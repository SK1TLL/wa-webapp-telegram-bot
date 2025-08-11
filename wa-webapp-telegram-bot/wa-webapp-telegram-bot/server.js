/**
 * WhatsApp Warmup with Telegram Web App UI
 * - whatsapp-web.js clients (LocalAuth)
 * - Telegram bot for sending WebApp button and notifications
 * - Express API used by WebApp for managing accounts/targets/warming
 *
 * Security: WebApp posts include Telegram initDataUnsafe.user.id which is checked against OWNER_ID.
 * For private use this is acceptable; for production you'd verify initData signature.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');
const express = require('express');
const bodyParser = require('body-parser');
const { Client, LocalAuth } = require('whatsapp-web.js');
const TelegramBot = require('node-telegram-bot-api');

const DUMP_FILE = path.join(__dirname, 'data.json');
const DIALOGUE_FILE = path.join(__dirname, 'dialogue.json');

let dialogue = [];
try { dialogue = JSON.parse(fs.readFileSync(DIALOGUE_FILE,'utf8')); } catch(e){ dialogue = []; }

let store = { accounts: {} };
try { store = JSON.parse(fs.readFileSync(DUMP_FILE,'utf8')); } catch(e){ fs.writeFileSync(DUMP_FILE, JSON.stringify(store,null,2)); }

function saveStore(){ fs.writeFileSync(DUMP_FILE, JSON.stringify(store, null, 2)); }

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OWNER_ID = process.env.OWNER_ID; // string or number
const WEBAPP_URL = process.env.WEBAPP_URL || ''; // public url of webapp, e.g. https://app.onrender.com/webapp
const MIN_DELAY = parseFloat(process.env.MIN_DELAY || '1.5');
const MAX_DELAY = parseFloat(process.env.MAX_DELAY || '4');
const PORT = process.env.PORT || 3000;

if (!TELEGRAM_TOKEN) {
  console.error('TELEGRAM_TOKEN missing in .env');
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const app = express();
app.use(bodyParser.json());
app.use(express.static('webapp')); // serve webapp static files

const clients = {}; // accountId -> { client, status, ownerChatId, warming, workerHandle, lastQrDataUrl }

function isOwnerId(id) {
  if (!OWNER_ID) return true;
  return String(id) === String(OWNER_ID);
}

function normalizePhone(phone){ return phone.replace(/[^0-9]/g,''); }
function toJid(phone){ return `${normalizePhone(phone)}@c.us`; }

function createClient(accountId, ownerChatId){
  if (clients[accountId]) return clients[accountId];
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: accountId }),
    puppeteer: { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'] }
  });
  clients[accountId] = { client, status: 'initializing', ownerChatId, warming: false, workerHandle: null, lastQrDataUrl: null };
  if (!store.accounts[accountId]) store.accounts[accountId] = { targets: [], name: accountId, status: 'initializing', warming: false };
  saveStore();

  client.on('qr', async (qr) => {
    try {
      const dataUrl = await qrcode.toDataURL(qr);
      clients[accountId].lastQrDataUrl = dataUrl;
      clients[accountId].status = 'qr';
      store.accounts[accountId].status = 'qr';
      saveStore();
      // send QR to owner via Telegram for convenience
      const chatId = ownerChatId || OWNER_ID || null;
      if (chatId) {
        const base64 = dataUrl.split(',')[1];
        const buffer = Buffer.from(base64, 'base64');
        await bot.sendPhoto(chatId, buffer, { caption: `QR для ${accountId} (через Telegram WebApp или этот чат).` });
      }
    } catch (e) { console.error('qr error', e); }
  });

  client.on('ready', () => {
    clients[accountId].status = 'ready';
    store.accounts[accountId].status = 'ready';
    try { store.accounts[accountId].name = client.info.pushname || accountId; } catch(e){}
    saveStore();
    const chatId = ownerChatId || OWNER_ID || null;
    if (chatId) bot.sendMessage(chatId, `✅ Аккаунт ${accountId} готов.`);
  });

  client.on('auth_failure', (msg) => {
    clients[accountId].status = 'auth_failure';
    store.accounts[accountId].status = 'auth_failure';
    saveStore();
    const chatId = ownerChatId || OWNER_ID || null;
    if (chatId) bot.sendMessage(chatId, `⚠️ Auth failure ${accountId}: ${msg}`);
  });

  client.on('disconnected', (reason) => {
    clients[accountId].status = 'disconnected';
    store.accounts[accountId].status = 'disconnected';
    saveStore();
    const chatId = ownerChatId || OWNER_ID || null;
    if (chatId) bot.sendMessage(chatId, `❌ Аккаунт ${accountId} отключён: ${reason}`);
  });

  client.initialize();
  return clients[accountId];
}

async function sendMessage(accountId, toPhone, text){
  const entry = clients[accountId];
  if (!entry) throw new Error('account not initialized');
  if (entry.status !== 'ready') throw new Error('account not ready');
  return entry.client.sendMessage(toJid(toPhone), text);
}

async function runDialogueSequence(accountId, targetPhone){
  if (!Array.isArray(dialogue) || dialogue.length === 0){
    await sendMessage(accountId, targetPhone, 'Привет!');
    await sleep(randBetween(MIN_DELAY*1000, MAX_DELAY*1000));
    return;
  }
  for (const item of dialogue){
    if (!clients[accountId] || !clients[accountId].warming) break;
    let text = (typeof item === 'string') ? item : (item && item.message) ? item.message : '';
    if (!text) continue;
    await sendMessage(accountId, targetPhone, text);
    const chat = clients[accountId].ownerChatId || OWNER_ID || null;
    if (chat) await bot.sendMessage(chat, `✉️ ${accountId} → ${targetPhone}: ${truncate(text,200)}`);
    await sleep(randBetween(MIN_DELAY*1000, MAX_DELAY*1000));
  }
}

async function startWarming(accountId){
  const ac = clients[accountId];
  if (!ac) throw new Error('account not initialized');
  if (ac.warming) throw new Error('already warming');
  ac.warming = true; store.accounts[accountId].warming = true; saveStore();
  const chat = ac.ownerChatId || OWNER_ID || null;
  if (chat) bot.sendMessage(chat, `▶️ Прогрев запущен для ${accountId}`);
  ac.workerHandle = (async () => {
    while (ac.warming){
      const targets = store.accounts[accountId].targets || [];
      for (const t of targets){
        if (!ac.warming) break;
        try { await runDialogueSequence(accountId, t); } catch(e){ console.error('dialogue error', e); if (chat) bot.sendMessage(chat, `Ошибка: ${e.message}`); }
        await sleep(randBetween(MIN_DELAY*1000, MAX_DELAY*1000));
      }
      await sleep(2000);
    }
  })();
  return true;
}

function stopWarming(accountId){
  const ac = clients[accountId];
  if (!ac) throw new Error('account not initialized');
  ac.warming = false; store.accounts[accountId].warming = false; saveStore();
  return true;
}

function sleep(ms){ return new Promise(res=>setTimeout(res, ms)); }
function randBetween(min,max){ return Math.floor(Math.random()*(max-min+1))+min; }
function truncate(s,n){ return s.length>n? s.slice(0,n-1)+'…': s; }

// Express API for WebApp
// Simple auth: we accept requests that include {telegramUserId} matching OWNER_ID OR that include initDataUnsafe from Telegram WebApp.
function checkAuthFromBody(body){
  if (!OWNER_ID) return true;
  if (!body) return false;
  if (body.telegramUserId && String(body.telegramUserId) === String(OWNER_ID)) return true;
  if (body.initDataUnsafe && body.initDataUnsafe.user && String(body.initDataUnsafe.user.id) === String(OWNER_ID)) return true;
  return false;
}

app.get('/api/accounts', (req,res)=>{
  const accounts = Object.keys(store.accounts).map(id => ({
    id,
    config: store.accounts[id],
    runtimeStatus: clients[id] ? clients[id].status : (store.accounts[id].status || 'not-initialized'),
    hasQr: clients[id] ? Boolean(clients[id].lastQrDataUrl) : false
  }));
  res.json({ ok:true, accounts });
});

app.post('/api/connect', (req,res)=>{
  const body = req.body;
  if (!checkAuthFromBody(body)) return res.status(403).json({ error: 'forbidden' });
  const { accountId } = body;
  if (!accountId) return res.status(400).json({ error: 'accountId required' });
  createClient(accountId, OWNER_ID);
  res.json({ ok:true, message: 'initializing', accountId });
});

app.get('/api/qr/:accountId', (req,res)=>{
  const accountId = req.params.accountId;
  if (!accountId) return res.status(400).end();
  const cl = clients[accountId];
  if (!cl || !cl.lastQrDataUrl) return res.status(404).json({ error:'no-qr' });
  const data = cl.lastQrDataUrl.split(',')[1];
  const buffer = Buffer.from(data, 'base64');
  res.writeHead(200, { 'Content-Type': 'image/png' });
  res.end(buffer);
});

app.post('/api/addtarget', (req,res)=>{
  const body = req.body;
  if (!checkAuthFromBody(body)) return res.status(403).json({ error: 'forbidden' });
  const { accountId, phone } = body;
  if (!accountId || !phone) return res.status(400).json({ error:'accountId & phone required' });
  if (!store.accounts[accountId]) store.accounts[accountId] = { targets: [], name: accountId };
  const p = normalizePhone(String(phone));
  if (!store.accounts[accountId].targets.includes(p)) store.accounts[accountId].targets.push(p);
  saveStore();
  res.json({ ok:true, accountId, phone: p });
});

app.post('/api/removetarget', (req,res)=>{
  const body = req.body;
  if (!checkAuthFromBody(body)) return res.status(403).json({ error: 'forbidden' });
  const { accountId, phone } = body;
  if (!accountId || !phone) return res.status(400).json({ error:'accountId & phone required' });
  if (!store.accounts[accountId]) return res.status(404).json({ error:'no account' });
  store.accounts[accountId].targets = (store.accounts[accountId].targets || []).filter(p=>p!==normalizePhone(String(phone)));
  saveStore();
  res.json({ ok:true });
});

app.post('/api/startwarm', async (req,res)=>{
  const body = req.body;
  if (!checkAuthFromBody(body)) return res.status(403).json({ error:'forbidden' });
  const { accountId } = body;
  if (!accountId) return res.status(400).json({ error:'accountId required' });
  try { await startWarming(accountId); res.json({ ok:true }); } catch(e){ res.status(500).json({ error: e.message }); }
});

app.post('/api/stopwarm', (req,res)=>{
  const body = req.body;
  if (!checkAuthFromBody(body)) return res.status(403).json({ error:'forbidden' });
  const { accountId } = body;
  try { stopWarming(accountId); res.json({ ok:true }); } catch(e){ res.status(500).json({ error: e.message }); }
});

app.get('/api/listtargets/:accountId', (req,res)=>{
  const accountId = req.params.accountId;
  if (!accountId) return res.status(400).json({ error:'accountId required' });
  if (!store.accounts[accountId]) return res.status(404).json({ error:'no account' });
  res.json({ ok:true, targets: store.accounts[accountId].targets || [] });
});

// Telegram command to send WebApp button
bot.onText(/\/panel/, (msg) => {
  const chatId = msg.chat.id;
  const url = WEBAPP_URL || ''; // must be set via env to allow opening inside Telegram
  if (!url) return bot.sendMessage(chatId, 'WEBAPP_URL is not configured on server. Set WEBAPP_URL in .env to your public https URL ending with /webapp');
  const opts = {
    reply_markup: {
      inline_keyboard: [[{ text: 'Открыть панель управления', web_app: { url } }]]
    }
  };
  bot.sendMessage(chatId, 'Открой панель управления:', opts);
});

// basic bot commands
bot.onText(/\/start/, (msg) => bot.sendMessage(msg.chat.id, 'Привет! Пиши /panel чтобы получить кнопку управления WebApp.'));
bot.onText(/\/help/, (msg) => bot.sendMessage(msg.chat.id, '/panel - получить кнопку WebApp\n/connect <id> - quick connect\n/listaccounts - list'));
bot.onText(/\/connect (.+)/, (msg,match)=>{ const id=match[1].trim(); createClient(id,msg.chat.id); bot.sendMessage(msg.chat.id,'Инициализация клиента '+id); });
bot.onText(/\/listaccounts/, (msg)=>{
  const lines = Object.keys(store.accounts).map(id=>`${id}: targets=${(store.accounts[id].targets||[]).length}, status=${clients[id]?clients[id].status:(store.accounts[id].status||'n/a')}`);
  bot.sendMessage(msg.chat.id, 'Accounts:\n'+lines.join('\n'));
});

// serve webapp file
app.get('/webapp', (req,res)=>{
  res.sendFile(path.join(__dirname, 'webapp', 'index.html'));
});

app.listen(PORT, ()=> console.log('Server listening on', PORT));
console.log('Bot and server started');