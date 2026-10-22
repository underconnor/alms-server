# 과제 목록·상세 실패 진단

과제 읽기 실패는 고정된 operation·stage·code만 로그에 남긴다. 학교 응답 본문·URL·사용자·강좌·과제·파일 식별자·쿠키·토큰·원래 오류 cause를 기록하지 않는다.

진단은 기존 응답, 권한, 캐시, 취소와 재시도 정책을 바꾸지 않는다. 로그 기록 실패가 원래 HTTP 결과를 바꾸어서도 안 된다. 진단만으로 특정 학교 장애나 운영 실패 원인이 확정된 것은 아니다.

구현은 [`src/assignment-read-diagnostics.ts`](../src/assignment-read-diagnostics.ts), 검사는 [`test/assignment-read-diagnostics.test.ts`](../test/assignment-read-diagnostics.test.ts)를 따른다.
