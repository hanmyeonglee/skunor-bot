const DEFAULT_EXCEED_MESSAGE =
  "현재 Codex 사용 한도에 도달했습니다. 사용량이 복구된 뒤 `@봇 재확인`으로 다시 확인해 주세요.";

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function positiveInteger(name, defaultValue) {
  const value = Number.parseInt(process.env[name] ?? String(defaultValue), 10);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Invalid ${name}: expected a TCP port number`);
  }
  return value;
}

export function loadConfig() {
  const scheduleTimezone = process.env.SCHEDULE_TIME_ZONE?.trim() || "Asia/Seoul";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: scheduleTimezone }).format();
  } catch {
    throw new Error(`Invalid SCHEDULE_TIME_ZONE: ${scheduleTimezone}`);
  }

  return {
    discordToken: requiredEnv("DISCORD_TOKEN"),
    allowedGuildId: requiredEnv("ALLOWED_GUILD_ID"),
    databasePath: process.env.DATABASE_PATH?.trim() || "./data/bot.sqlite3",
    codexHome: process.env.CODEX_HOME?.trim() || "./data/codex",
    scheduleTimezone,
    host: process.env.HOST?.trim() || "0.0.0.0",
    port: positiveInteger("PORT", 8080),
    exceedMessage: process.env.EXCEED_MESSAGE?.trim() || DEFAULT_EXCEED_MESSAGE,
    maxResponseChars: 30_000,
    maxDiscordMessageChars: 1_900,
  };
}
