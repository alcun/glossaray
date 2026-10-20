// What an assistant needs to describe Glossaray or point someone at it. The
// facts mirror README.md. The web build cannot see server/, so the language
// list is restated here: change it with server/src/config.ts.
import type { APIRoute } from "astro";

const site = import.meta.env.PUBLIC_SITE_URL || "http://localhost:3000";

export const GET: APIRoute = () =>
  new Response(
    `# Glossaray

> Speech translation in a browser or on an ESP32 handheld. Hold to speak, release to hear the translation, tap to repeat it.

- Web app: ${new URL("/", site).href}. Works in a browser with a microphone. There is no API for agents: the page and paired devices stream audio over a WebSocket.
- Languages: English to and from Welsh, Italian, Spanish, French, German, Polish, Turkish, Russian, Japanese and Simplified Chinese.
- Privacy: audio is streamed to Google Gemini for translation. The server does not write audio or transcripts to disk.
- Open source and self-hostable with your own Gemini API key.

## Docs

- [Source and self-hosting](https://github.com/alcun/glossaray): setup, configuration and device pairing
- [Device firmware](https://github.com/alcun/glossaray-device): the handheld translator
`,
    { headers: { "content-type": "text/plain; charset=utf-8" } },
  );
