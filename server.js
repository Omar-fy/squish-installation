// ─────────────────────────────────────────────────────────────
//  SQUISH — installation server
//  Express + WebSocket + Ollama (llama3.2)
//
//  Clients:
//    installation  → ws, role:"display"  — the big screen
//    controller    → ws, role:"control"  — phone browser
//
//  Ollama use: field narrator
//    Every ~6s when hands are active, the server reads the
//    current game state (gestures, score, hands, velocity) and
//    asks llama3.2 for a one-line atmospheric caption.
//    This appears on the installation screen as living text.
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

// ── Live field state (updated by display, read by Ollama) ─────
let fieldState = {
  hands:     0,
  gestures:  [],
  score:     0,
  best:      0,
  avgSpeed:  0,
  lastActive: 0
};

// ── Current physics params (controlled by phone) ──────────────
// These are the defaults; controller can change any of them
let params = {
  count:     350,
  gravity:   0.02,
  friction:  0.993,
  radius:    110,
  attract:   3.5,
  repel:     7.0,
  size:      4,
  trail:     true
};

// ── Ollama narrator ───────────────────────────────────────────
const OLLAMA_URL   = 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = 'llama3.2';
let lastNarration  = Date.now();
let narratorActive = false;

async function generateNarration() {
  if (narratorActive) return;
  if (fieldState.hands === 0) return;
  if (Date.now() - lastNarration < 6000) return;

  narratorActive = true;
  lastNarration  = Date.now();

  const gestures = fieldState.gestures.length
    ? fieldState.gestures.join(' + ')
    : 'still';

  const prompt = `You are the voice of a generative particle installation.
Right now: ${fieldState.hands} hand(s) in the field.
Gestures: ${gestures}.
Particles held: ${fieldState.score} out of ${params.count}.
Average particle speed: ${fieldState.avgSpeed.toFixed(1)}.

Write ONE short atmospheric line (max 9 words) reacting to this moment.
No punctuation. No quotes. Just the line. Be poetic and physical.
Examples: "the field remembers the shape of your grip"
          "everything scatters and reconvenes"
          "two hands one field one pull"`;

  try {
    const res = await fetch(OLLAMA_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model:  OLLAMA_MODEL,
        prompt,
        stream: false,
        options: { temperature: 0.85, num_predict: 20 }
      }),
      timeout: 6000
    });
    const data = await res.json();
    const line = (data.response || '').trim()
      .replace(/^["']/,'').replace(/["']$/,'')
      .replace(/\.$/, '');

    if (line) broadcast({ type: 'narration', text: line });
    console.log('[narrator]', line);
  } catch (e) {
    console.warn('[narrator] Ollama offline:', e.message);
  } finally {
    narratorActive = false;
  }
}

// Run narrator check every 2s
setInterval(generateNarration, 2000);

// ── Broadcast to all display clients ─────────────────────────
function broadcast(msg) {
  const data = JSON.stringify(msg);
  if (displayClient && displayClient.readyState === WebSocket.OPEN) {
    displayClient.send(data);
  }
}

// ── Broadcast params to display ───────────────────────────────
function pushParams() {
  broadcast({ type: 'params', params });
}

// ── WebSocket handler ─────────────────────────────────────────
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── Identify role ──────────────────────────────────────
    if (msg.type === 'identify') {
      if (msg.role === 'display') {
        displayClient = ws;
        // Send current params immediately
        ws.send(JSON.stringify({ type: 'params', params }));
        console.log('[ws] display connected');
      } else if (msg.role === 'control') {
        controlClients.add(ws);
        // Send current params so sliders initialise correctly
        ws.send(JSON.stringify({ type: 'params', params }));
        console.log('[ws] controller connected');
      }
      return;
    }

    // ── State update from display ──────────────────────────
    if (msg.type === 'state') {
      fieldState = { ...fieldState, ...msg.state, lastActive: Date.now() };
      // Forward to all controllers so they can see live metrics
      const stateMsg = JSON.stringify({ type: 'state', state: fieldState });
      for (const c of controlClients) {
        if (c.readyState === WebSocket.OPEN) c.send(stateMsg);
      }
      return;
    }

    // ── Param update from controller ──────────────────────
    if (msg.type === 'setParam') {
      const { key, value } = msg;
      if (key in params) {
        params[key] = value;
        pushParams();
        console.log(`[param] ${key} = ${value}`);
      }
      return;
    }

    // ── Reset command from controller ──────────────────────
    if (msg.type === 'reset') {
      broadcast({ type: 'reset' });
      console.log('[ws] reset triggered by controller');
      return;
    }

    // ── Manual narration trigger from controller ───────────
    if (msg.type === 'narrate') {
      lastNarration = 0;  // force immediate generation
      generateNarration();
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
  // Get local IP for phone
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  let localIP = 'localhost';
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) { localIP = net.address; break; }
    }
  }
  console.log(`\n✦  SQUISH installation server`);
  console.log(`   Display:    http://localhost:${PORT}`);
  console.log(`   Controller: http://${localIP}:${PORT}/control  ← open on phone\n`);
});
