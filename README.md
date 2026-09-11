# Glossaray

Speech translation for a browser or an ESP32 handheld. Hold to speak, release
to hear the translation, and tap to repeat it.

[Try the web app](https://glossaray.alcun.dev) ·
[Device firmware](https://github.com/alcun/glossaray-device)

## Run your own

Install and start Docker, then:

```sh
git clone https://github.com/alcun/glossaray.git
cd glossaray
./setup
```

The script asks for your Gemini API key and public origin, generates a device
token, writes `.env`, and starts the server. Open `http://localhost:3000`.
On macOS, the script also supports a native Bun and Node setup.

Create a key in [Google AI Studio](https://aistudio.google.com/apikey).
Provider usage is subject to your account's billing and data terms. Configure
limits before exposing your own server publicly.

See [SELFHOSTING.md](SELFHOSTING.md) for HTTPS, configuration and device pairing.

## Languages

English to and from Welsh, Italian, Spanish, French, German, Polish, Turkish,
Russian, Japanese and Simplified Chinese. Supported pairs are defined in
`server/src/config.ts` and returned to both clients by the server.

## Architecture

One container serves the static Astro site and a Bun WebSocket server. Both
clients send audio through the same `/ws` endpoint. The server holds the Gemini
key, model selection and translation instruction.

The browser offers a device-style view and a wider conversation view. Both
use the same session controller. [DESIGN.md](DESIGN.md) describes the protocol,
audio formats and client behaviour.

## Audio and privacy

Glossaray streams audio to Google for translation. The server does not write
audio or transcripts to disk. Clients retain results in memory for display and
repeat playback; the browser conversation view keeps previous turns while open.
Provider-side processing and retention are governed by Google's terms.

The Gemini key stays on the server. A paired device stores a separate bearer
token, which grants access to that server and should be treated as a credential.

## Development

```sh
(cd web && npm ci)
bun test server/test web/test
npm run build --prefix web
```

Native server startup and environment settings are in
[SELFHOSTING.md](SELFHOSTING.md). Microphone permissions and physical-device
behaviour need browser and hardware checks in addition to automated tests.

## Licence

The server and website are [MIT licensed](LICENSE). The
[device firmware](https://github.com/alcun/glossaray-device) is GPL-3.0 and
includes separate third-party notices. Gemini is subject to Google's terms.
