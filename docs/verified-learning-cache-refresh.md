# 명시적 학교 결과 재확인과 캐시 갱신

## 변경

기존 `GET /v1/jobs/:id/verify`와 `GET /v1/courses/:id/activities/:activityId/learning-status`는 학교의 새 결과를 카드에 반환했지만, 별도 강좌·활동·출석·할 일 캐시는 정리하지 않았다. 작업 목록/상세의 terminal 결과 갱신과 별개로 두 명시적 읽기의 성공 뒤 캐시 정리를 연결한다.

현재 사용자의 fresh 학교 신원·수강권한·활동을 확인한 원본 결과 객체에 내부 proof를 결합한다. proof는 사용자·학교 generation·정확한 강좌/활동·요청 AbortSignal·90초 만료를 포함한다. 객체의 복사본, 다른 사용자/대상/요청, 만료 또는 재사용은 삭제 전에 거절한다. proof는 한 번만 사용하며 공개 DTO·로그·DB에 넣지 않는다.

같은 사용자 lock 안에서 ALMS 신원 및 작업 snapshot을 확인한 뒤 학교 generation을 확인한다. 캐시 삭제 뒤 같은 순서로 재검증하며, 마지막 학교 generation 검사 뒤 추가 DB 대기를 두지 않는다. 기존 final session/job 검사와 소유권·오류 정책은 유지한다. 15초 캐시 작업 상한과 요청의 90초/DB 5초 상한은 각각 적용된다. 늦은 read-only 검증 또는 삭제의 완료를 성공 응답으로 바꾸지 않는다.

## 삭제 범위

기존 `progressCacheResources`의 정확한 합집합을 재사용한다.

- `course:<courseId>`
- `activity:<courseId>:<activityId>`
- `calendar-modules:<courseId>` (캘린더의 정확한 학습 완료 module proof)
- `tasks`
- `attendance`
- `attendance:<courseId>`

메모리와 기존 암호화된 durable cache에서 해당 사용자만 정리한다. 다른 강좌·활동·계정, 시간표, catalog, PDF/계획서/과제 첨부 및 영상 바이트를 지우지 않는다. 학교 결과가 `progressPercent:null`, `attendance:unknown`, `recognized:null`이어도 유효한 읽기라면 같은 갱신을 진행한다. 학교 완료·인정을 합성하지 않는다.

## 오류와 공개 계약

학교 읽기/응답 검증 또는 기존 ALMS/job 검증이 실패하면 cache hook을 호출하지 않는다. 캐시 정리 실패·상한 초과·요청 취소는 `SCHOOL_RESULT_UNAVAILABLE` 503이며, 신원/학교 세대/작업 변화는 기존 401/409 의미를 유지한다. 이전에 읽은 학교 결과를 성공 body에 넣지 않는다. hook은 사용자의 명시적 GET 한 번에 대해서만 실행하며 자동 재시도·작업 재개·종료/학교 인정 전이는 없다.

외부 HTTP 경로·쿼리·응답 shape·`stateChanged:false`·`recognized:null`을 유지한다. `refreshLearningStatus`는 서버 내부의 optional provider/reader hook이며, 구현하는 adapter는 전후 `options.validate`와 마지막 동일 학교 generation 검증을 수행해야 한다. 기존 cache hook 없는 합성/legacy provider의 읽기 호환은 유지한다.

## 검증 경계

새 SQL·migration·SDK·worker·학교 쓰기/보고·작업 쓰기·인증 권한·배포 설정 변경은 없다. **실행되는 durable cache 삭제는 DB 변경 작업**이다. 학교/job 기록 쓰기와 구분한다. 로컬 합성 검사와 기존 cache SQL의 격리 PG 검사는 실제 학교/운영 HTTP/브라우저/출석 QA와 별도다.

실제 인수는 동일 계정의 명시적 학교 결과 GET 성공 → Front의 정확한 JSON 캐시 정리/강좌·활동 재조회 → 진도·출석·할 일의 fresh 결과, 다른 강좌와 PDF/영상 읽던 위치 유지로 확인한다. 기존 완료 영상과 새로운 학교 인정, 단순 조회와 서버 재생 성공을 구분한다. 상위 BE-03/BE-04/QA Issue는 부분 구현으로 닫지 않는다.
