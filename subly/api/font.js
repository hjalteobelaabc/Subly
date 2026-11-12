// Skrifttyper serveres fra Sublys eget domæne, så besøgende ikke kontakter Google Fonts eller et CDN (GDPR).
// Serveren henter filen én gang, og Vercels CDN cacher den i et år. Licens: SIL Open Font License 1.1.
const FONTS = {
  manrope: "https://cdn.jsdelivr.net/npm/@fontsource-variable/manrope@5.3.0/files/manrope-latin-wght-normal.woff2",
  "dm-sans": "https://cdn.jsdelivr.net/npm/@fontsource-variable/dm-sans@5.3.0/files/dm-sans-latin-wght-normal.woff2",
};

export default async function handler(req, res) {
  const url = FONTS[String(req.query?.f || "")];
  if (!url) return res.status(404).end();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return res.status(502).end();
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", "font/woff2");
    res.setHeader("Cache-Control", "public, max-age=31536000, s-maxage=31536000, immutable");
    return res.status(200).send(buf);
  } catch {
    return res.status(502).end();
  }
}
