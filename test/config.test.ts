/**
 * Tests for runtime env-var validation.
 *
 * The validators in src/config.ts are the only thing standing between a
 * typo in a deployment manifest and a confusing startup-time failure
 * deep inside Node, Fastify, or pino. They run at module load, so they
 * deserve their own targeted tests covering happy paths, fallback
 * behavior, and every documented rejection reason.
 */

import { LOG_LEVELS, parseHost, parseLogLevel, parsePositiveInt } from '../src/config';

describe('parsePositiveInt', () => {
  test('returns fallback for undefined', () => {
    expect(parsePositiveInt('X', undefined, 42)).toBe(42);
  });
  test('returns fallback for empty string', () => {
    expect(parsePositiveInt('X', '', 42)).toBe(42);
  });
  test('parses a positive integer', () => {
    expect(parsePositiveInt('X', '3000', 0)).toBe(3000);
  });
  test.each(['abc', '3.14', '-1', '0'])('rejects %s', (raw) => {
    expect(() => parsePositiveInt('X', raw, 0)).toThrow(/X must be a positive integer/);
  });
  test('Number() leniently trims whitespace — we follow that convention', () => {
    // Documenting actual behavior: ' 12 ' parses to 12 (Number trims).
    expect(parsePositiveInt('X', ' 12 ', 0)).toBe(12);
  });
});

describe('parseHost', () => {
  test.each(['0.0.0.0', '127.0.0.1', 'localhost', 'service.internal', '[::1]', 'host_name'])(
    'accepts %s',
    (raw) => {
      expect(parseHost('HOST', raw, 'fallback')).toBe(raw);
    },
  );
  test('returns fallback for undefined', () => {
    expect(parseHost('HOST', undefined, '0.0.0.0')).toBe('0.0.0.0');
  });
  test.each(['not a host', 'host name', 'host;rm', 'host/path'])('rejects %s', (raw) => {
    expect(() => parseHost('HOST', raw, '0.0.0.0')).toThrow(/HOST contains invalid characters/);
  });
});

describe('parseLogLevel', () => {
  test.each(LOG_LEVELS)('accepts %s', (level) => {
    expect(parseLogLevel('LOG_LEVEL', level, 'info')).toBe(level);
  });
  test('returns fallback for undefined', () => {
    expect(parseLogLevel('LOG_LEVEL', undefined, 'info')).toBe('info');
  });
  test('rejects an invalid level with a clear error', () => {
    expect(() => parseLogLevel('LOG_LEVEL', 'bogus', 'info')).toThrow(
      /LOG_LEVEL must be one of .* got "bogus"/,
    );
  });
});
