/**
 * Shared types for the MP3 frame parser.
 *
 * Kept in one place so the parser, header decoder, route, and tests can
 * import a single canonical definition of each shape. None of these types
 * are exposed in the public HTTP contract — that is intentionally minimal
 * (`{ frameCount: number }`) — but they are the public contract of the
 * `mp3` module.
 */

/**
 * Decoded fields of a 4-byte MPEG-1 Layer III frame header.
 *
 * Only the fields needed to compute frame length and validate the format
 * are surfaced. CRC, channel mode, mode extension, copyright, original,
 * and emphasis bits are not relevant to frame counting and are omitted
 * to keep the surface small.
 */
export interface FrameHeader {
  /** Bitrate of this frame, in bits per second. */
  readonly bitrateBps: number;
  /** Sampling frequency of this frame, in Hz. */
  readonly sampleRateHz: number;
  /** Padding flag — adds 1 byte to the frame length when set. */
  readonly padding: boolean;
  /** Total length of the frame in bytes, including the 4-byte header. */
  readonly frameLengthBytes: number;
}

/**
 * Result of a successful parse.
 *
 * `bytesScanned` is exposed primarily for diagnostics and tests — it lets
 * us verify, for example, that a streaming parse and an in-memory parse
 * consume the same number of bytes from the same input.
 */
export interface ParseResult {
  readonly frameCount: number;
  readonly bytesScanned: number;
}
