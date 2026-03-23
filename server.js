// ─────────────────────────────────────────────────────────────
//  SQUISH — installation server
//  Express + WebSocket only. No Ollama, no external API.
//
//  Zone classification is now handled client-side in index.html
//  using a pure heuristic from the physics state.
//
//  This server handles:
//    - Serving static files
//    - Relaying physics params from controller to display
//    - Forwarding field state from display to controllers
// ─────────────────────────────────────────────────────────────

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const path      = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const PORT   = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let displayClient  = null;
let controlClients = new Set();

// ── Physics params (controller can change these) ──────────────
let params = {
  count: 200, gravity: 0.02, friction: 0.993,
  radius: 110, attract: 3.5, repel: 7.0, size: 4, trail: true
};

// ── Field state (forwarded from display to controllers) ───────
let fieldState = {
  hands: 0, gestures: [], score: 0, best: 0,
  avgSpeed: 0, palmDist: 0, density: 0,
  zone: 'void', comboName: ''
};

function broadcast(msg) {
  const data = JSON.stringify(msg);
  if (displayClient && displayClient.readyState === WebSocket.OPEN) {
    displayClient.send(data);
  }
}

function pushParams() {
  broadcast({ type: 'params', params });
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'identify') {
      if (msg.role === 'display') {
        displayClient = ws;
        ws.send(JSON.stringify({ type: 'params', params }));
        console.log('[ws] display connected');
      } else if (msg.role === 'control') {
        controlClients.add(ws);
        ws.send(JSON.stringify({ type: 'params', params }));
        ws.send(JSON.stringify({ type: 'state', state: fieldState }));
        console.log('[ws] controller connected');
      }
      return;
    }

    if (msg.type === 'state') {
      fieldState = { ...fieldState, ...msg.state };
      const s = JSON.stringify({ type: 'state', state: fieldState });
      for (const c of controlClients) {
        if (c.readyState === WebSocket.OPEN) c.send(s);
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
      console.log('[ws] reset');
      return;
    }
  });

  ws.on('close', () => {
    if (ws === displayClient) { displayClient = null; console.log('[ws] display disconnected'); }
    controlClients.delete(ws);
  });
});

app.get('/control', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'control.html'));
});

server.listen(PORT, () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  let localIP = 'localhost';
  for (const iface of Object.values(nets))
    for (const net of iface)
      if (net.family === 'IPv4' && !net.internal) { localIP = net.address; break; }

  console.log(`\n✦  SQUISH`);
  console.log(`   Display:    http://localhost:${PORT}`);
  console.log(`   Controller: http://${localIP}:${PORT}/control\n`);
});
