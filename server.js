const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { WebSocketServer } = require('ws');

const PORT = 3000;
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
  pistol:  { name: 'Пистолет',   dmg: 25, rate: 0.35, speed: 800,  count: 1, spread: 0,    ammo: -1, color: '#ffd24a', br: 3   },
  shotgun: { name: 'Дробовик',   dmg: 14, rate: 0.75, speed: 700,  count: 4, spread: 0.30, ammo: 8,  color: '#ff9a3a', br: 3   },
  smg:     { name: 'Автомат',    dmg: 11, rate: 0.09, speed: 950,  count: 1, spread: 0.07, ammo: 45, color: '#ffea6a', br: 2.5 },
  sniper:  { name: 'Снайперка',  dmg: 65, rate: 1.20, speed: 1400, count: 1, spread: 0,    ammo: 5,  color: '#b8a8ff', br: 2.5 },
  rocket:  { name: 'Ракетница',  dmg: 25, rate: 1.50, speed: 500,  count: 1, spread: 0,    ammo: 3,  color: '#ff5555', br: 4, explosive: true, expR: 100, expDmg: 45 }
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

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.png':  'image/png',
  '.ico':  'image/x-icon'
};

const server = http.createServer((req, res) => {
  let url = req.url.split('?')[0];
  if (url === '/') url = '/index.html';
  const file = path.join(__dirname, url);
  if (!file.startsWith(__dirname)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('Not found: ' + url);
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.end(data);
  });
});

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
  n = n.trim().slice(0, 16);
  n = n.replace(/[<>&"'\n\r\t]/g, '');
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

  ws.on('message', (raw) => {
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
      events.push({
        t: 'kill',
        kn: killer.name, vn: p.name,
        ks: killer.slot, vs: p.slot
      });
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
        const w = WEAPONS[pu.type];
        p.weapon = pu.type;
        p.ammo = w.ammo;
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

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  ═══ TANK ARENA 10P ═══\n');
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