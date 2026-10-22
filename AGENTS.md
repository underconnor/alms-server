# ALMS Server 작업 지침

- TypeScript/Fastify, PostgreSQL/pg-boss 기반 REST API와 선택적 조회 전용 MCP 저장소다. 공개 계약은 `docs/http-contract.md`, `docs/openapi.json`, `docs/mcp-contract.md`를 따른다.
- 변경 전 현재 코드·브랜치·작업 중 변경과 해당 기능의 provider 지원 범위를 확인한다. 사용자의 최신 지시가 문서보다 우선한다.
- `npm ci`, `npm run check`, `TEST_DATABASE_URL=... npm run test:integration`를 사용한다. 통합 테스트 DB는 별도 `alms_test` 또는 `alms_qa`만 허용하며 운영 DB를 사용하지 않는다.
- 실제 학교 연동은 `src/provider.ts`의 기능별 adapter로 주입한다. 미지원·미연동 기능은 오류 또는 명시적 지원 상태로 반환한다. 정상 학교 응답을 합성하지 않는다.
- 학교 SSO 신원·callback 연결을 검증한 내부 코드만 `PgStore.issueVerifiedSession()`을 호출할 수 있다. 요청의 userId·학교 식별자를 인증 근거로 받지 않는다.
- 세션·쿠키·토큰·학교 원문·학생 데이터·강의자료·DB 연결 문자열을 코드, fixture, 로그, 이슈, PR에 넣지 않는다. 테스트에는 합성 데이터를 사용한다.
- REST 쓰기의 세션·Origin·CSRF와 사용자별 SQL 소유권 조건을 유지한다. 명시적으로 승인되지 않은 학교 제출·재제출·수강·진도 변경을 실행하지 않는다.
- MCP는 별도 OAuth/PKCE와 정확한 client/resource/S256을 검증한다. 승인 POST는 기존 ALMS 세션·정확한 API Origin·CSRF·단회 nonce를 검사한다.
- MCP owner는 검증한 principal로 결정한다. 학교 쓰기·자료 bytes·임의 URL·토큰 인수를 도구에 추가하지 않는다. 승인한 ALMS 세션의 만료·로그아웃·토큰 폐기·계정 전환 차단을 유지한다.
- 재생 worker의 종료와 학교 인정 상태는 별개다. 실제 재생 뒤 `learningStatus()`를 새로 조회한다. 불명확한 쓰기나 끊긴 작업을 자동 재실행하지 않는다.
- 구현, 합성/SQL 테스트, 실제 학교 검증, 배포 결과를 구분해 보고한다. 테스트나 PR 병합만으로 운영 성공을 주장하지 않는다.
- 외부 코드를 가져오거나 수정하면 출처·버전·라이선스·필요한 고지를 함께 검토한다. 공개 문서는 비공개 운영 기록 없이 이해할 수 있어야 한다.
