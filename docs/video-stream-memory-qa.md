# 영상 스트림 메모리 검사

영상 스트림은 소비한 조각을 전체 파일 크기만큼 보관하지 않아야 한다. 동일한 합성 조각을 반복 전달하는 fixture로 retained ArrayBuffer와 취소 listener의 수를 검사한다. 전체 파일 buffering 여부와 실제 운영 RSS는 다른 측정이다.

## 실행

```sh
node --import tsx --test test/video-stream-memory.test.ts test/video-stream.test.ts test/playback-media-proxy.test.ts
```

대용량 합성 검사는 별도 프로세스에서 실행한다.

```sh
node --expose-gc --import tsx test/helpers/video-stream-memory-fixture.mjs --large
```

이 검사는 학교 네트워크·사용자 세션·실제 미디어를 사용하지 않는다. 합성 전송의 결과를 운영 OOM 원인이나 모든 재생 환경의 메모리 보장으로 확대하지 않는다. 실제 운영에서는 프로세스·동시 연결·컨테이너 제한과 같은 시간창의 지표를 함께 확인한다.
