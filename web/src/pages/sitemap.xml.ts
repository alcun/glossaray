import type { APIRoute } from "astro";

const site = import.meta.env.PUBLIC_SITE_URL || "http://localhost:3000";

export const GET: APIRoute = () =>
  new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${new URL("/", site).href}</loc></url>\n</urlset>\n`,
    { headers: { "content-type": "application/xml; charset=utf-8" } },
  );
