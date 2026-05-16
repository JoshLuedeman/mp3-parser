/**
 * Unit tests for the VBR-header frame detector.
 *
 * The module is small and pure, so the tests are exhaustive about the
 * accept/reject surface: every known magic string is detected at every
 * candidate offset, anything else is rejected, and bounds-checks hold
 * when the buffer is too short to contain the candidate offsets.
 */

import { isVbrHeaderFrame } from '../src/mp3/vbrHeader';

/**
 * Build a synthetic frame buffer with a 4-byte ASCII tag placed at a
 * specific offset from the frame start. The rest of the buffer is
 * zero-padded; the actual frame header bytes are irrelevant here
 * because `isVbrHeaderFrame` only inspects the side-info region.
 */
function frameWithTagAt(offset: number, tag: string, frameLength = 417): Buffer {
  const frame = Buffer.alloc(frameLength);
  frame.write(tag, offset, 'ascii');
  return frame;
}

describe('isVbrHeaderFrame', () => {
  describe('detects each known magic at the mono side-info offset (21)', () => {
    test.each(['Xing', 'Info', 'VBRI'])('%s at offset 21', (tag) => {
      const buf = frameWithTagAt(21, tag);
      expect(isVbrHeaderFrame(buf, 0)).toBe(true);
    });
  });

  describe('detects each known magic at the stereo side-info offset (36)', () => {
    test.each(['Xing', 'Info', 'VBRI'])('%s at offset 36', (tag) => {
      const buf = frameWithTagAt(36, tag);
      expect(isVbrHeaderFrame(buf, 0)).toBe(true);
    });
  });

  test('returns false for a frame of all zeros', () => {
    expect(isVbrHeaderFrame(Buffer.alloc(417), 0)).toBe(false);
  });

  test('returns false for a frame of random non-magic bytes at candidate offsets', () => {
    const buf = Buffer.alloc(417);
    buf.write('AAAA', 21, 'ascii');
    buf.write('BBBB', 36, 'ascii');
    expect(isVbrHeaderFrame(buf, 0)).toBe(false);
  });

  test('uses frameOffset to position the probe (magic relative to frame, not buffer)', () => {
    // Build "prefix bytes" + a frame whose VBR magic sits at the
    // correct *relative* offset. The detector must apply frameOffset.
    const prefix = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const frame = frameWithTagAt(36, 'Xing');
    const combined = Buffer.concat([prefix, frame]);

    expect(isVbrHeaderFrame(combined, prefix.length)).toBe(true);
    // Same buffer, wrong frameOffset → magic falls outside candidate
    // positions, so it must not match.
    expect(isVbrHeaderFrame(combined, 0)).toBe(false);
  });

  test('returns false (not throw) when the buffer is too short to probe', () => {
    // Buffer truncated before offset 21 — the function should bail
    // gracefully via its bounds check, not crash.
    expect(isVbrHeaderFrame(Buffer.alloc(10), 0)).toBe(false);
  });

  test('rejects lowercase or mixed-case variants (signatures are case-sensitive)', () => {
    expect(isVbrHeaderFrame(frameWithTagAt(36, 'xing'), 0)).toBe(false);
    expect(isVbrHeaderFrame(frameWithTagAt(36, 'XING'), 0)).toBe(false);
    expect(isVbrHeaderFrame(frameWithTagAt(36, 'XiNg'), 0)).toBe(false);
  });
});
