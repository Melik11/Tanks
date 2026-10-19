// ═══════════════════════════════════════════════════════════════════
//  TANK ARENA 10P — self-contained fix.js
//  Запуск:  node fix.js
//  Внутри: HTTP-сервер + WebSocket + встроенный клиент (HTML)
// ═══════════════════════════════════════════════════════════════════
const http = require('http');
const os   = require('os');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DEBUG = false;

const W = 1600, H = 1000;
const TANK_R = 18, TANK_SPEED = 240;
const BULLET_R = 4, MAX_BOUNCES = 3;
const RESPAWN = 2.0;
const MAX_PLAYERS = 10;
const MAX_PICKUPS = 5;
const PICKUP_SPAWN_INTERVAL = 2.5;
const PICKUP_R = 22;
const PICKUP_COLLECT_R = 28;

const WEAPONS = {
  pistol:  { name: 'Пистолет',  dmg: 25, rate: 0.35, speed: 800,  count: 1, spread: 0,    ammo: -1, color: '#ffd24a', br: 3   },
  shotgun: { name: 'Дробовик',  dmg: 14, rate: 0.75, speed: 700,  count: 4, spread: 0.30, ammo: 8,  color: '#ff9a3a', br: 3   },
  smg:     { name: 'Автомат',   dmg: 11, rate: 0.09, speed: 950,  count: 1, spread: 0.07, ammo: 45, color: '#ffea6a', br: 2.5 },
  sniper:  { name: 'Снайперка', dmg: 65, rate: 1.20, speed: 1400, count: 1, spread: 0,    ammo: 5,  color: '#b8a8ff', br: 2.5 },
  rocket:  { name: 'Ракетница', dmg: 25, rate: 1.50, speed: 500,  count: 1, spread: 0,    ammo: 3,  color: '#ff5555', br: 4, explosive: true, expR: 100, expDmg: 45 }
};
const DROP_TYPES = ['shotgun', 'smg', 'sniper', 'rocket'];

const SPAWNS = [
  { x: 180,  y: 550, a: 0 },
  { x: 1420, y: 550, a: Math.PI },
  { x: 800,  y: 100, a: Math.PI / 2 },
  { x: 800,  y: 900, a: -Math.PI / 2 },
  { x: 550,  y: 500, a: 0 },
  { x: 1050, y: 500, a: Math.PI },
  { x: 250,  y: 250, a: Math.PI * 0.75 },
  { x: 1350, y: 250, a: Math.PI * 0.25 },
  { x: 250,  y: 750, a: -Math.PI * 0.75 },
  { x: 1350, y: 750, a: -Math.PI * 0.25 }
];

const WALLS = [
  { x: 720,  y: 400, w: 40,  h: 200 },
  { x: 840,  y: 400, w: 40,  h: 200 },
  { x: 380,  y: 220, w: 180, h: 40  },
  { x: 1040, y: 220, w: 180, h: 40  },
  { x: 380,  y: 740, w: 180, h: 40  },
  { x: 1040, y: 740, w: 180, h: 40  },
  { x: 250,  y: 400, w: 40,  h: 200 },
  { x: 1310, y: 400, w: 40,  h: 200 },
  { x: 100,  y: 100, w: 100, h: 100 },
  { x: 1400, y: 100, w: 100, h: 100 },
  { x: 100,  y: 800, w: 100, h: 100 },
  { x: 1400, y: 800, w: 100, h: 100 }
];

// ───────── HTTP: только / и /?name=... отдаём встроенную HTML ─────────
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/?')) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    return res.end(HTML);
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

// ───────── WEBSOCKET ─────────
const wss = new WebSocketServer({ server });
let nextId = 1, nextPickupId = 1;
const players = [];
const bullets = [];
const pickups = [];
let events = [];
let pickupTimer = 0;

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

function sanitizeName(n) {
  if (typeof n !== 'string') return null;
  n = n.trim().slice(0, 16).replace(/[<>&"'\n\r\t]/g, '');
  return n || null;
}
function freeSlot() {
  for (let s = 0; s < MAX_PLAYERS; s++) if (!players.some(p => p.slot === s)) return s;
  return -1;
}
function hitsWall(x, y, r) {
  for (const w of WALLS) {
    const cx = Math.max(w.x, Math.min(x, w.x + w.w));
    const cy = Math.max(w.y, Math.min(y, w.y + w.h));
    const dx = x - cx, dy = y - cy;
    if (dx * dx + dy * dy < r * r) return true;
  }
  return false;
}

wss.on('connection', (ws, req) => {
  const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
  const slot = freeSlot();
  if (slot < 0) { ws.send(JSON.stringify({ t: 'full' })); ws.close(); return; }

  let urlObj;
  try { urlObj = new URL(req.url, 'http://localhost'); } catch { urlObj = null; }
  const rawName = urlObj ? urlObj.searchParams.get('name') : null;
  const name = sanitizeName(rawName) || ('Игрок ' + (slot + 1));

  const sp = SPAWNS[slot];
  const p = {
    ws, id: nextId++, slot, ip, name,
    x: sp.x, y: sp.y, a: sp.a,
    hp: 100, alive: true, score: 0, respawnT: 0, fireCd: 0,
    weapon: 'pistol', ammo: -1,
    input: { mx: 0, my: 0, s: 0, a: sp.a }
  };
  players.push(p);
  console.log(`+ player ${p.id} "${p.name}"  slot=${slot}  ip=${ip}`);

  ws.send(JSON.stringify({ t: 'w', id: p.id, slot, W, H, walls: WALLS }));

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t !== 'i') return;
    if (m.mx !== undefined || m.my !== undefined) {
      p.input.mx = clamp(Number(m.mx) || 0, -1, 1);
      p.input.my = clamp(Number(m.my) || 0, -1, 1);
    } else {
      p.input.mx = clamp((m.r | 0) - (m.l | 0), -1, 1);
      p.input.my = clamp((m.d | 0) - (m.u | 0), -1, 1);
    }
    p.input.s = m.s | 0;
    p.input.a = Number(m.a) || 0;
  });
  ws.on('close', () => {
    const i = players.indexOf(p);
    if (i >= 0) players.splice(i, 1);
    console.log(`- player ${p.id} "${p.name}"`);
  });
  ws.on('error', () => {});
});

function moveTank(p, dx, dy) {
  const nx = clamp(p.x + dx, TANK_R, W - TANK_R);
  if (!hitsWall(nx, p.y, TANK_R)) p.x = nx;
  const ny = clamp(p.y + dy, TANK_R, H - TANK_R);
  if (!hitsWall(p.x, ny, TANK_R)) p.y = ny;
}

function fire(p) {
  const w = WEAPONS[p.weapon];
  p.fireCd = w.rate;
  const a = p.a;
  for (let i = 0; i < w.count; i++) {
    let ang = a;
    if (w.spread) ang += (Math.random() - 0.5) * w.spread * 2;
    const sx = p.x + Math.cos(ang) * (TANK_R + 12);
    const sy = p.y + Math.sin(ang) * (TANK_R + 12);
    bullets.push({
      x: sx, y: sy,
      vx: Math.cos(ang) * w.speed,
      vy: Math.sin(ang) * w.speed,
      owner: p.id, bounces: 0, age: 0,
      weapon: p.weapon,
      dmg: w.dmg, br: w.br, color: w.color,
      explosive: !!w.explosive
    });
  }
  events.push({ t: 'shoot', x: p.x, y: p.y, a, o: p.id, w: p.weapon });
  if (p.ammo > 0) {
    p.ammo--;
    if (p.ammo === 0) {
      p.weapon = 'pistol';
      p.ammo = -1;
      p.fireCd = Math.max(p.fireCd, 0.3);
    }
  }
}

function damage(p, amount, oid, bx, by) {
  p.hp -= amount;
  events.push({ t: 'hit', x: bx, y: by, o: oid });
  if (p.hp <= 0) {
    p.hp = 0; p.alive = false; p.respawnT = RESPAWN;
    events.push({ t: 'die', x: p.x, y: p.y, o: p.id });
    const killer = players.find(q => q.id === oid);
    if (killer) {
      killer.score++;
      events.push({ t: 'score', x: p.x, y: p.y - 40, o: killer.id });
      events.push({ t: 'kill', kn: killer.name, vn: p.name, ks: killer.slot, vs: p.slot });
    }
  }
}

function explode(x, y, radius, dmg, oid) {
  events.push({ t: 'explode', x, y, r: radius });
  for (const p of players) {
    if (!p.alive || p.id === oid) continue;
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < radius + TANK_R) {
      const falloff = clamp(1 - d / (radius + TANK_R), 0.3, 1);
      damage(p, Math.round(dmg * falloff), oid, p.x, p.y);
    }
  }
}

function stepBullet(b, dt) {
  b.age += dt;
  if (b.age > 5) return false;
  const STEPS = 3, sdt = dt / STEPS;
  for (let s = 0; s < STEPS; s++) {
    const nx = b.x + b.vx * sdt;
    if (nx < b.br || nx > W - b.br || hitsWall(nx, b.y, b.br)) {
      if (b.explosive) { explode(b.x, b.y, WEAPONS[b.weapon].expR, WEAPONS[b.weapon].expDmg, b.owner); return false; }
      b.vx = -b.vx; b.bounces++;
      events.push({ t: 'bounce', x: b.x, y: b.y });
      if (b.bounces > MAX_BOUNCES) return false;
    } else b.x = nx;

    const ny = b.y + b.vy * sdt;
    if (ny < b.br || ny > H - b.br || hitsWall(b.x, ny, b.br)) {
      if (b.explosive) { explode(b.x, b.y, WEAPONS[b.weapon].expR, WEAPONS[b.weapon].expDmg, b.owner); return false; }
      b.vy = -b.vy; b.bounces++;
      events.push({ t: 'bounce', x: b.x, y: b.y });
      if (b.bounces > MAX_BOUNCES) return false;
    } else b.y = ny;

    for (const p of players) {
      if (!p.alive || p.id === b.owner) continue;
      const dx = p.x - b.x, dy = p.y - b.y;
      const rr = TANK_R + b.br;
      if (dx * dx + dy * dy < rr * rr) {
        if (b.explosive) { explode(b.x, b.y, WEAPONS[b.weapon].expR, WEAPONS[b.weapon].expDmg, b.owner); return false; }
        damage(p, b.dmg, b.owner, b.x, b.y);
        return false;
      }
    }
  }
  return true;
}

function trySpawnPickup() {
  if (pickups.length >= MAX_PICKUPS) return;
  const type = DROP_TYPES[Math.floor(Math.random() * DROP_TYPES.length)];
  for (let tries = 0; tries < 60; tries++) {
    const x = 100 + Math.random() * (W - 200);
    const y = 100 + Math.random() * (H - 200);
    if (hitsWall(x, y, PICKUP_R + 15)) continue;
    let ok = true;
    for (const p of players) if (Math.hypot(p.x - x, p.y - y) < 160) { ok = false; break; }
    if (!ok) continue;
    for (const pu of pickups) if (Math.hypot(pu.x - x, pu.y - y) < 120) { ok = false; break; }
    if (!ok) continue;
    pickups.push({ id: nextPickupId++, x, y, type, age: 0 });
    return;
  }
}

function checkPickupCollect() {
  for (let i = pickups.length - 1; i >= 0; i--) {
    const pu = pickups[i];
    for (const p of players) {
      if (!p.alive) continue;
      if (Math.hypot(p.x - pu.x, p.y - pu.y) < TANK_R + PICKUP_COLLECT_R) {
        p.weapon = pu.type;
        p.ammo = WEAPONS[pu.type].ammo;
        p.fireCd = 0.15;
        events.push({ t: 'pickup', x: pu.x, y: pu.y, o: p.id, type: pu.type });
        pickups.splice(i, 1);
        break;
      }
    }
  }
}

function respawn(p) {
  const sp = SPAWNS[p.slot];
  p.x = sp.x; p.y = sp.y; p.a = sp.a;
  p.hp = 100; p.alive = true; p.fireCd = 0;
  p.weapon = 'pistol'; p.ammo = -1;
  events.push({ t: 'spawn', x: p.x, y: p.y, o: p.id });
}

function step(dt) {
  pickupTimer += dt;
  if (pickupTimer >= PICKUP_SPAWN_INTERVAL) { pickupTimer = 0; trySpawnPickup(); }
  for (const pu of pickups) pu.age += dt;

  for (const p of players) {
    if (!p.alive) {
      p.respawnT -= dt;
      if (p.respawnT <= 0) respawn(p);
      continue;
    }
    if (p.fireCd > 0) p.fireCd -= dt;
    let dx = p.input.mx, dy = p.input.my;
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }
    moveTank(p, dx * TANK_SPEED * dt, dy * TANK_SPEED * dt);
    p.a = p.input.a;
    if (p.input.s && p.fireCd <= 0) fire(p);
  }
  checkPickupCollect();
  for (let i = bullets.length - 1; i >= 0; i--) {
    if (!stepBullet(bullets[i], dt)) bullets.splice(i, 1);
  }
}

const r1 = v => Math.round(v * 10) / 10;

function broadcast() {
  if (players.length === 0) { events = []; return; }
  const msg = JSON.stringify({
    t: 'st',
    p: players.map(p => ({
      id: p.id, s: p.slot, n: p.name,
      x: r1(p.x), y: r1(p.y), a: r1(p.a),
      hp: p.hp, al: p.alive, sc: p.score, rs: r1(p.respawnT),
      w: p.weapon, am: p.ammo
    })),
    b: bullets.map(b => ({
      x: r1(b.x), y: r1(b.y), vx: r1(b.vx), vy: r1(b.vy),
      c: b.color, br: b.br, ex: b.explosive ? 1 : 0
    })),
    pu: pickups.map(pu => ({ id: pu.id, x: r1(pu.x), y: r1(pu.y), ty: pu.type })),
    e: events
  });
  events = [];
  for (const p of players) if (p.ws.readyState === 1) p.ws.send(msg);
}

let last = Date.now();
setInterval(() => {
  const now = Date.now();
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.1) dt = 0.1;
  step(dt);
  broadcast();
}, 1000 / 60);

// ═══════════════════════════════════════════════════════════════════
//  ВСТРОЕННЫЙ КЛИЕНТ (HTML)
// ═══════════════════════════════════════════════════════════════════
const HTML = String.raw`<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover" />
<title>Tank Arena 10P</title>
<style>
  :root { --bg: #05080d; }
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:100%; height:100%; overflow:hidden; background:var(--bg); font-family:'Segoe UI',system-ui,-apple-system,sans-serif; color:#e8eefc; user-select:none; -webkit-user-select:none; -webkit-tap-highlight-color:transparent; overscroll-behavior:none; touch-action:none; }
  canvas { display:block; position:absolute; inset:0; touch-action:none; }
  #overlay { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; background:radial-gradient(circle at 50% 45%, rgba(20,32,50,0.92), rgba(3,6,10,0.98)); z-index:10; backdrop-filter:blur(3px); padding:20px; }
  #overlay .panel { text-align:center; padding:20px; max-width:480px; width:100%; }
  #overlay h1 { font-size:38px; letter-spacing:6px; font-weight:800; background:linear-gradient(180deg,#8fc4ff,#3d7fd6); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; margin-bottom:22px; }
  #overlay p { font-size:15px; color:#9fb4d0; line-height:1.6; }
  #overlay .sub { margin-top:10px; font-size:12px; color:#5b7291; }
  #name-form { display:flex; gap:10px; margin-bottom:6px; }
  #name-input { flex:1; min-width:0; padding:13px 16px; border-radius:10px; border:2px solid rgba(120,170,255,0.35); background:rgba(10,20,35,0.7); color:#e8eefc; font-size:16px; font-family:inherit; outline:none; }
  #name-input:focus { border-color:rgba(120,170,255,0.8); }
  #play-btn { padding:13px 22px; border-radius:10px; border:none; background:linear-gradient(180deg,#6ab0ff,#3d7fd6); color:#fff; font-size:14px; font-weight:700; letter-spacing:1.5px; cursor:pointer; font-family:inherit; }
  #play-btn:active { transform:translateY(1px); }
  .spin { display:inline-block; width:14px; height:14px; border:2px solid rgba(120,170,255,0.25); border-top-color:#6aa8ff; border-radius:50%; animation:sp 0.8s linear infinite; vertical-align:-2px; margin-right:8px; }
  @keyframes sp { to { transform:rotate(360deg); } }
</style>
</head>
<body>
<canvas id="game"></canvas>
<div id="overlay">
  <div class="panel">
    <h1>TANK ARENA</h1>
    <div id="name-form">
      <input id="name-input" type="text" placeholder="Твоё имя" maxlength="16" autocomplete="off" />
      <button id="play-btn">В БОЙ</button>
    </div>
    <p id="ov-text" style="display:none"></p>
    <p class="sub" id="ov-sub"></p>
  </div>
</div>
<script>
(() => {
'use strict';
const canvas=document.getElementById('game'),ctx=canvas.getContext('2d');
const overlay=document.getElementById('overlay'),ovText=document.getElementById('ov-text'),ovSub=document.getElementById('ov-sub');
const nameForm=document.getElementById('name-form'),nameInput=document.getElementById('name-input'),playBtn=document.getElementById('play-btn');
const MAX_PLAYERS=10;
const COLORS=['#4ea1ff','#ff7a45','#4ee08a','#d070ff','#ffd84e','#ff44aa','#44ddd8','#dd3333','#99cc44','#b8832a'];
const COLORS_DARK=['#2b6db3','#b84f28','#2a9e5e','#8a3bb3','#b8992b','#b32e75','#2a9e9a','#992222','#669922','#7a5518'];
const WEAPONS={pistol:{name:'Пистолет',color:'#ffd24a',icon:'П'},shotgun:{name:'Дробовик',color:'#ff9a3a',icon:'Д'},smg:{name:'Автомат',color:'#ffea6a',icon:'А'},sniper:{name:'Снайперка',color:'#b8a8ff',icon:'С'},rocket:{name:'Ракетница',color:'#ff5555',icon:'Р'}};
const TANK_R=18,SEND_RATE=1/60;
const isTouch=matchMedia('(pointer: coarse)').matches||'ontouchstart' in window;
let W=1600,H=1000,walls=[],dpr=1,scale=1,ox=0,oy=0;
let ws=null,myId=null,mySlot=0,reconnectTimer=null,welcomeReceived=false,chosenName='';
let players=[],bullets=[],pickups=[],killFeed=[],lastKiller='';
const keys=Object.create(null),mouse={x:0,y:0,down:false};
let aim=0,sendAcc=0;
const joy={active:false,id:null,baseX:0,baseY:0,nx:0,ny:0};
const aimTouch={active:false,id:null,x:0,y:0};
const particles=[],explosions=[],flashes=new Map(),shake={t:0,mag:0},popups=[];
let actx=null;
function audioInit(){if(actx)return;try{actx=new(window.AudioContext||window.webkitAudioContext)();}catch(e){}}
function sfxTone(f,d,ty,v,st){if(!actx||actx.state==='suspended')return;const t=actx.currentTime,o=actx.createOscillator(),g=actx.createGain();o.type=ty||'square';o.frequency.setValueAtTime(f,t);if(st)o.frequency.exponentialRampToValueAtTime(Math.max(1,st),t+d);g.gain.setValueAtTime(v||0.06,t);g.gain.exponentialRampToValueAtTime(0.0001,t+d);o.connect(g);g.connect(actx.destination);o.start(t);o.stop(t+d+0.02);}
function sfxNoise(d,v,cu){if(!actx||actx.state==='suspended')return;const t=actx.currentTime,n=Math.floor(actx.sampleRate*d);if(n<=0)return;const buf=actx.createBuffer(1,n,actx.sampleRate),dd=buf.getChannelData(0);for(let i=0;i<n;i++)dd[i]=(Math.random()*2-1)*(1-i/n);const src=actx.createBufferSource();src.buffer=buf;const f=actx.createBiquadFilter();f.type='lowpass';f.frequency.value=cu||900;const g=actx.createGain();g.gain.setValueAtTime(v||0.14,t);g.gain.exponentialRampToValueAtTime(0.0001,t+d);src.connect(f);f.connect(g);g.connect(actx.destination);src.start(t);}
const sfxShoot=w=>{if(w==='shotgun'){sfxNoise(0.14,0.18,1400);sfxTone(180,0.12,'square',0.08,60);}else if(w==='sniper'){sfxTone(1200,0.10,'sawtooth',0.07,200);sfxNoise(0.12,0.14,1800);}else if(w==='rocket'){sfxTone(180,0.30,'sawtooth',0.10,70);sfxNoise(0.20,0.12,800);}else{sfxTone(420,0.09,'square',0.05,130);sfxNoise(0.07,0.07,2200);}};
const sfxHit=()=>{sfxTone(180,0.10,'sawtooth',0.09,60);sfxNoise(0.10,0.10,1400);};
const sfxExplode=()=>{sfxNoise(0.60,0.30,500);sfxTone(80,0.55,'sine',0.20,22);};
const sfxBounce=()=>sfxTone(900,0.045,'triangle',0.028,1400);
const sfxRespawn=()=>sfxTone(320,0.12,'sine',0.07,620);
const sfxPickup=()=>{sfxTone(660,0.08,'sine',0.08,990);sfxTone(990,0.10,'sine',0.06,1320);};
function rr(c,x,y,w,h,r){if(w<0){x+=w;w=-w;}if(h<0){y+=h;h=-h;}r=Math.min(r,w/2,h/2);c.beginPath();c.moveTo(x+r,y);c.arcTo(x+w,y,x+w,y+h,r);c.arcTo(x+w,y+h,x,y+h,r);c.arcTo(x,y+h,x,y,r);c.arcTo(x,y,x+w,y,r);c.closePath();}
const clamp=(v,a,b)=>v<a?a:v>b?b:v;
function resize(){dpr=Math.min(window.devicePixelRatio||1,2);const cw=window.innerWidth,ch=window.innerHeight;canvas.width=Math.floor(cw*dpr);canvas.height=Math.floor(ch*dpr);canvas.style.width=cw+'px';canvas.style.height=ch+'px';}
window.addEventListener('resize',resize);
window.addEventListener('orientationchange',()=>setTimeout(resize,120));
function computeCamera(){const cw=window.innerWidth,ch=window.innerHeight;const me=players.find(p=>p.id===myId);if(isTouch&&me){const VIEW=900;scale=Math.max(cw,ch)/VIEW;let tx=cw/2-me.x*scale,ty=ch/2-me.y*scale;const wW=W*scale,wH=H*scale;if(wW<=cw)tx=(cw-wW)/2;else tx=Math.min(0,Math.max(cw-wW,tx));if(wH<=ch)ty=(ch-wH)/2;else ty=Math.min(0,Math.max(ch-wH,ty));ox=tx;oy=ty;}else{scale=Math.min(cw/W,ch/H)*0.96;ox=(cw-W*scale)/2;oy=(ch-H*scale)/2;}}
const PREVENT=new Set(['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','KeyW','KeyA','KeyS','KeyD']);
window.addEventListener('keydown',e=>{if(PREVENT.has(e.code))e.preventDefault();keys[e.code]=true;});
window.addEventListener('keyup',e=>{keys[e.code]=false;});
window.addEventListener('blur',()=>{for(const k in keys)keys[k]=false;mouse.down=false;});
canvas.addEventListener('mousemove',e=>{const r=canvas.getBoundingClientRect();mouse.x=e.clientX-r.left;mouse.y=e.clientY-r.top;});
canvas.addEventListener('mousedown',e=>{audioInit();if(actx&&actx.state==='suspended')actx.resume();if(e.button===0)mouse.down=true;});
window.addEventListener('mouseup',e=>{if(e.button===0)mouse.down=false;});
canvas.addEventListener('contextmenu',e=>e.preventDefault());
canvas.addEventListener('touchstart',e=>{audioInit();if(actx&&actx.state==='suspended')actx.resume();for(const t of e.changedTouches){const x=t.clientX,y=t.clientY;if(x<window.innerWidth/2&&!joy.active){joy.active=true;joy.id=t.identifier;joy.baseX=x;joy.baseY=y;joy.nx=0;joy.ny=0;}else if(x>=window.innerWidth/2&&!aimTouch.active){aimTouch.active=true;aimTouch.id=t.identifier;aimTouch.x=x;aimTouch.y=y;}}e.preventDefault();},{passive:false});
canvas.addEventListener('touchmove',e=>{for(const t of e.changedTouches){if(joy.active&&t.identifier===joy.id){const dx=t.clientX-joy.baseX,dy=t.clientY-joy.baseY,d=Math.hypot(dx,dy),maxR=60,cl=Math.min(d,maxR);if(d>0.001){joy.nx=(dx/d)*(cl/maxR);joy.ny=(dy/d)*(cl/maxR);}}else if(aimTouch.active&&t.identifier===aimTouch.id){aimTouch.x=t.clientX;aimTouch.y=t.clientY;}}e.preventDefault();},{passive:false});
const endTouch=e=>{for(const t of e.changedTouches){if(joy.active&&t.identifier===joy.id){joy.active=false;joy.nx=0;joy.ny=0;}if(aimTouch.active&&t.identifier===aimTouch.id)aimTouch.active=false;}e.preventDefault();};
canvas.addEventListener('touchend',endTouch,{passive:false});
canvas.addEventListener('touchcancel',endTouch,{passive:false});
function showOverlay(html,sub){overlay.style.display='flex';nameForm.style.display='none';ovText.style.display='block';ovText.innerHTML=html;ovSub.textContent=sub||'';}
function hideOverlay(){overlay.style.display='none';}
const savedName=localStorage.getItem('tankName');
if(savedName)nameInput.value=savedName;
const urlName=new URLSearchParams(location.search).get('name');
if(urlName)nameInput.value=urlName.slice(0,16);
nameInput.addEventListener('keydown',e=>{if(e.key==='Enter')playBtn.click();});
playBtn.addEventListener('click',()=>{audioInit();if(actx&&actx.state==='suspended')actx.resume();chosenName=(nameInput.value||'').trim().slice(0,16)||'Игрок';localStorage.setItem('tankName',chosenName);nameForm.style.display='none';ovText.style.display='block';ovText.innerHTML='<span class="spin"></span>Подключение к серверу…';connect();});
function connect(){if(ws&&(ws.readyState===WebSocket.OPEN||ws.readyState===WebSocket.CONNECTING))return;const proto=location.protocol==='https:'?'wss:':'ws:';const host=location.host||'localhost:3000';const url=proto+'//'+host+'?name='+encodeURIComponent(chosenName||'');showOverlay('<span class="spin"></span>Подключение к серверу…',host);try{ws=new WebSocket(url);}catch(e){scheduleReconnect();return;}ws.onmessage=ev=>{let m;try{m=JSON.parse(ev.data);}catch(e){return;}handleMessage(m);};ws.onclose=()=>{welcomeReceived=false;players=[];bullets=[];pickups=[];killFeed=[];flashes.clear();if(!reconnectTimer)showOverlay('<span class="spin"></span>Соединение потеряно…','Переподключение');scheduleReconnect();};ws.onerror=()=>{};}
function scheduleReconnect(){if(reconnectTimer)return;reconnectTimer=setTimeout(()=>{reconnectTimer=null;connect();},1500);}
function handleMessage(m){if(m.t==='w')onWelcome(m);else if(m.t==='st')onState(m);else if(m.t==='full'){showOverlay('СЕРВЕР ЗАНЯТ','Все 10 мест заняты. Попробуйте позже.');if(ws)ws.close();}}
function onWelcome(m){myId=m.id;mySlot=m.slot;W=m.W;H=m.H;walls=m.walls;welcomeReceived=true;resize();hideOverlay();}
function onState(m){players=m.p||[];bullets=m.b||[];pickups=m.pu||[];if(m.e&&m.e.length)for(const e of m.e)handleEvent(e);}
function handleEvent(e){switch(e.t){
  case 'shoot':flashes.set(e.o,0.085);spawnBurst(e.x+Math.cos(e.a)*30,e.y+Math.sin(e.a)*30,'#ffd24a',6,200,0.18,3,e.a,0.6);addShake(1.4);sfxShoot(e.w);break;
  case 'hit':spawnBurst(e.x,e.y,'#ffb340',10,240,0.28,3);spawnBurst(e.x,e.y,'#ffffff',4,130,0.16,2);addShake(2.8);sfxHit();break;
  case 'die':spawnBurst(e.x,e.y,'#ff7a45',34,380,0.75,5.5);spawnBurst(e.x,e.y,'#ffe08a',22,240,0.55,4);spawnBurst(e.x,e.y,'#ffffff',14,180,0.35,2.6);addShake(11);sfxExplode();break;
  case 'spawn':spawnBurst(e.x,e.y,'#8fd0ff',16,170,0.5,3);sfxRespawn();break;
  case 'bounce':spawnBurst(e.x,e.y,'#9fd0ff',3,120,0.20,2);sfxBounce();break;
  case 'score':popups.push({x:e.x,y:e.y,life:1.2,text:'+1',color:'#ffe08a'});break;
  case 'kill':killFeed.unshift({kn:e.kn,vn:e.vn,ks:e.ks,vs:e.vs,life:5});if(killFeed.length>5)killFeed.pop();if(e.vs===mySlot)lastKiller=e.kn;break;
  case 'explode':explosions.push({x:e.x,y:e.y,r:e.r,life:0.55,maxLife:0.55});spawnBurst(e.x,e.y,'#ff7028',40,480,0.70,6);spawnBurst(e.x,e.y,'#ffd24a',24,300,0.55,4.5);spawnBurst(e.x,e.y,'#3a4457',18,200,0.80,5.5);addShake(16);sfxExplode();break;
  case 'pickup':spawnBurst(e.x,e.y,WEAPONS[e.type]?.color||'#fff',20,240,0.45,3.5);spawnBurst(e.x,e.y,'#ffffff',8,150,0.25,2.2);if(e.o===myId)sfxPickup();break;
}}
function spawnBurst(x,y,color,n,speed,life,size,dir,spread){for(let i=0;i<n;i++){let a;if(dir!==undefined)a=dir+(Math.random()-0.5)*(spread||0.8);else a=Math.random()*Math.PI*2;const s=speed*(0.35+Math.random()*0.95),lf=life*(0.55+Math.random()*0.7);particles.push({x,y,vx:Math.cos(a)*s,vy:Math.sin(a)*s,life:lf,maxLife:lf,color,size:size*(0.55+Math.random()*0.85),drag:5+Math.random()*5});}}
function addShake(mag){shake.mag=Math.max(shake.mag,mag);shake.t=Math.max(shake.t,0.22);}
function updateAim(dt){const me=players.find(p=>p.id===myId);if(!me)return;if(isTouch){let target=null;if(aimTouch.active){const wx=(aimTouch.x-ox)/scale,wy=(aimTouch.y-oy)/scale;target=Math.atan2(wy-me.y,wx-me.x);}else if(joy.active&&(Math.abs(joy.nx)>0.15||Math.abs(joy.ny)>0.15))target=Math.atan2(joy.ny,joy.nx);if(target!==null){let diff=target-aim;while(diff>Math.PI)diff-=2*Math.PI;while(diff<-Math.PI)diff+=2*Math.PI;aim+=diff*Math.min(1,dt*18);}}else{const wx=(mouse.x-ox)/scale,wy=(mouse.y-oy)/scale;aim=Math.atan2(wy-me.y,wx-me.x);}}
function updateParticles(dt){for(let i=particles.length-1;i>=0;i--){const p=particles[i];p.life-=dt;if(p.life<=0){particles.splice(i,1);continue;}p.x+=p.vx*dt;p.y+=p.vy*dt;const d=Math.exp(-p.drag*dt);p.vx*=d;p.vy*=d;}}
function updateExplosions(dt){for(let i=explosions.length-1;i>=0;i--){explosions[i].life-=dt;if(explosions[i].life<=0)explosions.splice(i,1);}}
function updateFlashes(dt){for(const[id,t]of flashes){const nt=t-dt;if(nt<=0)flashes.delete(id);else flashes.set(id,nt);}}
function updatePopups(dt){for(let i=popups.length-1;i>=0;i--){popups[i].life-=dt;popups[i].y-=40*dt;if(popups[i].life<=0)popups.splice(i,1);}}
function updateKillFeed(dt){for(let i=killFeed.length-1;i>=0;i--){killFeed[i].life-=dt;if(killFeed[i].life<=0)killFeed.splice(i,1);}}
function updateShake(dt){if(shake.t>0){shake.t-=dt;if(shake.t<=0){shake.t=0;shake.mag=0;}else shake.mag*=Math.exp(-6*dt);}}
function updateInput(dt){if(!welcomeReceived)return;sendAcc+=dt;if(sendAcc<SEND_RATE)return;sendAcc=0;if(!ws||ws.readyState!==WebSocket.OPEN)return;let mx=0,my=0,shoot=0;if(isTouch){if(joy.active){mx=joy.nx;my=joy.ny;}if(aimTouch.active)shoot=1;}else{mx=(keys.KeyD||keys.ArrowRight?1:0)-(keys.KeyA||keys.ArrowLeft?1:0);my=(keys.KeyS||keys.ArrowDown?1:0)-(keys.KeyW||keys.ArrowUp?1:0);shoot=(mouse.down||keys.Space)?1:0;}ws.send(JSON.stringify({t:'i',mx:Math.round(mx*100)/100,my:Math.round(my*100)/100,s:shoot,a:Math.round(aim*1000)/1000}));}
function drawArena(){const g=ctx.createRadialGradient(W/2,H/2,60,W/2,H/2,Math.max(W,H)*0.72);g.addColorStop(0,'#131b29');g.addColorStop(1,'#070a10');ctx.fillStyle=g;ctx.fillRect(0,0,W,H);ctx.strokeStyle='rgba(90,140,210,0.055)';ctx.lineWidth=1;ctx.beginPath();for(let x=0;x<=W;x+=70){ctx.moveTo(x+0.5,0);ctx.lineTo(x+0.5,H);}for(let y=0;y<=H;y+=70){ctx.moveTo(0,y+0.5);ctx.lineTo(W,y+0.5);}ctx.stroke();ctx.strokeStyle='rgba(90,140,210,0.10)';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(W/2,0);ctx.lineTo(W/2,H);ctx.moveTo(0,H/2);ctx.lineTo(W,H/2);ctx.stroke();ctx.strokeStyle='rgba(80,140,220,0.25)';ctx.lineWidth=2;ctx.strokeRect(1,1,W-2,H-2);}
function drawWalls(){for(const w of walls){ctx.fillStyle='rgba(0,0,0,0.45)';ctx.fillRect(w.x+4,w.y+5,w.w,w.h);const g=ctx.createLinearGradient(w.x,w.y,w.x,w.y+w.h);g.addColorStop(0,'#26314a');g.addColorStop(1,'#161d2b');ctx.fillStyle=g;ctx.fillRect(w.x,w.y,w.w,w.h);ctx.fillStyle='rgba(130,175,240,0.22)';ctx.fillRect(w.x,w.y,w.w,3);ctx.strokeStyle='rgba(85,125,190,0.55)';ctx.lineWidth=2;ctx.strokeRect(w.x+1,w.y+1,w.w-2,w.h-2);}}
function drawPickups(){const t=performance.now()/1000;for(const pu of pickups){const w=WEAPONS[pu.ty];if(!w)continue;const bob=Math.sin(t*2.6+pu.id)*4,pulse=0.7+0.3*Math.sin(t*4+pu.id);ctx.save();ctx.translate(pu.x,pu.y+bob);ctx.globalCompositeOperation='lighter';const g=ctx.createRadialGradient(0,0,0,0,0,46);g.addColorStop(0,w.color+'aa');g.addColorStop(0.5,w.color+'44');g.addColorStop(1,w.color+'00');ctx.fillStyle=g;ctx.beginPath();ctx.arc(0,0,46,0,Math.PI*2);ctx.fill();ctx.globalCompositeOperation='source-over';const bg=ctx.createLinearGradient(0,-18,0,18);bg.addColorStop(0,'#1e2838');bg.addColorStop(1,'#0f151f');ctx.fillStyle=bg;rr(ctx,-18,-18,36,36,8);ctx.fill();ctx.strokeStyle=w.color;ctx.lineWidth=2.5*pulse;ctx.stroke();ctx.strokeStyle=w.color;ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(-18,-8);ctx.lineTo(-18,-18);ctx.lineTo(-8,-18);ctx.moveTo(18,-8);ctx.lineTo(18,-18);ctx.lineTo(8,-18);ctx.moveTo(-18,8);ctx.lineTo(-18,18);ctx.lineTo(-8,18);ctx.moveTo(18,8);ctx.lineTo(18,18);ctx.lineTo(8,18);ctx.stroke();ctx.fillStyle=w.color;ctx.font='bold 20px system-ui, sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(w.icon,0,1);ctx.restore();}}
function drawBullets(){ctx.globalCompositeOperation='lighter';for(const b of bullets){const color=b.c||'#ffd24a',br=b.br||3,tl=0.03;ctx.strokeStyle=color+'66';ctx.lineWidth=br*1.6;ctx.lineCap='round';ctx.beginPath();ctx.moveTo(b.x,b.y);ctx.lineTo(b.x-b.vx*tl,b.y-b.vy*tl);ctx.stroke();const g=ctx.createRadialGradient(b.x,b.y,0,b.x,b.y,br*4.5);g.addColorStop(0,color);g.addColorStop(0.5,color+'66');g.addColorStop(1,color+'00');ctx.fillStyle=g;ctx.beginPath();ctx.arc(b.x,b.y,br*4.5,0,Math.PI*2);ctx.fill();ctx.fillStyle='#fffbea';ctx.beginPath();ctx.arc(b.x,b.y,br*0.9,0,Math.PI*2);ctx.fill();}ctx.globalCompositeOperation='source-over';}
function drawTanks(){for(const p of players)if(p.al)drawTank(p);else drawWreck(p);}
function drawTank(p){const col=COLORS[p.s]||COLORS[0],dark=COLORS_DARK[p.s]||COLORS_DARK[0],weapon=WEAPONS[p.w]||WEAPONS.pistol;ctx.save();ctx.translate(p.x,p.y);ctx.fillStyle='rgba(0,0,0,0.55)';ctx.beginPath();ctx.ellipse(3,5,23,20,0,0,Math.PI*2);ctx.fill();ctx.save();ctx.rotate(p.a);ctx.fillStyle='#141a26';rr(ctx,-22,-22,44,9,4);ctx.fill();rr(ctx,-22,13,44,9,4);ctx.fill();ctx.fillStyle='#0c1119';for(let tx=-19;tx<20;tx+=7){ctx.fillRect(tx,-22,3,9);ctx.fillRect(tx,13,3,9);}const bg=ctx.createLinearGradient(0,-14,0,14);bg.addColorStop(0,col);bg.addColorStop(1,dark);ctx.fillStyle=bg;rr(ctx,-17,-14,34,28,7);ctx.fill();ctx.strokeStyle='rgba(255,255,255,0.22)';ctx.lineWidth=1.5;ctx.stroke();ctx.fillStyle='rgba(255,255,255,0.10)';rr(ctx,-14,-11,28,8,4);ctx.fill();ctx.fillStyle='#232c3c';if(p.w==='shotgun'){rr(ctx,4,-7,24,14,3);ctx.fill();ctx.fillStyle='#3b4a61';rr(ctx,26,-8,6,16,2);ctx.fill();}else if(p.w==='sniper'){rr(ctx,4,-3,34,6,2);ctx.fill();ctx.fillStyle='#3b4a61';rr(ctx,36,-4,5,8,1);ctx.fill();}else if(p.w==='rocket'){rr(ctx,4,-8,22,16,5);ctx.fill();ctx.fillStyle='#3b4a61';rr(ctx,24,-7,10,14,4);ctx.fill();ctx.fillStyle='#ff5555';rr(ctx,32,-5,4,10,2);ctx.fill();}else if(p.w==='smg'){rr(ctx,4,-5,26,10,2);ctx.fill();ctx.fillStyle='#3b4a61';rr(ctx,28,-4,5,8,1);ctx.fill();}else{rr(ctx,4,-4.5,27,9,3);ctx.fill();ctx.fillStyle='#3b4a61';rr(ctx,25,-5.5,7,11,2);ctx.fill();}const tg=ctx.createRadialGradient(-3,-4,1,0,0,13);tg.addColorStop(0,'rgba(255,255,255,0.55)');tg.addColorStop(0.5,col);tg.addColorStop(1,dark);ctx.fillStyle=tg;ctx.beginPath();ctx.arc(0,0,11,0,Math.PI*2);ctx.fill();ctx.strokeStyle='rgba(255,255,255,0.28)';ctx.lineWidth=1.5;ctx.stroke();const fl=flashes.get(p.id);if(fl&&fl>0){const k=clamp(fl/0.085,0,1);ctx.globalCompositeOperation='lighter';const mg=ctx.createRadialGradient(34,0,0,34,0,30*k);mg.addColorStop(0,weapon.color+'ee');mg.addColorStop(0.4,weapon.color+'88');mg.addColorStop(1,weapon.color+'00');ctx.fillStyle=mg;ctx.beginPath();ctx.arc(34,0,30*k,0,Math.PI*2);ctx.fill();ctx.globalCompositeOperation='source-over';}ctx.restore();const hpFrac=clamp(p.hp/100,0,1),bw=48,bh=6;ctx.fillStyle='rgba(0,0,0,0.65)';rr(ctx,-bw/2-1,-40,bw+2,bh+2,4);ctx.fill();if(hpFrac>0){let hc='#3ddc84';if(hpFrac<=0.6)hc='#ffcc33';if(hpFrac<=0.3)hc='#ff5252';ctx.fillStyle=hc;rr(ctx,-bw/2,-39,bw*hpFrac,bh,3);ctx.fill();}ctx.font='bold 11px system-ui, sans-serif';ctx.textAlign='center';ctx.textBaseline='bottom';ctx.lineWidth=3;ctx.strokeStyle='rgba(0,0,0,0.8)';ctx.strokeText(p.n||('Игрок '+(p.s+1)),0,-46);ctx.fillStyle=col;ctx.fillText(p.n||('Игрок '+(p.s+1)),0,-46);if(p.id===myId){ctx.strokeStyle='rgba(255,255,255,0.45)';ctx.lineWidth=2;ctx.setLineDash([5,5]);ctx.beginPath();ctx.arc(0,0,31,0,Math.PI*2);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle='rgba(255,255,255,0.75)';ctx.beginPath();ctx.moveTo(0,-58);ctx.lineTo(-6,-66);ctx.lineTo(6,-66);ctx.closePath();ctx.fill();}ctx.restore();}
function drawWreck(p){ctx.save();ctx.translate(p.x,p.y);ctx.fillStyle='rgba(0,0,0,0.5)';ctx.beginPath();ctx.ellipse(0,0,24,22,0,0,Math.PI*2);ctx.fill();ctx.globalAlpha=0.55;ctx.rotate(p.a);ctx.fillStyle='#20283a';rr(ctx,-18,-15,36,30,6);ctx.fill();ctx.fillStyle='#2b3448';ctx.beginPath();ctx.arc(0,0,10,0,Math.PI*2);ctx.fill();ctx.globalAlpha=1;ctx.restore();}
function drawExplosions(){ctx.globalCompositeOperation='lighter';for(const ex of explosions){const k=1-ex.life/ex.maxLife,r=ex.r*(0.4+k*0.9),a=1-k;const g=ctx.createRadialGradient(ex.x,ex.y,0,ex.x,ex.y,r);g.addColorStop(0,'rgba(255,220,120,'+(a*0.9)+')');g.addColorStop(0.5,'rgba(255,110,40,'+(a*0.6)+')');g.addColorStop(1,'rgba(255,40,0,0)');ctx.fillStyle=g;ctx.beginPath();ctx.arc(ex.x,ex.y,r,0,Math.PI*2);ctx.fill();ctx.strokeStyle='rgba(255,220,150,'+a+')';ctx.lineWidth=4*a+1;ctx.beginPath();ctx.arc(ex.x,ex.y,ex.r*(0.3+k*1.1),0,Math.PI*2);ctx.stroke();}ctx.globalCompositeOperation='source-over';}
function drawParticles(){ctx.globalCompositeOperation='lighter';for(const p of particles){const a=clamp(p.life/p.maxLife,0,1);ctx.globalAlpha=a*a;ctx.fillStyle=p.color;ctx.beginPath();ctx.arc(p.x,p.y,p.size*(0.35+a*0.75),0,Math.PI*2);ctx.fill();}ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';}
function drawPopups(){ctx.textAlign='center';ctx.textBaseline='middle';for(const p of popups){ctx.globalAlpha=clamp(p.life/1.2,0,1);ctx.font='bold 30px system-ui, sans-serif';ctx.fillStyle=p.color;ctx.fillText(p.text,p.x,p.y);}ctx.globalAlpha=1;}
function drawCrosshair(){if(isTouch)return;const me=players.find(p=>p.id===myId);if(!me||!me.al)return;const wx=(mouse.x-ox)/scale,wy=(mouse.y-oy)/scale;ctx.save();ctx.globalAlpha=0.16;ctx.strokeStyle=COLORS[mySlot]||'#fff';ctx.lineWidth=1.5;ctx.setLineDash([8,10]);ctx.beginPath();ctx.moveTo(me.x,me.y);ctx.lineTo(wx,wy);ctx.stroke();ctx.setLineDash([]);ctx.restore();ctx.save();ctx.translate(wx,wy);ctx.strokeStyle='rgba(255,255,255,0.85)';ctx.lineWidth=2;ctx.beginPath();ctx.arc(0,0,10,0,Math.PI*2);ctx.stroke();ctx.beginPath();ctx.moveTo(-16,0);ctx.lineTo(-6,0);ctx.moveTo(6,0);ctx.lineTo(16,0);ctx.moveTo(0,-16);ctx.lineTo(0,-6);ctx.moveTo(0,6);ctx.lineTo(0,16);ctx.stroke();ctx.fillStyle='rgba(255,90,90,0.9)';ctx.beginPath();ctx.arc(0,0,2,0,Math.PI*2);ctx.fill();ctx.restore();}
function drawCard(x,y,w,h,slot,p,isMine,small){ctx.save();rr(ctx,x,y,w,h,small?6:10);ctx.fillStyle=isMine?'rgba(18,28,44,0.92)':'rgba(10,15,24,0.78)';ctx.fill();ctx.strokeStyle=p?COLORS[slot]+'99':'rgba(85,105,135,0.30)';ctx.lineWidth=isMine?2.5:(small?1.2:1.5);ctx.stroke();const pad=small?4:8,fs1=small?8.5:11,fs2=small?12:16;let name=!p?'—':(p.n||('Игрок '+(slot+1)));const maxChars=small?Math.max(3,Math.floor((w-22)/5.2)):Math.max(4,Math.floor((w-30)/7));if(name.length>maxChars)name=name.slice(0,maxChars-1)+'…';ctx.textAlign='left';ctx.textBaseline='top';ctx.font='bold '+fs1+'px system-ui, sans-serif';ctx.fillStyle=p?COLORS[slot]:'#5b6b80';ctx.fillText(name,x+pad,y+pad);if(p){ctx.textAlign='right';ctx.font='bold '+fs2+'px system-ui, sans-serif';ctx.fillStyle='#dbe7f8';ctx.fillText(String(p.sc),x+w-pad,y+pad-1);}const bx=x+pad,by=y+h-(small?8:12),bw=w-pad*2,bh=small?3.5:6;rr(ctx,bx,by,bw,bh,bh/2);ctx.fillStyle='rgba(255,255,255,0.08)';ctx.fill();if(p){const f=clamp(p.hp/100,0,1);if(f>0){rr(ctx,bx,by,Math.max(bh,bw*f),bh,bh/2);ctx.fillStyle=p.al?COLORS[slot]:'#3a4457';ctx.fill();}}ctx.restore();}
function drawWeaponHUD(cx,y,small){const me=players.find(p=>p.id===myId);if(!me||!me.al)return;const w=WEAPONS[me.w]||WEAPONS.pistol,pw=small?130:200,ph=small?24:32,x=cx-pw/2;ctx.save();rr(ctx,x,y,pw,ph,ph/2);ctx.fillStyle='rgba(10,15,24,0.9)';ctx.fill();ctx.strokeStyle=w.color+'cc';ctx.lineWidth=2;ctx.stroke();ctx.textBaseline='middle';ctx.font='bold '+(small?11:14)+'px system-ui, sans-serif';ctx.textAlign='left';ctx.fillStyle=w.color;ctx.fillText(w.name,x+(small?10:14),y+ph/2);ctx.textAlign='right';ctx.font='bold '+(small?13:17)+'px system-ui, sans-serif';ctx.fillStyle='#e8eefc';ctx.fillText(me.am===-1?'∞':String(me.am),x+pw-(small?10:14),y+ph/2);ctx.restore();}
function drawKillFeed(cx,y,small){if(killFeed.length===0)return;const fs=small?10:12,entryH=small?18:22,max=small?3:5;ctx.save();ctx.textBaseline='middle';ctx.font='bold '+fs+'px system-ui, sans-serif';for(let i=0;i<Math.min(killFeed.length,max);i++){const kf=killFeed[i],a=clamp(kf.life/1.5,0,1);const parts=[{text:kf.kn||'?',color:COLORS[kf.ks]||'#fff'},{text:' убил ',color:'#8899aa'},{text:kf.vn||'?',color:COLORS[kf.vs]||'#fff'}];let tw=0;for(const p of parts)tw+=ctx.measureText(p.text).width;const bgW=tw+16,bgX=cx-bgW/2,bgY=y+i*entryH;ctx.globalAlpha=a;rr(ctx,bgX,bgY-(small?8:10),bgW,small?17:21,8);ctx.fillStyle='rgba(10,15,24,0.88)';ctx.fill();ctx.strokeStyle=(COLORS[kf.ks]||'#fff')+'aa';ctx.lineWidth=1.5;ctx.stroke();let tx=bgX+8;ctx.textAlign='left';for(const p of parts){ctx.fillStyle=p.color;ctx.fillText(p.text,tx,bgY);tx+=ctx.measureText(p.text).width;}}ctx.globalAlpha=1;ctx.restore();}
function drawHUD(){const cw=window.innerWidth,verySmall=cw<600,small=cw<900;const cols=5,rows=2,gap=verySmall?3:(small?5:8),padX=verySmall?6:(small?10:14);const bw=clamp((cw-padX*2-gap*(cols-1))/cols,55,200),bh=verySmall?30:(small?36:44),rowGap=verySmall?3:(small?4:6);const totalW=bw*cols+gap*(cols-1),x0=(cw-totalW)/2,y0=verySmall?5:(small?8:12);for(let s=0;s<MAX_PLAYERS;s++){const col=s%cols,row=Math.floor(s/cols),x=x0+col*(bw+gap),y=y0+row*(bh+rowGap),p=players.find(pl=>pl.s===s);drawCard(x,y,bw,bh,s,p,mySlot===s,verySmall||small);}const hudBottom=y0+rows*bh+(rows-1)*rowGap,weaponY=hudBottom+(verySmall?4:6),weaponH=verySmall?22:(small?26:32);drawWeaponHUD(cw/2,weaponY,verySmall||small);const killFeedY=weaponY+weaponH+(verySmall?8:12);drawKillFeed(cw/2,killFeedY,verySmall||small);const me=players.find(p=>p.id===myId);if(me&&!me.al){const ch2=window.innerHeight;ctx.save();ctx.textAlign='center';ctx.textBaseline='middle';ctx.font='bold '+(verySmall?16:20)+'px system-ui, sans-serif';ctx.fillStyle='rgba(255,120,90,0.9)';ctx.fillText('УНИЧТОЖЕН',cw/2,ch2/2-(verySmall?60:74));if(lastKiller){ctx.font='bold '+(verySmall?12:15)+'px system-ui, sans-serif';ctx.fillStyle='#ffcc88';ctx.fillText('от '+lastKiller,cw/2,ch2/2-(verySmall?42:52));}ctx.font='bold '+(verySmall?60:84)+'px system-ui, sans-serif';ctx.fillStyle='rgba(255,255,255,0.92)';ctx.fillText(Math.ceil(me.rs),cw/2,ch2/2+20);const frac=clamp(me.rs/2,0,1);ctx.strokeStyle='rgba(255,255,255,0.85)';ctx.lineWidth=5;ctx.lineCap='round';ctx.beginPath();ctx.arc(cw/2,ch2/2+20,verySmall?54:72,-Math.PI/2,-Math.PI/2+Math.PI*2*frac);ctx.stroke();ctx.restore();}}
function drawTouchControls(){const cw=window.innerWidth,ch=window.innerHeight;if(joy.active){ctx.save();ctx.globalAlpha=0.30;ctx.strokeStyle='#fff';ctx.lineWidth=3;ctx.beginPath();ctx.arc(joy.baseX,joy.baseY,65,0,Math.PI*2);ctx.stroke();ctx.globalAlpha=0.55;ctx.fillStyle=COLORS[mySlot]||'#fff';ctx.beginPath();ctx.arc(joy.baseX+joy.nx*65,joy.baseY+joy.ny*65,26,0,Math.PI*2);ctx.fill();ctx.restore();}else{ctx.save();ctx.globalAlpha=0.10;ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.setLineDash([6,6]);ctx.beginPath();ctx.arc(110,ch-110,55,0,Math.PI*2);ctx.stroke();ctx.setLineDash([]);ctx.beginPath();ctx.arc(110,ch-110,20,0,Math.PI*2);ctx.stroke();ctx.globalAlpha=0.22;ctx.fillStyle='#fff';ctx.font='bold 11px system-ui, sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('ДВИЖЕНИЕ',110,ch-22);ctx.restore();}if(aimTouch.active){ctx.save();ctx.globalAlpha=0.6;ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.beginPath();ctx.arc(aimTouch.x,aimTouch.y,30,0,Math.PI*2);ctx.stroke();ctx.beginPath();ctx.moveTo(aimTouch.x-15,aimTouch.y);ctx.lineTo(aimTouch.x+15,aimTouch.y);ctx.moveTo(aimTouch.x,aimTouch.y-15);ctx.lineTo(aimTouch.x,aimTouch.y+15);ctx.stroke();ctx.restore();}else{ctx.save();ctx.globalAlpha=0.10;ctx.strokeStyle='#ff7a45';ctx.lineWidth=2;ctx.setLineDash([6,6]);ctx.beginPath();ctx.arc(cw-110,ch-110,55,0,Math.PI*2);ctx.stroke();ctx.setLineDash([]);ctx.beginPath();ctx.moveTo(cw-130,ch-110);ctx.lineTo(cw-90,ch-110);ctx.moveTo(cw-110,ch-130);ctx.lineTo(cw-110,ch-90);ctx.stroke();ctx.globalAlpha=0.22;ctx.fillStyle='#ff7a45';ctx.font='bold 11px system-ui, sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('ПРИЦЕЛ',cw-110,ch-22);ctx.restore();}}
function render(){const cw=window.innerWidth,ch=window.innerHeight;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.fillStyle='#05080d';ctx.fillRect(0,0,cw,ch);if(!welcomeReceived)return;let sx=0,sy=0;if(shake.t>0){sx=(Math.random()-0.5)*shake.mag*2;sy=(Math.random()-0.5)*shake.mag*2;}ctx.save();ctx.translate(ox+sx,oy+sy);ctx.scale(scale,scale);drawArena();drawWalls();drawPickups();drawBullets();drawTanks();drawExplosions();drawParticles();drawPopups();drawCrosshair();ctx.restore();if(isTouch)drawTouchControls();drawHUD();}
let lastT=performance.now();
function loop(t){let dt=(t-lastT)/1000;lastT=t;if(dt>0.06)dt=0.06;if(dt<0)dt=0;computeCamera();updateAim(dt);updateInput(dt);updateParticles(dt);updateExplosions(dt);updateFlashes(dt);updatePopups(dt);updateKillFeed(dt);updateShake(dt);render();requestAnimationFrame(loop);}
resize();requestAnimationFrame(loop);
setInterval(()=>{if(chosenName&&(!ws||ws.readyState===WebSocket.CLOSED))connect();},3000);
})();
</script>
</body>
</html>`;

// ───────── СТАРТ ─────────
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  ═══ TANK ARENA 10P (fix.js) ═══\n');
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) {
        console.log(`  LAN:   http://${n.address}:${PORT}`);
      }
    }
  }
  console.log(`  Local: http://localhost:${PORT}\n`);
});
