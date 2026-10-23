# ALMS Server

숭실대학교 LMS·u-SAINT 연동을 위한 TypeScript 서버입니다. Fastify REST API, PostgreSQL 저장소, 선택적 재생 worker와 조회 전용 Remote MCP를 한 저장소에서 관리합니다. 학교 연동 SDK `@alms/ssu-api`는 검토한 로컬 패키지 버전으로 고정합니다.

학교가 제공하거나 보증하는 공식 서비스가 아닙니다. 코드와 합성 테스트의 공개는 특정 계정·학교 응답·운영 환경에서 로그인, 제출, 진도 또는 출석이 성공한다는 보장이 아닙니다. 실제 학교 기능은 설정·권한·대상별 지원 상태를 확인한 뒤 사용해야 합니다.

## 제공 기능

| 영역 | 구현 범위와 제한 |
| --- | --- |
| 인증 | 학교 SSO 신원 검증, 사용자별 암호화 학교 세션, ALMS 세션, 등록된 웹 클라이언트의 cookie 또는 bearer 인증 |
| 학교 조회 | 학기·강좌·주차 활동·과제와 본인 제출·일정·시간표·출결·학습 상태. 계정과 학교 응답에 따라 사용 가능 여부가 달라짐 |
| 자료 | 권한을 확인한 PDF·첨부·영상의 내부 열람과 지원되는 강의계획서 PDF 렌더링 |
| 개인 기록 | 개인 TODO와 학습 완료 체크. 학교의 제출·출석·완료 기록과 별도로 저장 |
| 학교 쓰기 | 지원되는 과제의 명시적 제출, 실제 수동 영상 관찰·진도 보고, 제한된 서버 재생. 불명확한 쓰기는 자동 재전송하지 않음 |
| MCP | 본인 데이터 조회 도구 12개. 별도 OAuth/S256 승인과 승인한 ALMS 세션의 유효기간 안에서만 접근 |
| 운영 | DB migration, 작업 큐, 상태 조회, 제한된 진단, 선택적 PostHog EU 전송 |

공지와 퀴즈 전용 기능, 서버 재생의 일시정지·재개는 지원하지 않습니다. `readystream`은 지원되는 단일 영상의 수동 재생에 제한되며 서버 재생 접수를 허용하지 않습니다. `GET /v1/features`는 서비스 구현 상태를, 각 응답의 `featureSupport`는 대상별 상태를 설명합니다. 작업 종료·학습 완료·출석 인정은 서로 다른 값입니다.

## 로컬 실행

Node.js 24 이상과 접근 가능한 PostgreSQL이 필요합니다. 아래 `.env`는 **로컬 Node 프로세스용**이며 학교 연동과 MCP는 기본으로 꺼져 있습니다. 웹 프론트는 이 저장소에 포함하지 않습니다.

```sh
cp .env.example .env
# .env의 DATABASE_URL을 본인의 개발 DB 연결로 설정합니다.
npm ci
npm run build
node --env-file=.env dist/migrate.js
node --env-file=.env dist/server.js
```

기본 로컬 주소는 API `http://localhost:4300`, 프론트 Origin `http://localhost:5173`이며 `COOKIE_SECURE=false`입니다. 앱이 `.env`를 자동으로 읽지 않으므로 `--env-file`을 지정하거나 환경 변수를 주입합니다. 별도 worker가 필요하면 같은 환경으로 `node --env-file=.env dist/worker-main.js`를 실행합니다.

```sh
curl --fail http://localhost:4300/healthz
curl --fail http://localhost:4300/readyz
curl --fail http://localhost:4300/.well-known/alms-api
```

상태 조회 성공은 DB·프로세스 준비 상태를 뜻합니다. 학교 연동이 꺼진 상태에서는 학교 로그인과 학교 데이터 조회를 사용할 수 없으며 샘플 계정이나 강좌를 정상 학교 응답으로 반환하지 않습니다.

## Docker Compose

제공된 Compose는 PostgreSQL·migration·API·worker를 구성합니다. API는 서버의 `127.0.0.1:4300`에만 노출하며 PostgreSQL 포트는 호스트에 공개하지 않습니다. DB는 영속 volume을 사용합니다.

Compose는 `NODE_ENV=production`과 `COOKIE_SECURE=true`를 고정합니다. 로컬 HTTP용 `.env.example`을 그대로 사용하는 대신 별도 `.env.compose`에 최소한 다음 값을 설정합니다. 비밀번호와 주소는 본인의 값으로 교체합니다.

```dotenv
POSTGRES_PASSWORD=replace-with-a-url-safe-random-password
API_PUBLIC_ORIGIN=https://api.example.org
FRONTEND_ORIGIN=https://app.example.org
ALLOWED_ORIGINS=https://app.example.org
```

```sh
docker compose --env-file .env.compose config --quiet
docker compose --env-file .env.compose up -d --build
docker compose --env-file .env.compose ps
```

`POSTGRES_PASSWORD`는 필수이며 Compose가 내부 `DATABASE_URL`을 만듭니다. API·프론트 Origin은 HTTPS여야 합니다. TLS 종료와 도메인 연결은 별도 reverse proxy가 담당합니다. sandbox Chromium과 seccomp를 지원하는 컨테이너 호스트가 필요합니다. 운영 배포 전 백업·복원과 실행 중 작업의 처리 방법을 준비합니다.

## 학교 연동과 설정

- `SESSION_ENCRYPTION_KEY`: 정확히 32바이트 난수의 base64 값입니다. 비밀 저장소에서 주입하고 유지합니다. 키 분실·교체는 기존 암호화 기록의 복호화에 영향을 줍니다.
- `SSU_AUTH_ENABLED`: 학교 SSO를 연결합니다. 학교 callback 정책과 브라우저 반환을 확인해야 하며 실제 운영 SSO에는 HTTPS 도메인이 필요합니다. 로컬 HTTP만으로 cross-site callback 검증을 완료했다고 판단하지 않습니다.
- `SSU_READ_ENABLED`, `SSU_SAINT_READ_ENABLED`: LMS와 u-SAINT 조회를 각각 활성화합니다. 학교의 인증·수강권한을 재검증합니다.
- `SSU_PLAYBACK_ENABLED`: 지원 대상의 서버 재생을 활성화합니다. 같은 커밋·SDK의 worker 준비 상태와 현재 학교 권한이 추가로 필요합니다. flag만으로 재생을 허용하지 않습니다.
- `FRONTEND_CLIENTS_JSON`: 추가 웹 프론트를 정확한 Origin·복귀 주소로 등록합니다. 다른 사이트의 프론트는 bearer와 S256 PKCE를 사용합니다. [HTTP 인증 계약](docs/http-contract.md)을 따릅니다.
- `POSTHOG_PROJECT_KEY`: 선택적 외부 이벤트 전송입니다. 비어 있어도 허용된 로컬 이벤트 저장은 계속됩니다.

학교 비밀번호는 공식 학교 로그인 화면에서 입력합니다. 학교 쿠키·토큰·원문 응답·학생 데이터·DB 연결 문자열을 로그, 이슈, PR에 올리지 않습니다.

## REST API와 MCP

- [HTTP 계약](docs/http-contract.md)과 [OpenAPI](docs/openapi.json): 경로·필수 헤더·입출력·오류의 기준입니다. 실행 서버도 `/openapi.json`을 제공합니다.
- `/.well-known/alms-api`: 해당 배포에서 활성화된 인터페이스를 알려 줍니다.
- [MCP 계약](docs/mcp-contract.md): OAuth 설정, Codex 연결, 도구 목록, 결과 제한과 오류를 설명합니다.

MCP는 기본 비활성입니다. migration 015, 기존 세션 암호화 키, 영속 RSA 서명 JWKS와 cookie 키를 준비한 API 역할에서만 활성화합니다. 현재 native OAuth client는 `alms-codex` 하나이며 scope는 `alms:read`입니다. 동적·임의 클라이언트 등록은 제공하지 않습니다. 승인에는 기본 `alms-web` 클라이언트의 유효한 ALMS 세션이 필요합니다.

2026-10-23 Codex CLI 0.141.0에서 운영 OAuth 연결과 조회 도구 7종의 실제 호출을 각각 한 표본씩 확인했습니다. 한계·부분 소스 표시를 포함한 응답 성공이며, 강좌 데이터 전체의 완전성이나 모든 LMS 기능을 확인한 결과는 아닙니다. 도구별 결과는 [MCP 계약의 실제 검증 범위](docs/mcp-contract.md#실제-검증-범위)를 참고하세요.

나머지 5개 도구, 다른 클라이언트·계정·네트워크, 운영 환경의 MCP refresh 회전·토큰 폐기와 별도 차시 출결은 아직 미검증입니다. 합성·PostgreSQL 회귀 검사와 실제 호출 표본을 구분합니다.

MCP는 학교 쓰기·재생·제출·자료 바이트를 도구로 제공하지 않습니다. OAuth 승인·토큰 회전과 기존 조회의 세션·캐시 갱신은 저장 동작을 포함합니다. REST 세션 토큰과 MCP 토큰은 서로 대신 사용할 수 없습니다.

## 개발과 검증

```sh
npm run check
# 별도 alms_test 또는 alms_qa DB의 연결 문자열을 환경에 주입한 뒤 실행합니다.
npm run test:integration
# HTTP 계약을 바꾼 경우 생성 결과를 함께 검토합니다.
npm run contract:generate
```

통합 테스트는 `TEST_DATABASE_URL`을 사용합니다. 합성 학교 adapter와 격리 DB 테스트의 성공은 실제 학교 로그인·업로드·최종 제출·영상 보고·출석 성공의 근거가 아닙니다. 실제 계정 검증은 대상과 변경 내용을 명확히 정하고 수행합니다. 이미 제출한 과제를 검증용으로 다시 제출하지 않습니다.

기여 절차는 [CONTRIBUTING](CONTRIBUTING.md), 보안 보고는 [SECURITY](SECURITY.md), 자동화 작업 지침은 [AGENTS](AGENTS.md)를 참고합니다.

## 라이선스

ALMS Server는 [MIT 라이선스](LICENSE)를 적용합니다. 비공개 프로젝트와 상용 서비스에서도 사용할 수 있으며 배포하는 사본에는 라이선스의 저작권 표시와 허가 문구를 유지해야 합니다. 외부 코드의 고지는 [NOTICE](NOTICE)와 [라이선스 파일](LICENSES/)을 함께 확인합니다. 이 라이선스는 학교 데이터·강의자료에 대한 권리를 부여하지 않습니다.
