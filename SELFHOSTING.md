# Running your own Glossaray

One container. It serves the page and the `/ws` socket together. No database.

## 1. Start it

```sh
git clone https://github.com/alcun/glossaray
cd glossaray
./setup
```

`./setup` asks for your Gemini key and your public origin, then:

- generates a random 64-character device token
- writes `.env` at mode 0600
- uses Docker if Docker is running; on macOS it can instead install Bun and
  Node with Homebrew, build the page and start the server directly

On Linux, install Docker before using `./setup`. The manual native development
commands below require both Bun and Node/npm.

Open <http://localhost:3000>.

To do it by hand instead:

```sh
cp .env.example .env
# edit .env
docker compose up -d --build
```

## 2. Get a Gemini key

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
2. Create a key.
3. Paste it when `./setup` asks, or put it in `.env` as `GEMINI_API_KEY`.

Review the billing settings and usage limits for your provider account.
Application limits do not guarantee a monetary spending cap.

Without a key, translation sessions are refused with `unconfigured`.

## 3. Put it on a domain

Use HTTPS for hosted microphone access and device connections. Browsers also
permit microphone access on localhost for development. Plain HTTP on a local
network address is not a secure context.

Put Caddy, nginx, Traefik or a tunnel in front of the container, then set:

| Variable | Set to |
|---|---|
| `PUBLIC_SITE_URL` | Your address. **Baked at build time**, so rebuild after changing it |
| `GLOSSARAY_ALLOWED_ORIGINS` | Your address, comma separated if several |

`GLOSSARAY_ALLOWED_ORIGINS` stops another browser page pointing at your
translator: browser JavaScript cannot forge `Origin`. It is not authentication
against scripts or custom WebSocket clients. If the service is open to the
internet, use application limits together with the controls available in your provider
account. **Leaving the list empty allows any browser
origin and is for local development only.**

Rebuild after changing `PUBLIC_SITE_URL`:

```sh
docker compose up -d --build
```

## 4. Pair a device

The board opens `/ws` with `Authorization: Bearer <GLOSSARAY_DEVICE_TOKEN>` and
speaks the same protocol as the browser.

1. Read the token out of your `.env`.
2. Flash [`alcun/glossaray-device`](https://github.com/alcun/glossaray-device).
3. Give it your server's address and that token when it asks.

Rotate the token by changing it in `.env`, restarting, and reflashing the board.

## Settings

Required:

| Name | Purpose |
|---|---|
| `GEMINI_API_KEY` | Your server-side Gemini key |
| `GLOSSARAY_ALLOWED_ORIGINS` | Origins allowed to open a socket |

Optional:

| Name | Default | Purpose |
|---|---:|---|
| `GLOSSARAY_DEVICE_TOKEN` | none | Bearer credential for an ESP32. Needed only if you build one |
| `PORT` | `3000` | |
| `GLOSSARAY_PUBLIC_DIR` | `./public` | Where the built page lives |
| `GLOSSARAY_MAX_SESSIONS` | `3` | Concurrent live sessions |
| `GLOSSARAY_RATE_LIMIT` | `30` | New sessions per address per window |
| `GLOSSARAY_RATE_WINDOW_MS` | `3600000` | That window |
| `GLOSSARAY_DAILY_SESSIONS` | `300` | Global provider-session starts per 24-hour process window |
| `GLOSSARAY_TRUST_PROXY` | `false` | Trust `X-Forwarded-For`; only behind a proxy you control |
| `GLOSSARAY_MAX_SESSION_MS` | `300000` | Hard session lifetime |
| `GLOSSARAY_MAX_INPUT_BYTES` | `3840000` | About 120 seconds of input audio |
| `GLOSSARAY_MAX_FRAME_BYTES` | `32000` | Largest accepted audio frame |
| `GLOSSARAY_IDLE_MS` | `60000` | Dropped after this much client silence |

The global session limit bounds what this process can start; it resets on
restart and is not shared between replicas. It is not a durable billing
limit. The other ceilings bound session duration and audio volume. Forwarding headers are attacker-chosen
unless a trusted proxy overwrites them, so leave trusted-proxy mode off on a
directly exposed container.

## Development

Install Bun and Node/npm. From the repository root:

```sh
(cd web && npm ci)
npm run build --prefix web
bun test server/test web/test
```

Create `.env` from `.env.example` and set your provider key, then start:

```sh
GLOSSARAY_PUBLIC_DIR=./web/dist bun run server/src/index.ts
```

For browser development, use localhost or HTTPS and test microphone permission,
capture and playback in the target browser. Automated session tests do not
replace real microphone or physical-device checks.
