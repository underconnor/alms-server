import { SchoolHttpClient, LearningxClient } from '@alms/ssu-api';
// Synthetic school launch contract; no real account or document values.
export async function syllabusFixture(extra = '') {
  const courseId = '7001', sis = '2099_1_999_1', report = 'zcm_get_abeek_plan_2018_new';
  const names = ['YEAR', 'TERM', 'COURSE', 'UNAME', 'P_RANDOM'], values = ['2099', '1', '999', 'synthetic-user', 'synthetic-nonce'];
  const launchUrl = 'https://office.ssu.ac.kr/oz70/ozView.jsp?' + new URLSearchParams({ ozrname: report, category: 'CM', cnt: '5', pName: names.join(','), pValue: values.join(',') });
  const html = `<html><head><script src="/oz70/authcheck_utf.js"></script><script>
function SetOZParamters_OZViewer(){ var oz; oz = document.getElementById("OZViewer");
oz.sendToActionScript("connection.servlet", "https://office.ssu.ac.kr/oz70/server");
oz.sendToActionScript("connection.reportname", "CM/${report}.ozr");
oz.sendToActionScript("odi.odinames", "${report}");
oz.sendToActionScript("odi.${report}.pcount", "5");
${names.map((name, i) => `oz.sendToActionScript("odi.${report}.args${i + 1}", "${name}=${values[i]}");`).join('\n')}
return true; }
function call(){ start_ozjs("OZViewer", "/oz70/ozhviewer/"); }
</script><script>requestSend('${values[3]}','${report}','${values[4]}');</script>${extra}</head><body><div id="OZViewer"></div></body></html>`;
  const http = new SchoolHttpClient(undefined, async input => {
    const path = new URL(String(input)).pathname;
    let body: string, contentType = 'application/json';
    if (path.endsWith('/terms')) body = JSON.stringify({ enrollment_terms: [{ id: '9', name: 'Synthetic term' }] });
    else if (path.endsWith('/learn_activities/courses')) body = JSON.stringify([{ id: courseId }]);
    else if (path === `/learningx/api/v1/courses/${courseId}`) body = JSON.stringify({ id: courseId, sis_source_id: sis,
      syllabus_body: `<iframe src="https://canvas.ssu.ac.kr/learningx/courses/${sis}/syllabus"></iframe>` });
    else if (path.endsWith('/syllabus')) { contentType = 'text/html'; body = `<meta http-equiv="refresh" content="0; url=${launchUrl.replaceAll('&', '&amp;')}">`; }
    else if (path === '/oz70/ozView.jsp') { contentType = 'text/html'; body = html; }
    else throw new Error('Unexpected synthetic request');
    return new Response(body, { headers: { 'content-type': contentType } });
  });
  await http.jar.setCookie('xn_api_token=synthetic; Secure; Path=/learningx/', 'https://canvas.ssu.ac.kr');
  const client = new LearningxClient(http, { userId: '2', userLogin: '90000001', role: 1, moduleBuilderToolId: '3', attendanceToolId: '4' });
  return { plan: await client.prepareCourseSyllabusRender(courseId), courseId, launchUrl, html };
}
