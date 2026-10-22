# 과제 제출

학교가 현재 본인에게 허용한 과제만 제출한다. `AssignmentSubmissionService`가 영속 작업과 파일 준비를 담당하고 `createAssignmentSubmissionSchool`이 SDK의 학교 신원·수강권한·발급 폼·제출 결과 검증을 호출한다. 모든 쓰기는 기존 ALMS Cookie·Origin·CSRF 검사를 적용한다. 사용자 ID·학교 URL·학교 파일 ID는 브라우저에서 받지 않는다.

## API

기준 경로는 `/v1/courses/:id/assignments/:assignmentId`다.

| 경로 | 동작 |
| --- | --- |
| GET `/submission-options` | fresh 학교 조건·지원 방식·확장자·현재 attempt·확인 문구와 digest·현재 작업 |
| POST `/uploads` | `{fileName,contentType,sizeBytes}`로 ALMS 임시 용량 예약 |
| POST `/uploads/:uploadId/content` | `application/octet-stream` 원본 파일, 정확한 예약 크기 검증 |
| POST `/uploads/:uploadId/cancel` | 준비 파일 취소. 학교 요청 없음 |
| POST `/submissions` | UUID Idempotency-Key와 `{submissionType,expectedAttempt,pledgeAccepted,pledgeDigest,uploadIds?,text?,url?}`로 명시적 제출 |
| GET `/submissions/current` | 과제의 마지막 작업. 선택적 `idempotencyKey`로 응답 유실된 정확한 요청만 조회 |
| GET `/submissions/:operationId` | owner·과제에 묶인 현재 처리 상태 |
| POST `/submissions/:operationId/reconcile` | 미확정 작업을 학교 본인 제출 GET과 다시 대조. 재전송 없음 |
| POST `/submissions/:operationId/release` | `{observedAt}`로 재확인 결과를 지정해 미확정 작업의 차단만 명시적으로 정리. 학교 쓰기·자동 새 제출 없음 |

`online_upload`, `online_text_entry`, `online_url` 중 실제 발급 form에서 확인한 방식만 허용한다. 그룹·미지원/불명확 조건은 거절한다. plain text는 SDK가 HTML escape와 줄바꿈 변환을 수행한다. 학교 확인 문구 digest가 바뀌면 다시 확인해야 한다.

공개 작업에는 ID·과제 식별자·방식·상태·시각·고정 오류 코드·확인된 attempt/제출 시각만 포함한다. 제출 본문·학교 private receipt·인증 generation·worker token은 포함하지 않는다.

## 저장과 제한

Migration `006-assignment-submission.sql`은 기존 테이블을 변경하지 않고 upload/chunk/operation 테이블을 추가한다. 기존 암호화 키와 owner·목적별 AAD로 파일 메타·128KiB chunk·제출 본문·학교 receipt를 암호화한다. 파일명은 파일시스템 경로로 사용하지 않는다.

- 파일당 20MiB, 최대 5개, 제출 합계 40MiB.
- 임시 예약은 사용자 80MiB/25개, 전체 512MiB/1000개, 1시간 TTL.
- 학교 제출 준비/전송은 DB 잠금으로 전체 2개까지 허용한다. 초과 요청은 학교 쓰기 전에 거절한다.
- 작업 이력은 사용자 1000개/전체 10000개까지. 완료·거절 본문은 1일 후, private receipt는 7일 후 제거한다. 공개 상태와 idempotency 기록은 유지한다.
- final JSON 150000바이트, 본문 UTF-8 120000바이트. raw 파일만 120초 요청 기한이며 기본 JSON 상한은 32KiB다. HTTP 헤더 기한은 15초다.

## 전송과 복구

학교 쓰기 전 DB 실행권과 상태를 저장한다. 최종 POST 직전에는 비교에 필요한 private receipt를 반드시 저장한다. 동일 owner/key/body는 같은 작업, 다른 body는 충돌, 같은 과제의 미확정 작업은 새 전송을 막는다.

`preparing → sending → confirmed/rejected/needs_confirmation`. `confirmed`는 다음 attempt와 제출 본문/첨부가 이번 작업에 일치하는 새 자기 제출 조회 근거가 있어야 한다. pending_review는 완료로 단정하지 않는다. 응답 유실·학교 결과 조회 실패는 `needs_confirmation`이며 자동 POST 재시도는 없다. 만료된 preparing은 거절, sending은 미확정으로 회수한다. 재시작 때 학교 전송을 재실행하지 않는다.

로그아웃·새 인증은 다음 전송 전 검증에서 중단한다. 이미 학교에 도달했을 수 있는 요청은 미확정으로 보존하고, 재로그인 후 같은 본인의 결과를 읽어 대조한다. 자동수강의 로그아웃 후 유지 정책과 별개다.

API 종료 신호는 즉시 새 쓰기를 막고 취소 신호를 전달한다. 정리 7초·pool 2초·최종 프로세스 9.5초로 현재 API Docker 기본 종료 기한 안에 둔다. SIGTERM 이후 허가되지 않은 새 전송이나 자동 재시작은 없다.

## 검증 범위

합성 SDK·서비스·HTTP 회귀, 실제 격리 PostgreSQL의 암호화·동시성·lease 만료·복구를 검증한다. 실제 학교 제출 조건 조회와 최종 학교 쓰기는 분리한다. 배포 전 본인 조건 조회 8GET/전부200을 확인했다. 학교 파일 업로드/최종 제출은 사용자 지정 대상·내용의 최종 동작으로 검증해야 하며 임의 시험 과제를 제출하지 않는다. 학교가 이 과제의 안내·본인 제출에 연결해 반환한 첨부는 Backend 파일 API와 Front 다운로드·PDF 보기를 지원한다. 과거 제출 첨부는 별도 본인 제출 이력 API로 조회한다. 각 요청은 정확한 과제·파일·본인 관계를 검증하며, 브라우저에서 내려받기와 실제 OS 저장 완료는 별도 QA로 구분한다.

## 영수증 없는 재확인과 명시적 작업 정리

`POST reconcile`은 영수증이 없는 미확정 작업에서도 학교 본인 제출을 새로 읽는다. `reconciliationAvailable`은 이제 이 실제 조회를 사용할 수 있다는 뜻이다. 학교 인증이 만료됐거나 조회가 실패하면 해당 오류를 반환하며 성공한 재확인처럼 표시하지 않는다. 현재 학교에 제출돼 있어도 이번 ALMS 작업이 성공했다는 뜻으로 바꾸지 않는다. 정확한 영속 영수증과 새 학교 기록의 일치가 확인된 경우에만 원래 작업을 `confirmed`로 바꿀 수 있다.

공개 Operation에 다음 optional `recovery`를 추가한다. 구버전 서버에서 필드가 없으면 정리 가능 여부는 미확정이다.

```ts
recovery: {
  schoolObservation: {
    workflowState: 'unsubmitted' | 'submitted' | 'graded' | 'pending_review' | 'unknown';
    attempt: number | null; submittedAt: string | null;
    observedAt: string; attribution: 'unattributed';
  } | null;
  release: { kind: 'upload_failed_before_submit' | 'school_submission_present'; releasedAt: string } | null;
  releaseAvailable: boolean;
}
```

원래 결과를 확정할 수 없는 경우 재확인·정리는 원래 `state`·`errorCode`·`receipt`·`createdAt`·`updatedAt`을 보존한다. 현재 학교 상태·정리 기록은 별도 필드다. 이 조회를 통해 기존 강좌/과제 개인 읽기 캐시를 무효화하되 학교 제출을 재전송하지 않는다. 과거 제출 상태를 ALMS의 성공으로 귀속하지 않는다.

정리는 사용자가 `releaseAvailable`을 확인하고 `POST release`에 마지막 `observedAt`을 보낸 경우에만 가능하다. 서버는 학교 기록을 한 번 더 새로 읽고 학교 인증 세대·정확한 session seal·상태/attempt/제출시각과 관측 CAS를 확인한다. 같은 ALMS 사용자·과제·작업의 독점 claim을 확보하며, 기존 로컬 실행이나 유효 lease가 있으면 거절한다. ALMS 세션/CSRF와 만료 시각도 DB 트랜잭션에서 재검증한다. 관측은 5분 이내여야 한다.

- 현재 학교 상태가 제출·채점·검토 중이며 유효한 attempt와 제출 시각이 있으면 `school_submission_present`로 차단만 정리할 수 있다. 원래 작업은 여전히 미확정이며 현재 학교 제출의 주체는 귀속하지 않는다.
- 학교가 미제출이면 새 실행 protocol 1의 정확한 종료 기록과 최종 제출 checkpoint 미도달 근거가 모두 있어야 `upload_failed_before_submit`로 정리할 수 있다. 파일 업로드가 학교 파일을 만들었을 가능성은 별개다.
- 과거 행의 영수증 없음·lease 만료만으로는 최종 미전송을 소급 확정하지 않는다. 학교 미제출인 과거 작업, 최종 checkpoint에 도달한 작업, 종료 근거 없는 작업은 차단을 유지한다.

정리는 원래 idempotency 결과와 이력을 남긴다. 같은 정리 응답이 유실돼 다시 요청해도 새 학교 동작은 없다. 정리 직후 자동 작성/제출은 없으며 새 제출은 사용자의 별도 검토와 새 요청 키·fresh 학교 조건/attempt 확인이 필요하다. 이미 제출한 과제를 QA용으로 다시 제출하지 않는다.

Migration `014-assignment-operation-recovery.sql`은 기존 값을 덮지 않고 execution protocol·최종 checkpoint·정확한 종료·고정 진단·학교 관측·정리 필드를 추가한다. 과거 실행 근거는 NULL로 남긴다. 활성 unique index는 명시적 정리 행만 제외하며 원래 작업의 상태를 변경하지 않는다.

`assignment_submission_failed`는 기존 고정 진단에 `uploadStep`·`finalSubmissionMayHaveWritten`과 UUID `operationId`를 추가한다. 학교 사용자·학번·파일명·원본 URL·본문·오류 cause는 기록하지 않는다. SDK가 새 필드를 제공하지 않으면 null이며 과거 원인을 추정하지 않는다. 새 실행의 정확한 종료 때 같은 고정 진단을 해당 작업에 연결해 저장하므로 시간 근접만으로 원인을 귀속할 필요가 없다.

오류는 `RECOVERY_CHANGED`(관측/세대/학교 기록이 바뀌거나 오래됨), `RECOVERY_UNAVAILABLE`(정리 근거 부족), `SUBMISSION_BUSY`(다른 실행/조회 claim), `OPERATION_CHANGED`(작업 CAS 변경), `SCHOOL_SESSION_CHANGED`(학교 인증 변경), `AUTH_REQUIRED`/`SCHOOL_AUTH_REQUIRED`로 구분한다. 프론트는 `GET status`를 학교 재확인 버튼으로 사용하지 않는다.

## 발급된 로컬 파일 업로드

학교 SDK는 검토한 패키지 버전으로 고정한다. 기존 같은 Canvas 호스트 안에서 학교가 발급한 `/files_api`와 `on_duplicate=rename`, 10자리 소문자 hex `quota_exemption`만 추가로 지원한다. 두 값은 각각 한 개까지 허용하고 디코딩·재작성하지 않는다. 완료 GET의 두 값은 receiver의 유무·값과 같아야 한다. 기존 `/files`·`/files/pending`은 쿼리 없는 계약을 유지한다. 외부 저장소·자동 제출 매개변수·변경된 완료 URL·자동 재시도는 추가하지 않는다.

근거는 공식 Instructure commit `1c9f0bb8013ed69c4f2efe11fd483025469b7e6c`의 [local route](https://github.com/instructure/canvas-lms/blob/1c9f0bb8013ed69c4f2efe11fd483025469b7e6c/config/routes.rb#L3083-L3085), [URL 발급](https://github.com/instructure/canvas-lms/blob/1c9f0bb8013ed69c4f2efe11fd483025469b7e6c/lib/api/v1/attachment.rb#L435-L454), [완료 redirect](https://github.com/instructure/canvas-lms/blob/1c9f0bb8013ed69c4f2efe11fd483025469b7e6c/app/controllers/files_controller.rb#L1051-L1074)다. 값 형식과 전체 검증은 vendor 안의 SDK `docs/assignment-submit-contract.md`에 기록했다.

Backend의 API·상태·실행권·세션·generation·학교 쓰기 기한·잠금과 `beforeUpload`/`beforeWrite` 순서는 바꾸지 않는다. 최종 receipt는 모든 파일 준비와 fresh 조건 확인 뒤, 최종 학교 POST 직전에 저장한다. 초기화·파일 수신·완료 확인 응답이 불명확해 그 단계에 도달하지 못하면 receipt가 없을 수 있다. 과거 receipt 누락만으로 학교 업로드 여부나 실패 원인을 단정하지 않으며 이전 미확정 작업을 해제하지 않는다. 실제 사용자 지정 제출과 새 학교 결과의 대조는 별도 QA다.
