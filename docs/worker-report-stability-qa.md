# Worker 보고와 실제 결과 검증

Worker 프로세스 종료, 학교 보고의 전달·응답, 저장된 작업 결과, 새로 읽은 학교 진도·완료·출결을 따로 확인한다. HTTP 200이나 runtime ended만으로 출석 인정을 판단하지 않는다.

학교 jar를 갱신하는 API·worker adapter는 동일 사용자에 대한 PostgreSQL coordinator로 직렬화한다. 프로세스 내부 lock만 사용하는 주입 adapter에는 이 보장이 없다. 로그인에 따른 학교 generation 변경과 jar CAS 검사는 별도로 유지하며, 조정 실패나 보고 결과 미확정을 인증 만료로 단정하지 않는다. CAS 조건을 완화하거나 불명확한 보고를 자동 재전송하지 않는다.

## 자동 검사

[`test/playback-worker.test.ts`](../test/playback-worker.test.ts), [`test/school-playback.test.ts`](../test/school-playback.test.ts)와 [`test/playback-log-projection.test.ts`](../test/playback-log-projection.test.ts)는 worker 상태, 합성 학교 응답, 제한된 로그 투영을 검사한다. Docker의 합성 runtime 검사는 [런타임 계약](runtime-contract.md)을 따른다.

## 로그와 실제 QA

[`scripts/project-playback-logs.mjs`](../scripts/project-playback-logs.mjs)는 지정한 시간 범위의 API·worker 로그를 고정된 형태로 투영한다. 원본 로그는 공개하지 않는다. 같은 시간에 여러 작업이 존재할 수 있으므로 시간 근접만으로 특정 사용자·작업의 원인이나 ACK 횟수를 확정하지 않는다.

실제 검증은 승인한 계정과 활동에 대해 새 인증 반환, 정상 재생·종료, 취소·예약·세션 변경, fresh 학교 결과를 각각 확인한다. 학교 쓰기가 필요한 시나리오는 대상과 변경을 명시적으로 승인한 뒤 실행한다. 실패·미확정 상태를 성공으로 바꾸거나 기존 제출물을 QA용으로 변경하지 않는다.

## 전송·후속 조회·runtime 중단의 구분

SDK의 `refresh` 오류는 전송 후 권한 검사, fresh 학교 읽기, 후속 권한 검사를 포함한다. SDK는 전송 오류를 잡은 뒤에도 한 번 조회하므로, `refresh/upstream_unavailable`만으로 학교 거절이나 전송 ACK 유무를 판단할 수 없다.

Worker 실패 진단은 학교 URL·원문·토큰·학생·작업 식별자 대신 아래의 고정 값만 보존한다. 이 값은 HTTP 응답과 학교 결과에 추가되지 않는다.

- `transmission`: 엄격한 transport parser의 `acknowledged` 사실 또는 전송 실패 코드·응답 실패 종류. 이후 fresh read·CAS·캐시 무효화 실패가 있어도 이 사실을 덮어쓰지 않는다. 값이 없으면 ACK 미관측이지 명시적 거절이 아니다.
- `reportFailure`: 실패 경계의 처리 구간과 report/lifetime 취소 여부. 취소 이유 문자열이나 원본 오류는 기록하지 않는다.
- `runtimeFirstFailure`와 `runtimeFirstFailureOrigin`: 실행 중 최초 중단 코드와 고정 원인 구간. 진행 중인 보고의 취소 또는 정리 오류가 최초 중단을 가리지 않게 한다. 학교 측 거절 원인을 대신하지 않는다.

엄격한 일반 보고 ACK 뒤 첫 fresh 조회에서 실제 HTTP 5xx와 retryable `upstream_unavailable`이 함께 관찰된 경우에만 상태 조회를 최대 한 번 추가한다. 같은 실행·owner·generation·대상·jar·취소 신호·요청 한도를 유지하며, 각 조회는 캐시 없이 신원·수강권한·module/detail의 다섯 GET을 수행한다. 권한 검사나 요청 한도 실패가 한 번이라도 발생했거나 요청 신호가 취소된 응답이면 추가 조회하지 않는다. 일반 fetch/jar 오류, 다른 HTTP 오류, 파싱 오류, 정상적으로 반환된 미완료 결과도 대상이 아니다. 429와 `Retry-After`가 있는 응답은 서버 대기 지시를 즉시 재요청으로 넘기지 않고 기존 실패 경로를 따른다.

보고·새 시작·후속 권한 검사·jar CAS는 재시도하지 않는다. 추가 조회 뒤에도 fresh 결과·권한 검사·저장이 실패하면 기존 미확정 처리를 유지하며, 과거 미확정 작업을 다시 실행하지 않는다. 명시적 새 시작 ACK, 일반 `playing/update/ended` 보고 ACK, 학교 완료·개별 영상 출석·차시 출결은 각각 확인한다. 상태 조회 복구나 진단을 이유로 첫 일반 보고를 생략하거나 ACK parser를 완화하지 않는다. `refresh/upstream_unavailable` 로그에 원래 HTTP 상태 근거가 없다면 이 복구 경로의 적용 대상이었다고 단정할 수 없다.

[`test/video-report-refresh-diagnostics.test.ts`](../test/video-report-refresh-diagnostics.test.ts)는 포함된 SDK로 ACK·거절 뒤 fresh read/CAS/캐시 실패를 구분한다. runtime·보고 동시 실패는 controlled runtime 및 school playback 회귀로 검사한다. 이 합성 검사들은 운영 수강 완료의 근거가 아니다.

[`test/video-report-status-read-recovery.test.ts`](../test/video-report-status-read-recovery.test.ts)는 같은 SDK의 Commons·Readystream·Everlec 보고에서 503 후 조회 복구와 보고 1회·같은 신호·저장 1회를 확인한다. 반복 503, 401/404/429, 서버 대기 지시, schema/fetch 오류, ACK 거절·손상, 취소·generation 변경, 일시적인 권한 검사 실패, 후속 CAS 실패에서는 허용 범위를 넘는 조회나 보고를 하지 않는지 검사한다.
