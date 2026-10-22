# 로그인 실패의 포털 진단

로그인 진단은 허용된 단계·정규화 오류 코드·화면 구조의 boolean/count/enum만 기록한다. 학교 원문 HTML, URL, 계정 식별자, 토큰, 쿠키, nonce, 오류 cause와 stack은 기록하지 않는다.

callback 실패의 현재 단계는 이번 요청의 결과에서 결정한다. 이전 학교 세션에 저장된 실패를 새 시도의 원인으로 복사하지 않는다. 진단은 ALMS 로그인 성공 조건이나 학교 신원 검증을 완화하지 않으며 동작 실패의 원인을 소급 확정하지 않는다.

구현과 허용 필드는 [`src/auth-diagnostics.ts`](../src/auth-diagnostics.ts), 요청 상관관계는 [`src/auth-attempt-diagnostics.ts`](../src/auth-attempt-diagnostics.ts), 검사는 [`test/auth-diagnostics.test.ts`](../test/auth-diagnostics.test.ts)를 따른다. 원래 학교 응답을 저장해 진단 범위를 넓히지 않는다.
