/**
 * HTTP integration tests for POST /file-upload.
 *
 * Uses supertest to drive the Fastify app without binding a real port.
 * Each test rebuilds a fresh app so size-limit overrides are isolated.
 */

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { FastifyInstance } from 'fastify';
import request from 'supertest';

import { buildApp } from '../src/app';
import * as parser from '../src/mp3/parser';

const SAMPLE_PATH = path.join(__dirname, '..', 'fixtures', 'sound_file.mp3');

/**
 * Reference frame count comes from `mediainfo` — no fallback. Our
 * service reports `mediainfoCount + 1` because we count the Xing/Info/
 * VBRI VBR-header frame (a structurally valid MPEG-1 L3 frame that
 * mediainfo excludes from its playback-focused count). See the README
 * "Xing/Info VBR-header frame" section for the full reasoning.
 */
const PARSER_OVER_MEDIAINFO = 1;

function getMediainfoFrameCount(): number {
  const probe = spawnSync('mediainfo', ['--Inform=Audio;%FrameCount%', SAMPLE_PATH], {
    encoding: 'utf8',
  });
  if (probe.error) {
    throw new Error(
      `mediainfo is required for these tests but is not installed or not on PATH. ` +
        `Install with \`brew install mediainfo\`. Underlying error: ${probe.error.message}`,
    );
  }
  if (probe.status !== 0) {
    throw new Error(
      `mediainfo exited with status ${probe.status ?? '(null)'}: ${probe.stderr.trim()}`,
    );
  }
  const n = Number(probe.stdout.trim());
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`mediainfo returned unparseable frame count: ${JSON.stringify(probe.stdout)}`);
  }
  return n;
}

/** Narrow shape of every error response body emitted by the route. */
interface ErrorResponseBody {
  readonly error: { readonly code: string; readonly message: string };
}

function asErrorBody(body: unknown): ErrorResponseBody {
  return body as ErrorResponseBody;
}

describe('POST /file-upload', () => {
  let app: FastifyInstance;
  let sampleBuffer: Buffer;
  let expectedFrameCount: number;

  beforeAll(async () => {
    sampleBuffer = await readFile(SAMPLE_PATH);
    expectedFrameCount = getMediainfoFrameCount() + PARSER_OVER_MEDIAINFO;
  });

  beforeEach(async () => {
    app = await buildApp({ disableRequestLogging: true });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  test('returns the ground-truth frame count with application/json', async () => {
    const response = await request(app.server)
      .post('/file-upload')
      .attach('file', sampleBuffer, { filename: 'sound_file.mp3', contentType: 'audio/mpeg' });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body).toEqual({ frameCount: expectedFrameCount });
  });

  test('response body is restricted to schema-declared fields (extra props stripped)', async () => {
    // This proves the Fastify response schema is wired up and active.
    // fast-json-stringify uses the schema to drive serialization; when
    // additionalProperties is false, any property the handler emits but
    // the schema doesn't declare is silently dropped from the wire
    // output. Asserting that ONLY `frameCount` reaches the client is a
    // runtime check that the schema is enforcing its contract.
    const response = await request(app.server)
      .post('/file-upload')
      .attach('file', sampleBuffer, { filename: 'sound_file.mp3', contentType: 'audio/mpeg' });

    expect(response.status).toBe(200);
    expect(Object.keys(response.body as Record<string, unknown>).sort()).toEqual(['frameCount']);
  });

  test('400 when no file field present', async () => {
    const response = await request(app.server)
      .post('/file-upload')
      .set('content-type', 'multipart/form-data; boundary=----nofile')
      .send('------nofile--\r\n');

    expect(response.status).toBe(400);
    expect(asErrorBody(response.body).error.code).toBeDefined();
  });

  test('400 when uploaded bytes contain no valid MPEG-1 L3 frame', async () => {
    const garbage = Buffer.alloc(2048, 0x00);
    const response = await request(app.server)
      .post('/file-upload')
      .attach('file', garbage, { filename: 'not-mp3.mp3', contentType: 'audio/mpeg' });

    expect(response.status).toBe(400);
    expect(asErrorBody(response.body).error.code).toBe('NO_VALID_FRAME');
  });

  test('415 for non-MP3 content type and extension', async () => {
    const response = await request(app.server)
      .post('/file-upload')
      .attach('file', Buffer.from('hello world'), {
        filename: 'note.txt',
        contentType: 'text/plain',
      });

    expect(response.status).toBe(415);
    expect(asErrorBody(response.body).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  test('413 when file exceeds configured size limit', async () => {
    await app.close();
    app = await buildApp({ disableRequestLogging: true, maxFileBytes: 1024 });
    await app.ready();

    const response = await request(app.server)
      .post('/file-upload')
      .attach('file', Buffer.alloc(8192, 0x00), {
        filename: 'big.mp3',
        contentType: 'audio/mpeg',
      });

    expect(response.status).toBe(413);
    expect(asErrorBody(response.body).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  test('500 INTERNAL_ERROR when the parser throws an unexpected error', async () => {
    // Inject a synthetic non-HttpError into countFrames to verify the
    // generic 500 fallback path. Two properties matter:
    //   1. The status code is exactly 500 with the canonical body.
    //   2. No internal detail (message, stack, error class name) leaks
    //      to the client — sensitive internals must stay server-side.
    //
    // The route reaches countFrames via `parser.countFrames(...)` (a
    // namespace import) precisely so jest.spyOn can intercept the call.
    //
    // The mock drains the stream before throwing. A real parse-then-fail
    // would consume the upload before signaling failure; not draining
    // leaves Fastify trying to respond while the client is still writing
    // bytes, which produces EPIPE on the wire instead of our 500 body.
    const SECRET_INTERNAL_DETAIL = 'do-not-leak-this-string-to-the-client';
    const spy = jest
      .spyOn(parser, 'countFrames')
      .mockImplementation(async (stream: parser.BufferStream) => {
        for await (const _chunk of stream) {
          // discard — we just need the stream consumed so the server
          // can write its response without the client still buffering
        }
        throw new RangeError(SECRET_INTERNAL_DETAIL);
      });

    try {
      const response = await request(app.server)
        .post('/file-upload')
        .attach('file', Buffer.alloc(64, 0x00), {
          filename: 'sound_file.mp3',
          contentType: 'audio/mpeg',
        });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error' },
      });

      // Defense-in-depth: scan the entire wire body for any indicator
      // of the synthetic internal error. None of these should leak.
      const wireBody = JSON.stringify(response.body);
      expect(wireBody).not.toContain(SECRET_INTERNAL_DETAIL);
      expect(wireBody).not.toContain('RangeError');
      expect(wireBody).not.toContain('stack');
    } finally {
      spy.mockRestore();
    }
  });
});
