// Fælles serverkode. Filer der starter med "_" bliver ikke til endpoints på Vercel.
export const MODEL = "claude-haiku-5-5"; // Anthropics billigste model (november 2026)

const hits = new Map();
export function limited(req, max) {
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "ukendt";
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < 60_000);
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) for (const k of [...hits.keys()].slice(0, 2500)) hits.delete(k);
  return list.length > max;
}

// Kun kald fra selve siden. Det stopper ikke et målrettet script, men det stopper andre hjemmesider.
export function sameOrigin(req) {
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").toLowerCase();
  const src = req.headers.origin || req.headers.referer || "";
  if (!src || !host) return false;
  try { return new URL(src).host.toLowerCase() === host; } catch { return false; }
}

export function send(res, status, body) { res.setHeader("Cache-Control", "no-store"); res.status(status).json(body); }

export async function claude(body) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { error: "not_configured", status: 500 };
  let r;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, ...body }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch {
    return { error: "upstream_error", status: 502 };
  }
  const out = await r.json().catch(() => null);
  if (!r.ok) {
    console.error("Claude API fejl", r.status, out?.error);
    const msg = String(out?.error?.message || "").toLowerCase();
    if (msg.includes("usage limit") || msg.includes("credit balance") || msg.includes("spend limit")) return { error: "quota_reached", status: 402 };
    return { error: r.status === 429 ? "rate_limited" : "upstream_error", status: r.status === 429 ? 429 : 502, raw: msg };
  }
  const text = (out?.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  return { text };
}

export function parseJson(text) {
  try { return JSON.parse(text); } catch {}
  const f = String(text).match(/```(?:json)?\s*([\s\S]*?)```/); if (f) { try { return JSON.parse(f[1]); } catch {} }
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch {} }
  return null;
}
