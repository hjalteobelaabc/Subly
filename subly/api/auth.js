// Login og brugere. Tre måder: e-mail + adgangskode, Google og Facebook.
// Subly gemmer ingen adgangskoder i klartekst, og Google/Facebook-login giver Subly ingen adgangskode overhovedet.
import { checkPassword, currentUser, dbReady, endSession, hashPassword, ip, publicUser, randomId, redis, sameOrigin, send, sha, startSession, tooMany } from "./_lib.js";

const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[a-z]{2,}$/i;

async function createUser(fields) {
  const user = { id: randomId(16), created: new Date().toISOString(), ...fields };
  await redis("SET", `user:${user.id}`, JSON.stringify(user));
  return user;
}

async function viaIdentity(key, fields) {
  const existing = await redis("GET", key);
  if (existing) {
    const raw = await redis("GET", `user:${existing}`);
    if (raw) return JSON.parse(raw);
  }
  const user = await createUser({ ...fields, ident: key });
  await redis("SET", key, user.id);
  return user;
}

export default async function handler(req, res) {
  const action = String(req.query?.action || "");
  if (!dbReady()) return send(res, 503, { error: "not_configured" });

  try {
    if (req.method === "GET" && action === "me") {
      const u = await currentUser(req);
      return send(res, 200, { user: publicUser(u) });
    }
    if (req.method !== "POST") return send(res, 405, { error: "bad_request" });
    if (!sameOrigin(req)) return send(res, 403, { error: "forbidden" });
    const body = req.body || {};

    if (action === "logout") { await endSession(req, res); return send(res, 200, { ok: true }); }

    if (action === "register" || action === "login") {
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (!EMAIL.test(email) || password.length > 200) return send(res, 400, { error: "bad_input" });
      if (await tooMany(`auth:${sha(ip(req))}`, 20, 900) || await tooMany(`auth:${sha(email)}`, 8, 900)) return send(res, 429, { error: "rate_limited" });
      const id = await redis("GET", `email:${sha(email)}`);
      if (action === "register") {
        if (password.length < 10) return send(res, 400, { error: "weak_password" });
        if (body.consent !== true) return send(res, 400, { error: "consent_required" });
        if (id) return send(res, 409, { error: "exists" });
        const user = await createUser({ email, provider: "email", pw: hashPassword(password) });
        const ok = await redis("SET", `email:${sha(email)}`, user.id, "NX");
        if (ok !== "OK") { await redis("DEL", `user:${user.id}`); return send(res, 409, { error: "exists" }); }
        await startSession(res, user.id);
        return send(res, 200, { user: publicUser(user) });
      }
      const raw = id ? await redis("GET", `user:${id}`) : null;
      const user = raw ? JSON.parse(raw) : null;
      if (!checkPassword(password, user?.pw)) return send(res, 401, { error: "wrong_login" });
      await startSession(res, user.id);
      return send(res, 200, { user: publicUser(user) });
    }

    if (action === "google") {
      if (await tooMany(`auth:${sha(ip(req))}`, 20, 900)) return send(res, 429, { error: "rate_limited" });
      const token = String(body.credential || "");
      if (!token || token.length > 4000) return send(res, 400, { error: "bad_input" });
      // Google tjekker selv signatur og udløb. Vi tjekker at tokenet er udstedt til netop Subly.
      const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(token), { signal: AbortSignal.timeout(8000) });
      const t = await r.json().catch(() => ({}));
      const okIss = t.iss === "accounts.google.com" || t.iss === "https://accounts.google.com";
      if (!r.ok || !okIss || t.aud !== process.env.GOOGLE_CLIENT_ID || !t.sub || Number(t.exp) * 1000 < Date.now()) return send(res, 401, { error: "wrong_login" });
      const user = await viaIdentity(`google:${t.sub}`, { provider: "google", email: t.email_verified === "true" || t.email_verified === true ? String(t.email || "") : "", name: String(t.name || "").slice(0, 80) });
      await startSession(res, user.id);
      return send(res, 200, { user: publicUser(user) });
    }

    if (action === "facebook") {
      const appId = process.env.FACEBOOK_APP_ID, secret = process.env.FACEBOOK_APP_SECRET;
      if (!appId || !secret) return send(res, 503, { error: "not_configured" });
      if (await tooMany(`auth:${sha(ip(req))}`, 20, 900)) return send(res, 429, { error: "rate_limited" });
      const token = String(body.accessToken || "");
      if (!token || token.length > 1000) return send(res, 400, { error: "bad_input" });
      // Tjek at tokenet er udstedt til Sublys Facebook-app, så et token fra en anden app ikke kan bruges.
      const dbg = await fetch(`https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(appId + "|" + secret)}`, { signal: AbortSignal.timeout(8000) }).then(r => r.json()).catch(() => ({}));
      const d = dbg.data || {};
      if (!d.is_valid || String(d.app_id) !== String(appId) || !d.user_id) return send(res, 401, { error: "wrong_login" });
      const me = await fetch(`https://graph.facebook.com/me?fields=id,name,email&access_token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(8000) }).then(r => r.json()).catch(() => ({}));
      if (String(me.id) !== String(d.user_id)) return send(res, 401, { error: "wrong_login" });
      const user = await viaIdentity(`fb:${me.id}`, { provider: "facebook", email: String(me.email || ""), name: String(me.name || "").slice(0, 80) });
      await startSession(res, user.id);
      return send(res, 200, { user: publicUser(user) });
    }

    if (action === "delete") {
      const u = await currentUser(req);
      if (!u) return send(res, 401, { error: "login_required" });
      const keys = [`user:${u.id}`, `data:${u.id}`];
      if (u.provider === "email" && u.email) keys.push(`email:${sha(u.email)}`);
      if (u.ident) keys.push(u.ident);
      await redis("DEL", ...keys);
      await endSession(req, res);
      return send(res, 200, { ok: true });
    }

    return send(res, 400, { error: "bad_request" });
  } catch (e) {
    console.error("auth fejl", e?.message);
    return send(res, 500, { error: "server_error" });
  }
}
