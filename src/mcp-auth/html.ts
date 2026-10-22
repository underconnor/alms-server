const escape = (text: string) => text.replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[value]!));
export function consentHtml(input: { action: string; csrf: string; nonce: string; displayName: string | null; clientId: string }) {
  return page('ALMS 연결 승인', `<p class="eyebrow">ALMS · MCP</p><h1>학습 정보 조회를 허용할까요?</h1>
    <p>${escape(input.displayName ?? '로그인한 사용자')} 계정으로 <strong>${escape(input.clientId)}</strong>에 연결합니다.</p>
    <ul><li>본인의 강좌·주차·과제 설명과 제출 현황</li><li>시간표·할 일·캘린더·학교 학습 상태</li></ul>
    <p class="muted">허용한 조회 권한은 이 ALMS 로그인 유효기간 안에서 자동 갱신됩니다. 로그아웃하거나 로그인 유효기간이 끝나면 연결과 갱신 권한도 만료됩니다. 파일 제출, 수강 시작, 학교 진도·출석 변경 권한은 제공하지 않습니다.</p>
    <form method="post" action="${escape(input.action)}"><input type="hidden" name="csrf" value="${escape(input.csrf)}"><input type="hidden" name="nonce" value="${escape(input.nonce)}">
    <div class="actions"><button name="decision" value="approve">조회 허용</button><button class="secondary" name="decision" value="deny">취소</button></div></form>`);
}
export function signInHtml(frontendUrl: string) {
  return page('ALMS 로그인 필요', `<p class="eyebrow">ALMS · MCP</p><h1>ALMS 로그인이 필요해요</h1>
    <p>ALMS에서 로그인한 뒤 이 창을 새로고침하면 조회 권한을 승인할 수 있습니다.</p><p><a href="${escape(frontendUrl)}" target="_blank" rel="noopener noreferrer">ALMS 로그인 열기</a></p>`);
}
export function accountChangedHtml() {
  return page('ALMS 계정 확인 필요', `<p class="eyebrow">ALMS · MCP</p><h1>ALMS 계정이 변경되었어요</h1>
    <p>이 브라우저의 기존 MCP 연결과 현재 ALMS 로그인 계정이 다릅니다. 계정을 섞지 않도록 이번 승인을 중단했습니다.</p>
    <p>현재 창을 닫고, 연결하려는 계정으로 로그인한 별도 브라우저 프로필이나 비공개 창에서 Codex 연결을 다시 시작해 주세요.</p>`);
}
function page(title: string, body: string) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
    <style>html{font-family:Pretendard,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#191f28;background:#f7f8fa}body{margin:0;word-break:keep-all;overflow-wrap:anywhere}main{max-width:560px;margin:8vh auto;padding:32px;background:#fff;border:1px solid #e5e8eb;border-radius:16px}h1{font-size:26px;line-height:1.4;margin:12px 0 20px}p,li{line-height:1.75}ul{padding-left:22px}.eyebrow,.muted{color:#6b7684}.eyebrow{font-size:14px}.muted{font-size:14px}.actions{display:flex;gap:12px;margin-top:28px}button,a{font:inherit}button{min-height:44px;border:0;border-radius:10px;background:#1b64da;color:#fff;padding:12px 20px;cursor:pointer}.secondary{background:#f2f4f6;color:#191f28}a{color:#1b64da}button:focus-visible,a:focus-visible{outline:3px solid #2272eb;outline-offset:3px}@media(max-width:640px){main{margin:24px 16px;padding:24px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}</style></head><body><main>${body}</main></body></html>`;
}
