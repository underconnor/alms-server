import { readystreamXml } from './readystream-fixture.js';

// Synthetic UPF grammar shared by two formats; Everlec keeps its own exact CDN tuple and filename policy.
export function everlecXml(content = 'synthetic-video', duration = 600, filename = 'synthetic_video-01.mp4') {
  return readystreamXml(content, duration, filename).replaceAll('https://ssu-toast.commonscdn.com/contents31/',
    'https://ssuin-object.commonscdn.com/ssu-contents/contents31/');
}
