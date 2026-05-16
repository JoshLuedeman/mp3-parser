/**
 * Centralized pino logger configuration.
 *
 * Why pino:
 *   - It's Fastify's native logger so we don't pay double JSON-stringify
 *     when Fastify wraps it.
 *   - Structured logs by default — every line is a single JSON object,
 *     which is what production log aggregators expect.
 *
 * Why a module-level singleton:
 *   - The HTTP server and the test bootstrap both want the same config.
 *   - Pretty-printing is gated to `NODE_ENV !== 'production'` so prod
 *     logs stay machine-parseable.
 */

import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
});
