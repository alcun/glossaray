/**
 * The browser renderer: the same session, without the panel's constraints.
 *
 * What it may do that the device cannot, and only because a browser can:
 * both sides of the exchange on screen at once, text streaming in as it is
 * heard rather than after the release, the last several turns kept, and no
 * seven-line ceiling. Device mode holds the same text back until the turn
 * closes, because the board is a walkie-talkie and cannot show half a sentence;
 * that is a rendering choice and the only difference between the two views.
 * What this may NOT do is behave differently - every rule about the microphone,
 * the turn and the pair lives in `session.ts`, which this only reads.
 */
import type { Session } from "./session";
import { LANGUAGE_NAMES } from "./session";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function errorText(code: string): string {
  if (code === "busy") return "All three lines are busy. Try again in a moment.";
  if (code === "rate_limited") return "Too many turns for now. Try again later.";
  if (code === "unsupported_pair") return "That pair is not available.";
  if (code === "unconfigured") return "The translator is not configured.";
  if (code === "too_short") return "Hold the button for longer.";
  if (code === "mic_blocked") return "Allow the microphone to translate.";
  if (code === "offline") return "Cannot reach the server. Tap to try again.";
  if (code === "session_expired" || code === "idle") return "That took too long. Try again.";
  // Not "connection lost": an unrecognised failure is the provider's, and
  // blaming the network sends people to fix the wrong thing.
  return "The translator failed. Try again.";
}

export function mountWeb(session: Session): () => void {
  const log = $<HTMLDivElement>("log");
  const empty = $<HTMLParagraphElement>("logEmpty");
  const sourceSelect = $<HTMLSelectElement>("webSource");
  const targetSelect = $<HTMLSelectElement>("webTarget");
  const swapButton = $<HTMLButtonElement>("webSwap");
  const hint = $<HTMLParagraphElement>("webHint");
  const talk = $<HTMLButtonElement>("webTalk");

  function fillSelects(): void {
    sourceSelect.innerHTML = session.sources()
      .map((c) => `<option value="${c}">${LANGUAGE_NAMES[c] ?? c}</option>`).join("");
    sourceSelect.value = session.source;
    targetSelect.innerHTML = session.targets()
      .map((c) => `<option value="${c}">${LANGUAGE_NAMES[c] ?? c}</option>`).join("");
    targetSelect.value = session.target;
    // Only offer the swap when the reverse pair is one the server admits.
    swapButton.disabled = !session.canSwap();
  }

  function render(): void {
    fillSelects();
    talk.dataset.holding = String(session.holding);
    talk.textContent =
      session.phase === "setup" ? "Allow the microphone"
      : session.holding ? "Listening - release when done"
      : "Hold to talk";

    hint.textContent =
      session.phase === "error" ? errorText(session.errorCode)
      // Asked once and on its own: the permission dialog would otherwise eat
      // the first hold, and a fumbled first turn reads as a broken app.
      : session.phase === "setup" ? "One tap to let the browser use your microphone"
      : session.phase === "translating" ? "Translating"
      // A tap rather than a hold plays the last translation again, in both
      // views - it is the board's repeat gesture and it lives in the session.
      : session.repeating ? "Playing that again"
      : session.phase === "speaking" ? "Speaking"
      : "Hold, speak, release";
    hint.dataset.tone = session.phase === "error" ? "error" : "normal";

    empty.hidden = session.turns.length > 0;
    log.replaceChildren(...session.turns.flatMap((turn) => {
      const rows: HTMLElement[] = [];
      if (turn.heard) rows.push(row(turn.source, turn.heard, "said-by-you"));
      if (turn.said) rows.push(row(turn.target, turn.said, "said-by-it"));
      return rows;
    }));
    log.scrollTop = log.scrollHeight;
  }

  function row(code: string, text: string, kind: string): HTMLElement {
    const line = document.createElement("p");
    line.className = `line ${kind}`;
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = code.toUpperCase();
    const body = document.createElement("span");
    body.className = "body";
    body.textContent = text;
    line.append(tag, body);
    return line;
  }

  const onSource = () => {
    // Changing what you speak can strand the target; take the first it allows.
    const targets = session.targets(sourceSelect.value);
    session.setPair(sourceSelect.value, targets.includes(session.target)
      ? session.target : targets[0]!);
  };
  const onTarget = () => session.setPair(session.source, targetSelect.value);
  const onSwap = () => session.swap();

  sourceSelect.addEventListener("change", onSource);
  targetSelect.addEventListener("change", onTarget);
  swapButton.addEventListener("click", onSwap);
  session.subscribe(render);
  render();

  return () => {
    sourceSelect.removeEventListener("change", onSource);
    targetSelect.removeEventListener("change", onTarget);
    swapButton.removeEventListener("click", onSwap);
  };
}
