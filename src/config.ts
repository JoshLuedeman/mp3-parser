/**
 * Runtime validation for configuration that crosses the
 * `process.env` → TypeScript boundary.
 *
 * TypeScript's types are erased at compile time; everything in
 * `process.env` is `string | undefined` at runtime, regardless of what
 * we annotate. This module validates each variable we read with a
 * fail-fast policy: if the value is present but malformed, throw a
 * descriptive error at startup so the operator sees the problem
 * immediately, instead of letting a silent NaN or invalid string
 * propagate into Node, Fastify, or pino and produce a confusing
 * runtime failure later.
 *
 * Each helper takes:
 *   - the variable name (used in error messages),
 *   - the raw value (`process.env.X`, possibly `undefined`),
 *   - a fallback used when the variable is absent or empty.
 *
 * Empty strings are treated as "absent." This matches the conventional
 * Unix shell behavior: setting `FOO=` is the same as not setting it.
 */

/**
 * Parse a positive integer.
 *
 * `Number('abc')` returns `NaN`; `Number('')` and `Number(undefined)`
 * return 0. Without explicit validation, both would coerce into
 * downstream config without error and produce surprising behavior
 * (e.g. a multipart fileSize limit of NaN or 0).
 */
export function parsePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/**
 * Parse a host string for a TCP listener.
 *
 * We don't fully parse the host — Node's networking stack handles that.
 * We just reject characters that have no business in a hostname / IPv4 /
 * IPv6-with-brackets so that an obvious mistake fails at startup rather
 * than at `app.listen()` time.
 *
 * Allowed character set covers:
 *   - letters and digits (hostnames, IPv4)
 *   - `.` and `-` (hostnames)
 *   - `:` (IPv6, `host:port` is rejected — we read the port separately)
 *   - `[` and `]` (IPv6 literal brackets)
 *   - `_` (technically not RFC-1123 but tolerated by Node)
 */
const HOST_PATTERN = /^[A-Za-z0-9._\-:[\]]+$/;

export function parseHost(name: string, raw: string | undefined, fallback: string): string {
  if (raw === undefined || raw === '') return fallback;
  if (!HOST_PATTERN.test(raw)) {
    throw new Error(`${name} contains invalid characters: ${JSON.stringify(raw)}`);
  }
  return raw;
}

/**
 * Pino's log levels. Keeping the list as a `readonly` tuple via
 * `as const` lets us derive the `LogLevel` type from it without
 * a second source of truth.
 */
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

function isLogLevel(raw: string): raw is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(raw);
}

/**
 * Parse a pino log level.
 *
 * Pino itself throws for invalid levels — but at logger-construction
 * time, with a message that doesn't name the env var. Validating here
 * gives a clear "LOG_LEVEL must be one of …" error instead.
 */
export function parseLogLevel(name: string, raw: string | undefined, fallback: LogLevel): LogLevel {
  if (raw === undefined || raw === '') return fallback;
  if (!isLogLevel(raw)) {
    throw new Error(`${name} must be one of ${LOG_LEVELS.join(', ')}; got ${JSON.stringify(raw)}`);
  }
  return raw;
}
