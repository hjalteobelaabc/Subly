// Gemmer og henter brugerens abonnementer. Kræver login. Kun brugerens egne data kan læses.
import { currentUser, dbReady, redis, sameOrigin, send } from "./_lib.js";

const MAX = 200_000;

export default async function handler(req, res) {
  if (!dbReady()) return send(res, 503, { error: "not_configured" });
  try {
    const u = await currentUser(req);
    if (!u) return send(res, 401, { error: "login_required" });
    if (req.method === "GET") {
      const raw = await redis("GET", `data:${u.id}`);
      return send(res, 200, { data: raw ? JSON.parse(raw) : null });
    }
    if (req.method === "PUT") {
      if (!sameOrigin(req)) return send(res, 403, { error: "forbidden" });
      const d = req.body?.data;
      if (!d || typeof d !== "object" || !Array.isArray(d.subs) || d.subs.length > 500) return send(res, 400, { error: "bad_input" });
      const text = JSON.stringify(d);
      if (text.length > MAX) return send(res, 413, { error: "too_large" });
      await redis("SET", `data:${u.id}`, text);
      return send(res, 200, { ok: true });
    }
    return send(res, 405, { error: "bad_request" });
  } catch (e) {
    console.error("data fejl", e?.message);
    return send(res, 500, { error: "server_error" });
  }
}
