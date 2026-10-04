import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const MAX_MEMORY_TERMS = 1_200;
const MAX_QUERY_TERMS = 100;

function now() {
  return new Date().toISOString();
}

function getTerms(text, maxTerms = MAX_MEMORY_TERMS) {
  const normalized = text.normalize("NFKC").toLocaleLowerCase("ko-KR");
  const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const terms = new Set();

  for (const word of words) {
    const chars = Array.from(word);
    const isHangulOrCjk = chars.some((char) => /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char));

    if (isHangulOrCjk) {
      if (chars.length === 1) {
        terms.add(chars[0]);
      } else {
        for (let index = 0; index < chars.length - 1; index += 1) {
          terms.add(chars.slice(index, index + 2).join(""));
          if (terms.size >= maxTerms) return [...terms].slice(0, maxTerms);
        }
      }
    } else if (chars.length >= 2) {
      terms.add(chars.join(""));
    }

    if (terms.size >= maxTerms) break;
  }

  return [...terms].slice(0, maxTerms);
}

export class BotDatabase {
  constructor(databasePath) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new Database(databasePath);
    if (databasePath !== ":memory:") fs.chmodSync(databasePath, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.initialize();
  }

  initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        conversation_key TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        owner_user_id TEXT,
        codex_thread_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_key TEXT NOT NULL REFERENCES conversations(conversation_key) ON DELETE CASCADE,
        discord_message_id TEXT UNIQUE,
        user_id TEXT,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS qna_threads (
        thread_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        parent_channel_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS messages_conversation_time
        ON messages(conversation_key, id DESC);

      CREATE TABLE IF NOT EXISTS research_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        conversation_key TEXT NOT NULL REFERENCES conversations(conversation_key) ON DELETE CASCADE,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS research_memory_guild_time
        ON research_memory(guild_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS research_memory_terms (
        memory_id INTEGER NOT NULL REFERENCES research_memory(id) ON DELETE CASCADE,
        term TEXT NOT NULL,
        weight REAL NOT NULL,
        PRIMARY KEY (memory_id, term)
      );

      CREATE INDEX IF NOT EXISTS research_memory_terms_lookup
        ON research_memory_terms(term, memory_id);

      CREATE TABLE IF NOT EXISTS bot_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scheduled_items (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        mention_user_id TEXT,
        visibility TEXT NOT NULL CHECK (visibility IN ('personal', 'shared')),
        kind TEXT NOT NULL CHECK (kind IN ('cron', 'event')),
        title TEXT NOT NULL,
        details TEXT,
        task_prompt TEXT,
        cron_expression TEXT,
        event_at TEXT,
        reminder_offsets TEXT NOT NULL DEFAULT '[15,5]',
        timezone TEXT NOT NULL,
        next_run_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'cancelled', 'completed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS scheduled_items_due
        ON scheduled_items(status, kind, next_run_at);

      CREATE INDEX IF NOT EXISTS scheduled_items_guild_owner
        ON scheduled_items(guild_id, owner_user_id, status);

      CREATE TABLE IF NOT EXISTS schedule_occurrences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule_id TEXT NOT NULL REFERENCES scheduled_items(id),
        run_type TEXT NOT NULL CHECK (run_type IN ('cron', 'event_reminder')),
        scheduled_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
        result TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        UNIQUE (schedule_id, run_type, scheduled_at)
      );

      CREATE INDEX IF NOT EXISTS schedule_occurrences_due
        ON schedule_occurrences(status, scheduled_at);
    `);

    const scheduledItemColumns = this.db.pragma("table_info(scheduled_items)");
    if (!scheduledItemColumns.some((column) => column.name === "mention_user_id")) {
      this.db.exec("ALTER TABLE scheduled_items ADD COLUMN mention_user_id TEXT");
    }

    this.statements = {
      createConversation: this.db.prepare(`
        INSERT INTO conversations (
          conversation_key, guild_id, channel_id, owner_user_id, created_at, updated_at
        ) VALUES (
          @conversationKey, @guildId, @channelId, @ownerUserId, @now, @now
        )
        ON CONFLICT(conversation_key) DO UPDATE SET updated_at = excluded.updated_at
      `),
      insertUserMessage: this.db.prepare(`
        INSERT OR IGNORE INTO messages (
          conversation_key, discord_message_id, user_id, role, content, created_at
        ) VALUES (@conversationKey, @discordMessageId, @userId, 'user', @content, @now)
      `),
      insertAssistantMessage: this.db.prepare(`
        INSERT INTO messages (
          conversation_key, user_id, role, content, created_at
        ) VALUES (@conversationKey, NULL, 'assistant', @content, @now)
      `),
      insertContextMessage: this.db.prepare(`
        INSERT INTO messages (conversation_key, role, content, created_at)
        VALUES (@conversationKey, @role, @content, @now)
      `),
      getConversation: this.db.prepare(`
        SELECT * FROM conversations WHERE conversation_key = ?
      `),
      insertQnaThread: this.db.prepare(`
        INSERT OR IGNORE INTO qna_threads (
          thread_id, guild_id, parent_channel_id, owner_user_id, created_at
        ) VALUES (@threadId, @guildId, @parentChannelId, @ownerUserId, @now)
      `),
      getQnaThread: this.db.prepare(`
        SELECT guild_id FROM qna_threads WHERE thread_id = ?
      `),
      setThreadId: this.db.prepare(`
        UPDATE conversations SET codex_thread_id = @threadId, updated_at = @now
        WHERE conversation_key = @conversationKey
      `),
      recentMessages: this.db.prepare(`
        SELECT role, content FROM messages
        WHERE conversation_key = @conversationKey AND discord_message_id IS NOT @excludeMessageId
        ORDER BY id DESC LIMIT @limit
      `),
      insertMemory: this.db.prepare(`
        INSERT INTO research_memory (guild_id, conversation_key, question, answer, created_at)
        VALUES (@guildId, @conversationKey, @question, @answer, @now)
      `),
      insertMemoryTerm: this.db.prepare(`
        INSERT INTO research_memory_terms (memory_id, term, weight)
        VALUES (@memoryId, @term, @weight)
      `),
      searchMemory: this.db.prepare(`
        SELECT
          memory.question,
          memory.answer,
          memory.created_at,
          SUM(memory_term.weight) AS relevance
        FROM research_memory_terms AS memory_term
        JOIN research_memory AS memory ON memory.id = memory_term.memory_id
        WHERE memory.guild_id = @guildId
          AND memory_term.term IN (SELECT value FROM json_each(@termsJson))
        GROUP BY memory.id
        ORDER BY relevance DESC, memory.created_at DESC
        LIMIT @limit
      `),
      getState: this.db.prepare("SELECT value FROM bot_state WHERE key = ?"),
      setState: this.db.prepare(`
        INSERT INTO bot_state (key, value, updated_at) VALUES (@key, @value, @now)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `),
      deleteState: this.db.prepare("DELETE FROM bot_state WHERE key = ?"),
      insertSchedule: this.db.prepare(`
        INSERT INTO scheduled_items (
          id, guild_id, channel_id, owner_user_id, mention_user_id, visibility, kind, title, details,
          task_prompt, cron_expression, event_at, reminder_offsets, timezone,
          next_run_at, status, created_at, updated_at
        ) VALUES (
          @id, @guildId, @channelId, @ownerUserId, @mentionUserId, @visibility, @kind, @title, @details,
          @taskPrompt, @cronExpression, @eventAt, @reminderOffsets, @timezone,
          @nextRunAt, @status, @now, @now
        )
      `),
      getSchedule: this.db.prepare("SELECT * FROM scheduled_items WHERE id = ?"),
      listSchedules: this.db.prepare(`
        SELECT *,
          (SELECT substr(result, 1, 1500) FROM schedule_occurrences AS occurrence
           WHERE occurrence.schedule_id = scheduled_items.id
             AND occurrence.run_type = 'cron' AND occurrence.status = 'succeeded'
           ORDER BY occurrence.scheduled_at DESC LIMIT 1) AS latest_result,
          (SELECT scheduled_at FROM schedule_occurrences AS occurrence
           WHERE occurrence.schedule_id = scheduled_items.id
             AND occurrence.run_type = 'cron' AND occurrence.status = 'succeeded'
           ORDER BY occurrence.scheduled_at DESC LIMIT 1) AS latest_run_at
        FROM scheduled_items
        WHERE guild_id = @guildId
          AND (visibility = 'shared' OR owner_user_id = @userId)
          AND (@includeInactive = 1 OR status = 'active')
          AND (@query = '' OR
            title LIKE @queryPattern COLLATE NOCASE OR
            COALESCE(details, '') LIKE @queryPattern COLLATE NOCASE OR
            COALESCE(task_prompt, '') LIKE @queryPattern COLLATE NOCASE OR
            COALESCE(cron_expression, '') LIKE @queryPattern COLLATE NOCASE OR
            id LIKE @queryPattern)
          AND (@fromAt IS NULL OR COALESCE(event_at, next_run_at, created_at) >= @fromAt)
          AND (@toAt IS NULL OR COALESCE(event_at, next_run_at, created_at) <= @toAt)
        ORDER BY COALESCE(event_at, next_run_at, created_at) ASC
        LIMIT @limit
      `),
      getDueCronSchedules: this.db.prepare(`
        SELECT * FROM scheduled_items
        WHERE kind = 'cron' AND status = 'active' AND next_run_at <= ?
        ORDER BY next_run_at ASC
        LIMIT ?
      `),
      getUpcomingEvents: this.db.prepare(`
        SELECT * FROM scheduled_items
        WHERE kind = 'event' AND status = 'active' AND event_at > ? AND event_at <= ?
        ORDER BY event_at ASC
        LIMIT ?
      `),
      insertOccurrence: this.db.prepare(`
        INSERT OR IGNORE INTO schedule_occurrences (
          schedule_id, run_type, scheduled_at, status, created_at
        ) VALUES (@scheduleId, @runType, @scheduledAt, 'pending', @now)
      `),
      advanceCronSchedule: this.db.prepare(`
        UPDATE scheduled_items SET next_run_at = @nextRunAt, updated_at = @now
        WHERE id = @scheduleId AND kind = 'cron' AND status = 'active'
      `),
      pendingOccurrences: this.db.prepare(`
        SELECT occurrence.*, schedule.guild_id, schedule.channel_id,
          schedule.owner_user_id, schedule.mention_user_id, schedule.visibility, schedule.kind,
          schedule.title, schedule.details, schedule.task_prompt, schedule.timezone,
          schedule.event_at
        FROM schedule_occurrences AS occurrence
        JOIN scheduled_items AS schedule ON schedule.id = occurrence.schedule_id
        WHERE occurrence.status = 'pending' AND schedule.status = 'active'
        ORDER BY occurrence.scheduled_at ASC
        LIMIT ?
      `),
      claimOccurrence: this.db.prepare(`
        UPDATE schedule_occurrences SET status = 'running', started_at = @now
        WHERE id = @id AND status = 'pending'
      `),
      recoverRunningOccurrences: this.db.prepare(`
        UPDATE schedule_occurrences SET status = 'pending', started_at = NULL
        WHERE status = 'running'
      `),
      finishOccurrence: this.db.prepare(`
        UPDATE schedule_occurrences SET status = @status, result = @result,
          error = @error, completed_at = @now
        WHERE id = @id AND status = 'running'
      `),
      completePastEvents: this.db.prepare(`
        UPDATE scheduled_items SET status = 'completed', updated_at = @now
        WHERE kind = 'event' AND status = 'active' AND event_at <= @now
      `),
      cancelExpiredEventReminders: this.db.prepare(`
        UPDATE schedule_occurrences SET status = 'cancelled',
          result = 'Skipped because the event start time had passed.', completed_at = @now
        WHERE run_type = 'event_reminder' AND status IN ('pending', 'running')
          AND schedule_id IN (
            SELECT id FROM scheduled_items
            WHERE kind = 'event' AND status = 'active' AND event_at <= @now
          )
      `),
      ownedActiveSchedule: this.db.prepare(`
        SELECT * FROM scheduled_items
        WHERE id = @id AND guild_id = @guildId AND owner_user_id = @userId
          AND status = 'active'
      `),
      updateSchedule: this.db.prepare(`
        UPDATE scheduled_items SET channel_id = @channelId, mention_user_id = @mentionUserId,
          title = @title, details = @details, visibility = @visibility,
          task_prompt = @taskPrompt, cron_expression = @cronExpression,
          event_at = @eventAt, timezone = @timezone, next_run_at = @nextRunAt,
          status = @status, updated_at = @now
        WHERE id = @id AND guild_id = @guildId AND owner_user_id = @userId
          AND status = 'active'
      `),
      cancelSchedule: this.db.prepare(`
        UPDATE scheduled_items SET status = 'cancelled', updated_at = @now
        WHERE id = @id AND guild_id = @guildId AND owner_user_id = @userId
          AND status = 'active'
      `),
      cancelPendingOccurrences: this.db.prepare(`
        UPDATE schedule_occurrences SET status = 'cancelled', completed_at = @now
        WHERE schedule_id = @scheduleId AND status IN ('pending', 'running')
      `),
    };

    this.saveMemoryTransaction = this.db.transaction((entry) => {
      const result = this.statements.insertMemory.run({ ...entry, now: now() });
      const memoryId = Number(result.lastInsertRowid);
      const questionTerms = new Set(getTerms(entry.question));
      const allTerms = new Set([...questionTerms, ...getTerms(entry.answer)]);
      const insertTerm = this.statements.insertMemoryTerm;

      for (const term of allTerms) {
        insertTerm.run({ memoryId, term, weight: questionTerms.has(term) ? 1 : 0.35 });
      }
    });

    this.claimPendingOccurrencesTransaction = this.db.transaction((limit) => {
      const pending = this.statements.pendingOccurrences.all(limit);
      const claimed = [];
      for (const occurrence of pending) {
        const result = this.statements.claimOccurrence.run({ id: occurrence.id, now: now() });
        if (result.changes === 1) claimed.push(occurrence);
      }
      return claimed;
    });

    this.insertReminderOccurrenceTransaction = this.db.transaction(({ scheduleId, scheduledAt }) => {
      return this.statements.insertOccurrence.run({
        scheduleId,
        runType: "event_reminder",
        scheduledAt,
        now: now(),
      }).changes === 1;
    });

    this.advanceCronOccurrenceTransaction = this.db.transaction(({ scheduleId, scheduledAt, nextRunAt }) => {
      const insertion = this.statements.insertOccurrence.run({
        scheduleId,
        runType: "cron",
        scheduledAt,
        now: now(),
      });
      this.statements.advanceCronSchedule.run({ scheduleId, nextRunAt, now: now() });
      return insertion.changes === 1;
    });

    this.updateScheduleTransaction = this.db.transaction(({ schedule, changes }) => {
      const updated = {
        ...schedule,
        ...changes,
        now: now(),
      };
      const result = this.statements.updateSchedule.run({
        id: schedule.id,
        guildId: schedule.guild_id,
        channelId: updated.channel_id,
        userId: schedule.owner_user_id,
        mentionUserId: updated.mention_user_id ?? null,
        title: updated.title,
        details: updated.details,
        visibility: updated.visibility,
        taskPrompt: updated.task_prompt,
        cronExpression: updated.cron_expression,
        eventAt: updated.event_at,
        timezone: updated.timezone,
        nextRunAt: updated.next_run_at,
        status: updated.status,
        now: updated.now,
      });
      const mustCancelPendingRuns = schedule.kind === "event"
        ? "event_at" in changes
        : "cron_expression" in changes || "timezone" in changes;
      if (result.changes && mustCancelPendingRuns) {
        this.statements.cancelPendingOccurrences.run({ scheduleId: schedule.id, now: updated.now });
      }
      return result.changes === 1 ? this.statements.getSchedule.get(schedule.id) : null;
    });

    this.cancelScheduleTransaction = this.db.transaction(({ scheduleId, guildId, userId }) => {
      const currentTime = now();
      const result = this.statements.cancelSchedule.run({ id: scheduleId, guildId, userId, now: currentTime });
      if (result.changes) this.statements.cancelPendingOccurrences.run({ scheduleId, now: currentTime });
      return result.changes === 1;
    });
  }

  ensureConversation({ conversationKey, guildId, channelId, ownerUserId }) {
    this.statements.createConversation.run({
      conversationKey,
      guildId,
      channelId,
      ownerUserId: ownerUserId ?? null,
      now: now(),
    });
    return this.statements.getConversation.get(conversationKey);
  }

  addUserMessage({ conversationKey, discordMessageId, userId, content }) {
    const result = this.statements.insertUserMessage.run({
      conversationKey,
      discordMessageId,
      userId,
      content,
      now: now(),
    });
    return result.changes === 1;
  }

  addAssistantMessage(conversationKey, content) {
    this.statements.insertAssistantMessage.run({ conversationKey, content, now: now() });
  }

  addContextMessage(conversationKey, { role, content }) {
    if (role !== "user" && role !== "assistant") throw new Error("Invalid context message role");
    this.statements.insertContextMessage.run({ conversationKey, role, content, now: now() });
  }

  getConversation(conversationKey) {
    return this.statements.getConversation.get(conversationKey);
  }

  registerQnaThread({ threadId, guildId, parentChannelId, ownerUserId }) {
    this.statements.insertQnaThread.run({
      threadId,
      guildId,
      parentChannelId,
      ownerUserId,
      now: now(),
    });
  }

  isQnaThread(threadId, guildId) {
    const thread = this.statements.getQnaThread.get(threadId);
    return Boolean(thread && thread.guild_id === guildId);
  }

  setCodexThreadId(conversationKey, threadId) {
    if (!threadId) return;
    this.statements.setThreadId.run({ conversationKey, threadId, now: now() });
  }

  getRecentHistory(conversationKey, excludeMessageId, limit = 12) {
    return this.statements.recentMessages
      .all({ conversationKey, excludeMessageId, limit })
      .reverse();
  }

  saveResearchMemory(entry) {
    this.saveMemoryTransaction(entry);
  }

  findRelevantMemory(guildId, query, limit = 4) {
    const terms = getTerms(query, MAX_QUERY_TERMS);
    if (terms.length === 0) return [];

    return this.statements.searchMemory.all({
      guildId,
      termsJson: JSON.stringify(terms),
      limit,
    });
  }

  createSchedule(schedule) {
    const currentTime = now();
    this.statements.insertSchedule.run({
      id: schedule.id,
      guildId: schedule.guildId,
      channelId: schedule.channelId,
      ownerUserId: schedule.ownerUserId,
      mentionUserId: schedule.mentionUserId ?? null,
      visibility: schedule.visibility,
      kind: schedule.kind,
      title: schedule.title,
      details: schedule.details ?? null,
      taskPrompt: schedule.taskPrompt ?? null,
      cronExpression: schedule.cronExpression ?? null,
      eventAt: schedule.eventAt ?? null,
      reminderOffsets: JSON.stringify(schedule.reminderOffsets ?? [15, 5]),
      timezone: schedule.timezone,
      nextRunAt: schedule.nextRunAt ?? null,
      status: schedule.status ?? "active",
      now: currentTime,
    });
    return this.statements.getSchedule.get(schedule.id);
  }

  listSchedules({ guildId, userId, query = "", includeInactive = false, fromAt = null, toAt = null, limit = 50 }) {
    return this.statements.listSchedules.all({
      guildId,
      userId,
      query,
      queryPattern: `%${query}%`,
      includeInactive: includeInactive ? 1 : 0,
      fromAt,
      toAt,
      limit: Math.min(Math.max(Number(limit) || 50, 1), 100),
    });
  }

  getSchedule(scheduleId) {
    return this.statements.getSchedule.get(scheduleId) ?? null;
  }

  updateSchedule({ scheduleId, guildId, userId, changes }) {
    const schedule = this.statements.ownedActiveSchedule.get({ id: scheduleId, guildId, userId });
    if (!schedule) return null;
    return this.updateScheduleTransaction({ schedule, changes });
  }

  cancelSchedule({ scheduleId, guildId, userId }) {
    return this.cancelScheduleTransaction({ scheduleId, guildId, userId });
  }

  getDueCronSchedules(nowIso, limit = 50) {
    return this.statements.getDueCronSchedules.all(nowIso, limit);
  }

  advanceCronSchedule({ scheduleId, scheduledAt, nextRunAt }) {
    return this.advanceCronOccurrenceTransaction({ scheduleId, scheduledAt, nextRunAt });
  }

  getUpcomingEvents(nowIso, throughIso, limit = 100) {
    return this.statements.getUpcomingEvents.all(nowIso, throughIso, limit);
  }

  addEventReminderOccurrence(scheduleId, scheduledAt) {
    return this.insertReminderOccurrenceTransaction({ scheduleId, scheduledAt });
  }

  claimPendingScheduleOccurrences(limit = 100) {
    return this.claimPendingOccurrencesTransaction(Math.min(limit, 200));
  }

  recoverInterruptedScheduleOccurrences() {
    return this.statements.recoverRunningOccurrences.run().changes;
  }

  finishScheduleOccurrence({ id, status, result = null, error = null }) {
    this.statements.finishOccurrence.run({ id, status, result, error, now: now() });
  }

  completePastEvents(nowIso) {
    this.statements.cancelExpiredEventReminders.run({ now: nowIso });
    return this.statements.completePastEvents.run({ now: nowIso }).changes;
  }

  isUsageLimited() {
    return this.statements.getState.get("usage_limited")?.value === "true";
  }

  setUsageLimited(isLimited) {
    if (isLimited) {
      this.statements.setState.run({
        key: "usage_limited",
        value: "true",
        now: now(),
      });
      return;
    }

    this.statements.deleteState.run("usage_limited");
  }

  close() {
    this.db.close();
  }
}

export { getTerms };
