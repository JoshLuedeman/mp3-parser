/**
 * Streaming MPEG-1 Layer III frame counter.
 *
 * Why streaming?
 *   The assignment explicitly calls out scalability ("is the solution
 *   scalable and able to handle large files?"). Buffering the entire upload
 *   in memory would scale linearly with file size — fine for the 1.4 MB
 *   sample, but unacceptable for a real service. Operating on a Node
 *   `Readable` lets us:
 *     - keep memory flat regardless of input size (a few KB of working
 *       buffer at any time),
 *     - start counting as bytes arrive (no wait-for-EOF),
 *     - respect backpressure automatically via `for await`.
 *
 * High-level algorithm:
 *   1. Maintain a rolling buffer (`Buffer.concat` of the unconsumed tail
 *      plus each new chunk).
 *   2. On the very first chunks, skip an ID3v2 tag if present — the tag
 *      is metadata wrapping audio data, not itself a frame.
 *   3. Find the first frame header by scanning for a sync word, then
 *      validating with `decodeHeader`. This is the "initial sync."
 *   4. Jump forward by `frameLengthBytes` and validate the header at
 *      the new position. If valid, increment the counter and repeat.
 *      If invalid, fall back to a byte-by-byte resync — this handles
 *      real-world garbage (tag fragments, padding, truncation).
 *   5. When the stream ends, return the final count.
 *
 * Note on Xing/Info/VBRI VBR-header frames:
 *   The first frame of a VBR-encoded MP3 often carries a Xing, Info, or
 *   VBRI metadata block in its side-information region. Structurally it
 *   is a valid MPEG-1 Layer III frame — correct sync, version, layer,
 *   length, and 1152 samples — and the assignment asks for the number
 *   of frames *in the file*, not the number of audible playback frames.
 *   We therefore count it. Mainstream playback tools (mediainfo,
 *   ffprobe) exclude it to keep their reported duration accurate; that
 *   is a UX choice for players, not a spec choice. See README "Xing/Info
 *   VBR-header frame" for the full reasoning.
 *
 * Why the resync fallback instead of strict frame-following?
 *   Real-world MP3 files contain non-audio bytes in unexpected places:
 *   stale ID3v1 tags appended without removing prior ones, APE tags,
 *   Lyrics3, encoder padding, etc. A strict parser would either reject
 *   these files or undercount. Resync makes the parser robust without
 *   being lenient — every counted frame still passes full header
 *   validation. We cap consecutive resync skips to avoid pathological
 *   loops on input that is not actually an MP3 at all (e.g. a JPEG with
 *   coincidental `0xFF` bytes).
 *
 * Memory bounds:
 *   - Working buffer ≤ `MAX_BUFFER_BYTES` between consumed positions.
 *   - The longest legitimate Layer III frame at 320 kbps / 32 kHz is
 *     `floor(144 * 320000 / 32000) + 1 = 1441` bytes, so 64 KB of
 *     headroom is generous.
 */

import { HEADER_SIZE_BYTES, decodeHeader } from './header';
import type { FrameHeader, ParseResult } from './types';

/**
 * What we actually consume: an async iterable of `Buffer` chunks. This is
 * stricter than `Readable` (whose chunk type is essentially `any`) so the
 * compiler can prove every chunk is a Buffer with no runtime guard.
 *
 * Callers passing a Node stream — including Fastify's multipart `file`
 * field — must assert at the boundary that the stream emits Buffers.
 * That cast lives in `src/routes/fileUpload.ts`, the one place we cross
 * from Fastify's loose stream types into our parser's tight contract.
 */
export type BufferStream = AsyncIterable<Buffer>;

/**
 * Soft cap on the working buffer.
 *
 * If we ever accumulate more than this without making progress, the input
 * is almost certainly not a valid MPEG-1 Layer III stream and we abort.
 * 64 KB is well above any realistic frame length (~1.4 KB max) and any
 * realistic ID3v2 tag overhead per scan attempt.
 */
const MAX_BUFFER_BYTES = 64 * 1024;

/**
 * How many bytes the resync fallback will scan before giving up.
 *
 * Real-world inter-frame garbage is at most a few hundred bytes (most
 * commonly zero). 64 KB lets us recover from substantial corruption
 * while still failing fast on input that has lost frame alignment for
 * good.
 */
const MAX_RESYNC_SCAN_BYTES = 64 * 1024;

/** Public error thrown when no valid MPEG-1 L3 frame is ever found. */
export class NoValidFrameError extends Error {
  public readonly code = 'NO_VALID_FRAME';
  constructor(message = 'No valid MPEG-1 Audio Layer III frame found in input') {
    super(message);
    this.name = 'NoValidFrameError';
  }
}

/**
 * Detect and skip a leading ID3v2 tag.
 *
 * ID3v2 tag header layout (10 bytes):
 *   bytes 0..2: "ID3" magic
 *   byte 3:     major version
 *   byte 4:     revision
 *   byte 5:     flags
 *   bytes 6..9: tag size as a "syncsafe" 32-bit integer
 *               (each byte uses only its low 7 bits to avoid
 *                colliding with frame sync `0xFF`)
 *
 * Total bytes to skip past the audio = 10 (header) + syncsafe-size +
 * 10 if the footer flag (bit 4 of flags) is set.
 *
 * Why we only consult ID3v2 (not v1):
 *   ID3v1 is a fixed 128-byte block at the *end* of the file. It is
 *   located after the last audio frame, not before, so it never affects
 *   initial sync. Even if it appears mid-stream (some buggy tools
 *   prepend ID3v1 incorrectly), the resync logic handles it.
 *
 * @returns the number of bytes consumed (0 if no tag present, or
 *          a positive number to skip). Returns -1 if the tag header
 *          looks malformed (we'll then resync byte-by-byte instead).
 */
function maybeSkipId3v2(buf: Buffer): number {
  if (buf.length < 10) return 0;
  if (buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) {
    // No "ID3" magic — nothing to skip.
    return 0;
  }
  const flags = buf[5]!;
  // Syncsafe: 7 bits per byte, big-endian. Each byte is guaranteed by
  // the spec to have its top bit clear, so a simple bitwise shift works
  // (we mask defensively in case of an invalid tag).
  const s1 = buf[6]! & 0x7f;
  const s2 = buf[7]! & 0x7f;
  const s3 = buf[8]! & 0x7f;
  const s4 = buf[9]! & 0x7f;
  const tagBodySize = (s1 << 21) | (s2 << 14) | (s3 << 7) | s4;
  const hasFooter = (flags & 0b0001_0000) !== 0;
  return 10 + tagBodySize + (hasFooter ? 10 : 0);
}

/**
 * Scan forward in `buf` from `start` looking for a position where the
 * next 4 bytes decode as a valid frame header.
 *
 * Returns the offset of the sync byte, or -1 if none found within the
 * portion of `buf` available (the caller must call again with more data
 * appended). Up to `maxScan` bytes are inspected.
 *
 * Doing the scan in a tight loop with manual indexing rather than
 * `Buffer#indexOf(0xff)` matters here: a buffer full of `0xff` bytes
 * would defeat `indexOf` and the cost of validating each candidate is
 * already a few cycles. Direct loop also lets us bail cleanly on
 * `maxScan`.
 */
type FindHeaderResult =
  | { readonly found: true; readonly offset: number; readonly header: FrameHeader }
  | { readonly found: false };

function findNextHeader(buf: Buffer, start: number, maxScan: number): FindHeaderResult {
  const limit = Math.min(buf.length - HEADER_SIZE_BYTES, start + maxScan);
  for (let i = start; i <= limit; i++) {
    // Cheap byte-0 prefilter: every valid frame starts with 0xFF. Skipping
    // straight to `decodeHeader` would do the full validation per position
    // and burn cycles on non-candidates. Buffer's index access is typed as
    // `number | undefined` under `noUncheckedIndexedAccess`; a strict
    // equality check against 0xff narrows it to number safely.
    if (buf[i] !== 0xff) continue;
    const header = decodeHeader(buf, i);
    if (header) {
      return { found: true, offset: i, header };
    }
  }
  return { found: false };
}

/**
 * Count MPEG-1 Layer III frames in `stream`.
 *
 * The stream is consumed exactly once and not closed by this function —
 * the caller is responsible for the stream's lifecycle.
 *
 * @throws {NoValidFrameError} if the stream ends without ever producing
 *   a single valid MPEG-1 Layer III frame, or if buffered data grows
 *   beyond `MAX_BUFFER_BYTES` without making progress (indicating the
 *   input is not an MP3).
 */
export async function countFrames(stream: BufferStream): Promise<ParseResult> {
  // The rolling buffer holds bytes we have *seen* but not yet *consumed*.
  // We append every chunk to it and slice off the consumed prefix once
  // we have advanced past at least the next frame. Typed as `Buffer`
  // (without the generic ArrayBuffer parameter Node 20 infers) so any
  // ArrayBufferLike-backed chunk concatenates cleanly.
  let buf: Buffer = Buffer.alloc(0);

  /** Absolute byte offset within the stream of `buf[0]`. */
  let bufStartAbsolute = 0;

  /** Absolute byte offset of the *next* unread byte. */
  let cursor = 0;

  /** Have we successfully decoded at least one frame? */
  let locked = false;

  let frameCount = 0;

  /**
   * Consume up to `cursor` from `buf` so it stays bounded. Called
   * periodically; not after every frame to avoid quadratic copy cost.
   */
  const compact = (): void => {
    const drop = cursor - bufStartAbsolute;
    if (drop > 0 && drop >= buf.length / 2) {
      buf = buf.subarray(drop);
      bufStartAbsolute = cursor;
    }
  };

  /** Number of bytes currently available from `cursor` onward. */
  const available = (): number => buf.length - (cursor - bufStartAbsolute);

  /** Local view: the byte at absolute offset `cursor + delta`. */
  const localOffset = (): number => cursor - bufStartAbsolute;

  // Stream consumption loop. `for await` automatically handles
  // backpressure: it pauses the source while we're processing. The
  // BufferStream input type guarantees `chunk` is a Buffer — no cast,
  // no normalization, no runtime guard.
  for await (const chunk of stream) {
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);

    // On the very first read, see if there's an ID3v2 tag to skip past.
    // We only do this before locking — once we're inside the audio
    // stream, an "ID3" magic byte sequence is just incidental data.
    if (!locked && cursor === 0) {
      const skip = maybeSkipId3v2(buf);
      if (skip > 0) {
        cursor = skip;
      }
    }

    // Inner loop: parse as many frames as we can with the data we have.
    // We keep going until we either run out of bytes (need another
    // chunk) or hit an unrecoverable condition.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (available() < HEADER_SIZE_BYTES) break;

      if (!locked) {
        // We have not yet found a valid frame. Scan for one.
        const found = findNextHeader(buf, localOffset(), MAX_RESYNC_SCAN_BYTES);
        if (!found.found) {
          // No header in the bytes we have so far. If our buffer has
          // grown past MAX_BUFFER_BYTES without finding sync, this is
          // not an MP3.
          if (available() > MAX_BUFFER_BYTES) {
            throw new NoValidFrameError();
          }
          break; // wait for more data
        }
        // Make sure we have enough bytes to step over the whole frame.
        const frameStartAbsolute = bufStartAbsolute + found.offset;
        const frameEndAbsolute = frameStartAbsolute + found.header.frameLengthBytes;
        if (frameEndAbsolute > bufStartAbsolute + buf.length) {
          // We can see the header but not the whole frame yet.
          // Move the cursor to the header so we don't rescan, and
          // wait for more data.
          cursor = frameStartAbsolute;
          break;
        }
        cursor = frameEndAbsolute;
        frameCount = 1;
        locked = true;
        continue;
      }

      // Locked: try to decode the header at the current cursor.
      const header = decodeHeader(buf, localOffset());
      if (header) {
        const frameEndAbsolute = cursor + header.frameLengthBytes;
        if (frameEndAbsolute > bufStartAbsolute + buf.length) {
          // Header is valid but frame extends past what we've buffered.
          // Wait for more data without losing the cursor.
          break;
        }
        cursor = frameEndAbsolute;
        frameCount++;
        compact();
        continue;
      }

      // Header at the expected position didn't decode — resync.
      const resync = findNextHeader(buf, localOffset() + 1, MAX_RESYNC_SCAN_BYTES);
      if (!resync.found) {
        // Couldn't resync within what we have. If we've burned through
        // MAX_BUFFER_BYTES of garbage, give up.
        if (available() > MAX_BUFFER_BYTES) {
          throw new NoValidFrameError(
            'Lost frame sync and unable to resynchronize within scan limit',
          );
        }
        break; // wait for more data
      }
      cursor = bufStartAbsolute + resync.offset;
      // Don't count yet — re-enter the locked branch which will validate
      // and advance.
    }
  }

  // Final pass after the stream is exhausted: handle the trailing frame
  // case where we had a valid header but were waiting for more bytes
  // that never arrived. The frame is *incomplete*, so we do NOT count
  // it — counting partial frames would diverge from every reference
  // implementation (mediainfo, music-metadata, etc.).

  // If we never locked onto a valid frame at all, the input wasn't an
  // MPEG-1 L3 stream. (frameCount === 0 implies we never locked, since
  // every successful lock now counts at least one frame.)
  if (!locked || frameCount === 0) {
    throw new NoValidFrameError();
  }

  return {
    frameCount,
    bytesScanned: cursor,
  };
}
