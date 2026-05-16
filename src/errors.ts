/**
 * Typed HTTP error classes and Fastify error-mapping helper.
 *
 * The route handler throws these (or lets Fastify-native errors bubble);
 * the `mapError` function converts any error into a stable JSON shape:
 *
 *   { "error": { "code": "STRING", "message": "human readable" } }
 *
 * Keeping error mapping in one place means new error sources just need
 * to subclass `HttpError` (or be recognized by `mapError`) — they don't
 * need to know anything about the wire format.
 */

import { NoValidFrameError } from './mp3/parser';

export abstract class HttpError extends Error {
  public abstract readonly statusCode: number;
  public abstract readonly code: string;
}

export class BadRequestError extends HttpError {
  public readonly statusCode = 400;
  public readonly code: string;
  constructor(message: string, code = 'BAD_REQUEST') {
    super(message);
    this.name = 'BadRequestError';
    this.code = code;
  }
}

export class UnsupportedMediaTypeError extends HttpError {
  public readonly statusCode = 415;
  public readonly code = 'UNSUPPORTED_MEDIA_TYPE';
  constructor(message = 'Only MPEG-1 Audio Layer III (.mp3) files are accepted') {
    super(message);
    this.name = 'UnsupportedMediaTypeError';
  }
}

export class PayloadTooLargeError extends HttpError {
  public readonly statusCode = 413;
  public readonly code = 'PAYLOAD_TOO_LARGE';
  constructor(message = 'Uploaded file exceeds the configured size limit') {
    super(message);
    this.name = 'PayloadTooLargeError';
  }
}

export interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

/**
 * Convert any thrown value into `{ status, body }` for a JSON response.
 *
 * We special-case:
 *   - Our own `HttpError` subclasses (pass through verbatim).
 *   - `NoValidFrameError` (always 400 — the file isn't a valid MP3).
 *   - Fastify's multipart size-limit error (`FST_REQ_FILE_TOO_LARGE`)
 *     → 413.
 *
 * Everything else is logged at the caller and surfaced as a generic 500
 * with no message details (don't leak internals).
 */
export function mapError(err: unknown): { status: number; body: ErrorBody } {
  if (err instanceof HttpError) {
    return {
      status: err.statusCode,
      body: { error: { code: err.code, message: err.message } },
    };
  }
  if (err instanceof NoValidFrameError) {
    return {
      status: 400,
      body: { error: { code: err.code, message: err.message } },
    };
  }
  // Fastify multipart raises this when the per-file limit is exceeded.
  // We check by the `code` field rather than instanceof because the
  // class is not part of @fastify/multipart's public type surface.
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (code === 'FST_REQ_FILE_TOO_LARGE') {
      return {
        status: 413,
        body: {
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: 'Uploaded file exceeds the configured size limit',
          },
        },
      };
    }
  }
  return {
    status: 500,
    body: { error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error' } },
  };
}
