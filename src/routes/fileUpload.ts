/**
 * `POST /file-upload` route.
 *
 * Accepts a single multipart/form-data file field and returns the number
 * of MPEG-1 Audio Layer III frames it contains:
 *
 *   { "frameCount": <number> }
 *
 * Design notes:
 *   - The route never reads the upload into memory. `@fastify/multipart`
 *     hands us a `Readable` for the file part, which we pipe straight
 *     into the streaming `countFrames` parser. This is what makes the
 *     service scale to large files.
 *   - The route is intentionally thin: validate input shape, call the
 *     parser, translate errors. All MP3 knowledge lives in the `mp3`
 *     module; all error → status mapping lives in `errors.ts`. That
 *     separation keeps the route easy to read and easy to test.
 *   - Field-name expected is `file`. We accept anything (assignment
 *     doesn't pin the field name), but documenting one in the README
 *     and curl example is friendlier than leaving callers guessing.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  BadRequestError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  mapError,
} from '../errors';
import { type BufferStream, countFrames } from '../mp3/parser';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

interface SuccessBody {
  readonly frameCount: number;
}

/**
 * Response schemas for the route.
 *
 * Two payoffs:
 *   1. **Runtime serialization safety.** Fastify's `fast-json-stringify`
 *      compiles these schemas into a serializer. If the handler ever
 *      returns an object whose shape diverges from the contract
 *      (missing `frameCount`, wrong type, extra property), the
 *      serializer enforces the schema instead of silently emitting it.
 *      That's a real runtime check that TypeScript's compile-time
 *      `SuccessBody` / `ErrorBody` types can't provide.
 *   2. **Documentation.** Hooking @fastify/swagger to these schemas
 *      later would generate an OpenAPI spec for free.
 *
 * `additionalProperties: false` is the important bit — without it,
 * fast-json-stringify happily passes through extra fields.
 */
const SUCCESS_SCHEMA = {
  type: 'object',
  required: ['frameCount'],
  additionalProperties: false,
  properties: {
    frameCount: { type: 'integer', minimum: 0 },
  },
} as const;

const ERROR_SCHEMA = {
  type: 'object',
  required: ['error'],
  additionalProperties: false,
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      additionalProperties: false,
      properties: {
        code: { type: 'string', minLength: 1 },
        message: { type: 'string' },
      },
    },
  },
} as const;

const FILE_UPLOAD_SCHEMA = {
  response: {
    200: SUCCESS_SCHEMA,
    400: ERROR_SCHEMA,
    413: ERROR_SCHEMA,
    415: ERROR_SCHEMA,
    500: ERROR_SCHEMA,
  },
} as const;

/**
 * Runtime guard for the parser's input contract.
 *
 * `countFrames` is typed as `AsyncIterable<Buffer>`, but Fastify's
 * multipart `file` field is typed loosely as `Readable` (chunk type
 * effectively `any`). Crossing that boundary with a plain cast would
 * surrender the runtime safety the parser's tight type implies.
 *
 * This generator threads every chunk through `Buffer.isBuffer` and
 * fails loudly if anything other than a Buffer ever shows up — busboy
 * (the engine inside @fastify/multipart) only ever emits Buffers for
 * file parts, so the guard is silent on the happy path and catches
 * the world if that ever changes.
 */
async function* assertBufferStream(source: AsyncIterable<unknown>): BufferStream {
  for await (const chunk of source) {
    if (!Buffer.isBuffer(chunk)) {
      throw new TypeError(
        `expected Buffer chunks from upload stream; got ${chunk === null ? 'null' : typeof chunk}`,
      );
    }
    yield chunk;
  }
}

/**
 * Soft mime/extension allowlist. We do *not* rely on this for correctness
 * (the parser is the source of truth — any non-MP3 will be rejected with
 * a clear "no valid frame" error). It exists to give clients a faster,
 * clearer 415 when they obviously upload the wrong thing, and to avoid
 * burning CPU parsing a 200 MB ZIP.
 */
const ACCEPTED_MIME_TYPES = new Set(['audio/mpeg', 'audio/mp3', 'application/octet-stream']);

function isProbablyMp3(mimetype: string, filename: string | undefined): boolean {
  if (ACCEPTED_MIME_TYPES.has(mimetype)) return true;
  if (filename && filename.toLowerCase().endsWith('.mp3')) return true;
  return false;
}

export function registerFileUploadRoute(app: FastifyInstance): void {
  app.post(
    '/file-upload',
    { schema: FILE_UPLOAD_SCHEMA },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // `@fastify/multipart`'s `file()` helper returns a single
        // MultipartFile or undefined. We deliberately do not iterate over
        // additional parts: the API contract says "an MP3 file," singular.
        const part = await request.file();
        if (!part) {
          throw new BadRequestError('No file field present in multipart form', 'NO_FILE');
        }

        if (!isProbablyMp3(part.mimetype, part.filename)) {
          // Drain the stream so the connection closes cleanly. If we
          // don't, Fastify can hang waiting for the client to finish
          // sending bytes we'll never read.
          part.file.resume();
          throw new UnsupportedMediaTypeError(
            `Expected an MP3 file but received Content-Type "${part.mimetype}"`,
          );
        }

        // Cross the boundary from Fastify's loosely-typed Readable into
        // the parser's tight `AsyncIterable<Buffer>` contract. Instead of
        // a structural cast (which would silently drop the runtime check),
        // wrap the stream in assertBufferStream — same compile-time type,
        // *with* a Buffer-shape check on every chunk.
        const fileStream = assertBufferStream(part.file as AsyncIterable<unknown>);

        let result;
        try {
          result = await countFrames(fileStream);
        } catch (parseErr) {
          // @fastify/multipart silently truncates the stream when fileSize
          // is exceeded — `throwFileSizeLimit: true` only affects
          // `toBuffer()`, not raw consumption. If we got here via a parse
          // failure caused by truncation, surface the more useful 413.
          if (part.file.truncated) throw new PayloadTooLargeError();
          throw parseErr;
        }
        if (part.file.truncated) throw new PayloadTooLargeError();

        const body: SuccessBody = { frameCount: result.frameCount };
        return reply.type(JSON_CONTENT_TYPE).send(body);
      } catch (err) {
        const { status, body } = mapError(err);
        if (status >= 500) {
          request.log.error({ err }, 'Unexpected error counting MP3 frames');
        } else {
          request.log.warn(
            { errName: err instanceof Error ? err.name : 'unknown' },
            'Request failed',
          );
        }
        return reply.status(status).type(JSON_CONTENT_TYPE).send(body);
      }
    },
  );
}
