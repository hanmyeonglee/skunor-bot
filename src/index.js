import http from "node:http";
import { spawn } from "node:child_process";
import { CronExpressionParser } from "cron-parser";
import {
  AttachmentBuilder,
  Client,
  EmbedBuilder,
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
  ensureCodexHomeConfig,
  installDiscordApiSkill,
  describeCodexError,
} from "./codex.js";

process.umask(0o077);

const USER_ERROR_TEXT = "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.";
const LOGIN_REQUIRED_MESSAGE = "Codex 로그인이 필요합니다. `/login` 명령어로 이 봇의 Codex 계정을 인증한 뒤 요청을 다시 멘션해 주세요.";
const LOGIN_IN_PROGRESS_MESSAGE = "Codex 로그인이 진행 중입니다. 완료된 뒤 요청을 다시 멘션해 주세요.";
const THREAD_HISTORY_LIMIT = 12;
const QNA_CONTEXT_FETCH_LIMIT = 50;
const QNA_CONTEXT_MESSAGE_LIMIT = 12;
const QNA_QUESTION_MAX_CHARS = 1_800;
const MEMORY_LIMIT = 4;
const MAX_CSV_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const STRUCTURED_RESPONSE_PATTERN = /(?:^|\r?\n)\[\[SKUNOR_RESPONSE_V1\]\]\s*\r?\n([\s\S]*?)\r?\n\[\[\/SKUNOR_RESPONSE_V1\]\](?=\r?\n|$)/;

const config = loadConfig();
ensureCodexHomeConfig(config.codexHome);
installDiscordApiSkill(config.codexHome);
const database = new BotDatabase(config.databasePath);
const codexThreadOptions = createThreadOptions();
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

let queueTail = Promise.resolve();
let shuttingDown = false;
let healthServer;
let activeJob = null;
let loginRequested = false;
let activeLoginChild = null;
let schedulePollTimer = null;
let schedulePollRunning = false;

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

function createCodexForMessage(message, {
  allowScheduleWrites = true,
  requesterUserId = message.author.id,
} = {}) {
  return createCodexClient({
    codexHome: config.codexHome,
    discordToken: config.discordToken,
    guildId: config.allowedGuildId,
    channelId: message.channelId,
    requesterUserId,
    databasePath: config.databasePath,
    timezone: config.scheduleTimezone,
    allowScheduleWrites,
  });
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

function plainDiscordResponse(content) {
  const boundedContent = boundAnswer(content || "(빈 답변)");
  return {
    kind: "prepared_discord_response",
    content: boundedContent,
    embed: null,
    csv: null,
    historyText: boundedContent,
  };
}

function flattenEmbedForHistory(embed) {
  return [
    embed.title,
    embed.description,
    ...embed.fields.map(({ name, value }) => `**${name}**\n${value}`),
  ].filter(Boolean).join("\n\n");
}

function sanitizeCsvFilename(filename) {
  let safeFilename = String(filename || "table.csv")
    .replace(/[\\/:\u0000-\u001f\u007f]/g, "_")
    .trim()
    .slice(0, 120);
  if (!safeFilename) safeFilename = "table.csv";
  if (!safeFilename.toLowerCase().endsWith(".csv")) safeFilename += ".csv";
  return safeFilename;
}

function validateEmbedPayload(embed) {
  if (!embed || typeof embed !== "object" || Array.isArray(embed)) return null;
  const title = embed.title ?? "";
  const description = embed.description ?? "";
  const rawFields = embed.fields ?? [];
  if (typeof title !== "string" || typeof description !== "string" || !Array.isArray(rawFields)) return null;

  const fields = [];
  for (const field of rawFields) {
    if (!field || typeof field !== "object" || Array.isArray(field)) return null;
    if (typeof field.name !== "string" || typeof field.value !== "string") return null;
    if (!field.name.trim() || !field.value.trim()) return null;
    fields.push({
      name: field.name,
      value: field.value,
      inline: field.inline === true,
    });
  }

  const characterCount = title.length + description.length
    + fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
  if (title.length > 256 || description.length > 4_096 || fields.length > 25
    || fields.some((field) => field.name.length > 256 || field.value.length > 1_024)
    || characterCount > 6_000
    || (!title && !description && fields.length === 0)) {
    return null;
  }

  return { title, description, fields };
}

function makePreparedDiscordResponse({ content, embed = null, csv = null }) {
  const boundedContent = boundAnswer(content || "");
  const embedText = embed ? flattenEmbedForHistory(embed) : "";
  const csvText = csv ? `CSV 첨부: ${csv.filename}` : "";
  const historyText = boundAnswer([boundedContent, embedText, csvText].filter(Boolean).join("\n\n"));
  return {
    kind: "prepared_discord_response",
    content: boundedContent,
    embed,
    csv,
    historyText,
  };
}

function prepareDiscordResponse(answer) {
  if (answer?.kind === "prepared_discord_response") return answer;
  const rawAnswer = typeof answer === "string" ? answer : String(answer ?? "");
  const safeAnswer = rawAnswer.replaceAll(config.discordToken, "[Discord bot token redacted]");
  const match = safeAnswer.match(STRUCTURED_RESPONSE_PATTERN);
  if (!match) return plainDiscordResponse(safeAnswer);
  const surroundingText = [
    safeAnswer.slice(0, match.index),
    safeAnswer.slice(match.index + match[0].length),
  ].join("").trim();

  let payload;
  try {
    payload = JSON.parse(match[1]);
  } catch {
    return plainDiscordResponse("표 응답을 처리하지 못했습니다. 표 내용을 목록 형식으로 다시 요청해 주세요.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return plainDiscordResponse("표 응답을 처리하지 못했습니다. 표 내용을 목록 형식으로 다시 요청해 주세요.");
  }

  const content = [
    surroundingText,
    typeof payload.content === "string" ? payload.content : "",
  ].filter(Boolean).join("\n\n");
  const hasEmbed = payload.embed !== undefined && payload.embed !== null;
  const hasCsv = payload.csv !== undefined && payload.csv !== null;
  if (hasEmbed && hasCsv) {
    return plainDiscordResponse(`${content}\n\nEmbed와 CSV를 함께 표시할 수 없어 응답을 목록 형식으로 다시 요청해 주세요.`.trim());
  }

  if (hasEmbed) {
    const embed = validateEmbedPayload(payload.embed);
    if (!embed) {
      const rawFields = Array.isArray(payload.embed?.fields) ? payload.embed.fields : [];
      const fallbackRows = rawFields
        .filter((field) => field && typeof field.name === "string" && typeof field.value === "string")
        .map((field) => `**${field.name}**\n${field.value}`);
      return plainDiscordResponse([
        content,
        payload.embed?.title,
        payload.embed?.description,
        ...fallbackRows,
        "Embed 제한을 넘어 표를 목록 형태로 바꾸었습니다.",
      ].filter(Boolean).join("\n\n"));
    }
    return makePreparedDiscordResponse({ content, embed });
  }

  if (hasCsv) {
    if (!payload.csv || typeof payload.csv !== "object" || Array.isArray(payload.csv)
      || typeof payload.csv.content !== "string" || !payload.csv.content.trim()) {
      return plainDiscordResponse(`${content}\n\nCSV 첨부를 만들지 못했습니다.`.trim());
    }
    const csv = {
      filename: sanitizeCsvFilename(payload.csv.filename),
      content: payload.csv.content.replaceAll(config.discordToken, "[Discord bot token redacted]"),
    };
    if (Buffer.byteLength(csv.content, "utf8") > MAX_CSV_ATTACHMENT_BYTES) {
      return plainDiscordResponse(`${content}\n\nCSV 파일이 8 MiB 제한을 넘어 첨부하지 못했습니다.`.trim());
    }
    return makePreparedDiscordResponse({
      content: content || "표 데이터는 CSV 파일로 첨부했습니다.",
      csv,
    });
  }

  return plainDiscordResponse(content);
}

function toDiscordEmbed(embed) {
  const builder = new EmbedBuilder();
  if (embed.title) builder.setTitle(embed.title);
  if (embed.description) builder.setDescription(embed.description);
  if (embed.fields.length > 0) builder.addFields(...embed.fields);
  return builder;
}

function responseSendOptions(response, content, allowedMentions) {
  const options = { allowedMentions };
  if (!response.embed) options.flags = MessageFlags.SuppressEmbeds;
  if (content) options.content = content;
  if (response.embed) options.embeds = [toDiscordEmbed(response.embed)];
  if (response.csv) {
    options.files = [new AttachmentBuilder(Buffer.from(response.csv.content, "utf8"), {
      name: response.csv.filename,
    })];
  }
  return options;
}

async function postAnswer(sourceMessage, answer) {
  const response = prepareDiscordResponse(answer);
  const chunks = response.content
    ? splitForDiscord(response.content, config.maxDiscordMessageChars)
    : [];

  await sourceMessage.reply(responseSendOptions(
    response,
    chunks[0],
    { parse: [], repliedUser: false },
  ));

  for (const chunk of chunks.slice(1)) {
    await sourceMessage.channel.send({
      content: chunk,
      allowedMentions: { parse: [] },
      flags: MessageFlags.SuppressEmbeds,
    });
  }

  return response.historyText;
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

function compactProgressText(value, maxChars) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  const characters = Array.from(text);
  return characters.length > maxChars
    ? `${characters.slice(0, maxChars - 1).join("")}…`
    : text;
}

function formatProgressPlan(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && typeof item.text === "string" && item.text.trim())
    .slice(0, 6)
    .map((item) => ({
      text: compactProgressText(item.text, 130),
      completed: item.completed === true,
    }));
}

function renderProgressMessage(question, plan, activity) {
  const steps = plan ?? [];
  const activeIndex = steps.findIndex((step) => !step.completed);
  const lines = [
    "🔎 **분석 진행 상황**",
    `**요청:** ${compactProgressText(question, 220)}`,
    "",
  ];

  if (steps.length > 0) {
    lines.push("**계획**");
    lines.push(...steps.map((step, index) => {
      if (step.completed) return `✅ ${step.text}`;
      if (index === activeIndex) return `🔄 ${step.text}`;
      return `▫️ ${step.text}`;
    }));
  } else if (!activity) {
    lines.push("요청을 구체적인 조사 단계로 나누고 있습니다.");
  }

  if (activity) lines.push("", `**상세 활동:** ${activity}`);

  const content = lines.join("\n");
  return content.length > 1_900 ? `${content.slice(0, 1_870)}…(일부 생략)` : content;
}

async function createRequestProgress(sourceMessage, question) {
  const progressChannel = sourceMessage.channel;
  const initialContent = renderProgressMessage(
    question,
    null,
    "요청을 구체적인 조사 단계로 나누고 있습니다.",
  );
  let progressMessage;
  try {
    progressMessage = await sourceMessage.reply({
      content: initialContent,
      allowedMentions: { parse: [], repliedUser: false },
      flags: MessageFlags.SuppressEmbeds,
    });
  } catch (error) {
    log("request_progress_reply_failed", {
      messageId: sourceMessage.id,
      channelId: sourceMessage.channelId,
      diagnostic: describeCodexError(error),
    });
    return null;
  }

  let plan = null;
  let activity = null;
  let finished = false;
  let finishPromise = null;
  let renderTimer = null;
  let renderQueue = Promise.resolve();
  let lastRenderedContent = initialContent;
  const stopTyping = startTypingIndicator(progressChannel);

  const queueRender = () => {
    if (finished) return;
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      renderTimer = null;
      renderQueue = renderQueue.then(async () => {
        const content = renderProgressMessage(question, plan, activity);
        if (content === lastRenderedContent) return;
        try {
          await progressMessage.edit({ content, allowedMentions: { parse: [] } });
          lastRenderedContent = content;
        } catch (error) {
          log("request_progress_update_failed", {
            messageId: sourceMessage.id,
            channelId: progressChannel.id,
            diagnostic: describeCodexError(error),
          });
        }
      }).catch((error) => {
        log("request_progress_update_failed", {
          messageId: sourceMessage.id,
          channelId: progressChannel.id,
          diagnostic: describeCodexError(error),
        });
      });
    }, 500);
    renderTimer.unref?.();
  };

  return {
    setPlan(items) {
      const nextPlan = formatProgressPlan(items);
      if (nextPlan.length === 0) return;
      plan = nextPlan;
      activity = null;
      queueRender();
    },
    setActivity(nextActivity) {
      if (nextActivity === null) {
        if (!plan || activity === null) return;
        activity = null;
      } else {
        if (typeof nextActivity !== "string" || !nextActivity.trim()) return;
        const normalizedActivity = nextActivity.trim();
        if (activity === normalizedActivity) return;
        activity = normalizedActivity;
      }
      queueRender();
    },
    async finish() {
      if (finishPromise) return finishPromise;
      finished = true;
      if (renderTimer) clearTimeout(renderTimer);
      renderTimer = null;
      stopTyping();
      finishPromise = (async () => {
        await renderQueue;
        try {
          await progressMessage.delete();
        } catch (error) {
          log("request_progress_delete_failed", {
            messageId: sourceMessage.id,
            channelId: progressChannel.id,
            progressMessageId: progressMessage.id,
            diagnostic: describeCodexError(error),
          });
        }
      })();
      return finishPromise;
    },
  };
}

async function startMessageStatus(message) {
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

async function runCodexTurnWithProgress(thread, prompt, progress) {
  const { events } = await thread.runStreamed(prompt);
  let finalResponse = "";
  let turnCompleted = false;

  for await (const event of events) {
    if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
      const { item } = event;
      if (item.type === "todo_list") {
        progress?.setPlan(item.items);
      } else if (item.type === "agent_message" && event.type === "item.completed") {
        finalResponse = item.text;
      } else if (item.type === "web_search") {
        const query = compactProgressText(item.query, 150);
        const searchStatus = event.type === "item.completed" ? "검색 완료" : "검색 중";
        progress?.setActivity(query ? `${searchStatus}: ${query}` : `${searchStatus}: 웹 자료`);
      } else if (item.type === "command_execution") {
        progress?.setActivity(null);
      } else if (item.type === "mcp_tool_call") {
        progress?.setActivity(null);
      }
    } else if (event.type === "turn.completed") {
      turnCompleted = true;
    } else if (event.type === "turn.failed") {
      const message = typeof event.error === "string" ? event.error : event.error?.message;
      throw new Error(message || "Codex 작업이 실패했습니다.");
    } else if (event.type === "error") {
      throw new Error(event.message || "Codex 이벤트 스트림이 실패했습니다.");
    } else if (event.type === "turn.interrupted") {
      throw new Error("Codex 작업이 중단되었습니다.");
    }
  }

  if (!turnCompleted) throw new Error("Codex 작업이 완료 이벤트 없이 종료되었습니다.");
  return { finalResponse };
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
  const safeAnswer = answer.replaceAll(config.discordToken, "[Discord bot token redacted]");
  if (safeAnswer.length <= config.maxResponseChars) return safeAnswer;
  return `${safeAnswer.slice(0, config.maxResponseChars - suffix.length)}${suffix}`;
}

async function processQuotaRecheck(conversationKey, sourceMessage, requesterUserId = sourceMessage.author.id) {
  const codex = createCodexForMessage(sourceMessage, {
    allowScheduleWrites: false,
    requesterUserId,
  });
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

async function processRequest({
  sourceMessage,
  question,
  conversationKey,
  guildId,
  progress = null,
  requesterUserId = sourceMessage.author.id,
  initialHistory = [],
}) {
  const reply = async (answer) => {
    await progress?.finish();
    await saveReply(conversationKey, sourceMessage, answer);
  };

  if (database.isUsageLimited()) {
    if (!isQuotaRecheckRequest(question)) {
      await reply(config.exceedMessage);
      return;
    }

    try {
      await processQuotaRecheck(conversationKey, sourceMessage, requesterUserId);
    } catch (error) {
      const errorKind = classifyCodexError(error);
      if (errorKind === "not_authenticated") {
        await reply(LOGIN_REQUIRED_MESSAGE);
        log("codex_login_required", { channelId: sourceMessage.channelId });
      } else if (errorKind === "usage_limited") {
        await reply(config.exceedMessage);
      } else {
        await reply(USER_ERROR_TEXT);
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
    await reply(answer);
    return;
  }

  let thread = null;
  let codex = null;
  let currentPrompt = "";
  let failureStage = "conversation_load";
  const requestTime = new Date();
  const discordContext = {
    guildId: sourceMessage.guildId,
    channelId: sourceMessage.channelId,
    isThread: sourceMessage.channel?.isThread?.() ?? false,
    requesterUserId,
    timezone: config.scheduleTimezone,
    currentTimeUtc: requestTime.toISOString(),
    currentTimeLocal: new Intl.DateTimeFormat("ko-KR", {
      timeZone: config.scheduleTimezone,
      dateStyle: "full",
      timeStyle: "long",
    }).format(requestTime),
  };
  try {
    codex = createCodexForMessage(sourceMessage, { requesterUserId });
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
        : [...initialHistory, ...database.getRecentHistory(conversationKey, sourceMessage.id, THREAD_HISTORY_LIMIT)]
          .slice(-THREAD_HISTORY_LIMIT),
      memory,
      discordContext,
    });
    failureStage = "thread_run";
    const turn = await runCodexTurnWithProgress(thread, currentPrompt, progress);

    const answer = prepareDiscordResponse(turn.finalResponse?.trim() || "요청을 처리했지만 답변 텍스트가 비어 있습니다.");

    failureStage = "database_save";
    database.setCodexThreadId(conversationKey, thread.id);
    database.saveResearchMemory({ guildId, conversationKey, question, answer: answer.historyText });
    failureStage = "discord_reply";
    await reply(answer);
    log("request_completed", { channelId: sourceMessage.channelId });
  } catch (error) {
    const errorKind = classifyCodexError(error);
    if (errorKind === "not_authenticated") {
      await reply(LOGIN_REQUIRED_MESSAGE);
      log("codex_login_required", { channelId: sourceMessage.channelId });
      return;
    }
    if (errorKind === "usage_limited") {
      database.setUsageLimited(true);
      await reply(config.exceedMessage);
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
          history: [...initialHistory, ...database.getRecentHistory(conversationKey, sourceMessage.id, THREAD_HISTORY_LIMIT)]
            .slice(-THREAD_HISTORY_LIMIT),
          memory: database.findRelevantMemory(guildId, question, MEMORY_LIMIT),
          discordContext,
        });
        progress?.setActivity("이전 Codex 대화를 복구하지 못해 현재 요청을 새 문맥에서 다시 조사하고 있습니다.");
        const turn = await runCodexTurnWithProgress(replacementThread, currentPrompt, progress);
        const answer = prepareDiscordResponse(turn.finalResponse?.trim() || "요청을 처리했지만 답변 텍스트가 비어 있습니다.");
        database.setCodexThreadId(conversationKey, replacementThread.id);
        database.saveResearchMemory({ guildId, conversationKey, question, answer: answer.historyText });
        await reply(answer);
        log("request_completed_after_thread_restore", { channelId: sourceMessage.channelId });
        return;
      } catch (retryError) {
        const retryErrorKind = classifyCodexError(retryError);
        if (retryErrorKind === "not_authenticated") {
          await reply(LOGIN_REQUIRED_MESSAGE);
          log("codex_login_required", { channelId: sourceMessage.channelId });
          return;
        }
        if (retryErrorKind === "usage_limited") {
          database.setUsageLimited(true);
          await reply(config.exceedMessage);
          log("usage_limit_reached");
          return;
        }
        failureError = retryError;
        failureKind = retryErrorKind;
      }
    }

    await reply(USER_ERROR_TEXT);
    log("request_failed", {
      category: failureKind,
      stage: failureStage,
      messageId: sourceMessage.id,
      channelId: sourceMessage.channelId,
      diagnostic: describeCodexError(failureError, {
        redactValues: [question, currentPrompt, config.discordToken],
      }),
    });
  }
}

function nextCronRun(cronExpression, timezone, currentDate) {
  const iterator = CronExpressionParser.parse(cronExpression, { currentDate, tz: timezone });
  return iterator.next().toDate().toISOString();
}

function formatScheduleTime(isoDate, timezone) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: timezone,
    dateStyle: "full",
    timeStyle: "short",
  }).format(new Date(isoDate));
}

async function sendScheduleNotification(schedule, content) {
  let channel = client.channels.cache.get(schedule.channel_id);
  if (!channel) channel = await client.channels.fetch(schedule.channel_id);
  if (!channel?.isTextBased?.() || typeof channel.send !== "function") {
    throw new Error("The schedule's Discord channel is no longer available for messages.");
  }

  const mention = `<@${schedule.owner_user_id}>`;
  const response = prepareDiscordResponse(content);
  const chunks = response.content
    ? splitForDiscord(response.content, config.maxDiscordMessageChars)
    : [];
  const firstContent = chunks.length > 0 ? `${mention}\n${chunks[0]}` : mention;
  await channel.send(responseSendOptions(
    response,
    firstContent,
    { parse: [], users: [schedule.owner_user_id] },
  ));

  for (const chunk of chunks.slice(1)) {
    await channel.send({
      content: chunk,
      allowedMentions: { parse: [] },
      flags: MessageFlags.SuppressEmbeds,
    });
  }
  return response.historyText;
}

async function executeScheduleOccurrence(occurrence) {
  try {
    if (occurrence.run_type === "event_reminder") {
      if (Date.parse(occurrence.event_at) <= Date.now()) {
        database.finishScheduleOccurrence({
          id: occurrence.id,
          status: "succeeded",
          result: "Skipped because the event start time had passed before the queued reminder ran.",
        });
        return;
      }
      const reminderMinutes = Math.round((Date.parse(occurrence.event_at) - Date.parse(occurrence.scheduled_at)) / 60_000);
      await sendScheduleNotification(occurrence, [
        `일정 알림: **${occurrence.title}** 시작 ${reminderMinutes}분 전입니다.`,
        `시작 시각: ${formatScheduleTime(occurrence.event_at, occurrence.timezone)} (${occurrence.timezone})`,
        ...(occurrence.details ? [`메모: ${occurrence.details}`] : []),
      ].join("\n"));
      database.finishScheduleOccurrence({
        id: occurrence.id,
        status: "succeeded",
        result: `Sent the ${reminderMinutes}-minute reminder.`,
      });
      log("schedule_reminder_sent", { scheduleId: occurrence.schedule_id, channelId: occurrence.channel_id });
      return;
    }

    if (database.isUsageLimited()) {
      await sendScheduleNotification(occurrence, config.exceedMessage);
      database.finishScheduleOccurrence({ id: occurrence.id, status: "failed", error: "usage_limited" });
      return;
    }
    if (!(await isCodexLoggedIn())) {
      await sendScheduleNotification(occurrence, LOGIN_REQUIRED_MESSAGE);
      database.finishScheduleOccurrence({ id: occurrence.id, status: "failed", error: "not_authenticated" });
      return;
    }

    const requestContext = {
      author: { id: occurrence.owner_user_id },
      guildId: occurrence.guild_id,
      channelId: occurrence.channel_id,
    };
    const codex = createCodexForMessage(requestContext, { allowScheduleWrites: false });
    const thread = codex.startThread(codexThreadOptions);
    const runAt = new Date();
    const discordContext = {
      guildId: occurrence.guild_id,
      channelId: occurrence.channel_id,
      isThread: false,
      requesterUserId: occurrence.owner_user_id,
      timezone: occurrence.timezone,
      currentTimeUtc: runAt.toISOString(),
      currentTimeLocal: formatScheduleTime(runAt.toISOString(), occurrence.timezone),
      scheduledTaskId: occurrence.schedule_id,
    };
    const prompt = buildCodexPrompt({
      question: `예약된 반복 작업을 이번 회차에 수행하세요. 결과를 등록 채널에 전달할 수 있도록 완결된 답변으로 작성하세요.\n\n작업 이름: ${occurrence.title}\n\n요청 내용:\n${occurrence.task_prompt}`,
      discordContext,
    });
    const turn = await thread.run(prompt);
    const answer = prepareDiscordResponse(turn.finalResponse?.trim() || "예약 작업을 수행했지만 답변 텍스트가 비어 있습니다.");
    await sendScheduleNotification(occurrence, answer);
    database.finishScheduleOccurrence({ id: occurrence.id, status: "succeeded", result: answer.historyText });
    log("schedule_task_completed", { scheduleId: occurrence.schedule_id, channelId: occurrence.channel_id });
  } catch (error) {
    const errorKind = classifyCodexError(error);
    let message = USER_ERROR_TEXT;
    if (errorKind === "usage_limited") {
      database.setUsageLimited(true);
      message = config.exceedMessage;
    } else if (errorKind === "not_authenticated") {
      message = LOGIN_REQUIRED_MESSAGE;
    }

    try {
      await sendScheduleNotification(occurrence, message);
    } catch (deliveryError) {
      log("schedule_notification_failed", {
        scheduleId: occurrence.schedule_id,
        channelId: occurrence.channel_id,
        diagnostic: describeCodexError(deliveryError),
      });
    }
    database.finishScheduleOccurrence({
      id: occurrence.id,
      status: "failed",
      error: describeCodexError(error, { redactValues: [config.discordToken] }),
    });
    log("schedule_execution_failed", {
      category: errorKind,
      scheduleId: occurrence.schedule_id,
      channelId: occurrence.channel_id,
      diagnostic: describeCodexError(error, { redactValues: [config.discordToken] }),
    });
  }
}

function pollSchedules() {
  if (schedulePollRunning || shuttingDown || !client.isReady()) return;
  schedulePollRunning = true;
  try {
    const currentTime = new Date();
    const nowIso = currentTime.toISOString();
    for (const schedule of database.getDueCronSchedules(nowIso)) {
      try {
        database.advanceCronSchedule({
          scheduleId: schedule.id,
          scheduledAt: schedule.next_run_at,
          nextRunAt: nextCronRun(schedule.cron_expression, schedule.timezone, currentTime),
        });
      } catch (error) {
        log("schedule_cron_invalid", {
          scheduleId: schedule.id,
          diagnostic: describeCodexError(error),
        });
      }
    }

    const eventReminderHorizon = new Date(currentTime.getTime() + 15 * 60_000).toISOString();
    for (const schedule of database.getUpcomingEvents(nowIso, eventReminderHorizon, 200)) {
      let reminderOffsets;
      try {
        reminderOffsets = JSON.parse(schedule.reminder_offsets);
      } catch {
        reminderOffsets = [15, 5];
      }
      const eventAt = Date.parse(schedule.event_at);
      for (const offsetMinutes of reminderOffsets) {
        const reminderAt = eventAt - offsetMinutes * 60_000;
        const nextReminderOffset = reminderOffsets.filter((offset) => offset < offsetMinutes).sort((a, b) => b - a)[0];
        const createdAfterReminder = Date.parse(schedule.created_at) > reminderAt;
        const laterReminderIsDue = nextReminderOffset !== undefined
          && currentTime.getTime() >= eventAt - nextReminderOffset * 60_000;
        if (reminderAt > currentTime.getTime() || createdAfterReminder || laterReminderIsDue) continue;
        database.addEventReminderOccurrence(schedule.id, new Date(reminderAt).toISOString());
      }
    }

    database.completePastEvents(nowIso);
    for (const occurrence of database.claimPendingScheduleOccurrences()) {
      void enqueue(() => executeScheduleOccurrence(occurrence)).catch((error) => {
        log("schedule_queue_failed", {
          scheduleId: occurrence.schedule_id,
          diagnostic: describeCodexError(error, { redactValues: [config.discordToken] }),
        });
      });
    }
  } catch (error) {
    log("schedule_poll_failed", { diagnostic: describeCodexError(error) });
  } finally {
    schedulePollRunning = false;
  }
}

async function loadQnaChannelContext(channel, beforeTimestamp) {
  const fetched = await channel.messages.fetch({ limit: QNA_CONTEXT_FETCH_LIMIT });
  const recentMessages = [...fetched.values()]
    .filter((message) => message.createdTimestamp <= beforeTimestamp)
    .filter((message) => message.content.trim())
    .filter((message) => !message.author.bot || message.author.id === client.user?.id)
    .filter((message) => !message.content.startsWith("🔎 **분석 진행 상황**"))
    .sort((first, second) => first.createdTimestamp - second.createdTimestamp);

  const latestHumanMessage = [...recentMessages]
    .reverse()
    .find((message) => !message.author.bot) ?? null;
  const anchor = latestHumanMessage && !latestHumanMessage.hasThread
    ? latestHumanMessage
    : null;
  const history = recentMessages.slice(-QNA_CONTEXT_MESSAGE_LIMIT).map((message) => {
    const displayName = message.member?.displayName
      || message.author.globalName
      || message.author.username;
    const content = message.author.bot
      ? message.content
      : cleanRequestContent(message.content, client.user.id);
    return {
      role: message.author.bot ? "assistant" : "user",
      content: `${displayName}: ${compactProgressText(content, 1_400)}`,
    };
  });

  return { anchor, history };
}

async function processInitialQnaRequest({
  sourceMessage,
  question,
  conversationKey,
  guildId,
  requesterUserId,
  initialHistory,
}) {
  let progress = null;
  let stopFallbackTyping = null;
  try {
    if (loginRequested) {
      await saveReply(conversationKey, sourceMessage, LOGIN_IN_PROGRESS_MESSAGE);
      return;
    }

    if (!(await isCodexLoggedIn())) {
      await saveReply(conversationKey, sourceMessage, LOGIN_REQUIRED_MESSAGE);
      log("codex_login_required", { channelId: sourceMessage.channelId });
      return;
    }

    if (database.isUsageLimited() && !isQuotaRecheckRequest(question)) {
      await saveReply(conversationKey, sourceMessage, config.exceedMessage);
      return;
    }

    if (!isQuotaRecheckRequest(question)) {
      progress = await createRequestProgress(sourceMessage, question);
    }
    if (!progress) stopFallbackTyping = startTypingIndicator(sourceMessage.channel);

    await processRequest({
      sourceMessage,
      question,
      conversationKey,
      guildId,
      requesterUserId,
      initialHistory,
      progress,
    });
  } finally {
    stopFallbackTyping?.();
    await progress?.finish();
  }
}

async function handleQnaCommand(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "qna") return;
  if (interaction.guildId !== config.allowedGuildId) {
    await interaction.reply({
      content: "이 서버에서는 Q&A 명령을 사용할 수 없습니다.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (interaction.channel?.isThread?.()) {
    await interaction.editReply("새 Q&A는 일반 채널에서 시작해 주세요. 기존 Q&A 스레드에서는 메시지를 바로 보내 이어서 질문할 수 있습니다.");
    return;
  }

  const question = interaction.options.getString("question", true).trim();
  if (!question) {
    await interaction.editReply("질문 내용을 입력해 주세요.");
    return;
  }

  let thread = null;
  let createdAnchor = null;
  try {
    const { anchor: recentConversationMessage, history } = await loadQnaChannelContext(
      interaction.channel,
      interaction.createdTimestamp,
    );
    let threadAnchor = recentConversationMessage;
    if (!threadAnchor) {
      createdAnchor = await interaction.channel.send({
        content: "Q&A 요청 스레드",
        allowedMentions: { parse: [] },
      });
      threadAnchor = createdAnchor;
    }

    const threadName = `Q&A · ${compactProgressText(question, 88)}`;
    thread = await threadAnchor.startThread(
      {
        name: threadName,
        reason: `Q&A requested by ${interaction.user.id}`,
      },
    );
    const displayName = interaction.member?.displayName
      || interaction.user.globalName
      || interaction.user.username;
    const sourceMessage = await thread.send({
      content: `**${displayName}의 질문:**\n${question}`,
      allowedMentions: { parse: [] },
    });
    const conversationKey = `${interaction.guildId}:${thread.id}:shared`;

    database.registerQnaThread({
      threadId: thread.id,
      guildId: interaction.guildId,
      parentChannelId: interaction.channelId,
      ownerUserId: interaction.user.id,
    });
    database.ensureConversation({
      conversationKey,
      guildId: interaction.guildId,
      channelId: thread.id,
      ownerUserId: null,
    });
    for (const contextMessage of history) {
      database.addContextMessage(conversationKey, contextMessage);
    }
    database.addUserMessage({
      conversationKey,
      discordMessageId: sourceMessage.id,
      userId: interaction.user.id,
      content: question,
    });

    const completion = enqueue(() => processInitialQnaRequest({
      sourceMessage,
      question,
      conversationKey,
      guildId: interaction.guildId,
      requesterUserId: interaction.user.id,
      initialHistory: [],
    }));
    void completion.catch((error) => {
      log("qna_request_failed", {
        threadId: thread.id,
        channelId: interaction.channelId,
        diagnostic: describeCodexError(error),
      });
    });

    log("qna_thread_created", {
      guildId: interaction.guildId,
      parentChannelId: interaction.channelId,
      threadId: thread.id,
      requesterUserId: interaction.user.id,
      contextMessageCount: history.length,
    });
    try {
      await interaction.editReply(`Q&A 스레드를 열었습니다: <#${thread.id}>`);
    } catch (error) {
      log("qna_interaction_ack_failed", {
        threadId: thread.id,
        diagnostic: describeCodexError(error),
      });
    }
  } catch (error) {
    if (thread) {
      try {
        await thread.setArchived(true);
      } catch {
        // Keep the original setup error for diagnostics.
      }
    }
    if (createdAnchor) {
      try {
        await createdAnchor.delete();
      } catch {
        // A visible fallback anchor is harmless if Discord rejects deletion.
      }
    }
    log("qna_thread_creation_failed", {
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      diagnostic: describeCodexError(error),
    });
    await interaction.editReply("Q&A 스레드를 준비하지 못했습니다. 봇의 채널 기록 및 스레드 권한을 확인한 뒤 다시 시도해 주세요.");
  }
}

async function handleMessage(message) {
  if (!message.guildId || message.guildId !== config.allowedGuildId) return;
  if (message.author.bot || !client.user) return;
  const isQnaThread = message.channel.isThread?.()
    && database.isQnaThread(message.channelId, message.guildId);
  if (!isQnaThread && !message.mentions.users.has(client.user.id)) return;

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
  let progress = null;
  let stopFallbackTyping = null;
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

    if (!isQuotaRecheckRequest(question)) {
      progress = await createRequestProgress(message, question);
    }
    if (!progress) stopFallbackTyping = startTypingIndicator(message.channel);

    const completion = enqueue(() => processRequest({
      sourceMessage: message,
      question,
      conversationKey,
      guildId: message.guildId,
      progress,
    }));
    await completion;
  } finally {
    stopFallbackTyping?.();
    await progress?.finish();
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
    const recoveredRuns = database.recoverInterruptedScheduleOccurrences();
    if (recoveredRuns > 0) log("schedule_runs_recovered", { count: recoveredRuns });
    schedulePollTimer = setInterval(pollSchedules, 15_000);
    schedulePollTimer.unref?.();
    pollSchedules();
    try {
      await client.application.commands.create(
        new SlashCommandBuilder()
          .setName("login")
          .setDescription("Codex 계정을 이 봇에 로그인합니다.")
          .toJSON(),
        config.allowedGuildId,
      );
      await client.application.commands.create(
        new SlashCommandBuilder()
          .setName("qna")
          .setDescription("최근 대화를 바탕으로 답변하는 Q&A 스레드를 엽니다.")
          .addStringOption((option) => option
            .setName("question")
            .setDescription("최근 대화에 대해 궁금한 점")
            .setRequired(true)
            .setMaxLength(QNA_QUESTION_MAX_CHARS))
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
    if (interaction.isChatInputCommand() && interaction.commandName === "qna") {
      void handleQnaCommand(interaction).catch((error) => {
        log("qna_interaction_failed", { diagnostic: describeCodexError(error) });
      });
      return;
    }

    void handleLoginCommand(interaction).catch((error) => {
      log("login_interaction_failed", { diagnostic: describeCodexError(error) });
    });
  });

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("shutdown_started", { signal });
    activeLoginChild?.kill("SIGTERM");
    if (schedulePollTimer) clearInterval(schedulePollTimer);
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
