import { readystreamXml } from './readystream-fixture.js';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { SchoolHttpClient } from '@alms/ssu-api';
import { encryptSchoolSession } from '../../src/crypto.js';
import { createManualVideoSchool } from '../../src/manual-video-school.js';
import { createSchoolVideoSessions } from '../../src/school-video-session.js';

export const noop = async () => {}, signal = () => AbortSignal.timeout(5_000);
export const context = { owner: 'synthetic-owner', sessionHash: 'a'.repeat(64), courseId: '10', moduleItemId: '20' };
export const observation = { positionSeconds: 0, durationSeconds: 600, playbackRate: 1, paused: false, ended: false, seeking: false, visible: true };
export async function fixture(options: { durationSeconds?: number; allowPlaybackStart?: boolean; workerOnly?: boolean } = {}) {
  const duration = options.durationSeconds ?? 600;
  const key = randomBytes(32), seed = new SchoolHttpClient();
  await seed.jar.setCookie('xn_api_token=synthetic-learningx; Secure; Path=/learningx/', 'https://canvas.ssu.ac.kr');
  await seed.jar.setCookie('_canvas_session=synthetic-canvas; Secure; Path=/', 'https://canvas.ssu.ac.kr');
  const jar = await seed.jar.serialize(); let generation = randomUUID(), encrypted = '', released = 0, rawType = 'mp4', ack = true, reportStatus = 200;
  const reset = () => { generation = randomUUID(); encrypted = encryptSchoolSession({ version: 1, generation, identity: { studentId: '90000001' }, jar }, key, context.owner, 'ssu'); }; reset();
  let owned = true, profile = true, details: Record<string, unknown> = {}, requests = 0, reports = 0, starts = 0, beforeReturn = async () => {}, cas = true, progress = 0, pureCanvas: boolean | null = true, xmlOverride: string | undefined;
  let reportResponse: ((callback: string) => Response) | undefined;
  let invalidationError: unknown;
  const paths: string[] = [];
  const store = { getEncryptedSchoolSession: async () => encrypted,
    replaceEncryptedSchoolSession: async (_owner: string, _provider: string, before: string, after: string) => { if (!cas || encrypted !== before) return false; encrypted = after; return true; } };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); requests++; paths.push(url.pathname); assert.equal(init?.method, 'GET');
    const resource = { content_type: rawType, content_id: 'synthetic-video', duration };
    let value: unknown, mime = 'application/json', body: string | undefined;
    if (url.pathname === '/em/synthetic-video') {
      assert.equal(new Headers(init?.headers).get('cookie'), null); assert.equal(new Headers(init?.headers).get('authorization'), null);
      body = '<script>var contentUri = "https://commons.ssu.ac.kr/viewer/ssplayer/uniplayer_support/content.php?content_id=synthetic-video";</script>'; mime = 'text/html';
    } else if (url.pathname.endsWith('/content.php')) {
      body = rawType === 'readystream' ? xmlOverride ?? readystreamXml('synthetic-video', duration) : '<content><content_playing_info><content_id>synthetic-video</content_id><content_type>video1</content_type>'
        + '<content_uri>https://commons.ssu.ac.kr/contents31/ssu1000001/synthetic-video/contents/</content_uri><content_duration>' + duration + '</content_duration>'
        + '<main_media><desktop><html5><method>progressive</method><media_uri>https://ssuin-object.commonscdn.com/ssu-contents/contents31/ssu1000001/synthetic-video/contents/media_files/mobile/video.mp4</media_uri></html5></desktop></main_media>'
        + '</content_playing_info></content>'; mime = 'text/xml';
    } else if (url.pathname === '/mypage') { body = '<iframe id="fulliframe" src="https://canvas.ssu.ac.kr/learningx/dashboard"></iframe>'; mime = 'text/html'; }
    else if (url.pathname === '/learningx/dashboard') { body = '<div id="root" data-user_login="90000001" data-user_id="42" data-role="1" data-module_builder_tool_id="3" data-lecture_attendance_tool_id="4"></div>'; mime = 'text/html'; }
    else if (url.pathname === '/api/v1/users/self/profile') value = { id: profile ? 42 : 99, login_id: '90000001' };
    else if (url.pathname.endsWith('/terms')) value = { enrollment_terms: [{ id: 1, name: '합성 학기', default: true }] };
    else if (url.pathname.endsWith('/learn_activities/courses')) value = owned ? [{ id: 10, name: '합성 강좌', term_id: 1, use_purecanvas: pureCanvas }] : [];
    else if (url.pathname.endsWith('/modules')) value = [{ module_id: 7, module_items: [{ module_item_id: 20, content_type: 'attendance_item',
      content_data: { course_id: 10, item_id: 30, item_content_type: 'commons', item_content_data: resource } }] }];
    else if (url.pathname.endsWith('/attendance_items/30')) value = { course_id: 10, item_id: 30, title: '합성 영상', item_content_type: 'commons', published: true,
      opened: true, use_attendance: true, omit_progress: false, item_content_data: resource, attendance_data: { progress, last_at: 0, completed: false, attendance_status: 'none' },
      viewer_url: 'https://commons.ssu.ac.kr/em/synthetic-video?endat=' + progress + '&TargetUrl=' + encodeURIComponent('https://canvas.ssu.ac.kr/learningx/api/v1/courses/10/sections/17/components/30/progress?user_id=90000001&content_id=synthetic-video&content_type=' + rawType), ...details };
    else if (url.pathname.endsWith('/progress')) {
      assert.equal(url.searchParams.get('content_type'), rawType);
      if (url.searchParams.has('force_cancel')) {
        assert.equal(options.allowPlaybackStart, true); starts++;
        assert.equal(url.searchParams.get('force_cancel'), 'true'); assert.equal(url.searchParams.get('state'), '3');
        assert.ok(Number(url.searchParams.get('currentTime')) <= progress + 0.25);
        assert.equal(Number(url.searchParams.get('cumulativeTime')), Math.round(progress * 1000) / 1000);
      } else reports++;
      assert.equal(new Headers(init?.headers).get('authorization'), null);
      if (ack && reportStatus === 200) progress = Number(url.searchParams.get('cumulativeTime'));
      body = url.searchParams.get('callback') + `({"result":${ack},"error_code":null});`; mime = 'text/javascript';
    } else throw new Error('Unexpected synthetic request');
    await beforeReturn();
    if (url.pathname.endsWith('/progress') && reportResponse) return reportResponse(url.searchParams.get('callback')!);
    return new Response(body ?? JSON.stringify(value), { status: url.pathname.endsWith('/progress') ? reportStatus : 200, headers: { 'content-type': mime } });
  };
  const invalidate = async () => { released++; if (invalidationError) throw invalidationError; };
  const school = createManualVideoSchool(store, key, invalidate, fetcher);
  const sessions = createSchoolVideoSessions(store, key, invalidate, fetcher, { allowReadystreamManual: options.workerOnly !== true });
  return { sessions, generation: () => generation, encrypted: () => encrypted, school, store, reset, paths, counts: () => ({ requests, reports, starts, invalidated: released }),
    setPureCanvas: (v: boolean | null) => { pureCanvas = v; }, setXml: (v: string) => { xmlOverride = v; },
    setOwned: (v: boolean) => { owned = v; }, setProfile: (v: boolean) => { profile = v; }, setDetails: (v: Record<string, unknown>) => { details = v; },
    setType: (v: string) => { rawType = v; }, setAck: (v: boolean) => { ack = v; }, setCas: (v: boolean) => { cas = v; },
    setReportStatus: (value: number) => { reportStatus = value; },
    setReportResponse: (value: (callback: string) => Response) => { reportResponse = value; },
    setInvalidationError: (value: unknown) => { invalidationError = value; },
    setProgress: (value: number) => { progress = value; },
    onReturn: (fn: () => Promise<void>) => { beforeReturn = fn; }, prepare: () => school.prepare(context, noop, signal()) };
}
