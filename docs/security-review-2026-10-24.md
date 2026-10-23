# MCP·Backend 범용성과 보안 검토 — 2026-10-24

검토 기준은 공개 저장소 `b94e56e`와 이 보고서를 포함하는 변경이다. **여러 프론트가 쓰는 SSU 전용 Backend 기반은 갖췄지만, 임의 MCP 클라이언트·큰 목록·모든 운영 환경의 검증까지 완료한 상태는 아니다.** 타 학교 지원은 범위에 포함하지 않는다.

이전 공개 전환의 비밀 검사와 Codex OAuth/7개 조회 표본은 유효한 별도 근거다. 그것을 포괄적인 보안 감사나 모든 클라이언트 호환 결과로 확대하지 않는다. 이번에는 소스 감사, 현재 의존성 advisory, 합성 실패 검사, 최신 공식 규격을 추가 대조했다.

## 적용한 검토 방법

- OpenAI 공식 `security-best-practices`, `security-threat-model` 스킬을 설치·읽고 적용했다. 설치 출처는 [openai/skills](https://github.com/openai/skills/tree/main/skills/.curated)다. Fastify 전용 참고 파일이 없어 서버 검토는 [Fastify 공식 문서](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)와 실제 구현을 사용했다. HTML 동의 화면에는 일반 JavaScript 웹 보안 참고를 적용했다.
- OAuth·사용자 격리, API 범용성, 공급망·CI를 독립 검토했다. 자동 스캐너는 `npm audit`이며, 공식 advisory의 영향 조건을 코드와 대조했다. 모든 소스 취약점이나 컨테이너 OS 취약점을 이 스캐너가 검출한다는 뜻은 아니다.
- 사용자와 이미 정한 맥락을 사용했다: 공개 HTTPS 서비스, 운영자 소유 Docker 서버, 초대한 사용자의 학교 데이터, SSU 전용 연동, 조회 전용 MCP, 사용자별 권한. 학교 비밀번호를 수집하는 설계로 바꾸지 않는다.
- [MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28), [MCP 인증](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), [보안 권고](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices), [OAuth 보안 BCP RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html), [OWASP API Security](https://api-security.owasp.org/editions/2023/en/0x11-t10/)를 기준으로 했다.

## 발견과 이번 수정

| ID | 구분 | 확인한 사실과 영향 | 조치 |
| --- | --- | --- | --- |
| SEC-01 | 의존성 중간 | 잠긴 `ip-address` 10.7.2는 [GHSA-rxp7-6hxx-x8q5](https://github.com/beaugunderson/ip-address/security/advisories/GHSA-rxp7-6hxx-x8q5) 대상이다. 긴 문자열 처리 비용 문제다. 현재 rate-limit 경로는 `net.isIPv6` 검사와 `trustProxy:false`를 거쳐 외부 임의 문자열의 직접 도달은 입증하지 않았다. | 10.7.4로 lock 갱신. |
| SEC-02 | 의존성 낮음 | Fastify 5.12.5는 [GHSA-389g-gv7q-r4x8](https://github.com/fastify/fastify/security/advisories/GHSA-389g-gv7q-r4x8) 대상이다. 현재 소스에서 해당 header `propertyNames` 권한 검사 패턴은 확인하지 못했다. | 5.12.7로 패치. |
| SEC-03 | 방어 보완 | `src/mcp-routes.ts:61`에서 SDK 입력 요소 상한을 설정하지 않았다. [GHSA-46jr-4wx8-v453](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-46jr-4wx8-v453)의 방어는 업그레이드만으로 켜지지 않는다. 기존 32KiB·동시 32개·엄격한 scalar schema가 위험을 줄인다. ALMS 메모리 고갈을 재현했다는 주장은 아니다. | `maxToolInputElements:256` 적용. 바이트 한도 이내의 넓은 입력이 validator/provider 전에 거절되는 것을 2025/2026 전송으로 검사. |
| GEN-01 | 배포 호환성 | `src/contracts/http-openapi.ts:409`의 고정 서버 주소 때문에 다른 도메인에서 받은 명세도 원 배포로 요청할 수 있었다. | 서버 URL을 상대 `/`로 변경. 명세를 받은 API Origin을 사용하며, 파일 기반 codegen 사용자는 본인의 base URL을 지정한다. |
| SEC-04 | 공급망 관리 | CI가 알려진 의존성 취약점을 차단하지 않았고 Actions가 움직이는 태그를 참조했다. | 중간 이상 audit 실패를 CI에 반영. 검증한 Actions commit SHA 고정, checkout credential 잔류 방지, npm/Actions 주간 Dependabot PR 설정. 자동 병합은 설정하지 않음. |

`package.json`과 lock의 의존성 변경은 Fastify 및 `ip-address` 두 resolved 패키지에 한정한다. 패키지 스크립트를 비활성화해 로컬에 설치했다. advisory 등급과 이 애플리케이션에서 입증한 공격 가능성을 구분한다.

## 확인한 보호

| 경계 | 코드 근거 | 확인 내용 |
| --- | --- | --- |
| REST 프론트 | `src/frontend-clients.ts:40`, `src/auth.ts` | 등록 client별 Origin·복귀 주소·cookie/bearer 구분, 다른 site는 S256 PKCE. 임의 return URL을 사용하지 않음. |
| MCP 권한 | `src/mcp-auth/index.ts:57`, `src/mcp-auth/repository.ts` | 별도 OAuth, 정확한 resource/audience·scope·client, 승인한 원래 ALMS 세션·owner 재검증, 회전 refresh 및 폐기. |
| 동의 화면 | `src/mcp-auth/index.ts`, `src/mcp-auth/html.ts`, `src/mcp-auth/handoff.ts` | 정확한 Origin·CSRF·단회 nonce, 안전한 HTML escaping과 같은 Origin resume 제한. |
| 전송 격리 | `src/mcp-routes.ts:60` | 요청마다 새 server factory. [cross-client advisory](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-jm63-cq47-j5jp)의 공유 instance 패턴을 쓰지 않음. |
| 자원·취소 | `src/mcp-routes.ts:34`, `src/mcp-tools/index.ts:112` | 본문/동시 요청/시간/응답 크기 제한, 사용자별 동시 조회 제한, disconnect 전달. |
| 학교 데이터 | `src/mcp-tools/validation.ts:22`, `src/mcp-tools/index.ts:104` | 공유 schema 검증·필드 투영, URL·bytes·학교 쓰기 제외. 도구 인수로 owner/토큰/임의 URL을 받지 않음. |
| 실행 환경 | `compose.yaml`, `Dockerfile.playback` | API/worker 분리, 비 root 사용자, read-only FS, cap drop, no-new-privileges, CPU·메모리·PID 제한. 현재 운영 설정의 동등성은 이번에 재실측하지 않음. |

SDK server 2.3.1/node 2.1.1은 검토한 cross-client·body-size advisory의 패치 범위다. [audience advisory](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-rvq5-wwqv-78pq)의 helper에만 의존하지 않고 자체 토큰 대상을 확인한다. 최신 라이브러리를 쓴다는 사실만으로 안전을 판단하지 않는다.

## 아직 부족한 범용성과 운영 검증

| 우선순위 | 항목 | 현재 제약 / 다음 완료 조건 |
| --- | --- | --- |
| P1 | 초대 전용 가입 정책 | `src/auth.ts:187`→`src/store.ts:153`은 검증된 새 학교 신원으로 사용자·세션을 만든다. 앱 내 초대 allowlist가 없다. 외부 ingress 제한은 이번에 확인하지 않았으므로 노출 우회로 단정하지 않는다. 초대 전용 운영에는 가입 전 허용 검사와 미초대 사용자 차단 QA가 필요하다. |
| P1 | 여러 MCP 클라이언트 | `src/mcp-config.ts`, `src/mcp-auth/index.ts:41`에서 `alms-codex` 하나와 native callback만 허용한다. 운영자가 등록한 client별 redirect·종류·scope·폐기를 설정으로 관리하고 두 번째 클라이언트를 실제 검증해야 한다. |
| P1 | 목록 이어 읽기 | `src/mcp-tools/index.ts:130`은 최대 200개를 자르고 알리지만 cursor가 없다. 사용자·필터·스냅샷에 묶인 페이지 토큰과 순서/만료 계약이 필요하다. |
| P1 | 실제 보안 생명주기 | 다른 계정의 격리, 운영 refresh 회전/replay/폐기, 탈퇴·접근권 상실의 자료 삭제 전파를 검증해야 한다. 현재 합성/DB 검사와 실제 Codex 한 계정 표본은 구분한다. |
| P2 | 브라우저 MCP·호스팅 AI | OAuth public native client 외의 흐름은 미지원. REST CORS 허용을 MCP OAuth 등록으로 간주하면 안 된다. Browser MCP 헤더·challenge 노출, 기밀 client 또는 CIMD 신뢰 정책은 별도 설계·검증 대상이다. |
| P2 | 공개 프론트 HTTP client | REST 계약은 공개지만 `@alms/http-client` 배포 소스는 이 저장소에 없다. 공개 패키지·버전 호환 정책과 예제 프론트가 필요하다. 학교 SDK는 이를 대체하지 않는다. |
| P2 | 운영·공급망 | 컨테이너 OS/브라우저 이미지 CVE, digest 고정과 갱신 절차, 백업 복원, 키 회전, 공유 rate-limit의 ingress 동작을 후속 검증한다. |

## 최신 방향을 적용하는 기준

현재는 stateless 요청과 구체적인 입출력 schema·구조화 오류·최소 scope를 유지하는 것이 적합하다. 최신 규격에서 CIMD를 권장하더라도, 무제한 URL 조회와 동적 등록을 바로 켜면 SSRF·클라이언트 사칭 검토 범위가 늘어난다. 먼저 운영자 등록 client 설정과 실제 두 번째 클라이언트 검증을 진행한다. DCR, MCP Apps, Tasks, prompts/resources는 사용 사례가 확정된 뒤 추가한다. 이 기능들이 없다는 사실 자체는 취약점이 아니다.

학교 본문은 신뢰할 수 없는 데이터다. 서버의 안내와 조회 전용 권한은 위험을 줄이지만 외부 AI 클라이언트의 prompt injection 방어를 대신하지 않는다. 클라이언트의 다른 도구와 결합되는 데이터 유출까지 이번 서버 감사로 보증하지 않는다.

## 검증 결과

- 로컬 `npm run check`: TypeScript 빌드와 934개 검사 통과, 실패·skip 0.
- 독립 OAuth·설정·동의·복귀 검사 15개 통과. 첫 실행의 모듈 누락은 병행 의존성 설치 중 발생했으며 설치 완료 후 재실행 결과와 구분한다.
- MCP 실제 로컬 HTTP 검사 15개 통과. 두 프로토콜의 입력 요소 초과 거절과 provider 호출 0을 포함한다. 실제 학교 응답은 사용하지 않았다.
- OpenAPI·discovery 검사 11개 통과. 생성 명세는 `servers`만 바뀌었고 경로·schema는 유지했다.
- 합성 201개 과제 중 200개만 반복 반환되고 cursor가 거절되는 한계를 재현했다. `hasMore:true, complete:false` 표시는 유지한다.
- `npm audit` 전체·운영 모두 낮음 1/중간 1에서 0으로 감소, exit 0. 알려진 lock 의존성 결과이며 번들 내부·OS·Chromium 전체의 무취약 판정이 아니다.
- 로컬 Docker daemon이 없어 이미지 스캔과 로컬 PostgreSQL 통합은 실행하지 않았다. CI의 PostgreSQL·Compose·기본 Docker 이미지 결과는 해당 PR에서 확인한다. 현재 CI는 `Dockerfile.playback`의 Chromium 포함 API/worker target을 빌드하지 않으며 Compose 설정만 검증한다.
- 이번 검토의 운영 재시작·학교 로그인·학교 기록 쓰기·기존 과제 변경은 0회다.

배포 상태는 이 변경의 PR/릴리스를 따른다. 소스 수정·합성 HTTP·단위·DB 검증을 운영 배포나 새 학교 로그인 성공으로 표현하지 않는다. 상세 자산/경계/잔여 위험은 [위협 모델](alms-server-threat-model.md)에 기록한다.
