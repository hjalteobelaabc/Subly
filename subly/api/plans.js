// Finder planer og priser for et abonnement, som Subly ikke kender i forvejen.
// Bruger Claudes websøgning, så priserne kommer fra nettet. Virker websøgning ikke, bruges modellens viden, og svaret markeres som usikkert.
import { claude, limited, parseJson, sameOrigin, send } from "./_lib.js";

const ASK = (service) => `Find de aktuelle abonnementsplaner og priser i Danmark (DKK) for tjenesten: "${service}".
Brug helst tjenestens egen danske side. Svar KUN med ét JSON-objekt i dette format:
{"found": true, "service": "Officielt navn", "category": "Streaming", "url": "https://kilde", "plans": [{"name": "Plan", "price": 129, "cycle": "monthly"}]}
Regler:
- "category" er én af: Streaming, Musik, Software, Sundhed, Andet.
- "cycle" er "monthly", "quarterly" eller "yearly".
- "price" er prisen i danske kroner som tal. Kender du ikke prisen sikkert, så brug null.
- Højst 8 planer.
- Er det ikke et abonnement, eller kan du ikke finde tjenesten, så svar {"found": false}.
- Opfind aldrig planer eller priser.`;

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "bad_request" });
  if (!sameOrigin(req)) return send(res, 403, { error: "forbidden" });
  if (limited(req, 8)) return send(res, 429, { error: "rate_limited" });
  const service = String(req.body?.service || "").replace(/[\u0000-\u001f"<>]/g, "").trim().slice(0, 60);
  if (service.length < 2) return send(res, 400, { error: "bad_request" });

  let out = await claude({
    max_tokens: 900,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2, user_location: { type: "approximate", country: "DK" } }],
    messages: [{ role: "user", content: ASK(service) }],
  });
  let verified = true;
  if (out.error && out.error !== "quota_reached" && out.error !== "not_configured") {
    // Websøgning ikke tilgængelig: prøv uden, og marker som usikkert.
    verified = false;
    out = await claude({ max_tokens: 600, messages: [{ role: "user", content: ASK(service) + "\nDu har ikke adgang til internettet. Brug kun det, du er sikker på, og sæt price til null ved tvivl." }] });
  }
  if (out.error) return send(res, out.status, { error: out.error });
  const j = parseJson(out.text);
  if (!j || typeof j !== "object") return send(res, 200, { found: false });
  return send(res, 200, { ...j, verified });
}
