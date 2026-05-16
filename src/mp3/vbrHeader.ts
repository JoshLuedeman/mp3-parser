/**
 * Detection of Xing / Info / VBRI VBR-header frames.
 *
 * VBR-encoded MP3s embed metadata (frame count, byte count, table of
 * contents, encoder quality, etc.) in the side-information region of
 * the first audio frame. That frame is structurally a valid MPEG-1
 * Layer III frame — correct sync, version, layer, length — but its
 * audio payload is silence padding the metadata. Mainstream MP3 tools
 * exclude this frame from their reported frame count:
 *
 *   mediainfo --Inform="Audio;%FrameCount%"  → excludes
 *   ffprobe -count_packets                   → excludes
 *   music-metadata (duration-based)          → excludes
 *
 * The prompt names mediainfo as the verification tool, so we follow
 * the same convention: detect and skip the VBR-header frame on the
 * initial lock so the reported count matches the dominant ecosystem.
 *
 * Pure module: no I/O, no streaming awareness. Takes a buffer and a
 * frame offset, returns a boolean. Keeping the detection isolated
 * here makes it trivially testable and keeps the streaming parser
 * focused on streaming.
 */

/**
 * Offsets of the magic within the frame, measured from the start of
 * the 4-byte frame header.
 *
 * MPEG-1 side-information length depends on channel mode:
 *   - Mono                       → 17 bytes → Xing/Info magic at byte 4 + 17 = 21
 *   - Stereo / Joint / Dual      → 32 bytes → Xing/Info magic at byte 4 + 32 = 36
 *   - VBRI (Fraunhofer)          → always at byte 4 + 32 = 36, regardless
 *
 * We probe both candidate offsets rather than decoding the channel
 * mode and dispatching. The signatures are 4-byte ASCII tags at fixed
 * positions in the very first audio frame; false positives from real
 * audio data at exactly these offsets are essentially impossible.
 *
 * Typed via `as const` so the inferred type is `readonly [21, 36]` —
 * iteration yields `21 | 36`, not `number | undefined`, so we keep
 * full `noUncheckedIndexedAccess` safety with no escape hatches.
 */
const CANDIDATE_OFFSETS = [21, 36] as const;

/**
 * Known VBR-header magic strings. Kept as a `readonly string[]` so we
 * can use `.includes()` without losing literal-type narrowing on the
 * tag we read from the buffer.
 */
const VBR_MAGICS: readonly string[] = ['Xing', 'Info', 'VBRI'];

/** Length of the magic in bytes. */
const MAGIC_LENGTH = 4;

/**
 * Does the frame starting at `frameOffset` in `buf` carry a Xing /
 * Info / VBRI VBR-header signature?
 *
 * @param buf          Buffer containing the frame to inspect.
 * @param frameOffset  Offset of the frame's first byte (the `0xFF` of
 *                     the sync word) within `buf`. The caller must
 *                     guarantee `buf` extends at least
 *                     `frameOffset + 40` bytes so both candidate
 *                     positions can be probed.
 * @returns `true` if either candidate offset matches a known VBR
 *          magic; `false` otherwise.
 */
export function isVbrHeaderFrame(buf: Buffer, frameOffset: number): boolean {
  for (const offset of CANDIDATE_OFFSETS) {
    const tagStart = frameOffset + offset;
    const tagEnd = tagStart + MAGIC_LENGTH;
    if (tagEnd > buf.length) continue;
    const tag = buf.toString('ascii', tagStart, tagEnd);
    if (VBR_MAGICS.includes(tag)) return true;
  }
  return false;
}
