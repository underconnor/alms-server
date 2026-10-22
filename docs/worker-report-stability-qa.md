# Worker 보고와 실제 결과 검증

Worker 프로세스 종료, 학교 보고의 전달·응답, 저장된 작업 결과, 새로 읽은 학교 진도·완료·출결을 따로 확인한다. HTTP 200이나 runtime ended만으로 출석 인정을 판단하지 않는다.

학교 읽기와 worker의 프로세스 내부 owner lock은 서로 다른 프로세스를 직렬화하지 않는다. 같은 학교 generation에서도 jar CAS가 실패할 수 있다. CAS 조건을 완화하거나 불명확한 보고를 자동 재전송하지 않는다.

## 자동 검사

[`test/playback-worker.test.ts`](../test/playback-worker.test.ts), [`test/school-playback.test.ts`](../test/school-playback.test.ts)와 [`test/playback-log-projection.test.ts`](../test/playback-log-projection.test.ts)는 worker 상태, 합성 학교 응답, 제한된 로그 투영을 검사한다. Docker의 합성 runtime 검사는 [런타임 계약](runtime-contract.md)을 따른다.

## 로그와 실제 QA

[`scripts/project-playback-logs.mjs`](../scripts/project-playback-logs.mjs)는 지정한 시간 범위의 API·worker 로그를 고정된 형태로 투영한다. 원본 로그는 공개하지 않는다. 같은 시간에 여러 작업이 존재할 수 있으므로 시간 근접만으로 특정 사용자·작업의 원인이나 ACK 횟수를 확정하지 않는다.

실제 검증은 승인한 계정과 활동에 대해 새 인증 반환, 정상 재생·종료, 취소·예약·세션 변경, fresh 학교 결과를 각각 확인한다. 학교 쓰기가 필요한 시나리오는 대상과 변경을 명시적으로 승인한 뒤 실행한다. 실패·미확정 상태를 성공으로 바꾸거나 기존 제출물을 QA용으로 변경하지 않는다.
