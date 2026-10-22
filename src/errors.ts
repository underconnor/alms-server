export class AppError extends Error {
  constructor(public statusCode: number, public code: string, message: string) {
    super(message);
  }
}
export const unavailable = (code = 'SCHOOL_PROVIDER_UNAVAILABLE') =>
  new AppError(503, code, '학교 연동을 준비 중입니다. 학교 LMS에서 확인해 주세요.');

export const notFound = () => new AppError(404, 'NOT_FOUND', '항목을 찾을 수 없습니다.');
