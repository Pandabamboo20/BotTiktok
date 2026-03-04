const express = require("express");
const { WebSocketServer } = require("ws");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { WebcastPushConnection } = require("tiktok-live-connector");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");

// ── Ensure data directory exists ──
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ── Generic data helpers ──
function readData(key) {
  const file = path.join(DATA_DIR, `${key}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
function writeData(key, data) {
  const file = path.join(DATA_DIR, `${key}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ── REST API ──
// Commands
app.get("/api/commands",    (req, res) => res.json(readData("commands") || []));
app.post("/api/commands",   (req, res) => { const d = readData("commands") || []; d.push({ id: Date.now(), ...req.body }); writeData("commands", d); res.json(d); });
app.put("/api/commands/:id",(req, res) => { let d = readData("commands") || []; d = d.map(c => c.id == req.params.id ? { ...c, ...req.body } : c); writeData("commands", d); res.json(d); });
app.delete("/api/commands/:id", (req, res) => { let d = readData("commands") || []; d = d.filter(c => c.id != req.params.id); writeData("commands", d); res.json(d); });

// Giveaways
app.get("/api/giveaways",    (req, res) => res.json(readData("giveaways") || []));
app.post("/api/giveaways",   (req, res) => { const d = readData("giveaways") || []; d.push({ id: Date.now(), entries: [], active: false, ...req.body }); writeData("giveaways", d); res.json(d); });
app.put("/api/giveaways/:id",(req, res) => { let d = readData("giveaways") || []; d = d.map(g => g.id == req.params.id ? { ...g, ...req.body } : g); writeData("giveaways", d); res.json(d); });
app.delete("/api/giveaways/:id", (req, res) => { let d = readData("giveaways") || []; d = d.filter(g => g.id != req.params.id); writeData("giveaways", d); res.json(d); });

// Regulars
app.get("/api/regulars",    (req, res) => res.json(readData("regulars") || []));
app.post("/api/regulars",   (req, res) => { const d = readData("regulars") || []; if (!d.find(r => r.user === req.body.user)) d.push({ id: Date.now(), addedAt: new Date().toISOString(), ...req.body }); writeData("regulars", d); res.json(d); });
app.delete("/api/regulars/:id", (req, res) => { let d = readData("regulars") || []; d = d.filter(r => r.id != req.params.id); writeData("regulars", d); res.json(d); });

// Timers
app.get("/api/timers",    (req, res) => res.json(readData("timers") || []));
app.post("/api/timers",   (req, res) => { const d = readData("timers") || []; d.push({ id: Date.now(), enabled: true, ...req.body }); writeData("timers", d); res.json(d); });
app.put("/api/timers/:id",(req, res) => { let d = readData("timers") || []; d = d.map(t => t.id == req.params.id ? { ...t, ...req.body } : t); writeData("timers", d); res.json(d); });
app.delete("/api/timers/:id", (req, res) => { let d = readData("timers") || []; d = d.filter(t => t.id != req.params.id); writeData("timers", d); res.json(d); });

// Moderation
app.get("/api/moderation",  (req, res) => res.json(readData("moderation") || defaultModeration()));
app.put("/api/moderation",  (req, res) => { writeData("moderation", req.body); res.json(req.body); });

// Logs (last 500)
app.get("/api/logs", (req, res) => res.json(readData("logs") || []));
function appendLog(entry) {
  let logs = readData("logs") || [];
  logs.unshift({ id: Date.now(), ts: new Date().toISOString(), ...entry });
  if (logs.length > 500) logs = logs.slice(0, 500);
  writeData("logs", logs);
}

// Banned words
app.get("/api/bannedwords",  (req, res) => res.json(readData("bannedwords") || []));
app.post("/api/bannedwords", (req, res) => { const d = readData("bannedwords") || []; d.push({ id: Date.now(), ...req.body }); writeData("bannedwords", d); res.json(d); });
app.delete("/api/bannedwords/:id", (req, res) => { let d = readData("bannedwords") || []; d = d.filter(w => w.id != req.params.id); writeData("bannedwords", d); res.json(d); });

function defaultModeration() {
  return { caps: { enabled: false, max: 70 }, links: { enabled: true }, spam: { enabled: true, max: 10 }, emotes: { enabled: false, max: 15 }, timeout: 300 };
}

// ── YouTube search ──
async function searchYouTube(query) {
  try {
    const encoded = encodeURIComponent(query + " official audio");
    const res = await fetch(`https://www.youtube.com/results?search_query=${encoded}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36", "Accept-Language": "en-US,en;q=0.9" }
    });
    const html = await res.text();
    const match = html.match(/var ytInitialData = ({.+?});<\/script>/s);
    if (!match) throw new Error("No ytInitialData");
    const data = JSON.parse(match[1]);
    const contents = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];
    for (const item of contents) {
      const v = item?.videoRenderer;
      if (!v?.videoId) continue;
      return {
        videoId: v.videoId,
        title: v.title?.runs?.[0]?.text || query,
        author: v.ownerText?.runs?.[0]?.text || "",
        thumbnail: `https://img.youtube.com/vi/${v.videoId}/mqdefault.jpg`,
        duration: v.lengthText?.simpleText || "3:00",
        durationSecs: parseDuration(v.lengthText?.simpleText),
      };
    }
    return null;
  } catch (err) { console.error("YT search error:", err.message); return null; }
}
function parseDuration(str) {
  if (!str) return 180;
  const p = str.split(":").map(Number);
  if (p.length === 2) return p[0]*60+p[1];
  if (p.length === 3) return p[0]*3600+p[1]*60+p[2];
  return 180;
}

// ── Timer engine ──
const activeTimers = new Map();
function startTimerEngine(send) {
  const timers = readData("timers") || [];
  for (const t of timers) {
    if (t.enabled) scheduleTimer(t, send);
  }
}
function scheduleTimer(t, send) {
  if (activeTimers.has(t.id)) clearInterval(activeTimers.get(t.id));
  const ms = (t.interval || 5) * 60 * 1000;
  const iv = setInterval(() => {
    send({ type: "timerFired", message: t.message, name: t.name });
    appendLog({ type: "timer", text: `Timer "${t.name}" disparado: ${t.message}` });
  }, ms);
  activeTimers.set(t.id, iv);
}

// ── WebSocket ──
const activeConnections = new Map();
const broadcastFns = new Set();

wss.on("connection", (ws) => {
  console.log("🌐 Cliente conectado");
  const send = (data) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data)); };
  broadcastFns.add(send);
  startTimerEngine(send);

  ws.on("message", async (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "connect") {
      const username = msg.username?.replace("@","").trim();
      if (!username) { send({ type:"error", text:"Username inválido." }); return; }
      if (activeConnections.has(ws)) { try { activeConnections.get(ws).disconnect(); } catch {} }

      send({ type:"status", text:`Conectando a @${username}...` });
      const tiktok = new WebcastPushConnection(username, { processInitialData:false, enableWebsocketUpgrade:true, requestPollingIntervalMs:1000 });
      activeConnections.set(ws, tiktok);

      tiktok.connect()
        .then(state => { console.log(`✅ @${username}`); send({ type:"connected", username, roomId:state.roomId }); appendLog({ type:"system", text:`Conectado al live de @${username}` }); })
        .catch(() => { send({ type:"error", text:`No se pudo conectar a @${username}. ¿Está en vivo?` }); activeConnections.delete(ws); });

      tiktok.on("chat", (data) => {
        const comment = data.comment || "";
        const user = `@${data.uniqueId||"anon"}`;
        const isMod = data.isModerator||false;
        const isSub = data.isSubscriber||false;
        const songReq = parseSongRequest(comment);

        // Moderation check
        const mod = readData("moderation") || defaultModeration();
        const bannedWords = readData("bannedwords") || [];
        let modAction = null;
        if (mod.links.enabled && /https?:\/\/|www\./i.test(comment)) modAction = "link";
        if (mod.caps.enabled) { const caps = (comment.match(/[A-Z]/g)||[]).length; if (caps > comment.length*(mod.caps.max/100) && comment.length > 8) modAction = "caps"; }
        if (bannedWords.some(w => comment.toLowerCase().includes(w.word?.toLowerCase()))) modAction = "banned_word";

        if (modAction) {
          send({ type:"modAction", user, action:modAction, comment });
          appendLog({ type:"mod", text:`Moderado ${user}: ${modAction} — "${comment.slice(0,50)}"` });
        }

        // Check custom commands
        const commands = readData("commands") || [];
        for (const cmd of commands) {
          if (cmd.enabled !== false && comment.trim().toLowerCase() === cmd.command?.toLowerCase()) {
            send({ type:"commandTriggered", user, command:cmd.command, response:cmd.response });
            appendLog({ type:"command", text:`${user} usó ${cmd.command}` });
            break;
          }
        }

        // Check giveaway entries
        const giveaways = readData("giveaways") || [];
        for (const g of giveaways) {
          if (g.active && comment.trim().toLowerCase() === (g.keyword||"!join").toLowerCase()) {
            const entries = g.entries || [];
            if (!entries.includes(user)) {
              entries.push(user);
              const updated = giveaways.map(gg => gg.id===g.id ? { ...gg, entries } : gg);
              writeData("giveaways", updated);
              send({ type:"giveawayEntry", user, giveawayId:g.id, count:entries.length });
            }
          }
        }

        send({ type:"chat", user, comment, isMod, isSub, songRequest:songReq, timestamp:Date.now() });
        appendLog({ type:"chat", user, text:comment });
      });

      tiktok.on("gift", (data) => { send({ type:"gift", user:`@${data.uniqueId}`, giftName:data.giftName, repeatCount:data.repeatCount||1 }); appendLog({ type:"gift", text:`@${data.uniqueId} envió ${data.giftName}` }); });
      tiktok.on("member", (data) => { send({ type:"join", user:`@${data.uniqueId}` }); });
      tiktok.on("roomUser", (data) => { send({ type:"viewers", count:data.viewerCount||0 }); });
      tiktok.on("follow", (data) => { send({ type:"follow", user:`@${data.uniqueId}` }); appendLog({ type:"follow", text:`@${data.uniqueId} siguió` }); });
      tiktok.on("streamEnd", () => { send({ type:"streamEnd", text:"El live terminó." }); appendLog({ type:"system", text:"Live terminado" }); });
      tiktok.on("error", (err) => { send({ type:"error", text:`Error: ${err.message}` }); });
    }

    if (msg.type === "searchYoutube") {
      const result = await searchYouTube(msg.query);
      if (result) send({ type:"youtubeResult", requestId:msg.requestId, ...result });
      else send({ type:"youtubeNotFound", requestId:msg.requestId, query:msg.query });
    }

    if (msg.type === "disconnect") {
      if (activeConnections.has(ws)) { try { activeConnections.get(ws).disconnect(); } catch {} activeConnections.delete(ws); }
      send({ type:"disconnected" });
    }
  });

  ws.on("close", () => {
    broadcastFns.delete(send);
    if (activeConnections.has(ws)) { try { activeConnections.get(ws).disconnect(); } catch {} activeConnections.delete(ws); }
  });
});

function parseSongRequest(comment) {
  const lower = comment.toLowerCase().trim();
  for (const prefix of ["!sr ","!songrequest ","!pedir ","!song ","!play "]) {
    if (lower.startsWith(prefix)) { const song = comment.slice(prefix.length).trim(); if (song) return { song }; }
  }
  return null;
}

server.listen(PORT, () => console.log(`\n🎵 TikTok Bot → http://localhost:${PORT}\n`));
