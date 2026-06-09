const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const express = require('express');
const fetch = require('node-fetch');
const http = require('http');
const path = require('path');
const fs = require('fs');

const SESSION_PATH = process.env.SESSION_PATH || '/data/session';

// Números autorizados a usar o bot (sem + e sem @)
const NUMEROS_AUTORIZADOS = (process.env.NUMEROS_AUTORIZADOS || '5537999310342,5537991288226').split(',').map(n => n.trim());
console.log('[AUTH] Numeros autorizados:', NUMEROS_AUTORIZADOS);
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const PORT = parseInt(process.env.PORT || '4000');
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || 'financas2026';

let currentQR = null;
let qrBase64 = null;
let isConnected = false;
const processedIds = new Set();

// Garante diretorio de sessao
if (!fs.existsSync(SESSION_PATH)) {
  fs.mkdirSync(SESSION_PATH, { recursive: true });
}

// Express
const app = express();
app.use(express.json());

app.get('/', (req, res) => res.json({ ok: true, connected: isConnected }));
app.get('/status', (req, res) => res.json({ connected: isConnected, hasQR: !!currentQR }));

app.get('/qr', (req, res) => {
  if (isConnected) return res.json({ ok: true, connected: true, message: 'Ja conectado!' });
  if (!qrBase64) return res.json({ ok: false, message: 'QR nao disponivel, aguarde...' });
  res.json({ ok: true, connected: false, qr: qrBase64 });
});

app.get('/qr.png', async (req, res) => {
  if (!currentQR) return res.status(404).send('QR nao disponivel');
  try {
    const buf = await QRCode.toBuffer(currentQR);
    res.set('Content-Type', 'image/png');
    res.send(buf);
  } catch(e) { res.status(500).send(e.message); }
});

app.post('/send', async (req, res) => {
  const { secret, number, text } = req.body || {};
  if (secret !== BRIDGE_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!isConnected) return res.status(503).json({ error: 'Bot nao conectado' });
  try {
    // Tenta resolver o numero via getNumberId (lida com LID automaticamente)
    const numId = await client.getNumberId(number.replace(/[^0-9]/g, ''));
    const chatId = numId ? numId._serialized : (number.includes('@') ? number : number + '@c.us');
    await client.sendMessage(chatId, text);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

http.createServer(app).listen(PORT, '0.0.0.0', () => {
  console.log('[BRIDGE] HTTP na porta', PORT);
});

// WhatsApp client
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_PATH }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ]
  }
});

client.on('qr', async (qr) => {
  currentQR = qr;
  try { qrBase64 = await QRCode.toDataURL(qr); } catch(e) {}
  console.log('[WWEB] QR gerado! Acesse /qr.png para escanear.');
});

client.on('ready', () => {
  isConnected = true;
  currentQR = null;
  qrBase64 = null;
  console.log('[WWEB] Conectado e pronto!');
});

client.on('disconnected', (reason) => {
  isConnected = false;
  console.log('[WWEB] Desconectado:', reason);
  setTimeout(() => {
    console.log('[WWEB] Reiniciando...');
    client.initialize().catch(e => console.error('[WWEB] Erro ao reiniciar:', e.message));
  }, 5000);
});

client.on('message', async (msg) => {
  try {
    if (msg.fromMe) return;
    const msgId = msg.id.id;
    if (processedIds.has(msgId)) return;
    processedIds.add(msgId);
    if (processedIds.size > 1000) processedIds.delete(processedIds.values().next().value);

    const txt = msg.body;
    if (!txt?.trim()) return;

    const remoteJid = msg.from;
    const isGroup = remoteJid.includes('@g.us');
    const participant = isGroup ? msg.author : remoteJid;

    console.log('[MSG]', msg._data.notifyName || '', ':', txt.substring(0, 40));

    if (!WEBHOOK_URL) return;

    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'messages.upsert',
        instance: 'financas',
        data: {
          key: {
            remoteJid: remoteJid.replace('@c.us', '@s.whatsapp.net'),
            fromMe: false,
            id: msgId,
            ...(isGroup ? { participant: participant?.replace('@c.us', '@s.whatsapp.net') } : {})
          },
          pushName: msg._data.notifyName || '',
          message: { conversation: txt },
          messageType: 'conversation',
          messageTimestamp: Math.floor(msg.timestamp)
        }
      })
    });
  } catch(e) { console.error('[MSG_ERR]', e.message); }
});

console.log('[WWEB] Iniciando cliente WhatsApp...');
client.initialize().catch(e => console.error('[WWEB] Erro ao iniciar:', e.message));
