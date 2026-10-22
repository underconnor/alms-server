# 강좌 과제·본인 제출·첨부 읽기

## 첨부·본문·캐시

- 상세에 `descriptionAttachments: [{id,fileName,contentType,sizeBytes,downloadAvailable}]`와 `ownSubmittedContent:{text,url}|null`을 추가한다. 본인 최신 제출이 submitted/graded/pending_review일 때만 SDK가 일반 텍스트와 안전한 HTTP(S) URL을 반환한다. 목록에는 이 두 필드를 넣지 않는다. 원본 HTML·학생 ID·서명 다운로드 URL은 계속 제외한다.
- `moduleItemId:string|null`은 학교의 명시적인 모듈 식별자만 수용한다. 제목이나 수강번호로 추정하지 않는다. 목록 첨부의 availability는 false이며, 상세는 SDK가 확인한 현재 설명/본인 첨부의 발급 URL에만 true를 보존한다. 주차 활동의 `assignmentId:string|null`은 SDK가 assignment content_id에서 읽은 값만 전달한다. 같은 제목·순번으로 결합하지 않는다.
- `GET /v1/courses/:id/assignments/:assignmentId/files/:fileId`는 인증된 내부 바이트 route다. 1~16자리 양의 정수 ID를 사용한다. 선택적 `download=1`은 저장, `refresh=1`은 바이트 캐시 우회다. 임의 URL·사용자 ID·다른 query는 거부한다.
- 바이트 요청마다 같은 owner·학교 generation의 native 신원·수강권한·과제/현재 본인 제출과 파일 연결을 새 SDK 상세 GET으로 확인한다. 설명 또는 최신 본인 제출의 현재 허용 파일 ID가 사라졌으면 기존 바이트가 있어도 반환하지 않는다. 과거 시도·다른 과제 파일은 이 권한으로 확장하지 않는다.
- 파일당 최대20MiB, 전체64MiB·사용자32MiB·최대256항목·5분의 프로세스 메모리 캐시다. 동시에 학교 바이트를 읽는 작업은2개, 대기는 최대16개/20초이며 취소된 대기는 학교 요청을 시작하지 않는다. key는 owner/generation/강좌/과제/파일 ID와 검증한 파일 메타이며 서명 URL을 사용하지 않는다. hit는 수명을 늘리지 않고 새 로그인·명시적 무효화·만료에 폐기한다. 디스크/DB에 원본 바이트를 추가하지 않으며 새 migration은 없다.
- PDF는 응답 MIME과 `%PDF-` 헤더를 함께 확인한 경우만 inline이다. 그 외 파일은 attachment이며, 실행 가능한 MIME이나 미지원 MIME은 application/octet-stream으로 제한한다. 파일명은 경로/제어문자를 제거하고 RFC5987로 인코딩한다. SDK의 출처·경로·redirect·크기 검사는 유지한다.
- 모든 파일은 private,no-store·nosniff·Content-Length·Accept-Ranges:none·sandbox를 사용한다. Content-Disposition을 CORS exposedHeaders에 추가하며 학교 URL을 redirect로 전달하지 않는다. Front는 인증된 fetch의 Blob을 내부 PDF viewer 또는 명시적 저장에 사용한다.
- 목록·상세의30초 읽기 cache hit는 같은 owner/generation과 원래 catalog proof를 재검증해 school bootstrap을 반복하지 않는다. cache miss·`refresh=1`은 native 신원과 현재 수강권한을 새로 읽는다. hit는 원래30초 만료를 늘리지 않고 제출 조건/업로드/최종 제출 권한 검사에는 사용하지 않는다.

과거 학기의 읽기 권한과 강좌 context는 [과거 학기 과제 계약](past-assignment-read-contract.md)을 함께 따른다.

## 조회 경로

`GET /v1/courses/:courseId/assignments`는 학교가 반환한 학기에서 소유권을 확인한 한 강좌의 전체 과제 목록을, `GET /v1/courses/:courseId/assignments/:assignmentId`는 그 과제의 안내와 본인 제출 상태를 반환한다. 목록은 모든 페이지를 확인한 경우만 `complete:true`다. 기존 `/v1/tasks` 학교 할 일과 개인 `/v1/todos`는 그대로 유지한다.

## 입력과 데이터

- 두 ID는 1~16자리 양의 정수 문자열이다. 일반 조회는 query 없이 요청하고, 명시적 다시 확인에만 `?refresh=1`로 30초 캐시를 우회한다. 다른 query는 거부한다.
- 목록은 `{courseId,items,complete:true}`, 상세는 한 과제 객체다. 과제 ID는 Canvas assignment ID이며 `moduleItemId`는 학교가 명시한 모듈 식별자가 없으면 `null`이다. 모듈 ID나 내부 학습 경로를 추정하지 않는다.
- 과제에는 제목·기한/열림/잠김 시각·공개/잠김 상태·제출 유형·허용 확장자·배점·시도 제한과 본인 제출이 포함된다. 미제공 시각/불리언/제한은 `null`이며 `allowedAttempts:-1`만 학교의 제한 없음 값이다.
- 상세의 `descriptionText`와 `lockExplanationText`는 SDK가 변환한 일반 텍스트다. Front는 HTML로 실행하지 않는다.
- 제출 상태는 `submissionState:missing|null|available`이다. 목록에서 미제공과 명시적 null을 구분한다. 상세는 별도 본인 제출 endpoint를 읽은 `available` 객체를 요구하며, 미제출은 그 객체의 `workflowState:unsubmitted`다. 조회 실패를 미제출로 바꾸지 않는다.
- `submission`의 workflow/attempt/submittedAt/gradedAt/late/missing/excused는 학교 값이다. 알 수 없는 workflow/type은 `unknown`, 미제공 nullable 값은 `null`이다.
- `submission.attachments`는 최대100개의 `{id,fileName,contentType,sizeBytes,downloadAvailable:boolean}`만 포함한다. 파일명도 없으면 `null`이다. `submission.feedback`는 최대100개의 `{id,text,createdAt}`이다. 두 배열의 미제공 `null`과 실제 빈 `[]`를 구분한다.
- 파일 원문·서명 다운로드 URL·제출 본문/URL·학생/댓글 작성자 식별자·rubric 원문을 반환하지 않는다. `sourceUrl`은 학교가 반환한 정확한 query 없는 `https://canvas.ssu.ac.kr/courses/:courseId/assignments/:assignmentId`만 보존한다. 학교 이동은 보조 수단이며 제출 완료 기능은 아니다.

## 공개된 현재 제출의 결과

제출 workflow와 성적 공개 상태를 분리한다. SDK가 먼저 제한하고 Backend가 아래 조건을 다시 검사한다.

1. `gradeMatchesCurrentSubmission:false`이면 `resultVisibility:stale`이다.
2. 그렇지 않고 명시적인 `postedAt:null`이면 `not_posted`다.
3. postedAt 미제공 또는 현재 제출 일치 여부가 불명이면 `unknown`이다.
4. 실제 postedAt 시각이 있고 일치가 true인 경우만 `available`이다.

`scoreState`와 `gradeState`는 각각 `missing|null|available|withheld`다. 원래 누락한 score/grade는 응답에서도 필드를 생략하고 missing을 표시한다. 원래 null은 null과 null 상태를 유지한다. 값이 있지만 공개·현재 제출 조건을 만족하지 않으면 값은 null로 제한하고 withheld를 표시한다. 실제 값을 반환하려면 resultVisibility와 해당 field state가 모두 available이어야 한다. 실제 0점은 보존하며 미제공을 0점으로 만들지 않는다.

## 권한·캐시·취소

ALMS 세션과 사용자별 암호화된 학교 세션 generation을 확인한다. 캐시 hit도 LearningX 신원과 현재 학기 수강 목록을 새로 읽어 해당 강좌의 소유권을 확인한다. 새 SDK 조회는 native Canvas 신원을 LearningX 신원과 대조하고 현재 수강 목록을 다시 확인한다. 상세의 embedded submission과 새 self-submission은 모두 본인/과제 식별자와 일치해야 한다.

기존 계정별 lock 안에서 현재 jar를 복원하고 학교 조회 뒤 암호문 CAS로 저장한다. 새 로그인·로그아웃·generation 교체·최종 ALMS 세션 폐기 후에는 결과를 발행하지 않는다. 목록과 상세는 owner/provider/generation/resource별로 분리하여 기존 AES-256-GCM 캐시에 최대30초 저장한다. hit는 원래 TTL을 늘리지 않는다. 메모리100사용자·사용자50리소스, 영속 항목1MiB·사용자100개/8MiB·전체5000개/128MiB 상한을 유지한다. 오류 뒤 만료 자료나 과거 제출 성공으로 대체하지 않는다.

Backend의 lock 대기·최초 권한 검사·SDK·최종 세션 검사를 포함한 전체 대기는90초다. SDK는 전체60초·요청15초·응답2MiB·원문 총8MiB·최대30GET로 제한한다. 목록은 per_page50·최대20페이지/1000개다. 실제 발급 Link의 다음 페이지를 같은 강좌/목적/쿼리 범위에서만 따른다. 상한 도달·순환·잘못된 데이터는 부분 성공 없이 실패한다. 연결 해제/취소 시 다음 요청을 중단하고 늦은 응답을 발행하지 않으며, 실행 중 owner lock은 실제 작업 종료까지 유지한다.

## 오류와 검증 구분

- ALMS/학교 인증 만료는401, 소유권에서 제외된 강좌는404 또는 정규화된 학교 권한 오류다.
- 학교 응답 형식/신원 불일치는 기존502 매핑을 따른다. 상류 실패는 정규화된 학교 오류다.
- 미지원/상한 초과는503 `SCHOOL_PROVIDER_UNAVAILABLE`, provider 없음/전체 취소는503 `ASSIGNMENTS_UNAVAILABLE`다.
- 개인 API 응답은 `Cache-Control:no-store`다. 일반 로그는 고정 route/status만 남기며 과제 본문·성적·학생 정보·학교 URL은 기록하지 않는다.
