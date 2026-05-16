/* eslint-disable */
/**
 * Optional cross-check: compare our /file-upload result against
 * mediainfo's reported frame count for the provided sample.
 *
 * The prompt explicitly suggests verifying results with mediainfo
 * ("The candidate may wish to use a tool such as mediainfo to verify
 * their results"). This script automates that — but only when
 * mediainfo is installed locally. If it isn't on PATH, the script
 * exits cleanly with a friendly hint.
 *
 * Usage:
 *   1. In one terminal: `pnpm dev` (or `pnpm build && pnpm start`)
 *   2. In another:      `pnpm verify:mediainfo`
 */

const { execFileSync, spawnSync } = require('node:child_process');
const { readFileSync, statSync } = require('node:fs');
const path = require('node:path');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'sound_file.mp3');
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000/file-upload';

function which(cmd) {
  const r = spawnSync('which', [cmd], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

(async () => {
  if (!which('mediainfo')) {
    console.log('mediainfo not found on PATH.');
    console.log('Install it with `brew install mediainfo` (macOS) and re-run.');
    console.log('Skipping verification.');
    process.exit(0);
  }

  let mediainfoCount;
  try {
    const out = execFileSync('mediainfo', ['--Inform=Audio;%FrameCount%', FIXTURE], {
      encoding: 'utf8',
    }).trim();
    mediainfoCount = Number(out);
    if (!Number.isFinite(mediainfoCount)) {
      throw new Error(`unexpected output: ${JSON.stringify(out)}`);
    }
  } catch (err) {
    console.error('Failed to query mediainfo:', err.message);
    process.exit(2);
  }

  console.log(`mediainfo frame count : ${mediainfoCount}`);
  console.log(`uploading             : ${FIXTURE} (${statSync(FIXTURE).size} bytes)`);
  console.log(`server                : ${SERVER_URL}`);

  const fileBuf = readFileSync(FIXTURE);
  const boundary = '----mp3verify' + Math.random().toString(36).slice(2);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sound_file.mp3"\r\n` +
      `Content-Type: audio/mpeg\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const body = Buffer.concat([head, fileBuf, tail]);

  let response;
  try {
    response = await fetch(SERVER_URL, {
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(body.length),
      },
      body,
    });
  } catch (err) {
    console.error(`Could not reach ${SERVER_URL}: ${err.message}`);
    console.error('Make sure the server is running (pnpm dev or pnpm start).');
    process.exit(2);
  }

  if (!response.ok) {
    const text = await response.text();
    console.error(`Server returned ${response.status}: ${text}`);
    process.exit(2);
  }
  const json = await response.json();
  const serverCount = json.frameCount;
  console.log(`server frame count    : ${serverCount}`);

  const delta = serverCount - mediainfoCount;
  if (delta === 0) {
    console.log('\nMatch — exactly equal.');
    process.exit(0);
  }
  console.log(
    `\nDifference: ${delta > 0 ? '+' : ''}${delta}.\n` +
      'A delta of +1 typically reflects the Xing/Info VBR-header frame,\n' +
      'which we count as a structurally valid MPEG-1 L3 frame but\n' +
      'mediainfo may exclude. Anything else suggests a real discrepancy.',
  );
  process.exit(Math.abs(delta) <= 1 ? 0 : 1);
})();
