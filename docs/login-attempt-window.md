# 로그인 요청의 15분 수명

새 로그인 시도는 [`src/auth-policy.ts`](../src/auth-policy.ts)의 900초 정책을 SQL 만료 시각과 binding cookie의 Max-Age에 함께 사용한다. 이미 생성된 시도의 수명을 연장하지 않는다.

정확한 state와 browser binding, 미소비 여부, 만료 전 상태를 모두 만족해야 학교 신원 검증을 시작한다. 소비된 시도·다른 브라우저·만료 시도·불일치 학교 신원은 거절한다. HTTPS binding cookie의 HttpOnly·Secure·SameSite=None·host-only 조건과 로그인 후 세션 cookie의 SameSite=Lax를 구분한다.

이 수명은 학교 토큰의 유효기간이나 로그인 후 ALMS 세션 수명을 연장하지 않는다. 요청 시간창 안에 돌아와도 학교가 토큰을 거절하면 오류를 반환한다. 원본 callback을 자동 재전송하지 않는다.

[`test/auth.test.ts`](../test/auth.test.ts)와 [`test/integration/auth-window.test.ts`](../test/integration/auth-window.test.ts)에서 cookie와 SQL의 만료 경계를 검사한다. 실제 학교 반환과 브라우저 cookie 전달은 HTTPS 환경에서 별도로 검증해야 한다.
