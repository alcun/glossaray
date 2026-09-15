/** Serve the static website and proxy browser/device audio over WebSockets. */
import pkg from "../package.json";
import { GeminiSession } from "./gemini";
import { createGate } from "./gate";
import { deviceIsAuthorized } from "./device";
import { limits, supportedPairs, OUTPUT_SAMPLE_RATE, INPUT_SAMPLE_RATE } from "./config";

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const PUBLIC_DIR = process.env.GLOSSARAY_PUBLIC_DIR ?? "./public";
const API_KEY = process.env.GEMINI_API_KEY ?? "";
const DEVICE_TOKEN = process.env.GLOSSARAY_DEVICE_TOKEN ?? "";

/**
 * Origins allowed to open a socket. A browser sends Origin on a WebSocket
 * upgrade and cannot forge it, so this stops another site from pointing its
 * own page at this translator and spending the balance. Empty means allow any,
 * which is only for local development.
 */
const ALLOWED_ORIGINS = (process.env.GLOSSARAY_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TRUST_PROXY = process.env.GLOSSARAY_TRUST_PROXY === "true";

const gate = createGate();

/** Direct socket addresses are authoritative. Forwarded addresses are accepted
 * only when the operator explicitly declares a trusted reverse proxy. */
function clientAddress(request: Request, server: any): string {
  if (!TRUST_PROXY) return server.requestIP(request)?.address ?? "direct";
  const header = request.headers.get("x-forwarded-for");
  const entries = header?.split(",").map((s) => s.trim()).filter(Boolean);
  return entries && entries.length > 0 ? entries[entries.length - 1]! : "local";
}

interface SocketData {
  address: string;
  session: GeminiSession | null;
  admitted: boolean;
  startTimer: ReturnType<typeof setTimeout> | null;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const server = Bun.serve<SocketData, {}>({
  port: PORT,
  idleTimeout: 120,

  async fetch(request, server) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      const origin = request.headers.get("origin");
      const browserAllowed = origin !== null &&
        (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin));
      const deviceAllowed = deviceIsAuthorized(
        request.headers.get("authorization"), DEVICE_TOKEN,
      );
      if (!browserAllowed && !deviceAllowed) {
        return new Response("forbidden", { status: 403 });
      }
      const ok = server.upgrade(request, {
        data: {
          address: clientAddress(request, server),
          session: null,
          admitted: false,
          startTimer: null,
        },
      });
      return ok ? undefined : new Response("expected a websocket", { status: 426 });
    }

    // Unauthenticated liveness for the container healthcheck. Touches no
    // provider: a health check that fails when Google is down would get the
    // container restarted, which fixes nothing.
    if (url.pathname === "/healthz") return json({ ok: true });
    if (url.pathname === "/health") return json({ status: "ok", service: "glossaray", version: pkg.version });

    // What the page needs to build its language menu, derived from the same
    // sets the server enforces, so the UI cannot offer a pair that is refused.
    if (url.pathname === "/v1/pairs") {
      return json({
        pairs: supportedPairs(),
        inputSampleRate: INPUT_SAMPLE_RATE,
        outputSampleRate: OUTPUT_SAMPLE_RATE,
      });
    }

    // Static page. Bun.file streams and sets content-type; a directory or a
    // missing file falls back to index.html so the page owns its own routing.
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(`${PUBLIC_DIR}${path}`);
    if (await file.exists()) {
      return new Response(file, {
        headers: {
          "cache-control": path === "/index.html" ? "no-cache" : "public, max-age=3600",
        },
      });
    }
    const index = Bun.file(`${PUBLIC_DIR}/index.html`);
    if (await index.exists()) return new Response(index, { headers: { "cache-control": "no-cache" } });
    return new Response("not found", { status: 404 });
  },

  websocket: {
    maxPayloadLength: limits.maxFrameBytes + 1024,

    open(ws) {
      ws.data.startTimer = setTimeout(() => {
        if (!ws.data.session) ws.close(1008, "start_timeout");
      }, 10_000);
      ws.send(JSON.stringify({ type: "hello", outputSampleRate: OUTPUT_SAMPLE_RATE }));
    },

    message(ws, message) {
      // Binary is audio and nothing else. Anything else is a small control
      // message, and the client can say exactly two things.
      if (message instanceof Uint8Array || message instanceof ArrayBuffer) {
        const frame = message instanceof ArrayBuffer ? new Uint8Array(message) : message;
        ws.data.session?.sendAudio(frame);
        return;
      }

      let parsed: any;
      try {
        parsed = JSON.parse(String(message));
      } catch {
        return;
      }

      if (parsed?.type === "start") {
        if (ws.data.session) return; // one session per socket
        if (ws.data.startTimer) clearTimeout(ws.data.startTimer);
        ws.data.startTimer = null;
        const gateError = gate.admit(ws.data.address);
        if (gateError) {
          ws.send(JSON.stringify({ type: "error", code: gateError }));
          ws.close(1013, gateError);
          return;
        }
        ws.data.admitted = true;
        const session = new GeminiSession(API_KEY, {
          onAudio: (pcm) => ws.send(pcm),
          onEvent: (event) => ws.send(JSON.stringify(event)),
          onClose: (reason) => {
            ws.send(JSON.stringify({ type: "error", code: reason }));
            ws.close(1011, reason);
          },
        });
        const error = session.start(parsed.source, parsed.target, parsed.mode);
        if (error) {
          gate.reject();
          ws.data.admitted = false;
          ws.send(JSON.stringify({ type: "error", code: error }));
          ws.close(1008, error);
          return;
        }
        ws.data.session = session;
        return;
      }

      if (parsed?.type === "end_turn") ws.data.session?.endTurn();
    },

    close(ws) {
      if (ws.data.startTimer) clearTimeout(ws.data.startTimer);
      ws.data.startTimer = null;
      ws.data.session?.close();
      ws.data.session = null;
      if (ws.data.admitted) {
        gate.release();
        ws.data.admitted = false;
      }
    },
  },
});

console.log(
  JSON.stringify({
    event: "listening",
    port: server.port,
    gemini_configured: API_KEY.length > 0,
    max_sessions: limits.maxSessions,
    origins: ALLOWED_ORIGINS.length,
    trust_proxy: TRUST_PROXY,
    daily_sessions: limits.dailySessions,
  }),
);
