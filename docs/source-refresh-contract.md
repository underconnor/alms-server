# 목록·주차의 학교 원본 재검증

이 문서는 현재 소스의 읽기 계약이다. 운영 배포와 실제 학교 계정의 지연시간·응답 성공은 별도로 확인한다.

## 지원 요청

아래 metadata GET은 선택적 `refresh=1` 또는 `refresh=resource`를 받는다.

- `/v1/courses/:id`
- `/v1/courses/:id/assignments`
- `/v1/courses/:id/assignments/:assignmentId`
- `/v1/tasks`
- `/v1/calendar?start=...&end=...&courseId=...`

일반 GET은 현재 세션과 학교 세대에 유효한 cache를 사용할 수 있다. `refresh=1`은 기존 과제·캘린더의 전체 catalog 재확인 의미를 유지한다. `refresh=resource`는 해당 학교 metadata를 재검증하면서 검증된 표시용 catalog의 재사용을 허용한다. 어느 모드도 사용자의 신원·학교 수강권한 검사를 대신하지 않으며, 다른 owner·학교 세대·캐시 전용 warmup과 섞지 않는다. 강좌/주차와 TODO의 명시적 재검증도 같은 계층을 통해 reader까지 전달된다.

구형 소비자의 기본 GET과 기존 `refresh=1`은 유지한다. 과제 이력·파일·계획서·자료 bytes의 별도 재조회는 현재 `refresh=1`만 받는다. 목록 새로고침을 위해 PDF·첨부·영상 bytes를 다시 내려받지 않는다.

`refresh`는 하나만 허용한다. 알 수 없는 값·중복 query·caller가 넣은 `userId`/학교 generation/임의 catalog는 거절한다. 기존 cookie 또는 등록 client Bearer·Origin·소유권 검사를 유지한다. 읽기 재검증은 학교 제출·학습 완료·진도 보고를 실행하지 않는다.

## 지원 발견

`GET /.well-known/alms-api`의 `http.freshness`는 다음 값을 광고한다.

```json
{
  "queryParameter": "refresh",
  "modes": ["1", "resource"],
  "resources": ["course", "assignments", "tasks", "calendar"]
}
```

이 값은 HTTP 요청 모드의 지원을 뜻한다. 현재 계정의 학교 인증·자료 권한과 각 feature availability는 실제 응답 및 `/v1/features`를 확인한다. Front는 광고를 확인하기 전에 새 query를 구형 배포에 보내지 않는다. MCP 토큰이나 scope를 일반 REST 읽기의 인증으로 사용하지 않는다.

## cache 일관성과 보호

성공한 metadata 재검증은 같은 owner·provider·학교 generation의 관련 metadata만 만료시킨다. 갱신한 본래 resource는 보존하고, 대상 강좌의 course/module 관계·과제 목록/상세 및 관련 TODO·캘린더 재확인을 준비한다. catalog·activity bytes·파일·syllabus·video·개인 완료·다른 강좌·다른 사용자의 값을 전체 삭제하지 않는다. 학교의 서로 다른 feed나 날짜 범위에 항목이 없다는 사실은 해당 항목의 삭제·완료 증명이 아니다.

호출자는 완료 전에 자신의 현재 ALMS 세션·학교 세대·권한을 검증한다. 취소·세션 만료·학교 로그인 교체가 발생한 응답을 새 결과로 발행하지 않는다. 정상적인 읽기 저장과 jar/cache 갱신은 학교 학습 기록 쓰기와 구분한다.

동일 owner·학교 generation·resource·갱신 정책의 진행 중 원본 조회만 합친다. 한 caller의 취소·만료는 다른 유효 caller의 요청을 취소하거나 로그인 만료로 바꾸지 않는다. 공유 작업은 90초, 프로세스 전체 128개·사용자당 8개·작업당 대기 caller 64개로 제한하고 초과하면 `429 SOURCE_REFRESH_BUSY`를 반환한다. 이전 로그인이나 이전 학교 jar에서 늦게 끝난 실패는 새 snapshot을 삭제하지 않는다. 캐시 삭제에는 generation과 현재 암호화 학교 상태의 원자적 조건을 함께 적용한다.

동등한 명시적 원본 조회만 사용자·학교 세대·resource·정책별로 합류한다. 각 호출자의 인증·취소를 따로 확인하며 한 호출자의 취소로 다른 호출자의 조회를 중단하지 않는다. 진행 중인 원본 조회는 사용자당 8개·프로세스 전체 128개, 같은 조회의 대기 호출자는 64개까지다. 초과하면 `429 SOURCE_REFRESH_BUSY`를 반환한다. 학교 읽기 예산은 90초이며 실패를 학교의 최신 확인 성공으로 표시하지 않는다.

실제 source 완료와 cache 화면 표시를 구분한다. UI는 기존 화면을 유지할 수 있지만 오래된 snapshot의 응답 시각을 새 학교 확인 시각으로 바꾸면 안 된다. 최신 확인 실패·부분 소스·미확인 module 관계를 그대로 표시한다. 새 과제 발견을 근거로 학교 제출 상태나 개인 완료를 추정하지 않는다.

## 검증

- `test/source-refresh-routes.test.ts`: 모드 전달·인증·중복/foreign query 거절·취소/로그아웃 경계·course adapter 전달.
- `test/source-refresh-cache.test.ts`: SQL selector bound와 사전 취소.
- `test/source-read-flight.test.ts`, `test/source-refresh-reader.test.ts`: 새 과제의 관련 목록 갱신, 공유 읽기·caller별 실패/취소와 이전 로그인 결과 격리.
- `test/integration/school-read-cache.test.ts`: 실제 PostgreSQL의 generation/owner/provider·제외 target·관련 resource 선택 삭제.
- `test/api-discovery.test.ts`, `test/http-openapi.test.ts`: discovery 광고·정적/런타임 명세 일치·전체 경로 대조.
