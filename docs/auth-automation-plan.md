# 인증 수명과 클라이언트 연결

ALMS 웹 세션, 학교 세션, MCP 승인은 서로 다른 수명을 가진다. 한 계층의 상태로 다른 계층의 인증 성공을 추정하지 않는다.

- ALMS 세션은 서버가 검증한 학교 신원에 연결한다. 사용자 입력의 식별자로 세션을 발급하지 않는다.
- 학교 세션은 사용자별 암호문과 generation으로 관리한다. 만료되면 학교 인증 갱신이 필요하며 다른 계정의 세션을 재사용하지 않는다.
- MCP 승인은 현재 기본 웹 클라이언트의 ALMS 세션에 연결한다. refresh token도 그 세션의 만료·로그아웃을 넘어서 사용할 수 없다.

## 연결 검증

웹 클라이언트는 허용된 Origin과 복귀 주소를 등록하고 [HTTP 인증 계약](http-contract.md)을 따른다. 실제 학교 SSO는 HTTPS 도메인과 callback 허용 조건을 갖춘 환경에서 검증한다. 실패한 callback을 자동 재전송하거나 다른 신원·세대로 이어 붙이지 않는다.

MCP 연결은 [MCP 계약](mcp-contract.md)의 단일 native client 범위에서 검증한다. 현재 실제 Codex 운영 OAuth·도구 호출 검증은 완료되지 않았다. 새 클라이언트나 무인 갱신을 추가할 때는 세션 폐기, 계정 전환, replay, scope·resource·PKCE 검사를 먼저 정의한다.

## 검사 위치

인증 코드는 [`src/auth.ts`](../src/auth.ts), 세션 정책은 [`src/auth-policy.ts`](../src/auth-policy.ts), MCP 승인은 [`src/mcp-auth`](../src/mcp-auth/)에 있다. 합성·DB 검사는 실제 브라우저 반환과 학교 계정 검증을 대신하지 않는다.
