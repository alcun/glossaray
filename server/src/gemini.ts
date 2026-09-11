/**
 * One Gemini Live session, proxied.
 *
 * The permanent API key never leaves this process and the client is handed
 * nothing: no token, no model name, no session URL. That is the whole reason
 * this proxies for both browser and device. It also means the client cannot be
 * trusted, so every message is validated here and nothing is forwarded verbatim.
 *
 * Audio on the wire is BINARY in both directions - raw 16-bit PCM, 16kHz in and
 * 24kHz out. Gemini wants base64 inside JSON, so the encoding happens here and
 * the browser never pays for it.
 *
 * This is the one provider boundary. Neither client contains Gemini protocol.
 */
import {
  GEMINI_HOST,
  setupMessage,
  pairIsSupported,
  limits,
  type Mode,
} from "./config";

export interface SessionHooks {
  /** Audio back from Gemini: raw 24kHz PCM, ready to play. */
  onAudio(pcm: Uint8Array): void;
  /** Small JSON events: ready, transcripts, turn boundaries, errors. */
  onEvent(event: Record<string, unknown>): void;
  /** Terminal. The socket to the client is closed by the caller. */
  onClose(reason: string): void;
}

type Phase = "connecting" | "ready" | "closed";

export class GeminiSession {
  private upstream: WebSocket | null = null;
  private phase: Phase = "connecting";
  private inputBytes = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private lastClientMessage = Date.now();
  private turnEnded = false;

  constructor(
    private readonly apiKey: string,
    private readonly hooks: SessionHooks,
  ) {}

  /**
   * Validate the client's opening message and connect. Returns an error code
   * rather than throwing, because every one of these is a client mistake and
   * the client is told a stable code, never an upstream detail.
   */
  start(source: unknown, target: unknown, mode: unknown): string | null {
    if (typeof source !== "string" || typeof target !== "string") return "invalid_request";
    if (mode !== "agent") return "invalid_request";
    if (!pairIsSupported(source, target, mode)) return "unsupported_pair";
    if (!this.apiKey) return "unconfigured";

    // The key travels in the query string because that is what the Live API
    // accepts. It never reaches a log line here: nothing logs a URL.
    const url =
      `wss://${GEMINI_HOST}/ws/google.ai.generativelanguage.v1beta` +
      `.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(this.apiKey)}`;

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      return "upstream_unavailable";
    }
    socket.binaryType = "arraybuffer";
    this.upstream = socket;

    socket.onopen = () => {
      socket.send(setupMessage(source, target, mode as Mode));
    };
    socket.onmessage = (event) => this.handleUpstream(event.data);
    socket.onerror = () => this.fail("upstream_unavailable");
    socket.onclose = (event) => {
      // Keep bounded upstream diagnostics on the server; clients receive a code.
      if (this.phase !== "closed") {
        console.log(
          JSON.stringify({
            event: "upstream_closed",
            code: event.code,
            reason: String(event.reason ?? "").slice(0, 300),
            phase: this.phase,
          }),
        );
      }
      this.fail("upstream_closed");
    };

    // Two ceilings that do not depend on either end behaving.
    this.timers.push(
      setTimeout(() => this.fail("session_expired"), limits.maxSessionMs),
      setInterval(() => {
        if (Date.now() - this.lastClientMessage > limits.idleMs) this.fail("idle");
      }, 5_000) as unknown as ReturnType<typeof setTimeout>,
    );
    return null;
  }

  /** Raw PCM from the browser. Bounded, then base64'd into a realtimeInput. */
  sendAudio(frame: Uint8Array): void {
    this.lastClientMessage = Date.now();
    if (this.phase !== "ready" || !this.upstream) return;
    if (frame.byteLength > limits.maxFrameBytes) return this.fail("frame_too_large");
    this.inputBytes += frame.byteLength;
    if (this.inputBytes > limits.maxInputBytes) return this.fail("input_limit");

    this.upstream.send(
      JSON.stringify({
        realtimeInput: {
          audio: {
            data: base64(frame),
            mimeType: "audio/pcm;rate=16000",
          },
        },
      }),
    );
  }

  /** The client saying it stopped talking, so Gemini can finish the turn. */
  endTurn(): void {
    this.lastClientMessage = Date.now();
    if (this.phase !== "ready" || !this.upstream || this.turnEnded) return;
    this.turnEnded = true;
    this.upstream.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
  }

  close(): void {
    this.phase = "closed";
    for (const t of this.timers) clearTimeout(t as ReturnType<typeof setTimeout>);
    this.timers = [];
    try {
      this.upstream?.close();
    } catch {
      // already gone
    }
    this.upstream = null;
  }

  private handleUpstream(data: unknown): void {
    if (this.phase === "closed") return;
    let text: string;
    if (typeof data === "string") text = data;
    else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
    else return;

    let message: any;
    try {
      message = JSON.parse(text);
    } catch {
      return; // a frame we do not understand is not a reason to kill the session
    }

    if (message.setupComplete) {
      this.phase = "ready";
      this.hooks.onEvent({ type: "ready" });
      return;
    }

    const content = message.serverContent;
    if (!content) return;

    // Transcripts are the only text ever forwarded, and only these two fields.
    if (content.inputTranscription?.text) {
      this.hooks.onEvent({ type: "heard", text: String(content.inputTranscription.text) });
    }
    if (content.outputTranscription?.text) {
      this.hooks.onEvent({ type: "said", text: String(content.outputTranscription.text) });
    }

    for (const part of content.modelTurn?.parts ?? []) {
      const encoded = part?.inlineData?.data;
      if (typeof encoded === "string" && encoded.length > 0) {
        this.hooks.onAudio(decodeBase64(encoded));
      }
    }

    if (content.turnComplete) this.hooks.onEvent({ type: "turn_complete" });
  }

  private fail(reason: string): void {
    if (this.phase === "closed") return;
    this.close();
    this.hooks.onClose(reason);
  }
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000; // String.fromCharCode has an argument-count ceiling
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function decodeBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
