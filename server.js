require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const compression = require('compression');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

const PORT = process.env.PORT || 3000;

app.use(compression());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'atc.html')));
app.get('/health', (req, res) => res.send('ok'));

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

const clients = new Set();
const atcClients = new Set();
const playerClients = new Set();
const aircrafts = new Map();
const trackHistory = new Map();

const RETENTION_MS = 12 * 60 * 60 * 1000;
const MAX_TRACK_POINTS = 500;

let broadcastQueue = [];
let broadcastTimer = null;

function queueBroadcast(obj) {
  broadcastQueue.push(obj);
  
  if (!broadcastTimer) {
    broadcastTimer = setTimeout(() => {
      if (broadcastQueue.length > 0) {
        const updates = broadcastQueue.filter(m => m.type === 'aircraft_update');
        const others = broadcastQueue.filter(m => m.type !== 'aircraft_update');
        
        if (updates.length > 0) {
          sendToATC({
            type: 'aircraft_batch_update',
            payload: updates.map(u => u.payload)
          });
        }
        
        others.forEach(m => sendToATC(m));
        broadcastQueue = [];
      }
      broadcastTimer = null;
    }, 100);
  }
}

function sendToATC(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of atcClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

function broadcastToATC(obj) {
  sendToATC(obj);
}

function simplifyTrack(track, maxPoints = MAX_TRACK_POINTS) {
  if (track.length <= maxPoints) return track;
  
  const step = Math.ceil(track.length / maxPoints);
  const simplified = [];
  
  for (let i = 0; i < track.length; i += step) {
    simplified.push(track[i]);
  }
  
  if (simplified[simplified.length - 1] !== track[track.length - 1]) {
    simplified.push(track[track.length - 1]);
  }
  
  return simplified;
}

function addTrackPoint(aircraftId, point) {
  if (!trackHistory.has(aircraftId)) {
    trackHistory.set(aircraftId, []);
  }
  
  const tracks = trackHistory.get(aircraftId);
  tracks.push(point);
  
  const cutoff = Date.now() - RETENTION_MS;
  const filtered = tracks.filter(t => t.ts >= cutoff);
  
  if (filtered.length > MAX_TRACK_POINTS * 2) {
    trackHistory.set(aircraftId, simplifyTrack(filtered, MAX_TRACK_POINTS));
  } else {
    trackHistory.set(aircraftId, filtered);
  }
}

function getTrackHistory(aircraftId) {
  const tracks = trackHistory.get(aircraftId) || [];
  return simplifyTrack(tracks, MAX_TRACK_POINTS);
}

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.role = 'unknown';

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'hello') {
        ws.role = msg.role || 'unknown';

        if (ws.role === 'atc') {
          atcClients.add(ws);

          const payload = Array.from(aircrafts.values()).map(x => x.payload);
          ws.send(JSON.stringify({ type: 'aircraft_snapshot', payload }));

          for (const [aircraftId] of aircrafts) {
            const tracks = getTrackHistory(aircraftId);
            if (tracks.length > 0) {
              ws.send(JSON.stringify({
                type: 'aircraft_track_history',
                payload: { aircraftId, tracks }
              }));
            }
          }
        } else if (ws.role === 'player') {
          playerClients.add(ws);
          ws.aircraftId = null;
        }
        return;
      }

      if (msg.type === 'position_update' && msg.payload) {
        const p = msg.payload;
        const id = p.id || (p.callsign ? p.callsign + ':' + (p.playerId || 'p') : null);
        if (!id) return;

        if (ws.role === 'player') {
          ws.aircraftId = id;
        }

        const payload = {
          id,
          callsign: p.callsign || 'UNK',
          type: p.type || '',
          lat: +p.lat || 0,
          lon: +p.lon || 0,
          alt: +p.alt || 0,
          heading: (typeof p.heading !== 'undefined') ? +p.heading : 0,
          speed: (typeof p.speed !== 'undefined') ? +p.speed : 0,
          flightNo: p.flightNo || '',
          departure: p.departure || '',
          arrival: p.arrival || '',
          takeoffTime: p.takeoffTime || '',
          squawk: p.squawk || '',
          ts: Date.now(),
          flightPlan: p.flightPlan || []
        };

        aircrafts.set(id, { payload, lastSeen: Date.now() });

        addTrackPoint(id, {
          lat: payload.lat,
          lon: payload.lon,
          alt: payload.alt,
          speed: payload.speed,
          ts: payload.ts
        });

        queueBroadcast({
          type: 'aircraft_update',
          payload,
          trackPoint: {
            lat: payload.lat,
            lon: payload.lon,
            alt: payload.alt,
            timestamp: payload.ts
          }
        });

        return;
      }

      if (msg.type === 'clear_track' && msg.aircraftId) {
        trackHistory.delete(msg.aircraftId);
        broadcastToATC({ type: 'aircraft_track_clear', payload: { aircraftId: msg.aircraftId } });
        return;
      }

      if (msg.type === 'disconnect' && msg.aircraftId) {
        trackHistory.delete(msg.aircraftId);
        broadcastToATC({ type: 'aircraft_track_clear', payload: { aircraftId: msg.aircraftId } });
        return;
      }

    } catch (e) {
      console.warn('Bad message', e);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    atcClients.delete(ws);
    playerClients.delete(ws);

    if (ws.role === 'player' && ws.aircraftId) {
      trackHistory.delete(ws.aircraftId);
      broadcastToATC({
        type: 'aircraft_track_clear',
        payload: { aircraftId: ws.aircraftId }
      });
    }
  });

  ws.on('error', (e) => {
    console.warn('WS error', e);
  });
});

setInterval(() => {
  const now = Date.now();
  const timeout = 30000;
  let removed = [];
  
  for (const [id, v] of aircrafts.entries()) {
    if (now - v.lastSeen > timeout) {
      aircrafts.delete(id);
      trackHistory.delete(id);
      removed.push(id);
    }
  }
  
  if (removed.length) {
    broadcastToATC({ type: 'aircraft_remove', payload: removed });
    removed.forEach(aircraftId => {
      broadcastToATC({
        type: 'aircraft_track_clear',
        payload: { aircraftId }
      });
    });
  }
}, 5000);

setInterval(() => {
  const cutoff = Date.now() - RETENTION_MS;
  for (const [id, tracks] of trackHistory.entries()) {
    const filtered = tracks.filter(t => t.ts >= cutoff);
    if (filtered.length === 0) {
      trackHistory.delete(id);
    } else {
      trackHistory.set(id, filtered);
    }
  }
}, 6 * 60 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});