# ALMS MCP 계약

이 문서는 조회 전용 Remote MCP의 구현 계약이다. REST API는 [HTTP 계약](http-contract.md)을 따른다.

## 실제 검증 범위

2026-10-23 Codex CLI 0.141.0으로 운영 OAuth 연결과 아래 조회 도구 각각의 실제 호출 한 표본을 확인했다.

| 도구 | 확인 결과 |
| --- | --- |
| `alms_get_capabilities` | 응답 성공 |
| `alms_list_terms` | 응답 성공 |
| `alms_list_courses` | 응답 성공 |
| `alms_get_course` | 응답 성공, 부분 소스 표시 유지 |
| `alms_list_assignments` | 응답 성공 |
| `alms_get_calendar` | 응답 성공 |
| `alms_get_attendance` | 응답 성공 |

여기서 성공은 한계·부분 소스 표시를 포함한 도구 응답의 성공을 뜻한다. 강좌 전체 데이터의 완전성이나 모든 LMS 기능을 확인한 결과로 확대하지 않는다. 이번 표본은 OAuth·도구 호출 수준의 검증이며 모델 대화의 도구 선택은 포함하지 않는다.

다음 범위는 아직 미검증이다.

- 나머지 5개 도구: `alms_get_activity`, `alms_get_assignment`, `alms_list_tasks`, `alms_get_timetable`, `alms_get_learning_status`
- 다른 MCP 클라이언트·계정·네트워크
- 운영 환경에서 MCP refresh 토큰의 회전과 토큰 폐기
- 별도 차시 출결 확인

합성 전송·PostgreSQL 회귀 검사와 위 실제 표본을 구분한다. 아래 연결 예시만으로 실제 조회 성공이나 범용 클라이언트 호환을 판단하지 않는다.

## 범위와 인증 경계

- 전송 주소는 구성된 API Origin의 `/mcp`다. 로컬 예시 Origin을 사용하면 `http://localhost:4300/mcp`가 된다.
- 학교 SSO와 기존 프론트 로그인·CSRF 계약은 유지한다. MCP는 별도의 OAuth Authorization Server(`oidc-provider`), 토큰, 동의 이력과 쿠키를 사용한다.
- MCP는 등록한 native OAuth client `alms-codex` 하나와 `alms:read` scope만 지원한다. CIMD·DCR·임의 클라이언트 등록은 제공하지 않는다.
- `/mcp`는 MCP 전용 Bearer만 받는다. ALMS 로그인 쿠키, 기존 프론트 Bearer, 학교 토큰, `X-ALMS-Client-Id`를 MCP 권한으로 사용하지 않는다. 토큰을 URL·도구 인수·분석 이벤트에 넣지 않는다.
- 로그인한 사용자가 브라우저에서 승인하면, 그 **기본 `alms-web` 세션**에 MCP 승인을 연결한다. 다른 웹 클라이언트의 세션이나 사용자가 지정한 `userId`로 대신 승인하지 않는다.
- 각 요청과 도구 실행에서 승인·원래 세션·소유자를 재검증한다. 같은 연결에서 앞서 인증됐다는 이유로 다음 요청을 허용하지 않는다.

MCP의 조회 전용 범위는 학교 학습 기록의 쓰기를 하지 않는다는 의미다. OAuth 승인·토큰 저장·기존 학교 조회의 세션 관리·캐시 갱신까지 저장 동작이 없다는 의미는 아니다.

## OAuth discovery와 연결

구성한 API Origin을 `API_ORIGIN`이라고 할 때 다음 경로를 제공한다.

| 경로 | 용도 |
| --- | --- |
| `/.well-known/oauth-protected-resource/mcp` | `resource: API_ORIGIN/mcp`, `authorization_servers: [API_ORIGIN/oauth]`, `scopes_supported: [alms:read]` |
| `/.well-known/oauth-protected-resource` | 위와 같은 리소스 메타데이터의 루트 경로 |
| `/.well-known/oauth-authorization-server/oauth` | Authorization Server discovery |
| `/oauth/.well-known/openid-configuration` | Provider의 OIDC discovery |
| `/oauth/auth` | authorization-code + PKCE 승인 시작 |
| `/oauth/token` | 단회 code 교환 및 refresh |
| `/oauth/token/revocation` | 해당 클라이언트의 토큰 폐기 |
| `/oauth/jwks` | 공개 서명키 |
| `/oauth/interaction/:uid` | 기존 ALMS 세션 확인 및 조회 동의 화면·POST |

Issuer는 정확한 `API_ORIGIN/oauth`, resource와 access token audience는 정확한 `API_ORIGIN/mcp`다. 다른 resource를 허용하지 않는다. Authorize 요청에는 resource 하나, `response_type=code`, PKCE `S256`, 정확한 `scope=alms:read`가 필요하다. `offline_access`를 포함한 추가 scope는 거절한다. Token endpoint의 public client 인증 방식은 `none`이다.

연결 순서:

1. MCP 클라이언트가 리소스·인증 서버 메타데이터를 조회한다.
2. 브라우저에서 OAuth 승인을 시작한다. ALMS 로그인이 없으면 기존 ALMS 로그인 화면을 별도로 열고, 로그인 뒤 동의 창을 새로고침한다.
3. 동의 화면에서 `alms-codex`, 조회 범위와 **해당 ALMS 로그인 유효기간 안의 자동 갱신**을 확인하고 승인하거나 취소한다. 계정과 학교 비밀번호를 MCP에 입력하지 않는다.
4. 승인 POST는 정확한 API Origin, 원래 ALMS 세션의 CSRF, interaction UID와 단회 nonce를 검증한다. 서버가 세션에서 owner를 결정한다.
5. 클라이언트가 PKCE verifier로 code를 교환하고 각 `/mcp` 요청에 `Authorization: Bearer …`를 붙인다.

승인·취소 POST는 Provider에 결과를 저장한 뒤 **200 private HTML**로 응답한다. 새 문서의 즉시 meta refresh가 동일 Origin의 정확한 interaction resume URL을 GET으로 열며, 같은 URL의 ‘계속하기’ 링크도 제공한다. `form-action 'self'`와 기존 Origin·CSRF·nonce·세션 검증은 유지하고, 폼 POST의 303 연쇄로 loopback callback까지 이동하지 않는다. resume에서 등록된 native callback으로 돌려보낸 뒤, 승인된 경우 클라이언트가 code를 교환한다.

Interaction은 최대 **15분**, 화면의 단회 동의 nonce는 최대 **10분**이며 nonce는 승인할 ALMS 세션보다 오래 유효하지 않다. Code는 최대 **60초**, access token은 최대 **300초**, refresh token은 발급마다 최대 **24시간**이며 모두 원래 승인 세션의 남은 유효기간으로 제한된다. 명시적으로 조회·갱신을 승인한 등록 클라이언트에만 refresh token을 발급한다. 갱신 요청마다 원래 승인·소유자·ALMS 세션을 다시 확인하고 토큰을 회전하며, ALMS 세션 밖의 오프라인 접근은 허용하지 않는다. 이전 refresh token을 다시 사용하면 관련 grant를 폐기한다.

기존 OIDC 쿠키가 있어도 현재 유효한 기본 ALMS 로그인이 필요하다. 이전 OIDC 계정과 현재 ALMS 계정이 다르면 동의 화면과 승인 POST에서 중단한다. 다른 계정의 기존 grant를 재사용하거나 현재 계정의 승인으로 바꾸지 않는다. 같은 계정으로 새 ALMS 세션을 만든 경우에도 새 동의가 필요하며, 이전 승인·refresh의 만료를 연장하지 않는다.

**승인한 ALMS 세션의 로그아웃·삭제·만료는 MCP 접근도 차단한다.** 다른 클라이언트의 별도 ALMS 세션까지 종료시키지 않는다. MCP 토큰 폐기는 기존 ALMS 로그인이나 수강을 종료하지 않는다. `codex mcp logout`의 로컬 인증정보 제거와 서버의 token revocation은 구분하며, CLI 명령이 서버 폐기를 수행했다고 확인 없이 보고하지 않는다.

## Codex CLI 0.141.0 연결 예시

아래 명령은 Codex CLI 0.141.0의 설정 형태를 기준으로 한다. 다른 버전의 옵션과 호환성은 해당 클라이언트에서 확인해야 한다. 예시의 loopback 주소는 로컬 설정 설명용이며 실제 운영 SSO에는 HTTPS API·프론트와 학교 callback 검증이 필요하다.

### 중복 resource 방지

이 CLI의 연결 설정에서는 discovery로 얻는 resource를 사용하고 중복되는 `oauth_resource` override를 추가하지 않는다. 서버는 정확한 resource 하나만 허용하며 중복 resource 요청은 거절한다.

기존 설정에 `oauth_resource`가 있다면 설정 소유자가 검토한다. 다른 서버나 profile 설정 전체를 교체하지 않는다.

### 이번 명령에서만 서버 설정

다음 명령은 `config.toml`에 MCP 서버를 추가하지 않는다. OAuth 로그인 자체는 Codex의 인증 저장소를 사용할 수 있다. 먼저 검증된 서버 주소와 동의 화면을 확인한다.

```sh
codex \
  -c 'mcp_servers.alms_qa.url="http://localhost:4300/mcp"' \
  -c 'mcp_servers.alms_qa.enabled=true' \
  -c 'mcp_servers.alms_qa.oauth.client_id="alms-codex"' \
  mcp login alms_qa --scopes alms:read
```

같은 이름·주소·설정으로 실제 읽기 호출을 검증한다. 아래 실행은 모델 호출을 포함하며 단순 설정 조회와 다르다.

```sh
codex exec --ephemeral \
  -c 'mcp_servers.alms_qa.url="http://localhost:4300/mcp"' \
  -c 'mcp_servers.alms_qa.enabled=true' \
  -c 'mcp_servers.alms_qa.oauth.client_id="alms-codex"' \
  -c 'mcp_servers.alms_qa.enabled_tools=["alms_get_capabilities"]' \
  'ALMS의 alms_get_capabilities를 한 번 호출하고 실제 반환한 지원 상태만 요약해 줘.'
```

`oauth.client_id`는 **중첩 키**다. `oauth_client_id`라는 평면 키로 바꾸지 않는다. 이 연결 예시에는 `oauth_resource` override를 넣지 않는다. `mcp get --json`은 이 CLI에서 OAuth client 설정을 모두 보여주지 않으므로 출력에 없다는 이유로 설정이 없거나 적용됐다고 단정하지 않는다.

로그인과 호출에 같은 서버명 `alms_qa`, 정확한 URL `http://localhost:4300/mcp`, 같은 Codex 인증 저장소를 사용한다. 서버명이나 URL의 끝 slash를 바꾸거나 `CODEX_HOME`·credential store 설정·사용자 설정 로드 방식을 바꿔 다른 인증정보를 선택하지 않는다. `-c` 옵션은 이번 프로세스에만 적용되지만, 정상 OAuth 로그인은 기존 Codex 인증 저장소에 토큰을 저장할 수 있다. 저장소에서 토큰을 꺼내 Bearer 환경 변수로 대신 넣지 않는다.

### 사용자가 상시 등록할 경우

```sh
codex mcp add alms_qa \
  --url http://localhost:4300/mcp \
  --oauth-client-id alms-codex
codex mcp login alms_qa --scopes alms:read
```

상시 등록 명령은 사용자가 등록하기로 선택한 경우에만 실행한다. 또는 사용자 `config.toml`에 해당 항목만 병합한다. 기존 설정 전체를 교체하지 않는다. 이미 있는 항목의 `oauth_resource`가 병합 과정에서 남아 있지 않은지도 확인한다.

```toml
[mcp_servers.alms_qa]
url = "http://localhost:4300/mcp"
tool_timeout_sec = 40

[mcp_servers.alms_qa.oauth]
client_id = "alms-codex"
```

등록 redirect URI는 가변 loopback 포트의 기존 `/callback` 경로와 현재 resource URL에서 계산한 Codex callback 경로다. Codex CLI 0.141.0의 계산은 서버 URL에서 fragment를 제거한 문자열의 SHA256 앞 9바이트를 base64url로 바꾸고 `/callback/` 뒤에 붙이는 방식이다. resource를 바꾸면 callback 경로도 달라진다. 서버의 정확한 등록 규칙은 [`src/mcp-config.ts`](../src/mcp-config.ts)를 따른다.

다른 resource의 callback ID, 임의 접미사·하위 경로·query·fragment·userinfo와 wildcard는 허용하지 않는다. callback 계산의 원본은 [Codex 0.141.0 소스](https://github.com/openai/codex/blob/3fb81667d30d9d24297216ea61fbfcc4351b2aa9/codex-rs/rmcp-client/src/perform_oauth_login.rs)에서 확인할 수 있다. 이 규칙의 구현은 실제 OAuth 반환·issuer 검증·토큰 교환 성공을 대신하지 않는다.

## 전송·프로토콜

- 설치 SDK는 `@modelcontextprotocol/server` 2.3.1과 `@modelcontextprotocol/node` 2.1.1이다. 하나의 도구 factory를 `createMcpHandler({ legacy: 'stateless' })` 방식으로 요청마다 생성한다.
- 2025 계열은 initialize/initialized 후 POST 요청을 받는 stateless fallback, 2026-07-28은 `server/discover`와 요청별 metadata를 사용하는 경로다. SDK가 두 형식의 wire 차이를 처리한다.
- POST에는 JSON 본문과 `Accept: application/json, text/event-stream`이 필요하다. 2026 계열은 protocol version·method·도구 이름 등의 표준 header/metadata도 사용한다. SDK 클라이언트를 통해 구성하고 버전별 JSON을 혼용하지 않는다.
- 응답은 JSON 또는 요청별 SSE다. GET·DELETE는 stateless 모드에서 405이며 프로토콜 세션 ID를 발급하지 않는다.
- `/mcp`는 정확한 Host를 검사한다. Origin이 있으면 구성된 API 또는 허용 Origin과 정확히 같아야 한다. 브라우저가 아닌 클라이언트의 Origin 부재는 허용하지만 Bearer 검증을 생략하지 않는다.
- 최종 JSON·SSE 응답은 `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`를 사용한다.

CLI 버전이나 명령 형식만으로 프로토콜 상호운용 성공을 판단하지 않는다. 전송 회귀는 실제 localhost Fastify listener와 합성 인증·도구로 2025-06-18, 2025-11-25, 2026-07-28을 검사한다. **이는 실제 Codex의 OAuth·도구 호출이나 학교 데이터 성공 근거와 별개다.**

## 제공 도구

모든 도구의 `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`다. 이 표시는 권한 검사를 대신하지 않는다. 아래 ID는 양의 십진수 문자열(최대 16자리)이다. 표에 없는 인수, owner·세션·토큰·URL 인수는 거절한다.

| 도구 | 인수 | 반환 범위 |
| --- | --- | --- |
| `alms_get_capabilities` | 없음 | 학교 기능 지원 상태와 MCP의 별도 읽기 정책. 대상별 권한 성공은 의미하지 않음 |
| `alms_list_terms` | `limit?` | 학교가 반환한 학기 목록. 달력상 현재 학기를 추정하지 않음 |
| `alms_list_courses` | `termId?`, `limit?` | 본인 강좌 목록과 선택된 학기 |
| `alms_get_course` | `courseId`, `weekId?`, `limit?` | 주차·활동 metadata. limit은 반환할 모든 주차의 활동 합계에 적용 |
| `alms_get_activity` | `courseId`, `activityId`, `maxTextChars?` | 활동 본문 텍스트·학습 metadata. 파일·영상 bytes나 viewer URL 없음 |
| `alms_list_assignments` | `courseId`, `limit?` | 학교 과제 목록. 제출·학습 완료는 별도 값 |
| `alms_get_assignment` | `courseId`, `assignmentId`, `maxTextChars?` | 과제 설명·제출 현황·평가·첨부 metadata. 업로드·재확인·제출 없음 |
| `alms_list_tasks` | `courseId?`, `limit?` | 본인 학교 TODO와 개인 완료값. 목록에 없다는 사실은 제출 증거가 아님 |
| `alms_get_calendar` | `start`, `end`, `courseId?`, `limit?` | Asia/Seoul 날짜의 `[start,end)` 학교 일정·본인 제출/개인 완료값. 최대 31일 |
| `alms_get_timetable` | `limit?` | 본인 시간표와 검증한 강좌 관계 |
| `alms_get_attendance` | `courseId?`, `limit?` | 학교 차시 출결. 영상 진도·개별 출석·인정값과 구분 |
| `alms_get_learning_status` | `courseId`, `activityId` | 해당 활동의 fresh 학교 진도·근거. 재생·보고·완료 변경 없음 |

`limit`은 기본 50, 1–200이다. `maxTextChars`는 기본 10,000, 100–30,000이며 텍스트를 자르면 `meta.textTruncated`로 표시한다. 목록 cap은 응답 크기 제한이지 cursor pagination이 아니다. 다음 페이지 cursor를 제공한다고 가정하지 않는다.

현재는 **tools만 제공**한다. MCP resources·prompts, 첨부 파일/PDF/영상 bytes, 자료 텍스트 추출·검색·임베딩, 새 학교 로그인 실행, 학교 수강·과제 제출·개인 완료 변경 도구는 제공하지 않는다. 미지원 자료를 원문 URL로 대신 열거나 학교 쓰기 경로를 자동 호출하지 않는다.

## 결과·지원 상태·오류

성공 결과는 `structuredContent`에 `{data,meta}`를 넣고 같은 JSON을 `content`의 text에도 제공한다. Adapter는 학교 응답을 기존 공유 HTTP schema로 검증하고 문서화된 필드만 투영한다. 각 도구는 `src/mcp-tools/output-schema.ts`의 구체적인 data/meta/error 출력 schema를 제공한다. URL·바이트·재생 제어를 제외한 공유 HTTP 모델의 투영과 목록 상한·잘림 관계를 명시한다. 정상·오류 합성 응답은 AJV로 대조하며 원본 REST 응답 전체를 그대로 제공하지 않는다.

`meta`는 `source: school|ALMS`, `schoolRecordWrites:false`, `textTruncated`와 목록의 `limit`, `returnedCount`, `hasMore`, `truncated`, `complete`를 포함할 수 있다. `complete:null`은 전체성 미확인이다. cap을 적용하면 `complete:false`이며, 잘린 결과를 전체 결과로 표현하지 않는다. `featureSupport`의 미지원·권한·비활성 이유를 빈 목록과 구분한다.

다음 상태는 서로 다르다.

- 학교 제출 상태·제출시각·시도와 개인 학습 완료 override
- 개별 영상 progress/completed/raw attendance와 차시 전체 attendance/recognized
- MCP 토큰 만료와 학교 인증 만료
- ALMS 과거 미확정 작업과 현재 학교 제출 상태

### 전송·인증 오류

| 응답 | 의미 |
| --- | --- |
| HTTP 401 + Bearer `WWW-Authenticate` | MCP 승인이 없거나 토큰·grant·승인한 ALMS 세션이 무효. 리소스 메타데이터 URL과 `alms:read` 안내 |
| HTTP 403 + `insufficient_scope` | 유효한 MCP 주체에 읽기 scope 부족 |
| HTTP 403 `MCP_ORIGIN_INVALID` | Host 또는 보낸 Origin 불일치. 권한 추가로 해결할 문제가 아님 |
| HTTP 413 | 32 KiB 요청 본문 제한 초과 |
| HTTP 429 `MCP_BUSY` 또는 전역 rate-limit | 동시 요청 또는 호출량 한도 |
| JSON-RPC 오류 / SDK `isError` 결과 | 존재하지 않는 도구·잘못된 protocol/인수 schema. HTTP 200만으로 성공 판정 금지 |

Adapter 실행 오류는 `isError:true`, `structuredContent.error={code,message,schoolReauthenticationRequired}`로 반환한다. 학교 원문 오류·SQL·토큰을 전달하지 않는다. 주요 code는 다음과 같다.

- `SCHOOL_AUTH_REQUIRED`, `SCHOOL_AUTH_FAILED`: 학교 인증 갱신 필요. MCP 재동의 성공과 구분한다.
- `SCHOOL_SESSION_CHANGED`: 학교 세대가 바뀌어 다시 읽어야 함.
- `MCP_INVALID_ARGUMENTS`, `NOT_FOUND`: 인수 또는 정확한 대상 관계 오류.
- `MCP_FEATURE_UNAVAILABLE`, `SCHOOL_PROVIDER_UNAVAILABLE`, `MCP_RESOURCE_UNSUPPORTED`: 미지원 기능·자료.
- `MCP_SOURCE_INVALID`: 공유 schema 또는 요청 대상과 학교 응답 불일치.
- `MCP_RESPONSE_TOO_LARGE`: 강좌·주차·기간·limit을 좁혀야 함.
- `MCP_TIMEOUT`, `MCP_CANCELLED`, `MCP_BUSY`: 시간·취소·동시성 제한.
- `SCHOOL_UPSTREAM_UNAVAILABLE`, `RATE_LIMITED`, `MCP_READ_FAILED`: 학교 지연·호출량 또는 정규화된 조회 실패.

MCP 응답에 있는 강의·과제 문장은 조회한 **사용자 데이터**다. 그 문장을 시스템 지시나 도구 실행 승인으로 취급하지 않는다.

## 제한과 운영 준비 조건

- 요청 본문 32 KiB, 도구 인수 최대 256개 요소, 도구 결과 JSON 96 KiB, 검증 전 학교 source JSON 4 MiB. 요소 수는 SDK가 중첩 값을 포함해 검사하며 schema 검증 전에 초과 입력을 거절한다. 바이트 제한 안에 드는 넓은 입력도 허용하지 않는다.
- `/mcp` 동시 HTTP 처리 최대 32개. 도구 실행은 사용자당 1개, 프로세스당 최대 100개 슬롯이다.
- 도구 조회 기한 30초, 전송 처리에는 35초 취소 신호를 둔다. 중단할 수 없는 기존 학교 조회는 실제로 종료될 때까지 사용자 슬롯을 유지한다. timeout을 성공으로 바꾸거나 자동 무한 재시도하지 않는다.
- route rate-limit은 분당 120개 설정이며 기존 Fastify rate-limit plugin과 배포 구성을 전제로 한다. 실제 ingress와 합산된 사용자 체감 한도는 운영 QA로 확인한다.
- `MCP_ENABLED=true`, 기존 32-byte `SESSION_ENCRYPTION_KEY`, 영속 `MCP_SIGNING_JWKS_JSON`·`MCP_COOKIE_KEYS_JSON`과 migration 015가 필요하다. 키가 없을 때 임시 키를 만들어 활성화하지 않는다.
- OAuth object는 PG에 암호화하고 lookup ID·nonce·grant 관계는 hash로 저장한다. 기존 학교 credential을 클라이언트에 내보내지 않는다.
- 운영 활성화 전 PG 실제 code·refresh·replay·revoke·로그아웃 검증, 기존 데이터 보존 배포, 실제 Codex OAuth·도구 호출, 학교 읽기 QA가 필요하다. 이 문서로 완료 처리하지 않는다.

## 검증 참고

- [전송 회귀](../test/mcp-routes.test.ts): 실제 localhost Fastify HTTP + 합성 주체/도구. protocol 3종·no-store·body bound·owner 격리·scope/revocation·Origin/Host·변경 도구 차단·disconnect·동시성 복구.
- [읽기 도구 회귀](../test/mcp-tools.test.ts): 공유 schema·소유권·출력 cap·기능 지원·학교 쓰기 경로 부재.
- [OAuth 단위 회귀](../test/mcp-auth.test.ts)와 [PG 통합 회귀](../test/integration/mcp-auth.test.ts): 현재 체크아웃에서 실행하고 결과를 확인한다.
- 공식 기준: [MCP 인증](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), [SDK의 legacy 지원](https://ts.sdk.modelcontextprotocol.io/v2/serving/legacy-clients), [oidc-provider 9.12.2 문서](https://github.com/panva/node-oidc-provider/blob/v9.12.2/docs/README.md), [공식 Codex MCP 문서](https://learn.chatgpt.com/docs/extend/mcp?surface=cli). 클라이언트 버전별 차이는 해당 버전의 설정과 실제 연결로 확인한다.
