# Discord API reference for Skunor

Verified against the official Discord API documentation on 2026-10-03.

## Common request rules

- API base: `https://discord.com/api/v10`.
- Authenticate as the bot with `Authorization: Bot <bot-token>`.
- Use only HTTP `GET` in this skill.
- The token is supplied in `DISCORD_BOT_TOKEN`; the only allowed guild is `DISCORD_GUILD_ID`.
- Use `curl --get --data-urlencode` for query parameters. Do not concatenate user search text into a URL.
- The examples use Bash process substitution so the token is not placed in curl's argument list:

```bash
curl --silent --show-error \
  --config <(printf 'header = "Authorization: Bot %s"\n' "$DISCORD_BOT_TOKEN") \
  --header 'Accept: application/json' \
  'https://discord.com/api/v10/guilds/'"${DISCORD_GUILD_ID}"'/channels' \
| jq '[.[] | {id, name, type, guild_id, parent_id}]'
```

Do not print the environment, token, or request headers. Do not use `curl -v`, tracing, or shell xtrace. Never use a user token or a self-bot; this bot token is the supported authentication method for bot API requests.

## Resolve a channel

### List server channels

`GET /guilds/{guild.id}/channels`

Returns the guild's channels and does not include threads. Match a requested channel name against `name`; if there are duplicates, ask which one the user means. The response's `id` is used in subsequent requests.

```bash
curl --silent --show-error \
  --config <(printf 'header = "Authorization: Bot %s"\n' "$DISCORD_BOT_TOKEN") \
  --header 'Accept: application/json' \
  "https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/channels" \
| jq '[.[] | {id, name, type, guild_id, parent_id}]'
```

### Verify a channel ID

`GET /channels/{channel.id}`

Use this when the user provides a channel mention or ID. Confirm the returned `guild_id` equals `DISCORD_GUILD_ID` before reading it. A channel object may represent a thread; its `parent_id` identifies the parent channel.

```bash
curl --silent --show-error \
  --config <(printf 'header = "Authorization: Bot %s"\n' "$DISCORD_BOT_TOKEN") \
  --header 'Accept: application/json' \
  "https://discord.com/api/v10/channels/${CHANNEL_ID}" \
| jq '{id, name, type, guild_id, parent_id, thread_metadata}'
```

## Read channel history

`GET /channels/{channel.id}/messages`

The bot needs `VIEW_CHANNEL` and `READ_MESSAGE_HISTORY` in a guild channel. Missing `READ_MESSAGE_HISTORY` may return an empty array. Results are newest first. `limit` is 1–100 (default 50); `before`, `after`, and `around` are snowflake message IDs and mutually exclusive.

```bash
# First page (newest messages):
curl --silent --show-error --get \
  --config <(printf 'header = "Authorization: Bot %s"\n' "$DISCORD_BOT_TOKEN") \
  --header 'Accept: application/json' \
  --data-urlencode 'limit=100' \
  "https://discord.com/api/v10/channels/${CHANNEL_ID}/messages" \
| jq '[.[] | {id, content, timestamp, author: {id: .author.id, username: .author.username}, attachments: [.attachments[]? | {id, filename, content_type}], message_reference}]'

# Older page: add the oldest message ID from the preceding page as `before`.
curl --silent --show-error --get \
  --config <(printf 'header = "Authorization: Bot %s"\n' "$DISCORD_BOT_TOKEN") \
  --header 'Accept: application/json' \
  --data-urlencode 'limit=100' \
  --data-urlencode "before=${BEFORE_MESSAGE_ID}" \
  "https://discord.com/api/v10/channels/${CHANNEL_ID}/messages" \
| jq '[.[] | {id, content, timestamp, author: {id: .author.id, username: .author.username}, attachments: [.attachments[]? | {id, filename, content_type}], message_reference}]'
```

Omit `before` on the first page. For older pages, set it to the last (oldest) message ID from the previous response. Stop when no messages are returned or the requested history scope is covered.

## Search messages

`GET /guilds/{guild.id}/messages/search`

Discord's indexed guild search is available to bots and requires `READ_MESSAGE_HISTORY`. The application must have the privileged `MESSAGE_CONTENT` intent enabled to search message content. A channel can be scoped with `channel_id`; without it, search is across the configured guild.

Useful query parameters:

| Parameter | Meaning |
| --- | --- |
| `content` | Text to search, up to 1024 characters |
| `channel_id` | Channel ID filter; repeat for multiple channels if needed |
| `limit` | 1–25 results per request; default 25 |
| `offset` | Result offset, up to 9975 |
| `min_id`, `max_id` | Bound results by message IDs |
| `sort_by` | `timestamp` or `relevance` |
| `sort_order` | `asc` or `desc`; ignored for relevance sorting |
| `slop` | Allowed word distance for content terms, 0–100; default 2 |

Example, where `SEARCH_QUERY` and `CHANNEL_ID` have already been set:

```bash
curl --silent --show-error --get \
  --config <(printf 'header = "Authorization: Bot %s"\n' "$DISCORD_BOT_TOKEN") \
  --header 'Accept: application/json' \
  --data-urlencode "content=${SEARCH_QUERY}" \
  --data-urlencode "channel_id=${CHANNEL_ID}" \
  --data-urlencode 'limit=25' \
  --data-urlencode 'sort_by=relevance' \
  "https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/messages/search" \
| jq '{total_results, messages: ([.messages // [] | flatten[]?] | map({id, channel_id, content, timestamp, author: {id: .author.id, username: .author.username}}))}'
```

`messages` is nested in the response; flatten it before processing. Search may return fewer results than the requested limit, and `total_results` may be temporarily inaccurate while messages are changing. An HTTP 202 response with Discord error code `110000` means the search index is not ready; wait for `retry_after` and retry once. Do not interpret it as zero matches.

## Errors and rate limits

- `401`: stop; the bot token is invalid or revoked. Never retry repeatedly.
- `403`: report that the bot lacks access to that channel. Do not try a different identity or endpoint to bypass permissions.
- `404`: verify the channel ID belongs to the configured guild and is visible to the bot.
- `429`: wait for JSON `retry_after` (or `Retry-After` if response headers are available) before any retry.
- Search `202` / code `110000`: wait for `retry_after` and retry once. If search remains unindexed, a recent-history scan may be used as a limited fallback: fetch at most 300 messages from the selected channel using the history endpoint and inspect their content. Say that older messages were not searched.

For each message used as evidence, construct its link as:

```text
https://discord.com/channels/{guild_id}/{channel_id}/{message_id}
```

## Official references

- [Get Guild Channels](https://discord.com/developers/docs/resources/guild#get-guild-channels)
- [Get Channel](https://discord.com/developers/docs/resources/channel#get-channel)
- [Get Channel Messages](https://discord.com/developers/docs/resources/message#get-channel-messages)
- [Search Guild Messages](https://discord.com/developers/docs/resources/message#search-guild-messages)
- [Discord rate limits](https://discord.com/developers/docs/topics/rate-limits)
- [Bot authentication](https://discord.com/developers/docs/topics/oauth2#bot-users)
