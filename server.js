import express from "express";
import qrcode from "qrcode";
import {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";
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
  if (!key || key !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
});

// Estado global del socket
let sock;
let qrData = "";

const startSock = async () => {
  const { state, saveCreds } = await useMultiFileAuthState(`./${SESSION_NAME}`);
  const { version } = await fetchLatestBaileysVersion();
  
  sock = makeWASocket({
    version,
    printQRInTerminal: false,
    auth: state,
    logger: pino({ level: "silent" }),
    generateHighQualityLinkPreview: true
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      qrData = await qrcode.toDataURL(qr);
    }
    if (connection === "close") {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) startSock();
    }
  });

  sock.ev.on("creds.update", saveCreds);
};

startSock();

// Endpoint para obtener el QR en base64
app.get("/qr", async (req, res) => {
  if (qrData) {
    res.send(`<img src="${qrData}" style="height: 300px" />`);
  } else {
    res.send("QR no generado todavía. Espera unos segundos...");
  }
});

// Endpoint de prueba
app.get("/", (req, res) => {
  res.send("✅ Bot de WhatsApp activo");
});

// Endpoint para enviar mensaje (usa API_KEY como header)
app.post("/send", async (req, res) => {
  const { number, message } = req.body;
  if (!number || !message) return res.status(400).json({ error: "Falta número o mensaje" });

  try {
    const id = number.includes("@s.whatsapp.net") ? number : `${number}@s.whatsapp.net`;
    await sock.sendMessage(id, { text: message });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`HTTP up on :${PORT}`);
});
