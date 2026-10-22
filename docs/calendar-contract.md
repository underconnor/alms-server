# 현재 학기 학교 캘린더 · 학습 완료 연결

## 개인 학습 완료와 학교 제출의 분리

학교 `userSubmitted: boolean|null`은 실제 본인 제출 관측을 그대로 유지한다. 정확한 학교 assignment ID와 유일한 주차 module relation을 확인한 과제에만 `moduleItemId`, `weekId`, `moduleCompleted: boolean|null`, `personalCompleted: boolean|null`을 추가한다. 일반 일정과 관계가 없거나 중복·명시 미공개인 과제에는 이 필드를 붙이지 않는다. 제목으로 연결하거나 완료된 과제를 pending TODO에서 찾지 않는다.

개인값은 매 API 조회에서 본인·강좌·활동별 PostgreSQL 값을 새로 읽는다. true와 false 모두 학교 기본값보다 우선하고, reset은 null이다. 학교 제출·출석·진도·작성 권한은 변경하지 않는다. Front 학습 완료 기본값은 개인 명시값이 없으면 학교 제출 true 또는 module 완료 true이며, 미확정 값은 그대로 남긴다.

학교 캘린더 캐시는 `calendar:v3:`의 최소 학교 DTO와 private generation만 보관한다. 개인값은 캐시에 넣지 않는다. 기존 warm course module proof를 재사용하고, cold module 조회는 해당 기간의 과제가 있고 본인 저장 override가 있는 강좌에만 순차 실행한다. 다른 강좌·전체 수강 목록의 modules/lessons/material/TODO를 추가 조회하지 않는다. 별도 `calendar-modules:<course>` 학교 proof는 30초 범위로 재사용한다. 재로그인으로 학교 proof가 지워져도 본인 override를 가지고 해당 강좌만 다시 매핑한다.

TODO도 같은 학교 proof를 재사용하며 cold 조회는 지원된 pending 항목과 본인 override가 있는 강좌만 수행한다. PDF 보고·명시적 학교 진도 확인·학교 작업 종료의 정확한 강좌 캐시 정리에 이 module proof도 포함한다. 다른 강좌·학교 캘린더 최소 DTO·파일 바이트는 유지한다. 실제 과제 제출 뒤에는 기존 강좌 무효화 경로가 학교 캘린더 DTO도 다시 읽게 한다.

override가 없고 warm module proof도 없는 과제는 학교 `userSubmitted`를 기본값으로 사용한다. 이때 실제 제출과 별개인 module 학습 완료를 추정하지 않는다. 정확한 관계가 모호하면 개인값을 붙이지 않으며 학교 제출 관측을 유지한다.

원본 provider DTO를 adapter와 reader의 일회용 private WeakMap proof에 연결한다. 최신 개인값 DB 조회 뒤 동일 ALMS 세션과 학교 seal을 한 SQL snapshot으로 검증하고 이후 비동기 권한 조회 없이 응답한다. DTO 복제·다른 소유자·proof 재사용·로그아웃·학교 generation 변경은 거절한다. 새로운 SDK·migration·학교 쓰기 API는 추가하지 않는다.

## 조회 캐시와 명시적 재조회

`GET /v1/calendar?start=...&end=...[&courseId=...][&refresh=1]`을 사용한다. refresh는 Backend 읽기 옵션이며 SDK의 기간 query에는 전달하지 않는다. 다른 값·중복 query는400이다.

동일 owner/generation/기간/필터의30초 메모리·암호화 영속 cache hit는 원래의 소유 catalog proof와 정확한 현재 학교 세션을 확인한 뒤 반환한다. 학교 profile/catalog/bootstrap을 매번 반복하지 않으며, 같은 요청이 동시에 들어오면 owner lock 안에서 첫 결과를 재사용한다. cache hit는 원래 만료 시각을 늘리지 않는다. 결과가 없거나 만료됐거나 명시적 `refresh=1`이면 기존 native 신원·현재 수강권한·전체 학교 일정 조회를 새로 수행한다.

## 입력과 응답

- `start`, `end`: `YYYY-MM-DD`, 실제 존재하는 날짜, 2000~2100년, 1~31일 범위. `Asia/Seoul` 자정 기준 시작 포함·끝 제외다. Front는 월 시작과 다음 월 시작을 보낸다.
- `courseId`: 선택적인 숫자 강좌 ID. 현재 학기에 소유하지 않은 명시 필터는 404다. 호출자가 사용자 ID, 임의 URL, 페이지 토큰을 제공할 수 없다. 중복·알 수 없는 query도 400이다.
- `courses`: 필터와 관계없이 현재 학기의 전체 수강 강좌 `{id,title}`.
- `items`: `{id,type,courseId,title,startsAt,endsAt,allDay,allDayDate,dueAt,assignmentId,sourceUrl}`. `type`은 `event|assignment`다. 시간은 SDK가 UTC ISO로 정규화하며, `allDayDate`는 학교 날짜 문자열을 그대로 둔다. 종일 과제도 실제 `dueAt`을 보존한다.
- `sourceUrl`은 학교가 반환한 동일 강좌·과제의 query 없는 Canvas 과제 주소만 허용한다. 이벤트의 query 기반 주소는 `null`이다. `assignmentId`를 LearningX moduleItemId로 추정하지 않는다.
- 응답 전체는 `{start,end,timeZone:'Asia/Seoul',courses,items,complete:true}`다. 설명 HTML/본문·장소·학생 식별자·원본 query·쿠키·토큰·제출/출석 상태를 응답 또는 캘린더 캐시에 추가하지 않는다.

SDK는 시간 일정의 구간이 요청 구간과 겹치는지 확인한다. 시작과 끝이 같은 마감은 해당 시점으로 분류한다. 끝 경계의 일정과 그 경계에서 끝난 이전 일정은 제외한다. 종일 일정은 학교가 발급한 `allDayDate` 기준으로 포함 여부를 판단한다. 실제 관찰하지 않은 종일 복수일 범위를 임의로 확장하지 않는다.

## 인증, 요청과 상한

Backend는 ALMS 세션과 암호화된 학교 로그인 generation을 검사한다. 각 캘린더 요청과 캐시 hit에서도 LearningX 신원과 현재 default 학기의 수강 목록을 다시 확인한다. 새 SDK 조회는 native Canvas profile의 ID/login을 현재 LearningX 신원과 대조한 후 현재 학기 강좌를 다시 읽으며, 두 수강 목록이 다르면 성공 응답을 보류한다.

SDK는 학교 GET만 사용한다. 현재 학기 강좌 최대100개, context10개 단위, event/assignment 각각 per_page50·최대10페이지, 전체 요청100회·원문8MiB·일정2000개를 넘으면 오류다. 학교 `Link rel=next`의 다음 페이지 토큰만 따라가며 출처·경로·기간·유형·강좌 context·per_page를 바꿀 수 없다. 학교 응답 전체가 끝나기 전에는 `complete:true`를 반환하지 않는다.

Backend 전체 대기와 최종 세션 재확인은 90초 상한이며, 소유자 lock 대기도 취소할 수 있다. SDK 캘린더 요청은 전체60초, 요청당15초, 응답당2MiB다. 브라우저 연결이 끊어지거나 시간이 만료되면 다음 학교 요청과 응답 발행을 중단한다. 현재 실행 중인 소유자 lock은 실제 작업이 끝날 때까지 유지해 학교 cookie jar 갱신을 병렬로 덮지 않는다. 각 요청은 독립적인 취소 신호를 쓴다.

## 캐시와 오류

현재의 AES-256-GCM 학교 JSON 캐시를 사용자/provider/generation/기간/강좌필터로 구분해 30초 보관한다. 기존 항목·사용자·전체 용량 제한을 그대로 적용한다. DTO는 기존 캐시 항목 상한인 1MiB 이하만 반환·저장하고, 캐시 재사용이 최초 만료 시각을 연장하지 않는다. 수강 목록이 달라지면 캐시를 버리고 새 조회를 수행한다. 로그인 변경·로그아웃·기존 전체 무효화 동작을 유지하며, 학교 jar는 기존 CAS로만 저장한다. DB migration은 없다.

- 200·빈 `items`: 전체 조회와 소유권 검증을 마친 실제 빈 기간.
- 401 `AUTH_REQUIRED`: ALMS 또는 학교 인증/신원을 확인하지 못함.
- 404 `NOT_FOUND`: 명시한 강좌가 현재 수강 목록에 없음.
- 409 `SCHOOL_SESSION_CHANGED`: 조회 중 학교 세션이 바뀜.
- 502 `SCHOOL_UPSTREAM_UNAVAILABLE`: 학교 응답 실패·잘못된 형식·부분 조회 실패.
- 503 `SCHOOL_PROVIDER_UNAVAILABLE`: SDK의 상한 초과·지원하지 않는 범위. provider 없음/전체 취소는 `CALENDAR_UNAVAILABLE`.

실패나 잘린 결과를 빈 목록으로 표시하지 않는다. 개인 데이터 응답은 `Cache-Control: no-store`이며 기존 고정 route·status 로그를 유지한다. 필수 UX 수집은 8개 캘린더 행동 enum과 `load_calendar`의 소요 시간·정규화 오류만 추가하며, 월/일/강좌/일정 ID·제목·본문·URL을 수집 속성으로 보내지 않는다. 전달 worker의 projection 코드는 기존 c7과 동일하다.

## 본인 제출 완료 표시

SDK 0.3.20의 `userSubmitted: boolean|null`을 전달한다. true는 학교가 확인한 본인 제출, false는 제출 내역 없음, 누락/null은 미확인이다. 일반 일정의 값은 null이어야 한다. 제출 시각·채점·면제나 출석 인정으로 확장하지 않는다. 기존 native 신원·수강권한·세션 generation 검증은 유지하며 별도 학교 요청은 없다. 기존 메타가 빠진 캐시와 섞이지 않도록 `calendar:v2:` 키를 사용한다. TTL30초와 캐시 조회 시 최신 소유권 검증을 유지한다.
