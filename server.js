const express = require("express");
const { WebSocketServer } = require("ws");
const http = require("http");
const path = require("path");
const { WebcastPushConnection } = require("tiktok-live-connector");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

// ── YouTube search via scraping (no API key needed) ──
async function searchYouTube(query) {
  try {
    const encoded = encodeURIComponent(query + " official audio");
    const url = `https://www.youtube.com/results?search_query=${encoded}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    const html = await res.text();

    // Extract ytInitialData JSON from the page
    const match = html.match(/var ytInitialData = ({.+?});<\/script>/s);
    if (!match) throw new Error("No ytInitialData found");

    const data = JSON.parse(match[1]);
    const contents =
      data?.contents?.twoColumnSearchResultsRenderer?.primaryContents
        ?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];

    for (const item of contents) {
      const v = item?.videoRenderer;
      if (!v || !v.videoId) continue;

      const videoId = v.videoId;
      const title = v.title?.runs?.[0]?.text || query;
      const author = v.ownerText?.runs?.[0]?.text || "";
      const duration = v.lengthText?.simpleText || "3:00";
      const thumbnail = `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;

      return {
        videoId,
        title,
        author,
        thumbnail,
        duration,
        durationSecs: parseDuration(duration),
        url: `https://www.youtube.com/watch?v=${videoId}`,
      };
    }
    return null;
  } catch (err) {
    console.error("YouTube search error:", err.message);
    return null;
  }
}

function parseDuration(str) {
  if (!str) return 180;
  const parts = str.split(":").map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 180;
}

// ── WebSocket connections ──
const activeConnections = new Map();

wss.on("connection", (ws) => {
  console.log("🌐 Cliente conectado");

  const send = (data) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
  };

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Connect to TikTok Live
    if (msg.type === "connect") {
      const username = msg.username?.replace("@", "").trim();
      if (!username) { send({ type: "error", text: "Username inválido." }); return; }

      if (activeConnections.has(ws)) {
        try { activeConnections.get(ws).disconnect(); } catch {}
        activeConnections.delete(ws);
      }

      send({ type: "status", text: `Conectando a @${username}...` });

      const tiktok = new WebcastPushConnection(username, {
        processInitialData: false,
        enableWebsocketUpgrade: true,
        requestPollingIntervalMs: 1000,
      });
      activeConnections.set(ws, tiktok);

      tiktok.connect()
        .then((state) => {
          console.log(`✅ Conectado a @${username}`);
          send({ type: "connected", username, roomId: state.roomId });
        })
        .catch(() => {
          send({ type: "error", text: `No se pudo conectar a @${username}. ¿Está en vivo?` });
          activeConnections.delete(ws);
        });

      tiktok.on("chat", (data) => {
        const comment = data.comment || "";
        const songReq = parseSongRequest(comment);
        send({
          type: "chat",
          user: `@${data.uniqueId || "anon"}`,
          comment,
          isMod: data.isModerator || false,
          isSub: data.isSubscriber || false,
          songRequest: songReq,
          timestamp: Date.now(),
        });
      });

      tiktok.on("gift", (data) => {
        send({ type: "gift", user: `@${data.uniqueId}`, giftName: data.giftName, repeatCount: data.repeatCount || 1 });
      });

      tiktok.on("roomUser", (data) => {
        send({ type: "viewers", count: data.viewerCount || 0 });
      });

      tiktok.on("streamEnd", () => {
        send({ type: "streamEnd", text: `El live de @${username} terminó.` });
      });

      tiktok.on("error", (err) => {
        send({ type: "error", text: `Error: ${err.message}` });
      });
    }

    // Search YouTube
    if (msg.type === "searchYoutube") {
      const { query, requestId } = msg;
      console.log(`🔍 Buscando en YouTube: "${query}"`);
      send({ type: "youtubeSearching", requestId });

      const result = await searchYouTube(query);
      if (result) {
        console.log(`✅ Encontrado: ${result.title}`);
        send({ type: "youtubeResult", requestId, ...result });
      } else {
        console.log(`❌ No encontrado: "${query}"`);
        send({ type: "youtubeNotFound", requestId, query });
      }
    }

    // Disconnect
    if (msg.type === "disconnect") {
      if (activeConnections.has(ws)) {
        try { activeConnections.get(ws).disconnect(); } catch {}
        activeConnections.delete(ws);
        send({ type: "disconnected" });
      }
    }
  });

  ws.on("close", () => {
    if (activeConnections.has(ws)) {
      try { activeConnections.get(ws).disconnect(); } catch {}
      activeConnections.delete(ws);
      console.log("🗑️ Cliente cerró pestaña");
    }
  });
});

function parseSongRequest(comment) {
  const lower = comment.toLowerCase().trim();
  const prefixes = ["!sr ", "!songrequest ", "!pedir ", "!song ", "!play "];
  for (const prefix of prefixes) {
    if (lower.startsWith(prefix)) {
      const song = comment.slice(prefix.length).trim();
      if (song.length > 0) return { song };
    }
  }
  return null;
}

server.listen(PORT, () => {
  console.log(`\n🎵 TikTok Music Bot → http://localhost:${PORT}\n`);
});
