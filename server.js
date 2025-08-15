const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;

let lastQr = null;
let sock = null;

async function start() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false, // lo manejo yo
      browser: ['Railway QR Test', 'Chrome', '10'],
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect, qr } = u;

      if (qr) {
        lastQr = qr;
        // QR en ASCII en logs
        try {
          const ascii = await QRCode.toString(qr, { type: 'terminal', small: true });
          console.log('\n\n=== ESCANEA ESTE QR EN WhatsApp > Dispositivos vinculados ===\n');
          console.log(ascii);
          console.log('\nTambién disponible como imagen en /qr\n');
        } catch (e) {
          console.error('Error generando QR ASCII:', e);
        }
      }

      if (connection === 'open') {
        console.log('✅ Conectado a WhatsApp (sesión creada).');
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log('Conexión cerrada. statusCode=', statusCode, 'reconectar:', shouldReconnect);
        if (shouldReconnect) {
          setTimeout(start, 3000);
        }
      }
    });
  } catch (e) {
    console.error('Fallo en start():', e);
    setTimeout(start, 5000);
  }
}

// Rutas HTTP
app.get('/', (_req, res) => res.send('OK: /qr mostrará el código cuando esté listo.'));

app.get('/qr', async (_req, res) => {
  try {
    if (!lastQr) {
      res.status(202).send('QR aún no generado. Abre los Deploy Logs y espera ~10-20s.');
      return;
    }
    const dataUrl = await QRCode.toDataURL(lastQr);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`
      <html>
        <body style="font-family:system-ui">
          <h2>Escanea este QR en WhatsApp → Dispositivos vinculados</h2>
          <img src="${dataUrl}" alt="QR" />
          <p>Si expira, refresca esta página.</p>
        </body>
      </html>
    `);
  } catch (e) {
    console.error('Error /qr:', e);
    res.status(500).send('Error generando QR.');
  }
});

app.listen(PORT, () => console.log('HTTP up on :' + PORT));

// Lanzar Baileys
start();
