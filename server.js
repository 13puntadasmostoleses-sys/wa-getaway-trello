const express = require("express");
const QRCode = require("qrcode");
const pino = require("pino");
const fs = require("fs");
const path = require("path");

const {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");

// === ENV ===
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "changeme";
const SESSION_NAME = process.env.SESSION_NAME || "trello-session";
const NODE_ENV = process.env.NODE_ENV || "production";

// === Paths (relativos, escritura segura en Railway) ===
const authDir = path.join(process.cwd(), "auth", SESSION_NAME);
fs.mkdirSync(authDir, { recursive: true });

// === App ===
const app = express();
app.use(express.json());

// Seguridad simple por header x-api-key (se permiten GET /, /qr, /status)
app.use((req, res, next) => {
  if (req.method === "GET" && (req.path === "/" || req.path === "/qr" || req.path === "/status")) {
    return next();
  }
  if (req.path.startsWith("/qr") || req.path === "/") return next();
  const key = req.headers["x-api-key"];
  if (key !== API_KEY) return res.status(401).json({ error: "unauthorized" });
  next();
});

let sock = null;
let lastQr = null;
let connected = false;

// === Helpers de log ===
const log = (...args) => console.log("[WA]", ...args);
const logger = pino({ level: "silent" });

// === Start WhatsApp ===
async function startSock() {
  try {
    log("Iniciando Baileys…");
    const { version } = await fetchLatestBaileysVersion();
    log("Versión Baileys/WA:", version);

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: true, // ASCII en logs
      auth: state,
      browser: ["RailwayBot", "Chrome", "18"],
      connectTimeoutMs: 60_000,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { qr, connection, lastDisconnect } = update;
      if (qr) {
        lastQr = qr;
        connected = false;
        log("QR recibido. Abre /qr para verlo.");
      }
      if (connection === "open") {
        connected = true;
        lastQr = null;
        log("Conectado a WhatsApp ✅");
      } else if (connection === "close") {
        connected = false;
        const shouldReconnect =
          (lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.code) !==
          DisconnectReason.loggedOut;
        log("Conexión cerrada. shouldReconnect:", shouldReconnect);
        if (shouldReconnect) {
          setTimeout(startSock, 3_000);
        } else {
          log("Sesión cerrada (loggedOut). Borra la carpeta auth si quieres re-vincular.");
        }
      }
    });

    // (Opcional) Ver algo cuando llega un mensaje
    sock.ev.on("messages.upsert", (m) => {
      try {
        const msg = m.messages?.[0];
        if (!msg) return;
        const from = msg.key.remoteJid;
        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
        if (text) log("Mensaje entrante de", from, "→", text);
      } catch {}
    });
  } catch (err) {
    log("Error en startSock:", err?.message || err);
    setTimeout(startSock, 5_000);
  }
}

// === Rutas HTTP ===
app.get("/", (_, res) => res.send("OK: servicio vivo"));

app.get("/status", (_, res) => {
  res.json({
    connected,
    hasQR: !!lastQr,
    session: SESSION_NAME,
    env: NODE_ENV,
  });
});

app.get("/qr", async (req, res) => {
  try {
    if (!lastQr) {
      return res
        .status(503)
        .send("Aún no hay QR disponible. Espera 3–10s y refresca esta página.");
    }
    // Devuelve PNG simple
    const png = await QRCode.toBuffer(lastQr, { width: 300, margin: 1 });
    res.setHeader("Content-Type", "image/png");
    res.send(png);
  } catch (e) {
    res.status(500).send("Error generando QR");
  }
});

// === Arranque ===
app.listen(PORT, () => {
  console.log("HTTP up on :", PORT);
  startSock();
});
