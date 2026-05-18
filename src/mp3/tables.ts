/**
 * Lookup tables for MPEG-1 Audio Layer III frame header decoding.
 *
 * The MPEG audio specification (ISO/IEC 11172-3) defines several constant
 * tables that the decoder needs to interpret the 4-byte frame header at the
 * start of each audio frame. The tables here are scoped intentionally narrowly
 * to MPEG Version 1, Layer III — the only format this service is required to
 * support per the assignment ("MPEG Version 1 Audio Layer 3").
 *
 * Why this is its own module:
 *   - The values are domain knowledge (not derivable from the code itself),
 *     so isolating them makes the parser easier to read.
 *   - Keeping the tables `as const` lets TypeScript narrow them to literal
 *     types and gives us index-out-of-range safety with
 *     `noUncheckedIndexedAccess`.
 */

/**
 * MPEG-1 Layer III bitrate table, in **bits per second**.
 *
 * Indexed by the 4-bit `bitrate_index` field (bits 12–15 of the header).
 *
 *   - Index 0 (`0000`) is the "free format" bitrate. Free format is
 *     theoretically valid but vanishingly rare in practice (no major encoder
 *     produces it). We treat it as invalid because (a) the frame length
 *     formula requires a known bitrate and (b) the assignment scope is
 *     standard MPEG-1 L3 files.
 *   - Index 15 (`1111`) is reserved/invalid per the spec. Always reject.
 *
 * Values are written in bits per second (not kbps) so the frame-length
 * formula `floor(144 * bitrate / sampleRate) + padding` operates directly
 * without unit conversion.
 */
export const MPEG1_L3_BITRATES_BPS = [
  0, // 0000 - free format (unsupported)
  32_000,
  40_000,
  48_000,
  56_000,
  64_000,
  80_000,
  96_000,
  112_000,
  128_000,
  160_000,
  192_000,
  224_000,
  256_000,
  320_000,
  0, // 1111 - reserved/invalid
] as const;

/**
 * MPEG-1 sample rate table, in **Hz**.
 *
 * Indexed by the 2-bit `sampling_frequency` field (bits 10–11 of the header).
 *
 *   - Index 3 (`11`) is reserved per the spec — always reject.
 */
export const MPEG1_SAMPLE_RATES_HZ = [44_100, 48_000, 32_000, 0] as const;

/**
 * MPEG-1 Layer III always produces 1152 PCM samples per frame.
 *
 * The frame-length formula uses `samples_per_frame / 8 = 144` as the
 * "magic constant" multiplier (Layer III packs 1152 samples into one
 * frame; dividing by 8 converts the bit count to bytes after
 * multiplying by `bitrate / sample_rate`).
 */
export const MPEG1_L3_SAMPLES_PER_FRAME = 1152;

/**
 * Frame-length formula coefficient for MPEG-1 Layer III.
 *
 * `frameLengthBytes = floor(coefficient * bitrate / sampleRate) + padding`
 *
 * For Layer III this is `samples_per_frame (1152) / 8 = 144`.
 * Other layers (I, II) and MPEG-2 use different coefficients; this constant
 * is only valid for the format we support.
 */
export const MPEG1_L3_FRAME_LENGTH_COEFFICIENT = 144;
