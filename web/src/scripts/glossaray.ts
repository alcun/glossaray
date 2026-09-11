/**
 * Glossaray on the web: one session, two renderings of it.
 *
 * DEVICE is firmware/glossaray/src/display.cpp in a browser, and it is the point -
 * a playground for the board where a change can be tried without a re-flash.
 * WEB is the same session with the browser's affordances instead of the
 * panel's. Both drive `session.ts` and neither may hold state of its own, so
 * what is true in one is true in the other, and true of the board.
 *
 * The mode control sits OUTSIDE the panel deliberately. Put it on the 368x448
 * surface and device mode stops being device mode.
 */
import { Session } from "./session";
import { mountDevice } from "./device";
import { mountWeb } from "./webmode";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const app = $<HTMLDivElement>("app");
const talk = $<HTMLButtonElement>("talk");
const webTalk = $<HTMLButtonElement>("webTalk");
const pairLine = $<HTMLButtonElement>("pair");
const tapNext = $<HTMLButtonElement>("tapNext");
const swapLine = $<HTMLButtonElement>("swap");
const modeButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-mode]")];

const session = new Session();
const STORAGE_KEY = "glossaray-mode";

function setMode(mode: "device" | "web", remember = true): void {
  app.dataset.mode = mode;
  for (const button of modeButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
  }
  if (remember) {
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // A private window refuses this. It is a preference, not a requirement.
    }
  }
}

function savedMode(): "device" | "web" {
  // ?mode=web wins over the stored preference, so a link can name the view it
  // wants to be seen in. It is not remembered: a link should not quietly change
  // what this browser opens in next time.
  const asked = new URLSearchParams(location.search).get("mode");
  if (asked === "web" || asked === "device") return asked;
  try {
    return localStorage.getItem(STORAGE_KEY) === "web" ? "web" : "device";
  } catch {
    return "device";
  }
}

/* Holding, in both modes. A long press is a hold, never a context menu, and a
 * pointer that ends anywhere at all must end the turn: a release outside the
 * capture, a hidden tab or a lost window used to leave the microphone open and
 * a session held until it timed out. */
function wireHold(button: HTMLButtonElement): void {
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    session.startHold();
  });
  button.addEventListener("pointerup", () => session.endHold());
  button.addEventListener("pointercancel", () => session.endHold());
  button.addEventListener("contextmenu", (event) => event.preventDefault());
}

wireHold(talk);
wireHold(webTalk);

/*
 * In device mode the space AROUND the panel is the button too.
 *
 * The board's button is a physical one, not a region of its screen, so this is
 * closer to the device rather than further from it - and on a phone it is the
 * difference between reaching for the middle of a centred 368x448 panel and
 * holding the thing anywhere your thumb already is. Web mode has its own big
 * button at the bottom of the screen and does not need this.
 *
 * The panel keeps its own handlers, so anything inside it - the pair line, TAP
 * NEXT, the talk area - behaves exactly as before, and the mode switch stays a
 * switch.
 */
app.addEventListener("pointerdown", (event) => {
  if (app.dataset.mode !== "device") return;
  const target = event.target as HTMLElement | null;
  if (target?.closest(".stage, .modes, .web")) return;
  event.preventDefault();
  session.startHold();
});
window.addEventListener("pointerup", () => session.endHold());
window.addEventListener("blur", () => session.endHold());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) session.endHold();
});

pairLine.addEventListener("click", () => session.cycleTarget());
tapNext.addEventListener("click", () => session.cycleTarget());
swapLine.addEventListener("click", () => session.swap());
for (const button of modeButtons) {
  button.addEventListener("click", () => setMode(button.dataset.mode as "device" | "web"));
}

setMode(savedMode(), false);
// Both renderers are mounted at once and CSS shows one. They are pure views of
// the session, so the hidden one costs a few DOM writes and cannot go stale
// while it is out of sight.
mountDevice(session);
// The session renders its own failure - a panel that cannot reach the server
// says so and offers a retry, rather than being written over from out here.
session.load().catch(() => {});
mountWeb(session);
