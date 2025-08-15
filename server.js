// server.js — debug intensivo + rutas /status, /qr, /debug/*
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

// === Helpers ===
const ts = () => new Date().toISOString().split("T")[1].split(".")[0];
const log = (...args) => console.log(`[${ts()}][WA]`, ...args);
const logger = pino({ level: "silent" });

// === FS (Railway es writable en runtime) ===
const authDir = path.join(process.cwd(), "auth", SESSION_NAME);
fs.mkdirSync(authDir, { recursive: true });

// === App ===
const app = express();
app.use(express.json());

// Seguridad simple por header x-api-key (excepto GET /, /qr, /status, /debug/*)
app.use((req, res, next) => {
  if (
    req.method === "GET" &&
    (req.path === "/" ||
      req.path === "/qr" ||
      req.path === "/status" ||
      req.path.startsWith("/debug"))
  ) {
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
let starting = false;

async function startSock() {
  if (starting) {
    log("startSock() ignorado: ya está iniciando…");
    return;
  }
  starting = true;
  try {
    log("Iniciando Baileys… (pre fetchLatestBaileysVersion)");
    const { version } = await fetchLatestBaileysVersion();
    log("Versión Baileys/WA:", version);

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    log("Auth state preparado en:", authDir);

    sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: true, // QR ASCII en logs (Railway Logs)
      auth: state,
      browser: ["RailwayBot", "Chrome", "18"],
      connectTimeoutMs: 60_000,
    });
    log("makeWASocket creado.");

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { qr, connection, lastDisconnect } = update;
      if (qr) {
        lastQr = qr;
        connected = false;
        log("QR recibido. Visita /qr para verlo (caduca ~60s).");
      }
      if (connection === "open") {
        connected = true;
        lastQr = null;
        log("Conectado a WhatsApp ✅");
      } else if (connection === "close") {
        connected = false;
        const code =
          lastDisconnect?.error?.output?.statusCode ||
          lastDisconnect?.error?.code;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        log("Conexión cerrada. code:", code, "reintenta:", shouldReconnect);
        if (shouldReconnect) {
          setTimeout(startSock, 3000);
        } else {
          log("Sesión cerrada (loggedOut). Borra /auth para re-vincular.");
        }
      }
    });

    sock.ev.on("messages.upsert", (m) => {
      try {
        const msg = m.messages?.[0];
        if (!msg) return;
        const from = msg.key.remoteJid;
        const text =
          msg.message?.conversation || msg.message?.extendedTextMessage?.text;
        if (text) log("Mensaje entrante", from, "→", text);
      } catch (e) {
        log("Error en messages.upsert:", e?.message || e);
      }
    });

    log("startSock() finalizado (escuchando eventos).");
  } catch (err) {
    log("Error en startSock:", err?.message || err);
    setTimeout(startSock, 5000);
  } finally {
    starting = false;
  }
}

// ==== Rutas HTTP ====
app.get("/", (_, res) => res.send("OK: servicio vivo"));

app.get("/status", (_, res) => {
  res.json({
    connected,
    hasQR: !!lastQr,
    session: SESSION_NAME,
    env: NODE_ENV,
    starting,
  });
});

app.get("/qr", async (req, res) => {
  try {
    if (!lastQr) {
      return res
        .status(503)
        .send("Aún no hay QR disponible. Refresca en 3–10s.");
    }
    const png = await QRCode.toBuffer(lastQr, { width: 300, margin: 1 });
    res.setHeader("Content-Type", "image/png");
    res.send(png);
  } catch (e) {
    res.status(500).send("Error generando QR");
  }
});

// Rutas de debug
app.get("/debug/restart", async (req, res) => {
  log("DEBUG: /debug/restart invocado");
  startSock();
  res.send("OK: startSock() disparado");
});

app.get("/debug/info", (req, res) => {
  res.json({
    connected,
    hasQR: !!lastQr,
    starting,
    authDirExists: fs.existsSync(authDir),
    authDir,
  });
});

// Captura de errores no gestionados
process.on("unhandledRejection", (r) => log("unhandledRejection:", r));
process.on("uncaughtException", (e) => log("uncaughtException:", e?.message || e));

// Arranque
app.listen(PORT, () => {
  console.log("HTTP up on :", PORT);
  startSock();
});
