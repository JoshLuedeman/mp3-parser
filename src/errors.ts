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
 * Type guard: does `err` have a string `code` property?
 *
 * Used to recognize Fastify's `FST_REQ_FILE_TOO_LARGE` (and similar
 * error-code conventions) without resorting to a structural cast. The
 * predicate's `is` clause lets the compiler narrow `err` to a shape
 * with a `code: string` field inside the conditional block.
 */
function isErrorWithCode(err: unknown): err is { code: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string'
  );
}

/**
 * Mapping of @fastify/multipart error codes to client-facing responses.
 *
 * Discovered by inspecting `node_modules/@fastify/multipart/index.js` —
 * the plugin uses `@fastify/error` to define a fixed set of `FST_*` codes
 * (the same identifiers the plugin throws). Each is given a semantically
 * accurate status code and a stable client-facing `code` string.
 *
 * The plugin's own defaults sometimes differ from what's most useful to
 * a public API consumer (e.g., the plugin returns 406 for non-multipart
 * Content-Type; 415 is more conventional). We restate the mapping here
 * rather than passing the plugin's defaults through verbatim.
 */
interface MappedMultipartError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

const MULTIPART_ERROR_MAP: Readonly<Record<string, MappedMultipartError>> = {
  FST_REQ_FILE_TOO_LARGE: {
    status: 413,
    code: 'PAYLOAD_TOO_LARGE',
    message: 'Uploaded file exceeds the configured size limit',
  },
  FST_INVALID_MULTIPART_CONTENT_TYPE: {
    status: 415,
    code: 'UNSUPPORTED_MEDIA_TYPE',
    message: 'Request Content-Type must be multipart/form-data',
  },
  FST_FILES_LIMIT: {
    status: 400,
    code: 'TOO_MANY_FILES',
    message: 'Request contained more file parts than this endpoint accepts',
  },
  FST_FIELDS_LIMIT: {
    status: 400,
    code: 'TOO_MANY_FIELDS',
    message: 'Request contained too many form fields',
  },
  FST_PARTS_LIMIT: {
    status: 400,
    code: 'TOO_MANY_PARTS',
    message: 'Request contained too many multipart parts',
  },
  FST_PROTO_VIOLATION: {
    status: 400,
    code: 'INVALID_FIELD_NAME',
    message: 'Request contained a disallowed field name',
  },
  FST_INVALID_JSON_FIELD_ERROR: {
    status: 400,
    code: 'INVALID_JSON_FIELD',
    message: 'A request field declared as JSON was not valid JSON',
  },
};

/**
 * Convert any thrown value into `{ status, body }` for a JSON response.
 *
 * Recognized in order:
 *   1. Our own `HttpError` subclasses (pass through verbatim).
 *   2. `NoValidFrameError` from the parser → 400.
 *   3. `@fastify/multipart`'s `FST_*` error codes → mapped per
 *      `MULTIPART_ERROR_MAP` above (mostly 400/413/415).
 *
 * Everything else is logged at the caller and surfaced as a generic 500
 * with no message details — never leak internals to the client.
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
  if (isErrorWithCode(err)) {
    const mapped = MULTIPART_ERROR_MAP[err.code];
    if (mapped) {
      return {
        status: mapped.status,
        body: { error: { code: mapped.code, message: mapped.message } },
      };
    }
  }
  return {
    status: 500,
    body: { error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error' } },
  };
}
