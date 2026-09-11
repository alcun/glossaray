import { expect, test, describe } from "bun:test";
import { pairIsSupported, setupMessage, supportedPairs } from "../src/config";

describe("the pair allowlist", () => {
  test("every language uses the one Agent model", () => {
    expect(pairIsSupported("en", "cy", "agent")).toBe(true);
    expect(pairIsSupported("en", "it", "agent")).toBe(true);
    expect(pairIsSupported("fr", "en", "agent")).toBe(true);
    expect(pairIsSupported("zh", "en", "agent")).toBe(true);
    expect(new Set(supportedPairs().map((pair) => pair.mode))).toEqual(new Set(["agent"]));
  });

  test("nonsense is refused rather than passed upstream", () => {
    expect(pairIsSupported("en", "zz", "agent")).toBe(false);
    expect(pairIsSupported("en", "en", "agent")).toBe(false);
  });

  test("every pair the UI is offered is one the server would admit", () => {
    for (const pair of supportedPairs()) {
      expect(pairIsSupported(pair.source, pair.target, pair.mode)).toBe(true);
    }
  });
});

describe("the setup message", () => {
  test("every pair names the Agent model and locks translation", () => {
    for (const pair of supportedPairs()) {
      const setup = JSON.parse(setupMessage(pair.source, pair.target, pair.mode)).setup;
      expect(setup.model).toBe("models/gemini-3.1-flash-live-preview");
      expect(setup.generationConfig.responseModalities).toEqual(["AUDIO"]);
      expect(setup.inputAudioTranscription).toEqual({});
      expect(setup.outputAudioTranscription).toEqual({});
      expect(setup.systemInstruction.parts[0].text).toContain("Speak only the translation");
      expect(setup.translationConfig).toBeUndefined();
    }
  });

  test("the raw websocket uses camelCase, never the SDK's snake_case", () => {
    const setup = JSON.parse(setupMessage("en", "cy", "agent")).setup;
    expect(setup.response_modalities).toBeUndefined();
    expect(setup.input_audio_transcription).toBeUndefined();
    expect(setup.output_audio_transcription).toBeUndefined();
    expect(setup.system_instruction).toBeUndefined();
  });

  test("the client cannot select a different model", () => {
    const models = new Set(
      supportedPairs().map((p) => JSON.parse(setupMessage(p.source, p.target, p.mode)).setup.model),
    );
    expect(models).toEqual(new Set(["models/gemini-3.1-flash-live-preview"]));
  });
});
