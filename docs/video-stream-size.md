# 학교 영상 스트림의 4 GiB 제한

권한을 확인한 단일 MP4 바이트 스트림은 최대 4 GiB를 허용한다. 단일 Range의 200/206, 잘못된 Range의 416과 HEAD를 지원한다. 전체 파일을 메모리나 DB에 buffering하지 않는다.

선언한 길이와 실제 소비 길이를 제한하며, 부정확한 Content-Length·범위를 벗어난 숫자·허용하지 않은 호스트나 경로는 거절한다. 사용자·학교 generation 확인, 연결 상한, 준비·읽기·소비 중단 기한을 유지한다.

세부 정책은 [`src/video-policy.ts`](../src/video-policy.ts), 전송은 [`src/video-stream.ts`](../src/video-stream.ts), 회귀는 [`test/video-stream.test.ts`](../test/video-stream.test.ts)를 따른다. 합성 Range·길이 검사는 실제 학교 미디어의 전체 재생이나 진도 보고 성공과 별개다.
