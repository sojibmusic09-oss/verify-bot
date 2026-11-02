/**
 * ST TOURNAMENT BD - Official Anti-Ban WhatsApp Gateway & Live Control Center
 * Features: Live Web Terminal, Inbound Trigger (No Ban), 1-Click Pairing/QR, Code Copy & Resend
 * Platform: Render.com Ready
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const QRCode = require('qrcode');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  delay,
  Browsers
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SESSION_DIR = path.join(__dirname, 'auth_otp_baileys');
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

let sock = null;
let botState = {
  connected: false,
  connecting: false,
  qrCodeUrl: null,
  pairingCode: null,
  botPhone: null
};

// ================= ১. লাইভ কনসোল লগ ইঞ্জিন (WEB TERMINAL) =================
let liveTerminalLogs = [];

function appendLog(type, text) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  const logEntry = { time, type, text };
  liveTerminalLogs.unshift(logEntry);
  if (liveTerminalLogs.length > 150) liveTerminalLogs.pop();
  console.log(`[${time}] [${type.toUpperCase()}] ${text}`);
}

appendLog('info', 'সার্ভার ইঞ্জিন চালু হয়েছে। WhatsApp সেশন প্রস্তুত হচ্ছে...');

// ওটিপি ডাটা ক্যাশ (যাচাই, কপি এবং রিসেন্ডের জন্য)
const activeOtpStore = {}; // { targetPhoneOrToken: { code, time, rawPhone } }

// ================= ২. ANTI-BAN BAILEYS WHATSAPP ENGINE =================
async function startWhatsAppBot() {
  if (botState.connecting || botState.connected) return;
  botState.connecting = true;
  appendLog('info', 'WhatsApp কানেকশন ইনিশিয়ালাইজ করা হচ্ছে...');

  try {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      auth: state,
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: false,
      markOnlineOnConnect: true,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      emitOwnEvents: false,
      retryRequestDelayMs: 600,
      maxMsgRetryCount: 4
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        botState.qrCodeUrl = await QRCode.toDataURL(qr);
        appendLog('warn', 'নতুন QR কোড তৈরি হয়েছে। স্ক্যান করার জন্য প্রস্তুত।');
      }

      if (connection === 'close') {
        botState.connected = false;
        botState.connecting = false;
        botState.botPhone = null;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        appendLog('warn', `WhatsApp সংযোগ বিচ্ছিন্ন হয়েছে (Status Code: ${statusCode})`);

        if (statusCode !== DisconnectReason.loggedOut) {
          appendLog('info', '৫ সেকেন্ড পর পুনরায় স্বয়ংক্রিয় কানেক্ট করার চেষ্টা করা হবে...');
          setTimeout(() => startWhatsAppBot(), 5000);
        } else {
          appendLog('error', 'সেশন লগআউট হয়ে গেছে! নম্বর পরিবর্তনের জন্য Re-link করুন।');
        }
      } else if (connection === 'open') {
        botState.connected = true;
        botState.connecting = false;
        botState.qrCodeUrl = null;
        botState.pairingCode = null;

        if (sock.user && sock.user.id) {
          botState.botPhone = sock.user.id.split(':')[0].replace(/[^0-9]/g, '');
        }
        appendLog('success', `🎉 WhatsApp সফলভাবে কানেক্টেড হয়েছে! বট নম্বর: +${botState.botPhone}`);
      }
    });

    // ================= ৩. ইনকামিং মেসেজ ও অ্যান্টি-ব্যান অটো ওটিপি রিপ্লাই =================
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      try {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        if (sender.includes('@g.us')) return; // গ্রুপ মেসেজ ইগনোর

        const text = (
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          ''
        ).trim();

        if (!text) return;
        const cleanSenderNum = sender.replace(/[^0-9]/g, '');
        appendLog('info', `মেসেজ এসেছে [${cleanSenderNum}]: "${text}"`);

        // ওটিপি চাওয়ার কি-ওয়ার্ড ম্যাচিং (Anti-Ban Inbound)
        if (text.includes('পার্টনার') || text.includes('partner') || text.includes('code') || text.includes('কোড')) {
          
          const tokenMatch = text.match(/\[([A-Za-z0-9-_]+)\]/);
          const requestToken = tokenMatch ? tokenMatch[1] : '';

          // ৬ ডিজিটের র‍্যান্ডম ওটিপি
          const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

          // ক্যাশে সেভ
          activeOtpStore[cleanSenderNum] = { code: otpCode, time: new Date().toLocaleTimeString(), token: requestToken };
          if (requestToken) activeOtpStore[requestToken] = { code: otpCode, time: new Date().toLocaleTimeString(), phone: cleanSenderNum };

          appendLog('info', `ওটিপি তৈরি হয়েছে: ${otpCode} (প্রেরক: ${cleanSenderNum})`);

          // 🛡️ ANTI-BAN HUMAN LIKE DELAY: টাইপিং স্টেটাস অনুকরণ
          try {
            await sock.sendPresenceUpdate('composing', sender);
            await delay(1500); // ১.৫ সেকেন্ড টাইপিং অ্যানিমেশন
          } catch(e) {}

          const replyMsg = `*ST TOURNAMENT BD - পার্টনার ভেরিফিকেশন*\n━━━━━━━━━━━━━━━━━━━━\nআপনার ওটিপি কোড হলো: *${otpCode}*\n\n🔒 এই কোডটি কাউকে বলবেন না। সাইটে কোডটি বসিয়ে আপনার ভেরিফিকেশন নিশ্চিত করুন।\n━━━━━━━━━━━━━━━━━━━━\n_Anti-Ban Official Verification System_`;

          await sock.sendMessage(sender, { text: replyMsg });
          try { await sock.sendPresenceUpdate('paused', sender); } catch(e) {}

          appendLog('success', `✅ ওটিপি পাঠানো সফল: ${cleanSenderNum} ➔ [${otpCode}]`);
        }

      } catch (err) {
        appendLog('error', `মেসেজ হ্যান্ডলার এরর: ${err.message}`);
      }
    });

  } catch (err) {
    botState.connecting = false;
    appendLog('error', `বট স্টার্ট ব্যর্থ: ${err.message}`);
    setTimeout(() => startWhatsAppBot(), 5000);
  }
}
startWhatsAppBot();

// ================= ৪. API ROUTING =================

// ১. লাইভ ড্যাশবোর্ড ও লগ ফেচ API
app.get('/api/live-status', (req, res) => {
  res.json({
    connected: botState.connected,
    connecting: botState.connecting,
    qrCode: botState.qrCodeUrl,
    pairingCode: botState.pairingCode,
    botPhone: botState.botPhone,
    logs: liveTerminalLogs,
    activeOtps: activeOtpStore
  });
});

// ২. Pairing Code জেনারেটর (নম্বর পরিবর্তন ও লগইন)
app.post('/api/pair-number', async (req, res) => {
  let phone = (req.body.phone || '').replace(/[^0-9]/g, '');
  if (phone.startsWith('01') && phone.length === 11) phone = '88' + phone;

  if (!phone || phone.length < 11) {
    return res.status(400).json({ success: false, message: '১১ ডিজিটের সঠিক মোবাইল নম্বর দিন (যেমন: 017xxxxxxxx)' });
  }

  appendLog('info', `পেয়ারিং কোড রিকোয়েস্ট: ${phone}`);

  try {
    if (!sock) {
      await startWhatsAppBot();
      await delay(2000);
    }

    if (sock && !sock.authState.creds.registered) {
      await delay(1500);
      const code = await sock.requestPairingCode(phone);
      botState.pairingCode = code;
      appendLog('success', `🔑 পেয়ারিং কোড রেডি: ${code} (নম্বর: ${phone})`);
      return res.json({ success: true, pairingCode: code });
    }
    return res.status(400).json({ success: false, message: 'একটি ডিভাইস ইতিমধ্যে সংযুক্ত রয়েছে! Re-link করতে প্রথমে Reset করুন।' });
  } catch (err) {
    appendLog('error', `পেয়ারিং কোড ব্যর্থ: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ৩. সাইট থেকে অটো-ভেরিফাই চেক
app.post('/api/verify-inbound-otp', (req, res) => {
  const { phone, code, token } = req.body;
  const cleanPhone = String(phone || '').replace(/[^0-9]/g, '');

  let record = activeOtpStore[cleanPhone] || (token ? activeOtpStore[token] : null);

  if (record && String(record.code) === String(code)) {
    appendLog('success', `🎉 ওটিপি ভেরিফিকেশন সফল! (নম্বর: ${cleanPhone}, কোড: ${code})`);
    delete activeOtpStore[cleanPhone];
    if (token) delete activeOtpStore[token];
    return res.json({ success: true, message: 'OTP Verified successfully!' });
  }

  appendLog('warn', `ভুল ওটিপি ইনপুট: ${cleanPhone} দিয়েছে [${code}]`);
  return res.json({ success: false, message: 'Invalid or Expired OTP' });
});

// ৪. ড্যাশবোর্ড থেকে ওটিপি রিসেন্ড করার এন্ডপয়েন্ট
app.post('/api/resend-code', async (req, res) => {
  const { phone } = req.body;
  const clean = String(phone || '').replace(/[^0-9]/g, '');

  if (!clean || !sock || !botState.connected) {
    return res.status(400).json({ success: false, message: 'নম্বর পাওয়া যায়নি অথবা বট অফলাইন!' });
  }

  const newOtp = Math.floor(100000 + Math.random() * 900000).toString();
  activeOtpStore[clean] = { code: newOtp, time: new Date().toLocaleTimeString() };

  try {
    const jid = `${clean}@s.whatsapp.net`;
    const resendMsg = `*ST TOURNAMENT BD - ওটিপি রিসেন্ড*\n━━━━━━━━━━━━━━━━━━━━\nআপনার নতুন ওটিপি কোড হলো: *${newOtp}*\n\n🔒 এটি সাইটে দিয়ে ভেরিফাই সম্পন্ন করুন।\n━━━━━━━━━━━━━━━━━━━━`;
    await sock.sendMessage(jid, { text: resendMsg });
    appendLog('info', `🔄 ওটিপি রিসেন্ড করা হয়েছে: ${clean} ➔ [${newOtp}]`);
    return res.json({ success: true, newCode: newOtp });
  } catch (e) {
    appendLog('error', `রিসেন্ড এরর: ${e.message}`);
    return res.status(500).json({ success: false, message: e.message });
  }
});

// ৫. সম্পূর্ণ হার্ড রিসেট / নম্বর পরিবর্তন (Unlink & Change Number)
app.post('/api/hard-reset', async (req, res) => {
  appendLog('warn', 'সার্ভার হার্ড রিসেট ও নম্বর রিমুভ শুরু হয়েছে...');
  try {
    if (sock) {
      try { await sock.logout(); } catch(e) {}
      try { sock.ws?.close(); sock.ev?.removeAllListeners(); } catch(e) {}
      sock = null;
    }
    botState.connected = false;
    botState.connecting = false;
    botState.botPhone = null;
    botState.pairingCode = null;
    botState.qrCodeUrl = null;

    if (fs.existsSync(SESSION_DIR)) {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
      fs.mkdirSync(SESSION_DIR, { recursive: true });
    }

    appendLog('success', 'পুরনো সেশন মুছে ফেলা হয়েছে। ২ সেকেন্ড পর নতুন লগইন শুরু হচ্ছে...');
    setTimeout(() => startWhatsAppBot(), 2000);

    return res.json({ success: true, message: 'সফলভাবে রিসেট সম্পন্ন হয়েছে। এখন নতুন নম্বর দিয়ে পেয়ার করুন।' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ৬. লগ ক্লিয়ার করার রুট
app.post('/api/clear-logs', (req, res) => {
  liveTerminalLogs = [];
  appendLog('info', 'টার্মিনাল লগ ক্লিয়ার করা হয়েছে।');
  res.json({ success: true });
});

// ================= ৫. প্রিমিয়াম অ্যাডমিন ওয়েব ড্যাশবোর্ড UI =================
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>ST WhatsApp Bot Command Center</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
      <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
      <style>
        :root {
          --bg-dark: #08080e;
          --bg-card: rgba(20, 20, 35, 0.95);
          --primary: #6C63FF;
          --success: #00d4aa;
          --warning: #ffd93d;
          --danger: #ff5e7a;
          --border: rgba(255, 255, 255, 0.08);
        }
        * { margin:0; padding:0; box-sizing:border-box; font-family:'Plus Jakarta Sans',sans-serif; }
        body { background:var(--bg-dark); color:#fff; padding:20px 14px; min-height:100vh; }
        .wrapper { max-width:900px; margin:0 auto; }
        .header { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; padding-bottom:14px; border-bottom:1px solid var(--border); }
        .badge { font-size:11px; font-weight:800; padding:5px 14px; border-radius:30px; text-transform:uppercase; letter-spacing:0.5px; }
        .grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:20px; }
        @media (max-width:768px) { .grid { grid-template-columns:1fr; } }
        .card { background:var(--bg-card); border:1px solid var(--border); border-radius:18px; padding:20px; }
        .btn { padding:10px 16px; border-radius:10px; border:none; font-weight:800; font-size:12px; cursor:pointer; color:#fff; display:inline-flex; align-items:center; justify-content:center; gap:6px; transition:0.2s; }
        .btn:active { transform:scale(0.96); }
        .btn-primary { background:linear-gradient(135deg,var(--primary),#4a42b3); }
        .btn-danger { background:rgba(255,94,122,0.15); color:var(--danger); border:1px solid rgba(255,94,122,0.3); }
        .btn-warning { background:rgba(255,217,61,0.15); color:var(--warning); border:1px solid rgba(255,217,61,0.3); }
        .btn-success { background:rgba(0,212,170,0.15); color:var(--success); border:1px solid rgba(0,212,170,0.3); }
        input { width:100%; padding:12px; background:rgba(255,255,255,0.04); border:1px solid var(--border); border-radius:10px; color:#fff; font-size:14px; outline:none; margin-bottom:10px; text-align:center; }
        input:focus { border-color:var(--primary); }
        
        /* TERMINAL WINDOW */
        .terminal { background:#030307; border:1px solid rgba(255,255,255,0.12); border-radius:14px; padding:14px; height:240px; overflow-y:auto; font-family:'JetBrains Mono',monospace; font-size:11.5px; text-align:left; line-height:1.6; }
        .log-info { color:#818cf8; }
        .log-success { color:#34d399; }
        .log-warn { color:#fbbf24; }
        .log-error { color:#f87171; }
      </style>
    </head>
    <body>
      <div class="wrapper">
        <div class="header">
          <div>
            <h2 style="font-weight:800; font-size:18px; color:var(--primary);"><i class="fas fa-robot"></i> ST TOURNAMENT BD</h2>
            <p style="font-size:11px; color:#8892b0;">WhatsApp Gateway Server & Anti-Ban Terminal</p>
          </div>
          <div id="status-pill" class="badge" style="background:rgba(255,217,61,0.15); color:var(--warning);">চেক হচ্ছে...</div>
        </div>

        <div class="grid">
          <!-- DEVICE LINK & NUMBER CHANGE CARD -->
          <div class="card">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
              <h4 style="font-size:14px; font-weight:800;"><i class="fab fa-whatsapp" style="color:var(--success);"></i> ডিভাইস ও নম্বর লিঙ্ক</h4>
              <button class="btn btn-danger" onclick="hardResetBot()" style="padding:4px 10px; font-size:10px;" title="নতুন নম্বর দিতে রিসেট করুন"><i class="fas fa-trash"></i> Re-link</button>
            </div>

            <div id="connected-info" style="display:none; background:rgba(0,212,170,0.08); border:1px solid rgba(0,212,170,0.3); padding:14px; border-radius:12px; margin-bottom:12px;">
              <div style="font-size:11px; color:var(--success); font-weight:700;">🟢 সংযুক্ত বট নম্বর:</div>
              <div id="bot-phone-text" style="font-size:20px; font-weight:900; letter-spacing:1px; color:#fff; margin-top:4px;"></div>
            </div>

            <!-- PAIRING CODE INPUT -->
            <div id="pairing-box">
              <label style="font-size:11px; color:#8892b0; display:block; margin-bottom:4px; text-align:left; font-weight:700;">৮-সংখ্যার কোড দিয়ে লগইন (ফোন নম্বর দিন):</label>
              <input type="tel" id="input-phone" placeholder="88017xxxxxxxx">
              <button class="btn btn-primary" style="width:100%; padding:12px;" onclick="generatePairingCode()"><i class="fas fa-key"></i> পেয়ারিং কোড জেনারেট করুন</button>
              <div id="pairing-code-display" style="margin-top:12px; font-size:26px; font-weight:900; letter-spacing:6px; color:var(--warning); font-family:'JetBrains Mono',monospace;"></div>
            </div>

            <!-- QR FALLBACK -->
            <div id="qr-box" style="margin-top:14px;"></div>
          </div>

          <!-- ACTIVE OTPS & RESEND TOOL -->
          <div class="card">
            <h4 style="font-size:14px; font-weight:800; margin-bottom:14px;"><i class="fas fa-shield-alt" style="color:var(--warning);"></i> সক্রিয় ওটিপি ও রিসেন্ড প্যানেল</h4>
            <div id="otps-list" style="max-height:220px; overflow-y:auto; text-align:left;">
              <div style="text-align:center; padding:30px; color:#64748b; font-size:12px;">কোনো ওটিপি রেকর্ড নেই</div>
            </div>
          </div>
        </div>

        <!-- LIVE TERMINAL CONSOLE -->
        <div class="card">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
            <div style="font-size:13px; font-weight:800; display:flex; align-items:center; gap:6px;">
              <i class="fas fa-terminal" style="color:var(--primary);"></i> লাইভ সার্ভার টার্মিনাল লগ
            </div>
            <div style="display:flex; gap:6px;">
              <button class="btn btn-warning" onclick="copyAllLogs()" style="padding:4px 10px; font-size:10px;"><i class="far fa-copy"></i> Copy Logs</button>
              <button class="btn btn-danger" onclick="clearServerLogs()" style="padding:4px 10px; font-size:10px;"><i class="fas fa-eraser"></i> Clear</button>
            </div>
          </div>

          <div class="terminal" id="terminal-screen">
            <div class="log-info">[সার্ভার সিঙ্ক হচ্ছে...]</div>
          </div>
        </div>
      </div>

      <script>
        let latestRawLogs = [];

        async function refreshDashboard() {
          try {
            const res = await fetch('/api/live-status');
            const data = await res.json();

            const statusPill = document.getElementById('status-pill');
            const connInfo = document.getElementById('connected-info');
            const botPhone = document.getElementById('bot-phone-text');
            const pairBox = document.getElementById('pairing-box');
            const qrBox = document.getElementById('qr-box');
            const terminal = document.getElementById('terminal-screen');
            const otpsList = document.getElementById('otps-list');

            latestRawLogs = data.logs || [];

            // ১. স্ট্যাটাস আপডেট
            if (data.connected) {
              statusPill.style.background = 'rgba(0,212,170,0.15)';
              statusPill.style.color = '#00d4aa';
              statusPill.innerText = '🟢 অনলাইন ও সক্রিয়';
              connInfo.style.display = 'block';
              botPhone.innerText = '+' + data.botPhone;
              pairBox.style.display = 'none';
              qrBox.innerHTML = '';
            } else {
              statusPill.style.background = 'rgba(255,217,61,0.15)';
              statusPill.style.color = '#ffd93d';
              statusPill.innerText = '🟡 স্ক্যান / পেয়ারিং বাকি';
              connInfo.style.display = 'none';
              pairBox.style.display = 'block';
              if (data.qrCode) {
                qrBox.innerHTML = '<img src="' + data.qrCode + '" style="width:190px; background:#fff; padding:8px; border-radius:14px;">';
              }
            }

            // ২. টার্মিনাল লগ আপডেট
            if (latestRawLogs.length > 0) {
              terminal.innerHTML = latestRawLogs.map(l => 
                '<div class="log-' + l.type + '">[' + l.time + '] ' + l.text + '</div>'
              ).join('');
            }

            // ৩. সক্রিয় ওটিপি লিস্ট ও ১-ক্লিক রিসেন্ড বাটন
            const entries = Object.entries(data.activeOtps || {});
            if (entries.length === 0) {
              otpsList.innerHTML = '<div style="text-align:center; padding:30px; color:#64748b; font-size:12px;">কোনো ওটিপি রেকর্ড নেই</div>';
            } else {
              otpsList.innerHTML = entries.map(([target, item]) => 
                '<div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); padding:10px; border-radius:10px; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">' +
                  '<div>' +
                    '<div style="font-weight:700; font-size:13px; color:#fff;">' + target + '</div>' +
                    '<div style="font-size:11px; color:#8892b0;">কোড: <b style="color:#ffd93d; font-family:monospace; font-size:14px;">' + item.code + '</b> (' + item.time + ')</div>' +
                  '</div>' +
                  '<div style="display:flex; gap:6px;">' +
                    '<button class="btn btn-warning" style="padding:4px 8px; font-size:10px;" onclick="copySingleOtp(\\'' + item.code + '\\')"><i class="far fa-copy"></i> Copy</button>' +
                    '<button class="btn btn-success" style="padding:4px 8px; font-size:10px;" onclick="resendOtpNow(\\'' + target + '\\')"><i class="fas fa-paper-plane"></i> Resend</button>' +
                  '</div>' +
                '</div>'
              ).join('');
            }

          } catch (e) {}
        }

        async function generatePairingCode() {
          const phone = document.getElementById('input-phone').value.trim();
          const display = document.getElementById('pairing-code-display');
          if (!phone) return alert('১১ ডিজিটের মোবাইল নম্বর লিখুন!');
          display.innerText = 'জেনারেট হচ্ছে...';

          try {
            const res = await fetch('/api/pair-number', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ phone })
            });
            const d = await res.json();
            if (d.pairingCode) {
              display.innerText = d.pairingCode;
              alert('WhatsApp ওপেন করুন > Linked Devices > Link with phone number এ গিয়ে এই কোডটি লিখুন: ' + d.pairingCode);
            } else {
              display.innerText = '';
              alert(d.message || 'Error occurred');
            }
          } catch(e) {
            display.innerText = '';
            alert(e.message);
          }
        }

        async function hardResetBot() {
          if (!confirm('আপনি কি এই নম্বরটি রিমুভ করে নতুন নম্বর লিঙ্ক করতে চান?')) return;
          await fetch('/api/hard-reset', { method: 'POST' });
          alert('রিসেট সম্পন্ন হয়েছে। ২ সেকেন্ড পর নতুন নম্বর দিয়ে কোড নিন।');
          refreshDashboard();
        }

        async function resendOtpNow(phone) {
          const res = await fetch('/api/resend-code', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone })
          });
          const d = await res.json();
          if (d.success) alert('নতুন কোড পাঠানো হয়েছে: ' + d.newCode);
          else alert(d.message);
          refreshDashboard();
        }

        function copySingleOtp(code) {
          navigator.clipboard.writeText(code);
          alert('কোড কপি করা হয়েছে: ' + code);
        }

        function copyAllLogs() {
          const text = latestRawLogs.map(l => '[' + l.time + '] ' + l.text).join('\\n');
          navigator.clipboard.writeText(text);
          alert('সকল টার্মিনাল লগ কপি করা হয়েছে!');
        }

        async function clearServerLogs() {
          await fetch('/api/clear-logs', { method: 'POST' });
          refreshDashboard();
        }

        setInterval(refreshDashboard, 3000);
        refreshDashboard();
      </script>
    </body>
    </html>
  `);
});

app.listen(PORT, '0.0.0.0', () => appendLog('info', `সার্ভার চলছে পোর্ট: ${PORT}`));
