import { defineError } from './errors.js';

export const httpStatus = {
  Ok: 200,
  BadRequest: 400,
  NotFound: 404,
  Conflict: 409,
  TooManyRequests: 429,
  InternalServerError: 500,
  Unavailable: 503,
} as const;

export const httpErrors = {
  NetworkError: defineError('HttpNetworkError', (cause?: unknown) => ({ cause })),
  NotFound: defineError('HttpNotFound', (message?: string) => ({ message })),
  BadResponse: defineError('HttpBadResponse', (message?: string) => ({ message })),
  Unauthorized: defineError('HttpUnauthorized', (message?: string) => ({ message })),
  TooManyRequests: defineError(
    'HttpTooManyRequests',
    (retryAfterSeconds: number | null = null) => ({ retryAfterSeconds }),
  ),
  Unknown: defineError('HttpUnknownError', (status: number, message?: string) => ({
    status,
    message,
  })),
} as const;

export type HttpNetworkError = ReturnType<typeof httpErrors.NetworkError>;
export type HttpNotFoundError = ReturnType<typeof httpErrors.NotFound>;
export type HttpBadResponseError = ReturnType<typeof httpErrors.BadResponse>;
export type HttpUnautorizedError = ReturnType<typeof httpErrors.Unauthorized>;
export type HttpTooManyRequestsError = ReturnType<typeof httpErrors.TooManyRequests>;
export type HttpUnknownError = ReturnType<typeof httpErrors.Unknown>;
