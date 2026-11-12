// Henter tjenesternes rigtige logo (favicon) via serveren og cacher det.
// Så ser Google/DuckDuckGo ikke, hvilke abonnementer den enkelte bruger har. Kun gyldige domænenavne accepteres.
const DOMAIN = /^(?=.{3,100}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const TYPES = /^image\/(png|x-icon|vnd\.microsoft\.icon|jpeg|gif|webp)$/;

function pngWidth(buf) {
  return buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 ? buf.readUInt32BE(16) : null;
}

async function grab(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "follow" });
    const type = (r.headers.get("content-type") || "").split(";")[0].trim();
    if (!r.ok || !TYPES.test(type)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 300_000) return null;
    const w = pngWidth(buf);
    if (w !== null && w < 32) return null; // for lille eller Googles standardikon
    return { type, buf };
  } catch { return null; }
}

export default async function handler(req, res) {
  const d = String(req.query?.d || "").toLowerCase();
  if (!DOMAIN.test(d)) return res.status(400).end();
  const img = await grab(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=128`)
    || await grab(`https://icons.duckduckgo.com/ip3/${encodeURIComponent(d)}.ico`);
  if (!img) {
    res.setHeader("Cache-Control", "public, s-maxage=86400");
    return res.status(404).end();
  }
  res.setHeader("Content-Type", img.type);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "public, max-age=604800, s-maxage=2592000, stale-while-revalidate=86400");
  return res.status(200).send(img.buf);
}
