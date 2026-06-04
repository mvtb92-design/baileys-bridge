import pkg from '@whiskeysockets/baileys';
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = pkg;
import { Boom } from '@hapi/boom';
import pino from 'pino';
import express from 'express';
import fetch from 'node-fetch';
import { createServer } from 'http';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import qrcode from 'qrcode';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_PATH = process.env.SESSION_PATH || '/data/session';
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://localhost:3000/api/whatsapp/webhook';
const PORT = process.env.PORT || 4000;
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || 'financas2026';

let sock = null;
let isConnected = false;
let currentQR = null;
let qrBase64 = null;
const processedIds = new Set();

// Garante diretório de sessão
try { await fs.mkdir(SESSION_PATH, { recursive: true }); } catch(e) {}

const app = express();
app.use(express.json());

// Health check
app.get('/', (req, res) => res.json({ ok: true, connected: isConnected }));

// QR Code em base64 para exibir
app.get('/qr', async (req, res) => {
  if (isConnected) return res.json({ ok: true, connected: true, message: 'Já conectado!' });
  if (!qrBase64) return res.json({ ok: false, connected: false, message: 'QR não disponível ainda, aguarde...' });
  res.json({ ok: true, connected: false, qr: qrBase64 });
});

// QR Code como imagem PNG
app.get('/qr.png', async (req, res) => {
  if (!currentQR) return res.status(404).send('QR não disponível');
  const img = await qrcode.toBuffer(currentQR);
  res.set('Content-Type', 'image/png');
  res.send(img);
});

// Status
app.get('/status', (req, res) => {
  res.json({ connected: isConnected, hasQR: !!currentQR });
});

// Enviar mensagem (chamado pelo servidor principal)
app.post('/send', async (req, res) => {
  const { secret, number, text } = req.body;
  if (secret !== BRIDGE_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!isConnected || !sock) return res.status(503).json({ error: 'Bot não conectado' });
  try {
    const jid = number.includes('@') ? number : number + '@s.whatsapp.net';
    await sock.sendMessage(jid, { text });
    res.json({ ok: true });
  } catch(e) {
    console.error('[SEND] Erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const server = createServer(app);
server.listen(PORT, () => console.log(`[BRIDGE] Servidor na porta ${PORT}`));

async function startBaileys() {
  console.log('[BAILEYS] Iniciando... sessão em:', SESSION_PATH);
  
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
  const { version } = await fetchLatestBaileysVersion();
  console.log('[BAILEYS] Versão WA:', version.join('.'));

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
    },
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
    browser: ['FinancasBot', 'Chrome', '120.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    getMessage: async () => ({ conversation: '' })
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      qrBase64 = await qrcode.toDataURL(qr);
      console.log('[BAILEYS] QR disponível em /qr e /qr.png');
    }

    if (connection === 'close') {
      isConnected = false;
      currentQR = null;
      qrBase64 = null;
      const code = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output?.statusCode
        : 0;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.log('[BAILEYS] Conexão fechada. Código:', code, '| Loggedout:', loggedOut);

      if (loggedOut) {
        console.log('[BAILEYS] Logout — limpando sessão e reconectando para novo QR...');
        try { await fs.rm(SESSION_PATH, { recursive: true }); await fs.mkdir(SESSION_PATH, { recursive: true }); } catch(e) {}
      }
      setTimeout(startBaileys, 5000);
    }

    if (connection === 'open') {
      isConnected = true;
      currentQR = null;
      qrBase64 = null;
      console.log('[BAILEYS] ✅ Conectado e pronto!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (msg.key.fromMe) continue;

        const msgId = msg.key.id;
        if (!msgId || processedIds.has(msgId)) continue;
        processedIds.add(msgId);
        if (processedIds.size > 1000) {
          const first = processedIds.values().next().value;
          processedIds.delete(first);
        }

        const remoteJid = msg.key.remoteJid || '';
        const isGroup = remoteJid.includes('@g.us');
        const participant = msg.key.participant || remoteJid;

        const txt =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption || '';

        if (!txt?.trim()) continue;

        const pushName = msg.pushName || '';
        console.log('[MSG]', isGroup ? 'grupo' : 'dm', remoteJid.substring(0, 20), '|', pushName, '|', txt.substring(0, 40));

        // Envia para o webhook do servidor principal
        const payload = {
          event: 'messages.upsert',
          instance: 'financas',
          data: {
            key: {
              remoteJid,
              fromMe: false,
              id: msgId,
              ...(isGroup && participant ? { participant } : {})
            },
            pushName,
            message: msg.message,
            messageType: 'conversation',
            messageTimestamp: msg.messageTimestamp
          }
        };

        const wh = await fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          timeout: 15000
        });

        console.log('[WEBHOOK]', wh.status, remoteJid.substring(0, 15));
      } catch(e) {
        console.error('[MSG_ERR]', e.message);
      }
    }
  });
}

startBaileys().catch(e => {
  console.error('[FATAL]', e.message);
  process.exit(1);
});
