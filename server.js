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
const os       = require('os');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const PORT   = 3000;
  let uploadBuf  = null;
  let sseClients = [];
  
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

  // Serve the phone upload page
  app.get('/upload', (req, res) => res.send(`<!DOCTYPE html>
    <html><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>SQUISH — Upload Song</title>
    <style>
      body{background:#05020f;display:flex;flex-direction:column;
           align-items:center;justify-content:center;min-height:100vh;
           font-family:monospace;color:#e8d5a3;gap:20px;padding:20px;}
      h2{font-size:14px;letter-spacing:2px;}
      p{font-size:11px;color:#7a6030;text-align:center;}
      input[type=file]{display:none;}
      label{background:#e8d5a3;color:#05020f;padding:12px 24px;
            font-size:12px;cursor:pointer;letter-spacing:1px;}
      #status{font-size:10px;color:#ffd250;min-height:20px;}
    </style></head>
    <body>
      <h2>SQUISH CONDUCTOR</h2>
      <p>select a song to send to the installation</p>
      <label for="f">CHOOSE AUDIO FILE</label>
      <input type="file" id="f" accept="audio/*">
      <div id="status"></div>
      <script>
        document.getElementById('f').addEventListener('change',async e=>{
          const file=e.target.files[0]; if(!file)return;
          document.getElementById('status').textContent='UPLOADING '+file.name+'...';
          const fd=new FormData(); fd.append('audio',file);
          const r=await fetch('/upload',{method:'POST',body:fd});
          document.getElementById('status').textContent=
            r.ok?'SENT — CHECK INSTALLATION':'ERROR';
        });
      <\/script>
    </body></html>`));

  // Receive the uploaded file
  const multer = require('multer');
  const upload = multer({storage:multer.memoryStorage(),limits:{fileSize:80*1024*1024}});
  app.post('/upload', upload.single('audio'), (req, res) => {
    uploadBuf = req.file.buffer;
    res.json({ok:true});
    sseClients.forEach(c => c.write('data: ready\n\n'));
    sseClients = sseClients.filter(c => !c.writableEnded);
  });

  // SSE stream — installation listens here
  app.get('/upload-events', (req, res) => {
    res.setHeader('Content-Type','text/event-stream');
    res.setHeader('Cache-Control','no-cache');
    res.setHeader('Connection','keep-alive');
    sseClients.push(res);
    req.on('close', () => { sseClients = sseClients.filter(c=>c!==res); });
  });

  // Installation fetches the file after SSE notification
  app.get('/upload-file', (req, res) => {
    if(!uploadBuf){res.status(404).end();return;}
    res.setHeader('Content-Type','audio/mpeg');
    res.send(uploadBuf);
  });

  // Local IP for QR URL
  app.get('/local-ip', (req, res) => {
    const nets=os.networkInterfaces();
    let ip='localhost';
    for(const n of Object.values(nets).flat())
      if(n.family==='IPv4'&&!n.internal){ip=n.address;break;}
    res.json({ip});
  });