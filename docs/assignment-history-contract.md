# 본인 제출 이력 읽기

## HTTP

- `GET /v1/courses/:courseId/assignments/:assignmentId/submission-history`: 사용자가 내역을 펼칠 때 요청한다. 선택 query는 `refresh=1`뿐이다. 목록·대시보드의 선행 조회나 history 예열을 추가하지 않는다.
- `GET /v1/courses/:courseId/assignments/:assignmentId/submission-history/:attemptKey/files/:fileId`: 선택한 이력의 발급 첨부 바이트를 읽는다. 선택 query는 `download=1`, `refresh=1`이다. 기존 최신 제출의 `/files/:fileId` 권한과 합치지 않는다.
- 강좌·과제·파일 ID는 기존 1~16자리 양의 정수 문자열이다. Front용 `attemptKey`는 소문자 64자리 hex다. 요청에 시도 번호·사용자 ID·원본 URL을 받지 않는다.
- 두 경로는 현재 ALMS 세션을 전후 확인하며 전체90초·취소 경계를 갖는다. JSON은 `no-store`, 파일은 `private, no-store`다. 기존 CORS·nosniff와 파일의 Content-Disposition·Content-Length·Accept-Ranges:none·sandbox를 유지한다. PDF만 MIME과 `%PDF-`를 함께 검증해 inline으로 제공한다.

## 응답

```ts
type Field =
  | { state: 'missing' | 'null' | 'not_applicable'; value: null }
  | { state: 'available'; value: string };
type SubmissionHistory = {
  courseId: string;
  assignmentId: string;
  state: 'available' | 'missing' | 'null';
  coverage: 'school_returned';
  observedAt: string;
  currentAttempt: number | null;
  items: null | Array<{
    key: string;
    attempt: number | null;
    submittedAt: string | null;
    workflowState: 'unsubmitted' | 'submitted' | 'graded' | 'pending_review' | 'unknown';
    submissionType: AssignmentSubmissionType | null;
    content: { text: Field; url: Field };
    attachments: null | Array<{
      id: string;
      fileName: string | null;
      contentType: string | null;
      sizeBytes: number | null;
      downloadAvailable: boolean;
    }>;
    isCurrent: boolean | null;
  }>;
};
```

`missing`·명시적 `null`은 `items:null`이며 실제 빈 이력은 `available`·`items:[]`다. 미지원·인증 실패·학교 응답 오류는 오류 응답으로 남긴다. 학교가 반환한 내역을 모든 제출이라고 표시하지 않으며 history의 score·grade·평가·학생 ID·서명 URL은 공개하지 않는다. `isCurrent:true`는 SDK가 최신 제출의 시도·시각·유형·내용·파일 결합을 확인한 경우만 보존한다. 현재 평가 화면은 기존 최신 상세의 평가만 사용한다.

본문은 `online_text_entry`, 제출 주소는 `online_url`에만 적용한다. 일반 텍스트를 반환하며 HTML을 실행하지 않는다. 없는 필드·null·미적용과 실제 빈 문자열을 구분한다. 빈 URL도 `available/value:''`로 보존하되 Front는 링크로 만들지 않는다. 비어 있지 않은 주소는 HTTP(S)·userinfo 없음·제어문자 없음·2048자 이하다. 학교의 unknown/unsubmitted workflow 자체를 삭제하거나 제출 성공으로 바꾸지 않고 반환한 읽기 정보를 보존한다. 이 읽기 정보는 학교 제출 쓰기의 조건이나 성공 증거가 아니다.

## 권한·캐시

SDK는 fresh native 본인 확인·현재/default 학기 수강·과제 대상 검증 뒤 정확한 self 제출 URL의 `include[]=submission_history`만 읽는다. `read_status`·다른 사용자의 제출·추가 include는 허용하지 않는다. 과거 학기 읽기와 쓰기 권한 확장은 별도다.

SDK row key는 `a_` 접두사의 검증된 자체 hash다. Backend는 이를 owner·학교 generation·강좌·과제와 묶은 HMAC-SHA256으로 변환한다. Front key만으로 파일 권한을 부여하지 않으며 SDK key를 Front에 노출하지 않는다. History JSON은 같은 owner/generation과 catalog proof의 기존 암호화된30초 캐시를 사용한다. hit는 수명을 늘리지 않으며 `refresh=1`은 우회한다. 다른 계정·새 generation·로그아웃·취소된 응답은 반환을 막는다.

파일 요청마다 fresh history를 읽어 Front HMAC과 SDK row를 다시 결합하고 양의 attempt·현재 발급된 해당 파일을 확인한다. 바이트 miss에서는 SDK가 fresh history와 발급 URL을 다시 검증하고 출처·강좌 경로·redirect·20MiB 제한을 적용한다. 삭제된 이력/파일, 변경된 내용이나 다른 owner/generation의 key는 기존 바이트가 있어도 거절한다.

파일 캐시 key는 owner/generation/강좌/과제/**history/attemptKey**/파일 ID/검증한 메타다. 최신 파일·다른 시도와 분리하고 기존5분·파일20MiB·사용자32MiB·전체64MiB·256항목·동시2개·대기16개/20초 상한을 공유한다. cache hit도 fresh 권한·ALMS·학교 generation을 재검증한다. 파일 원본을 DB나 디스크에 추가하지 않는다. 새 migration·worker 변경·학교 업로드/최종 제출·진도 보고는 없다.

## 검증 경계

합성 검사는 SDK→Backend의 exact include와 cookie scope, missing/null/empty·평가 제외·row 결합, fresh 파일 권한·시도/최신 캐시 분리·owner/generation·취소/최종 세션 검증을 확인한다. 코드/격리 PostgreSQL 검사 결과는 실제 학교 history 지원·OS 다운로드·실제 제출·출석 인정·자동수강 성공과 구분한다.
