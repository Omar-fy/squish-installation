# SQUISH
### A cooperative hand-controlled particle installation

Built for a university interactive media module as a physical computing + AI prototype. This is a browser-based installation where 1 to 2 people use their bare hands to manipulate a field of particles in real time. No controllers, no touchscreen, just your hands in front of a webcam.

The project grew out of research into embodied play theory (Huizinga, Caillois) and the idea that the body itself can be the interface. A separate museum-mode controller lets a curator tweak the physics live from their phone, and a local AI model (Ollama / llama3.2) watches the session and generates atmospheric one-line captions that appear on the installation screen.

---

## What it actually does

A webcam feeds into ml5.js HandPose, which tracks 21 keypoints per hand at 30fps. Those keypoints drive a particle physics simulation running in p5.js. Depending on your hand shape, different forces apply to the particles around your palm.

| Gesture | What happens |
|---|---|
| Fist | Strong attract, particles compress inward like squeezing a stress ball |
| Open palm | Gentle gravitational hold, particles orbit around your hand |
| Fingers spread | Explosive repel, everything scatters |
| Fast swipe | Palm velocity transfers as a shockwave through nearby particles |

The score tracks how many particles both players are holding simultaneously. That is the cooperative element: two people working together can hold more than either can alone.

---

## Tech stack

- **p5.js** for the canvas and draw loop
- **ml5.js v1** for real-time hand pose detection (MediaPipe Hands under the hood)
- **Node.js + Express** as the installation server
- **WebSocket (ws)** for live communication between display, controller, and server
- **Ollama (llama3.2)** running locally as the AI narrator
- **nginx** (optional) for production HTTPS deployment

---

## Project structure

```
squish-installation/
├── server.js          Node + WebSocket server, Ollama integration
├── package.json
└── public/
    ├── index.html     Installation display screen (the big screen)
    └── control.html   Phone controller UI
```

---

## Running it locally

You need Node.js, Ollama, and a webcam.

```bash
# Clone the repo
git clone https://github.com/Omar-fy/squish-installation.git
cd squish-installation

# Install dependencies
npm install

# Pull the AI model (only needed once)
ollama pull llama3.2

# Start Ollama in a separate terminal tab
ollama serve

# Start the server
node server.js
```

The terminal will print two URLs:

```
Display:    http://localhost:3000
Controller: http://YOUR_LOCAL_IP:3000/control
```

Open the display URL on the installation screen (Chrome works best for camera access). Open the controller URL on your phone while connected to the same WiFi.

The AI narrator is optional. If Ollama is not running, everything else still works fine.

---

## Phone controller

The controller at `/control` lets you adjust the physics in real time without touching the installation screen. Changes push to the display instantly over WebSocket.

Parameters you can control:

- Particle count and size
- Gravity (can be set negative for particles that float up)
- Friction and bounce
- Palm influence radius
- Attract and repel strength
- Motion trail toggle

There is also a **Generate Narration** button that manually triggers the AI to react to whatever is currently happening in the field.

---

## Deploying with nginx

For a real installation where the display and controller need to be accessible from different devices or over the internet, you need HTTPS (the camera API requires it on non-localhost origins).

Install nginx and certbot, point your domain at your machine, then use this nginx config:

```nginx
server {
    listen 443 ssl;
    server_name yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    location / {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_read_timeout 3600s;
    }
}
```

The single location block handles both HTTP and WebSocket upgrade traffic, which is what the display and controller both need.

---

## AI narrator

The server watches the live field state (how many hands are active, what gestures they are doing, how many particles are being held, average particle speed) and calls llama3.2 every 6 seconds when the field is active. The model is prompted to generate a single atmospheric caption of no more than 9 words. Something like:

> two hands pulling the same field apart

> everything scatters and reconvenes

> the field remembers the shape of your grip

These appear as fading text at the bottom of the installation canvas. The idea is that the AI is not controlling the visuals directly but narrating what it observes, adding a layer of poetic interpretation to the physical interaction.

---

## Context and theory

This project sits within a broader body of work looking at cooperative embodied play in installation contexts. The cooperative scoring mechanic (shared hold count rather than individual scores) is intentionally designed to avoid competition, drawing on Caillois's distinction between agonistic and mimetic play. The absence of instructions on the display screen is also deliberate: gesture discovery through exploration is more interesting than following a legend.

The AI narrator extends work done on a parallel installation called Echoing Shadows, which uses TF.js hand tracking and a three-chapter narrative arc to create a longer-form cooperative experience. SQUISH is the stress-ball prototype: lighter, faster to set up, more immediately legible.

---

## Known issues and limitations

- ml5 HandPose works best in good even lighting with hands clearly visible against a contrasting background
- Two hands max from a single webcam (MediaPipe limitation at this input size)
- Ollama must be running separately before starting the server if you want the narrator active
- Camera access requires HTTPS in production (localhost is the only exception)

---

## License

MIT. Use it, break it, build on it.

---

*Made as part of a semester 2 interactive media project. University of Southampton, 2025.*
