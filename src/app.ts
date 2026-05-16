/**
 * Fastify application factory.
 *
 * Exported as `buildApp` so the integration tests (supertest) and the
 * server bootstrap (`server.ts`) construct identical apps. Tests never
 * spin up a real HTTP listener — they pass `app.server` to supertest.
 *
 * Config knobs:
 *   - `MAX_FILE_BYTES` (env): per-file upload limit. Defaults to 200 MB,
 *     which is well above any realistic MP3 (a 4-hour 320 kbps file is
 *     about 575 MB; we explicitly opt out of supporting podcasts that
 *     large in a single request).
 */

import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';

import { parseLogLevel, parsePositiveInt } from './config';
import { registerFileUploadRoute } from './routes/fileUpload';

export interface BuildAppOptions {
  /** Per-file size limit in bytes. */
  readonly maxFileBytes?: number;
  /** Disable Fastify's request logger (useful in tests). */
  readonly disableRequestLogging?: boolean;
}

const DEFAULT_MAX_FILE_BYTES = 200 * 1024 * 1024;

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const maxFileBytes =
    options.maxFileBytes ??
    parsePositiveInt('MAX_FILE_BYTES', process.env.MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES);
  const logLevel = parseLogLevel('LOG_LEVEL', process.env.LOG_LEVEL, 'info');

  const app = Fastify({
    // Let Fastify build its own pino instance from the options it
    // expects — passing a pre-built pino logger trips a (legitimate)
    // type mismatch with FastifyBaseLogger under strict types.
    logger: options.disableRequestLogging ? false : { level: logLevel },
    // Generate request ids so log lines correlate.
    genReqId: () => `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    // Disable Fastify's body parser for non-multipart routes (we have
    // none, but this is the production-safe default).
    bodyLimit: 1024,
  });

  await app.register(multipart, {
    // Without this, @fastify/multipart silently *truncates* a stream
    // that exceeds `fileSize` — the route would then see a partial
    // upload and report it as "no valid frame found." We'd much rather
    // surface a clear 413 to the client.
    throwFileSizeLimit: true,
    limits: {
      // One file max per request.
      files: 1,
      fileSize: maxFileBytes,
      // Generous field limits — the spec doesn't require any non-file
      // fields, but we don't want to choke on innocuous client-added ones.
      fields: 10,
      fieldSize: 1024,
    },
  });

  registerFileUploadRoute(app);

  // Liveness probe — not part of the assignment, but standard hygiene
  // for anything you'd actually deploy. Trivial enough to leave in.
  app.get('/healthz', () => ({ status: 'ok' }));

  return app;
}
