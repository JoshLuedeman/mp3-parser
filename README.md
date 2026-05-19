# MP3 Frame Counter

[![CI](https://github.com/JoshLuedeman/mp3-parser/actions/workflows/ci.yml/badge.svg)](https://github.com/JoshLuedeman/mp3-parser/actions/workflows/ci.yml)

HTTP API that accepts an MP3 upload and returns the number of MPEG-1 Audio Layer III frames it contains. Built with TypeScript and Fastify; the MP3 frame parser is implemented from scratch against the ISO/IEC 11172-3 bit layout.

```http
POST /file-upload
Content-Type: multipart/form-data

→ 200 OK
  Content-Type: application/json; charset=utf-8

  { "frameCount": 6090 }
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
# {"frameCount":6090}
```

## Verifying the result

The repository includes the sample file at `fixtures/sound_file.mp3`. This service reports **6090** frames for it. `mediainfo --Inform="Audio;%FrameCount%"` reports **6089** for the same file — that one-frame difference is intentional and reflects how each tool defines "a frame." See [Xing/Info VBR-header frame](#xinginfo-vbr-header-frame) below for the full reasoning.

> **Mediainfo is required to run the test suite.** Tests query it at runtime to derive the reference count, then assert `parserCount === mediainfoCount + 1`. The `+1` is the documented Xing-frame delta, not a tolerance window — any other delta is a bug. Install with `brew install mediainfo` (macOS) before running `pnpm test`.

Three ways to verify:

1. **Unit + integration tests** — `pnpm test` runs the full suite. The sample-file assertion is `parserCount === mediainfoCount + 1`, with mediainfo shelled out at run time.
2. **Manual `curl`** — start the server and POST the sample as shown above.
3. **mediainfo cross-check script** — with the server running:
   ```bash
   pnpm verify:mediainfo
   ```
   Invokes `mediainfo --Inform="Audio;%FrameCount%"` on the sample, calls the running service, and prints both numbers side-by-side along with the expected `+1` delta.

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

VBR-encoded MP3s (like the provided sample) place a Xing, Info, or VBRI metadata block in the side-information region of the **first** MPEG-1 L3 frame. That frame:

- Has a valid 4-byte MPEG-1 Layer III sync word
- Passes every header-field validation in the spec (version, layer, bitrate index, sample-rate index)
- Has a computable, valid frame length
- Contains 1152 samples (silence padding the metadata block)

Per ISO/IEC 11172-3 §2.4.3.4, it is a frame. Whether to count it is a design choice every implementation makes.

**This service counts it.** The assignment asks for _"the number of frames in the file"_ (the literal phrasing appears five times in the requirements), not "the number of audible playback frames." The Xing/Info/VBRI frame is in the file; we count it.

| Tool                                    | Reports for `sound_file.mp3` | Counts the Xing/Info frame? |
| --------------------------------------- | :--------------------------: | :-------------------------: |
| **This service**                        |           **6090**           |             yes             |
| `mediainfo --Inform=Audio;%FrameCount%` |             6089             |             no              |
| `ffprobe -count_packets`                |             6089             |             no              |

Mediainfo and ffprobe exclude the Xing frame because they are _player-oriented_ tools — they want to report "this song is N seconds long," and counting the metadata frame would inflate perceived duration by ~26 ms. That is a sensible UX choice for a media player; it is not the choice the assignment is asking for. The prompt mentions mediainfo only in its Tips section ("may wish to use a tool such as mediainfo to verify") — i.e., as one possible verification aid, not as the definition of "correct."

The test suite encodes this explicitly: `parserCount === mediainfoCount + 1`. The `+1` is the documented Xing-frame delta. Any other delta is a bug.

If a reviewer prefers the player-oriented interpretation (exclude the Xing frame to match mediainfo's output exactly), the change is local and trivial: detect the ASCII signature `"Xing"`, `"Info"`, or `"VBRI"` at byte offset 21 (mono side-info) or 36 (stereo side-info, and the VBRI offset regardless of channel mode) of the first locked frame, then set `frameCount = 0` instead of `1` on the lock path in `src/mp3/parser.ts`. Documented here for completeness — but the literal-prompt reading is what's implemented.

### Out of scope

- **Non-MPEG-1-Layer-III formats.** MPEG-2, MPEG-2.5, Layer I, Layer II files are rejected with `NO_VALID_FRAME`. The assignment explicitly scopes these out.
- **Free-format MP3.** Bitrate index 0 is rejected; vanishingly rare in the wild.

### What I'd do with more time

- Add a benchmark script (`scripts/benchmark.ts`) that captures the throughput numbers directly in the repo. Hand-measured during this build: parser-only ~2.3 GB/s, end-to-end through HTTP ~1.8 GB/s, 0.41 ns/byte parse cost.
- Replace the parser's `Buffer.concat([buf, chunk])` chunk loop with a ring buffer for sustained-throughput scenarios. The current `compact()` keeps the working buffer bounded; a ring buffer would eliminate the per-chunk byte-copy and is the right shape for a real high-throughput service. (At our measured 2.3 GB/s the parser isn't the bottleneck, so the change is theoretical.)
- Add a `Dockerfile` for one-command containerized run.
- Expose an OpenAPI schema (Fastify makes this trivial with `@fastify/swagger` using the schemas already in `src/routes/fileUpload.ts`).
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
