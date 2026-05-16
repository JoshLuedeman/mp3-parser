/**
 * Unit tests for the pure header decoder.
 *
 * The decoder is the only place where domain knowledge about MPEG-1
 * Layer III bit layouts lives. Bugs here cascade into every frame the
 * streaming parser counts, so this file aims to be exhaustive about
 * the bit-level contract: every accept/reject reason gets explicit
 * coverage with a hand-built 4-byte buffer.
 *
 * Helper `buildHeader` encodes the six fields we care about so that
 * test cases read declaratively instead of asking the reader to
 * decode hex constants in their head.
 */

import { HEADER_SIZE_BYTES, decodeHeader, isSyncWord32 } from '../src/mp3/header';

interface BuildHeaderOptions {
  /** 2-bit version ID. 0b11 = MPEG-1 (the only accepted value). */
  versionId?: number;
  /** 2-bit layer. 0b01 = Layer III. */
  layer?: number;
  /** Protection bit (1 = no CRC, 0 = CRC follows). Decoder ignores. */
  protection?: number;
  /** 4-bit bitrate index (1..14 are valid for MPEG-1 L3). */
  bitrateIndex: number;
  /** 2-bit sample-rate index (0..2 are valid). */
  sampleRateIndex: number;
  /** Padding flag. */
  padding?: boolean;
  /** Sync word override — used to test missing/partial sync rejection. */
  syncByte0?: number;
  syncByte1Top3?: number;
}

function buildHeader(opts: BuildHeaderOptions): Buffer {
  const b0 = opts.syncByte0 ?? 0xff;
  const top3 = opts.syncByte1Top3 ?? 0b111;
  const version = opts.versionId ?? 0b11;
  const layer = opts.layer ?? 0b01;
  const protection = opts.protection ?? 1;
  const b1 = (top3 << 5) | (version << 3) | (layer << 1) | protection;
  const b2 = (opts.bitrateIndex << 4) | (opts.sampleRateIndex << 2) | ((opts.padding ? 1 : 0) << 1);
  const b3 = 0; // channel/copyright/etc. — decoder ignores
  return Buffer.from([b0, b1, b2, b3]);
}

describe('isSyncWord32', () => {
  test('accepts canonical MPEG sync', () => {
    // 0xFFFB0000 — top 11 bits all 1, rest doesn't matter for sync.
    expect(isSyncWord32(0xfffb_0000)).toBe(true);
  });
  test('rejects when first byte is not 0xFF', () => {
    expect(isSyncWord32(0xfefb_0000)).toBe(false);
  });
  test('rejects when top 3 bits of second byte are not all 1', () => {
    // 0xFFDB0000 — second byte 0xDB has top 3 bits 110, not 111.
    expect(isSyncWord32(0xffdb_0000)).toBe(false);
  });
});

describe('decodeHeader — happy path', () => {
  test.each([
    // [name, bitrateIndex, bitrateBps, sampleRateIndex, sampleRateHz, padding, expectedFrameLengthBytes]
    ['128 kbps / 44.1 kHz / no pad', 9, 128_000, 0, 44_100, false, 417],
    ['128 kbps / 44.1 kHz / padded', 9, 128_000, 0, 44_100, true, 418],
    ['320 kbps / 32 kHz / no pad', 14, 320_000, 2, 32_000, false, 1440],
    ['32 kbps / 48 kHz / no pad', 1, 32_000, 1, 48_000, false, 96],
    ['64 kbps / 32 kHz / no pad', 5, 64_000, 2, 32_000, false, 288],
  ])(
    'decodes %s',
    (_name, bitrateIndex, bitrateBps, sampleRateIndex, sampleRateHz, padding, expectedLen) => {
      const buf = buildHeader({ bitrateIndex, sampleRateIndex, padding });
      const header = decodeHeader(buf);
      expect(header).not.toBeNull();
      expect(header).toEqual({
        bitrateBps,
        sampleRateHz,
        padding,
        frameLengthBytes: expectedLen,
      });
    },
  );

  test('reads from a non-zero offset', () => {
    const padding = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const header = buildHeader({ bitrateIndex: 9, sampleRateIndex: 0 });
    const combined = Buffer.concat([padding, header]);
    expect(decodeHeader(combined, padding.length)).toMatchObject({
      bitrateBps: 128_000,
      sampleRateHz: 44_100,
    });
  });
});

describe('decodeHeader — rejections', () => {
  test('rejects too-short buffer', () => {
    expect(decodeHeader(Buffer.from([0xff, 0xfb, 0x90]))).toBeNull();
  });

  test('rejects missing sync word (byte 0 != 0xFF)', () => {
    const buf = buildHeader({ bitrateIndex: 9, sampleRateIndex: 0, syncByte0: 0xfe });
    expect(decodeHeader(buf)).toBeNull();
  });

  test('rejects partial sync (top bits of byte 1 wrong)', () => {
    const buf = buildHeader({ bitrateIndex: 9, sampleRateIndex: 0, syncByte1Top3: 0b110 });
    expect(decodeHeader(buf)).toBeNull();
  });

  test.each([
    ['MPEG-2.5 (versionId=0b00)', 0b00],
    ['reserved (versionId=0b01)', 0b01],
    ['MPEG-2 (versionId=0b10)', 0b10],
  ])('rejects non-MPEG-1 version: %s', (_name, versionId) => {
    const buf = buildHeader({ versionId, bitrateIndex: 9, sampleRateIndex: 0 });
    expect(decodeHeader(buf)).toBeNull();
  });

  test.each([
    ['Layer I (0b11)', 0b11],
    ['Layer II (0b10)', 0b10],
    ['reserved (0b00)', 0b00],
  ])('rejects non-Layer-III layer: %s', (_name, layer) => {
    const buf = buildHeader({ layer, bitrateIndex: 9, sampleRateIndex: 0 });
    expect(decodeHeader(buf)).toBeNull();
  });

  test('rejects bitrate index 0 (free format)', () => {
    const buf = buildHeader({ bitrateIndex: 0, sampleRateIndex: 0 });
    expect(decodeHeader(buf)).toBeNull();
  });

  test('rejects bitrate index 15 (reserved)', () => {
    const buf = buildHeader({ bitrateIndex: 15, sampleRateIndex: 0 });
    expect(decodeHeader(buf)).toBeNull();
  });

  test('rejects sample-rate index 3 (reserved)', () => {
    const buf = buildHeader({ bitrateIndex: 9, sampleRateIndex: 3 });
    expect(decodeHeader(buf)).toBeNull();
  });
});

describe('HEADER_SIZE_BYTES', () => {
  test('is 4 (per the MPEG audio spec)', () => {
    expect(HEADER_SIZE_BYTES).toBe(4);
  });
});
