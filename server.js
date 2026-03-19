// ─────────────────────────────────────────────────────────────
//  SQUISH — installation server
//  Express + WebSocket + Ollama (llama3.2)
//
//  Ollama role: ZONE CLASSIFIER (not a narrator)
//    Every 5s when hands are active, the server reads the raw
//    physics state and asks llama3.2 to classify which of the
//    four psychogeographic zones the field is currently in:
//
//    stillness   low velocity, low density, patient presence
//    surge       high velocity, scattered, released tension
//    convergence two hands close together, shared gravity
//    void        no hands in frame, field acting alone
//
//    The zone name + a 2-word description is broadcast to the
//    display, which shifts its colour palette and adjusts
//    force multipliers to match the zone's rules.
// ─────────────────────────────────────────────────────────────

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const fetch     = require('node-fetch');
const path      = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const PORT   = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Connected clients ─────────────────────────────────────────
let displayClient  = null;
let controlClients = new Set();

// ── Live field state (sent by display every 500ms) ────────────
let fieldState = {
  hands:       0,
  gestures:    [],
  score:       0,
  best:        0,
  avgSpeed:    0,
  palmDist:    0,    // px distance between two palms (0 if solo)
  density:     0,    // 0-1 fraction of particles near any hand
  lastActive:  0
};

// ── Current physics params ────────────────────────────────────
let params = {
  count:    350,
  gravity:  0.02,
  friction: 0.993,
  radius:   110,
  attract:  3.5,
  repel:    7.0,
  size:     4,
  trail:    true
};

// ── Zone definitions ──────────────────────────────────────────
// These are the four psychogeographic zones.
// palette: hue values for the display to use for particles + hand skeletons
// forceMultiplier: applied server-side as a hint; display enforces locally too
const ZONES = {
  stillness:   { label: 'Stillness',   palette: 'blue',   description: 'low velocity, patient presence' },
  surge:       { label: 'Surge',       palette: 'red',    description: 'high velocity, released tension' },
  convergence: { label: 'Convergence', palette: 'purple', description: 'two hands, shared gravity' },
  void:        { label: 'Void',        palette: 'gray',   description: 'no presence, field drifts alone' }
};

// ── Current active zone ───────────────────────────────────────
let currentZone = 'void';

// ── Ollama zone classifier ────────────────────────────────────
const OLLAMA_URL   = 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = 'llama3.2';
let lastClassify   = 0;
let classifyActive = false;

async function classifyZone() {
  if (classifyActive) return;

  // Void: no hands — classify immediately without Ollama
  if (fieldState.hands === 0) {
    if (currentZone !== 'void') {
      currentZone = 'void';
      broadcastZone('void', 'no presence, field drifts alone');
    }
    return;
  }

  if (Date.now() - lastClassify < 5000) return;
  classifyActive = true;
  lastClassify   = Date.now();

  const prompt = `You are a zone classifier for a cooperative particle installation.

Current field state:
- Hands active: ${fieldState.hands}
- Average particle speed: ${fieldState.avgSpeed.toFixed(2)} (0=still, 10+=very fast)
- Particle density near hands: ${fieldState.density.toFixed(2)} (0=scattered, 1=dense)
- Palm distance: ${fieldState.palmDist.toFixed(0)}px (0 if one hand, <200=close, >200=apart)
- Active gestures: ${fieldState.gestures.join(', ') || 'none'}

Classify this moment as exactly one of these zones:
- stillness: low speed (<3), any density, patient, meditative
- surge: high speed (>5), low density, scattered, energetic
- convergence: two hands with palm distance under 220px
- void: no hands (default if uncertain)

Rules:
- convergence requires hands >= 2 AND palmDist < 220
- surge requires avgSpeed > 5
- stillness requires avgSpeed < 3
- if nothing fits clearly, output void

Respond with ONLY valid JSON, nothing else:
{"zone":"stillness","description":"two words max"}`;

  try {
    const res  = await fetch(OLLAMA_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model:   OLLAMA_MODEL,
        prompt,
        stream:  false,
        options: { temperature: 0.2, num_predict: 30 }
      }),
      timeout: 5000
    });
    const data  = await res.json();
    const raw   = (data.response || '').trim();
    const match = raw.match(/\{[\s\S]*?\}/);
    if (!match) throw new Error('no JSON');

    const parsed = JSON.parse(match[0]);
    const zone   = ZONES[parsed.zone] ? parsed.zone : heuristicZone();
    const desc   = (parsed.description || ZONES[zone].description).slice(0, 30);

    currentZone = zone;
    broadcastZone(zone, desc);
    console.log(`[zone] ${zone} — "${desc}"`);

  } catch (e) {
    // Offline fallback: heuristic zone from raw numbers
    console.warn('[zone] Ollama offline, using heuristic:', e.message);
    const zone = heuristicZone();
    currentZone = zone;
    broadcastZone(zone, ZONES[zone].description);
  } finally {
    classifyActive = false;
  }
}

// Heuristic zone without Ollama
function heuristicZone() {
  if (fieldState.hands === 0)                                    return 'void';
  if (fieldState.hands >= 2 && fieldState.palmDist < 220)       return 'convergence';
  if (fieldState.avgSpeed > 5)                                   return 'surge';
  if (fieldState.avgSpeed < 3)                                   return 'stillness';
  return 'void';
}

function broadcastZone(zone, description) {
  broadcast({
    type:        'zone',
    zone,
    label:       ZONES[zone].label,
    palette:     ZONES[zone].palette,
    description
  });
  // Forward to controllers too
  const msg = JSON.stringify({ type:'zone', zone, label:ZONES[zone].label, description });
  for (const c of controlClients) {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  }
}

// Run classifier check every 1s
setInterval(classifyZone, 1000);

// ── Broadcast to display ──────────────────────────────────────
function broadcast(msg) {
  const data = JSON.stringify(msg);
  if (displayClient && displayClient.readyState === WebSocket.OPEN) {
    displayClient.send(data);
  }
}

function pushParams() {
  broadcast({ type: 'params', params });
}

// ── WebSocket handler ─────────────────────────────────────────
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'identify') {
      if (msg.role === 'display') {
        displayClient = ws;
        ws.send(JSON.stringify({ type: 'params', params }));
        // Send current zone immediately
        ws.send(JSON.stringify({
          type: 'zone', zone: currentZone,
          label: ZONES[currentZone].label,
          palette: ZONES[currentZone].palette,
          description: ZONES[currentZone].description
        }));
        console.log('[ws] display connected');
      } else if (msg.role === 'control') {
        controlClients.add(ws);
        ws.send(JSON.stringify({ type: 'params', params }));
        ws.send(JSON.stringify({ type: 'zone', zone: currentZone, label: ZONES[currentZone].label, description: ZONES[currentZone].description }));
        console.log('[ws] controller connected');
      }
      return;
    }

    if (msg.type === 'state') {
      fieldState = { ...fieldState, ...msg.state, lastActive: Date.now() };
      const stateMsg = JSON.stringify({ type: 'state', state: fieldState });
      for (const c of controlClients) {
        if (c.readyState === WebSocket.OPEN) c.send(stateMsg);
      }
      return;
    }

    if (msg.type === 'setParam') {
      const { key, value } = msg;
      if (key in params) {
        params[key] = value;
        pushParams();
        console.log(`[param] ${key} = ${value}`);
      }
      return;
    }

    if (msg.type === 'reset') {
      broadcast({ type: 'reset' });
      console.log('[ws] reset triggered');
      return;
    }

    // Manual zone classify trigger from controller
    if (msg.type === 'classify') {
      lastClassify = 0;
      classifyZone();
      return;
    }
  });

  ws.on('close', () => {
    if (ws === displayClient) { displayClient = null; console.log('[ws] display disconnected'); }
    controlClients.delete(ws);
  });
});

// ── Routes ────────────────────────────────────────────────────
app.get('/control', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'control.html'));
});

// ── Start ─────────────────────────────────────────────────────
server.listen(PORT, () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  let localIP = 'localhost';
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) { localIP = net.address; break; }
    }
  }
  console.log(`\n✦  SQUISH — Psychogeographic Field`);
  console.log(`   Display:    http://localhost:${PORT}`);
  console.log(`   Controller: http://${localIP}:${PORT}/control\n`);
  console.log(`   Zones: stillness / surge / convergence / void`);
  console.log(`   Ollama zone classifier running every 5s\n`);
});
