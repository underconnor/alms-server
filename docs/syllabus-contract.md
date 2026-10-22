# 강의계획서 PDF

학교 뷰어의 메모리 PDF 내보내기 결과를 검증한 경우에만 내부 문서로 제공한다. SDK 준비 성공만으로 PDF를 성공 처리하지 않는다. 이 경로는 출석·진도·과제 제출 요청을 보내지 않는다.

## HTTP 계약

- `GET /v1/courses/:id/syllabus`: 강의계획서 metadata와 `documentVersion`, `sourceUrl:null`을 반환한다. `documentVersion`은 응답 시점 캐시 PDF bytes의 SHA-256이다.
- `GET /v1/courses/:id/syllabus/material[?refresh=1]`: 검증한 PDF bytes를 `application/pdf`, `private, no-store`로 반환한다. Range는 지원하지 않는다.
- 지원하지 않거나 준비·렌더가 실패한 경우를 빈 문서 성공으로 바꾸지 않는다.

metadata 뒤 다른 요청이 캐시를 갱신할 수 있으므로 Front는 실제 byte fingerprint로 문서와 읽기 위치를 구분해야 한다. 정확한 shape는 [OpenAPI](openapi.json)를 따른다.

## 소유권과 캐시

조회마다 학교 강좌 소유권을 확인한다. 캐시 key는 사용자·학교 generation·강좌다. TTL은 5분이며 문서당 16 MiB, 전체 64 MiB/128항목으로 제한한다. 준비 값은 영속 JSON 캐시에 넣지 않는다. 렌더 전후와 실행 중에도 ALMS 세션과 학교 generation을 확인한다.

전역 동시 렌더 1개, 사용자당 대기·실행 1개, 전역 대기 4개/20초다. 같은 문서 요청을 합치고, 명시적 refresh는 이전 작업 종료를 확인한 뒤 새 작업을 실행한다. 이전 요청의 늦은 실패나 결과가 새 세대의 캐시를 삭제하거나 덮어쓰지 않게 문서 객체·generation을 대조한다.

## 격리 렌더

요청마다 non-root·Chromium sandbox·loopback 관리 소켓을 쓰는 독립 프로세스를 만든다. 브라우저에 학교 쿠키·토큰을 넘기지 않는다. SDK가 검증한 launcher와 같은 준비 plan의 authcheck 응답만 제공한다.

정적 파일은 설치된 학교 뷰어 구조에 대한 exact allowlist로 제한한다. 보고서 읽기 POST는 인증 성공 뒤 허용된 보고서 목적지에서만 수행하며 body를 저장하지 않는다. 다른 문서 탐색·팝업·download·WebSocket·redirect·허용되지 않은 viewer 요청은 거부한다. TLS 검증과 목적지별 cookie 선택을 유지한다. 전체 정책은 [`src/syllabus-runtime.ts`](../src/syllabus-runtime.ts)를 따른다.

페이지 수만으로 렌더 완료를 판단하지 않는다. 반환 PDF의 구조와 페이지 정보를 [`src/syllabus-pdf-inspector.ts`](../src/syllabus-pdf-inspector.ts)에서 검사한다. 실패하면 문서 바이트를 반환하지 않는다.

## 환경과 검증

Compose의 API는 `Dockerfile.playback`의 `syllabus-api` target을 사용한다. non-root·sandbox·seccomp와 CPU·메모리·프로세스·공유메모리·tmpfs 제한을 유지한다.

[`test/syllabus-pdf.test.ts`](../test/syllabus-pdf.test.ts), [`test/syllabus-cache.test.ts`](../test/syllabus-cache.test.ts)와 [`scripts/syllabus-runtime-qa.mjs`](../scripts/syllabus-runtime-qa.mjs)는 합성 문서·전송 또는 격리 runtime을 검사한다. 실제 강의계획서의 취득·내용·표시는 권한 있는 학교 계정에서 별도로 확인해야 한다.
