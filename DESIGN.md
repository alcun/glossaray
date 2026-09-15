# Architecture and protocol

## Server

A Bun process serves the static website, HTTP endpoints and WebSocket sessions.
Both the browser and ESP32 use `/ws`. Gemini credentials, model selection,
language pairs and the translation instruction are server-side configuration.

- `server/src/index.ts`: HTTP routes and WebSocket lifecycle.
- `server/src/config.ts`: language pairs, audio rates and limits.
- `server/src/gate.ts`: admission and usage counters.
- `server/src/gemini.ts`: upstream connection and audio conversion.
- `server/src/device.ts`: device credential validation.

## HTTP endpoints

- `GET /health`: the same liveness as `{status, service, version}`, with the
  version from `server/package.json`.
- `GET /healthz`: server liveness without starting a provider session.
- `GET /v1/pairs`: supported language pairs and audio configuration.
- `/ws`: WebSocket upgrade for a translation session.

## WebSocket messages

Client to server:

| Message | Purpose |
|---|---|
| `{"type":"start","source":"en","target":"cy","mode":"agent"}` | Start translation |
| `{"type":"end_turn"}` | Finish the input turn |
| Binary frame | Signed 16-bit mono PCM at 16 kHz |

Server to client:

| Message | Purpose |
|---|---|
| `{"type":"hello","outputSampleRate":24000}` | Connection accepted |
| `{"type":"ready"}` | Upstream ready to receive audio |
| `{"type":"heard","text":"..."}` | Input transcript |
| `{"type":"said","text":"..."}` | Output transcript |
| `{"type":"turn_complete"}` | Translation finished |
| `{"type":"error","code":"..."}` | Session error |
| Binary frame | Signed 16-bit mono PCM at 24 kHz |

The client buffers captured audio until `ready`. Conversion between binary PCM
and the provider's base64 messages happens on the server.

## Browser audio and interaction

Capture and playback use separate AudioContexts at 16 kHz and 24 kHz.
Microphone echo cancellation, noise suppression and automatic gain control
are disabled. Playback waits until the user releases the talk control.

`web/src/scripts/session.ts` owns session state. The device and conversation
views render that state. A short tap repeats the previous result; a hold starts
capture and opens a session after the hold threshold. Microphone tracks are
released after a short idle period between turns.

The device view uses a 368 × 448 layout matching the handheld. Translation
text wraps by character cells and scrolls when it exceeds seven lines. The
conversation view displays transcripts as they arrive and retains previous
turns while the page remains open.

## Access and limits

Browser upgrades are checked against the configured Origin list. This prevents
cross-site browser use but is not authentication against custom clients.
Devices authenticate using `Authorization: Bearer <device-token>`.

Provider sessions start only after a valid start message. Unstarted sockets
close after ten seconds. Limits cover concurrency, session starts per address,
process-wide starts, session duration, input bytes, frame size and idle time.
Counters are in memory, reset on restart and are not shared between replicas.

Forwarded client addresses are trusted only when explicitly configured. See
[SELFHOSTING.md](SELFHOSTING.md) for deployment settings and their defaults.

## Verification

Server tests cover configuration, credentials and admission limits. Browser
tests cover session gestures, buffering and text wrapping. Physical microphone,
speaker and display behaviour require separate validation on the target device.
