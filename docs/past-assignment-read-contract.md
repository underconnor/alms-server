# 과거 학기 과제 읽기

## 강좌 context

목록과 상세의 최상위에 검증한 catalog의 `course`를 추가한다. 목록의 각 과제 항목과 SDK DTO에는 context를 요구하지 않는다.

```ts
type AssignmentCourseContext = {
  id: string;
  title: string;
  term: string | null;
  termId: string | null;
  schoolDefaultTerm: boolean | null;
  ended: boolean | null;
};
```

이 context의 id는 요청 강좌와 같아야 한다. 학교가 제공한 강좌·학기 목록으로 결합하며 제목·URL로 추정하지 않는다. 누락된 termId/default/ended는 null이다. 기존 provider/DTO의 context 미제공은 호환을 위해 유지하되 실제 school-reader는 검증한 catalog의 context를 채운다. context의 malformed 값·다른 강좌 ID는 성공으로 반환하지 않는다. 공통 public projection을 다시 거쳐도 context를 보존한다.

id와 값이 있는 termId는 기존 학교 ID 형식인 `/^[1-9]\\d{0,15}$/`를 따른다. title은1–10,000자, term은0–10,000자/null이며 context 객체 자체의 null은 허용하지 않는다. Front의 현재 context 검증이 더 넓더라도 학교 reader의 응답은 이 범위 안에 있다.

## 읽기 권한·캐시

Backend의 과제 목록/상세/history/현재 파일/history 파일은 명시적인 all 선택을 사용한다. SDK도 native 본인·모든 반환 학기의 수강·과제·본인 제출/선택 첨부를 검증한다. 일반 강좌 조회의 더 큰 catalog 상한을 과제 권한으로 넓히지 않으며 cache reuse에도30학기/100강좌 상한을 적용한다. SDK의60초·30GET·2MiB/총8MiB JSON, 기존 Backend90초·DTO1MiB 및 파일 상한을 유지한다.

목록·상세·history의 cache proof는 강좌 id/title/term/termId/schoolDefaultTerm/ended가 같은지 확인한다. term/default/종료값이 달라졌다면 기존 응답을 그대로 반환하지 않고 최신 owned catalog와 과제 데이터를 다시 읽는다. 같은 owner·generation의30초 JSON hit는 수명을 늘리지 않으며 암호화된 영속 캐시·취소·새 로그인/최종 ALMS 검증을 유지한다. 파일마다 fresh 과제/선택 시도 연결을 확인하며 다른 강좌·최신/이전 시도·owner/generation의 바이트 권한을 합치지 않는다.

목록·상세·history의 non-refresh miss는 같은 owner·generation·유효 TTL의 exact unique target catalog를 표시 context에 재사용할 수 있다. SDK의 fresh native self/전체 학기/수강 목록 검증은 매 miss 유지하며 캐시 context가 학교 권한을 대신하지 않는다. 없는/만료/과거 target은 전체 학기 조회로 돌아가고 refresh는 항상 새 catalog를 읽는다. [첫 본문 중복 조회](assignment-cold-read.md)의 조회 재사용과 권한 검사를 따른다.

대시보드/TODO의 default catalog는 별도로 유지한다. 과거 과제를 읽었다고 default 학교 학기와 현재 강좌 목록을 과거로 바꾸지 않는다.

## 제출·수강과 검증 경계

context는 Front 읽기 전용 표시용이다. schoolDefaultTerm:false 또는 ended:true이면 Front에서 과거 안내를 표시하고 작성·조건 요청을 막는다. context가 없거나 값이 null인 구버전 응답을 과거로 추정하지 않는다. Backend의 실제 options/prepare/submit/reconcile은 기존 SDK default helper와 학교의 활성 수강·개인 과제·기한·잠금·시도 검사를 계속 사용한다. 읽기 context를 쓰기 허가로 받지 않는다.

`assignment-submission-school.ts`·쓰기 API·worker·보고 정책과 migration은 변경하지 않는다. 이 계약은 과거 계획서·캘린더·영상 학교 보고·자동수강의 지원 범위를 넓히지 않는다. 과거 목록/상세/history/파일 합성 검사와 현재 쓰기 회귀, 격리 PostgreSQL의 context 암호화·재시작 보존을 실제 학교 읽기·브라우저·OS 저장·학교 최종 제출 성공과 구분한다.
