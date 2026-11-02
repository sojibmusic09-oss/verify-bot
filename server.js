/**
 * ST TOURNAMENT BD - Official Anti-Ban WhatsApp OTP Engine
 * Pairing Code + QR Scan + Inbound Verification (No Spam/Ban Risk)
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

// ================= ১. BAILEYS WHATSAPP BOT ENGINE =================
async function startWhatsAppBot() {
  if (botState.connecting || botState.connected) return;
  botState.connecting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      auth: state,
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'), // পেয়ারিং কোড ও QR ১০০% সাপোর্ট
      syncFullHistory: false,
      markOnlineOnConnect: true,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 25000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        botState.qrCodeUrl = await QRCode.toDataURL(qr);
        console.log("⚡ New QR Code Generated.");
      }

      if (connection === 'close') {
        botState.connected = false;
        botState.connecting = false;
        botState.botPhone = null;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`⚠️ WhatsApp Disconnected. Status: ${statusCode}`);

        if (statusCode !== DisconnectReason.loggedOut) {
          setTimeout(() => startWhatsAppBot(), 5000);
        } else {
          console.log("❌ Logged out. Re-pairing required.");
        }
      } else if (connection === 'open') {
        botState.connected = true;
        botState.connecting = false;
        botState.qrCodeUrl = null;
        botState.pairingCode = null;

        // বটের নিজের নম্বর ডিটেক্ট করা
        if (sock.user && sock.user.id) {
          botState.botPhone = sock.user.id.split(':')[0].replace(/[^0-9]/g, '');
        }
        console.log(`✅ [WhatsApp Bot Connected] Bot Number: ${botState.botPhone}`);
      }
    });

    // ================= ২. ইনকামিং মেসেজ হ্যান্ডলার (ANTI-BAN AUTO OTP) =================
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      try {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        if (sender.includes('@g.us')) return; // গ্রুপ মেসেজ এড়িয়ে চলা

        const text = (
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          ''
        ).trim();

        if (!text) return;

        console.log(`📩 [Message from ${sender}]: ${text}`);

        // যদি মেসেজে কোড চাওয়ার কি-ওয়ার্ড থাকে
        if (text.includes('পার্টনার') || text.includes('partner') || text.includes('code') || text.includes('কোড')) {
          
          // মেসেজ থেকে ট্র্যাকিং টোকেন থাকলে বের করা
          const tokenMatch = text.match(/\[([A-Za-z0-9-_]+)\]/);
          const requestToken = tokenMatch ? tokenMatch[1] : '';

          // ৬ ডিজিটের ওটিপি জেনারেট
          const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

          // ফায়ারস্টোর বা মেমোরিতে টোকেন ম্যাপিং (ওয়েবসাইটের সাথে সিঙ্ক)
          activeOtpStore[sender.replace(/[^0-9]/g, '')] = otpCode;
          if (requestToken) activeOtpStore[requestToken] = otpCode;

          await delay(1000); // ন্যাচারাল হিউম্যান টাইপিং ডিলে

          const replyMsg = `*ST TOURNAMENT BD - পার্টনার ভেরিফিকেশন*\n━━━━━━━━━━━━━━━━━━━━\nআপনার ওটিপি কোড হলো: *${otpCode}*\n\n🔒 এই কোডটি সাইটে দিয়ে ভেরিফিকেশন সম্পন্ন করুন। কাউকে শেয়ার করবেন না।\n━━━━━━━━━━━━━━━━━━━━\n_Anti-Ban Secure Verification_`;

          await sock.sendMessage(sender, { text: replyMsg });
          console.log(`🚀 [Auto-OTP Sent to ${sender}]: ${otpCode}`);
        }

      } catch (err) {
        console.error("Auto reply error:", err.message);
      }
    });

  } catch (err) {
    botState.connecting = false;
    setTimeout(() => startWhatsAppBot(), 5000);
  }
}
startWhatsAppBot();

// ইন-মেমোরি ওটিপি স্টোরেজ (ওয়েবসাইটে যাচাই করার জন্য)
const activeOtpStore = {};

// ================= ৩. এপিআই রাউটস =================

// বটের লাইভ স্ট্যাটাস ও বট নম্বর
app.get('/status', (req, res) => {
  res.json({
    connected: botState.connected,
    connecting: botState.connecting,
    qrCode: botState.qrCodeUrl,
    pairingCode: botState.pairingCode,
    botPhone: botState.botPhone
  });
});

// পেয়ারিং কোড রিকোয়েস্ট (ফোন নম্বর দিয়ে লগইন)
app.post('/pair', async (req, res) => {
  let phone = (req.body.phone || '').replace(/[^0-9]/g, '');
  if (phone.startsWith('01') && phone.length === 11) phone = '88' + phone;

  if (!phone || phone.length < 11) {
    return res.status(400).json({ success: false, message: 'সঠিক আন্তর্জাতিক নম্বর দিন (যেমন: 88017...)' });
  }

  try {
    if (!sock) {
      await startWhatsAppBot();
      await delay(2000);
    }
    if (sock && !sock.authState.creds.registered) {
      await delay(1500);
      const code = await sock.requestPairingCode(phone);
      botState.pairingCode = code;
      console.log(`🔑 Pairing Code Generated: ${code} for ${phone}`);
      return res.json({ success: true, pairingCode: code });
    }
    return res.status(400).json({ success: false, message: 'ইতিমধ্যে কানেক্টেড আছে।' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// সাইট থেকে ওটিপি অটো-চেক করার এন্ডপয়েন্ট
app.post('/api/verify-inbound-otp', (req, res) => {
  const { phone, code, token } = req.body;
  const cleanPhone = String(phone || '').replace(/[^0-9]/g, '');

  let validCode = activeOtpStore[cleanPhone] || (token ? activeOtpStore[token] : null);

  if (validCode && String(validCode) === String(code)) {
    delete activeOtpStore[cleanPhone];
    if (token) delete activeOtpStore[token];
    return res.json({ success: true, message: 'OTP Verified successfully!' });
  }

  return res.json({ success: false, message: 'Invalid or Expired OTP' });
});

// ================= ৪. সার্ভার ফ্রন্টএন্ড (QR + Pairing Code লগইন UI) =================
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>ST WhatsApp Bot Server</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;700;800&display=swap" rel="stylesheet">
        <style>
          * { margin:0; padding:0; box-sizing:border-box; font-family:'Plus Jakarta Sans',sans-serif; }
          body { background:#08080e; color:#fff; text-align:center; padding:30px 15px; }
          .card { max-width:440px; margin:0 auto; background:rgba(20,20,35,0.95); border:1px solid rgba(255,255,255,0.08); border-radius:24px; padding:28px 20px; box-shadow:0 15px 40px rgba(0,0,0,0.5); }
          .btn { background:linear-gradient(135deg,#6C63FF,#4a42b3); color:#fff; border:none; padding:12px 20px; border-radius:12px; font-weight:800; cursor:pointer; width:100%; margin-top:10px; font-size:14px; }
          input { width:100%; padding:12px 14px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:12px; color:#fff; margin-top:8px; font-size:14px; outline:none; text-align:center; }
          .badge { padding:6px 14px; border-radius:20px; font-size:12px; font-weight:800; display:inline-block; margin-bottom:15px; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2 style="color:#6C63FF; margin-bottom:6px;">ST TOURNAMENT BD</h2>
          <p style="font-size:12px; color:#8892b0; margin-bottom:20px;">Anti-Ban WhatsApp Gateway Console</p>

          <div id="status-badge" class="badge" style="background:rgba(255,217,61,0.15); color:#ffd93d;">চেক করা হচ্ছে...</div>
          
          <div id="live-bot-info" style="display:none; margin-bottom:15px; background:rgba(0,212,170,0.1); border:1px solid rgba(0,212,170,0.3); padding:12px; border-radius:14px;">
            <div style="font-size:11px; color:#00d4aa; font-weight:700;">🟢 বটের সক্রিয় নম্বর:</div>
            <div id="bot-number-display" style="font-size:18px; font-weight:800; letter-spacing:1px; color:#fff; margin-top:2px;"></div>
          </div>

          <!-- Pairing Code Option -->
          <div id="pairing-section" style="margin-top:15px;">
            <div style="font-size:13px; font-weight:700; color:#cbd5e1; text-align:left;">নম্বর দিয়ে Pairing Code নিন:</div>
            <input type="tel" id="target-phone" placeholder="88017xxxxxxxx">
            <button class="btn" onclick="requestPairCode()">পেয়ারিং কোড জেনারেট করুন</button>
            <div id="pair-result" style="margin-top:14px; font-size:24px; font-weight:900; letter-spacing:4px; color:#ffd93d; font-family:monospace;"></div>
          </div>

          <div style="margin:20px 0; font-size:11px; color:#64748b;">অথবা QR স্ক্যান করুন</div>

          <!-- QR Code Option -->
          <div id="qr-container"></div>
        </div>

        <script>
          async function fetchStatus() {
            try {
              const res = await fetch('/status');
              const d = await res.json();
              const badge = document.getElementById('status-badge');
              const qrCont = document.getElementById('qr-container');
              const liveInfo = document.getElementById('live-bot-info');
              const botNum = document.getElementById('bot-number-display');

              if(d.connected) {
                badge.style.background = 'rgba(0,212,170,0.15)';
                badge.style.color = '#00d4aa';
                badge.innerText = '🟢 WhatsApp Connected & Active';
                qrCont.innerHTML = '';
                document.getElementById('pairing-section').style.display = 'none';
                if(d.botPhone) {
                  liveInfo.style.display = 'block';
                  botNum.innerText = '+' + d.botPhone;
                }
              } else if(d.qrCode) {
                badge.style.background = 'rgba(255,217,61,0.15)';
                badge.style.color = '#ffd93d';
                badge.innerText = '🟡 QR স্ক্যান অথবা Pairing কোড দিন';
                qrCont.innerHTML = '<img src="' + d.qrCode + '" style="width:230px; background:#fff; padding:10px; border-radius:16px;">';
              }
            } catch(e) {}
          }

          async function requestPairCode() {
            const p = document.getElementById('target-phone').value.trim();
            const resEl = document.getElementById('pair-result');
            if(!p) return alert('ফোন নম্বর দিন!');
            resEl.innerText = 'কোড তৈরি হচ্ছে...';

            try {
              const res = await fetch('/pair', {
                method:'POST',
                headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ phone: p })
              });
              const data = await res.json();
              if(data.pairingCode) {
                resEl.innerText = data.pairingCode;
                alert('WhatsApp ওপেন করুন > Linked Devices > Link with phone number এ গিয়ে এই কোডটি দিন: ' + data.pairingCode);
              } else {
                resEl.innerText = '';
                alert(data.message || 'Error occurred');
              }
            } catch(e) {
              resEl.innerText = '';
              alert(e.message);
            }
          }

          setInterval(fetchStatus, 3000);
          fetchStatus();
        </script>
      </body>
    </html>
  `);
});

app.listen(PORT, '0.0.0.0', () => console.log(`Anti-Ban Bot running on port ${PORT}`));
