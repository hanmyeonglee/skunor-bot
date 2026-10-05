# Discord Codex 조사 봇

허용된 Discord 서버에서 봇을 멘션하면 Codex가 요청을 처리하고 답을 돌려줍니다. 논문·블로그 조사처럼 출처가 필요한 요청에는 웹 검색을 사용하고, 답변에 원문 링크를 포함하도록 설정했습니다.

## 동작

- `ALLOWED_GUILD_ID`에 적은 서버에서만 작동합니다. 별도의 사용자 인증이나 사용자별 허용 목록은 두지 않습니다.
- 일반 채널에서는 봇을 멘션한 메시지를 처리합니다. `/qna question:<질문>`을 실행하면 명령의 공개 응답 메시지에 새 공개 스레드를 만들고, 최근 메시지 최대 12개를 문맥으로 사용해 첫 답변을 그 스레드에 보냅니다. 슬래시 명령은 일반 사용자 메시지가 아니므로, 이전 대화 메시지에 스레드를 연결하지 않습니다. Q&A 스레드에서는 멘션 없이 보낸 모든 사람 메시지에 답하며, 스레드와 대화 내용은 SQLite에 저장됩니다. 요청은 한 번에 하나씩 처리하고, Discord 메시지 길이에 맞춰 답변을 나눕니다.
- Discord에서 지원하지 않는 마크다운 표 대신 제목·목록 형식으로 답합니다. 표가 비교에 유리하고 작으면 Embed 필드에 항목별 카드로 표시하며, Embed에 담기 어려운 표는 UTF-8 CSV 파일로 첨부합니다. CSV 첨부는 최대 8 MiB입니다.
- Codex 로그인이 안 되어 있으면 요청을 실행하지 않고 `/login` 명령을 안내합니다. `/login`은 기기 코드 인증 정보를 명령 실행자에게만 비공개로 보여줍니다. 인증 후 원래 요청을 다시 멘션해야 합니다.
- Notion MCP는 `/mcp-login notion`으로 연결합니다. 비공개 로그인 응답에서 Notion 승인을 연 뒤, 브라우저가 localhost 오류 페이지를 표시하면 주소창의 전체 URL을 복사해 ‘승인 URL 붙여넣기’ 창에 입력합니다. URL은 일회용 인증 코드를 포함하므로 비공개 입력창에만 붙여넣으세요. 인증 정보는 `/data/codex`에 저장됩니다. Notion 링크는 MCP로 직접 읽기를 시도하고, 접근 권한이 없으면 공개 웹 페이지를 live web search로 다시 읽습니다.
- Jira Cloud는 Atlassian 공식 Rovo MCP(`https://mcp.atlassian.com/v2/mcp`)를 사용하며 `/mcp-login jira`로 연결합니다. 로그인 응답의 버튼을 눌러 Atlassian 계정으로 승인하고, 브라우저가 localhost 오류 페이지를 표시하면 전체 주소를 복사해 비공개 ‘승인 URL 붙여넣기’ 창에 입력합니다. 인증 정보는 `/data/codex`에 저장되며, 봇 이용자는 연결한 Atlassian 계정이 접근할 수 있는 Jira 데이터를 함께 사용합니다.
- 공개 Google Docs 링크는 PDF로 내려받아 텍스트와 필요한 페이지 이미지를 확인합니다. PDF 변환·렌더링에는 컨테이너의 `poppler-utils`를 사용하며, 비공개이거나 다운로드가 막힌 문서는 읽을 수 없습니다.
- Codex 설정은 `gpt-6-luna`, 추론 `max`, 서비스 등급 `fast`로 고정되어 있습니다.
- 한 Discord 스레드 안에서는 참가자들이 대화 맥락을 공유합니다. 일반 채널에서는 사용자별 맥락을 분리합니다.
- 채널 기록·검색 요청은 설치된 `discord-api` 스킬에 따라 Codex가 Discord API를 직접 호출해 처리합니다. 채널 이름은 서버의 채널 목록에서 찾고, 채널 기록은 최근 100개씩 최대 300개까지 읽습니다. 메시지 검색은 Discord의 색인 검색을 사용하며 페이지마다 최대 25개를 반환합니다.
- API로 읽은 채널 기록은 SQLite에 복사하지 않습니다. 답변 근거로 사용한 메시지의 Discord 링크를 포함하고, 오래된 기록 전체를 읽지 않았다면 읽은 범위를 밝힙니다. 원문은 Codex 대화 세션에 포함될 수 있습니다.
- 이전 조사 결과 메모리는 허용된 서버 안에서 공유합니다. 비슷한 과거 질문과 답변을 SQLite에서 찾아 새 요청에 참고 자료로 전달합니다.
- SQLite에는 멘션으로 들어온 질문, 봇의 답변, Codex 대화 스레드 ID와 조사 메모리가 저장됩니다.
- 일정 기능은 Codex의 로컬 `skunor_schedule` MCP 도구와 봇의 SQLite 스케줄러를 사용합니다. 반복 작업은 설정한 cron 시각에 Codex가 실행합니다. 반복 작업 결과와 일정 알림은 지정한 채널에 지정한 사람을 멘션해 보냅니다. 기본값은 요청 채널과 등록자 멘션이며, 등록자는 자연어로 다른 채널과 사람을 지정하거나 기존 일정을 수정할 수 있습니다. 변경할 사람은 Discord에서 직접 멘션하고 채널은 서버의 채널 이름이나 채널 멘션으로 지정합니다. 일정 알림은 시작 15분 전과 5분 전에 전송됩니다.
- 일정 공개 범위는 기본적으로 개인이며, 등록자만 조회·수정·취소할 수 있습니다. "공용"으로 지정한 일정은 서버 멤버가 조회할 수 있고 변경은 등록자만 할 수 있습니다. 공개 범위와 알림을 보낼 채널·멘션 대상은 별도로 설정됩니다.
- cron 반복 작업의 시각대와 일정 해석 기본값은 `SCHEDULE_TIME_ZONE`이며 기본값은 `Asia/Seoul`입니다. 모호한 날짜나 시각은 Codex가 확인을 요청합니다. 봇이 중단된 동안 지나간 cron 회차는 재시작 후 한 번만 따라잡고, 그 사이 누락된 모든 회차를 몰아서 실행하지 않습니다.
- 일정과 실행 이력·결과는 SQLite의 `scheduled_items` 및 `schedule_occurrences` 테이블에 저장됩니다. 봇이 중단된 동안의 일정 알림은 재시작 시점에 행사가 아직 시작 전이면 유효한 알림만 보냅니다.
- Discord API 호출을 위해 Codex 요청 프로세스에는 `DISCORD_BOT_TOKEN`과 `DISCORD_GUILD_ID` 환경 변수를 전달합니다. 스킬은 토큰을 인증 헤더에만 사용하고 읽기 전용 GET 요청만 하도록 지시하지만, 이 제한은 컨테이너 내부의 기술적 차단은 아닙니다. Codex는 승인 없이 전체 접근 모드로 실행되므로 `node` 사용자가 접근 가능한 DB, `/data/codex`, 환경 변수에도 접근할 수 있습니다.
- Codex가 사용량 한도 오류를 반환하면 SQLite에 상태를 저장하고 `EXCEED_MESSAGE`를 보냅니다. 한도 오류만으로 초기화 시각을 알 수 없으므로, 사용량이 돌아온 뒤 `@봇 재확인`을 보내 직접 확인합니다.

## Discord 설정

1. Discord Developer Portal에서 애플리케이션과 Bot을 만듭니다.
2. OAuth2 URL Generator에서 `bot` scope와 `View Channels`, `Send Messages`, `Read Message History`, `Add Reactions`, `Create Public Threads`, `Send Messages in Threads` 권한을 골라 비공개 서버에 초대합니다. `bot` scope에 슬래시 명령용 `applications.commands` scope가 포함됩니다. 기록을 읽을 대상 채널에도 봇 역할의 `View Channel`과 `Read Message History` 권한이 있어야 합니다.
3. `.env.example`을 `.env`로 복사하고 `DISCORD_TOKEN`, `ALLOWED_GUILD_ID`를 채웁니다.

Discord Developer Portal에서 애플리케이션의 **Bot → Privileged Gateway Intents → Message Content Intent**를 켜고 저장하세요. 봇은 요청으로 지정된 다른 채널의 메시지 본문을 읽고 검색하기 위해 이 intent가 필요합니다. 코드에서도 `GatewayIntentBits.MessageContent`를 요청합니다. 변경 후 컨테이너를 재시작하세요.

기록 읽기와 검색은 요청에서 지정한 채널 또는 현재 채널을 대상으로 합니다. Discord 검색 색인이 준비되지 않으면 최근 300개 메시지에서 제한적으로 검색하고 그 범위를 답변에 밝힙니다. API 명세와 curl 예시는 `skills/discord-api/references/api.md`에 있습니다. Discord의 메시지 검색은 `Read Message History` 권한과 Message Content intent의 영향을 받습니다. [메시지 조회·검색 API 문서](https://discord.com/developers/docs/resources/message)

```sh
cp .env.example .env
```

`.env`는 Git에서 제외됩니다. Discord 토큰을 코드나 이미지에 넣지 마세요.

## Docker 서버에서 실행

Docker Engine과 Docker Compose가 있는 Linux 서버를 기준으로 합니다.

```sh
docker compose build
docker compose up -d
docker compose logs -f bot
```

첫 명령은 이미지를 빌드하고, 두 번째 명령은 봇을 상시 실행합니다. 처음 봇을 멘션하면 로그인 안내가 나오며, Discord에서 `/login`을 실행해 표시되는 주소와 코드를 사용해 외부 브라우저에서 Codex 계정을 승인하세요. 인증 상태는 봇 전체가 공유합니다.

`bot-data` Docker 볼륨을 `/data`에 마운트해 SQLite DB, Codex 로그인 정보, Codex 대화를 보존합니다. 시작할 때 저장소의 `skills/discord-api` 스킬을 `/data/codex/skills/discord-api`에 설치합니다. 실행 이미지에는 스킬의 curl 예시를 위해 `curl`과 `jq`가 포함됩니다. Codex 요청은 컨테이너 안에서 전체 접근 모드로 실행되므로 Codex 도구도 `/data`를 읽고 쓸 수 있습니다. 볼륨을 백업하고 서버 관리자만 접근하게 하세요. `docker compose down -v`는 이 데이터를 삭제합니다.

Compose는 호스트 포트를 공개하지 않습니다. 봇은 Discord Gateway로 직접 연결하고 `0.0.0.0:8080`에 내부 health endpoint만 제공합니다. `/healthz`는 프로세스 liveness, `/readyz`는 Discord 연결 상태를 확인합니다. 공개 도메인이나 reverse proxy는 필요하지 않습니다.

Codex CLI와 Discord Gateway, Codex 서비스에 대한 outbound HTTPS/WebSocket 연결이 필요합니다. 이 저장소의 Compose는 일반 Docker bridge 네트워크를 사용합니다. `cubus.sh`의 내부 전용 `web` 네트워크에만 연결하면 외부 연결이 차단될 수 있으므로, 중앙 Compose에 서비스를 옮길 때는 egress가 가능한 bridge 네트워크도 연결해야 합니다. health endpoint를 외부 ingress에 공개할 필요는 없습니다.

요청 처리는 Codex SDK의 `danger-full-access` 모드와 `approval_policy = "never"`를 사용합니다. Codex 내부의 `bubblewrap` 샌드박스와 승인 확인을 건너뛰고, Docker 컨테이너를 격리 경계로 사용합니다. 따라서 Codex 도구는 컨테이너 안에서 `node` 사용자가 접근 가능한 파일과 네트워크에 접근할 수 있습니다. Docker 호스트의 user namespace 설정이나 `bubblewrap` AppArmor 프로필은 필요하지 않습니다. 컨테이너에 Docker 소켓이나 무관한 호스트 디렉터리를 마운트하지 마세요.

## Codex 계정 사용 제한

이 봇은 OpenAI API key를 사용하지 않고 Codex CLI SDK와 로그인된 ChatGPT 계정을 사용합니다. Codex SDK는 로컬 CLI를 실행하고 같은 `CODEX_HOME`의 로그인 상태를 이용합니다. OpenAI의 구독 사용량 공유 문서는 오픈 소스와 로컬 호스팅 앱을 대상으로 설명하며, 원격 호스팅 앱에서 제공하려면 별도 interest form을 제출하라고 안내합니다. 따라서 Cubus 원격 서버의 비공개 Discord 봇에서 이 계정 사용이 허용되는지는 아직 확인되지 않았습니다. 배포 전에 해당 경로의 승인을 확인하세요. 사용 자격이나 모델·Fast 등급이 허용되지 않으면 봇이 자동으로 API 과금으로 전환하지 않습니다.

- [Codex TypeScript SDK](https://github.com/openai/codex/blob/main/sdk/typescript/README.md)
- [Codex CLI 로그인](https://developers.openai.com/codex/cli/reference#codex-login)
- [Codex 권한 및 샌드박스 설정](https://developers.openai.com/codex/permissions)
- [ChatGPT 구독 사용량 공유 개요 및 앱 배포 자격](https://developers.openai.com/siwc/token-sharing-open-source)
- [ChatGPT 구독 사용량 공유의 제한](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [사용 한도 오류 처리](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)

## 설정값

| 변수 | 설명 |
| --- | --- |
| `DISCORD_TOKEN` | Discord Bot 토큰 |
| `ALLOWED_GUILD_ID` | 봇이 응답할 Discord 서버 ID |
| `DATABASE_PATH` | SQLite 파일 경로. Compose 기본값 `/data/bot.sqlite3`, 로컬 기본값 `./data/bot.sqlite3` |
| `CODEX_HOME` | 인증 및 Codex 세션 저장 경로. Compose 기본값 `/data/codex`, 로컬 기본값 `./data/codex` |
| `SCHEDULE_TIME_ZONE` | cron과 기본 일정 시각대. 기본값 `Asia/Seoul` |
| `HOST`, `PORT` | 내부 health HTTP 서버 설정. 기본값 `0.0.0.0:8080` |
| `EXCEED_MESSAGE` | Codex 사용 한도에 도달했을 때 보낼 고정 문구 |

모델, 추론 깊이, 서비스 등급은 코드에 고정되어 있습니다.

## 메모리 및 기록

SQLite 파일에는 Discord 대화 원문과 성공한 요청·응답이 저장됩니다. 서버 내 요청과 답변은 공용 조사 메모리에 검색용 단어로도 기록되며, 다음 요청에서 관련 과거 답변 일부가 맥락으로 전달됩니다. 등록된 반복 작업·일정과 반복 실행 결과도 SQLite에 저장됩니다. Codex가 저장하는 이어가기용 세션은 `/data/codex` 아래에 보관됩니다. 데이터 보관 기간이나 일괄 삭제 기능은 아직 설정하지 않았으므로, 필요한 경우 SQLite 파일과 Codex 세션을 함께 백업·삭제해야 합니다.

## 로컬 실행

Node.js 24 이상과 npm이 필요합니다. `npm start`가 먼저 TypeScript를 컴파일합니다.

```sh
npm install
npm start
```

로컬 실행에서도 Codex CLI 로그인 상태와 `curl`, `jq`, `poppler-utils`가 필요하며 `CODEX_HOME`에 스킬을 설치하고 권한 프로필을 초기화합니다.

`npm run typecheck`는 타입 검사를 수행하고, `npm run build`는 `src/*.ts`를 `dist/`의 JavaScript로 컴파일합니다. Docker 이미지도 이 컴파일을 통과한 뒤 `dist/`를 실행합니다.
