/**
 * Everything Glossaray DOES, with nothing about how it looks.
 *
 * This exists so the two modes cannot drift. The device panel and the browser
 * conversation are two renderings of this one object: the microphone, the
 * socket, the turn, the language pair and every rule about them live here, and
 * a renderer may only listen and issue the same three commands a person can.
 * Anything learned in device mode is therefore true of web mode, and - the
 * point of the whole exercise - true of the board.
 *
 * Two AudioContexts, deliberately. Capture is created at 16000 and playback at
 * 24000, the rates Gemini speaks, so the browser does every conversion. One
 * context cannot be two rates and hand-rolling a resampler to avoid a second
 * one would be trading a solved problem for an unsolved one.
 */
export const LANGUAGE_NAMES: Record<string, string> = {
  en: "English", cy: "Welsh", it: "Italian", es: "Spanish", fr: "French",
  de: "German", pl: "Polish", tr: "Turkish", ru: "Russian", ja: "Japanese",
  zh: "Chinese",
};

export interface Pair { source: string; target: string; mode: "agent" }

/** What the panel calls a scene and the browser calls a state. */
export type Phase =
  | "loading" | "setup" | "idle" | "listening" | "translating" | "speaking" | "error";

export interface Turn {
  source: string;
  target: string;
  heard: string;
  said: string;
  /** The spoken reply, kept so a tap can play it again. */
  audio: ArrayBuffer[];
  done: boolean;
}

type Listener = () => void;

/**
 * Below this a press is a TAP, not a phrase. With a translation in hand a tap
 * repeats it; with nothing to repeat it is ERROR / HOLD LONGER.
 *
 * **It is one number on purpose, and it is also when the socket opens.** Split
 * them and a press that lands between the two either burns a session it never
 * uses or is read as a phrase it never was.
 *
 * The board decides at 350ms and can afford to: its button is a physical click.
 * A thumb on a touchscreen is nowhere near that crisp - a deliberate tap runs
 * to half a second without trying - and at 400ms a tap meant as REPEAT was
 * being read as a hold. It then opened a session, sent a blip of near-silence,
 * and the upstream closed on it, which the panel renders as TIMEOUT. The cost
 * of the longer window is that the model starts interpreting 600ms later; no
 * audio is lost, because the microphone is already running and buffered.
 */
const TAP_MS = 600;

/** Only the turn you are standing in can be repeated, and even that is bounded:
 *  60 seconds of 24kHz mono. Everything that accumulates here has a ceiling. */
const REPEAT_MAX_BYTES = 48_000 * 60;

/** Microphone held while the wire comes up. Three seconds at 16kHz mono; if the
 *  session has not opened by then it is not going to. */
const OUTBOX_MAX_BYTES = 32_000 * 3;

/**
 * How long the microphone stays open after a turn.
 *
 * Not zero, and not forever. A live track keeps the phone's recording indicator
 * lit, which on a translator reads as "it is still listening" and is the one
 * thing this must never look like. But re-acquiring it costs the start of the
 * next phrase, and back-to-back turns are the normal way this is used. So it is
 * held just long enough to cover a conversation and released the moment one
 * stops.
 */
const MIC_IDLE_MS = 4_000;

/** The board is a physical button. Where a browser can say so, it should.
 *  Absent on iOS, which supports no vibration API at all. */
function tap(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // A refusal to buzz is never a reason to fail a turn.
  }
}

export class Session {
  pairs: Pair[] = [];
  source = "en";
  target = "it";
  phase: Phase = "loading";
  /** The turn in progress, then finished. Newest last. */
  turns: Turn[] = [];
  errorCode = "";
  holding = false;
  /** Nothing can be said until the server's pair list is in hand. */
  loaded = false;
  /**
   * Whether the microphone has been granted.
   *
   * The board has no such notion, and this is where a browser stops being one:
   * the FIRST hold used to be eaten by the permission dialog - you press, the
   * browser asks, you lift your finger to answer it, and the turn dies as a
   * fumble. So permission is asked for on its own, once, before anything is
   * held. It cannot be asked on load either: iOS Safari refuses getUserMedia
   * without a genuine gesture, which is the one platform this most needs to
   * work on. Hence a scene with one instruction, and a tap.
   */
  micReady = false;
  /** Playing the last translation again rather than a new one. The board says
   *  REPEATING where it would say SPEAKING; nothing else differs. */
  repeating = false;
  /**
   * Microphone level while holding: peak, 0 to 1, with a short decay.
   *
   * Deliberately NOT published through changed(). Frames arrive every 8ms and a
   * render each time would be 125 a second; the meter that reads this is
   * stepped, so it samples on its own frame instead.
   */
  level = 0;

  private listeners: Listener[] = [];
  private micStream: MediaStream | null = null;
  private captureContext: AudioContext | null = null;
  private socket: WebSocket | null = null;
  private playback: AudioContext | null = null;
  private playHead = 0;
  private heldFrom = 0;
  private wakeLock: WakeLockSentinel | null = null;
  private wire: "closed" | "opening" | "ready" = "closed";
  private openTimer = 0;
  private settleTimer = 0;
  private endWhenReady = false;
  /**
   * Microphone frames captured before Gemini is ready.
   *
   * The server DROPS audio until the upstream session is up, so anything sent
   * early is the quiet start of the phrase and it is simply gone. Hold it here
   * and flush it the moment the wire opens.
   */
  private outbox: ArrayBuffer[] = [];
  private outboxBytes = 0;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micNode: AudioWorkletNode | null = null;
  private micTimer = 0;
  private workletLoaded = false;
  private asking = false;
  /**
   * Replies that arrived while the button was still down.
   *
   * Replies that arrive before release are held so playback can never feed the
   * speaker back into the still-open microphone.
   */
  private pending: ArrayBuffer[] = [];

  subscribe(listener: Listener): void {
    this.listeners.push(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  /* Languages ------------------------------------------------------------- */

  /** The server's own list, so a renderer can never offer a pair the server
   *  would refuse. */
  /** What the resting scene is: nothing yet, the microphone gate, or READY. */
  private resting(): Phase {
    if (!this.loaded) return "error";
    return this.micReady ? "idle" : "setup";
  }

  /**
   * Do we already have the microphone? Chrome will say; Safari does not know
   * the "microphone" permission name at all, so it falls back to what this
   * browser has done before. Both are hints - a wrong one costs one extra tap,
   * never a broken turn.
   */
  private async knowMic(): Promise<void> {
    try {
      const status = await navigator.permissions?.query({
        name: "microphone" as PermissionName,
      });
      if (status?.state === "granted") this.micReady = true;
      if (status?.state === "denied") this.micReady = false;
      if (status) return;
    } catch {
      // Not a permission name this browser knows.
    }
    try {
      if (
        localStorage.getItem("glossaray-mic") === "granted"
      ) this.micReady = true;
    } catch {
      // A private window refuses this.
    }
  }

  /**
   * Ask for the microphone, from a real tap and on its own. Nothing is being
   * recorded here: it is acquired, counted as granted, and let go of again on
   * the usual timer.
   */
  async requestMic(): Promise<void> {
    if (this.asking || this.holding) return;
    this.asking = true;
    try {
      await this.ensureMic();
      this.micReady = true;
      try {
        localStorage.setItem("glossaray-mic", "granted");
      } catch {
        // A preference, not a requirement.
      }
      this.phase = this.resting();
      this.releaseMicSoon();
      this.changed();
    } catch {
      this.fail("mic_blocked");
    } finally {
      this.asking = false;
    }
  }

  async load(): Promise<void> {
    try {
      const response = await fetch("/v1/pairs");
      const body = await response.json();
      this.pairs = body.pairs as Pair[];
      const sources = [...new Set(this.pairs.map((p) => p.source))];
      this.source = sources.includes("en") ? "en" : sources[0]!;
      this.target = this.targets()[0]!;
      this.loaded = true;
      await this.knowMic();
      this.phase = this.resting();
      this.errorCode = "";
      this.changed();
    } catch (error) {
      // No auto-clear: a board with no languages must not settle into READY and
      // then do nothing when it is pressed. It says so and waits to be retried.
      this.errorCode = "offline";
      this.phase = "error";
      this.changed();
      throw error;
    }
  }

  targets(source = this.source): string[] {
    return this.pairs.filter((p) => p.source === source).map((p) => p.target);
  }

  sources(): string[] {
    return [...new Set(this.pairs.map((p) => p.source))];
  }

  label(): string {
    return `${this.source.toUpperCase()} -> ${this.target.toUpperCase()}`;
  }

  /** The next target a tap would move to, as the device previews it. */
  nextTarget(): string {
    const targets = this.targets();
    return targets[(targets.indexOf(this.target) + 1) % targets.length] ?? this.target;
  }

  mode(): "agent" {
    return this.pairs.find((p) => p.source === this.source && p.target === this.target)
      ?.mode ?? "agent";
  }

  setPair(source: string, target: string): void {
    if (!this.pairs.some((p) => p.source === source && p.target === target)) return;
    this.source = source;
    this.target = target;
    this.changed();
  }

  cycleTarget(): void {
    if (this.holding) return;
    this.setPair(this.source, this.nextTarget());
  }

  /** Not every pair is symmetric, and offering one the server would refuse is
   *  a lie. Both renderers ask this before showing a swap. */
  canSwap(): boolean {
    return this.pairs.some((p) => p.source === this.target && p.target === this.source);
  }

  /** The device's double press. */
  swap(): void {
    if (this.holding) return;
    this.setPair(this.target, this.source);
  }

  /* The turn -------------------------------------------------------------- */

  get turn(): Turn | null {
    const last = this.turns[this.turns.length - 1];
    return last && !last.done ? last : null;
  }

  /**
   * The microphone. Must be called from a REAL pointer event: capture needs a
   * genuine user gesture and a secure context, which is also why none of this
   * can be verified headlessly and why the first real test has to be a person
   * on the live https host.
   */
  async startHold(): Promise<void> {
    if (this.holding) return;
    if (!this.loaded) {
      // The board's answer to a network it cannot reach is TAP v TO RETRY.
      void this.load().catch(() => {});
      return;
    }
    if (!this.micReady) {
      // The press that asks for the microphone is not also a phrase.
      void this.requestMic();
      return;
    }
    this.holding = true;
    this.repeating = false;
    this.heldFrom = Date.now();
    this.pending = [];
    this.outbox = [];
    this.outboxBytes = 0;
    this.endWhenReady = false;
    this.turns.push({
      source: this.source, target: this.target, heard: "", said: "",
      audio: [], done: false,
    });
    this.phase = "listening";
    this.changed();
    this.keepAwake(true);
    tap(12);

    try {
      await this.ensureMic();
      this.ensurePlayback().resume();
      await this.captureContext?.resume();
      this.armSocket();
    } catch {
      this.holding = false;
      this.fail("mic_blocked");
    }
  }

  /**
   * The socket opens at the moment a press becomes a phrase, not when it
   * begins. A tap is how the board repeats itself, and a session admitted and
   * thrown away costs one live slot out of three and one of thirty an hour.
   * Waiting loses nothing: the microphone is already running and every frame is
   * kept until the wire can take it.
   */
  private armSocket(): void {
    window.clearTimeout(this.openTimer);
    if (!this.holding) return;
    const wait = Math.max(0, TAP_MS - (Date.now() - this.heldFrom));
    this.openTimer = window.setTimeout(() => {
      if (this.holding) this.openSocket();
    }, wait);
  }

  endHold(): void {
    if (!this.holding) return;
    this.holding = false;
    this.level = 0;
    window.clearTimeout(this.openTimer);
    this.keepAwake(false);
    tap(8);

    if (Date.now() - this.heldFrom < TAP_MS) {
      // A tap. Drop the turn that never happened, then answer it the way the
      // board does: play the last translation again, or say HOLD LONGER.
      this.pending = [];
      this.closeSocket();
      this.turns.pop();
      if (this.canRepeat()) return this.repeat();
      return this.fail("too_short");
    }

    if (this.wire === "ready" && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "end_turn" }));
    } else if (this.wire === "opening") {
      // The wire is not up yet. End the turn the moment it is, or the held
      // audio never flushes and the panel waits for a reply that cannot come.
      this.endWhenReady = true;
    } else {
      this.pending = [];
      return this.finish();
    }

    this.phase = this.turn?.said ? "speaking" : "translating";
    this.changed();
    // The mic is shut, so anything held back can be heard safely.
    const held = this.pending;
    this.pending = [];
    for (const chunk of held) this.play(chunk);
    // The reply can be complete before the button is released; settle() was
    // refused while holding, so ask again now that the play head is real.
    if (this.turns[this.turns.length - 1]?.done) this.settle();
  }

  /** The board keeps the last translation on screen and plays it again on a
   *  tap. A turn that failed is not one, which is why this reads the last turn
   *  rather than the last one that worked. */
  canRepeat(): boolean {
    if (this.holding || !this.loaded || !this.micReady) return false;
    const last = this.turns[this.turns.length - 1];
    return !!last && last.done && last.audio.length > 0;
  }

  repeat(): void {
    if (!this.canRepeat()) return;
    const last = this.turns[this.turns.length - 1]!;
    this.repeating = true;
    this.phase = "speaking";
    this.changed();
    for (const chunk of last.audio) this.play(chunk);
  }

  private fail(code: string): void {
    this.releaseMicSoon();
    this.errorCode = code;
    this.phase = "error";
    this.changed();
    window.setTimeout(() => {
      if (this.phase === "error" && !this.holding) {
        this.phase = this.resting();
        this.changed();
      }
    }, code === "too_short" ? 1800 : 2600);
  }

  /**
   * The server has said the turn is over. Close the socket as soon as there is
   * nothing left to play.
   *
   * This used to be left entirely to the last chunk's `onended`, and a turn
   * whose audio never arrived - or never finished arriving - had no last chunk,
   * so the socket simply stayed open. It holds one of three live slots while it
   * does, and 60 seconds later the server drops it as idle, which reaches the
   * panel as a TIMEOUT belonging to no turn the person remembers starting.
   */
  private settle(): void {
    if (this.holding) return;
    window.clearTimeout(this.settleTimer);
    const context = this.playback;
    // Measured every time rather than once, because a late chunk pushes the
    // play head out again and the turn is not over until it has been heard.
    const remaining = context ? this.playHead - context.currentTime : 0;
    if (remaining <= 0.02) return this.finish();
    this.settleTimer = window.setTimeout(() => this.settle(), Math.min(remaining * 1000, 500) + 60);
  }

  private finish(): void {
    window.clearTimeout(this.settleTimer);
    this.closeSocket();
    this.releaseMicSoon();
    const turn = this.turn;
    if (turn) turn.done = true;
    this.repeating = false;
    if (this.phase !== "error") this.phase = "idle";
    // Only the newest turn can be repeated; the ones behind it let their audio
    // go rather than keeping every reply of the session in memory.
    for (const previous of this.turns.slice(0, -1)) previous.audio = [];
    this.changed();
  }

  private closeSocket(): void {
    window.clearTimeout(this.openTimer);
    this.socket?.close();
    this.socket = null;
    this.wire = "closed";
    this.outbox = [];
    this.outboxBytes = 0;
    this.endWhenReady = false;
  }

  /* The wire -------------------------------------------------------------- */

  private openSocket(): void {
    const url = new URL("/ws", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    // A socket that outlived its turn is not merely idle: it holds one of three
    // live slots and it can still deliver an error into a turn that has nothing
    // to do with it. Let go of it before taking another.
    const stale = this.socket;
    if (stale) {
      this.socket = null;
      try {
        stale.close();
      } catch {
        // already gone
      }
    }

    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.wire = "opening";

    socket.onopen = () => {
      socket.send(JSON.stringify({
        type: "start", source: this.source, target: this.target, mode: this.mode(),
      }));
    };

    socket.onmessage = (event) => {
      // Anything from a socket this session has moved on from is not news.
      if (this.socket !== socket) return;
      if (event.data instanceof ArrayBuffer) {
        this.remember(event.data);
        return this.play(event.data);
      }
      const message = JSON.parse(event.data);
      const turn = this.turn ?? this.turns[this.turns.length - 1];

      if (message.type === "ready") {
        this.wire = "ready";
        for (const frame of this.outbox) socket.send(frame);
        this.outbox = [];
        this.outboxBytes = 0;
        if (this.endWhenReady) {
          socket.send(JSON.stringify({ type: "end_turn" }));
          this.endWhenReady = false;
        }
        if (this.holding) this.phase = "listening";
      } else if (message.type === "heard") {
        // Transcripts arrive in PIECES, not as finished lines - Gemini streams
        // them as it goes. Accumulate: rendered one at a time you watch a
        // sentence assemble and erase itself, and it never exists whole.
        if (turn) turn.heard += message.text;
      } else if (message.type === "said") {
        if (turn) turn.said += message.text;
        if (!this.holding) this.phase = "speaking";
      } else if (message.type === "turn_complete") {
        if (turn) turn.done = true;
        this.settle();
      } else if (message.type === "error") {
        return this.fail(message.code);
      }
      this.changed();
    };

    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.wire = "closed";
      if (!this.holding && this.phase !== "error") this.finish();
    };
  }

  /* Audio ----------------------------------------------------------------- */

  private async ensureMic(): Promise<void> {
    window.clearTimeout(this.micTimer);
    if (this.micStream && this.captureContext && this.micNode) return;

    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        // All three off: voice DSP is tuned to suppress exactly the continuous
        // speech this is trying to send, and gates the quiet start of a phrase.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    // The context outlives the stream: it is the expensive half, and the
    // processor may only be registered on it once.
    if (!this.captureContext) this.captureContext = new AudioContext({ sampleRate: 16_000 });
    if (!this.workletLoaded) {
      await this.captureContext.audioWorklet.addModule("/capture-worklet.js");
      this.workletLoaded = true;
    }
    const source = this.captureContext.createMediaStreamSource(this.micStream);
    const node = new AudioWorkletNode(this.captureContext, "capture");
    node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (!this.holding) return;
      this.measure(event.data);
      this.sendAudio(event.data);
    };
    source.connect(node);
    // A worklet with no destination is not pulled in every browser; a zero-gain
    // node keeps the graph running without making a sound.
    const silence = this.captureContext.createGain();
    silence.gain.value = 0;
    node.connect(silence).connect(this.captureContext.destination);
    this.micSource = source;
    this.micNode = node;
  }

  /** Let the microphone go once a conversation has stopped, so the phone's
   *  recording indicator goes out with it. */
  private releaseMicSoon(): void {
    window.clearTimeout(this.micTimer);
    this.micTimer = window.setTimeout(() => {
      if (this.holding) return;
      this.micNode?.disconnect();
      this.micSource?.disconnect();
      this.micNode = null;
      this.micSource = null;
      for (const track of this.micStream?.getTracks() ?? []) track.stop();
      this.micStream = null;
    }, MIC_IDLE_MS);
  }

  /** Peak of one captured frame, decayed so the meter falls rather than
   *  flickering. 0.97 a frame at 8ms is a half-life of about 180ms. */
  private measure(frame: ArrayBuffer): void {
    const samples = new Int16Array(frame);
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const value = Math.abs(samples[i]!);
      if (value > peak) peak = value;
    }
    this.level = Math.max(peak / 0x8000, this.level * 0.97);
  }

  /** Out to the wire if it is up, into the outbox if it is not. */
  private sendAudio(frame: ArrayBuffer): void {
    if (this.wire === "ready" && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(frame);
      return;
    }
    if (this.outboxBytes + frame.byteLength > OUTBOX_MAX_BYTES) return;
    this.outbox.push(frame);
    this.outboxBytes += frame.byteLength;
  }

  /** Keep the reply so a tap can play it again. */
  private remember(pcm: ArrayBuffer): void {
    const turn = this.turns[this.turns.length - 1];
    if (!turn) return;
    const held = turn.audio.reduce((total, chunk) => total + chunk.byteLength, 0);
    if (held + pcm.byteLength > REPEAT_MAX_BYTES) return;
    turn.audio.push(pcm);
  }

  private ensurePlayback(): AudioContext {
    if (!this.playback) this.playback = new AudioContext({ sampleRate: 24_000 });
    return this.playback;
  }

  /** Queue one chunk of 24kHz PCM immediately after whatever is already queued. */
  private play(pcm: ArrayBuffer): void {
    if (this.holding) {
      this.pending.push(pcm);
      return;
    }
    const context = this.ensurePlayback();
    const samples = new Int16Array(pcm);
    if (samples.length === 0) return;

    const buffer = context.createBuffer(1, samples.length, 24_000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i]! / 0x8000;

    const node = context.createBufferSource();
    node.buffer = buffer;
    node.connect(context.destination);

    const now = context.currentTime;
    if (this.playHead < now) this.playHead = now;
    node.start(this.playHead);
    this.playHead += buffer.duration;
    // Only when it is news. A repeat queues its whole reply at once, and a
    // render per chunk would be hundreds of them in one frame.
    if (this.phase !== "error" && this.phase !== "speaking") {
      this.phase = "speaking";
      this.changed();
    }
    // Nothing about playback ends a turn. This used to call finish() whenever
    // the play head ran dry, which is not the end of the reply - it is a GAP in
    // delivery, and any pause between chunks closed the socket mid-sentence.
    // The rest of the translation then never arrived, taking the transcript
    // with it, so the panel fell back to READY with nothing to show. The server
    // says when a turn is over; settle() waits for the sound to catch up.
  }

  /** The device's screen stays on while it is in your hand; this one should
   *  too. Unsupported wherever it is unsupported, so every call is optional. */
  private async keepAwake(on: boolean): Promise<void> {
    try {
      if (on && !this.wakeLock && "wakeLock" in navigator) {
        this.wakeLock = await navigator.wakeLock.request("screen");
        this.wakeLock.addEventListener("release", () => { this.wakeLock = null; });
      } else if (!on && this.wakeLock) {
        await this.wakeLock.release();
        this.wakeLock = null;
      }
    } catch {
      // A wake lock is a nicety; never let it break a turn.
    }
  }
}
