# Codex CLI에서 ALMS 조회하기

ALMS는 별도 OAuth를 사용하는 조회 전용 Streamable HTTP MCP 서버다. 학교 SSO와 기본 ALMS 로그인을 먼저 완료하고, MCP 동의 화면에서 본인 계정·`alms-codex`·조회 권한을 확인한다. 학교 비밀번호나 학교 토큰을 Codex 설정에 넣지 않는다.

현재 소스의 지원 범위는 [MCP 계약](mcp-contract.md)을 따른다. 도구12개, `alms:read` scope, 사전 등록한 native client `alms-codex`를 제공한다. MCP로 자동수강·진도 보고·과제 제출·개인 완료 변경·PDF/첨부 bytes를 수행하지 않는다. 목록은 최대200개이며 cursor pagination은 아직 없다.

## 검증 범위

2026-11-05 설치된 **codex-cli0.164.0**의 `mcp`/`app-server` 도움말·생성 schema를 확인했다. 실제 app-server와 현재 ALMS route/tool factory를 연결한 localhost 합성 검증에서12개 도구 발견, 지원 기능과 과제 조회, `refresh` 생략/`resource`/`1`의 전달과 잘못된 enum 거절이 통과했다. 전송은2025-06-18로 협상됐고 정상 종료했다. 모델 turn·운영 OAuth·학교 요청·전역 설정 변경은0회다.

이 검증은0.164.0의 실제 운영 OAuth·학교 데이터 성공을 대신하지 않는다. 별도0.141.0의 과거 운영 OAuth와7개 조회 성공은 [MCP 계약의 실제 검증 이력](mcp-contract.md#실제-검증-범위)에 보존한다. 다른 클라이언트/계정/네트워크와 운영 refresh 회전·폐기는 별도 검증이 필요하다.

같은 날 별도로 운영 OAuth를1회 시작해 CLI exit0을 확인했지만, 브라우저 callback 오류 관찰과 이후 MCP401/refresh400·app-server 초기화 실패를 함께 보존했다. 이 시도의 학교 조회 도구 성공은0회다. 명시적 runtime read scope를 넣은 상태 진단에서도 `notLoggedIn`/`authenticationRequired`였다. 따라서 로컬 상호운용 성공이나 OAuth CLI 종료만으로 현재 운영의0.164.0 조회가 성공했다고 보고하지 않는다. 같은 OIDC browser session의 재승인 뒤 이전 연결이 종료되는 문제는 실제 provider의 합성 흐름으로 재현했으며 [Issue14](https://github.com/underconnor/alms-server/issues/14)에서 추적한다. 후속 구현은 아래 연결별 Grant 수명 정책을 적용한다. 후보 코드·회귀 통과와 운영 배포 뒤 실제 조회는 별도로 확정한다. 전역 설정·학교 기록은 이 진단 때문에 변경하지 않았다.

## 이번 명령에만 연결 설정 적용

아래 예시는 운영 서버 URL을 사용한다. 다른 자체 호스팅 서버라면 검증된 HTTPS API의 정확한 `/mcp` 주소로 바꾼다. 같은 이름·주소·Codex 자격 증명 저장소를 로그인과 실행에 사용한다.

```sh
codex \
  -c 'mcp_servers.alms_qa.url="https://api-lms.flyjung.kr/mcp"' \
  -c 'mcp_servers.alms_qa.enabled=true' \
  -c 'mcp_servers.alms_qa.scopes=["alms:read"]' \
  -c 'mcp_servers.alms_qa.oauth.client_id="alms-codex"' \
  mcp login alms_qa --scopes alms:read
```

`-c`는 이 프로세스에만 적용돼 전역 서버 설정을 추가하지 않는다. 정상 OAuth 로그인은 Codex의 자격 증명 저장소에 연결 토큰을 저장할 수 있다. 승인한 기본 ALMS 세션이 로그아웃·만료되면 연결도 더 이상 사용할 수 없다. 학교 인증 만료와 MCP 권한 만료는 별도로 확인한다.

새 버전의 명시 승인은 연결별 Grant를 사용해 다른 연결을 승인해도 기존 연결을 유지한다. 연결의 owner·원래 ALMS 부모·만료는 각각 유지하며, 해당 부모의 로그아웃·만료나 개별 폐기는 계속 적용된다. 배포 전 발급된 Session-bound 토큰을 바꾸지는 않으므로 이전 재승인으로 종료된 연결은 새로 승인해야 한다. 실제 운영에 이 정책이 반영됐는지는 해당 배포·조회 QA 결과로 확인한다.

같은 설정으로 Codex를 시작한다. 이 명령 뒤 대화는 모델을 사용하며 모델 호출 비용·데이터 처리는 사용 중인 Codex 설정을 따른다.

```sh
codex \
  -c 'mcp_servers.alms_qa.url="https://api-lms.flyjung.kr/mcp"' \
  -c 'mcp_servers.alms_qa.enabled=true' \
  -c 'mcp_servers.alms_qa.scopes=["alms:read"]' \
  -c 'mcp_servers.alms_qa.oauth.client_id="alms-codex"'
```

도구 목록에서 `alms_get_capabilities`를 먼저 확인한 뒤 원하는 강좌/과제/일정 조회를 요청한다. 최신 과제 확인은 해당 서버가 광고한 input schema에 `refresh`가 있을 때 `alms_list_assignments`의 `refresh:"resource"`를 사용한다. `refresh`를 받지 않는 기존 배포에 새 인수를 먼저 보내지 않는다.

## 상시 등록을 선택한 경우

다음 명령은 사용자 Codex 설정에 서버 항목을 추가한다. 사용자가 상시 등록을 선택한 경우에만 실행하고, 이미 등록한 같은 이름이 있다면 먼저 해당 항목을 확인한다. 기존 설정 전체를 교체하지 않는다.

```sh
codex mcp add alms \
  --url https://api-lms.flyjung.kr/mcp \
  --oauth-client-id alms-codex
codex mcp login alms --scopes alms:read
```

동등한 설정은 다음과 같다. 기존 설정에 해당 항목만 병합한다.

```toml
[mcp_servers.alms]
url = "https://api-lms.flyjung.kr/mcp"
enabled = true
scopes = ["alms:read"]
tool_timeout_sec = 40

[mcp_servers.alms.oauth]
client_id = "alms-codex"
```

`oauth.client_id`는 중첩 키다. 별도 client secret은 사용하지 않는다. ALMS는 정확한 단일 resource를 요구하므로 discovery와 중복되는 `oauth_resource` override를 추가하지 않는다. 다른 이름·URL·자격 증명 저장소로 바꾸면 기존 승인이 자동으로 이어진다고 가정하지 않는다. `codex mcp get`에 OAuth 설정이 보이지 않는 것만으로 인식·인증 성공을 판단하지 않는다.

read scope 설정은 `mcp_servers.<id>.scopes`이며 `oauth.scopes`가 아니다. 위 키들은0.164.0의 strict configuration 검사에서 인식됨을 확인했다. Scope를 생략하면 Codex는 인증 challenge·resource metadata의 scope를 사용할 수 있으므로, 명시하지 않은 것 자체를 인증 오류의 원인으로 단정하지 않는다.

OAuth client ID를 지정하지 않으면 Codex가 CIMD/DCR 등록을 시도할 수 있다. 현재 ALMS는 사전 등록 client만 제공하므로 `alms-codex`를 명시한다. Codex의 CLI·IDE 설정 공유와 등록 client 우선 동작은 [공식 MCP 문서](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), 중첩 키는 [공식 설정 문서](https://learn.chatgpt.com/docs/config-file/config-reference?surface=cli)를 따른다. ChatGPT 웹의 custom connector까지 지원한다고 확대하지 않는다.

## 오류와 연결 해제

- MCP401/로그인 필요: 해당 연결의 승인이 만료됐는지 확인한다. 기본 ALMS 로그인 후 정상 동의 흐름을 사용한다.
- `SCHOOL_AUTH_REQUIRED`: MCP 동의와 별개로 학교 인증을 갱신해야 한다. 학교 입력을 자동 우회하지 않는다.
- `MCP_INVALID_ARGUMENTS`: 실제 광고된 schema의 ID·기간·모드를 확인한다.
- `MCP_BUSY`/`MCP_TIMEOUT`: 진행 중 조회나 학교 지연을 확인한다. 동시 호출·무한 재시도를 늘리지 않는다.
- `hasMore:true`/`complete:false`: 잘린 목록이다. 학기·강좌·주차·기간으로 범위를 좁히며 나머지를 이미 확인한 것으로 요약하지 않는다.

`codex mcp logout alms`는 로컬 OAuth 인증정보 제거이며 서버 revocation 성공과 구분한다. `codex mcp remove alms`는 상시 등록 항목 제거다. 다른 서버나 사용자의 인증 저장소를 전체 삭제하지 않는다.
