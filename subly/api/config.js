// Offentlig konfiguration til browseren. Et Google OAuth-klient-ID er ikke hemmeligt.
export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ googleClientId: process.env.GOOGLE_CLIENT_ID || "" });
}
