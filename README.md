# MP3 Frame Counter

[![CI](https://github.com/JoshLuedeman/mp3-parser/actions/workflows/ci.yml/badge.svg)](https://github.com/JoshLuedeman/mp3-parser/actions/workflows/ci.yml)

HTTP API that accepts an MP3 upload and returns the number of MPEG-1 Audio Layer III frames it contains. Built with TypeScript and Fastify; the MP3 frame parser is implemented from scratch against the ISO/IEC 11172-3 bit layout.

```http
POST /file-upload
Content-Type: multipart/form-data

→ 200 OK
  Content-Type: application/json; charset=utf-8

  { "frameCount": 6089 }
```

## Requirements

- Node.js ≥ 20
- pnpm ≥ 9 (any package manager works; commands below use pnpm)

## Quick start

```bash
pnpm install
pnpm build
pnpm start            # production-style: serves the compiled output from dist/
# or
pnpm dev              # ts-node-dev with auto-reload
```

The server listens on `0.0.0.0:3000` by default (override with `PORT` / `HOST`).

### Try it

```bash
curl -F "file=@fixtures/sound_file.mp3" http://localhost:3000/file-upload
# {"frameCount":6089}
```

## Verifying the result

The repository includes the sample file at `fixtures/sound_file.mp3`. This service reports **6089** frames for it, which matches `mediainfo --Inform="Audio;%FrameCount%"` exactly. See [Xing/Info VBR-header frame](#xinginfo-vbr-header-frame) below for why this is the right number and how we get there.

> **Mediainfo is required to run the test suite.** Tests query it at runtime to derive the ground truth and assert `parserCount === mediainfoCount`. There is no hardcoded fallback. Install with `brew install mediainfo` (macOS) before running `pnpm test`.

Three ways to verify:

1. **Unit + integration tests** — `pnpm test` runs the full suite. The sample-file assertion is `parserCount === mediainfoCount`, with mediainfo shelled out at run time.
2. **Manual `curl`** — start the server and POST the sample as shown above.
3. **mediainfo cross-check script** — with the server running:
   ```bash
   pnpm verify:mediainfo
   ```
   Invokes `mediainfo --Inform="Audio;%FrameCount%"` on the sample, calls the running service, and prints both numbers side-by-side.

## Testing & quality gates

| Command                 | What it does                                              |
| ----------------------- | --------------------------------------------------------- |
| `pnpm test`             | Jest test suite (header decoder, parser, route)           |
| `pnpm lint`             | ESLint with `@typescript-eslint/recommended-type-checked` |
| `pnpm format:check`     | Prettier formatting verification                          |
| `pnpm build`            | TypeScript compile to `dist/`                             |
| `pnpm verify`           | All of the above, in order                                |
| `pnpm verify:mediainfo` | Optional external cross-check (see above)                 |

## API contract

### Request

`POST /file-upload`

| Field  | Where               | Type   | Required |
| ------ | ------------------- | ------ | -------- |
| `file` | multipart form-data | binary | yes      |

The handler accepts `audio/mpeg`, `audio/mp3`, or any file with a `.mp3` extension. Other content types are rejected with `415` before the upload is read.

### Responses

| Status | Body shape                                             | When                                     |
| ------ | ------------------------------------------------------ | ---------------------------------------- |
| 200    | `{ "frameCount": <integer> }`                          | Successfully counted frames              |
| 400    | `{ "error": { "code": "NO_FILE", ... } }`              | Multipart form had no file field         |
| 400    | `{ "error": { "code": "NO_VALID_FRAME", ... } }`       | Input contained no valid MPEG-1 L3 frame |
| 413    | `{ "error": { "code": "PAYLOAD_TOO_LARGE", ...}}`      | Upload exceeded `MAX_FILE_BYTES`         |
| 415    | `{ "error": { "code": "UNSUPPORTED_MEDIA_TYPE", ...}}` | Wrong content type / extension           |
| 500    | `{ "error": { "code": "INTERNAL_ERROR", ... } }`       | Anything unexpected                      |

All responses use `Content-Type: application/json; charset=utf-8`.

### Configuration

| Env var          | Default              | Purpose               |
| ---------------- | -------------------- | --------------------- |
| `PORT`           | `3000`               | TCP port to bind      |
| `HOST`           | `0.0.0.0`            | Bind address          |
| `MAX_FILE_BYTES` | `209715200` (200 MB) | Per-file upload limit |
| `LOG_LEVEL`      | `info`               | pino log level        |

## Design notes

### Streaming parser

The frame counter operates on a Node `Readable` stream, not a buffered `Buffer`. Fastify's `@fastify/multipart` exposes the uploaded file as a `Readable`, which we pipe straight into [`countFrames`](src/mp3/parser.ts). Memory stays flat (a few KB of working buffer) regardless of input size — the largest legitimate Layer III frame is ~1.4 KB.

This directly addresses the assignment's scalability criterion: a 10 GB upload would parse with the same memory footprint as the 1.4 MB sample.

### Header decoding

[`src/mp3/header.ts`](src/mp3/header.ts) is a pure function that validates the 4-byte frame header bit-by-bit: 11-bit sync, MPEG-1 version, Layer III, bitrate index (1..14), sample-rate index (0..2), and computes frame length via:

```
frameLength = floor(144 × bitrate / sampleRate) + padding
```

where `144 = samples_per_frame / 8`. The function returns `null` on any invalid header so the streaming parser can resync cheaply.

### Resync after garbage

Real-world MP3 files contain non-audio bytes in unexpected places (stale ID3 tags, encoder padding, truncated trailing frames). After locking onto the first frame, the parser jumps forward by `frameLengthBytes` and validates the header at the new position. On a mismatch, it falls back to a byte-by-byte scan for the next valid header within a 64 KB window. Every counted frame still passes full header validation — resync makes the parser robust without making it lenient.

### Xing/Info VBR-header frame

VBR-encoded MP3s (like the provided sample) place a Xing, Info, or VBRI metadata block in the side-info region of the **first** MPEG-1 L3 frame. Structurally that frame is a valid MPEG-1 L3 frame — correct sync, version, layer, sample rate, and length — but its 1152-sample audio payload is silence padding the metadata. Whether to count it is a design choice every implementation faces.

**This service does not count it.** That decision follows the de facto convention of the dominant MP3 ecosystem:

| Tool                                      | Reports for `sound_file.mp3` | Counts the Xing/Info frame? |
| ----------------------------------------- | :--------------------------: | :-------------------------: |
| **This service**                          |           **6089**           |             no              |
| `mediainfo --Inform=Audio;%FrameCount%`   |             6089             |             no              |
| `ffprobe -count_packets`                  |             6089             |             no              |
| `music-metadata` (via duration × SR/1152) |            ≈ 6089            |             no              |

The assignment names mediainfo as the verification tool, so we match its output exactly. The literal MPEG audio spec (ISO/IEC 11172-3 §2.4.3.4) defines a frame structurally and would justify counting it — but every consumer-grade MP3 tool excludes it, and "what every other tool reports" is what users expect.

Detection lives in [`src/mp3/vbrHeader.ts`](src/mp3/vbrHeader.ts): a pure function that probes byte offsets 21 (mono side-info) and 36 (stereo/JS/dual side-info, and the VBRI offset regardless of channel mode) of the first locked frame for the ASCII signatures `"Xing"`, `"Info"`, or `"VBRI"`. If a signature is found, the frame is excluded from the count.

### Out of scope

- **Non-MPEG-1-Layer-III formats.** MPEG-2, MPEG-2.5, Layer I, Layer II files are rejected with `NO_VALID_FRAME`. The assignment explicitly scopes these out.
- **Free-format MP3.** Bitrate index 0 is rejected; vanishingly rare in the wild.

### What I'd do with more time

- Parse the Xing TOC and surface VBR-specific frame-count info as an optional metadata field.
- Add a small benchmark harness to characterize throughput on real hardware (the parser is fast — sub-millisecond per MB on this machine — but the number should be reproducible).
- Provide a Dockerfile and a minimal CI pipeline (lint + test + build).
- Expose an OpenAPI schema (Fastify makes this trivial with `@fastify/swagger`).
- Support batch uploads with a streaming JSON response, for use cases where a client wants to enumerate many files in one round trip.

## Repository layout

```
src/
  server.ts              # bootstrap + graceful shutdown
  app.ts                 # buildApp() factory (shared by server + tests)
  routes/fileUpload.ts   # POST /file-upload handler
  mp3/
    parser.ts            # streaming countFrames(BufferStream)
    header.ts            # 4-byte header decoder (pure)
    vbrHeader.ts         # Xing/Info/VBRI detection (pure)
    tables.ts            # MPEG-1 L3 bitrate & sample-rate tables
    types.ts             # FrameHeader, ParseResult
  config.ts              # env-var validators (PORT/HOST/LOG_LEVEL/MAX_FILE_BYTES)
  errors.ts              # typed HTTP errors + mapError()
  logger.ts              # pino logger
test/                    # jest suites
fixtures/
  sound_file.mp3         # provided sample
scripts/
  verify-mediainfo.js    # optional mediainfo cross-check
```
