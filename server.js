import express from "express";
import qrcode from "qrcode";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} from "@adiwajshing/baileys";
import pino from "pino";

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "changeme";
const SESSION_NAME = process.env.SESSION_NAME || "trello-session";

const app = express();
app.use(express.json());

// Seguridad simple: x-api-key (QR y raíz libres)
app.use((req, res, next) => {
  if (req.path.startsWith("/qr") || req.path === "/") return next();
  const key = req.headers["x-api-key"];
  if (!key || key !== API_KEY) return res.status(401).json({ error: "unauthorized" });
  next();
});

let sock;
let lastQR = null;
let ready = false;

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(`./auth_${SESSION_NAME}`);
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({
    version,
    printQRInTerminal: false,
    auth: state,
    logger: pino({ level: "silent" })
  });

  sock.ev.on("connection.update", (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) lastQR = qr;
    if (connection === "open") { ready = true; lastQR = null; console.log("WA listo ✅"); }
    if (connection === "close") {
      ready = false;
      const shouldReconnect =
        (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) start();
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

app.get("/", (_req, res) => res.json({ ok: true, ready }));

app.get("/qr", async (_req, res) => {
  if (ready) return res.send("✅ Ya está conectado.");
  if (!lastQR) return res.send("⏳ Esperando QR, recarga en unos segundos…");
  const dataUrl = await qrcode.toDataURL(lastQR);
  res.send(`<html><body style="display:grid;place-items:center;height:100vh">
  <h3>Escanea este QR con WhatsApp</h3>
  <img src="${dataUrl}" style="width:320px;height:320px"/>
  </body></html>`);
});

// Enviar texto
app.post("/send", async (req, res) => {
  try {
    if (!ready) return res.status(503).json({ error: "not_ready" });
    const { to, text } = req.body;
    if (!to || !text) return res.status(400).json({ error: "missing_to_or_text" });
    const jid = to.replace(/\D/g, "") + "@s.whatsapp.net";
    await sock.sendMessage(jid, { text });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "send_failed" });
  }
});

app.listen(PORT, () => {
  console.log(`HTTP up on :${PORT}`);
  start();
});
