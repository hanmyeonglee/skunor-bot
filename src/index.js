import http from "node:http";
import { spawn } from "node:child_process";
import {
  Client,
  GatewayIntentBits,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { loadConfig } from "./config.js";
import { BotDatabase } from "./database.js";
import {
  buildCodexPrompt,
  classifyCodexError,
  createCodexCliEnvironment,
  createCodexClient,
  createThreadOptions,
  describeCodexError,
} from "./codex.js";

process.umask(0o077);

const USER_ERROR_TEXT = "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.";
const LOGIN_REQUIRED_MESSAGE = "Codex 로그인이 필요합니다. `/login` 명령어로 이 봇의 Codex 계정을 인증한 뒤 요청을 다시 멘션해 주세요.";
const LOGIN_IN_PROGRESS_MESSAGE = "Codex 로그인이 진행 중입니다. 완료된 뒤 요청을 다시 멘션해 주세요.";
const THREAD_HISTORY_LIMIT = 12;
const MEMORY_LIMIT = 4;

const config = loadConfig();
const database = new BotDatabase(config.databasePath);
const codex = createCodexClient({ codexHome: config.codexHome });
const codexThreadOptions = createThreadOptions();
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ],
});

let queueTail = Promise.resolve();
let shuttingDown = false;
let healthServer;
let activeJob = null;
let loginRequested = false;
let activeLoginChild = null;

function log(event, fields = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    ...fields,
  }));
}

function cleanRequestContent(content, botId) {
  return content
    .replace(new RegExp(`<@!?${botId}>`, "g"), " ")
    .replace(/\s+/g, " ")
    .trim();
}

function createConversationKey(message) {
  const isDiscordThread = message.channel.isThread?.() ?? false;
  const authorPart = isDiscordThread ? "shared" : message.author.id;
  return `${message.guildId}:${message.channelId}:${authorPart}`;
}

function splitForDiscord(text, maxLength) {
  const parts = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt < Math.floor(maxLength * 0.55)) {
      splitAt = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitAt < Math.floor(maxLength * 0.55)) splitAt = maxLength;

    parts.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) parts.push(remaining);
  return parts.length > 0 ? parts : ["(빈 답변)"];
}

async function postAnswer(sourceMessage, answer) {
  const boundedAnswer = boundAnswer(answer);
  const chunks = splitForDiscord(boundedAnswer, config.maxDiscordMessageChars);
  const sendOptions = { allowedMentions: { parse: [] } };

  await sourceMessage.reply({
    content: chunks[0],
    allowedMentions: { parse: [], repliedUser: false },
  });

  for (const chunk of chunks.slice(1)) {
    await sourceMessage.channel.send({ content: chunk, ...sendOptions });
  }

  return boundedAnswer;
}

function enqueue(job) {
  const completion = queueTail.then(async () => {
    if (shuttingDown) return;
    activeJob = job();
    try {
      return await activeJob;
    } finally {
      activeJob = null;
    }
  });
  queueTail = completion.catch(() => {});
  return completion;
}

function resolveStatusEmoji(message, name, fallback) {
  return message.guild?.emojis.cache.find((emoji) => emoji.name?.toLowerCase() === name) || fallback;
}

function startTypingIndicator(channel) {
  let stopped = false;
  let sending = false;
  let failureLogged = false;

  const sendTyping = async () => {
    if (stopped || sending) return;
    sending = true;
    try {
      await channel.sendTyping();
    } catch (error) {
      if (!failureLogged) {
        failureLogged = true;
        log("typing_indicator_failed", {
          channelId: channel.id,
          diagnostic: describeCodexError(error),
        });
      }
    } finally {
      sending = false;
    }
  };

  void sendTyping();
  const timer = setInterval(() => void sendTyping(), 8_000);
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function startMessageStatus(message) {
  const stopTyping = startTypingIndicator(message.channel);
  let loadingReaction = null;

  try {
    loadingReaction = await message.react(resolveStatusEmoji(message, "loading", "⏳"));
  } catch (error) {
    log("request_status_reaction_failed", {
      stage: "loading",
      messageId: message.id,
      channelId: message.channelId,
      diagnostic: describeCodexError(error),
    });
  }

  let finished = false;
  return async () => {
    if (finished) return;
    finished = true;
    stopTyping();

    if (loadingReaction && client.user) {
      try {
        await loadingReaction.users.remove(client.user.id);
      } catch (error) {
        log("request_status_reaction_failed", {
          stage: "loading_remove",
          messageId: message.id,
          channelId: message.channelId,
          diagnostic: describeCodexError(error),
        });
      }
    }

    try {
      await message.react(resolveStatusEmoji(message, "check_mark", "✅"));
    } catch (error) {
      log("request_status_reaction_failed", {
        stage: "complete",
        messageId: message.id,
        channelId: message.channelId,
        diagnostic: describeCodexError(error),
      });
    }
  };
}

function isCodexLoggedIn() {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("codex", ["login", "status"], {
        env: createCodexCliEnvironment(config.codexHome),
        stdio: "ignore",
      });
    } catch {
      resolve(false);
      return;
    }

    let settled = false;
    const finish = (loggedIn) => {
      if (settled) return;
      settled = true;
      resolve(loggedIn);
    };
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}

function cleanCodexOutput(rawOutput) {
  return rawOutput
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-10)
    .join("\n")
    .replace(/```/g, "` ` `")
    .slice(-1_500);
}

function formatLoginOutput(rawOutput) {
  const output = cleanCodexOutput(rawOutput);

  if (!output) {
    return "Codex 기기 로그인을 시작했습니다. 인증 안내가 표시되기를 기다리고 있습니다.";
  }
  return `Codex 기기 로그인 안내입니다. 외부 브라우저에서 주소를 열고 표시된 코드를 입력해 주세요.\n\n${output}`;
}

function formatLoginFailure(rawOutput, error) {
  const output = cleanCodexOutput(rawOutput);
  const exitCode = Number.isInteger(error.exitCode) ? ` (종료 코드 ${error.exitCode})` : "";

  if (!output) {
    return `Codex CLI가 인증 안내를 출력하지 않고 종료했습니다${exitCode}. 컨테이너의 외부 연결과 계정의 기기 인증 허용 여부를 확인한 뒤 다시 시도해 주세요.`;
  }

  return `Codex CLI가 인증을 완료하지 못했습니다${exitCode}. CLI 출력은 다음과 같습니다.\n\n${output}`;
}

function runCodexDeviceLogin(onOutput) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn("codex", ["login", "--device-auth"], {
        env: createCodexCliEnvironment(config.codexHome),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      reject(Object.assign(new Error("Codex CLI를 시작하지 못했습니다."), { kind: "cli_start_failed" }));
      return;
    }

    activeLoginChild = child;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      if (activeLoginChild === child) activeLoginChild = null;
      callback();
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", onOutput);
    child.stderr.on("data", onOutput);
    child.once("error", (error) => {
      finish(() => reject(Object.assign(new Error("Codex CLI를 시작하지 못했습니다."), {
        kind: error.code === "ENOENT" ? "cli_missing" : "cli_start_failed",
      })));
    });
    child.once("close", (code) => {
      if (code === 0) {
        finish(resolve);
      } else {
        finish(() => reject(Object.assign(new Error("Codex 기기 로그인이 완료되지 않았습니다."), {
          kind: "login_not_completed",
          exitCode: code,
        })));
      }
    });
  });
}

async function updateLoginInteraction(interaction, content) {
  try {
    await interaction.editReply({ content, allowedMentions: { parse: [] } });
  } catch {
    // The interaction may expire while the user is completing device authentication.
  }
}

async function handleLoginCommand(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "login") return;
  if (interaction.guildId !== config.allowedGuildId) {
    await interaction.reply({
      content: "이 서버에서는 로그인 명령을 사용할 수 없습니다.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (loginRequested) {
    await updateLoginInteraction(interaction, "이미 Codex 로그인이 진행 중입니다. 완료될 때까지 기다려 주세요.");
    return;
  }

  loginRequested = true;
  await updateLoginInteraction(interaction, "Codex 로그인 작업을 대기열에 넣었습니다. 기존 요청이 끝나면 기기 인증을 시작합니다.");

  try {
    await enqueue(async () => {
      let rawOutput = "";
      let outputTimer = null;
      const publishOutput = () => {
        outputTimer = null;
        void updateLoginInteraction(interaction, formatLoginOutput(rawOutput));
      };
      const collectOutput = (chunk) => {
        rawOutput = `${rawOutput}${chunk}`.slice(-6_000);
        if (outputTimer === null) outputTimer = setTimeout(publishOutput, 200);
      };

      try {
        await updateLoginInteraction(interaction, "Codex 기기 인증을 시작합니다.");
        await runCodexDeviceLogin(collectOutput);
        if (outputTimer !== null) {
          clearTimeout(outputTimer);
          outputTimer = null;
        }
        if (!(await isCodexLoggedIn())) {
          throw Object.assign(new Error("Codex 로그인 상태를 확인할 수 없습니다."), { kind: "login_status_failed" });
        }
        await updateLoginInteraction(interaction, "Codex 로그인이 완료됐습니다. 이 서버의 봇 계정으로 연결했으니 원래 요청을 다시 멘션해 주세요.");
        log("codex_login_completed");
      } catch (error) {
        if (outputTimer !== null) clearTimeout(outputTimer);
        log("codex_login_failed", {
          category: error.kind || "login_failed",
          ...(Number.isInteger(error.exitCode) ? { exitCode: error.exitCode } : {}),
          diagnostic: describeCodexError(error),
        });
        await updateLoginInteraction(interaction, formatLoginFailure(rawOutput, error));
      }
    });
  } finally {
    loginRequested = false;
  }
}

function isQuotaRecheckRequest(question) {
  return /^(재확인|다시\s*확인|quota\s*check|status)$/i.test(question.trim());
}

async function saveReply(conversationKey, sourceMessage, answer) {
  const savedAnswer = await postAnswer(sourceMessage, answer);
  database.addAssistantMessage(conversationKey, savedAnswer);
  return savedAnswer;
}

function boundAnswer(answer) {
  const suffix = "\n\n(응답이 Discord 전송 한도 때문에 일부 잘렸습니다.)";
  if (answer.length <= config.maxResponseChars) return answer;
  return `${answer.slice(0, config.maxResponseChars - suffix.length)}${suffix}`;
}

async function processQuotaRecheck(conversationKey, sourceMessage) {
  const probe = codex.startThread(codexThreadOptions);
  await probe.run([
    "Check whether you can answer with the current Codex account.",
    "Do not use tools, search, or inspect local state. Reply with exactly READY if you can respond.",
  ].join("\n"));

  database.setUsageLimited(false);
  const answer = "Codex 사용 한도가 해제된 것을 확인했습니다. 원래 요청을 다시 멘션해 주세요.";
  await saveReply(conversationKey, sourceMessage, answer);
  log("quota_recheck_succeeded");
}

async function processRequest({ sourceMessage, question, conversationKey, guildId }) {
  if (database.isUsageLimited()) {
    if (!isQuotaRecheckRequest(question)) {
      await saveReply(conversationKey, sourceMessage, config.exceedMessage);
      return;
    }

    try {
      await processQuotaRecheck(conversationKey, sourceMessage);
    } catch (error) {
      const errorKind = classifyCodexError(error);
      if (errorKind === "not_authenticated") {
        await saveReply(conversationKey, sourceMessage, LOGIN_REQUIRED_MESSAGE);
        log("codex_login_required", { channelId: sourceMessage.channelId });
      } else if (errorKind === "usage_limited") {
        await saveReply(conversationKey, sourceMessage, config.exceedMessage);
      } else {
        await saveReply(conversationKey, sourceMessage, USER_ERROR_TEXT);
        log("quota_recheck_failed", {
          category: errorKind,
          messageId: sourceMessage.id,
          diagnostic: describeCodexError(error),
        });
      }
    }
    return;
  }

  if (isQuotaRecheckRequest(question)) {
    const answer = "현재 사용 한도 초과 상태로 기록되어 있지 않습니다.";
    await saveReply(conversationKey, sourceMessage, answer);
    return;
  }

  let thread = null;
  let currentPrompt = "";
  let failureStage = "conversation_load";
  try {
    const conversation = database.getConversation(conversationKey);
    failureStage = "memory_lookup";
    const memory = database.findRelevantMemory(guildId, question, MEMORY_LIMIT);
    failureStage = conversation.codex_thread_id ? "thread_resume" : "thread_start";
    thread = conversation.codex_thread_id
      ? codex.resumeThread(conversation.codex_thread_id, codexThreadOptions)
      : codex.startThread(codexThreadOptions);

    currentPrompt = buildCodexPrompt({
      question,
      history: conversation.codex_thread_id
        ? []
        : database.getRecentHistory(conversationKey, sourceMessage.id, THREAD_HISTORY_LIMIT),
      memory,
    });
    failureStage = "thread_run";
    const turn = await thread.run(currentPrompt);

    const answer = boundAnswer(turn.finalResponse?.trim() || "요청을 처리했지만 답변 텍스트가 비어 있습니다.");

    failureStage = "database_save";
    database.setCodexThreadId(conversationKey, thread.id);
    database.saveResearchMemory({ guildId, conversationKey, question, answer });
    failureStage = "discord_reply";
    await saveReply(conversationKey, sourceMessage, answer);
    log("request_completed", { channelId: sourceMessage.channelId });
  } catch (error) {
    const errorKind = classifyCodexError(error);
    if (errorKind === "not_authenticated") {
      await saveReply(conversationKey, sourceMessage, LOGIN_REQUIRED_MESSAGE);
      log("codex_login_required", { channelId: sourceMessage.channelId });
      return;
    }
    if (errorKind === "usage_limited") {
      database.setUsageLimited(true);
      await saveReply(conversationKey, sourceMessage, config.exceedMessage);
      log("usage_limit_reached");
      return;
    }

    let failureError = error;
    let failureKind = errorKind;
    if (errorKind === "thread_missing" && thread) {
      failureStage = "thread_restore_retry";
      try {
        const replacementThread = codex.startThread(codexThreadOptions);
        currentPrompt = buildCodexPrompt({
          question,
          history: database.getRecentHistory(conversationKey, sourceMessage.id, THREAD_HISTORY_LIMIT),
          memory: database.findRelevantMemory(guildId, question, MEMORY_LIMIT),
        });
        const turn = await replacementThread.run(currentPrompt);
        const answer = boundAnswer(turn.finalResponse?.trim() || "요청을 처리했지만 답변 텍스트가 비어 있습니다.");
        database.setCodexThreadId(conversationKey, replacementThread.id);
        database.saveResearchMemory({ guildId, conversationKey, question, answer });
        await saveReply(conversationKey, sourceMessage, answer);
        log("request_completed_after_thread_restore", { channelId: sourceMessage.channelId });
        return;
      } catch (retryError) {
        const retryErrorKind = classifyCodexError(retryError);
        if (retryErrorKind === "not_authenticated") {
          await saveReply(conversationKey, sourceMessage, LOGIN_REQUIRED_MESSAGE);
          log("codex_login_required", { channelId: sourceMessage.channelId });
          return;
        }
        if (retryErrorKind === "usage_limited") {
          database.setUsageLimited(true);
          await saveReply(conversationKey, sourceMessage, config.exceedMessage);
          log("usage_limit_reached");
          return;
        }
        failureError = retryError;
        failureKind = retryErrorKind;
      }
    }

    await saveReply(conversationKey, sourceMessage, USER_ERROR_TEXT);
    log("request_failed", {
      category: failureKind,
      stage: failureStage,
      messageId: sourceMessage.id,
      channelId: sourceMessage.channelId,
      diagnostic: describeCodexError(failureError, { redactValues: [question, currentPrompt] }),
    });
  }
}

async function handleMessage(message) {
  if (!message.guildId || message.guildId !== config.allowedGuildId) return;
  if (message.author.bot || !client.user || !message.mentions.users.has(client.user.id)) return;

  const question = cleanRequestContent(message.content, client.user.id);
  const conversationKey = createConversationKey(message);
  database.ensureConversation({
    conversationKey,
    guildId: message.guildId,
    channelId: message.channelId,
    ownerUserId: message.channel.isThread?.() ? null : message.author.id,
  });

  if (!question) {
    await message.reply({
      content: `요청 내용을 함께 적어 주세요. 예: <@${client.user.id}> 논문을 조사해 줘`,
      allowedMentions: { parse: [], repliedUser: false },
    });
    return;
  }

  const inserted = database.addUserMessage({
    conversationKey,
    discordMessageId: message.id,
    userId: message.author.id,
    content: question,
  });
  if (!inserted) return;

  const finishStatus = await startMessageStatus(message);
  try {
    if (loginRequested) {
      await saveReply(conversationKey, message, LOGIN_IN_PROGRESS_MESSAGE);
      return;
    }

    if (!(await isCodexLoggedIn())) {
      await saveReply(conversationKey, message, LOGIN_REQUIRED_MESSAGE);
      log("codex_login_required", { channelId: message.channelId });
      return;
    }

    if (database.isUsageLimited() && !isQuotaRecheckRequest(question)) {
      await saveReply(conversationKey, message, config.exceedMessage);
      return;
    }

    const completion = enqueue(() => processRequest({
      sourceMessage: message,
      question,
      conversationKey,
      guildId: message.guildId,
    }));
    await completion;
  } finally {
    await finishStatus();
  }
}

function startHealthServer() {
  const server = http.createServer((request, response) => {
    if (request.url !== "/healthz" && request.url !== "/readyz") {
      response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      response.end('{"error":"not_found"}');
      return;
    }

    const isLiveness = request.url === "/healthz";
    const ready = client.isReady() && !shuttingDown;
    const ok = isLiveness || ready;
    response.writeHead(ok ? 200 : 503, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ status: ok ? "ok" : "not_ready" }));
  });

  server.listen(config.port, config.host, () => {
    log("health_server_started", { host: config.host, port: config.port });
  });
  return server;
}

async function main() {
  healthServer = startHealthServer();

  client.once("ready", async () => {
    log("discord_ready", { botId: client.user.id });
    try {
      await client.application.commands.create(
        new SlashCommandBuilder()
          .setName("login")
          .setDescription("Codex 계정을 이 봇에 로그인합니다.")
          .toJSON(),
        config.allowedGuildId,
      );
      log("discord_commands_registered", { guildId: config.allowedGuildId });
    } catch {
      log("discord_commands_registration_failed");
    }
  });
  client.on("messageCreate", (message) => {
    void handleMessage(message).catch((error) => {
      log("message_handler_failed", {
        messageId: message.id,
        channelId: message.channelId,
        diagnostic: describeCodexError(error),
      });
    });
  });
  client.on("interactionCreate", (interaction) => {
    void handleLoginCommand(interaction).catch((error) => {
      log("login_interaction_failed", { diagnostic: describeCodexError(error) });
    });
  });

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("shutdown_started", { signal });
    activeLoginChild?.kill("SIGTERM");
    client.destroy();
    healthServer.close();

    const timeout = new Promise((resolve) => setTimeout(resolve, 55_000));
    await Promise.race([queueTail, timeout]);
    if (activeJob) {
      await Promise.race([
        activeJob,
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
    }
    database.close();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  await client.login(config.discordToken);
}

void main().catch((error) => {
  log("startup_failed", { diagnostic: describeCodexError(error) });
  client.destroy();
  database.close();
  healthServer?.close();
  process.exitCode = 1;
});
