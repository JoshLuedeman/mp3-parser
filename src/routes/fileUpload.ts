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
import { countFrames } from '../mp3/parser';

interface SuccessBody {
  readonly frameCount: number;
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
  app.post('/file-upload', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      // Get the *first* file part. `@fastify/multipart`'s `file()` helper
      // returns a single MultipartFile (or throws if there's no file).
      // We deliberately do not iterate over additional parts: the API
      // contract says "an MP3 file," singular.
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

      try {
        const result = await countFrames(part.file);
        // @fastify/multipart truncates the stream silently when fileSize
        // is exceeded (even with `throwFileSizeLimit: true`, that option
        // only affects `toBuffer()`, not raw stream consumption). After
        // the stream is fully consumed, check the `truncated` flag to
        // distinguish "valid short input" from "client sent too much."
        if (part.file.truncated) {
          throw new PayloadTooLargeError();
        }
        const body: SuccessBody = { frameCount: result.frameCount };
        void reply.header('content-type', 'application/json; charset=utf-8');
        return body;
      } catch (err) {
        // If the parser failed but the underlying cause is actually a
        // size-limit truncation, surface that more useful 413 instead.
        if (part.file.truncated) {
          throw new PayloadTooLargeError();
        }
        throw err;
      }
    } catch (err) {
      const { status, body } = mapError(err);
      if (status >= 500) {
        request.log.error({ err }, 'Unexpected error counting MP3 frames');
      } else {
        request.log.warn({ err: { name: (err as Error).name } }, 'Request failed');
      }
      void reply.status(status).header('content-type', 'application/json; charset=utf-8');
      return body;
    }
  });
}
