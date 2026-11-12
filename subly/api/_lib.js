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

// ---------- Database (Upstash Redis via REST). Nøglerne sættes af Vercel, aldrig i koden. ----------
import crypto from "node:crypto";

const RURL = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const RTOK = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
export const dbReady = () => Boolean(RURL() && RTOK());

export async function redis(...cmd) {
  const r = await fetch(RURL(), {
    method: "POST",
    headers: { Authorization: `Bearer ${RTOK()}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error("db_error");
  return j.result;
}

// Begrænsning der virker på tværs af serverinstanser (bruges til login).
export async function tooMany(key, max, seconds) {
  const n = await redis("INCR", `rl:${key}`);
  if (n === 1) await redis("EXPIRE", `rl:${key}`, seconds);
  return n > max;
}

export const ip = (req) => String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "ukendt";
export const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
export const randomId = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

// ---------- Adgangskoder: scrypt med salt. Selve adgangskoden gemmes aldrig. ----------
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}
export function checkPassword(pw, stored) {
  const [alg, salt, key] = String(stored || "").split("$");
  if (alg !== "scrypt" || !salt || !key) { crypto.scryptSync(pw, "x", 64); return false; }
  const want = Buffer.from(key, "base64");
  const got = crypto.scryptSync(pw, Buffer.from(salt, "base64"), want.length, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(want, got);
}

// ---------- Sessioner: tilfældigt ID i en HttpOnly-cookie. I databasen ligger kun en hash af ID'et. ----------
const COOKIE = "subly_sid";
const SESSION_DAYS = 30;
export function readCookie(req, name = COOKIE) {
  const m = String(req.headers.cookie || "").split(/;\s*/).find(c => c.startsWith(name + "="));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : "";
}
export async function startSession(res, userId) {
  const sid = randomId();
  await redis("SET", `sess:${sha(sid)}`, userId, "EX", SESSION_DAYS * 86400);
  res.setHeader("Set-Cookie", `${COOKIE}=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
}
export async function endSession(req, res) {
  const sid = readCookie(req);
  if (sid) await redis("DEL", `sess:${sha(sid)}`).catch(() => {});
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}
export async function currentUser(req) {
  const sid = readCookie(req);
  if (!sid || sid.length > 100) return null;
  const id = await redis("GET", `sess:${sha(sid)}`);
  if (!id) return null;
  const raw = await redis("GET", `user:${id}`);
  return raw ? JSON.parse(raw) : null;
}
export const publicUser = (u) => u && ({ id: u.id, email: u.email || "", name: u.name || "", provider: u.provider, created: u.created });
