export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const asyncHandler = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

export function paginate(req) {
  const limit = Math.min(Number(req.query.limit || 50), 100);
  const offset = Math.max(Number(req.query.offset || 0), 0);
  return { limit, offset };
}
