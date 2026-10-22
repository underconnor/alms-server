# 서버 재생 런타임

이 문서는 단일 영상의 서버 실행 계약이다. 학교 영상의 실제 launch·쿠키·미디어·진도 요청은 아직 관찰하지 않았다. 운영 `playback` capability와 worker provider는 계속 비활성이다. 아래 합성 검사가 통과해도 학교 출석 인정이나 전체 학교 플레이어 지원을 뜻하지 않는다.

이 문서는 격리된 단일 영상 런타임의 계약이다. 실제 학교 재생은 별도의 provider 권한·준비·보고 검증과 worker readiness를 통과해야 한다. 런타임 종료는 출석 인정의 증거가 아니다.

## 내부 계약

```ts
const source = createPlaybackSource(verifiedServerInput);
const runtime = createPlaybackRuntime();
const evidence = await runtime.play(source, abortSignal);
await runtime.dispose(source);
```

- `createPlaybackSource`는 형식·경로·쿠키 범위를 검사한다. 소유 강좌·사용자·로그인 generation의 확인은 학교 adapter가 먼저 수행해야 한다. 함수 이름이나 성공 결과가 학교 검증을 대신하지 않는다.
- 소스는 WeakMap으로 실행 자료를 숨긴 단일 사용 객체다. JSON·일반 inspection은 원문 URL·쿠키를 반환하지 않는다. 같은 소스의 재실행과 dispose한 소스의 실행은 거부한다. 실행 전에 취소된 소스도 다시 사용하지 않는다.
- adapter는 `PreparedPlayback.handle`에 소스를 보관하고 `dispose()`에서 런타임 정리를 기다릴 수 있다. generation 검증은 학교 adapter의 snapshot으로 수행하며, 닫힌 browser에 의존하지 않는다.
- 반환값은 실제 단일 미디어의 `playing`, 시간 위치 증가, `ended`, 미디어 응답, 브라우저·프로세스 종료를 기록한다. 학교 인정 필드는 없다. 학교 결과는 정리 후 별도 fresh read로 확인한다.

## 네트워크와 인증 범위

- 허용 host는 `lms.ssu.ac.kr`, `canvas.ssu.ac.kr`, `commons.ssu.ac.kr`뿐이다. 이 런타임의 source 허용 목록 밖의 호스트는 허용하지 않는다. 격리 QA만 예약된 `fixture.alms.invalid`와 합성 transport를 사용한다. 실제 DNS·학교 네트워크 요청은 하지 않는다.
- 정확한 HTTPS URL·경로·query·리소스 종류·GET/HEAD 방법을 모두 source에 명시해야 한다. wildcard, 임의 host/IP, 비표준 port, URL 내 인증값, fragment, 이중 인코딩 경로는 거부한다. POST 등 학교 진도 쓰기 요청은 현재 계약에서 지원하지 않는다.
- 브라우저 context 생성 뒤 페이지를 만들기 전에 HTTP·WebSocket 규칙을 설치한다. WebSocket은 모두 거부하고 service worker·다운로드·추가 페이지·미지원 dialog를 막는다. frame도 허용된 document URL이어야 한다. TLS와 CSP 검증은 유지한다.
- Playwright 라우트는 HTTP redirect의 첫 URL에서만 호출될 수 있다. 따라서 허용 HTTP 요청은 서버 `fetch`의 `redirect: manual`로 처리하고 redirect 응답은 브라우저에 전달하지 않는다. 같은 정책을 통과한 응답만 브라우저에 전달한다. 이 단계는 school progress를 계산하거나 생성하지 않는다. [공식 route 계약](https://playwright.dev/docs/api/class-route)
- 쿠키는 exact host와 경로 범위를 가진 승인된 source 값만 보낸다. 원래 cookie jar 전체를 복사하지 않는다. `xn_api_token`은 Canvas `/learningx/`에만 허용한다. Bearer와 proxy authorization은 전달하지 않으며 응답의 새 `Set-Cookie`를 자동 수용하지 않는다.
- 단일 요청은 일반 리소스 2 MiB, media 32 MiB까지다. 동시 응답 처리는 8개, 전체 요청은 5,000개까지다. 큰 원본·HLS/DASH·blob media·다중 스토리·동적 인증 갱신은 관찰·설계 후 지원할 범위다. 이번 버전이 이런 학교 플레이어를 지원한다고 가정하지 않는다.

## 정상 재생과 정리

작업마다 새 Chromium 프로세스와 context를 만든다. 공유 사용자 프로필·사용자의 데스크톱 browser·기존 remote debugging 세션에 연결하지 않는다. 런타임이 만든 loopback browser server에만 5초 제한으로 연결하며 endpoint를 외부에 노출하지 않는다. Chromium sandbox는 명시적으로 켠다. 지정한 iframe이 있으면 부모 DOM이 준비된 뒤에도 `startMs` 동안 해당 frame의 탐색을 기다린다.

준비한 시작 버튼을 실제 클릭한 뒤 한 개의 HTML video를 관찰한다. 재생 속도 1, 원래 media URL, 정상 시간 증가를 확인한다. 영상의 시간·진도·학교 보고 함수를 덮어쓰지 않는다. loop, 추가 영상, seek, 속도 변경, 소스 교체는 미지원으로 중단한다. `playing`과 위치 증가 없이 경과 시간만으로 성공하지 않는다. `ended`와 실제 끝 위치·길이까지 일치해야 재생 종료로 반환한다.

시작·stall·pause·전체 실행 timeout을 구분한다. AbortSignal, dispose, 경로 위반, 전체 timeout은 진행 중인 browser protocol 응답과 독립적으로 정리를 시작한다. context 종료·server 종료·해당 프로세스 강제 종료는 각각 최대 5초이며, launch 중 취소는 launch·connect의 제한을 합친 25초까지 종료 대상을 기다린다. 정상 종료가 실패하면 그 작업의 프로세스만 강제 종료한다. 종료를 확인하지 못하면 `CLEANUP_FAILED`로 남기며 이후 `dispose()`도 같은 실패를 전달한다. connect 실패 후 프로세스 종료를 확인하지 못한 경우도 같다. [context와 service worker](https://playwright.dev/docs/api/class-browsercontext) · [browser server](https://playwright.dev/docs/api/class-browserserver)

## 이미지와 QA

- 패키지: `playwright@1.63.0`, lockfile에 고정했다. 별도 `Dockerfile.playback`이 해당 버전의 Chromium과 시스템 의존성을 설치한다. 이미지 target과 Compose의 권한·네트워크 제한을 함께 확인한다.
- `playback` target은 worker용이다. `playback-qa` target은 ffmpeg로 만든 2초 WebM과 합성 HTML을 포함한다. 실제 Chromium이 이를 디코딩·재생하고 종료한다. media API나 시계를 모킹하지 않는다. HTTP transport만 격리된 합성 응답이다.
- Playwright 공식 v1.63.0의 [seccomp profile](https://github.com/microsoft/playwright/blob/1b025d7e20a026371cd5f98ba0cdce48892737c8/utils/docker/seccomp_profile.json)을 기반으로 `scripts/playback-seccomp.json`을 작성했다. 기본 deny와 공식 namespace 허용을 유지하고 `chroot` syscall만 추가로 허용한다. `cap-drop ALL`에서 빠지는 기본 프로필의 조건부 chroot 규칙을 보완해, Chromium이 만든 user namespace 내부의 sandbox 준비를 가능하게 한다. 컨테이너 capability는 추가하지 않는다. 적용 파일 SHA-256: `9c8c1f24962d90df38cb51bdc2238a581eea5ec312f9362fd7364a2df823a232`. root 사용자나 `--no-sandbox`, `--privileged`, seccomp 전체 해제를 사용하지 않는다. [공식 Docker 안내](https://playwright.dev/docs/docker)

```sh
docker build -f Dockerfile.playback --target playback-qa -t alms-playback-qa:local .
docker run --rm --init --network none --cpus 2 --memory 1g \
  --pids-limit 256 --shm-size 256m --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=256m --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --security-opt seccomp="$PWD/scripts/playback-seccomp.json" \
  alms-playback-qa:local
```

운영 DB·학교 세션·키·자료 volume을 주입하지 않는다. 정상 재생·지연된 허용 iframe·시작 실패·pause·loop·다중 영상·속도 변경·redirect/frame/WebSocket·service worker·작업 간 취소 격리·dispose 후 프로세스 종료를 확인한다. 출력은 정규화된 JSON 결과뿐이다.

로컬 단위 회귀는 source validator와 합성 browser interface를 사용하며 실제 browser를 띄우지 않는다. 실제 서버 프로세스·코덱·sandbox 검사는 위 격리 Docker QA로 따로 기록한다.

## 외부 코드 고지

seccomp profile의 출처·수정 범위는 [별도 고지](../scripts/playback-seccomp.NOTICE.md)와 [NOTICE](../NOTICE)를 따른다. Playwright의 [Apache-2.0 라이선스](../LICENSES/Playwright-Apache-2.0.txt)와 [NOTICE](../LICENSES/Playwright-NOTICE.txt)를 함께 보존한다.
