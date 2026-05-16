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
 * Quick sync-word check on two bytes.
 *
 * The first 11 bits of any MPEG audio frame are `1`s ("frame sync"). That
 * means byte 0 is always `0xFF` and the top 3 bits of byte 1 are `111`.
 * This predicate is hot — it is called once per byte during resync scans —
 * so it is intentionally a single expression with no allocations.
 *
 * Note we check 11 bits, not 12. The 12-bit sync (`1111 1111 1111`) is
 * sometimes quoted, but the official spec says the sync word is 11 bits
 * and the 12th bit is the version ID. Either definition catches the same
 * candidate positions; we still validate the version bit explicitly below.
 */
export function isSyncWord(byte0: number, byte1: number): boolean {
  return byte0 === 0xff && (byte1 & 0xe0) === 0xe0;
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
  // Bounds check up front so subsequent index reads are safe under
  // `noUncheckedIndexedAccess`. Returning null here lets the caller treat
  // "not enough bytes" the same as "not a valid header" — both mean
  // "advance the input and try again later."
  if (buf.length - offset < HEADER_SIZE_BYTES) {
    return null;
  }

  const b0 = buf[offset]!;
  const b1 = buf[offset + 1]!;
  const b2 = buf[offset + 2]!;
  // b3 is intentionally unread — channel mode / emphasis bits are not
  // needed for frame counting. Leaving the read out keeps the function
  // honest about which bits actually influence the result.

  if (!isSyncWord(b0, b1)) return null;

  // Version ID is the two bits immediately after the 11-bit sync.
  // Layout of b1:  1 1 1 V V L L P    where V V = version, L L = layer,
  //                                    P = protection bit.
  const versionId = (b1 >> 3) & 0b11;
  if (versionId !== 0b11) return null; // not MPEG-1

  const layer = (b1 >> 1) & 0b11;
  if (layer !== 0b01) return null; // not Layer III

  // b2 layout:  B B B B F F D X
  //   B = bitrate index (4 bits)
  //   F = sampling-frequency index (2 bits)
  //   D = padding bit
  //   X = private bit (ignored)
  const bitrateIndex = (b2 >> 4) & 0b1111;
  const sampleRateIndex = (b2 >> 2) & 0b11;
  const padding = ((b2 >> 1) & 0b1) === 1;

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
    Math.floor((MPEG1_L3_FRAME_LENGTH_COEFFICIENT * bitrateBps) / sampleRateHz) +
    (padding ? 1 : 0);

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
