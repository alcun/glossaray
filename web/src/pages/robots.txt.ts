// Without these files the server's index.html fallback answered /robots.txt
// and /sitemap.xml with the page itself.
import type { APIRoute } from "astro";

const site = import.meta.env.PUBLIC_SITE_URL || "http://localhost:3000";

export const GET: APIRoute = () =>
  new Response(`User-agent: *\nAllow: /\n\nSitemap: ${new URL("/sitemap.xml", site).href}\n`, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
