/**
 * The result pane wraps in the FIRMWARE's units, not the browser's.
 *
 * drawWrappedResult() uses u8g2 unifont at size 2 - 16px a character across
 * 288px, so eighteen columns - while the rest of the panel is the 5x7 GFX face
 * at 12px. Leaving this to the browser put line breaks on screen that the board
 * would never produce, in the one scene where wrapping decides what fits.
 */
import { expect, test, describe } from "bun:test";
import { wrapResult, resultWindow, resultTravel, errorScene } from "../src/scripts/device";

const width = (lines: string[]) => Math.max(...lines.map((l) => l.length));

describe("the result wraps where the board wraps", () => {
  test("no line is wider than the panel", () => {
    const lines = wrapResult(
      "Mi scusi, sto cercando la stazione ferroviaria piu vicina, e vorrei " +
      "sapere anche a che ora parte il prossimo treno per Roma.",
    );
    expect(width(lines)).toBeLessThanOrEqual(18);
  });

  test("it breaks between words, not inside them", () => {
    const lines = wrapResult("dove si trova la stazione piu vicina");
    for (const line of lines) expect(line.trim()).toBe(line);
    expect(lines.join(" ")).toBe("dove si trova la stazione piu vicina");
  });

  test("a word wider than the panel breaks at glyph boundaries, as the firmware does", () => {
    const lines = wrapResult("Llanfairpwllgwyngyllgogerychwyrndrobwllllantysiliogogogoch");
    expect(width(lines)).toBeLessThanOrEqual(18);
    expect(lines.join("")).toBe("Llanfairpwllgwyngyllgogerychwyrndrobwllllantysiliogogogoch");
  });

  test("twenty-four columns would have fitted more, which is the bug", () => {
    // The panel's own advance is 12px, so the browser was fitting 24 characters
    // where the board fits 18. Anything in between is a line break the board
    // would never draw.
    const lines = wrapResult("dove si trova la stazione");
    expect(lines.length).toBeGreaterThan(1);
  });
});

describe("what does not fit moves, and is not dropped", () => {
  const long = Array.from({ length: 24 }, (_, i) => `riga${i}`).join(" ");

  test("a translation that fits does not travel", () => {
    expect(resultTravel("dove si trova la stazione")).toBe(0);
    expect(resultWindow("dove si trova la stazione", 0).join(" "))
      .toBe("dove si trova la stazione");
  });

  test("the pane never shows more than the board's seven lines", () => {
    expect(wrapResult(long).length).toBeGreaterThan(7);
    for (let at = 0; at <= resultTravel(long); at++) {
      expect(resultWindow(long, at).length).toBeLessThanOrEqual(7);
    }
  });

  test("every line is reachable, which is the whole point", () => {
    const seen = new Set<string>();
    for (let at = 0; at <= resultTravel(long); at++) {
      for (const line of resultWindow(long, at)) seen.add(line);
    }
    // Nothing is lost off the bottom the way it was when the board clipped.
    expect([...seen].sort()).toEqual([...wrapResult(long)].sort());
  });

  test("the last step lands on the end of the translation", () => {
    const lines = wrapResult(long);
    expect(resultWindow(long, resultTravel(long)).at(-1)).toBe(lines.at(-1));
  });

  test("an offset past the end is clamped, not blank", () => {
    expect(resultWindow(long, 999)).toEqual(resultWindow(long, resultTravel(long)));
  });

  test("an empty result is empty and still", () => {
    expect(resultWindow("", 0)).toEqual([]);
    expect(resultTravel("")).toBe(0);
  });
});

describe("what the panel says went wrong", () => {
  test("an unrecognised failure is the provider's, not the connection's", () => {
    // The firmware's own default. Saying TIMEOUT / CHECK CONNECTION for every
    // unknown upstream failure sends people to fix the wrong thing.
    expect(errorScene("something_new")).toEqual(["PROVIDER ERROR", "TRY AGAIN"]);
  });

  test("the two things that really do time out still say so", () => {
    expect(errorScene("idle")[0]).toBe("TIMEOUT");
    expect(errorScene("session_expired")[0]).toBe("TIMEOUT");
  });

  test("the board's own codes keep the board's own words", () => {
    expect(errorScene("busy")).toEqual(["BUSY", "TRY AGAIN"]);
    expect(errorScene("too_short")).toEqual(["ERROR", "HOLD LONGER"]);
  });
});
