/**
 * The walkie-talkie rules, which cannot be checked by looking.
 *
 * Everything here is about the seam between a press and a session: when the
 * socket opens, what happens to audio captured before it does, and what a tap
 * means. None of it is visible on screen and none of it can be exercised
 * through the microphone, which needs a genuine gesture and a real person - so
 * it gets a fake browser instead.
 */
import { expect, test, describe, beforeEach } from "bun:test";
import { Session } from "../src/scripts/session";

let clock = 0;
let timers: { at: number; id: number; fn: () => void }[] = [];
let nextTimer = 1;
let sockets: FakeSocket[] = [];
let worklets: FakeWorkletNode[] = [];
let played: { duration: number }[] = [];
let buzzes: (number | number[])[] = [];
let tracks: { stopped: boolean }[] = [];

class FakeSocket {
  static OPEN = 1;
  readyState = 0;
  sent: (string | ArrayBuffer)[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(_url: unknown) {
    sockets.push(this);
  }
  send(payload: string | ArrayBuffer): void {
    this.sent.push(payload);
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }

  /* The other end of the wire, for the tests to drive. */
  connect(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  say(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  speak(bytes = 48_000): void {
    this.onmessage?.({ data: new ArrayBuffer(bytes) });
  }
  frames(): ArrayBuffer[] {
    return this.sent.filter((s): s is ArrayBuffer => s instanceof ArrayBuffer);
  }
  notes(): any[] {
    return this.sent.filter((s) => typeof s === "string").map((s) => JSON.parse(s as string));
  }
}

class FakeWorkletNode {
  port: { onmessage: ((event: { data: ArrayBuffer }) => void) | null } = { onmessage: null };
  constructor() {
    worklets.push(this);
  }
  connect<T>(node: T): T {
    return node;
  }
  disconnect(): void {}
  /** One 8ms block of microphone audio, as the capture worklet posts it. */
  capture(bytes = 256, amplitude = 0): void {
    const buffer = new ArrayBuffer(bytes);
    new Int16Array(buffer).fill(Math.round(amplitude * 0x7fff));
    this.port.onmessage?.({ data: buffer });
  }
}

class FakeAudioContext {
  /** The same clock the timers run on, so a scheduled buffer really does end. */
  get currentTime(): number {
    return clock / 1000;
  }
  destination = {};
  audioWorklet = { addModule: async () => {} };
  constructor(_options: unknown) {}
  resume(): Promise<void> {
    return Promise.resolve();
  }
  createMediaStreamSource() {
    return { connect: <T>(node: T): T => node, disconnect: () => {} };
  }
  createGain() {
    return { gain: { value: 1 }, connect: <T>(node: T): T => node };
  }
  createBuffer(_channels: number, length: number, rate: number) {
    return { duration: length / rate, getChannelData: () => new Float32Array(length) };
  }
  createBufferSource() {
    const node = {
      buffer: null as { duration: number } | null,
      connect(): void {},
      start(when: number): void {
        const duration = node.buffer?.duration ?? 0;
        played.push({ duration });
        timers.push({
          at: (when + duration) * 1000,
          id: nextTimer++,
          fn: () => node.onended?.(),
        });
      },
      onended: null as (() => void) | null,
    };
    return node;
  }
}

/** Let a fire-and-forget promise inside the session settle. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function tick(ms: number): void {
  clock += ms;
  const due = timers.filter((t) => t.at <= clock).sort((a, b) => a.at - b.at);
  timers = timers.filter((t) => t.at > clock);
  for (const timer of due) timer.fn();
}

beforeEach(() => {
  clock = 0;
  timers = [];
  nextTimer = 1;
  sockets = [];
  worklets = [];
  played = [];
  buzzes = [];
  tracks = [];
  const win = {
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextTimer++;
      timers.push({ at: clock + ms, id, fn });
      return id;
    },
    clearTimeout: (id: number) => {
      timers = timers.filter((t) => t.id !== id);
    },
  };
  Object.assign(globalThis, {
    window: win,
    location: { href: "https://glossaray.test/", protocol: "https:" },
    WebSocket: FakeSocket,
    AudioContext: FakeAudioContext,
    AudioWorkletNode: FakeWorkletNode,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      vibrate: (pattern: number | number[]) => buzzes.push(pattern),
      mediaDevices: {
        getUserMedia: async () => {
          const track = { stopped: false, stop() { track.stopped = true; } };
          tracks.push(track);
          return { getTracks: () => [track] };
        },
      },
    },
  });
  Date.now = () => clock;
});

/** A session with the server's pair list already in hand. */
function ready(): Session {
  const session = new Session();
  session.pairs = [
    { source: "en", target: "it", mode: "agent" },
    { source: "it", target: "en", mode: "agent" },
    { source: "en", target: "cy", mode: "agent" },
  ];
  session.loaded = true;
  session.micReady = true;
  session.phase = "idle";
  return session;
}

/** As the page is before the server has answered. */
function unloaded(): Session {
  Object.assign(globalThis, {
    fetch: async () => {
      throw new Error("offline");
    },
  });
  return new Session();
}

/** Hold, speak, release, and let the reply arrive. One whole turn. */
async function turn(session: Session, text = "ciao"): Promise<FakeSocket> {
  await session.startHold();
  tick(700);
  const socket = sockets[sockets.length - 1]!;
  socket.connect();
  socket.say({ type: "hello" });
  socket.say({ type: "ready" });
  worklets[worklets.length - 1]!.capture();
  session.endHold();
  socket.say({ type: "said", text });
  socket.speak();
  socket.say({ type: "turn_complete" });
  socket.close();
  return socket;
}

describe("a tap is not a phrase", () => {
  test("a tap never opens a session, so it cannot cost a slot or a rate limit", async () => {
    const session = ready();
    await session.startHold();
    tick(120);
    session.endHold();
    tick(1000);

    expect(sockets.length).toBe(0);
    expect(session.phase).toBe("error");
    expect(session.errorCode).toBe("too_short");
    expect(session.turns.length).toBe(0);
  });

  test("with a translation in hand, a tap repeats it instead of failing", async () => {
    const session = ready();
    await turn(session, "ciao");
    const opened = sockets.length;

    await session.startHold();
    tick(120);
    session.endHold();

    expect(sockets.length).toBe(opened);
    expect(session.repeating).toBe(true);
    expect(session.phase).toBe("speaking");
    expect(session.errorCode).not.toBe("too_short");
    // The turn that never happened is gone, and the one being repeated stayed.
    expect(session.turns.length).toBe(1);
    expect(session.turns[0]!.said).toBe("ciao");
  });

  test("a thumb is not a physical button: half a second is still a tap", async () => {
    // 400ms was the old window, and a deliberate tap on a touchscreen runs past
    // it easily. It was then read as a phrase, opened a session on a blip of
    // near-silence, and came back as TIMEOUT.
    const session = ready();
    await turn(session, "ciao");
    const opened = sockets.length;

    await session.startHold();
    tick(480);
    session.endHold();

    expect(sockets.length).toBe(opened);
    expect(session.repeating).toBe(true);
  });

  test("a repeat plays the reply it kept, not silence", async () => {
    const session = ready();
    await turn(session);
    played.length = 0;

    session.repeat();

    expect(played.length).toBe(1);
    expect(played[0]!.duration).toBeGreaterThan(0);
  });

  test("there is nothing to repeat until a turn has finished", async () => {
    const session = ready();
    expect(session.canRepeat()).toBe(false);
    await session.startHold();
    tick(700);
    const socket = sockets[0]!;
    socket.connect();
    socket.say({ type: "ready" });
    socket.speak();
    // Mid-turn: audio has arrived but the turn is not closed.
    expect(session.canRepeat()).toBe(false);
    session.endHold();
    socket.say({ type: "turn_complete" });
    socket.close();
    expect(session.canRepeat()).toBe(true);
  });

  test("only the newest turn keeps its audio", async () => {
    const session = ready();
    await turn(session, "uno");
    await turn(session, "due");

    expect(session.turns.length).toBe(2);
    expect(session.turns[0]!.audio.length).toBe(0);
    expect(session.turns[1]!.audio.length).toBeGreaterThan(0);
  });
});

describe("the quiet start of a phrase", () => {
  test("audio captured before Gemini is ready is flushed, not dropped", async () => {
    const session = ready();
    await session.startHold();
    const mic = worklets[0]!;

    // Speaking already, while the wire is still coming up.
    mic.capture();
    mic.capture();
    tick(700);
    const socket = sockets[0]!;
    socket.connect();
    mic.capture();
    expect(socket.frames().length).toBe(0);

    socket.say({ type: "ready" });
    expect(socket.frames().length).toBe(3);

    mic.capture();
    expect(socket.frames().length).toBe(4);
  });

  test("a release before the wire is ready still ends the turn once it is", async () => {
    const session = ready();
    await session.startHold();
    worklets[0]!.capture();
    tick(700);
    const socket = sockets[0]!;
    socket.connect();
    session.endHold();

    expect(socket.notes().some((n) => n.type === "end_turn")).toBe(false);

    socket.say({ type: "ready" });
    expect(socket.frames().length).toBe(1);
    expect(socket.notes().some((n) => n.type === "end_turn")).toBe(true);
  });

  test("held audio is bounded, so a wire that never opens cannot grow", async () => {
    const session = ready();
    await session.startHold();
    const mic = worklets[0]!;
    for (let i = 0; i < 2000; i++) mic.capture(256);
    tick(700);
    const socket = sockets[0]!;
    socket.connect();
    socket.say({ type: "ready" });

    const bytes = socket.frames().reduce((total, f) => total + f.byteLength, 0);
    expect(bytes).toBeLessThanOrEqual(32_000 * 3);
    expect(bytes).toBeGreaterThan(0);
  });
});

describe("a turn that is over lets go of its session", () => {
  test("turn_complete closes the socket rather than waiting for playback", async () => {
    const session = ready();
    await session.startHold();
    tick(700);
    const socket = sockets[0]!;
    socket.connect();
    socket.say({ type: "ready" });
    session.endHold();
    socket.say({ type: "said", text: "ciao" });
    socket.speak();
    socket.say({ type: "turn_complete" });

    expect(socket.readyState).not.toBe(3);
    tick(3000);
    expect(socket.readyState).toBe(3);
  });

  test("a gap in delivery is not the end of the reply", () => {
    // The bug this exists for: playback running dry mid-reply used to close the
    // socket, so the rest of the translation never arrived and the panel had
    // nothing left to show.
    const session = ready();
    return (async () => {
      await session.startHold();
      tick(700);
      const socket = sockets[0]!;
      socket.connect();
      socket.say({ type: "ready" });
      session.endHold();

      socket.speak();
      tick(2500); // the first chunk plays out, and then some silence
      expect(socket.readyState).not.toBe(3);

      // The tail arrives late, and is still heard.
      socket.speak();
      socket.say({ type: "turn_complete" });
      expect(played.length).toBe(2);
      tick(3000);
      expect(socket.readyState).toBe(3);
    })();
  });

  test("a reply that brings no audio at all still closes, and does not sit idle", async () => {
    const session = ready();
    await session.startHold();
    tick(700);
    const socket = sockets[0]!;
    socket.connect();
    socket.say({ type: "ready" });
    session.endHold();
    // No audio ever arrives: nothing plays, so nothing can end.
    socket.say({ type: "turn_complete" });
    tick(2000);

    expect(socket.readyState).toBe(3);
    expect(session.phase).toBe("idle");
  });

  test("a socket left behind cannot report a timeout into a later turn", async () => {
    const session = ready();
    await session.startHold();
    tick(700);
    const first = sockets[0]!;
    first.connect();
    first.say({ type: "ready" });
    session.endHold();
    // A second hold begins before the first socket has gone.
    await session.startHold();
    tick(700);
    const second = sockets[1]!;
    second.connect();
    second.say({ type: "ready" });

    // The abandoned socket is dropped by the server 60 seconds later.
    first.say({ type: "error", code: "idle" });

    expect(session.phase).not.toBe("error");
    expect(session.errorCode).not.toBe("idle");
  });
});

describe("the microphone is let go of", () => {
  test("a finished turn releases the track, so the recording light goes out", async () => {
    const session = ready();
    await turn(session);
    expect(tracks.length).toBe(1);
    expect(tracks[0]!.stopped).toBe(false);

    tick(5000);
    expect(tracks[0]!.stopped).toBe(true);
  });

  test("a second turn straight away keeps the same one, and loses no phrase", async () => {
    const session = ready();
    await turn(session);
    tick(1000); // inside the grace period
    await turn(session);

    expect(tracks.length).toBe(1);
    expect(tracks[0]!.stopped).toBe(false);
  });

  test("a turn in progress is never cut off by the release", async () => {
    const session = ready();
    await turn(session);
    tick(3900);
    await session.startHold();
    tick(2000); // the release would have fired in here

    expect(tracks[tracks.length - 1]!.stopped).toBe(false);
    expect(session.holding).toBe(true);
  });

  test("the gesture is felt where a browser can say so", async () => {
    const session = ready();
    await session.startHold();
    tick(700);
    session.endHold();

    expect(buzzes.length).toBe(2);
  });
});

describe("the meter has something real to show", () => {
  test("speaking moves the level, and silence lets it fall", async () => {
    const session = ready();
    await session.startHold();
    const mic = worklets[0]!;

    expect(session.level).toBe(0);
    mic.capture(256, 0.8);
    expect(session.level).toBeGreaterThan(0.7);

    // Peak with a decay, so the meter falls rather than flickering off.
    for (let i = 0; i < 200; i++) mic.capture(256, 0);
    expect(session.level).toBeLessThan(0.05);
  });

  test("a level is only ever measured while the button is held", async () => {
    const session = ready();
    await session.startHold();
    const mic = worklets[0]!;
    mic.capture(256, 0.8);
    tick(700);
    session.endHold();

    // Released: the meter has nothing to show and must not be left lit.
    expect(session.level).toBe(0);
    mic.capture(256, 0.9);
    expect(session.level).toBe(0);
  });
});

describe("the microphone is asked for on its own", () => {
  test("the first press asks, and is not also a phrase", async () => {
    const session = ready();
    session.micReady = false;
    session.phase = "setup";

    await session.startHold();
    await flush();
    tick(700);

    expect(session.holding).toBe(false);
    expect(sockets.length).toBe(0);
    expect(session.turns.length).toBe(0);
    // Asking for it is what the press did, and it is granted.
    expect(session.micReady).toBe(true);
    expect(session.phase).toBe("idle");
  });

  test("once granted, the next press is a turn", async () => {
    const session = ready();
    session.micReady = false;
    session.phase = "setup";
    await session.startHold();
    await flush();

    await session.startHold();
    tick(700);

    expect(session.holding).toBe(true);
    expect(sockets.length).toBe(1);
  });

  test("a refusal returns to the gate, not to READY", async () => {
    const session = ready();
    session.micReady = false;
    session.phase = "setup";
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: async () => {
            throw new Error("denied");
          },
        },
      },
    });

    await session.requestMic();
    expect(session.phase).toBe("error");
    expect(session.errorCode).toBe("mic_blocked");

    tick(3000);
    expect(session.phase).toBe("setup");
  });
});

describe("a panel that cannot reach the server", () => {
  test("says so, and does not settle into READY with nothing behind it", async () => {
    const session = unloaded();
    await session.load().catch(() => {});

    expect(session.phase).toBe("error");
    expect(session.errorCode).toBe("offline");
    expect(session.loaded).toBe(false);
  });

  test("a press retries rather than opening a session with no languages", async () => {
    const session = unloaded();
    await session.load().catch(() => {});
    await session.startHold();

    expect(sockets.length).toBe(0);
    expect(session.holding).toBe(false);
    expect(session.turns.length).toBe(0);
  });
});

describe("what the panel is allowed to show", () => {
  test("a swap is only offered when the server admits the reverse pair", () => {
    const session = ready();
    session.setPair("en", "it");
    expect(session.canSwap()).toBe(true);
    session.setPair("en", "cy");
    expect(session.canSwap()).toBe(false);
  });
});
