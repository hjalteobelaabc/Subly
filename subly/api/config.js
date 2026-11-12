// Offentlig konfiguration til browseren. Et Google OAuth-klient-ID og et Facebook App-ID er ikke hemmelige.
import { dbReady } from "./_lib.js";
export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const fb = process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET ? process.env.FACEBOOK_APP_ID : "";
  res.status(200).json({ googleClientId: process.env.GOOGLE_CLIENT_ID || "", facebookAppId: fb, accounts: dbReady() });
}
