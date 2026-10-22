# 과제 읽기의 수강 목록 재사용

과제 목록·상세·제출 이력의 일반 cache miss는 같은 owner·학교 generation·유효 TTL의 정확하고 유일한 강좌 catalog를 표시 context에 재사용할 수 있다. 학교 SDK의 fresh native 신원·전체 학기·수강권한 검사는 유지한다. 캐시 context가 학교 권한을 대신하지 않는다.

대상이 없거나 만료됐거나 모호하면 전체 학기 catalog를 다시 읽는다. `refresh=1`은 새 catalog를 읽는다. 다른 사용자·세대·강좌의 결과를 재사용하지 않으며 대시보드의 기본 학기 선택을 바꾸지 않는다.

[과거 학기 과제 계약](past-assignment-read-contract.md)과 [`assignment-catalog-reuse` 테스트](../test/assignment-catalog-reuse.test.ts)에서 범위를 확인한다. 학교 요청 수나 응답 시간은 실제 환경별로 측정해야 하며 테스트의 캐시 재사용을 브라우저 성능 보장으로 해석하지 않는다.
