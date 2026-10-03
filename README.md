# Discord Codex 조사 봇

허용된 Discord 서버에서 봇을 멘션하면 Codex가 요청을 처리하고 답을 돌려줍니다. 논문·블로그 조사처럼 출처가 필요한 요청에는 웹 검색을 사용하고, 답변에 원문 링크를 포함하도록 설정했습니다.

## 동작

- `ALLOWED_GUILD_ID`에 적은 서버에서만 작동합니다. 별도의 사용자 인증이나 사용자별 허용 목록은 두지 않습니다.
- 봇을 멘션한 메시지만 처리합니다. 요청은 한 번에 하나씩 처리하고, Discord 메시지 길이에 맞춰 답변을 나눕니다.
- Codex 로그인이 안 되어 있으면 요청을 실행하지 않고 `/login` 명령을 안내합니다. `/login`은 기기 코드 인증 정보를 명령 실행자에게만 비공개로 보여줍니다. 인증 후 원래 요청을 다시 멘션해야 합니다.
- Codex 설정은 `gpt-6-luna`, 추론 `max`, 서비스 등급 `fast`로 고정되어 있습니다.
- 한 Discord 스레드 안에서는 참가자들이 대화 맥락을 공유합니다. 일반 채널에서는 사용자별 맥락을 분리합니다.
- 이전 조사 결과 메모리는 허용된 서버 안에서 공유합니다. 비슷한 과거 질문과 답변을 SQLite에서 찾아 새 요청에 참고 자료로 전달합니다.
- SQLite에는 멘션으로 들어온 질문, 봇의 답변, Codex 대화 스레드 ID와 조사 메모리가 저장됩니다.
- Codex에는 Discord 토큰 등 봇 프로세스의 환경 변수를 넘기지 않습니다. Codex 로컬 명령은 읽기 전용으로 제한하고, 인증 정보·DB·앱 디렉터리 읽기를 차단합니다.
- Codex가 사용량 한도 오류를 반환하면 SQLite에 상태를 저장하고 `EXCEED_MESSAGE`를 보냅니다. 한도 오류만으로 초기화 시각을 알 수 없으므로, 사용량이 돌아온 뒤 `@봇 재확인`을 보내 직접 확인합니다.

## Discord 설정

1. Discord Developer Portal에서 애플리케이션과 Bot을 만듭니다.
2. OAuth2 URL Generator에서 `bot` scope와 `View Channels`, `Send Messages`, `Read Message History` 권한을 골라 비공개 서버에 초대합니다. `bot` scope에 슬래시 명령용 `applications.commands` scope가 포함됩니다.
3. `.env.example`을 `.env`로 복사하고 `DISCORD_TOKEN`, `ALLOWED_GUILD_ID`를 채웁니다.

이 봇은 멘션된 메시지만 읽으므로 **Message Content Intent**를 켤 필요가 없습니다. Discord는 봇을 멘션한 메시지의 본문을 이 intent 없이도 전달합니다.

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

`bot-data` Docker 볼륨을 `/data`에 마운트해 SQLite DB, Codex 로그인 정보, Codex 대화를 보존합니다. Codex 요청은 컨테이너 안에서 전체 접근 모드로 실행되므로 Codex 도구도 `/data`를 읽고 쓸 수 있습니다. 볼륨을 백업하고 서버 관리자만 접근하게 하세요. `docker compose down -v`는 이 데이터를 삭제합니다.

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
| `HOST`, `PORT` | 내부 health HTTP 서버 설정. 기본값 `0.0.0.0:8080` |
| `EXCEED_MESSAGE` | Codex 사용 한도에 도달했을 때 보낼 고정 문구 |

모델, 추론 깊이, 서비스 등급은 코드에 고정되어 있습니다.

## 메모리 및 기록

SQLite 파일에는 Discord 대화 원문과 성공한 요청·응답이 저장됩니다. 서버 내 요청과 답변은 공용 조사 메모리에 검색용 단어로도 기록되며, 다음 요청에서 관련 과거 답변 일부가 맥락으로 전달됩니다. Codex가 저장하는 이어가기용 세션은 `/data/codex` 아래에 보관됩니다. 데이터 보관 기간이나 삭제 기능은 아직 설정하지 않았으므로, 필요한 경우 SQLite 파일과 Codex 세션을 함께 백업·삭제해야 합니다.

## 로컬 실행

Node.js 24 이상과 npm이 필요합니다.

```sh
npm install
npm start
```

로컬 실행에서도 Codex CLI 로그인 상태가 필요하며 `CODEX_HOME`의 권한 프로필을 봇이 초기화합니다.
