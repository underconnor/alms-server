# ALMS HTTP API 계약

이 문서가 최신 계약의 진입점이다. ALMS는 숭실대학교 전용 서비스다. 요청·응답·오류·경로·필수 헤더의 기계 명세는 [OpenAPI 3.1](openapi.json), 원본은 [`src/contracts/http-openapi.ts`](../src/contracts/http-openapi.ts)다. API도 공개 `GET /openapi.json`으로 같은 명세를 제공한다. 문서 생성과 전체 등록 경로 대조 검사는 코드와 함께 실행한다. 이 계약은 현재 소스의 동작을 설명한다. 실제 배포와 학교 계정의 동작은 별도로 검증해야 한다.

`GET /.well-known/alms-api`에서 HTTP 명세·기능 지원 조회·선택적 MCP의 경로와 실제 활성화 여부를 발견할 수 있다. 웹 프론트는 아래의 인증·전송 계약을 구현하는 HTTP 클라이언트를 사용한다. AI 클라이언트의 조회 전용 원격 연결은 [MCP 계약](mcp-contract.md)을 따른다. MCP의 별도 OAuth 권한은 웹 세션 토큰과 교환해 사용하는 범용 REST 토큰이 아니며 기존 Origin·CSRF·클라이언트 바인딩을 대체하지 않는다. MCP가 활성화된 배포의 `/oauth/*`, `/mcp`, OAuth discovery는 해당 프로토콜 계약으로 관리하고, OpenAPI 경로 대조는 기본 HTTP 서비스의 등록 경로를 검증한다.

## 주요 동작

과제 미확정 작업은 영수증이 없어도 `POST .../submissions/:operationId/reconcile`로 현재 본인 학교 제출을 새로 읽는다. `Operation.recovery.schoolObservation`은 `attribution:'unattributed'`인 현재 학교 상태이며 원래 ALMS 제출 성공과 구분한다. `POST .../:operationId/release {observedAt}`는 fresh 관측·세대/세션/claim CAS와 종료 근거를 검증해 차단만 명시적으로 정리한다. 원래 미확정 상태/오류/시각/영수증/idempotency는 유지하며 자동 재제출하지 않는다. [최신 과제 재확인·정리 계약](assignment-submission.md#영수증-없는-재확인과-명시적-작업-정리)을 따른다.

로컬 API 예시는 `http://localhost:4300`, 프론트 Origin 예시는 `http://localhost:5173`이다. `@alms/ssu-api`는 학교 서버의 SSO·LMS·u-SAINT 연동을 수행하는 서버용 SDK이며 브라우저에 학교 인증정보를 전달하지 않는다.

## 인증과 여러 프론트

`FRONTEND_CLIENTS_JSON`에 `id`, `authMode`, `origins`, `redirectUris`, `defaultRedirectUri`를 등록한다. `clientId`는 소문자 영숫자로 시작하는 영숫자·`_`·`-` 1–64자다. Origin은 정확한 Origin, 복귀 주소는 query가 없는 정확한 등록 URL이며 정적 `#/route`는 허용한다. `returnTo`는 구형 요청 호환으로만 허용하고 무시하므로 목적지를 바꾸지 못한다.

기존 `alms-web`은 `FRONTEND_ORIGIN`과 기존 허용 Origin에서 cookie 로그인을 유지한다. 사용자 세션 쿠키는 `__Host-alms_session`, `HttpOnly; Secure; SameSite=Lax; Path=/`이며 개발 HTTP만 `alms_session_dev`를 쓴다. 추가 cookie 프론트는 API와 같은 사이트여야 한다. `github.io` 등의 다른 사이트는 등록된 `bearer` 클라이언트로 로그인한다. public suffix와 private suffix를 포함해 사이트를 검증한다.

추가 cookie 클라이언트는 세션·로그인 binding 이름에 `_<clientId>`를 붙여 기존 프론트와 동시에 로그인해도 서로 덮어쓰지 않는다. `X-ALMS-Client-Id`로 해당 cookie를 선택하거나 native media의 정확한 등록 Origin으로 하나의 클라이언트를 선택한다. 여러 클라이언트가 같은 Origin에서 모호하면 거절하고 임의로 다른 세션을 선택하지 않는다. 로그아웃은 해당 클라이언트의 cookie와 세션만 폐기한다.

프론트의 HTTP 호출은 cookie 모드에서도 항상 자신의 `X-ALMS-Client-Id`를 보내는 것을 권장한다. 기본 프론트가 로그아웃한 뒤 다른 프론트의 cookie만 남아 있으면, 무헤더 요청은 그 cookie의 Origin 불일치로 `403 CLIENT_ORIGIN_INVALID`가 될 수 있다. `alms-web`을 명시하면 자신의 세션 부재인 `401 AUTH_REQUIRED`로 처리되고 다른 프론트의 세션은 유지된다. 헤더 없는 기존 요청과 native media의 Origin 선택은 계속 지원하며 OpenAPI의 헤더 필수 조건을 바꾸지 않는다.

Cookie 로그인은 `/v1/auth/start` 또는 `/v1/auth/login`에 선택적으로 `clientId`, `redirectUri`, `clientState`를 넣는다. Bearer 로그인은 위 값에 `codeChallenge`, `codeChallengeMethod=S256`을 추가하고 임의 43자 base64url `clientState`와 PKCE challenge를 필수로 보낸다. `redirectUri`를 생략하면 해당 클라이언트의 기본값을 사용한다. `/login`은 `{url}`, `/start`는 학교로 303 이동한다. 잘못된 등록 정보는 JSON 오류를 반환하며 검증된 시작 이후 실패는 시작한 프론트로 돌아간다.

학교 callback은 기존 단회 state·브라우저 binding·15분 기한·학교 신원 확인을 유지한다. HTTPS binding 쿠키 `__Host-alms_login`은 학교의 cross-site POST 반환을 위해 `SameSite=None; Secure`이며 ALMS 세션 쿠키와 다르다. 새 요청이 만들어져도 이전 요청의 수명을 연장하지 않는다. 실패 콜백은 저장된 허용 클라이언트·복귀 주소를 찾을 수 있을 때 그 프론트에 `reason`, 선택적 `clientId`, `clientState`를 반환한다. 허용 reason은 `login_expired`, `school_auth_failed`, `school_upstream_unavailable`다. 신뢰할 수 있는 저장 정보가 없는 callback은 기존 ALMS 로그인 화면으로 돌아간다.

Cookie callback의 정확한 동일 client·state·binding·학교 입력이 같은 프로세스에서 아직 처리 중이면 duplicate만 기존 결과를 최대 15초 기다린다. 최초 인증·발급 동작과 단회 SQL 검사는 유지한다. duplicate 대기 초과는 `SCHOOL_UPSTREAM_UNAVAILABLE`이며 완료 후 callback 재생은 계속 거절한다. [공유 범위·제한·검증](auth-inflight-callback.md)을 따른다. Bearer callback과 PKCE 교환은 이 공유에 참여하지 않는다.

Bearer 성공은 등록 URI의 fragment에 `code`, `clientId`, `clientState`를 붙여 반환한다. 학교 토큰과 ALMS 세션 토큰은 복귀 URL에 넣지 않는다. 원래 프론트는 `clientState`를 대조한 뒤 `POST /v1/auth/token`에 `{clientId,code,codeVerifier,redirectUri}`를 보낸다. 정확한 등록 `Origin`이 필요하고 Origin은 복귀 주소의 Origin과도 같아야 한다. 코드는 60초·단회이며 클라이언트·URI·S256 verifier에 묶인다. 응답은 `{accessToken,tokenType:'Bearer',expiresAt,csrfToken,user:{id,displayName}}`다. 이 경로는 세션 쿠키를 발급하지 않는다. 코드 교환을 자동 재시도하지 않는다.

다른 사이트의 bearer 로그인은 popup/별도 창으로 시작하고 원래 프론트의 메모리에 verifier를 유지하는 흐름을 사용한다. 결과를 전달할 때 popup·Origin·state를 대조하고 전달 뒤 URL의 code를 제거한다. `@alms/http-client`의 `beginBearerLogin()`과 `completeBearerLogin()`은 PKCE 생성·결과 검증·교환을 모은다. 토큰과 verifier를 localStorage·URL·분석 이벤트에 저장하지 않는다.

## 공통 전송과 오류

| 요청 | 요구 조건 |
| --- | --- |
| Cookie 조회 | `credentials: include`; 자신의 `X-ALMS-Client-Id` 사용 권장. 보낸 Origin/클라이언트 헤더는 등록값과 일치해야 함 |
| Bearer 조회 | `Authorization: Bearer …`, `X-ALMS-Client-Id`, 정확한 등록 `Origin`; `credentials: omit` |
| 인증된 쓰기 | 위 인증 + 정확한 `Origin` + `/v1/me` 또는 token 교환의 `X-CSRF-Token` |
| JSON | `Accept: application/json`; body가 있으면 `Content-Type: application/json` |
| 활동 상세 | 정확한 `Accept: application/json; alms-manual-video=untracked` |
| 작업 읽기·접수·취소·정리 | 정확한 `Accept: application/json; alms-playback=2`; playback 또는 학교 권한으로 접수된 작업에서 필수 |
| 과제 제출·수강 작업 접수 | UUID `Idempotency-Key`; 같은 키는 같은 입력에만 사용 |
| 파일 내용 업로드 | `Content-Type: application/octet-stream`; JSON 파일 예약에서 발급된 ID 사용 |

`@alms/http-client`의 `request<T>()`, `fetchBlob()`, `setSession()`, `clearSession()`은 인증·CSRF·Accept·구조화한 오류를 함께 처리한다. 같은 범위의 조회는 중복 요청을 합치며 각 소비자의 취소를 독립적으로 처리한다. 강제 갱신은 이전 응답을 최신값으로 덮어쓰지 못하게 한다. 기존 Front의 자원 캐시가 갱신을 관리하는 경로는 하위 클라이언트 중복 처리를 끈다. 쓰기는 자동 재시도하지 않는다.

프론트는 위 헤더와 세션 정책을 구현해야 한다. JSON 오류는 응답 본문을 검증해 처리하고, 파일 응답은 `Content-Type`·`Content-Disposition`을 확인한다. 자동 재시도로 학교 쓰기를 반복하지 않는다.

오류는 `{error:{code,message,requestId}}`다. `401 AUTH_REQUIRED`는 ALMS 세션, `401 SCHOOL_AUTH_REQUIRED`는 학교 인증 문제다. `403 CSRF_INVALID`는 쓰기 보호 실패, `403 CLIENT_ORIGIN_INVALID`는 클라이언트/Origin/인증 방식 불일치다. `409 SCHOOL_SESSION_CHANGED`는 다시 읽어야 하는 학교 인증 세대 변경이다. `message`를 상태 판단에 사용하지 않는다. 미지원 기능은 정상 빈 목록으로 오인하지 않게 지원 정보와 `503 …_UNAVAILABLE`를 함께 처리한다.

파일·PDF·MP4는 개인 바이트이며 `Cache-Control: private, no-store`, JSON은 `no-store`다. HEAD는 Fastify가 GET에서 자동 등록한 같은 인증/헤더의 무본문 응답이다. MP4는 단일 Range의 200/206과 잘못된 범위의 416을 지원한다. PDF/과제 파일은 Range를 지원하지 않는다. 원래 파일 이름은 `Content-Disposition`에서 읽는다. Native `<video>`는 사용자 정의 Authorization 헤더를 보낼 수 없으므로 같은 사이트 cookie 모드를 사용한다. Bearer 프론트는 인증된 `fetch`로 bytes/stream을 처리해야 하며 토큰을 미디어 URL에 넣는 경로는 제공하지 않는다.

과제 안내·본인 제출·과거 시도 첨부는 검증된 학교 응답의 파일명을 기존 `fileName`과 `Content-Disposition`으로 전달한다. 학교 헤더가 없거나 모호하면 기존 링크/첨부 메타정보를 사용한다. `filename*`의 UTF-8 이름을 우선하며 안전한 문자·240 UTF-16 길이 경계를 적용한다. 프론트는 해당 바이트와 파일명을 같은 개인 캐시 항목에 보관해야 한다. 일반 주차 PDF의 `material.pdf`와 계획서의 `강의계획서.pdf` 같은 서비스 fallback은 원본 파일명 근거가 아니므로 기존 강좌·자료 문맥 이름을 유지한다. 파일명은 소유권·제출 확인의 근거가 아니다.

## 기능 지원 계약

`GET /v1/features`는 학교 조회 없이 `{features}`를 반환한다. `/v1/me.featureSupport`에도 같은 서비스 정보를 제공하고 `/v1/me.client`는 `{id,authMode}`다. 강좌·대시보드·활동·과제·제출 조건의 `featureSupport`는 해당 범위의 실제 관측으로 더 구체적인 정보를 준다.

각 항목은 `{supported,availability,reason,scope,permissions:{read,write},constraints}`다. `supported`는 구현 여부, `availability`는 `available|unavailable|unknown`, permission의 `null`은 미확인이다. 서비스 수준의 지원이 해당 과제 제출 허용을 뜻하지 않는다. 고정 reason과 제출 modes·확장자·attempt·pledge·파일 개수/크기 제한은 OpenAPI `FeatureSupport`, `SubmissionConstraints`를 따른다.

공지와 퀴즈는 `supported:false`, `reason:'not_implemented'`다. 기존 빈 배열과 `availability:'unavailable'`은 호환을 위해 유지하므로 UI는 지원 정보를 먼저 읽어 ‘준비 중’ 등을 표시한다. 강좌 자료·과제 배열은 `scope:'module_collection'`의 주차 모듈 목록이다. 전체 과제 목록은 `/assignments`의 `complete:true`로 구분한다. 제출은 `/submission-options`의 최신 `featureSupport.assignment_submission.permissions.write`와 학교 조건을 사용한다.

## 수동 영상·학교 진도

학교가 canonical `readystream`으로 제공한 강좌 활동 목록은 `type:'video'`와 `resourceType:'readystream'`을 반환하고, TODO는 `type:'video'`와 정확한 본문 연결을 반환한다. `detailAvailable:true`는 본문·학교 메타 조회 지원이며 수동 보고 권한이 아니다. 선택한 상세와 수동 준비는 같은 소유자·학교 세대의 fresh 신원/수강·pureCanvas·정확한 발급 대상을 확인하고, 단일 story/video1 UPF와 content/duration/CDN 관계까지 검증한 경우에만 기존 `manualVideoAvailable`, `manualVideoReportAvailable`, `manualVideoProgressMode`를 사용한다. 미지원 manifest는 본문을 유지하고 수동 권한을 닫는다. `playbackAvailable:false`와 직접 서버 수강 admission 거절은 유지한다.

`LearningEvidence.resourceType`의 `readystream`은 조회한 duration/progress/lastPosition 초 값과 원본 학교 출결값을 보존한다. `recognized:null`과 공용 `attendance:'unknown'`은 원본 개별 영상의 `schoolAttendanceStatus`와 별개이며, 미디어 검증이나 로컬 재생 성공으로 인정값을 만들지 않는다. 기존 movie·PDF·과제 계약은 유지한다.

미디어 bytes 조회 자체는 진도를 보고하지 않는다. 실제 수동 수강은 별도 `/manual-playback`, `/observations`, `/reports`, `/stop` API를 사용하며 학교 진도 보고가 구현돼 있다. 이전 ‘수동 재생은 항상 보고 없음’ 설명은 현재 계약이 아니다. [현재 수동 영상 상세 계약](manual-video-contract.md)을 따른다.

수동 재생의 네 POST는 선택적 `X-ALMS-Trace-Id` 헤더를 지원한다. 요청마다 새로 생성한 소문자 UUID v4만 진단 상관값으로 기록하며 학교·사용자·playback 식별자나 인증값을 넣지 않는다. 없거나 잘못된 값은 진단에서 무시하고 기존 요청 처리를 유지한다. 수동 재생 route 진입·응답 완료·완료 전 연결 종료를 같은 상관값으로 기록한다. 전역 CORS·rate-limit에서 먼저 거절된 요청은 route 진입 기록이 없을 수 있으므로, 기록 부재만으로 서버 미도달을 단정하지 않는다. 전송 로그와 별도로 서비스가 검증한 보고의 event·ACK 여부·ready/closed 결과를 같은 임의 상관값으로 기록한다. 학교 결과·인정 여부는 fresh 학교 조회로 확인한다. 전송 완료 로그는 학교 ACK가 아니며 헤더로 인증·Origin·CSRF 보호를 대체하지 않는다. 요청별 진단을 추가해도 timeout·자동 재전송·학교 진도 조건은 바뀌지 않는다.

정상 1배속·탐색 없는 실제 화면 관측을 순서대로 보내고 `playing|update|unload|ended`를 보고한다. 학교 ACK와 `schoolResult`를 확인하며 불명확한 보고를 자동 재전송하지 않는다. `stop`은 로컬 종료이고 학교 ACK가 아니다. `manualVideoProgressMode:'untracked'`는 bytes 표현의 호환 필드이며 `manualVideoReportAvailable`와 progress lifetime 지원을 함께 확인한다. 이전 학기·종료 강좌의 수동 보고는 허용하지 않는다.

준비 응답이 선택적 `observationTiming:'client_monotonic_v1'`를 광고한 경우에만 관측 snapshot과 같은 시점의 `performance.now()`를 `observation.capturedAtMs`로 보낼 수 있다. 설치 SDK와 정확한 준비 driver가 모두 지원해야 광고하며, 첫 관측에서 고정한 timed/legacy 모드를 같은 lifetime에서 섞지 않는다. 이 값은 서버 시각·학교 누적 수강 시간·학교 인정값을 대체하지 않는다. 현재 세션·세대·nonce·sequence·임대·서버 freshness와 SDK 시간/진도 상한을 유지하며, 학교 새 시작 확인·보고/stop 요청에는 추가하지 않는다. 상세 계약과 검증 범위는 [수동 영상 계약](manual-video-contract.md)을 따른다. 고정 validation kind는 기존 선택 trace UUID와만 기록하고 관측 본문·position·사용자 정보는 로그에 추가하지 않는다.

`/playback-start-confirmations`의 영향 안내와 명시적 확인은 학교 진도 기록을 새로 시작하는 별도 동작이다. 작업 `completed/ended`는 실제 실행 종료이며 `recognized`, `attendance`는 fresh 학교 결과다. 개인 완료 override도 학교 결과와 별개다.

## 화면에서 독립적인 데이터

`GET /v1/todos`의 개인 TODO와 `GET /v1/jobs`의 수강 작업 목록은 기존 `items`에 `{complete,hasMore,limit}`를 추가한다. 개인 TODO는 최신 500개, 작업은 최신 200개를 유지하며 `createdAt` 내림차순 뒤 `id` 내림차순으로 같은 시각의 순서도 고정한다. 서버는 같은 소유자·선택한 `courseId` 범위에서 한 행을 추가 조회해 잘림을 확인한다. 항목이 정확히 상한만큼 있고 더 없으면 `complete:true,hasMore:false`, 초과하면 `complete:false,hasMore:true`다. `complete`는 목록의 완전성이며 개별 TODO 완료·수강 종료·학교 인정 상태가 아니다.

이 응답은 총개수나 다음 페이지를 추정하지 않는다. cursor·추가 페이지·새 필터는 아직 제공하지 않으며 `hasMore:true`인 목록을 전체 이력으로 해석하면 안 된다. 기존 소유권·인증·CSRF·수강 Accept 조건을 유지하고, 작업의 추가 확인용 행은 응답이나 결과 캐시 갱신에 포함하지 않는다. 학교의 `/v1/tasks` TODO와 전체 과제 `/assignments`의 기존 계약은 별개다.

대시보드 `currentActivityItems`는 현재 주차의 전체 활동이다. `weekId`, 상태 코드, 공개/완료 boolean, ISO 기한·열림 시각으로 새 프론트가 표시를 구성한다. `status.unlock:'elapsed'`는 시간이 지난 사실이며 학교 player가 열렸다는 판정이 아니다. `currentActivities`의 3개 요약은 기존 UI 호환 필드다. 현재 강좌의 `scheduleStartTime`, `scheduleEndTime`, `timeZone`을 사용하고 `scheduleLabel`은 기존 표시 문자열로만 다룬다.

분석 `ui_version`은 1–64자 `[A-Za-z0-9][A-Za-z0-9._-]*`이며 새 UI 릴리스를 구분한다. `clientId`는 인증 세션에서 서버가 넣고 body의 `client_id`를 받지 않는다. `/analytics/summary.frontends`는 `{clientId,uiVersion,count}`로 집계한다. 학교 사용자 정보나 원문은 분석 속성으로 보내지 않는다.

## 경로와 변경 이력

모든 데이터·바이트 경로는 [OpenAPI](openapi.json)에 있다. 경로 검사는 실제 Fastify 등록 경로와 method/path를 양방향 비교하고 wildcard OPTIONS만 CORS 인프라로 제외한다. 새 경로와 계약을 같은 변경에서 갱신한다.

[호환성 참고](http-contract-changelog.md) · [과제](assignments-contract.md) · [학습 결과](learning-verification-contract.md) · [개인 완료](personal-completion-contract.md).
