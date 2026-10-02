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
    `);

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
      getConversation: this.db.prepare(`
        SELECT * FROM conversations WHERE conversation_key = ?
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

  getConversation(conversationKey) {
    return this.statements.getConversation.get(conversationKey);
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
