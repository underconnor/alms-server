import type { FastifyRequest } from 'fastify';
import { AppError } from './errors.js';

export const playbackClientAccept = 'application/json; alms-playback=2';
/** Called after authentication, before school reads or job mutations. */
export function requirePlaybackClient(request: Pick<FastifyRequest, 'headers'>, required: boolean): void {
  if (required && request.headers.accept !== playbackClientAccept)
    throw new AppError(409, 'CLIENT_UPDATE_REQUIRED', 'ALMS가 업데이트됐습니다. 화면을 새로고침한 뒤 다시 이용해 주세요.');
}
