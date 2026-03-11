const express   = require("express");
const { WebSocketServer } = require("ws");
const http      = require("http");
const path      = require("path");
const fs        = require("fs");
const bcrypt    = require("bcryptjs");
const jwt       = require("jsonwebtoken");
const { WebcastPushConnection } = require("tiktok-live-connector");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });
const PORT       = process.env.PORT       || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "change-this-in-production";
const DEV_KEY    = process.env.DEV_KEY    || "dev-secret-key";
const DATA_DIR   = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ── Data helpers ──
function read(key)       { const f=path.join(DATA_DIR,`${key}.json`); if(!fs.existsSync(f))return null; try{return JSON.parse(fs.readFileSync(f,"utf8"));}catch{return null;} }
function write(key, val) { fs.writeFileSync(path.join(DATA_DIR,`${key}.json`),JSON.stringify(val,null,2)); }
function getUsers()      { return read("_users") || {}; }
function getUser(u)      { return getUsers()[u.toLowerCase()]; }
function saveUser(u, d)  { const all=getUsers(); all[u.toLowerCase()]=d; write("_users",all); }
function rk(u,k)         { return `u_${u.toLowerCase()}_${k}`; }
function rd(u,k)         { return read(rk(u,k)) ?? dflt(k); }
function wd(u,k,val)     { write(rk(u,k),val); }
function dflt(k)         { if(k==="moderation")return{caps:{enabled:false,max:70},links:{enabled:true},spam:{enabled:true},timeout:300}; return []; }
function appendLog(u, e) { let l=rd(u,"logs"); if(!Array.isArray(l))l=[]; l.unshift({id:Date.now(),ts:new Date().toISOString(),...e}); if(l.length>500)l=l.slice(0,500); wd(u,"logs",l); }
function issue(username, role, exp="24h") { return jwt.sign({username:username.toLowerCase(),role},JWT_SECRET,{expiresIn:exp}); }

// ── Auth middleware ──
function authMW(req,res,next) {
  const t=req.headers.authorization?.replace("Bearer ","");
  if(!t) return res.status(401).json({error:"No autorizado"});
  try { req.user=jwt.verify(t,JWT_SECRET); next(); }
  catch { res.status(401).json({error:"Token inválido"}); }
}

// ============================================================
// AUTH ROUTES
// ============================================================

// Developer login — just a secret key, no account needed
app.post("/api/auth/dev", (req,res) => {
  if (!req.body.devKey || req.body.devKey !== DEV_KEY)
    return res.status(401).json({error:"Clave incorrecta."});
  res.json({ ok:true, token:issue("__dev__","dev","30d"), role:"dev" });
});

// Streamer: register
app.post("/api/auth/register", async (req,res) => {
  const u = (req.body.username||"").replace("@","").toLowerCase().trim();
  const p = req.body.password||"";
  if (!u)       return res.status(400).json({error:"Ingresá tu usuario de TikTok."});
  if (p.length<6) return res.status(400).json({error:"Contraseña: mínimo 6 caracteres."});
  if (getUser(u)) return res.status(409).json({error:"Usuario ya registrado. Iniciá sesión."});
  saveUser(u, {passwordHash:await bcrypt.hash(p,10), verified:false, role:"streamer", createdAt:new Date().toISOString()});
  res.json({ok:true});
});

// Streamer: start ownership verification
const pending = new Map();
app.post("/api/auth/verify/start", (req,res) => {
  const u = (req.body.username||"").replace("@","").toLowerCase().trim();
  const user = getUser(u);
  if (!user) return res.status(404).json({error:"Registrate primero."});
  if (user.verified) return res.json({ok:true, alreadyVerified:true});
  const code = "TIKBOT-"+Math.random().toString(36).slice(2,8).toUpperCase();
  if (pending.has(u)) { const p=pending.get(u); clearTimeout(p.timer); try{p.conn.disconnect();}catch{} }
  const conn = new WebcastPushConnection(u, {processInitialData:false,enableWebsocketUpgrade:true,requestPollingIntervalMs:1000});
  const timer = setTimeout(() => { pending.delete(u); try{conn.disconnect();}catch{}; }, 5*60*1000);
  conn.connect()
    .then(() => {
      conn.on("chat", d => {
        if ((d.comment||"").trim().toUpperCase()===code && (d.uniqueId||"").toLowerCase()===u) {
          clearTimeout(timer); pending.delete(u); try{conn.disconnect();}catch{};
          saveUser(u, {...getUser(u), verified:true});
          console.log(`✅ @${u} verificado`);
        }
      });
    })
    .catch(() => { clearTimeout(timer); pending.delete(u); });
  pending.set(u, {code,conn,timer});
  res.json({ok:true, code});
});

// Streamer: poll verification status
app.get("/api/auth/verify/status/:u", (req,res) => {
  const u = req.params.u.replace("@","").toLowerCase();
  const user = getUser(u);
  if (!user) return res.status(404).json({error:"No encontrado."});
  if (user.verified) return res.json({verified:true, token:issue(u,"streamer")});
  res.json({verified:false});
});

// Streamer: login
app.post("/api/auth/login", async (req,res) => {
  const u = (req.body.username||"").replace("@","").toLowerCase().trim();
  const p = req.body.password||"";
  const user = getUser(u);
  if (!user || !(await bcrypt.compare(p,user.passwordHash)))
    return res.status(401).json({error:"Usuario o contraseña incorrectos."});
  if (!user.verified)
    return res.status(403).json({error:"Cuenta no verificada.", needsVerification:true, username:u});
  res.json({ok:true, token:issue(u,"streamer"), username:u, role:"streamer"});
});

// Me
app.get("/api/auth/me", authMW, (req,res) => {
  if (req.user.role==="dev") return res.json({username:"__dev__",role:"dev"});
  const u=getUser(req.user.username);
  if(!u) return res.status(404).json({error:"No encontrado."});
  res.json({username:req.user.username, role:"streamer"});
});

// ============================================================
// DATA ROUTES
// ============================================================
function scope(req) {
  // dev can pass ?as=username to use a streamer's data, otherwise uses __dev__
  if (req.user.role==="dev" && req.query.as) return req.query.as.toLowerCase();
  if (req.user.role==="dev") return "__dev__";
  return req.user.username;
}

function crud(key) {
  app.get(`/api/${key}`,        authMW,(req,res)=>res.json(rd(scope(req),key)));
  app.post(`/api/${key}`,       authMW,(req,res)=>{const u=scope(req);const d=rd(u,key);d.push({id:Date.now(),...req.body});wd(u,key,d);res.json(d);});
  app.put(`/api/${key}/:id`,    authMW,(req,res)=>{const u=scope(req);let d=rd(u,key);d=d.map(x=>x.id==req.params.id?{...x,...req.body}:x);wd(u,key,d);res.json(d);});
  app.delete(`/api/${key}/:id`, authMW,(req,res)=>{const u=scope(req);let d=rd(u,key);d=d.filter(x=>x.id!=req.params.id);wd(u,key,d);res.json(d);});
}
crud("commands"); crud("timers"); crud("giveaways"); crud("regulars"); crud("bannedwords");
app.get("/api/moderation", authMW,(req,res)=>res.json(rd(scope(req),"moderation")));
app.put("/api/moderation", authMW,(req,res)=>{wd(scope(req),"moderation",req.body);res.json(req.body);});
app.get("/api/logs",       authMW,(req,res)=>res.json(rd(scope(req),"logs")));
app.delete("/api/logs",    authMW,(req,res)=>{wd(scope(req),"logs",[]);res.json([]);});

// ============================================================
// YOUTUBE
// ============================================================
async function searchYT(q) {
  try {
    const r=await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(q+" official audio")}`,
      {headers:{"User-Agent":"Mozilla/5.0 Chrome/120","Accept-Language":"en-US"}});
    const html=await r.text();
    const m=html.match(/var ytInitialData = ({.+?});<\/script>/s);
    if(!m)return null;
    const items=JSON.parse(m[1])?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents||[];
    for(const i of items){const v=i?.videoRenderer;if(!v?.videoId)continue;return{videoId:v.videoId,title:v.title?.runs?.[0]?.text||q,author:v.ownerText?.runs?.[0]?.text||"",thumbnail:`https://img.youtube.com/vi/${v.videoId}/mqdefault.jpg`,duration:v.lengthText?.simpleText||"3:00",durationSecs:parseDur(v.lengthText?.simpleText)};}
  }catch(e){console.error("YT:",e.message);}
  return null;
}
function parseDur(s){if(!s)return 180;const p=s.split(":").map(Number);return p.length===2?p[0]*60+p[1]:p.length===3?p[0]*3600+p[1]*60+p[2]:180;}

// ============================================================
// WEBSOCKET
// ============================================================
const activeTT = new Map();
wss.on("connection", ws => {
  let auth = null;
  let dataUser = null; // which user's data to use
  const send = d => { if(ws.readyState===ws.OPEN)ws.send(JSON.stringify(d)); };

  ws.on("message", async raw => {
    let msg; try{msg=JSON.parse(raw);}catch{return;}

    if (msg.type==="auth") {
      try {
        const p=jwt.verify(msg.token,JWT_SECRET);
        auth={username:p.username,role:p.role};
        send({type:"authOk",username:auth.username,role:auth.role});
      } catch { send({type:"authFail",error:"Token inválido"}); }
      return;
    }
    if (!auth) { send({type:"authFail"}); return; }

    if (msg.type==="connect") {
      const target=(msg.username||"").replace("@","").toLowerCase().trim();
      if (!target) { send({type:"error",text:"Ingresá un @usuario."}); return; }
      // Streamers: only their own channel
      if (auth.role==="streamer" && target!==auth.username) {
        send({type:"error",text:"Solo podés conectarte a tu propio canal."}); return;
      }
      // Dev: any channel
      dataUser = auth.role==="dev" ? target : auth.username;
      if (activeTT.has(ws)) { try{activeTT.get(ws).disconnect();}catch{} }
      send({type:"status",text:`Conectando a @${target}...`});
      const tt=new WebcastPushConnection(target,{processInitialData:false,enableWebsocketUpgrade:true,requestPollingIntervalMs:1000});
      activeTT.set(ws,tt);
      tt.connect()
        .then(s=>{send({type:"connected",username:target,roomId:s.roomId,role:auth.role});appendLog(dataUser,{type:"system",text:`Conectado a @${target}`});})
        .catch(()=>send({type:"error",text:`No se pudo conectar a @${target}. ¿Está en vivo?`}));
      tt.on("chat",d=>{
        const comment=d.comment||"",user=`@${d.uniqueId||"anon"}`;
        const songReq=parseSongReq(comment);
        const mod=rd(dataUser,"moderation"),banned=rd(dataUser,"bannedwords");
        let ma=null;
        if(mod.links?.enabled&&/https?:\/\/|www\./i.test(comment))ma="link";
        if(mod.caps?.enabled){const pct=(comment.match(/[A-Z]/g)||[]).length/Math.max(comment.length,1)*100;if(pct>(mod.caps.max||70)&&comment.length>8)ma="caps";}
        if(Array.isArray(banned)&&banned.some(w=>comment.toLowerCase().includes((w.word||"").toLowerCase())))ma="banned_word";
        if(ma){send({type:"modAction",user,action:ma,comment});appendLog(dataUser,{type:"mod",text:`Moderado ${user}: ${ma}`});}
        const cmds=rd(dataUser,"commands");
        if(Array.isArray(cmds)){for(const c of cmds){if(c.enabled!==false&&comment.trim().toLowerCase()===c.command?.toLowerCase()){send({type:"commandTriggered",user,command:c.command});appendLog(dataUser,{type:"command",text:`${user} usó ${c.command}`});break;}}}
        const gws=rd(dataUser,"giveaways");
        if(Array.isArray(gws)){for(const g of gws){if(g.active&&comment.trim().toLowerCase()===(g.keyword||"!join").toLowerCase()){const e=g.entries||[];if(!e.includes(user)){e.push(user);wd(dataUser,"giveaways",gws.map(gg=>gg.id===g.id?{...gg,entries:e}:gg));send({type:"giveawayEntry",user,count:e.length});}}}}
        send({type:"chat",user,comment,isMod:d.isModerator||false,isSub:d.isSubscriber||false,songRequest:songReq,timestamp:Date.now()});
        appendLog(dataUser,{type:"chat",user,text:comment.slice(0,120)});
      });
      tt.on("gift",   d=>{send({type:"gift",user:`@${d.uniqueId}`,giftName:d.giftName,repeatCount:d.repeatCount||1});appendLog(dataUser,{type:"gift",text:`@${d.uniqueId} envió ${d.giftName}`});});
      tt.on("roomUser",d=>send({type:"viewers",count:d.viewerCount||0}));
      tt.on("follow", d=>{send({type:"follow",user:`@${d.uniqueId}`});appendLog(dataUser,{type:"follow",text:`@${d.uniqueId} siguió`});});
      tt.on("streamEnd",()=>{send({type:"streamEnd",text:"El live terminó."});});
      tt.on("error",  e=>send({type:"error",text:e.message}));
    }

    if (msg.type==="searchYoutube") {
      const r=await searchYT(msg.query);
      if(r)send({type:"youtubeResult",requestId:msg.requestId,...r});
      else send({type:"youtubeNotFound",requestId:msg.requestId,query:msg.query});
    }
    if (msg.type==="disconnect") { if(activeTT.has(ws)){try{activeTT.get(ws).disconnect();}catch{}activeTT.delete(ws);}send({type:"disconnected"}); }
    if (msg.type==="timerFired" && dataUser) appendLog(dataUser,{type:"timer",text:`Timer "${msg.name}": ${msg.message}`});
  });

  ws.on("close",()=>{ if(activeTT.has(ws)){try{activeTT.get(ws).disconnect();}catch{}activeTT.delete(ws);} });
});

function parseSongReq(c){const l=c.toLowerCase().trim();for(const p of["!sr ","!songrequest ","!pedir ","!song ","!play "]){if(l.startsWith(p)){const s=c.slice(p.length).trim();if(s)return{song:s};}}return null;}
server.listen(PORT,()=>console.log(`\n🎵 TikBot → http://localhost:${PORT}\n`));
