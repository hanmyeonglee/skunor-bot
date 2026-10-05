import http from "node:http";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Server } from "node:http";
import { CronExpressionParser } from "cron-parser";
import type { Input, Thread } from "@openai/codex-sdk";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  type AnyThreadChannel,
  type GuildTextBasedChannel,
  type Interaction,
  MessageFlags,
  type Message,
  type MessageMentionOptions,
  type MessageSnapshot,
  type ModalSubmitInteraction,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type MessageCreateOptions,
  type TextBasedChannel,
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
  installBundledSkills,
  describeCodexError,
  MCP_OAUTH_SERVER_NAMES,
  CODEX_WORKING_DIRECTORY,
  type CodexRequestOptions,
} from "./codex.js";
import type { DiscordContext, NotificationTarget, PromptHistoryEntry } from "./types.js";
import type { OccurrenceRow, ScheduleRow } from "./database.js";

process.umask(0o077);

const USER_ERROR_TEXT = "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.";
const LOGIN_REQUIRED_MESSAGE = "Codex 로그인이 필요합니다. `/login` 명령어로 이 봇의 Codex 계정을 인증한 뒤 요청을 다시 멘션해 주세요.";
const LOGIN_IN_PROGRESS_MESSAGE = "Codex 로그인이 진행 중입니다. 완료된 뒤 요청을 다시 멘션해 주세요.";
const MCP_LOGIN_IN_PROGRESS_MESSAGE = "MCP 로그인이 진행 중입니다. 완료된 뒤 요청을 다시 멘션해 주세요.";
const THREAD_HISTORY_LIMIT = 12;
const QNA_CONTEXT_FETCH_LIMIT = 50;
const QNA_CONTEXT_MESSAGE_LIMIT = 12;
const QNA_QUESTION_MAX_CHARS = 1_800;
const MAX_LINKED_MESSAGE_CONTEXT_CHARS = 8_000;
const MEMORY_LIMIT = 4;
const MCP_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_CSV_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_ATTACHMENTS_PER_REQUEST = 5;
const MAX_TOTAL_IMAGE_ATTACHMENT_BYTES = 40 * 1024 * 1024;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000;
const STRUCTURED_RESPONSE_PATTERN = /(?:^|\r?\n)\[\[SKUNOR_RESPONSE_V1\]\]\s*\r?\n([\s\S]*?)\r?\n\[\[\/SKUNOR_RESPONSE_V1\]\](?=\r?\n|$)/;

type FenceState = { character: string; length: number; openingLine: string; closingLine: string };
type EmbedFieldData = { name: string; value: string; inline: boolean };
type EmbedData = { title: string; description: string; fields: EmbedFieldData[] };
type CsvData = { filename: string; content: string };
type PreparedDiscordResponse = {
  kind: "prepared_discord_response";
  content: string;
  historyText: string;
  embed?: EmbedData;
  csv?: CsvData;
};
type ProgressPlanItem = { text: string; completed: boolean };
type RequestProgress = {
  setPlan(items: readonly ProgressPlanItem[]): void;
  setActivity(activity: string | undefined): void;
  finish(): Promise<void>;
};
type CodexJob = () => Promise<void>;
type ProcessRequestOptions = {
  sourceMessage: Message;
  question: string;
  quotaRecheck?: boolean;
  conversationKey: string;
  guildId: string;
  progress?: RequestProgress;
  requesterUserId?: string;
  initialHistory?: PromptHistoryEntry[];
  imageAttachments?: DiscordAttachmentReference[];
};
type InitialQnaRequestOptions = {
  sourceMessage: Message;
  question: string;
  conversationKey: string;
  guildId: string;
  requesterUserId: string;
  initialHistory: PromptHistoryEntry[];
  imageAttachments: DiscordAttachmentReference[];
};
type DiscordAttachmentReference = {
  name: string;
  contentType?: string;
  size?: number;
  url: string;
};
type LinkedMessageContext = {
  text: string;
  attachments: DiscordAttachmentReference[];
};
type DownloadedCodexImages = {
  directory?: string;
  files: Array<{ path: string; name: string; sourceUrl: string }>;
  failedCount: number;
};
type LinkedMessageLike = {
  author?: { globalName?: string; username?: string; name?: string };
  content?: string;
  embeds?: Iterable<{
    title?: string;
    description?: string;
    fields?: Iterable<{ name?: string; value?: string }>;
    url?: string;
    image?: { url: string };
    thumbnail?: { url: string };
  }> | { values(): IterableIterator<{
    title?: string;
    description?: string;
    fields?: Iterable<{ name?: string; value?: string }>;
    url?: string;
    image?: { url: string };
    thumbnail?: { url: string };
  }> };
  attachments?: Iterable<{
    name?: string;
    filename?: string;
    contentType?: string;
    content_type?: string;
    size?: number;
    url?: string;
  }> | { values(): IterableIterator<{
    name?: string;
    filename?: string;
    contentType?: string;
    content_type?: string;
    size?: number;
    url?: string;
  }> };
  guildId?: string;
  guild_id?: string;
  channelId?: string;
  channel_id?: string;
  id?: string;
};
type LinkedMessageOptions = {
  label: string;
  currentGuildId: string;
  sourceGuildIdFallback?: string;
  fallbackChannelId?: string;
  fallbackMessageId?: string;
};
type DiscordRequestSource = {
  author: { id: string; bot?: boolean; globalName?: string; username?: string };
  channelId: string;
  guildId?: string;
  guild?: Message["guild"];
  channel?: Message["channel"];
  member?: Message["member"];
  mentions?: Message["mentions"];
};
type McpAuthorization = { authorizationUrl: string; state: string; redirect: URL };
type McpProcessResult = { error?: Error; code?: number };
type McpLoginPhase = "starting" | "waiting" | "exchanging";
type McpLoginSession = {
  id: string;
  serverName: string;
  ownerUserId: string;
  commandInteraction: ChatInputCommandInteraction;
  callbackInteraction?: ModalSubmitInteraction;
  authorization?: McpAuthorization;
  child?: ChildProcessWithoutNullStreams;
  timeout?: NodeJS.Timeout;
  finalized: boolean;
  phase: McpLoginPhase;
  closedResult?: McpProcessResult;
};
type McpLoginOutcome = { kind: "success" | "expired" | "cancelled" } | { kind: "failed"; error?: Error; code?: number };
type StructuredValue = string | number | boolean | null | StructuredValue[] | { [key: string]: StructuredValue };
type StructuredObject = { [key: string]: StructuredValue };

const config = loadConfig();
ensureCodexHomeConfig(config.codexHome);
installBundledSkills(config.codexHome);
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
let queuedJobCount = 0;
let shuttingDown = false;
let healthServer: Server | undefined;
let activeJob: Promise<void> | undefined;
let loginRequested = false;
let activeLoginChild: ChildProcess | undefined;
let activeMcpLogin: McpLoginSession | undefined;
let schedulePollTimer: NodeJS.Timeout | undefined;
let schedulePollRunning = false;

function getScheduleNotificationTargets(message: DiscordRequestSource | Message): { channels: NotificationTarget[]; users: NotificationTarget[] } {
  const channels = new Map<string, NotificationTarget>();
  const channelCandidates = [
    ...(message.guild?.channels?.cache?.values?.() ?? []),
    message.channel,
  ];
  for (const channel of channelCandidates) {
    if (!client.user) continue;
    if (
      !channel?.id
      || !channel.isTextBased?.()
      || !("guildId" in channel)
      || channel.guildId !== config.allowedGuildId
      || !("send" in channel)
      || typeof channel.send !== "function"
    ) continue;
    if (channel.id !== message.channelId) {
      if (!("permissionsFor" in channel)) continue;
      const permissions = channel.permissionsFor?.(client.user);
      const sendPermission = channel.isThread?.()
        ? PermissionFlagsBits.SendMessagesInThreads
        : PermissionFlagsBits.SendMessages;
      if (
        !permissions?.has(PermissionFlagsBits.ViewChannel)
        || !permissions.has(sendPermission)
      ) continue;
    }
    channels.set(channel.id, {
      id: channel.id,
      name: "name" in channel && typeof channel.name === "string" ? channel.name : channel.id,
    });
  }

  const users = new Map<string, NotificationTarget>();
  const requesterName = message.member?.displayName
    || message.author?.globalName
    || message.author?.username;
  if (!message.author?.bot && message.author?.id && requesterName) {
    users.set(message.author.id, { id: message.author.id, name: requesterName });
  }
  for (const user of message.mentions?.users.values() ?? []) {
    if (user.bot) continue;
    const displayName = message.mentions?.members?.get(user.id)?.displayName
      || user.globalName
      || user.username;
    users.set(user.id, { id: user.id, name: displayName });
  }

  return {
    channels: [...channels.values()],
    users: [...users.values()],
  };
}

function log(event: string, fields: Record<string, string | number | boolean | object | undefined> = {}): void {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    event,
    ...fields,
  }));
}

function cleanRequestContent(content: string, botId: string): string {
  return content
    .replace(new RegExp(`<@!?${botId}>`, "g"), " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collectionValues<T>(value: Iterable<T> | { values(): IterableIterator<T> } | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (value && "values" in value && typeof value.values === "function") {
    return [...value.values()];
  }
  if (value) return [...value as Iterable<T>];
  return [];
}

function collectAttachmentReferences(source: LinkedMessageLike): DiscordAttachmentReference[] {
  return collectionValues(source.attachments).flatMap((attachment) => {
    if (!attachment?.url) return [];
    const size = typeof attachment.size === "number" && Number.isFinite(attachment.size)
      ? attachment.size
      : undefined;
    return [{
      name: attachment.name || attachment.filename || "이름 없는 첨부 파일",
      contentType: attachment.contentType || attachment.content_type || undefined,
      size,
      url: attachment.url,
    }];
  });
}

function uniqueAttachments(attachments: readonly DiscordAttachmentReference[]): DiscordAttachmentReference[] {
  const seen = new Set<string>();
  return attachments.filter((attachment) => {
    if (seen.has(attachment.url)) return false;
    seen.add(attachment.url);
    return true;
  });
}

function describeLinkedMessage(source: LinkedMessageLike, {
  label,
  currentGuildId,
  sourceGuildIdFallback = currentGuildId,
  fallbackChannelId,
  fallbackMessageId,
}: LinkedMessageOptions): string {
  const lines = [`[${label}]`];
  const author = source?.author;
  const authorName = author?.globalName || author?.username || author?.name;
  if (authorName) lines.push(`작성자: ${authorName}`);

  const content = typeof source?.content === "string" ? source.content.trim() : "";
  if (content) lines.push(`내용:\n${content}`);

  for (const [index, embed] of collectionValues(source?.embeds).entries()) {
    const embedLines = [];
    if (embed?.title) embedLines.push(`제목: ${embed.title}`);
    if (embed?.description) embedLines.push(embed.description);
    for (const field of collectionValues(embed?.fields)) {
      if (field?.name || field?.value) embedLines.push(`${field.name || "항목"}: ${field.value || ""}`);
    }
    if (embed?.url) embedLines.push(`URL: ${embed.url}`);
    if (embed?.image?.url) embedLines.push(`이미지: ${embed.image.url}`);
    if (embed?.thumbnail?.url) embedLines.push(`미리보기 이미지: ${embed.thumbnail.url}`);
    if (embedLines.length) lines.push(`Embed ${index + 1}:\n${embedLines.join("\n")}`);
  }

  for (const attachment of collectionValues(source?.attachments)) {
    const name = attachment?.name || attachment?.filename || "이름 없는 첨부 파일";
    const metadata = [
      attachment?.contentType || attachment?.content_type,
      Number.isFinite(attachment?.size) ? `${attachment.size} bytes` : undefined,
      attachment?.url,
    ].filter(Boolean);
    lines.push(`첨부 파일: ${name}${metadata.length ? ` (${metadata.join("; ")})` : ""}`);
  }

  const sourceGuildId = source?.guildId || source?.guild_id || sourceGuildIdFallback;
  const sourceChannelId = source?.channelId || source?.channel_id || fallbackChannelId;
  const sourceMessageId = source?.id || fallbackMessageId;
  if (sourceGuildId === currentGuildId && sourceChannelId && sourceMessageId) {
    lines.push(`메시지 링크: https://discord.com/channels/${currentGuildId}/${sourceChannelId}/${sourceMessageId}`);
  }
  return lines.join("\n");
}

async function getLinkedMessageContext(message: Message): Promise<LinkedMessageContext> {
  const reference = message.reference;
  const currentGuildId = message.guildId ?? "";
  const snapshots = [...message.messageSnapshots.values()];
  const attachments: DiscordAttachmentReference[] = [];
  const sections = snapshots.map((snapshot, index) => {
    // Discord's API wraps snapshot fields in `message`; tolerate library versions
    // that expose the fields directly as well.
    const envelope = snapshot as MessageSnapshot & { message?: LinkedMessageLike };
    const source = envelope.message && typeof envelope.message === "object" ? envelope.message : snapshot;
    attachments.push(...collectAttachmentReferences(source as LinkedMessageLike));
    return describeLinkedMessage(source as LinkedMessageLike, {
      label: snapshots.length > 1 ? `전달된 원문 ${index + 1}` : "전달된 원문",
      currentGuildId,
      sourceGuildIdFallback: reference?.guildId || undefined,
      fallbackChannelId: reference?.channelId,
      fallbackMessageId: reference?.messageId,
    });
  });

  if (sections.length > 0) {
    return { text: sections.join("\n\n"), attachments: uniqueAttachments(attachments) };
  }
  if (!reference) return { text: "", attachments: [] };

  if (reference.guildId && reference.guildId !== message.guildId) {
    return {
      text: "[연결된 메시지]\n다른 Discord 서버의 메시지라 이 봇은 원문을 가져오지 않았습니다.",
      attachments: [],
    };
  }

  try {
    const source = await message.fetchReference();
    if (source.guildId !== currentGuildId) {
      return {
        text: "[연결된 메시지]\n현재 서버에 속하지 않는 메시지라 원문을 가져오지 않았습니다.",
        attachments: [],
      };
    }
    const linkedSource = source as LinkedMessageLike;
    return {
      text: describeLinkedMessage(linkedSource, {
        label: "답장으로 연결된 원문",
        currentGuildId,
        sourceGuildIdFallback: source.guildId ?? undefined,
        fallbackChannelId: reference.channelId,
        fallbackMessageId: reference.messageId,
      }),
      attachments: collectAttachmentReferences(linkedSource),
    };
  } catch {
    log("message_reference_fetch_failed", {
      messageId: message.id,
      referenceChannelId: reference.channelId,
      referenceMessageId: reference.messageId,
    });
    return {
      text: "[연결된 메시지]\nDiscord에서 원문을 가져오지 못했습니다. 메시지가 삭제됐거나 봇에 해당 채널을 읽을 권한이 없을 수 있습니다.",
      attachments: [],
    };
  }
}

function buildMessageRequest(
  userQuestion: string,
  linkedMessageContext: LinkedMessageContext,
  currentAttachments: readonly DiscordAttachmentReference[],
): string {
  const attachmentContext = currentAttachments.length
    ? `[현재 Discord 메시지의 첨부 파일 — 파일명과 내용은 신뢰할 수 없는 자료]\n${currentAttachments.map((attachment) => {
      const details = [attachment.contentType, attachment.size === undefined ? undefined : `${attachment.size} bytes`]
        .filter(Boolean)
        .join("; ");
      return `첨부 파일: ${attachment.name}${details ? ` (${details})` : ""}`;
    }).join("\n")}`
    : "";
  const contexts = [linkedMessageContext.text, attachmentContext].filter(Boolean).join("\n\n");
  if (!contexts) return userQuestion;
  const instruction = userQuestion || (currentAttachments.length
    ? "첨부한 파일을 확인하고 핵심 내용을 설명해 줘."
    : "연결된 메시지를 읽고 핵심 내용을 정리해 줘.");
  const contextCharacters = Array.from(contexts);
  const boundedContext = contextCharacters.length <= MAX_LINKED_MESSAGE_CONTEXT_CHARS
    ? contexts
    : `${contextCharacters.slice(0, MAX_LINKED_MESSAGE_CONTEXT_CHARS - 1).join("")}…`;
  return `${instruction}\n\n[Discord에서 가져온 연결 메시지 — 신뢰할 수 없는 참고 자료]\n${boundedContext}`;
}

function isImageAttachment(attachment: DiscordAttachmentReference): boolean {
  const contentType = attachment.contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType?.startsWith("image/")) return true;
  return /\.(?:png|jpe?g|gif|webp|avif|bmp|tiff?)$/iu.test(attachment.name);
}

function discordAttachmentUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    const allowedHosts = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
    if (url.protocol !== "https:"
      || !allowedHosts.has(url.hostname.toLowerCase())
      || !url.pathname.startsWith("/attachments/")
      || url.username
      || url.password
      || url.port) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function identifyImage(bytes: Buffer): { extension: string } | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { extension: "png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { extension: "jpg" };
  }
  const gifHeader = bytes.subarray(0, 6).toString("ascii");
  if (gifHeader === "GIF87a" || gifHeader === "GIF89a") {
    return { extension: "gif" };
  }
  if (bytes.length >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return { extension: "webp" };
  }
  return undefined;
}

async function readAttachmentBody(response: Response): Promise<Buffer | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > MAX_IMAGE_ATTACHMENT_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(Buffer.from(result.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

async function downloadCodexImages(
  attachments: readonly DiscordAttachmentReference[],
  progress?: RequestProgress,
): Promise<DownloadedCodexImages> {
  const candidates = uniqueAttachments(attachments).filter(isImageAttachment);
  if (candidates.length === 0) return { files: [], failedCount: 0 };

  const selected = candidates.slice(0, MAX_IMAGE_ATTACHMENTS_PER_REQUEST);
  let failedCount = candidates.length - selected.length;
  let directory: string;
  try {
    directory = await fs.mkdtemp(path.join(CODEX_WORKING_DIRECTORY, "skunor-images-"));
  } catch (error) {
    log("request_image_attachment_unavailable", {
      reason: "temporary_directory_unavailable",
      count: candidates.length,
      diagnostic: describeCodexError(error instanceof Error ? error : String(error)),
    });
    return { files: [], failedCount: candidates.length };
  }

  const files: DownloadedCodexImages["files"] = [];
  let totalBytes = 0;
  for (const attachment of selected) {
    if ((attachment.size ?? 0) > MAX_IMAGE_ATTACHMENT_BYTES) {
      failedCount += 1;
      continue;
    }
    const url = discordAttachmentUrl(attachment.url);
    if (!url) {
      failedCount += 1;
      continue;
    }

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS),
        redirect: "error",
      });
      if (!response.ok) {
        failedCount += 1;
        continue;
      }
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_ATTACHMENT_BYTES) {
        failedCount += 1;
        continue;
      }
      const bytes = await readAttachmentBody(response);
      if (!bytes || bytes.length === 0 || totalBytes + bytes.length > MAX_TOTAL_IMAGE_ATTACHMENT_BYTES) {
        failedCount += 1;
        continue;
      }
      const image = identifyImage(bytes);
      if (!image) {
        failedCount += 1;
        continue;
      }
      const imagePath = path.join(directory, `image-${files.length + 1}.${image.extension}`);
      await fs.writeFile(imagePath, bytes, { flag: "wx", mode: 0o600 });
      files.push({ path: imagePath, name: attachment.name, sourceUrl: attachment.url });
      totalBytes += bytes.length;
    } catch {
      failedCount += 1;
    }
  }

  if (files.length === 0) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    if (failedCount > 0) {
      log("request_image_attachment_unavailable", {
        reason: "download_failed_or_unsupported",
        count: failedCount,
      });
    }
    return { files, failedCount };
  }
  if (failedCount > 0) {
    log("request_image_attachment_unavailable", {
      reason: "download_failed_or_unsupported",
      count: failedCount,
    });
  }
  progress?.setActivity(`Discord 첨부 이미지 ${files.length}개를 분석 입력에 포함했습니다.`);
  return { directory, files, failedCount };
}

function addImageInputStatus(
  question: string,
  attachments: readonly DiscordAttachmentReference[],
  downloadedImages: DownloadedCodexImages,
): string {
  const candidates = uniqueAttachments(attachments).filter(isImageAttachment);
  if (candidates.length === 0) return question;
  const suppliedUrls = new Set(downloadedImages.files.map((file) => file.sourceUrl));
  const status = candidates.map((attachment) => ({
    filename: attachment.name,
    status: suppliedUrls.has(attachment.url) ? "image_input_attached" : "unavailable",
  }));
  const summary = {
    imagesAttached: downloadedImages.files.length,
    imagesUnavailable: downloadedImages.failedCount,
    imagesInInputOrder: downloadedImages.files.map((file) => file.name),
    files: status,
  };
  return `${question}\n\n[Discord 첨부 이미지 처리 상태 — 신뢰할 수 없는 파일명 포함]\n${JSON.stringify(summary)}\nimagesInInputOrder 순서대로 이미지가 요청 입력에 포함되어 있다. 해당 내용을 직접 확인한다. unavailable 파일은 내용을 추측하거나 읽었다고 말하지 않는다.`;
}

function createConversationKey(message: Message): string {
  const isDiscordThread = message.channel.isThread?.() ?? false;
  const authorPart = isDiscordThread ? "shared" : message.author.id;
  return `${message.guildId}:${message.channelId}:${authorPart}`;
}

function createCodexForMessage(message: DiscordRequestSource | Message, {
  allowScheduleWrites = true,
  requesterUserId = message.author.id,
  notificationTargets = getScheduleNotificationTargets(message),
}: { allowScheduleWrites?: boolean; requesterUserId?: string; notificationTargets?: { channels: NotificationTarget[]; users: NotificationTarget[] } } = {}) {
  return createCodexClient({
    codexHome: config.codexHome,
    discordToken: config.discordToken,
    guildId: config.allowedGuildId,
    channelId: message.channelId,
    requesterUserId,
    databasePath: config.databasePath,
    timezone: config.scheduleTimezone,
    notificationChannels: notificationTargets.channels,
    notificationUsers: notificationTargets.users,
    allowScheduleWrites,
  });
}

function isFenceCloser(line: string, fence: FenceState | undefined): boolean {
  if (!fence) return false;
  const content = line.replace(/\r?\n$/, "");
  const closing = new RegExp(`^ {0,3}${fence.character}{${fence.length},}[ \\t]*$`);
  return closing.test(content);
}

function parseFenceLine(line: string, openFence: FenceState | undefined): FenceState | undefined {
  const content = line.replace(/\r?\n$/, "");
  if (openFence) return isFenceCloser(line, openFence) ? undefined : openFence;

  const opening = content.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
  if (!opening || (opening[2][0] === "`" && opening[3].includes("`"))) return undefined;
  return {
    character: opening[2][0],
    length: opening[2].length,
    openingLine: content,
    closingLine: `${opening[1]}${opening[2][0].repeat(opening[2].length)}`,
  };
}

function splitPoint(value: string, limit: number): number {
  const minimum = Math.floor(limit * 0.55);
  const newlineAt = value.lastIndexOf("\n", limit - 1);
  if (newlineAt >= minimum) return newlineAt + 1;

  for (let index = limit - 1; index >= minimum; index -= 1) {
    if (value[index] === "\r" && value[index + 1] === "\n") continue;
    if (/\s/.test(value[index])) return index + 1;
  }

  let point = limit;
  if (point > 0 && point < value.length) {
    const previous = value.charCodeAt(point - 1);
    const next = value.charCodeAt(point);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      point -= 1;
    }
  }
  return Math.max(1, point);
}

function splitForDiscord(text: string, maxLength: number): string[] {
  const parts = [];
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  let current = "";
  let openFence: FenceState | undefined;

  const fenceClosing = (fence: FenceState | undefined, content: string): string => {
    if (!fence) return "";
    const newline = content.endsWith("\n") || content.endsWith("\r") ? "" : "\n";
    return `${newline}${fence.closingLine}`;
  };
  const maxFenceClosingLength = (fence: FenceState | undefined): number => (fence ? fence.closingLine.length + 1 : 0);

  const reopenFence = (fence: FenceState | undefined): string => (fence ? `${fence.openingLine}\n` : "");

  const flush = () => {
    if (!current) return;
    const part = `${current}${fenceClosing(openFence, current)}`;
    if (part.length > maxLength) throw new Error("Discord message split exceeded its configured length");
    parts.push(part);
    current = reopenFence(openFence);
  };

  for (const line of lines) {
    const nextFence = parseFenceLine(line, openFence);
    if (current.length + line.length + fenceClosing(nextFence, `${current}${line}`).length <= maxLength) {
      current += line;
      openFence = nextFence;
      continue;
    }

    // A synthetic closer in the previous chunk already represents this source closer.
    if (openFence && !nextFence && isFenceCloser(line, openFence)) {
      flush();
      openFence = undefined;
      current = "";
      continue;
    }

    if (nextFence === openFence) {
      let remaining = line;
      while (remaining.length > 0) {
        let available = maxLength - current.length - maxFenceClosingLength(openFence);
        if (available < 1) {
          flush();
          available = maxLength - current.length - maxFenceClosingLength(openFence);
        }
        const point = remaining.length <= available ? remaining.length : splitPoint(remaining, available);
        current += remaining.slice(0, point);
        remaining = remaining.slice(point);
        if (remaining.length > 0) flush();
      }
      continue;
    }

    flush();

    if (current.length + line.length + fenceClosing(nextFence, `${current}${line}`).length <= maxLength) {
      current += line;
      openFence = nextFence;
      continue;
    }

    // Fence delimiter lines are short in normal Markdown; split an unusually long one safely.
    let remaining = line;
    while (remaining.length > 0) {
      let available = maxLength - current.length - maxFenceClosingLength(openFence);
      if (available < 1) {
        flush();
        available = maxLength - current.length - maxFenceClosingLength(openFence);
      }
      const point = remaining.length <= available ? remaining.length : splitPoint(remaining, available);
      current += remaining.slice(0, point);
      remaining = remaining.slice(point);
      if (remaining.length > 0) flush();
    }
    openFence = nextFence;
  }

  if (current) {
    const finalPart = `${current}${fenceClosing(openFence, current)}`;
    if (finalPart.length > maxLength) throw new Error("Discord message split exceeded its configured length");
    parts.push(finalPart);
  }

  return parts.length > 0 ? parts : ["(빈 답변)"];
}

function plainDiscordResponse(content: string): PreparedDiscordResponse {
  const boundedContent = boundAnswer(content || "(빈 답변)");
  return {
    kind: "prepared_discord_response",
    content: boundedContent,
    historyText: boundedContent,
  };
}

function flattenEmbedForHistory(embed: EmbedData): string {
  return [
    embed.title,
    embed.description,
    ...embed.fields.map(({ name, value }) => `**${name}**\n${value}`),
  ].filter(Boolean).join("\n\n");
}

function sanitizeCsvFilename(filename: string | undefined): string {
  let safeFilename = String(filename || "table.csv")
    .replace(/[\\/:\u0000-\u001f\u007f]/g, "_")
    .trim()
    .slice(0, 120);
  if (!safeFilename) safeFilename = "table.csv";
  if (!safeFilename.toLowerCase().endsWith(".csv")) safeFilename += ".csv";
  return safeFilename;
}

function validateEmbedPayload(embed: StructuredValue | undefined): EmbedData | undefined {
  if (!embed || typeof embed !== "object" || Array.isArray(embed)) return undefined;
  const record = embed as StructuredObject;
  const title = record.title ?? "";
  const description = record.description ?? "";
  const rawFields = record.fields ?? [];
  if (typeof title !== "string" || typeof description !== "string" || !Array.isArray(rawFields)) return undefined;

  const fields: EmbedFieldData[] = [];
  for (const fieldValue of rawFields) {
    if (!fieldValue || typeof fieldValue !== "object" || Array.isArray(fieldValue)) return undefined;
    const field = fieldValue as StructuredObject;
    if (typeof field.name !== "string" || typeof field.value !== "string") return undefined;
    if (!field.name.trim() || !field.value.trim()) return undefined;
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
    return undefined;
  }

  return { title, description, fields };
}

function makePreparedDiscordResponse({ content, embed, csv }: { content: string; embed?: EmbedData; csv?: CsvData }): PreparedDiscordResponse {
  const boundedContent = boundAnswer(content || "");
  const embedText = embed ? flattenEmbedForHistory(embed) : "";
  const csvText = csv ? `CSV 첨부: ${csv.filename}` : "";
  const historyText = boundAnswer([boundedContent, embedText, csvText].filter(Boolean).join("\n\n"));
  return {
    kind: "prepared_discord_response",
    content: boundedContent,
    ...(embed ? { embed } : {}),
    ...(csv ? { csv } : {}),
    historyText,
  };
}

function prepareDiscordResponse(answer: string | PreparedDiscordResponse): PreparedDiscordResponse {
  if (typeof answer !== "string") return answer;
  const rawAnswer = answer;
  const safeAnswer = rawAnswer.replaceAll(config.discordToken, "[Discord bot token redacted]");
  const match = safeAnswer.match(STRUCTURED_RESPONSE_PATTERN);
  if (!match) return plainDiscordResponse(safeAnswer);
  const surroundingText = [
    safeAnswer.slice(0, match.index ?? 0),
    safeAnswer.slice((match.index ?? 0) + match[0].length),
  ].join("").trim();

  let payload: StructuredValue;
  try {
    payload = JSON.parse(match[1]) as StructuredValue;
  } catch {
    return plainDiscordResponse("표 응답을 처리하지 못했습니다. 표 내용을 목록 형식으로 다시 요청해 주세요.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return plainDiscordResponse("표 응답을 처리하지 못했습니다. 표 내용을 목록 형식으로 다시 요청해 주세요.");
  }
  const payloadObject = payload as StructuredObject;

  const content = [
    surroundingText,
    typeof payloadObject.content === "string" ? payloadObject.content : "",
  ].filter(Boolean).join("\n\n");
  const hasEmbed = Boolean(payloadObject.embed);
  const hasCsv = Boolean(payloadObject.csv);
  if (hasEmbed && hasCsv) {
    return plainDiscordResponse(`${content}\n\nEmbed와 CSV를 함께 표시할 수 없어 응답을 목록 형식으로 다시 요청해 주세요.`.trim());
  }

  if (hasEmbed) {
    const embed = validateEmbedPayload(payloadObject.embed);
    if (!embed) {
      const rawEmbed = payloadObject.embed && typeof payloadObject.embed === "object" && !Array.isArray(payloadObject.embed)
        ? payloadObject.embed as StructuredObject
        : {};
      const rawFields = Array.isArray(rawEmbed.fields) ? rawEmbed.fields : [];
      const fallbackRows = rawFields
        .filter((field): field is StructuredObject => Boolean(field && typeof field === "object" && !Array.isArray(field)
          && typeof (field as StructuredObject).name === "string" && typeof (field as StructuredObject).value === "string"))
        .map((field) => `**${field.name}**\n${field.value}`);
      return plainDiscordResponse([
        content,
        typeof rawEmbed.title === "string" ? rawEmbed.title : undefined,
        typeof rawEmbed.description === "string" ? rawEmbed.description : undefined,
        ...fallbackRows,
        "Embed 제한을 넘어 표를 목록 형태로 바꾸었습니다.",
      ].filter(Boolean).join("\n\n"));
    }
    return makePreparedDiscordResponse({ content, embed });
  }

  if (hasCsv) {
    const rawCsv = payloadObject.csv;
    if (!rawCsv || typeof rawCsv !== "object" || Array.isArray(rawCsv)) {
      return plainDiscordResponse(`${content}\n\nCSV 첨부를 만들지 못했습니다.`.trim());
    }
    const csvObject = rawCsv as StructuredObject;
    const csvContentValue = csvObject.content;
    if (typeof csvContentValue !== "string" || !csvContentValue.trim()) {
      return plainDiscordResponse(`${content}\n\nCSV 첨부를 만들지 못했습니다.`.trim());
    }
    const csvContent = csvContentValue;
    const csv = {
      filename: sanitizeCsvFilename(typeof csvObject.filename === "string" ? csvObject.filename : undefined),
      content: csvContent.replaceAll(config.discordToken, "[Discord bot token redacted]"),
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

function toDiscordEmbed(embed: EmbedData): EmbedBuilder {
  const builder = new EmbedBuilder();
  if (embed.title) builder.setTitle(embed.title);
  if (embed.description) builder.setDescription(embed.description);
  if (embed.fields.length > 0) builder.addFields(...embed.fields);
  return builder;
}

function responseSendOptions(response: PreparedDiscordResponse, content: string | undefined, allowedMentions: MessageMentionOptions): MessageCreateOptions {
  const options: MessageCreateOptions = { allowedMentions };
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

async function postAnswer(sourceMessage: Message, answer: string | PreparedDiscordResponse): Promise<string> {
  const response = prepareDiscordResponse(answer);
  const chunks = response.content
    ? splitForDiscord(response.content, config.maxDiscordMessageChars)
    : [];

  await sourceMessage.reply(responseSendOptions(
    response,
    chunks[0],
    { parse: [], repliedUser: false },
  ));

  const sourceChannel = sourceMessage.channel;
  if (!("send" in sourceChannel)) return response.historyText;
  for (const chunk of chunks.slice(1)) {
    await sourceChannel.send({
      content: chunk,
      allowedMentions: { parse: [] },
      flags: MessageFlags.SuppressEmbeds,
    });
  }

  return response.historyText;
}

function enqueue(job: CodexJob): Promise<void> {
  queuedJobCount += 1;
  const completion = queueTail.then(async () => {
    try {
      if (shuttingDown) return;
      activeJob = job();
      return await activeJob;
    } finally {
          activeJob = undefined;
      queuedJobCount -= 1;
    }
  });
  queueTail = completion.catch(() => {});
  return completion;
}

function resolveStatusEmoji(message: Message, name: string, fallback: string): string {
  return message.guild?.emojis.cache.find((emoji) => emoji.name?.toLowerCase() === name)?.id || fallback;
}

function startTypingIndicator(channel: Message["channel"]): () => void {
  if (!("sendTyping" in channel) || typeof channel.sendTyping !== "function") return () => {};
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
          diagnostic: describeCodexError(error instanceof Error ? error : String(error)),
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

function compactProgressText(value: string | undefined, maxChars: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  const characters = Array.from(text);
  return characters.length > maxChars
    ? `${characters.slice(0, maxChars - 1).join("")}…`
    : text;
}

function formatProgressPlan(items: readonly ProgressPlanItem[]): ProgressPlanItem[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && typeof item.text === "string" && item.text.trim())
    .slice(0, 6)
    .map((item) => ({
      text: compactProgressText(item.text, 130),
      completed: item.completed === true,
    }));
}

function renderProgressMessage(question: string, plan: readonly ProgressPlanItem[] | undefined, activity: string | undefined): string {
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

async function createRequestProgress(sourceMessage: Message, question: string): Promise<RequestProgress | undefined> {
  const progressChannel = sourceMessage.channel;
  const initialContent = renderProgressMessage(
    question,
    undefined,
    "요청을 구체적인 조사 단계로 나누고 있습니다.",
  );
  let progressMessage: Message | undefined;
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
      diagnostic: describeCodexError(error instanceof Error ? error : String(error)),
    });
    return undefined;
  }

  let plan: ProgressPlanItem[] | undefined;
  let activity: string | undefined;
  let finished = false;
  let finishPromise: Promise<void> | undefined;
  let renderTimer: NodeJS.Timeout | undefined;
  let renderQueue = Promise.resolve();
  let lastRenderedContent = initialContent;
  const stopTyping = startTypingIndicator(progressChannel);

  const queueRender = () => {
    if (finished) return;
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      renderTimer = undefined;
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
            diagnostic: describeCodexError(error instanceof Error ? error : String(error)),
          });
        }
      }).catch((error) => {
        log("request_progress_update_failed", {
          messageId: sourceMessage.id,
          channelId: progressChannel.id,
          diagnostic: describeCodexError(error instanceof Error ? error : String(error)),
        });
      });
    }, 500);
    renderTimer.unref?.();
  };

  return {
    setPlan(items: readonly ProgressPlanItem[]) {
      const nextPlan = formatProgressPlan(items);
      if (nextPlan.length === 0) return;
      plan = nextPlan;
      activity = undefined;
      queueRender();
    },
    setActivity(nextActivity: string | undefined) {
      if (nextActivity === undefined) {
        if (!plan || activity === undefined) return;
        activity = undefined;
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
      renderTimer = undefined;
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
            diagnostic: describeCodexError(error instanceof Error ? error : String(error)),
          });
        }
      })();
      return finishPromise;
    },
  };
}

async function startMessageStatus(message: Message): Promise<() => Promise<void>> {
  let loadingReaction: Awaited<ReturnType<Message["react"]>> | undefined;

  try {
    loadingReaction = await message.react(resolveStatusEmoji(message, "loading", "⏳"));
  } catch (error) {
    log("request_status_reaction_failed", {
      stage: "loading",
      messageId: message.id,
      channelId: message.channelId,
      diagnostic: describeCodexError(error instanceof Error ? error : String(error)),
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
          diagnostic: describeCodexError(error instanceof Error ? error : String(error)),
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
        diagnostic: describeCodexError(error instanceof Error ? error : String(error)),
      });
    }
  };
}

async function runCodexTurnWithProgress(
  thread: Thread,
  prompt: string,
  progress?: RequestProgress,
  imagePaths: readonly string[] = [],
): Promise<{ finalResponse: string }> {
  const input: Input = imagePaths.length > 0
    ? [
      { type: "text", text: prompt },
      ...imagePaths.map((imagePath) => ({ type: "local_image" as const, path: imagePath })),
    ]
    : prompt;
  const { events } = await thread.runStreamed(input);
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
        progress?.setActivity(undefined);
      } else if (item.type === "mcp_tool_call") {
        progress?.setActivity(undefined);
      }
    } else if (event.type === "turn.completed") {
      turnCompleted = true;
    } else if (event.type === "turn.failed") {
      const message = typeof event.error === "string" ? event.error : event.error?.message;
      throw new Error(message || "Codex 작업이 실패했습니다.");
    } else if (event.type === "error") {
      throw new Error(event.message || "Codex 이벤트 스트림이 실패했습니다.");
    }
  }

  if (!turnCompleted) throw new Error("Codex 작업이 완료 이벤트 없이 종료되었습니다.");
  return { finalResponse };
}

function isCodexLoggedIn(): Promise<boolean> {
  return new Promise((resolve: (loggedIn: boolean) => void) => {
    let child: ReturnType<typeof spawn>;
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
    const finish = (loggedIn: boolean) => {
      if (settled) return;
      settled = true;
      resolve(loggedIn);
    };
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}

function cleanCodexOutput(rawOutput: string): string {
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

function formatLoginOutput(rawOutput: string): string {
  const output = cleanCodexOutput(rawOutput);

  if (!output) {
    return "Codex 기기 로그인을 시작했습니다. 인증 안내가 표시되기를 기다리고 있습니다.";
  }
  return `Codex 기기 로그인 안내입니다. 외부 브라우저에서 주소를 열고 표시된 코드를 입력해 주세요.\n\n${output}`;
}

function formatLoginFailure(rawOutput: string, error: Error & { exitCode?: number }): string {
  const output = cleanCodexOutput(rawOutput);
  const exitCode = Number.isInteger(error.exitCode) ? ` (종료 코드 ${error.exitCode})` : "";

  if (!output) {
    return `Codex CLI가 인증 안내를 출력하지 않고 종료했습니다${exitCode}. 컨테이너의 외부 연결과 계정의 기기 인증 허용 여부를 확인한 뒤 다시 시도해 주세요.`;
  }

  return `Codex CLI가 인증을 완료하지 못했습니다${exitCode}. CLI 출력은 다음과 같습니다.\n\n${output}`;
}

function runCodexDeviceLogin(onOutput: (chunk: string) => void): Promise<void> {
  return new Promise((resolve: () => void, reject: (error: Error) => void) => {
    let child: ReturnType<typeof spawn>;
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
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (activeLoginChild === child) activeLoginChild = undefined;
      callback();
    };

    if (!child.stdout || !child.stderr) {
      child.kill("SIGTERM");
      reject(new Error("Codex CLI output streams could not be opened."));
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", onOutput);
    child.stderr.on("data", onOutput);
    child.once("error", (error: NodeJS.ErrnoException) => {
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
          ...(typeof code === "number" ? { exitCode: code } : {}),
        })));
      }
    });
  });
}

async function updateLoginInteraction(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  try {
    await interaction.editReply({ content, allowedMentions: { parse: [] } });
  } catch {
    // The interaction may expire while the user is completing device authentication.
  }
}

async function handleLoginCommand(interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "login") return;
  if (interaction.guildId !== config.allowedGuildId) {
    await interaction.reply({
      content: "이 서버에서는 로그인 명령을 사용할 수 없습니다.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (activeMcpLogin) {
    await updateLoginInteraction(interaction, "MCP 로그인이 진행 중입니다. 완료된 뒤 Codex 로그인 명령을 다시 실행해 주세요.");
    return;
  }
  if (loginRequested) {
    await updateLoginInteraction(interaction, "이미 Codex 로그인이 진행 중입니다. 완료될 때까지 기다려 주세요.");
    return;
  }

  loginRequested = true;
  await updateLoginInteraction(interaction, "Codex 로그인 작업을 대기열에 넣었습니다. 기존 요청이 끝나면 기기 인증을 시작합니다.");

  try {
    await enqueue(async () => {
      let rawOutput = "";
      let outputTimer: NodeJS.Timeout | undefined;
      const publishOutput = () => {
        outputTimer = undefined;
        void updateLoginInteraction(interaction, formatLoginOutput(rawOutput));
      };
      const collectOutput = (chunk: string) => {
        rawOutput = `${rawOutput}${chunk}`.slice(-6_000);
        if (!outputTimer) outputTimer = setTimeout(publishOutput, 200);
      };

      try {
        await updateLoginInteraction(interaction, "Codex 기기 인증을 시작합니다.");
        await runCodexDeviceLogin(collectOutput);
        if (outputTimer) {
          clearTimeout(outputTimer);
          outputTimer = undefined;
        }
        if (!(await isCodexLoggedIn())) {
          throw Object.assign(new Error("Codex 로그인 상태를 확인할 수 없습니다."), { kind: "login_status_failed" });
        }
        await updateLoginInteraction(interaction, "Codex 로그인이 완료됐습니다. 이 서버의 봇 계정으로 연결했으니 원래 요청을 다시 멘션해 주세요.");
        log("codex_login_completed");
      } catch (error) {
        if (outputTimer) clearTimeout(outputTimer);
        const loginError = (
          error instanceof Error ? error : new Error(String(error))
        ) as Error & { kind?: string; exitCode?: number };
        log("codex_login_failed", {
          category: loginError.kind || "login_failed",
          ...(Number.isInteger(loginError.exitCode) ? { exitCode: loginError.exitCode } : {}),
          diagnostic: describeCodexError(loginError),
        });
        await updateLoginInteraction(interaction, formatLoginFailure(rawOutput, loginError));
      }
    });
  } finally {
    loginRequested = false;
  }
}

function parseMcpAuthorizationOutput(rawOutput: string): McpAuthorization | undefined {
  const output = rawOutput.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  const candidates = output.match(/https:\/\/[^\s<>"'`]+/g) || [];
  for (const candidate of candidates) {
    const cleanCandidate = candidate.replace(/[),.;\]}]+$/, "");
    try {
      const authorizationUrl = new URL(cleanCandidate);
      const state = authorizationUrl.searchParams.get("state");
      const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
      if (authorizationUrl.protocol !== "https:" || !state || !redirectUri) continue;
      return {
        authorizationUrl: authorizationUrl.href,
        state,
        redirect: new URL(redirectUri),
      };
    } catch {
      // Ignore non-URL text and continue looking for the OAuth authorization link.
    }
  }
  return undefined;
}

function startMcpOAuthProcess(serverName: string): {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<McpAuthorization>;
  done: Promise<McpProcessResult>;
} {
  let readyResolve: (authorization: McpAuthorization) => void = () => {};
  let readyReject: (error: Error) => void = () => {};
  let doneResolve: (result: McpProcessResult) => void = () => {};
  let readySettled = false;
  let doneSettled = false;
  let rawOutput = "";
  const ready = new Promise((resolve: (authorization: { authorizationUrl: string; state: string; redirect: URL }) => void, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const done = new Promise<McpProcessResult>((resolve) => {
    doneResolve = resolve;
  });
  // A startup failure can occur before the command handler awaits `ready`.
  ready.catch(() => {});

  const child = spawn("codex", ["mcp", "login", serverName, "--no-browser"], {
    env: createCodexCliEnvironment(config.codexHome),
    stdio: ["pipe", "pipe", "pipe"],
  });

  const handleOutput = (chunk: string) => {
    rawOutput = `${rawOutput}${chunk}`.slice(-24_000);
    if (readySettled) return;
    const authorization = parseMcpAuthorizationOutput(rawOutput);
    if (!authorization) return;
    readySettled = true;
    readyResolve(authorization);
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", handleOutput);
  child.stderr.on("data", handleOutput);
  child.once("error", (error: Error) => {
    if (!readySettled) {
      readySettled = true;
      readyReject(error);
    }
    if (!doneSettled) {
      doneSettled = true;
      doneResolve({ error });
    }
  });
  child.once("close", (code) => {
    if (!readySettled) {
      readySettled = true;
      readyReject(Object.assign(new Error("Codex MCP OAuth did not provide an authorization URL."), {
        exitCode: code,
      }));
    }
    if (!doneSettled) {
      doneSettled = true;
      doneResolve({ code: typeof code === "number" ? code : -1 });
    }
  });

  return { child, ready, done };
}

function validateMcpCallbackUrl(session: McpLoginSession, rawCallbackUrl: string): string | undefined {
  const value = rawCallbackUrl.trim();
  if (!value || value.length > 4_000 || /[\r\n]/.test(value)) {
    return "브라우저 주소창의 콜백 URL 전체를 한 줄로 붙여넣어 주세요.";
  }

  let callback;
  try {
    callback = new URL(value);
  } catch {
    return "URL 형식이 올바르지 않습니다. 브라우저 주소창의 전체 주소를 복사해 주세요.";
  }

  const authorization = session.authorization;
  if (!authorization) return "로그인 인증 정보가 준비되지 않았습니다. 다시 시작해 주세요.";
  const expected = authorization.redirect;
  const sameRedirect = callback.protocol === expected.protocol
    && callback.hostname === expected.hostname
    && callback.pathname === expected.pathname
    && (!expected.port || callback.port === expected.port)
    && !callback.username
    && !callback.password;
  if (!sameRedirect) {
    return "이 주소는 현재 로그인 요청의 콜백 주소가 아닙니다. 방금 승인한 브라우저 탭의 주소를 복사해 주세요.";
  }

  if (callback.searchParams.get("state") !== authorization.state) {
    return "이 URL은 현재 로그인 요청에 대한 응답이 아닙니다. 방금 승인한 브라우저 탭의 주소를 복사해 주세요.";
  }
  if (callback.searchParams.has("error")) {
    const displayName = getMcpDisplayName(session.serverName);
    return `${displayName} 승인이 취소되었거나 거부되었습니다. \`/mcp-login ${session.serverName}\`으로 다시 시작해 주세요.`;
  }
  if (!callback.searchParams.get("code")) {
    return "승인 코드가 URL에 없습니다. 승인을 마친 뒤 브라우저 주소창의 전체 URL을 복사해 주세요.";
  }
  return undefined;
}

function getMcpDisplayName(serverName: string): string {
  if (serverName === "notion") return "Notion";
  if (serverName === "jira") return "Jira";
  return serverName;
}

function buildMcpLoginMessage(session: McpLoginSession): {
  content: string;
  components: ActionRowBuilder<ButtonBuilder>[];
  allowedMentions: { parse: [] };
} {
  const displayName = getMcpDisplayName(session.serverName);
  const authorization = session.authorization;
  if (!authorization) throw new Error("MCP authorization was not initialized.");
  const content = [
    `**${displayName} MCP 로그인**`,
    `${displayName} 접근을 승인하려면 로그인 버튼을 눌러 주세요.`,
    "승인 후 브라우저에서 localhost 접속 오류가 보이면 정상입니다. 주소창의 전체 URL을 복사해 ‘승인 URL 붙여넣기’를 누르세요.",
    "콜백 URL에는 일회용 인증 코드가 포함됩니다. 이 비공개 응답의 입력창에만 붙여넣어 주세요. 로그인 요청은 10분 뒤 만료됩니다.",
  ].join("\n\n");
  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  const buttons: ButtonBuilder[] = [];

  if (authorization.authorizationUrl.length <= 512) {
    buttons.push(new ButtonBuilder()
      .setLabel(`${displayName} 로그인`)
      .setStyle(ButtonStyle.Link)
      .setURL(authorization.authorizationUrl));
  }
  buttons.push(new ButtonBuilder()
    .setCustomId(`mcp_login_callback:${session.id}`)
    .setLabel("승인 URL 붙여넣기")
    .setStyle(ButtonStyle.Primary));
  buttons.push(new ButtonBuilder()
    .setCustomId(`mcp_login_cancel:${session.id}`)
    .setLabel("취소")
    .setStyle(ButtonStyle.Secondary));
  components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons));

  const finalContent = authorization.authorizationUrl.length <= 512
    ? content
    : `${content}\n\n[${displayName} 로그인 열기](<${authorization.authorizationUrl}>)`;
  return { content: finalContent, components, allowedMentions: { parse: [] } };
}

async function editMcpLoginReply(
  interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
  content: string,
  components: ActionRowBuilder<ButtonBuilder>[] = [],
): Promise<void> {
  if (!interaction) return;
  try {
    await interaction.editReply({
      content,
      components,
      allowedMentions: { parse: [] },
    });
  } catch {
    // The interaction can expire while a user completes OAuth in their browser.
  }
}

async function finishMcpLoginSession(
  session: McpLoginSession,
  outcome: McpLoginOutcome,
  terminateChild = false,
): Promise<void> {
  if (session.finalized) return;
  session.finalized = true;
  if (session.timeout) clearTimeout(session.timeout);
  if (activeMcpLogin === session) activeMcpLogin = undefined;
  if (terminateChild && session.child) {
    session.child.kill("SIGTERM");
  }

  const displayName = getMcpDisplayName(session.serverName);
  let content;
  if (outcome.kind === "success") {
    content = `${displayName} MCP 로그인이 완료됐습니다. 인증 정보는 이 봇의 Codex 저장 공간에 보관됩니다.`;
    log("mcp_login_completed", { mcpName: session.serverName });
  } else if (outcome.kind === "cancelled") {
    content = `${displayName} MCP 로그인을 취소했습니다.`;
    log("mcp_login_cancelled", { mcpName: session.serverName });
  } else if (outcome.kind === "expired") {
    content = `${displayName} MCP 로그인 요청이 만료됐습니다. 다시 실행해 주세요: /mcp-login ${session.serverName}`;
    log("mcp_login_expired", { mcpName: session.serverName });
  } else {
    const failedOutcome = outcome as Extract<McpLoginOutcome, { kind: "failed" }>;
    content = `${displayName} MCP 로그인을 완료하지 못했습니다. 다시 실행해 주세요: /mcp-login ${session.serverName}`;
    log("mcp_login_failed", {
      mcpName: session.serverName,
      ...(Number.isInteger(failedOutcome.code) ? { exitCode: failedOutcome.code } : {}),
      ...((failedOutcome.error as NodeJS.ErrnoException | undefined)?.code
        ? { errorCode: (failedOutcome.error as NodeJS.ErrnoException).code }
        : {}),
    });
  }

  await editMcpLoginReply(session.commandInteraction, content);
  if (session.callbackInteraction) {
    await editMcpLoginReply(session.callbackInteraction, content);
  }
}

async function handleMcpLoginCommand(interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "mcp-login") return;
  if (interaction.guildId !== config.allowedGuildId) {
    await interaction.reply({
      content: "이 서버에서는 MCP 로그인 명령을 사용할 수 없습니다.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const serverName = interaction.options.getString("mcp_name", true).trim().toLowerCase();
  if (!MCP_OAUTH_SERVER_NAMES.includes(serverName)) {
    await interaction.reply({
      content: `로그인할 수 있는 MCP 이름은 다음과 같습니다: ${MCP_OAUTH_SERVER_NAMES.join(", ")}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (activeMcpLogin || loginRequested || activeLoginChild) {
    await editMcpLoginReply(interaction, "Codex 또는 MCP 로그인이 이미 진행 중입니다. 완료된 뒤 다시 시도해 주세요.");
    return;
  }
  if (queuedJobCount > 0) {
    await editMcpLoginReply(interaction, "현재 Codex 작업이 끝난 뒤 다시 시도해 주세요.");
    return;
  }

  const session: McpLoginSession = {
    id: randomUUID(),
    serverName,
    ownerUserId: interaction.user.id,
    commandInteraction: interaction,
    finalized: false,
    phase: "starting",
  };
  activeMcpLogin = session;

  try {
    const process = startMcpOAuthProcess(serverName);
    session.child = process.child;
    process.done.then((result) => {
      session.closedResult = result;
      if (session.authorization && ["waiting", "exchanging"].includes(session.phase)) {
        void finishMcpLoginSession(session, result.error || result.code !== 0
          ? { kind: "failed", ...result }
          : { kind: "success" });
      }
    });

    const startupTimer = setTimeout(() => {
      process.child.kill("SIGTERM");
    }, 45_000);
    let authorization;
    try {
      authorization = await process.ready;
    } finally {
      clearTimeout(startupTimer);
    }
    session.authorization = authorization;
    const completedBeforeReply = session.closedResult as McpProcessResult | undefined;
    if (completedBeforeReply) {
      await finishMcpLoginSession(session, completedBeforeReply.error || completedBeforeReply.code !== 0
        ? { kind: "failed", ...completedBeforeReply }
        : { kind: "success" });
      return;
    }

    session.timeout = setTimeout(() => {
      void finishMcpLoginSession(session, { kind: "expired" }, true);
    }, MCP_LOGIN_TIMEOUT_MS);
    session.timeout.unref?.();
    await interaction.editReply(buildMcpLoginMessage(session));
    session.phase = "waiting";
    if (session.closedResult) {
      await finishMcpLoginSession(session, session.closedResult.error || session.closedResult.code !== 0
        ? { kind: "failed", ...session.closedResult }
        : { kind: "success" });
    }
  } catch (error) {
    await finishMcpLoginSession(session, {
      kind: "failed",
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

async function handleMcpLoginButton(interaction: Interaction): Promise<boolean> {
  if (!interaction.isButton()) return false;
  const match = interaction.customId.match(/^mcp_login_(callback|cancel):([0-9a-f-]{36})$/i);
  if (!match) return false;
  const [, action, sessionId] = match;
  const session = activeMcpLogin;
  if (!session || session.id !== sessionId || session.finalized) {
    await interaction.reply({ content: "이 로그인 요청은 만료됐습니다. `/mcp-login`을 다시 실행해 주세요.", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (interaction.user.id !== session.ownerUserId) {
    await interaction.reply({ content: "이 로그인 요청을 시작한 사용자만 완료할 수 있습니다.", flags: MessageFlags.Ephemeral });
    return true;
  }

  if (action === "cancel") {
    await interaction.deferUpdate();
    await finishMcpLoginSession(session, { kind: "cancelled" }, true);
    return true;
  }

  const callbackInput = new TextInputBuilder()
    .setCustomId("callback_url")
    .setLabel("브라우저 주소창의 전체 URL")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(4_000)
    .setPlaceholder("http://127.0.0.1:.../callback?code=...&state=...");
  const modal = new ModalBuilder()
    .setCustomId(`mcp_login_callback:${session.id}`)
    .setTitle(`${getMcpDisplayName(session.serverName)} 승인 결과`)
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(callbackInput));
  await interaction.showModal(modal);
  return true;
}

async function handleMcpLoginCallback(interaction: Interaction): Promise<boolean> {
  if (!interaction.isModalSubmit()) return false;
  const match = interaction.customId.match(/^mcp_login_callback:([0-9a-f-]{36})$/i);
  if (!match) return false;
  const session = activeMcpLogin;
  if (!session || session.id !== match[1] || session.finalized) {
    await interaction.reply({ content: "이 로그인 요청은 만료됐습니다. 다시 시작해 주세요.", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (interaction.user.id !== session.ownerUserId) {
    await interaction.reply({ content: "이 로그인 요청을 시작한 사용자만 완료할 수 있습니다.", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (session.phase !== "waiting" || !session.child?.stdin?.writable) {
    await interaction.reply({ content: "로그인 처리가 이미 끝났습니다. 다시 시작해 주세요.", flags: MessageFlags.Ephemeral });
    return true;
  }

  const callbackUrl = interaction.fields.getTextInputValue("callback_url");
  const validationError = validateMcpCallbackUrl(session, callbackUrl);
  if (validationError) {
    await interaction.reply({ content: validationError, flags: MessageFlags.Ephemeral });
    return true;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  session.callbackInteraction = interaction;
  session.phase = "exchanging";
  try {
    session.child.stdin.write(`${callbackUrl.trim()}\n`);
  } catch (error) {
    await finishMcpLoginSession(session, {
      kind: "failed",
      error: error instanceof Error ? error : new Error(String(error)),
    }, true);
    return true;
  }
  await editMcpLoginReply(interaction, "승인 결과를 확인하고 있습니다. 완료될 때까지 잠시 기다려 주세요.");
  return true;
}

function isQuotaRecheckRequest(question: string): boolean {
  return /^(재확인|다시\s*확인|quota\s*check|status)$/i.test(question.trim());
}

async function saveReply(
  conversationKey: string,
  sourceMessage: Message,
  answer: string | PreparedDiscordResponse,
): Promise<string> {
  const savedAnswer = await postAnswer(sourceMessage, answer);
  database.addAssistantMessage(conversationKey, savedAnswer);
  return savedAnswer;
}

function boundAnswer(answer: string): string {
  const suffix = "\n\n(응답이 Discord 전송 한도 때문에 일부 잘렸습니다.)";
  const safeAnswer = answer.replaceAll(config.discordToken, "[Discord bot token redacted]");
  if (safeAnswer.length <= config.maxResponseChars) return safeAnswer;
  return `${safeAnswer.slice(0, config.maxResponseChars - suffix.length)}${suffix}`;
}

async function processQuotaRecheck(
  conversationKey: string,
  sourceMessage: Message,
  requesterUserId = sourceMessage.author.id,
): Promise<void> {
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
  quotaRecheck = isQuotaRecheckRequest(question),
  conversationKey,
  guildId,
  progress,
  requesterUserId = sourceMessage.author.id,
  initialHistory = [],
  imageAttachments = [],
}: ProcessRequestOptions): Promise<void> {
  const reply = async (answer: string | PreparedDiscordResponse): Promise<void> => {
    await progress?.finish();
    await saveReply(conversationKey, sourceMessage, answer);
  };

  if (database.isUsageLimited()) {
    if (!quotaRecheck) {
      await reply(config.exceedMessage);
      return;
    }

    try {
      await processQuotaRecheck(conversationKey, sourceMessage, requesterUserId);
    } catch (error) {
      const errorKind = classifyCodexError(error instanceof Error ? error : String(error));
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
          diagnostic: describeCodexError(error instanceof Error ? error : String(error)),
        });
      }
    }
    return;
  }

  if (quotaRecheck) {
    const answer = "현재 사용 한도 초과 상태로 기록되어 있지 않습니다.";
    await reply(answer);
    return;
  }

  let thread: Thread | undefined;
  let codex: ReturnType<typeof createCodexForMessage> | undefined;
  let currentPrompt = "";
  let requestQuestion = question;
  let downloadedImages: DownloadedCodexImages | undefined;
  let failureStage = "conversation_load";
  const requestTime = new Date();
  const notificationTargets = getScheduleNotificationTargets(sourceMessage);
  const discordContext: DiscordContext = {
    guildId,
    channelId: sourceMessage.channelId,
    isThread: sourceMessage.channel?.isThread?.() ?? false,
    requesterUserId,
    notificationChannels: notificationTargets.channels,
    notificationUsers: notificationTargets.users,
    timezone: config.scheduleTimezone,
    currentTimeUtc: requestTime.toISOString(),
    currentTimeLocal: new Intl.DateTimeFormat("ko-KR", {
      timeZone: config.scheduleTimezone,
      dateStyle: "full",
      timeStyle: "long",
    }).format(requestTime),
  };
  try {
    failureStage = "attachment_download";
    downloadedImages = await downloadCodexImages(imageAttachments, progress);
    requestQuestion = addImageInputStatus(question, imageAttachments, downloadedImages);

    codex = createCodexForMessage(sourceMessage, { requesterUserId, notificationTargets });
    const conversation = database.getConversation(conversationKey);
    if (!conversation) throw new Error("The Discord conversation could not be loaded.");
    failureStage = "memory_lookup";
    const memory = database.findRelevantMemory(guildId, question, MEMORY_LIMIT);
    failureStage = conversation.codex_thread_id ? "thread_resume" : "thread_start";
    thread = conversation.codex_thread_id
      ? codex.resumeThread(conversation.codex_thread_id, codexThreadOptions)
      : codex.startThread(codexThreadOptions);

    currentPrompt = buildCodexPrompt({
      question: requestQuestion,
      history: conversation.codex_thread_id
        ? []
        : [...initialHistory, ...database.getRecentHistory(conversationKey, sourceMessage.id, THREAD_HISTORY_LIMIT)]
          .slice(-THREAD_HISTORY_LIMIT),
      memory,
      discordContext,
    });
    failureStage = "thread_run";
    const imagePaths = downloadedImages.files.map((file) => file.path);
    const turn = await runCodexTurnWithProgress(thread, currentPrompt, progress, imagePaths);

    const answer = prepareDiscordResponse(turn.finalResponse?.trim() || "요청을 처리했지만 답변 텍스트가 비어 있습니다.");

    failureStage = "database_save";
    const threadId = thread.id;
    if (!threadId) throw new Error("Codex did not return a thread identifier.");
    database.setCodexThreadId(conversationKey, threadId);
    database.saveResearchMemory({ guildId, conversationKey, question, answer: answer.historyText });
    failureStage = "discord_reply";
    await reply(answer);
    log("request_completed", { channelId: sourceMessage.channelId });
  } catch (error) {
    const errorKind = classifyCodexError(error instanceof Error ? error : String(error));
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

    let failureError: Error | string = error instanceof Error ? error : String(error);
    let failureKind = errorKind;
    if (errorKind === "thread_missing" && thread && codex) {
      failureStage = "thread_restore_retry";
      try {
        const replacementThread = codex.startThread(codexThreadOptions);
        const replacementThreadId = replacementThread.id;
        if (!replacementThreadId) throw new Error("Codex did not return a thread identifier.");
        currentPrompt = buildCodexPrompt({
          question: requestQuestion,
          history: [...initialHistory, ...database.getRecentHistory(conversationKey, sourceMessage.id, THREAD_HISTORY_LIMIT)]
            .slice(-THREAD_HISTORY_LIMIT),
          memory: database.findRelevantMemory(guildId, question, MEMORY_LIMIT),
          discordContext,
        });
        progress?.setActivity("이전 Codex 대화를 복구하지 못해 현재 요청을 새 문맥에서 다시 조사하고 있습니다.");
        const turn = await runCodexTurnWithProgress(
          replacementThread,
          currentPrompt,
          progress,
          downloadedImages?.files.map((file) => file.path) ?? [],
        );
        const answer = prepareDiscordResponse(turn.finalResponse?.trim() || "요청을 처리했지만 답변 텍스트가 비어 있습니다.");
        database.setCodexThreadId(conversationKey, replacementThreadId);
        database.saveResearchMemory({ guildId, conversationKey, question, answer: answer.historyText });
        await reply(answer);
        log("request_completed_after_thread_restore", { channelId: sourceMessage.channelId });
        return;
      } catch (retryError) {
        const retryErrorKind = classifyCodexError(retryError instanceof Error ? retryError : String(retryError));
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
        failureError = retryError instanceof Error ? retryError : String(retryError);
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
  } finally {
    if (downloadedImages?.directory) {
      await fs.rm(downloadedImages.directory, { recursive: true, force: true }).catch((error: Error) => {
        log("request_image_cleanup_failed", {
          diagnostic: describeCodexError(error),
        });
      });
    }
  }
}

function nextCronRun(cronExpression: string, timezone: string, currentDate: Date): string {
  const iterator = CronExpressionParser.parse(cronExpression, { currentDate, tz: timezone });
  return iterator.next().toDate().toISOString();
}

function formatScheduleTime(isoDate: string, timezone: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: timezone,
    dateStyle: "full",
    timeStyle: "short",
  }).format(new Date(isoDate));
}

async function sendScheduleNotification(
  schedule: ScheduleRow | OccurrenceRow,
  content: string | PreparedDiscordResponse,
): Promise<string> {
  const channel = client.channels.cache.get(schedule.channel_id)
    ?? await client.channels.fetch(schedule.channel_id);
  if (!channel?.isTextBased?.() || !("send" in channel) || typeof channel.send !== "function") {
    throw new Error("The schedule's Discord channel is no longer available for messages.");
  }

  const mentionUserId = schedule.mention_user_id ?? schedule.owner_user_id;
  const mention = `<@${mentionUserId}>`;
  const response = prepareDiscordResponse(content);
  const chunks = response.content
    ? splitForDiscord(response.content, config.maxDiscordMessageChars)
    : [];
  const firstContent = chunks.length > 0 ? `${mention}\n${chunks[0]}` : mention;
  await channel.send(responseSendOptions(
    response,
    firstContent,
    { parse: [], users: [mentionUserId] },
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

async function executeScheduleOccurrence(occurrence: OccurrenceRow): Promise<void> {
  try {
    if (occurrence.run_type === "event_reminder") {
      const eventAt = occurrence.event_at;
      if (!eventAt) throw new Error("Event reminder is missing its event time.");
      if (Date.parse(eventAt) <= Date.now()) {
        database.finishScheduleOccurrence({
          id: occurrence.id,
          status: "succeeded",
          result: "Skipped because the event start time had passed before the queued reminder ran.",
        });
        return;
      }
      const reminderMinutes = Math.round((Date.parse(eventAt) - Date.parse(occurrence.scheduled_at)) / 60_000);
      await sendScheduleNotification(occurrence, [
        `일정 알림: **${occurrence.title}** 시작 ${reminderMinutes}분 전입니다.`,
        `시작 시각: ${formatScheduleTime(eventAt, occurrence.timezone)} (${occurrence.timezone})`,
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
    const errorKind = classifyCodexError(error instanceof Error ? error : String(error));
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
        diagnostic: describeCodexError(deliveryError instanceof Error ? deliveryError : String(deliveryError)),
      });
    }
    database.finishScheduleOccurrence({
      id: occurrence.id,
      status: "failed",
      error: describeCodexError(error instanceof Error ? error : String(error), { redactValues: [config.discordToken] }),
    });
    log("schedule_execution_failed", {
      category: errorKind,
      scheduleId: occurrence.schedule_id,
      channelId: occurrence.channel_id,
      diagnostic: describeCodexError(error instanceof Error ? error : String(error), { redactValues: [config.discordToken] }),
    });
  }
}

function pollSchedules() {
  if (schedulePollRunning || shuttingDown || activeMcpLogin || !client.isReady()) return;
  schedulePollRunning = true;
  try {
    const currentTime = new Date();
    const nowIso = currentTime.toISOString();
    for (const schedule of database.getDueCronSchedules(nowIso)) {
      try {
        const scheduledAt = schedule.next_run_at;
        const cronExpression = schedule.cron_expression;
        if (!scheduledAt || !cronExpression) throw new Error("Cron schedule is missing its next run time or expression.");
        database.advanceCronSchedule({
          scheduleId: schedule.id,
          scheduledAt,
          nextRunAt: nextCronRun(cronExpression, schedule.timezone, currentTime),
        });
      } catch (error) {
        log("schedule_cron_invalid", {
          scheduleId: schedule.id,
          diagnostic: describeCodexError(error instanceof Error ? error : String(error)),
        });
      }
    }

    const eventReminderHorizon = new Date(currentTime.getTime() + 15 * 60_000).toISOString();
    for (const schedule of database.getUpcomingEvents(nowIso, eventReminderHorizon, 200)) {
      const eventAtValue = schedule.event_at;
      if (!eventAtValue) continue;
      let reminderOffsets: number[];
      try {
        const parsedOffsets = JSON.parse(schedule.reminder_offsets) as number[];
        if (!Array.isArray(parsedOffsets) || !parsedOffsets.every((value) => Number.isFinite(value))) {
          throw new Error("Invalid reminder offsets");
        }
        reminderOffsets = parsedOffsets;
      } catch {
        reminderOffsets = [15, 5];
      }
      const eventAt = Date.parse(eventAtValue);
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
      diagnostic: describeCodexError(error instanceof Error ? error : String(error), { redactValues: [config.discordToken] }),
        });
      });
    }
  } catch (error) {
    log("schedule_poll_failed", { diagnostic: describeCodexError(error instanceof Error ? error : String(error)) });
  } finally {
    schedulePollRunning = false;
  }
}

async function loadQnaChannelContext(
  channel: GuildTextBasedChannel,
  beforeTimestamp: number,
): Promise<{ history: PromptHistoryEntry[]; imageAttachments: DiscordAttachmentReference[] }> {
  const botUser = client.user;
  if (!botUser) return { history: [], imageAttachments: [] };
  const fetched = await channel.messages.fetch({ limit: QNA_CONTEXT_FETCH_LIMIT });
  const recentMessages = [...fetched.values()]
    .filter((message) => message.createdTimestamp <= beforeTimestamp)
    .filter((message) => message.content.trim() || message.reference || collectionValues(message.messageSnapshots).length > 0)
    .filter((message) => !message.author.bot || message.author.id === botUser.id)
    .filter((message) => !message.content.startsWith("🔎 **분석 진행 상황**"))
    .sort((first, second) => first.createdTimestamp - second.createdTimestamp);

  const contextEntries = await Promise.all(recentMessages.slice(-QNA_CONTEXT_MESSAGE_LIMIT).map(async (message) => {
    const displayName = message.member?.displayName
      || message.author.globalName
      || message.author.username;
    const content = message.author.bot
      ? message.content
      : cleanRequestContent(message.content, botUser.id);
    const linkedMessageContext = message.author.bot ? { text: "", attachments: [] } : await getLinkedMessageContext(message);
    const messageAttachments: DiscordAttachmentReference[] = message.author.bot
      ? []
      : [...message.attachments.values()].map((attachment) => ({
        name: attachment.name,
        contentType: attachment.contentType || undefined,
        size: attachment.size,
        url: attachment.url,
      }));
    const attachments = [...messageAttachments, ...linkedMessageContext.attachments];
    const attachmentSummary = messageAttachments.map((attachment) => {
      const details = [attachment.contentType, attachment.size === undefined ? undefined : `${attachment.size} bytes`]
        .filter(Boolean)
        .join("; ");
      return `첨부 파일: ${attachment.name}${details ? ` (${details})` : ""}`;
    }).join("\n");
    const historyContent = [content, linkedMessageContext.text, attachmentSummary].filter(Boolean).join("\n\n")
      || "연결된 원문 메시지";
    return {
      history: {
        role: message.author.bot ? "assistant" as const : "user" as const,
        content: `${displayName}: ${compactProgressText(historyContent, 1_400)}`,
      },
      attachments,
    };
  }));

  return {
    history: contextEntries.map((entry) => entry.history),
    imageAttachments: uniqueAttachments(contextEntries.flatMap((entry) => entry.attachments)),
  };
}

async function processInitialQnaRequest({
  sourceMessage,
  question,
  conversationKey,
  guildId,
  requesterUserId,
  initialHistory,
  imageAttachments,
}: InitialQnaRequestOptions): Promise<void> {
  let progress: RequestProgress | undefined;
  let stopFallbackTyping: (() => void) | undefined;
  try {
    if (activeMcpLogin) {
      await saveReply(conversationKey, sourceMessage, MCP_LOGIN_IN_PROGRESS_MESSAGE);
      return;
    }
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
      imageAttachments,
      progress,
    });
  } finally {
    stopFallbackTyping?.();
    await progress?.finish();
  }
}

async function handleQnaCommand(interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "qna") return;
  if (interaction.guildId !== config.allowedGuildId) {
    await interaction.reply({
      content: "이 서버에서는 Q&A 명령을 사용할 수 없습니다.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const guildId = interaction.guildId;

  if (activeMcpLogin) {
    await interaction.reply({
      content: MCP_LOGIN_IN_PROGRESS_MESSAGE,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.channel?.isThread?.()) {
    await interaction.reply({
      content: "새 Q&A는 일반 채널에서 시작해 주세요. 기존 Q&A 스레드에서는 메시지를 바로 보내 이어서 질문할 수 있습니다.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const question = interaction.options.getString("question", true).trim();
  if (!question) {
    await interaction.reply({
      content: "질문 내용을 입력해 주세요.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // A slash command is an interaction, not a user-authored channel message.
  // Use its public response as the stable thread anchor instead of an earlier chat message.
  const qnaChannel = interaction.channel;
  if (!qnaChannel || !("messages" in qnaChannel)) {
    await interaction.reply({ content: "이 채널에서는 Q&A를 시작할 수 없습니다.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply();

  let thread: AnyThreadChannel | undefined;
  try {
    const { history, imageAttachments } = await loadQnaChannelContext(
      qnaChannel as GuildTextBasedChannel,
      interaction.createdTimestamp,
    );
    const displayName = interaction.member && "displayName" in interaction.member
      ? interaction.member.displayName
      || interaction.user.globalName
      || interaction.user.username
      : interaction.user.globalName || interaction.user.username;
    const threadName = `Q&A · ${compactProgressText(question, 88)}`;
    const threadAnchor = await interaction.editReply({
      content: `**${displayName}의 Q&A 요청**\n${question}`,
      allowedMentions: { parse: [] },
    });
    const qnaThread = await threadAnchor.startThread({
      name: threadName,
      reason: `Q&A requested by ${interaction.user.id}`,
    });
    thread = qnaThread;
    const sourceMessage = await qnaThread.send({
      content: `**${displayName}의 질문:**\n${question}`,
      allowedMentions: { parse: [] },
    });
    const conversationKey = `${guildId}:${qnaThread.id}:shared`;

    database.registerQnaThread({
      threadId: qnaThread.id,
      guildId,
      parentChannelId: interaction.channelId,
      ownerUserId: interaction.user.id,
    });
    database.ensureConversation({
      conversationKey,
      guildId,
      channelId: qnaThread.id,
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
      guildId,
      requesterUserId: interaction.user.id,
      initialHistory: [],
      imageAttachments,
    }));
    void completion.catch((error) => {
      log("qna_request_failed", {
        threadId: qnaThread.id,
        channelId: interaction.channelId,
        diagnostic: describeCodexError(error instanceof Error ? error : String(error)),
      });
    });

    log("qna_thread_created", {
      guildId,
      parentChannelId: interaction.channelId,
      threadId: qnaThread.id,
      requesterUserId: interaction.user.id,
      contextMessageCount: history.length,
    });
    try {
      await interaction.editReply({
        content: `**${displayName}의 Q&A 요청**\n${question}\n\n스레드: <#${qnaThread.id}>`,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      log("qna_interaction_ack_failed", {
        threadId: qnaThread.id,
        diagnostic: describeCodexError(error instanceof Error ? error : String(error)),
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
    log("qna_thread_creation_failed", {
      guildId,
      channelId: interaction.channelId,
      diagnostic: describeCodexError(error instanceof Error ? error : String(error)),
    });
    await interaction.editReply("Q&A 스레드를 준비하지 못했습니다. 봇의 채널 기록 및 스레드 권한을 확인한 뒤 다시 시도해 주세요.");
  }
}

async function handleMessage(message: Message): Promise<void> {
  const guildId = message.guildId;
  if (!guildId || guildId !== config.allowedGuildId) return;
  if (message.author.bot || !client.user) return;
  const isQnaThread = message.channel.isThread?.()
    && database.isQnaThread(message.channelId, guildId);
  if (!isQnaThread && !message.mentions.users.has(client.user.id)) return;

  const userQuestion = cleanRequestContent(message.content, client.user.id);
  const linkedMessageContext = await getLinkedMessageContext(message);
  const currentAttachments: DiscordAttachmentReference[] = [...message.attachments.values()].map((attachment) => ({
    name: attachment.name,
    contentType: attachment.contentType || undefined,
    size: attachment.size,
    url: attachment.url,
  }));
  const imageAttachments = uniqueAttachments([...currentAttachments, ...linkedMessageContext.attachments]);
  const question = buildMessageRequest(userQuestion, linkedMessageContext, currentAttachments);
  const conversationKey = createConversationKey(message);
  database.ensureConversation({
    conversationKey,
    guildId,
    channelId: message.channelId,
    ownerUserId: message.channel.isThread?.() ? undefined : message.author.id,
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
  let progress: RequestProgress | undefined;
  let stopFallbackTyping: (() => void) | undefined;
  try {
    if (activeMcpLogin) {
      await saveReply(conversationKey, message, MCP_LOGIN_IN_PROGRESS_MESSAGE);
      return;
    }
    if (loginRequested) {
      await saveReply(conversationKey, message, LOGIN_IN_PROGRESS_MESSAGE);
      return;
    }

    if (!(await isCodexLoggedIn())) {
      await saveReply(conversationKey, message, LOGIN_REQUIRED_MESSAGE);
      log("codex_login_required", { channelId: message.channelId });
      return;
    }

    if (database.isUsageLimited() && !isQuotaRecheckRequest(userQuestion)) {
      await saveReply(conversationKey, message, config.exceedMessage);
      return;
    }

    if (!isQuotaRecheckRequest(userQuestion)) {
      progress = await createRequestProgress(message, question);
    }
    if (!progress) stopFallbackTyping = startTypingIndicator(message.channel);

    const completion = enqueue(() => processRequest({
      sourceMessage: message,
      question,
      quotaRecheck: isQuotaRecheckRequest(userQuestion),
      conversationKey,
      guildId,
      progress,
      imageAttachments,
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
    const botUser = client.user;
    const application = client.application;
    if (!botUser || !application) throw new Error("Discord client was ready without its user or application.");
    log("discord_ready", { botId: botUser.id });
    const recoveredRuns = database.recoverInterruptedScheduleOccurrences();
    if (recoveredRuns > 0) log("schedule_runs_recovered", { count: recoveredRuns });
    schedulePollTimer = setInterval(pollSchedules, 15_000);
    schedulePollTimer.unref?.();
    pollSchedules();
    try {
      await application.commands.create(
        new SlashCommandBuilder()
          .setName("login")
          .setDescription("Codex 계정을 이 봇에 로그인합니다.")
          .toJSON(),
        config.allowedGuildId,
      );
      await application.commands.create(
        new SlashCommandBuilder()
          .setName("mcp-login")
          .setDescription("MCP 서버에 OAuth 로그인합니다.")
          .addStringOption((option) => option
            .setName("mcp_name")
            .setDescription("로그인할 MCP 서버 이름")
            .setRequired(true)
            .addChoices({ name: "Notion", value: "notion" })
            .addChoices({ name: "Jira (Atlassian)", value: "jira" })
            .setMaxLength(32))
          .toJSON(),
        config.allowedGuildId,
      );
      await application.commands.create(
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
        diagnostic: describeCodexError(error instanceof Error ? error : String(error)),
      });
    });
  });
  client.on("interactionCreate", (interaction) => {
    if (interaction.isChatInputCommand() && interaction.commandName === "qna") {
      void handleQnaCommand(interaction).catch((error) => {
        log("qna_interaction_failed", { diagnostic: describeCodexError(error instanceof Error ? error : String(error)) });
      });
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === "mcp-login") {
      void handleMcpLoginCommand(interaction).catch((error) => {
        log("mcp_login_interaction_failed", { diagnostic: describeCodexError(error instanceof Error ? error : String(error)) });
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("mcp_login_")) {
      void handleMcpLoginButton(interaction).catch((error) => {
        log("mcp_login_button_failed", { diagnostic: describeCodexError(error instanceof Error ? error : String(error)) });
      });
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("mcp_login_callback:")) {
      void handleMcpLoginCallback(interaction).catch((error) => {
        log("mcp_login_callback_failed", { diagnostic: describeCodexError(error instanceof Error ? error : String(error)) });
      });
      return;
    }

    void handleLoginCommand(interaction).catch((error) => {
      log("login_interaction_failed", { diagnostic: describeCodexError(error instanceof Error ? error : String(error)) });
    });
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("shutdown_started", { signal });
    activeLoginChild?.kill("SIGTERM");
    if (activeMcpLogin) {
      if (activeMcpLogin.timeout) clearTimeout(activeMcpLogin.timeout);
      activeMcpLogin.finalized = true;
      activeMcpLogin.child?.kill("SIGTERM");
    }
    if (schedulePollTimer) clearInterval(schedulePollTimer);
    client.destroy();
    healthServer?.close();

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
  log("startup_failed", { diagnostic: describeCodexError(error instanceof Error ? error : String(error)) });
  client.destroy();
  database.close();
  healthServer?.close();
  process.exitCode = 1;
});
