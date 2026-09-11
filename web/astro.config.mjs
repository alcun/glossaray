// Static output. The Bun server in ../server serves this directory and owns
// /ws; there is no SSR here and nothing on this side needs a runtime.
import { defineConfig } from "astro/config";

export default defineConfig({
  output: "static",
  site: process.env.PUBLIC_SITE_URL || "http://localhost:3000",
  build: { format: "file" },
});
