import pkg from '@whiskeysockets/baileys';
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore, fetchLatestBaileysVersion } = pkg;
import { Boom } from '@hapi/boom';
import pino from 'pino';
import express from 'express';
import fetch from 'node-fetch';
import { createServer } from 'http';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import qrcode from 'qrcode';

const SESSION_PATH = process.env.SESSION_PATH || '/data/session';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const PORT = parseInt(process.env.PORT || '4000');
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || 'financas2026';

let sock = null;
let isConnected = false;
let currentQR = null;
let qrBase64 = null;
const processedIds = new Set();

try { await fs.mkdir(SESSION_PATH, { recursive: true }); } catch(e) {}

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, connected: isConnected, hasQR: !!currentQR }));
app.get('/', (req, res) => res.json({ ok: true, connected: isConnected }));

app.get('/qr', async (req, res) => {
  if (isConnected) return res.json({ ok: true, connected: true, message: 'Ja conectado!' });
  if (!qrBase64) return res.json({ ok: false, connected: false, message: 'QR nao disponivel, aguarde...' });
  res.json({ ok: true, connected: false, qr: qrBase64 });
});

app.get('/qr.png', async (req, res) => {
  if (!currentQR) return res.status(404).send('QR nao disponivel');
  try {
    const img = await qrcode.toBuffer(currentQR);
    res.set('Content-Type', 'image/png');
    res.send(img);
  } catch(e) { res.status(500).send(e.message); }
});

app.get('/status', (req, res) => {
  res.json({ connected: isConnected, hasQR: !!currentQR });
});

app.post('/send', async (req, res) => {
  const { secret, number, text } = req.body || {};
  if (secret !== BRIDGE_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!isConnected || !sock) return res.status(503).json({ error: 'Bot nao conectado' });
  try {
    const jid = number.includes('@') ? number : number + '@s.whatsapp.net';
    await sock.sendMessage(jid, { text });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

const server = createServer(app);
server.listen(PORT, '0.0.0.0', () => console.log(`[BRIDGE] HTTP na porta ${PORT}`));

async function getVersion() {
  try {
    const { version } = await fetchLatestBaileysVersion();
    console.log('[BAILEYS] Versao obtida:', version.join('.'));
    return version;
  } catch(e) {
    console.log('[BAILEYS] Usando versao fallback');
    return [2, 3000, 1015901307];
  }
}

async function startBaileys() {
  console.log('[BAILEYS] Iniciando...');
  try {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
    const version = await getVersion();
    const logger = pino({ level: 'silent' });

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      logger,
      printQRInTerminal: true,
      browser: ['Chrome (Linux)', 'Chrome', '122.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false,
      getMessage: async () => undefined
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQR = qr;
        try { qrBase64 = await qrcode.toDataURL(qr); } catch(e) {}
        console.log('[BAILEYS] QR gerado! Acesse /qr.png');
      }

      if (connection === 'close') {
        isConnected = false;
        currentQR = null; qrBase64 = null;
        const status = lastDisconnect?.error?.output?.statusCode;
        console.log('[BAILEYS] Fechado. Status:', status);
        const loggedOut = status === DisconnectReason.loggedOut || status === 401;
        if (loggedOut) {
          try { await fs.rm(SESSION_PATH, { recursive: true, force: true }); await fs.mkdir(SESSION_PATH, { recursive: true }); } catch(e) {}
        }
        setTimeout(startBaileys, 8000);
      }

      if (connection === 'open') {
        isConnected = true;
        currentQR = null; qrBase64 = null;
        console.log('[BAILEYS] Conectado!');
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
          if (processedIds.size > 1000) processedIds.delete(processedIds.values().next().value);

          const remoteJid = msg.key.remoteJid || '';
          const isGroup = remoteJid.includes('@g.us');
          const participant = msg.key.participant || remoteJid;
          const txt = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
          if (!txt?.trim()) continue;

          console.log('[MSG]', msg.pushName, ':', txt.substring(0, 40));
          if (!WEBHOOK_URL) continue;

          await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              event: 'messages.upsert', instance: 'financas',
              data: {
                key: { remoteJid, fromMe: false, id: msgId, ...(isGroup ? { participant } : {}) },
                pushName: msg.pushName || '', message: msg.message,
                messageType: 'conversation', messageTimestamp: msg.messageTimestamp
              }
            })
          });
        } catch(e) { console.error('[MSG_ERR]', e.message); }
      }
    });

  } catch(e) {
    console.error('[ERRO]', e.message);
    setTimeout(startBaileys, 10000);
  }
}

startBaileys();
