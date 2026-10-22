# 학교 학습 결과의 읽기 재검증

## 작업 없이 활동의 학교 결과 확인

`GET /v1/courses/:id/activities/:activityId/learning-status`는 확인한 숫자 강좌·모듈 활동의 학교 결과를 명시적으로 다시 읽는다. 응답은 `{courseId,activityId,schoolResult,stateChanged:false}`이며 아래의 동일한 `SchoolResult` 검증과 학교 신원·현재 수강권한·활동 결합·generation 검사를 사용한다. 작업을 생성하거나 학교 재생·진도 보고·출석 인정 쓰기를 하지 않는다. `recognized:null`은 미확정으로 표시한다.

HTTP 요청 시작부터 전체90초, 초기·최종 ALMS 세션 DB 조회 각각5초, 사용자별 동시1회와1분12회 제한을 적용한다. 동시 조회는409 `LEARNING_STATUS_BUSY`, 반복 제한은429다. query 인수는 받지 않으며 응답은 `no-store`다. 성공을 캐시하거나 요청을 자동 재시도하지 않는다. API 자체의 작업/학습 기록 쓰기는 없으며 정상 학교 세션 jar/catalog 갱신은 기존 reader 정책을 따른다. 이 경로는 기존 작업 재검증과 별도 호출 제한을 가진다.

실제 학교/운영 UI 검증은 배포 뒤 별도 근거로 기록한다. 읽기 endpoint의 존재만으로 학교 보고나 서버 재생의 성공을 판단하지 않는다.

`GET /v1/jobs/:id/verify`는 본인의 기존 작업에 연결된 활동을 학교에서 새로 읽는다. 응답은 `{job,schoolResult,stateChanged:false}`다. `job`은 기존 저장 상태이며 새 `schoolResult`와 구분한다. 이 요청은 작업의 상태·저장된 결과·오류 코드를 수정하지 않고 재생/진도 보고/자료 열람 보고를 시작하지 않는다. `needs_verification`을 `succeeded`로 바꾸지 않는다.

## 현재 결과의 의미

SDK의 `moduleLearningStatus(courseId,moduleItemId,signal)`는 native Canvas 본인 신원, 현재 학기 수강 목록, 해당 강좌 모듈의 실제 attendance item 연결, 상세를 새로 읽는다. `lectureId`는 확인한 moduleItemId와 연결하며 이름이나 과제 ID에서 추정하지 않는다. 현재 지원 대상은 Commons 영상·PDF·파일이다.

`SchoolResult`는 관찰시각·진도 비율·정규화한 출석·인정 여부를 유지한다. 새 선택 필드 `evidence`는 학교가 실제 반환한 공개/열림/출석대상/진도생략/완료 불리언, resourceType, 고정 학교 상태 enum, 영상 진도·마지막 위치·총 길이 초값을 담는다. ID·제목·URL·학번·본문은 evidence에 포함하지 않는다.

- 현재 `recognized`는 항상 `null`이다. 학교 완료 true, attendance 라벨, 95/100% 또는 플레이어 종료는 출석 인정의 명시적 근거가 아니다.
- `useAttendance:false`만 `attendance:not_applicable`이다. 다른 값은 unknown이다. 학교의 원래 attendance/absent/late/none/unknown 라벨은 evidence 안에서만 구분한다.
- 영상 초값과 비율은 기존에 확인한 학교 표시 계약이다. `min(100,progress/duration*100)`은 양의 길이와 진도 값이 있을 때만 계산하며 인정 조건이 아니다. PDF/파일의 진도 초·비율은 null이다.
- 실제0/false와 미제공 null을 구분한다. 근거와 비율·정규화 상태가 모순되거나 미검증 recognized 값이 들어오면 성공으로 투영하지 않는다.
- `observedAt`은 최종 SDK 읽기 완료 시각이며 학교 내부 변경 시각이나 학교 인프라 캐시의 갱신 시각을 뜻하지 않는다.

## 권한과 최종 응답

인증된 사용자로만 작업을 조회하며, 숫자 학교 강좌/모듈 ID가 없는 작업은 지원하지 않는다. ALMS 세션을 다시 확인하고 학교 세션의 generation과 현재 소유권을 검증한다. schoolResult와 catalog 캐시를 최종 결과에 사용하지 않으며 매번 새 학교 상태를 읽는다. 기존 사용자별 school jar lock/CAS는 유지한다. 읽기 뒤 정상 jar와 새 catalog는 기존 내부 정책으로 갱신될 수 있지만 학습 결과는 메모리·암호화 결과 캐시에 저장하지 않는다.

학교 조회 전후에 작업의 owner/id/course/lecture/status/createdAt/updatedAt를 비교한다. 최종 ALMS 세션 조회 도중 취소·복구가 일어날 수 있으므로 그 뒤에도 작업을 다시 비교한다. 달라졌거나 삭제됐으면409 `JOB_CHANGED`로 늦은 결과를 거절한다. 권한이 사라지면401이다. 조회 결과로 DB 상태 전이나 CAS 쓰기를 만들지 않는다.

## 시간 제한·중복·실패

이 경로만 요청 시작부터 인증 DB 조회·학교 세션/lock 대기·SDK·최종 확인까지 전체90초와 연결 취소 신호를 적용한다. HTTP 인증/작업/최종 ALMS DB 대기는 각각5초로 제한한다. 초기·최종 school jar 및 shared reader 내부 작업은 전체90초 취소에 포함되며, 실제 작업이 남아 있으면 기존 owner lock을 유지한다. SDK 자체는 전체60초·요청15초·응답2MiB·원문 총8MiB·최대5GET다. 자동 재시도는 없다.

동일 사용자의 동시 재검증은409 `JOB_VERIFICATION_BUSY`, 사용자당1분12회 초과는429다. 동시에 진행 중인 호출을 다른 세션에 공유하거나 이전 성공 응답을 재사용하지 않는다. 실패/시간 초과는503 또는 기존 학교 오류이며 빈 성공·미출석·미인정 false로 바꾸지 않는다. 응답은 `Cache-Control:no-store`다. 알 수 없는 원문 오류·학교 URL·계정 값을 로그에 추가하지 않는다.

## 검증 경계

합성 검사는 완료/진도/출석 라벨의 의미 분리, 누락/null/0, owner/generation/로그아웃, 두 번 조회의 캐시 비사용, 초기·최종 DB 대기, 동시·반복 요청, 취소·늦은 결과와 작업변경을 확인한다. exact SDK 연결·전체 회귀·독립 리뷰·CI·운영 배포·실제 학교 읽기 QA는 각각 별도 근거다.

검증은 [`test/learning-status.test.ts`](../test/learning-status.test.ts)와 [`test/learning-status-sdk.test.ts`](../test/learning-status-sdk.test.ts)에서 시작한다. 합성 학교 응답과 격리 DB 검사는 실제 학교 결과와 출석 인정의 근거를 대신하지 않는다.
