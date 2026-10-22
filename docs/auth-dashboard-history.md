# 로그인 상태·대시보드·학기 조회

ALMS 세션 만료와 학교 인증 만료는 다른 오류다. 유효한 ALMS 세션이 있어도 학교 읽기에 필요한 학교 인증은 만료될 수 있다. 학교 상태를 확인하지 못했을 때 이전 성공 응답이나 빈 목록으로 대신하지 않는다.

대시보드 개요와 학교 학기·강좌 조회는 사용자·학교 generation별 캐시를 사용한다. 학교가 반환한 default 학기를 따르며 날짜로 현재 학기를 추측하지 않는다. 선택한 이전 학기의 조회가 기본 학기와 다른 사용자의 캐시를 바꾸지 않는다.

정확한 경로·query·응답은 [OpenAPI](openapi.json), 인증 동작은 [HTTP 계약](http-contract.md)을 따른다. [`course-history-and-dashboard` 테스트](../test/course-history-and-dashboard.test.ts)는 합성 응답과 캐시 경계를 검사한다. 실제 계정의 학기 목록·세션 만료·재로그인은 별도 확인이 필요하다.
