/**
 * Pure decoder for the 4-byte MPEG-1 Audio Layer III frame header.
 *
 * This module has *no* I/O and no awareness of streaming or buffering — it
 * takes 4 bytes of candidate header data and either returns a fully decoded
 * `FrameHeader` or `null` if the bytes do not represent a valid MPEG-1 L3
 * frame header. Keeping it pure makes it cheap to exhaustively unit-test
 * with table-driven cases and makes the streaming parser much easier to
 * reason about: "if this returns non-null, advance by `frameLengthBytes`;
 * otherwise resync."
 *
 * MPEG-1 Audio frame header layout (32 bits, big-endian on the wire):
 *
 *   AAAA AAAA  AAAB BCCD  EEEE FFGH  IIJJ KLMM
 *   ┬──────────┘├┘├┘┬├──┘─┴─┘│├──┘─┴┘│
 *   │           ││ ││        │└─ G:  padding (1 bit)
 *   │           ││ ││        └─── F:  sampling frequency index (2 bits)
 *   │           ││ │└──────────── E:  bitrate index (4 bits)
 *   │           ││ └────────────  D:  protection bit / CRC (1 bit, ignored)
 *   │           │└──────────────  C:  layer description (2 bits)
 *   │           └───────────────  B:  MPEG audio version ID (2 bits)
 *   └──────────────────────────── A:  frame sync (11 bits, all 1s)
 *
 *   H:  private bit (1 bit, ignored)
 *   I:  channel mode (2 bits, not needed for frame counting)
 *   J:  mode extension (2 bits)
 *   K:  copyright (1 bit)
 *   L:  original (1 bit)
 *   M:  emphasis (2 bits)
 *
 * For this assignment we only care about A, B, C, E, F, and G. The
 * remaining fields are decoded by other implementations for playback but
 * have no bearing on frame *length* and therefore no bearing on frame
 * counting.
 *
 * References:
 *   - ISO/IEC 11172-3 §2.4.3.4 (frame header semantics)
 *   - The widely-cited mpgedit / Predrag Supurovic "MPEG Audio Frame Header"
 *     reference (matches the spec but is freely accessible).
 */

import {
  MPEG1_L3_BITRATES_BPS,
  MPEG1_L3_FRAME_LENGTH_COEFFICIENT,
  MPEG1_SAMPLE_RATES_HZ,
} from './tables';
import type { FrameHeader } from './types';

/** Size of the frame header in bytes. */
export const HEADER_SIZE_BYTES = 4;

/**
 * Quick sync-word check on the top 11 bits of a 32-bit big-endian header word.
 *
 * The first 11 bits of any MPEG audio frame are `1`s ("frame sync"), so
 * the top 11 bits of the word are all set: `(word >>> 21) === 0b111_1111_1111`
 * which is `0x7FF`. This is the hot path — called once per candidate
 * position during resync — so it's a single mask + compare with no
 * allocations.
 *
 * Note we check 11 bits, not 12. The 12-bit sync (`1111 1111 1111`) is
 * sometimes quoted but the official spec says the sync word is 11 bits;
 * the 12th bit is the version ID, which we validate explicitly below.
 */
export function isSyncWord32(word: number): boolean {
  return word >>> 21 === 0x7ff;
}

/**
 * Attempt to decode a 4-byte candidate header.
 *
 * Returns `null` (rather than throwing) for any invalid header. The caller
 * is expected to treat `null` as "this position is not a frame header; try
 * the next byte." Throwing would force the streaming parser to wrap every
 * sync attempt in try/catch, which is both slower and less clear.
 *
 * Validation, in spec order:
 *   1. Sync word (11 bits of `1`).
 *   2. Version ID must be `11` (MPEG-1). Other versions (`00` = MPEG-2.5,
 *      `10` = MPEG-2, `01` = reserved) are out of scope per the assignment.
 *   3. Layer must be `01` (Layer III). Layer I (`11`) and Layer II (`10`)
 *      use different frame-length formulas and different bitrate tables;
 *      they are out of scope per the assignment.
 *   4. Bitrate index must be in `1..14`. Index 0 (free format) and index
 *      15 (reserved) cannot yield a valid frame length and so are rejected.
 *   5. Sample-rate index must be in `0..2`. Index 3 is reserved.
 *
 * If all five checks pass we compute the frame length using the standard
 * Layer III formula:
 *
 *   frameLength = floor(144 * bitrate / sampleRate) + padding
 *
 * where `144` is `samples_per_frame / 8` for Layer III (the bits-to-bytes
 * conversion of the per-frame sample count).
 */
export function decodeHeader(buf: Buffer, offset = 0): FrameHeader | null {
  // Bounds check up front. Returning null here lets the caller treat
  // "not enough bytes" the same as "not a valid header" — both mean
  // "advance the input and try again later."
  if (buf.length - offset < HEADER_SIZE_BYTES) {
    return null;
  }

  // Read the whole 4-byte header as a single big-endian 32-bit word.
  // Using readUInt32BE rather than four indexed byte reads avoids the
  // per-byte `undefined` widening under `noUncheckedIndexedAccess`,
  // matches the on-wire bit order, and is one v8 instruction.
  const word = buf.readUInt32BE(offset);

  if (!isSyncWord32(word)) return null;

  // 32-bit header layout (big-endian, MSB = bit 31):
  //
  //   bits 31..21: frame sync (11 × 1)
  //   bits 20..19: version ID                ((word >>> 19) & 0b11)
  //   bits 18..17: layer                     ((word >>> 17) & 0b11)
  //   bit  16    : protection (ignored)
  //   bits 15..12: bitrate index             ((word >>> 12) & 0b1111)
  //   bits 11..10: sampling-frequency index  ((word >>> 10) & 0b11)
  //   bit  9     : padding                   ((word >>> 9)  & 0b1)
  //   bit  8     : private (ignored)
  //   bits 7..0  : channel mode / mode ext / copyright / original / emphasis
  //                — none of which influence frame length.

  const versionId = (word >>> 19) & 0b11;
  if (versionId !== 0b11) return null; // not MPEG-1

  const layer = (word >>> 17) & 0b11;
  if (layer !== 0b01) return null; // not Layer III

  const bitrateIndex = (word >>> 12) & 0b1111;
  const sampleRateIndex = (word >>> 10) & 0b11;
  const padding = ((word >>> 9) & 0b1) === 1;

  // Reject bitrate 0 (free) and 15 (reserved) explicitly via the table —
  // both slots are 0, which would also blow up the frame-length math if
  // we let it through.
  const bitrateBps = MPEG1_L3_BITRATES_BPS[bitrateIndex];
  if (!bitrateBps) return null;

  const sampleRateHz = MPEG1_SAMPLE_RATES_HZ[sampleRateIndex];
  if (!sampleRateHz) return null;

  // Math.floor of a non-negative number — `| 0` would also work but is
  // less self-documenting. The +0 for padding (false coerces to 0) keeps
  // the branch off the hot path.
  const frameLengthBytes =
    Math.floor((MPEG1_L3_FRAME_LENGTH_COEFFICIENT * bitrateBps) / sampleRateHz) + (padding ? 1 : 0);

  // Defensive: the minimum possible Layer III frame is 4 bytes (header
  // only at the lowest bitrate / highest sample rate combinations would
  // still be much larger, but better to assert than miscount).
  if (frameLengthBytes <= HEADER_SIZE_BYTES) return null;

  return {
    bitrateBps,
    sampleRateHz,
    padding,
    frameLengthBytes,
  };
}
