/**
 * Parser integration tests.
 *
 * Ground-truth strategy for the provided sample file:
 *   - The expected frame count is sourced from `mediainfo` (the
 *     verification tool the assignment names) at test run time, with
 *     no hardcoded fallback. If mediainfo isn't installed, the suite
 *     fails loudly rather than silently asserting against a stale
 *     baked-in number.
 *   - Our parser is asserted to match mediainfo exactly. Both exclude
 *     the Xing/Info/VBRI VBR-header frame from the audible count.
 *     See `src/mp3/vbrHeader.ts` for the detection and rationale.
 *
 * The project deliberately uses zero NPM packages that parse MP3 frame
 * data — including in tests. Verification is delegated to the OS-level
 * mediainfo binary the assignment recommends. Crafted-fixture tests
 * below exercise edge cases that can be expressed as a few bytes of
 * literal hex, no parser library needed.
 */

/**
 * Query mediainfo for the canonical frame count. Mediainfo is a hard
 * requirement for these tests — no fallback, no fixture-baked number.
 * If mediainfo is missing or fails, the test must fail loudly.
 *
 * This service matches mediainfo's count exactly: both exclude the
 * Xing/Info/VBRI VBR-header frame from the audible frame count. See
 * `src/mp3/vbrHeader.ts` for the rationale.
 */
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

import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { countFrames, NoValidFrameError } from '../src/mp3/parser';

const SAMPLE_PATH = path.join(__dirname, '..', 'fixtures', 'sound_file.mp3');

/** Wrap a Buffer in a Readable stream for the parser. */
function streamOf(buf: Buffer): Readable {
  return Readable.from([buf]);
}

/**
 * Wrap a Buffer in a Readable that emits one byte at a time. This
 * exercises every buffer-boundary path in the parser (each `await` on
 * `for await` resumes with a 1-byte chunk, forcing the inner loop to
 * `break` and wait for more data many times).
 */
function streamOfTinyChunks(buf: Buffer): Readable {
  return Readable.from(
    (function* () {
      for (const byte of buf) {
        yield Buffer.from([byte]);
      }
    })(),
  );
}

describe('countFrames — provided sample file (mediainfo-verified)', () => {
  let sampleBuffer: Buffer;
  let expectedCount: number;

  beforeAll(async () => {
    sampleBuffer = await readFile(SAMPLE_PATH);
    expectedCount = getMediainfoFrameCount();
  });

  test('single-chunk stream matches mediainfo exactly', async () => {
    const result = await countFrames(streamOf(sampleBuffer));
    expect(result.frameCount).toBe(expectedCount);
  });

  test('1-byte-chunk stream returns the same count (exercises buffer boundaries)', async () => {
    const result = await countFrames(streamOfTinyChunks(sampleBuffer));
    expect(result.frameCount).toBe(expectedCount);
  });

  test('result is deterministic across multiple runs', async () => {
    const a = await countFrames(streamOf(sampleBuffer));
    const b = await countFrames(streamOf(sampleBuffer));
    expect(a.frameCount).toBe(b.frameCount);
  });
});

/**
 * Crafted fixture tests.
 *
 * We build minimal MP3-like buffers in-memory to exercise edge cases
 * that would be awkward or fragile to assert against the sample file.
 */
describe('countFrames — crafted edge cases', () => {
  // Build N valid back-to-back frames at 128 kbps / 44.1 kHz / no padding.
  // Frame length = floor(144 * 128000 / 44100) = 417 bytes.
  function craftFrame(): Buffer {
    const frame = Buffer.alloc(417);
    frame[0] = 0xff;
    frame[1] = 0xfb; // sync(11) + version=11 (MPEG-1) + layer=01 (L3) + protection=1
    frame[2] = 0b1001_0000; // bitrate index 9 (128k), sample-rate index 0 (44.1k), no padding
    frame[3] = 0x00;
    return frame;
  }

  function craftStream(frameCount: number, prefix: Buffer = Buffer.alloc(0)): Buffer {
    const parts: Buffer[] = [prefix];
    for (let i = 0; i < frameCount; i++) parts.push(craftFrame());
    return Buffer.concat(parts);
  }

  test('counts N back-to-back frames', async () => {
    const stream = streamOf(craftStream(50));
    const result = await countFrames(stream);
    expect(result.frameCount).toBe(50);
  });

  test('skips a leading ID3v2 tag', async () => {
    // ID3v2 header: "ID3" + version 0x0300 + flags 0 + syncsafe size = 100 body bytes
    const tagBody = Buffer.alloc(100, 0x00);
    const tagHeader = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0, 0, 0, 100]);
    const prefix = Buffer.concat([tagHeader, tagBody]);
    const stream = streamOf(craftStream(10, prefix));
    const result = await countFrames(stream);
    expect(result.frameCount).toBe(10);
  });

  test('resyncs across a single junk byte between frames', async () => {
    const frames = [craftFrame(), Buffer.from([0xaa]), craftFrame(), craftFrame()];
    const stream = streamOf(Buffer.concat(frames));
    const result = await countFrames(stream);
    expect(result.frameCount).toBe(3);
  });

  test('throws when no valid frame is ever present', async () => {
    const garbage = Buffer.alloc(1024, 0x00);
    await expect(countFrames(streamOf(garbage))).rejects.toBeInstanceOf(NoValidFrameError);
  });

  test('does not count a truncated trailing frame', async () => {
    const fullFrames = craftStream(5);
    // Append only the first 100 bytes of what would have been a 6th frame.
    const truncated = Buffer.concat([fullFrames, craftFrame().subarray(0, 100)]);
    const stream = streamOf(truncated);
    const result = await countFrames(stream);
    expect(result.frameCount).toBe(5);
  });
});
