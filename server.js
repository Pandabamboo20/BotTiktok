const express    = require("express");
const { WebSocketServer } = require("ws");
const http       = require("http");
const path       = require("path");
const fs         = require("fs");
const bcrypt     = require("bcryptjs");
const jwt        = require("jsonwebtoken");
const { WebcastPushConnection } = require("tiktok-live-connector");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });
const PORT   = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "tiktok-bot-secret-change-in-production";
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ── Data helpers ──
function readData(key) {
  const f = path.join(DATA_DIR, `${key}.json`);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}
function writeData(key, data) {
  fs.writeFileSync(path.join(DATA_DIR, `${key}.json`), JSON.stringify(data, null, 2));
}

// ── Users store ──
function getUsers()          { return readData("users") || {}; }
function saveUsers(u)        { writeData("users", u); }
function getUser(username)   { return getUsers()[username.toLowerCase()]; }
function saveUser(username, data) {
  const users = getUsers();
  users[username.toLowerCase()] = data;
  saveUsers(users);
}

// ── Namespaced data per user ──
function userKey(username, key) { return `user_${username.toLowerCase()}_${key}`; }
function readUserData(username, key) { return readData(userKey(username, key)) || defaultFor(key); }
function writeUserData(username, key, data) { writeData(userKey(username, key), data); }
function defaultFor(key) {
  if (key === "moderation") return { caps:{enabled:false,max:70}, links:{enabled:true}, spam:{enabled:true}, timeout:300 };
  return [];
}

// ── Auth middleware ──
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "No autorizado" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: "Token inválido o expirado" }); }
}

// ── Pending verifications: username -> { code, tiktokConn, resolve } ──
const pendingVerifications = new Map();

// ============================================================
// AUTH ROUTES
// ============================================================

// Register (step 1): create account
app.post("/api/auth/register", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Faltan datos" });
  const clean = username.replace("@","").toLowerCase().trim();
  if (getUser(clean)) return res.status(409).json({ error: "Este usuario ya tiene cuenta" });
  if (password.length < 6) return res.status(400).json({ error: "La contraseña debe tener al menos 6 caracteres" });
  const hash = await bcrypt.hash(password, 10);
  saveUser(clean, { username: clean, passwordHash: hash, verified: false, createdAt: new Date().toISOString() });
  res.json({ ok: true, message: "Cuenta creada. Ahora verificá que sos el dueño del canal." });
});

// Verify ownership (step 2): start — returns a code to type in TikTok chat
app.post("/api/auth/verify/start", (req, res) => {
  const { username } = req.body;
  const clean = username?.replace("@","").toLowerCase().trim();
  const user = getUser(clean);
  if (!user) return res.status(404).json({ error: "Usuario no encontrado. Registrate primero." });
  if (user.verified) return res.json({ ok: true, alreadyVerified: true });

  // Generate a random 6-char alphanumeric code
  const code = "VERIFY-" + Math.random().toString(36).slice(2,8).toUpperCase();

  // Connect to their TikTok live to watch for the code
  const conn = new WebcastPushConnection(clean, {
    processInitialData: false,
    enableWebsocketUpgrade: true,
    requestPollingIntervalMs: 1000,
  });

  let resolved = false;
  const timeout = setTimeout(() => {
    if (!resolved) {
      resolved = true;
      try { conn.disconnect(); } catch {}
      pendingVerifications.delete(clean);
    }
  }, 5 * 60 * 1000); // 5 minute window

  conn.connect()
    .then(() => {
      conn.on("chat", (data) => {
        if (resolved) return;
        const comment = (data.comment || "").trim().toUpperCase();
        const sender  = (data.uniqueId || "").toLowerCase();
        if (comment === code.toUpperCase() && sender === clean) {
          resolved = true;
          clearTimeout(timeout);
          try { conn.disconnect(); } catch {}
          // Mark as verified
          const u = getUser(clean);
          saveUser(clean, { ...u, verified: true });
          pendingVerifications.delete(clean);
          console.log(`✅ @${clean} verificado correctamente`);
        }
      });
      conn.on("error", () => {});
    })
    .catch(() => {
      clearTimeout(timeout);
      pendingVerifications.delete(clean);
    });

  pendingVerifications.set(clean, { code, conn });
  console.log(`🔑 Código de verificación para @${clean}: ${code}`);
  res.json({ ok: true, code, message: `Escribí exactamente "${code}" en tu chat de TikTok en vivo` });
});

// Verify ownership (step 2): poll — check if verified yet
app.get("/api/auth/verify/status/:username", (req, res) => {
  const clean = req.params.username.replace("@","").toLowerCase().trim();
  const user = getUser(clean);
  if (!user) return res.status(404).json({ error: "Usuario no encontrado" });
  if (user.verified) {
    // Auto-issue token when verified
    const token = jwt.sign({ username: clean }, JWT_SECRET, { expiresIn: "24h" });
    return res.json({ verified: true, token });
  }
  res.json({ verified: false });
});

// Login
app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body;
  const clean = username?.replace("@","").toLowerCase().trim();
  const user = getUser(clean);
  if (!user) return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return res.status(401).json({ error: "Usuario o contraseña incorrectos" });
  if (!user.verified) return res.status(403).json({ error: "Cuenta no verificada. Completá la verificación primero.", needsVerification: true });
  const token = jwt.sign({ username: clean }, JWT_SECRET, { expiresIn: "24h" });
  res.json({ ok: true, token, username: clean });
});

// Me
app.get("/api/auth/me", authMiddleware, (req, res) => {
  const user = getUser(req.user.username);
  if (!user) return res.status(404).json({ error: "Usuario no encontrado" });
  res.json({ username: user.username, verified: user.verified, createdAt: user.createdAt });
});

// ============================================================
// PROTECTED DATA ROUTES (all scoped per user)
// ============================================================

function makeRoutes(key) {
  app.get(`/api/${key}`,        authMiddleware, (req, res) => res.json(readUserData(req.user.username, key)));
  app.post(`/api/${key}`,       authMiddleware, (req, res) => { const d = readUserData(req.user.username, key); d.push({ id: Date.now(), ...req.body }); writeUserData(req.user.username, key, d); res.json(d); });
  app.put(`/api/${key}/:id`,    authMiddleware, (req, res) => { let d = readUserData(req.user.username, key); d = d.map(x => x.id == req.params.id ? { ...x, ...req.body } : x); writeUserData(req.user.username, key, d); res.json(d); });
  app.delete(`/api/${key}/:id`, authMiddleware, (req, res) => { let d = readUserData(req.user.username, key); d = d.filter(x => x.id != req.params.id); writeUserData(req.user.username, key, d); res.json(d); });
}
makeRoutes("commands");
makeRoutes("timers");
makeRoutes("giveaways");
makeRoutes("regulars");
makeRoutes("bannedwords");

app.get("/api/moderation",  authMiddleware, (req, res) => res.json(readUserData(req.user.username, "moderation")));
app.put("/api/moderation",  authMiddleware, (req, res) => { writeUserData(req.user.username, "moderation", req.body); res.json(req.body); });

app.get("/api/logs",    authMiddleware, (req, res) => res.json(readUserData(req.user.username, "logs")));
app.delete("/api/logs", authMiddleware, (req, res) => { writeUserData(req.user.username, "logs", []); res.json([]); });

function appendLog(username, entry) {
  let logs = readUserData(username, "logs");
  if (!Array.isArray(logs)) logs = [];
  logs.unshift({ id: Date.now(), ts: new Date().toISOString(), ...entry });
  if (logs.length > 500) logs = logs.slice(0, 500);
  writeUserData(username, "logs", logs);
}

// ============================================================
// YOUTUBE SEARCH
// ============================================================
async function searchYouTube(query) {
  try {
    const res = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query + " official audio")}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120", "Accept-Language": "en-US" }
    });
    const html = await res.text();
    const match = html.match(/var ytInitialData = ({.+?});<\/script>/s);
    if (!match) return null;
    const data = JSON.parse(match[1]);
    const items = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];
    for (const item of items) {
      const v = item?.videoRenderer;
      if (!v?.videoId) continue;
      return { videoId: v.videoId, title: v.title?.runs?.[0]?.text || query, author: v.ownerText?.runs?.[0]?.text || "", thumbnail: `https://img.youtube.com/vi/${v.videoId}/mqdefault.jpg`, duration: v.lengthText?.simpleText || "3:00", durationSecs: parseDur(v.lengthText?.simpleText) };
    }
  } catch (e) { console.error("YT search:", e.message); }
  return null;
}
function parseDur(s) { if(!s)return 180; const p=s.split(":").map(Number); return p.length===2?p[0]*60+p[1]:p.length===3?p[0]*3600+p[1]*60+p[2]:180; }

// ============================================================
// WEBSOCKET — now authenticated
// ============================================================
const activeTikTok = new Map(); // ws -> TikTokConnection

wss.on("connection", (ws) => {
  let authedUser = null;
  const send = d => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(d)); };

  ws.on("message", async (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    // ── Authenticate the WS connection ──
    if (msg.type === "auth") {
      try {
        const payload = jwt.verify(msg.token, JWT_SECRET);
        authedUser = payload.username;
        send({ type: "authOk", username: authedUser });
        console.log(`🔐 WS autenticado: @${authedUser}`);
      } catch { send({ type: "authFail", error: "Token inválido" }); }
      return;
    }

    // All other messages require auth
    if (!authedUser) { send({ type: "authFail", error: "No autenticado" }); return; }

    // ── Connect to TikTok Live ──
    if (msg.type === "connect") {
      // Only allow connecting to their own channel
      const targetUser = msg.username?.replace("@","").toLowerCase().trim();
      if (targetUser !== authedUser) {
        send({ type: "error", text: "Solo podés conectarte a tu propio canal." });
        return;
      }

      if (activeTikTok.has(ws)) { try { activeTikTok.get(ws).disconnect(); } catch {} }
      send({ type: "status", text: `Conectando a @${targetUser}...` });

      const tiktok = new WebcastPushConnection(targetUser, { processInitialData:false, enableWebsocketUpgrade:true, requestPollingIntervalMs:1000 });
      activeTikTok.set(ws, tiktok);

      tiktok.connect()
        .then(state => { console.log(`✅ @${targetUser} conectado`); send({ type:"connected", username:targetUser, roomId:state.roomId }); appendLog(authedUser, {type:"system", text:`Conectado al live de @${targetUser}`}); })
        .catch(() => { send({ type:"error", text:`No se pudo conectar. ¿Estás en vivo?` }); activeTikTok.delete(ws); });

      tiktok.on("chat", data => {
        const comment = data.comment || "";
        const user = `@${data.uniqueId||"anon"}`;
        const isMod = data.isModerator||false;
        const isSub = data.isSubscriber||false;
        const songReq = parseSongReq(comment);

        // Moderation
        const mod = readUserData(authedUser, "moderation");
        const banned = readUserData(authedUser, "bannedwords");
        let modAction = null;
        if (mod.links?.enabled && /https?:\/\/|www\./i.test(comment)) modAction = "link";
        if (mod.caps?.enabled) { const pct = (comment.match(/[A-Z]/g)||[]).length / Math.max(comment.length,1) * 100; if (pct > (mod.caps.max||70) && comment.length > 8) modAction = "caps"; }
        if (Array.isArray(banned) && banned.some(w => comment.toLowerCase().includes((w.word||"").toLowerCase()))) modAction = "banned_word";
        if (modAction) { send({ type:"modAction", user, action:modAction, comment }); appendLog(authedUser, {type:"mod", text:`Moderado ${user}: ${modAction}`}); }

        // Commands
        const commands = readUserData(authedUser, "commands");
        if (Array.isArray(commands)) {
          for (const cmd of commands) {
            if (cmd.enabled!==false && comment.trim().toLowerCase()===cmd.command?.toLowerCase()) {
              send({ type:"commandTriggered", user, command:cmd.command, response:cmd.response });
              appendLog(authedUser, {type:"command", text:`${user} usó ${cmd.command}`});
              break;
            }
          }
        }

        // Giveaways
        const giveaways = readUserData(authedUser, "giveaways");
        if (Array.isArray(giveaways)) {
          for (const g of giveaways) {
            if (g.active && comment.trim().toLowerCase()===(g.keyword||"!join").toLowerCase()) {
              const entries = g.entries||[];
              if (!entries.includes(user)) {
                entries.push(user);
                writeUserData(authedUser, "giveaways", giveaways.map(gg=>gg.id===g.id?{...gg,entries}:gg));
                send({ type:"giveawayEntry", user, giveawayId:g.id, count:entries.length });
              }
            }
          }
        }

        send({ type:"chat", user, comment, isMod, isSub, songRequest:songReq, timestamp:Date.now() });
        appendLog(authedUser, {type:"chat", user, text:comment.slice(0,120)});
      });

      tiktok.on("gift",     d => { send({type:"gift",user:`@${d.uniqueId}`,giftName:d.giftName,repeatCount:d.repeatCount||1}); appendLog(authedUser,{type:"gift",text:`@${d.uniqueId} envió ${d.giftName}`}); });
      tiktok.on("roomUser", d => send({type:"viewers",count:d.viewerCount||0}));
      tiktok.on("follow",   d => { send({type:"follow",user:`@${d.uniqueId}`}); appendLog(authedUser,{type:"follow",text:`@${d.uniqueId} siguió`}); });
      tiktok.on("streamEnd",() => { send({type:"streamEnd",text:"El live terminó."}); appendLog(authedUser,{type:"system",text:"Live terminado"}); });
      tiktok.on("error",    e => send({type:"error",text:e.message}));
    }

    if (msg.type === "searchYoutube") {
      const result = await searchYouTube(msg.query);
      if (result) send({type:"youtubeResult",requestId:msg.requestId,...result});
      else send({type:"youtubeNotFound",requestId:msg.requestId,query:msg.query});
    }

    if (msg.type === "disconnect") {
      if (activeTikTok.has(ws)) { try { activeTikTok.get(ws).disconnect(); } catch {} activeTikTok.delete(ws); }
      send({type:"disconnected"});
    }

    // Timer fire (from client scheduling, or server can do it too)
    if (msg.type === "timerFired") {
      appendLog(authedUser, {type:"timer", text:`Timer "${msg.name}": ${msg.message}`});
    }
  });

  ws.on("close", () => {
    if (activeTikTok.has(ws)) { try { activeTikTok.get(ws).disconnect(); } catch {} activeTikTok.delete(ws); }
  });
});

function parseSongReq(comment) {
  const lower = comment.toLowerCase().trim();
  for (const p of ["!sr ","!songrequest ","!pedir ","!song ","!play "]) {
    if (lower.startsWith(p)) { const s=comment.slice(p.length).trim(); if(s) return {song:s}; }
  }
  return null;
}

server.listen(PORT, () => console.log(`\n🎵 TikBot → http://localhost:${PORT}\n`));
