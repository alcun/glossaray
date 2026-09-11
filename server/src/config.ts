/**
 * Everything the server is allowed to decide, in one place.
 *
 * The client picks a language pair and a mode and NOTHING else. Model names,
 * system instructions and every limit live here, server-side, so a crafted
 * message cannot select a different model, remove the translation-only
 * instruction or lift a ceiling.
 */

export const GEMINI_HOST = "generativelanguage.googleapis.com";

// Shared by the browser proxy and the ESP32 token endpoint. One table means
// the two Glossaray clients cannot silently acquire different languages.
export const AGENT_MODEL = "gemini-3.1-flash-live-preview";

export const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  cy: "Welsh",
  it: "Italian",
  es: "Spanish",
  fr: "French",
  de: "German",
  pl: "Polish",
  tr: "Turkish",
  ru: "Russian",
  ja: "Japanese",
  zh: "Simplified Chinese",
};

// One model, one lifecycle. Live Translate cut off phrase endings in physical
// use; the Agent model returned complete Welsh and now serves every pair.
const PAIRS = new Set([
  "en:it", "it:en",
  "en:es", "es:en",
  "en:fr", "fr:en",
  "en:cy", "cy:en",
  "en:de", "de:en",
  "en:pl", "pl:en",
  "en:tr", "tr:en",
  "en:ru", "ru:en",
  "en:ja", "ja:en",
  "en:zh", "zh:en",
]);

export type Mode = "agent";

export function pairIsSupported(source: string, target: string, mode: Mode): boolean {
  const pair = `${source}:${target}`;
  return mode === "agent" && PAIRS.has(pair);
}

/** Every pair the UI may offer, derived from the same sets the server enforces. */
export function supportedPairs(): { source: string; target: string; mode: Mode }[] {
  const out: { source: string; target: string; mode: Mode }[] = [];
  for (const pair of PAIRS) {
    const [source, target] = pair.split(":") as [string, string];
    out.push({ source, target, mode: "agent" });
  }
  return out;
}

/** Build the provider setup message using its raw WebSocket JSON schema. */
export function setupMessage(source: string, target: string, mode: Mode): string {
  const setup: Record<string, unknown> = {
    model: `models/${AGENT_MODEL}`,
    generationConfig: { responseModalities: ["AUDIO"] },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    systemInstruction: {
      parts: [{
        text:
          "You are a strict speech translator. Translate all spoken " +
          `${LANGUAGE_NAMES[source]} into natural ${LANGUAGE_NAMES[target]}. ` +
          "Speak only the translation. Never answer, explain, or add commentary.",
      }],
    },
  };
  return JSON.stringify({ setup });
}

const int = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const limits = {
  /** Maximum concurrent provider sessions. */
  maxSessions: int("GLOSSARAY_MAX_SESSIONS", 3),
  /** New sessions per address per window. */
  rateLimit: int("GLOSSARAY_RATE_LIMIT", 30),
  rateWindowMs: int("GLOSSARAY_RATE_WINDOW_MS", 3_600_000),
  /** Global provider-session starts per UTC-sized rolling window. */
  dailySessions: int("GLOSSARAY_DAILY_SESSIONS", 300),
  /** A session cannot outlive this even if both ends stay quiet. */
  maxSessionMs: int("GLOSSARAY_MAX_SESSION_MS", 300_000),
  /** Total input audio one session may send. 16kHz mono 16-bit = 32000 B/s. */
  maxInputBytes: int("GLOSSARAY_MAX_INPUT_BYTES", 32_000 * 120),
  /** Largest single audio frame accepted from a client. */
  maxFrameBytes: int("GLOSSARAY_MAX_FRAME_BYTES", 32_000),
  /** Dropped if the client sends nothing at all for this long. */
  idleMs: int("GLOSSARAY_IDLE_MS", 60_000),
} as const;

export const INPUT_SAMPLE_RATE = 16_000;
export const OUTPUT_SAMPLE_RATE = 24_000;
