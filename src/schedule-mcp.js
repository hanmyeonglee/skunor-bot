import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { BotDatabase } from "./database.js";

process.umask(0o077);

const tools = [
  {
    name: "create_scheduled_task",
    description: "Create a recurring task. Codex runs taskPrompt on each cron occurrence and sends the result to the configured channel and mention target. Notifications default to the current channel and requester. Visibility defaults to personal and timezone to the request timezone.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short human-readable task name." },
        taskPrompt: { type: "string", description: "The full research or work request Codex should perform each time." },
        cronExpression: { type: "string", description: "A five-field cron expression: minute hour day-of-month month day-of-week." },
        timezone: { type: "string", description: "IANA timezone, such as Asia/Seoul. Defaults to the request timezone." },
        visibility: { type: "string", enum: ["personal", "shared"], description: "Use shared only when the requester asks for a server-wide schedule; otherwise personal." },
        notificationChannelId: { type: "string", description: "Optional destination channel ID or exact channel name from trusted Discord request context. Use 'current' for the channel where the request was made. Defaults to current channel." },
        mentionUserId: { type: "string", description: "Optional mention target ID or exact user name from trusted Discord request context. Use 'self' for the requester. Defaults to mentioning the requester." },
      },
      required: ["title", "taskPrompt", "cronExpression"],
      additionalProperties: false,
    },
  },
  {
    name: "create_event",
    description: "Remember a one-time event and notify the configured mention target in the configured channel 15 minutes and 5 minutes before it starts. Defaults to the current channel and requester. startsAt must be ISO 8601 with an explicit timezone offset. Defaults to personal visibility and the request timezone.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short event name." },
        startsAt: { type: "string", description: "ISO 8601 date and time with Z or an explicit offset, for example 2026-10-10T19:30:00+09:00." },
        details: { type: "string", description: "Optional notes about the event." },
        timezone: { type: "string", description: "IANA timezone used to display and interpret the event, such as Asia/Seoul." },
        visibility: { type: "string", enum: ["personal", "shared"], description: "Use shared only when the requester asks for a server-wide schedule; otherwise personal." },
        notificationChannelId: { type: "string", description: "Optional destination channel ID or exact channel name from trusted Discord request context. Use 'current' for the channel where the request was made. Defaults to current channel." },
        mentionUserId: { type: "string", description: "Optional mention target ID or exact user name from trusted Discord request context. Use 'self' for the requester. Defaults to mentioning the requester." },
      },
      required: ["title", "startsAt"],
      additionalProperties: false,
    },
  },
  {
    name: "list_schedules",
    description: "Search or list schedules visible to the current requester. Personal schedules are visible only to their owner; shared schedules are visible to the whole server. Use includeInactive=true for past or cancelled schedules. Recurring tasks include the most recent successful run result.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional text search across title, notes, task prompt, and cron expression." },
        fromAt: { type: "string", description: "Optional inclusive ISO 8601 lower date/time bound." },
        toAt: { type: "string", description: "Optional inclusive ISO 8601 upper date/time bound." },
        includeInactive: { type: "boolean", description: "Include cancelled and completed schedules when true." },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "update_schedule",
    description: "Update a schedule created by the current requester. Only its registrant can update it. Supply the schedule ID and only the fields to change. notificationChannelId can be a channel ID or exact channel name from trusted Discord request context; use 'current' for the request channel. mentionUserId can be a user ID or exact user name from trusted context; use 'self' for the requester. Event reminders remain 15 and 5 minutes before start.",
    inputSchema: {
      type: "object",
      properties: {
        scheduleId: { type: "string" },
        title: { type: "string" },
        details: { type: "string" },
        taskPrompt: { type: "string" },
        cronExpression: { type: "string" },
        startsAt: { type: "string", description: "ISO 8601 date and time with Z or an explicit offset; events only." },
        timezone: { type: "string" },
        visibility: { type: "string", enum: ["personal", "shared"] },
        notificationChannelId: { type: "string", description: "Change the destination. Use a channel from trusted Discord request context or 'current'." },
        mentionUserId: { type: "string", description: "Change who is pinged. Use a user from trusted Discord request context or 'self'." },
      },
      required: ["scheduleId"],
      additionalProperties: false,
    },
  },
  {
    name: "cancel_schedule",
    description: "Cancel an active schedule created by the current requester. Other members cannot cancel it. Shared schedules remain visible but only their registrant can cancel them.",
    inputSchema: {
      type: "object",
      properties: { scheduleId: { type: "string" } },
      required: ["scheduleId"],
      additionalProperties: false,
    },
  },
];

let database;

function getRequestContext() {
  const context = {
    userId: process.env.SCHEDULE_REQUESTER_ID,
    guildId: process.env.SCHEDULE_GUILD_ID,
    channelId: process.env.SCHEDULE_CHANNEL_ID,
    timezone: process.env.SCHEDULE_TIME_ZONE || "Asia/Seoul",
  };
  if (!context.userId || !context.guildId || !context.channelId) {
    throw new Error("Trusted schedule request context is missing.");
  }
  validateTimezone(context.timezone);
  return context;
}

function getTargetOptions(environmentVariable) {
  let options;
  try {
    options = JSON.parse(process.env[environmentVariable] || "[]");
  } catch {
    throw new Error(`${environmentVariable} must contain a JSON array.`);
  }
  if (!Array.isArray(options)) throw new Error(`${environmentVariable} must contain a JSON array.`);
  return options.filter((option) => (
    option
    && typeof option.id === "string"
    && /^\d{17,20}$/u.test(option.id)
    && typeof option.name === "string"
    && option.name.trim()
  ));
}

function resolveTargetId(value, options, field, { mentionPattern = null, selfId = null } = {}) {
  const target = cleanText(value, field, 200);
  if (selfId && target.toLocaleLowerCase("en-US") === "self") return selfId;

  const mentionedId = mentionPattern ? target.match(mentionPattern)?.[1] : null;
  const query = mentionedId || target.replace(/^[@#]/u, "").trim();
  const matches = options.filter((option) => (
    option.id === query
    || option.name.trim().toLocaleLowerCase("en-US") === query.toLocaleLowerCase("en-US")
  ));
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) throw new Error(`${field} matches multiple Discord targets; use an explicit mention.`);
  throw new Error(`${field} must match an available Discord target in the current request context.`);
}

function resolveNotificationChannel(value, context) {
  if (value === undefined) return context.channelId;
  if (typeof value === "string" && value.trim().toLocaleLowerCase("en-US") === "current") {
    return context.channelId;
  }
  return resolveTargetId(
    value,
    getTargetOptions("SCHEDULE_NOTIFICATION_CHANNEL_OPTIONS_JSON"),
    "notificationChannelId",
    { mentionPattern: /^<#(\d{17,20})>$/u },
  );
}

function resolveMentionUser(value, context) {
  if (value === undefined) return context.userId;
  if (typeof value === "string" && value.trim().toLocaleLowerCase("en-US") === "self") {
    return context.userId;
  }
  return resolveTargetId(
    value,
    getTargetOptions("SCHEDULE_NOTIFICATION_USER_OPTIONS_JSON"),
    "mentionUserId",
    { mentionPattern: /^<@!?(\d{17,20})>$/u, selfId: context.userId },
  );
}

function ensureWritesAllowed() {
  if (process.env.SCHEDULE_ALLOW_WRITES !== "true") {
    throw new Error("Schedule changes are disabled during this scheduled task run.");
  }
}

function validateTimezone(timezone) {
  if (typeof timezone !== "string" || timezone.length > 100) {
    throw new Error("timezone must be an IANA timezone name.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new Error(`Unknown timezone: ${timezone}`);
  }
  return timezone;
}

function cleanText(value, field, maxLength, { required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${field} is required.`);
    return null;
  }
  if (typeof value !== "string") throw new Error(`${field} must be text.`);
  const result = value.trim();
  if (required && !result) throw new Error(`${field} cannot be empty.`);
  if (result.length > maxLength) throw new Error(`${field} must be ${maxLength} characters or fewer.`);
  return result || null;
}

function normalizeVisibility(value) {
  if (value === undefined || value === null) return "personal";
  if (value !== "personal" && value !== "shared") {
    throw new Error("visibility must be personal or shared.");
  }
  return value;
}

function normalizeCronExpression(expression, timezone, currentDate = new Date()) {
  if (typeof expression !== "string" || expression.trim().split(/\s+/u).length !== 5) {
    throw new Error("cronExpression must have exactly five fields: minute hour day-of-month month day-of-week.");
  }
  try {
    const iterator = CronExpressionParser.parse(expression.trim(), { currentDate, tz: timezone });
    return { expression: expression.trim(), nextRunAt: iterator.next().toDate().toISOString() };
  } catch (error) {
    throw new Error(`Invalid cronExpression: ${error.message}`);
  }
}

function normalizeStartTime(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    throw new Error("startsAt must be an ISO 8601 date/time with an explicit timezone, such as 2026-10-10T19:30:00+09:00.");
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("startsAt is not a valid date/time.");
  return date.toISOString();
}

function scheduleSummary(schedule) {
  const excerpt = (value, limit) => {
    if (typeof value !== "string" || value.length <= limit) return value;
    return `${value.slice(0, limit)}…(잘림)`;
  };
  return {
    id: schedule.id,
    kind: schedule.kind,
    title: schedule.title,
    details: excerpt(schedule.details, 800),
    visibility: schedule.visibility,
    status: schedule.status,
    timezone: schedule.timezone,
    notificationChannelId: schedule.channel_id,
    mentionUserId: schedule.mention_user_id ?? schedule.owner_user_id,
    createdAt: schedule.created_at,
    ...(schedule.kind === "event"
      ? { startsAt: schedule.event_at, reminderMinutesBefore: JSON.parse(schedule.reminder_offsets || "[15,5]") }
      : {
        cronExpression: schedule.cron_expression,
        nextRunAt: schedule.next_run_at,
        taskPrompt: excerpt(schedule.task_prompt, 1_200),
        latestRunAt: schedule.latest_run_at,
        latestResult: excerpt(schedule.latest_result, 1_000),
      }),
  };
}

function toolText(value) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function createScheduledTask(args) {
  ensureWritesAllowed();
  const context = getRequestContext();
  const title = cleanText(args.title, "title", 160);
  const taskPrompt = cleanText(args.taskPrompt, "taskPrompt", 5_000);
  const timezone = validateTimezone(args.timezone || context.timezone);
  const { expression, nextRunAt } = normalizeCronExpression(args.cronExpression, timezone);
  const schedule = database.createSchedule({
    id: randomUUID(),
    guildId: context.guildId,
    ownerUserId: context.userId,
    visibility: normalizeVisibility(args.visibility),
    kind: "cron",
    title,
    channelId: resolveNotificationChannel(args.notificationChannelId, context),
    mentionUserId: resolveMentionUser(args.mentionUserId, context),
    taskPrompt,
    cronExpression: expression,
    timezone,
    nextRunAt,
  });
  return toolText({ created: true, schedule: scheduleSummary(schedule) });
}

function createEvent(args) {
  ensureWritesAllowed();
  const context = getRequestContext();
  const title = cleanText(args.title, "title", 160);
  const details = cleanText(args.details, "details", 2_000, { required: false });
  const timezone = validateTimezone(args.timezone || context.timezone);
  const eventAt = normalizeStartTime(args.startsAt);
  const schedule = database.createSchedule({
    id: randomUUID(),
    guildId: context.guildId,
    ownerUserId: context.userId,
    visibility: normalizeVisibility(args.visibility),
    kind: "event",
    title,
    channelId: resolveNotificationChannel(args.notificationChannelId, context),
    mentionUserId: resolveMentionUser(args.mentionUserId, context),
    details,
    eventAt,
    reminderOffsets: [15, 5],
    timezone,
    status: Date.parse(eventAt) <= Date.now() ? "completed" : "active",
  });
  return toolText({ created: true, schedule: scheduleSummary(schedule) });
}

function listSchedules(args) {
  const context = getRequestContext();
  const query = cleanText(args.query, "query", 200, { required: false }) || "";
  const fromAt = args.fromAt === undefined ? null : normalizeStartTime(args.fromAt);
  const toAt = args.toAt === undefined ? null : normalizeStartTime(args.toAt);
  const schedules = database.listSchedules({
    guildId: context.guildId,
    userId: context.userId,
    query,
    includeInactive: args.includeInactive === true,
    fromAt,
    toAt,
    limit: args.limit ?? 50,
  });
  return toolText({ schedules: schedules.map(scheduleSummary), count: schedules.length });
}

function updateSchedule(args) {
  ensureWritesAllowed();
  const context = getRequestContext();
  const scheduleId = cleanText(args.scheduleId, "scheduleId", 100);
  const existing = database.getSchedule(scheduleId);
  if (!existing || existing.guild_id !== context.guildId || existing.owner_user_id !== context.userId || existing.status !== "active") {
    throw new Error("Active schedule not found or not owned by the current requester.");
  }

  const changes = {};
  if (args.title !== undefined) changes.title = cleanText(args.title, "title", 160);
  if (args.visibility !== undefined) changes.visibility = normalizeVisibility(args.visibility);
  if (args.timezone !== undefined) changes.timezone = validateTimezone(args.timezone);
  if (args.notificationChannelId !== undefined) {
    changes.channel_id = resolveNotificationChannel(args.notificationChannelId, context);
  }
  if (args.mentionUserId !== undefined) {
    changes.mention_user_id = resolveMentionUser(args.mentionUserId, context);
  }

  if (existing.kind === "cron") {
    if (args.startsAt !== undefined || args.details !== undefined) {
      throw new Error("startsAt and details can only be changed on an event schedule.");
    }
    if (args.taskPrompt !== undefined) changes.task_prompt = cleanText(args.taskPrompt, "taskPrompt", 5_000);
    if (args.cronExpression !== undefined || args.timezone !== undefined) {
      const { expression, nextRunAt } = normalizeCronExpression(
        args.cronExpression ?? existing.cron_expression,
        changes.timezone ?? existing.timezone,
      );
      changes.cron_expression = expression;
      changes.next_run_at = nextRunAt;
    }
  } else {
    if (args.taskPrompt !== undefined || args.cronExpression !== undefined) {
      throw new Error("taskPrompt and cronExpression can only be changed on a recurring task.");
    }
    if (args.details !== undefined) changes.details = cleanText(args.details, "details", 2_000, { required: false });
    if (args.startsAt !== undefined) changes.event_at = normalizeStartTime(args.startsAt);
    if (args.startsAt !== undefined) {
      changes.status = Date.parse(changes.event_at) <= Date.now() ? "completed" : "active";
    }
  }

  if (Object.keys(changes).length === 0) throw new Error("Provide at least one field to update.");
  const updated = database.updateSchedule({
    scheduleId,
    guildId: context.guildId,
    userId: context.userId,
    changes,
  });
  if (!updated) throw new Error("Schedule could not be updated.");
  return toolText({ updated: true, schedule: scheduleSummary(updated) });
}

function cancelSchedule(args) {
  ensureWritesAllowed();
  const context = getRequestContext();
  const scheduleId = cleanText(args.scheduleId, "scheduleId", 100);
  const cancelled = database.cancelSchedule({
    scheduleId,
    guildId: context.guildId,
    userId: context.userId,
  });
  if (!cancelled) throw new Error("Active schedule not found or not owned by the current requester.");
  return toolText({ cancelled: true, scheduleId });
}

function handleToolCall(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be a JSON object.");
  switch (name) {
    case "create_scheduled_task": return createScheduledTask(args);
    case "create_event": return createEvent(args);
    case "list_schedules": return listSchedules(args);
    case "update_schedule": return updateSchedule(args);
    case "cancel_schedule": return cancelSchedule(args);
    default: throw new Error(`Unknown schedule tool: ${name}`);
  }
}

function handleRequest(request) {
  if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return { jsonrpc: "2.0", id: request?.id ?? null, error: { code: -32600, message: "Invalid JSON-RPC request" } };
  }
  if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") return null;
  if (request.method === "ping") return { jsonrpc: "2.0", id: request.id, result: {} };
  if (request.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: request.params?.protocolVersion || "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "skunor-schedule", version: "1.0.0" },
        instructions: "Use these tools for personal and shared Discord schedules. Personal schedules are owner-only. Notification channels and mention targets must match the trusted options supplied for the current Discord request. Scheduled task runs have schedule writes disabled.",
      },
    };
  }
  if (request.method === "tools/list") {
    return { jsonrpc: "2.0", id: request.id, result: { tools } };
  }
  if (request.method === "tools/call") {
    try {
      const result = handleToolCall(request.params?.name, request.params?.arguments ?? {});
      return { jsonrpc: "2.0", id: request.id, result };
    } catch (error) {
      return { jsonrpc: "2.0", id: request.id, result: { ...toolText(error.message), isError: true } };
    }
  }
  if (request.id === undefined) return null;
  return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } };
}

let inputBuffer = "";
let processing = Promise.resolve();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inputBuffer += chunk;
  let newlineAt;
  while ((newlineAt = inputBuffer.indexOf("\n")) >= 0) {
    const line = inputBuffer.slice(0, newlineAt).trim();
    inputBuffer = inputBuffer.slice(newlineAt + 1);
    if (!line) continue;
    processing = processing.then(() => {
      const request = JSON.parse(line);
      const response = handleRequest(request);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    }).catch((error) => {
      process.stderr.write(`schedule MCP error: ${error.message}\n`);
    });
  }
});
process.stdin.on("end", () => {
  void processing.finally(() => database?.close());
});

try {
  database = new BotDatabase(process.env.DATABASE_PATH || "./data/bot.sqlite3");
} catch (error) {
  process.stderr.write(`schedule MCP startup failed: ${error.message}\n`);
  process.exit(1);
}
