import pkg from '@whiskeysockets/baileys';
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } = pkg;
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
  res.json({ connected: isConnected, hasQR: !!currentQR, session: SESSION_PATH });
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
    console.error('[SEND] Erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const server = createServer(app);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[BRIDGE] Servidor HTTP na porta ${PORT}`);
});

async function startBaileys() {
  console.log('[BAILEYS] Iniciando... sessao em:', SESSION_PATH);
  
  try {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
    
    // Usa versao fixa para evitar problemas de rede
    const version = [2, 3000, 1035194821];
    console.log('[BAILEYS] Usando versao WA:', version.join('.'));

    const logger = pino({ level: 'silent' });

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      logger,
      printQRInTerminal: true,
      browser: ['FinancasBot', 'Chrome', '120.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false,
      connectTimeoutMs: 30000,
      keepAliveIntervalMs: 10000,
      retryRequestDelayMs: 2000,
      getMessage: async () => ({ conversation: '' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      console.log('[CONN]', JSON.stringify({ connection, qr: !!qr, code: lastDisconnect?.error?.output?.statusCode }));

      if (qr) {
        currentQR = qr;
        try { qrBase64 = await qrcode.toDataURL(qr); } catch(e) {}
        console.log('[BAILEYS] QR disponivel em /qr e /qr.png');
      }

      if (connection === 'close') {
        isConnected = false;
        currentQR = null;
        qrBase64 = null;
        const code = lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output?.statusCode
          : lastDisconnect?.error?.output?.statusCode || 0;
        const loggedOut = code === DisconnectReason.loggedOut || code === 401;
        console.log('[BAILEYS] Conexao fechada. Codigo:', code, '| Loggedout:', loggedOut);

        if (loggedOut) {
          console.log('[BAILEYS] Logout — limpando sessao para novo QR...');
          try {
            await fs.rm(SESSION_PATH, { recursive: true, force: true });
            await fs.mkdir(SESSION_PATH, { recursive: true });
          } catch(e) { console.error('[BAILEYS] Erro ao limpar sessao:', e.message); }
        }
        console.log('[BAILEYS] Reconectando em 5s...');
        setTimeout(startBaileys, 5000);
      }

      if (connection === 'open') {
        isConnected = true;
        currentQR = null;
        qrBase64 = null;
        console.log('[BAILEYS] Conectado com sucesso!');
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

          const txt =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption || '';

          if (!txt?.trim()) continue;

          console.log('[MSG]', isGroup ? 'grupo' : 'dm', '|', msg.pushName || '', '|', txt.substring(0, 40));

          if (!WEBHOOK_URL) { console.log('[MSG] WEBHOOK_URL nao configurada'); continue; }

          const payload = {
            event: 'messages.upsert',
            instance: 'financas',
            data: {
              key: { remoteJid, fromMe: false, id: msgId, ...(isGroup && participant ? { participant } : {}) },
              pushName: msg.pushName || '',
              message: msg.message,
              messageType: 'conversation',
              messageTimestamp: msg.messageTimestamp
            }
          };

          const wh = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          console.log('[WEBHOOK]', wh.status);
        } catch(e) {
          console.error('[MSG_ERR]', e.message);
        }
      }
    });

  } catch(e) {
    console.error('[BAILEYS] Erro fatal:', e.message, e.stack?.substring(0, 200));
    console.log('[BAILEYS] Tentando novamente em 10s...');
    setTimeout(startBaileys, 10000);
  }
}

startBaileys();
