# 진행 중 Cookie 로그인 콜백의 중복 반환

## 수정한 경로

첫 callback이 학교 검증을 진행하는 동안 정확히 같은 callback이 다시 도착하면, 기존 구현은 단회 SQL consume의 거절을 곧바로 `login_expired`로 표시했다. 합성 검증에서는 두 번째 응답이 만료 화면으로 이동한 뒤 첫 요청이 정상 세션을 발급했다. 지난 실제 u-SAINT `identity_parse / missing_both / literal_navigation` 두 실패가 이 경로였다는 근거는 없다.

Cookie callback의 진행 중 동일 요청은 최초 실행의 결과를 기다린다. 성공하면 동일한 세션 쿠키와 등록된 복귀 주소를 받고, 실패하면 최초 실패의 고정 단계와 기존 JSON/HTML 처리를 유지한다. 세션을 재발급하거나 학교 입력을 재전송하지 않는다. Bearer callback과 PKCE 코드 교환은 변경하지 않는다.

## 인증 경계

- callback의 경로·query·body 중복 검증과 기존 state/학교 입력 형식 검사를 먼저 수행한다.
- 유효한 binding cookie가 없는 요청은 공유 경로에 들어가지 못한다.
- 공유 키는 등록된 `clientId`, 복귀 URI·clientState, state hash, binding hash, 정확한 `sIdno`·`sToken`을 길이가 분명한 JSON 배열로 만든 SHA-256 digest다. digest와 원본 값을 로그·DB·응답에 넣지 않는다.
- 최초 요청은 기존 단회 `consumeLoginAttempt` → 학교 신원 검증 → 일치 확인 → `issueVerifiedSession`을 수행한다. 다른 입력은 결과를 공유하지 못하며 기존 SQL binding 검사를 거친다.
- 성공 Promise는 token·expiresAt·고정 진단 context만 활성 참여자에게 전달한다. 학교 jar·학생 record·CSRF 값은 공유하지 않는다. 세션 token은 기존 HttpOnly/Secure/Lax cookie로만 반환한다.
- 최초 실행이 완료되면 lookup과 보관 timer를 즉시 제거한다. 이후 같은 callback의 재생은 기존 SQL 단회 검사에서 거절된다. 완료된 인증 결과를 캐시하거나 새 인증의 근거로 사용하지 않는다.

## 자원·대기 제한

| 제한 | 동작 |
| --- | --- |
| 공유 lookup 64개 | 가득 차면 원래 공유 없는 callback 경로를 수행한다. 최초 로그인은 기존 동작을 유지한다. |
| flight당 duplicate 참여자 8개 | 초과 요청은 기존 SQL 경로로 처리한다. 기존 참여자를 취소하거나 학교 요청을 늘리지 않는다. |
| lookup 보관 최대 60초 | 새 합류만 차단한다. 최초 실행과 이미 참여한 요청은 취소하지 않는다. |
| duplicate 대기 최대 15초 | `502 SCHOOL_UPSTREAM_UNAVAILABLE`, HTML은 `school_upstream_unavailable`로 반환한다. 최초 실행은 계속한다. |
| 완료·실패·shutdown | lookup/timer를 정리한다. timer는 `unref`이며 프로세스 종료를 붙잡지 않는다. |

최초 callback의 인증·발급 시간 제한을 새로 추가하지 않는다. duplicate의 timeout 뒤에도 최초 요청이 정상적으로 끝날 수 있다. lookup 보관 기간이 지났거나 용량이 부족할 때 동일 중복을 공유하지 못하면 기존 `INVALID_CALLBACK` 거절이 유지된다. 다른 인스턴스로 도착한 중복도 공유하지 못하므로 SQL 단회 보호가 최종 기준이다.

## 검증 범위

합성 검사는 DB consume 대기·학교 검증 대기·세션 발급 대기의 정확한 중복, GET/form POST, 다른 binding·artifact·학번·새 로그인·등록 client, provider 거절·불가·신원 불일치·DB 실패, duplicate timeout·lookup 만료·용량 초과·shutdown·완료 후 재생 거절을 대조한다. 최초 SQL consume·학교 검증·발급의 횟수와 동일 cookie, 기존 보안 헤더·고정 로그 단계·민감값 제외도 확인한다.

실제 학교의 첫 callback 반환과 브라우저 cookie 전달은 별도로 검증해야 한다. 합성 경합 검사의 성공을 모든 로그인 환경의 성공으로 확대하지 않는다.
