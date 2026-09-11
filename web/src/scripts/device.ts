/**
 * The device renderer: firmware/glossaray/src/display.cpp, in a browser.
 *
 * This is the playground. Every position is a firmware coordinate on the
 * panel's own 368x448, the palette is `palette()`, and the strings are the
 * device's own - showReady, showStatus and showTranslation are named after the
 * functions that draw them. If it is not on the board, it does not go here.
 *
 * Type is sized to the built-in 5x7 GFX face: at "size N" the device advances
 * 6N and has 7N caps, which a monospace gives at font-size 10N.
 */
import type { Session } from "./session";

/** The device's 16x11 fish, byte for byte from display.cpp. Spaces are
 *  transparent; every other cell maps to a palette role. */
const FISH = [
  "     dddddd     ", "   dddppppddd   ", "  cdppppppppd   ",
  " ccdpppppppppd  ", "cccdpppplllpppd ", "cccdppppldkpppd ",
  "cccdpppplllpppd ", " ccdpppppppppd  ", "  cdppppppppd   ",
  "   dddppppddd   ", "     dddddd     ",
];
const PALETTE: Record<string, string> = {
  d: "#241033", p: "#713fad", l: "#c6a0ff", c: "#4fdde5", k: "#050207",
};
/** runBootAnimation()'s twelve-frame bob, and its 110ms tick. */
const BOB = [0, -1, -2, -3, -2, -1, 0, 1, 2, 3, 2, 1];

/**
 * drawWrappedResult()'s own numbers, and they are NOT the panel's.
 *
 * The result is the one thing the board draws in a different face: u8g2
 * unifont at size 2, which is 16px per character, wrapped to 288px. That is
 * eighteen characters a line, where the 5x7 GFX face used everywhere else
 * would give twenty-four. Wrapping with the panel's advance put line breaks
 * on screen that the board would never produce, in the one scene where
 * wrapping decides what fits - so the wrap is done here, in the firmware's
 * units, rather than left to the browser.
 */
/** Bars in the listening meter, and blocks in the translating progress. */
const METER_BARS = 8;
const PROGRESS_BLOCKS = 4;
/** One block per step. Discrete, as everything on this panel is. */
const PROGRESS_MS = 400;

const RESULT_ADVANCE = 16;
const RESULT_COLUMNS = 18;
const RESULT_LINES = 7;
/** drawWrappedResult()'s scroll: one line a step, longer at the end. */
const SCROLL_STEP_MS = 2200;
const SCROLL_HOLD_MS = 4500;

/** commitWord() and flushLine(), in the same order and with the same
 *  fallback: a word wider than the panel breaks at glyph boundaries. */
export function wrapResult(text: string, columns = RESULT_COLUMNS): string[] {
  const lines: string[] = [];
  let line = "";
  const flush = () => {
    if (line) lines.push(line);
    line = "";
  };
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = word;
    while (rest.length > columns) {
      flush();
      lines.push(rest.slice(0, columns));
      rest = rest.slice(columns);
    }
    const proposed = line ? `${line} ${rest}` : rest;
    if (proposed.length > columns) {
      flush();
      line = rest;
    } else {
      line = proposed;
    }
  }
  flush();
  return lines;
}

/**
 * The seven lines on screen at a given scroll offset.
 *
 * There is ONE type size, because the board cannot have two: u8g2 at textsize
 * 1 paints a glyph as 1px-high fills and one-pixel primitives on the CO5300
 * break into dots, so a smaller size was drawn correctly and simply could not
 * be seen. Paging was the other answer and it costs the tap, which is REPEAT.
 * So what will not fit MOVES, and this is the window onto it.
 */
export function resultWindow(text: string, offset: number): string[] {
  const lines = wrapResult(text);
  const last = Math.max(0, lines.length - RESULT_LINES);
  const at = Math.min(Math.max(offset, 0), last);
  return lines.slice(at, at + RESULT_LINES);
}

/** How far the pane can travel. Zero when the whole translation fits. */
export function resultTravel(text: string): number {
  return Math.max(0, wrapResult(text).length - RESULT_LINES);
}

/**
 * Make one character occupy exactly the firmware's advance.
 *
 * A browser monospace is ~0.6em wide, but not on every platform - Consolas is
 * 0.55 - so a font-size alone does not fix the advance. Measure the real one
 * and correct it with letter-spacing, and eighteen characters fill 288px
 * wherever this runs.
 */
function matchAdvance(element: HTMLElement, advance: number): void {
  const style = getComputedStyle(element);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return;
  context.font = `${style.fontSize} ${style.fontFamily}`;
  const measured = context.measureText("M".repeat(10)).width / 10;
  if (!measured) return;
  element.style.letterSpacing = `${advance - measured}px`;
}

/**
 * showTranslationFailure(), plus the three a board cannot have.
 *
 * **The fallback is PROVIDER ERROR, as the firmware's is.** It used to be
 * TIMEOUT / CHECK CONNECTION, which is not a spelling difference: every
 * unrecognised upstream failure was telling someone their connection was bad
 * when the provider had refused. TIMEOUT is for the two things that actually
 * time out.
 */
export function errorScene(code: string): [string, string] {
  if (code === "busy") return ["BUSY", "TRY AGAIN"];
  if (code === "rate_limited") return ["BUSY", "TOO MANY TRIES"];
  if (code === "unsupported_pair") return ["PROVIDER ERROR", "PAIR UNAVAILABLE"];
  if (code === "unconfigured") return ["AUTH ERROR", "NOT CONFIGURED"];
  if (code === "too_short") return ["ERROR", "HOLD LONGER"];
  if (code === "session_expired" || code === "idle") return ["TIMEOUT", "TRY AGAIN"];
  // Not on the board: a browser asks permission, and can be served by nothing.
  if (code === "mic_blocked") return ["MIC BLOCKED", "ALLOW THE MICROPHONE"];
  if (code === "offline") return ["WI-FI ERROR", "PRESS TO RETRY"];
  return ["PROVIDER ERROR", "TRY AGAIN"];
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function mountDevice(session: Session): () => void {
  const stage = $<HTMLDivElement>("stage");
  const fish = $<HTMLCanvasElement>("fish");
  const bootLine = $<HTMLDivElement>("bootLine");
  const pairLine = $<HTMLButtonElement>("pair");
  const tapNext = $<HTMLButtonElement>("tapNext");
  const statusTitle = $<HTMLParagraphElement>("statusTitle");
  const statusDetail = $<HTMLParagraphElement>("statusDetail");
  const result = $<HTMLParagraphElement>("result");
  const footerOne = $<HTMLParagraphElement>("footerOne");
  const footerTwo = $<HTMLParagraphElement>("footerTwo");
  const talk = $<HTMLButtonElement>("talk");
  const meter = $<HTMLDivElement>("meter");
  const bars = [...meter.querySelectorAll("i")];

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let booting = true;
  let meterFrame = 0;
  let progressTimer = 0;
  let lit = -1;
  /* Where the result pane has scrolled to, and which text it belongs to. This
     is animation, the way the meter's rAF is - it is derived from the text
     being shown and resets the moment that text changes, so the renderer is
     still remembering nothing about the session. */
  let scrollOffset = 0;
  let scrolling = "";
  let scrollTimer = 0;

  function stopScroll(): void {
    if (scrollTimer) window.clearTimeout(scrollTimer);
    scrollTimer = 0;
  }

  /** One line a step, and longer at the end so the last of the translation is
   *  readable before it goes back to the first. tickTranslation(). */
  function startScroll(travel: number): void {
    if (scrollTimer) return;
    const atEnd = scrollOffset >= travel;
    scrollTimer = window.setTimeout(() => {
      scrollTimer = 0;
      scrollOffset = atEnd ? 0 : scrollOffset + 1;
      render();
    }, atEnd ? SCROLL_HOLD_MS : SCROLL_STEP_MS);
  }

  /** Scale the panel to the viewport as one unit, never past 1:1.6. */
  function fit(): void {
    const k = Math.min(
      (window.innerWidth - 24) / 368,
      (window.innerHeight - 96) / 448,
      1.6,
    );
    stage.style.setProperty("--k", String(Math.max(k, 0.4)));
  }

  function drawFish(offsetY = 0): void {
    const context = fish.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, fish.width, fish.height);
    for (let row = 0; row < FISH.length; row++) {
      for (let column = 0; column < FISH[row]!.length; column++) {
        const cell = FISH[row]![column]!;
        if (cell === " ") continue;
        context.fillStyle = PALETTE[cell]!;
        context.fillRect(column * 7, row * 7 + offsetY, 7, 7);
      }
    }
  }

  /** resultPowerAction(): what the second footer offers once a translation is
   *  on screen. On the board it is a power-button gesture; here it is the same
   *  words, on the controls that do it. */
  function resultAction(): string {
    if (!session.canSwap()) return "v TAP CHANGE LANGUAGE";
    return `v v SWAP TO ${session.target.toUpperCase()} -> ${session.source.toUpperCase()}`;
  }

  function status(title: string, detail: string): void {
    stage.dataset.scene = "status";
    statusTitle.textContent = title;
    statusDetail.textContent = detail;
  }

  /**
   * The meter samples the level on its own frame rather than being pushed one.
   * Capture posts every 8ms; a render per frame would be 125 a second to move
   * something that can only ever be one of nine states.
   *
   * The square root is not decoration: speech peaks low, and a linear map
   * leaves the meter dead for a normal speaking voice.
   */
  function paintMeter(): void {
    const level = reducedMotion.matches
      ? 0.25 // "a fixed representative frame plus the unambiguous state label"
      : Math.sqrt(Math.min(1, Math.max(0, session.level)));
    light(Math.min(METER_BARS, Math.round(level * METER_BARS)));
    meterFrame = requestAnimationFrame(paintMeter);
  }

  /** How many of the row's bars are lit, painted only when it changes. */
  function light(on: number): void {
    if (on === lit) return;
    lit = on;
    bars.forEach((bar, index) => {
      bar.dataset.on = String(index < on);
    });
  }

  function showMeter(): void {
    stopProgress();
    stage.dataset.meter = "level";
    meter.dataset.mode = "level";
    if (!meterFrame) meterFrame = requestAnimationFrame(paintMeter);
  }

  /** TRANSLATING has nothing to measure - there is no answer yet - so this is
   *  the reference's [■□□□] filling and refilling, not a real proportion. */
  function showProgress(): void {
    stopLevel();
    if (progressTimer) return;
    stage.dataset.meter = "progress";
    meter.dataset.mode = "progress";
    if (reducedMotion.matches) return light(2);
    let block = 0;
    light(1);
    progressTimer = window.setInterval(() => {
      block = (block + 1) % PROGRESS_BLOCKS;
      light(block + 1);
    }, PROGRESS_MS);
  }

  function stopLevel(): void {
    if (meterFrame) cancelAnimationFrame(meterFrame);
    meterFrame = 0;
  }

  function stopProgress(): void {
    window.clearInterval(progressTimer);
    progressTimer = 0;
  }

  function hideMeter(): void {
    stopLevel();
    stopProgress();
    stage.dataset.meter = "off";
    lit = -1;
  }

  function render(): void {
    if (booting) return;
    stage.dataset.holding = String(session.holding);
    pairLine.textContent = session.label();
    tapNext.textContent = `v TAP NEXT ${session.nextTarget().toUpperCase()}`;
    talk.setAttribute(
      "aria-label",
      session.phase === "setup" ? "Tap to allow the microphone"
        : session.canRepeat() ? "Hold to talk, or tap to hear that again"
        : "Hold to talk",
    );

    // A translation only exists once it is whole. The board is a walkie-talkie:
    // it has the finished line or it has TRANSLATING, and it never shows a
    // sentence assembling itself. The text streams in here exactly as it does
    // in web mode - device mode simply does not look at it until the turn
    // closes, which is the difference between the two views and all of it.
    // A turn that spoke counts even if no transcript came with it: the panel
    // parks on the result so it can be played again, rather than dropping to
    // READY as though nothing had been said.
    const last = session.turns[session.turns.length - 1];
    const shown = last && last.done && (last.said || last.audio.length > 0) ? last : null;

    // Every branch says what the stepped row is doing, rather than one of them
    // turning it off on the way past: render runs on every transcript fragment,
    // and a progress that is stopped and restarted each time never advances.
    if (session.phase === "error") {
      hideMeter();
      const [title, detail] = errorScene(session.errorCode);
      return status(title, detail);
    }
    if (session.phase === "listening") {
      showMeter();
      return status("LISTENING", "RELEASE WHEN DONE");
    }
    // The board has no such scene, because a board does not ask permission. It
    // is the setup screen a browser needs, and it is drawn with showStatus()
    // like the firmware's own GLOSSARAY-SETUP so that it belongs to the panel
    // rather than arriving as browser chrome on top of it.
    if (session.phase === "setup") {
      hideMeter();
      return status("MICROPHONE", "TAP TO ALLOW");
    }
    if (!shown) {
      if (session.phase === "translating" || session.phase === "speaking") {
        showProgress();
        return status("TRANSLATING", session.label());
      }
      // showReady(), the resting scene until there is something to show. A turn
      // that failed leaves no translation, so the board goes back here too.
      hideMeter();
      stage.dataset.scene = "ready";
      return;
    }
    hideMeter();

    // showTranslation(), and it STAYS. The board does not return to READY on its
    // own: the result is the resting scene until the next hold, and a tap of the
    // talk button plays it again.
    const speaking = session.phase === "speaking";
    stage.dataset.scene = "result";
    stage.dataset.footers = speaking ? "one" : "two";

    // A new translation always starts at its first line.
    if (shown.said !== scrolling) {
      scrolling = shown.said;
      scrollOffset = 0;
      stopScroll();
    }
    result.textContent = resultWindow(shown.said, scrollOffset).join("\n");
    const travel = resultTravel(shown.said);
    if (travel > 0) startScroll(travel);
    else stopScroll();
    footerOne.textContent = session.repeating ? "REPEATING"
      : speaking ? "SPEAKING"
      : "^ TAP REPEAT / HOLD NEW";
    footerTwo.textContent = speaking ? "" : resultAction();
  }

  /** drawBootIntro(): a bright centre line opens, resolves into the wordmark,
   *  and the fish bobs until there is something to show. */
  async function boot(): Promise<void> {
    const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // The board spends this long finding wifi. Locally /v1/pairs answers in
    // single-digit milliseconds, and an intro gone inside 300ms is a flicker.
    const settled = Date.now() + (reduced ? 0 : 1500);

    stage.dataset.scene = "boot";
    drawFish();
    if (!reduced) {
      for (let width = 8; width <= 216; width += 24) {
        bootLine.style.width = `${width}px`;
        await wait(20);
      }
      await wait(120);
    }
    bootLine.style.width = "0";

    let frame = 0;
    const bob = window.setInterval(() => {
      if (stage.dataset.scene !== "boot") return window.clearInterval(bob);
      drawFish(reduced ? 0 : BOB[frame]!);
      frame = (frame + 1) % BOB.length;
    }, 110);

    await wait(Math.max(0, settled - Date.now()));
    window.clearInterval(bob);
    booting = false;
    render();
  }

  matchAdvance(result, RESULT_ADVANCE);
  fit();
  window.addEventListener("resize", fit);
  session.subscribe(render);
  // The board boots every time it is switched on; so does this, once.
  if (session.phase === "loading") stage.dataset.scene = "boot";
  boot();

  return () => {
    hideMeter();
    stopScroll();
    window.removeEventListener("resize", fit);
  };
}
