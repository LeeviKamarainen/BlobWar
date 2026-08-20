/**
 * Relay server for online matches.
 *
 * Deliberately dumb: it knows about rooms, slots and whose turn it is, and it
 * forwards messages. It does not simulate the game. The client whose turn it is
 * owns the outcome and publishes an authoritative snapshot at the end of each
 * turn (see docs/multiplayer-plan.md).
 */
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { MAPS, DEFAULT_MAP } from '../src/maps.js';
import { WEAPON_ORDER, CORE_WEAPONS } from '../src/weapons.js';
import { CFG } from '../src/config.js';
import { CONTROL_DIM, CUSTOM_MAP_ID } from '../src/customMap.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = process.env.PORT || 3000;
const MAX_TEAMS = 4;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no easily-confused glyphs

const TOGGLEABLE_WEAPONS = new Set(WEAPON_ORDER.filter((id) => !CORE_WEAPONS.includes(id)));
const GRAVITY_VALUES = CFG.gravityPresets.map((p) => p.value);
const DEFAULT_GRAVITY = CFG.gravityPresets.find((p) => p.id === CFG.defaultGravityPreset).value;

/** The server doesn't simulate, but a malicious/odd client could still send
 *  garbage settings, so match-shape fields get the same validation the menu
 *  UI already enforces on itself. */
function sanitizeMapId(id, hasCustomMap) {
  if (id === CUSTOM_MAP_ID) return hasCustomMap ? CUSTOM_MAP_ID : DEFAULT_MAP;
  return typeof id === 'string' && MAPS[id] ? id : DEFAULT_MAP;
}
function sanitizeGravity(g) {
  const n = Number(g);
  return GRAVITY_VALUES.includes(n) ? n : DEFAULT_GRAVITY;
}
function sanitizeWeapons(list) {
  // Not provided at all means "every weapon" (null); an explicit array —
  // even empty — is a real restriction and is kept as given.
  if (!Array.isArray(list)) return null;
  return list.filter((id) => TOGGLEABLE_WEAPONS.has(id));
}
/** The host's hand-painted map, relayed whole so every client builds the
 *  identical terrain — nobody else has it in their own localStorage. */
function sanitizeCustomMap(cm) {
  if (!cm || !Array.isArray(cm.heights) || cm.heights.length !== CONTROL_DIM * CONTROL_DIM) return null;
  return {
    name: typeof cm.name === 'string' ? cm.name.slice(0, 24) : 'Custom',
    controlDim: CONTROL_DIM,
    noiseAmount: Math.max(0, Math.min(1, Number(cm.noiseAmount) || 0)),
    heights: cm.heights.map((v) => Math.max(0, Math.min(1, Number(v) || 0))),
  };
}

const app = express();
const http = createServer(app);
const io = new Server(http, { cors: { origin: '*' } });

const dist = join(ROOT, 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
} else {
  console.warn('[blobwar] no dist/ found — run "npm run build" first, or use "npm run dev"');
}
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

/** @type {Map<string, Room>} */
const rooms = new Map();

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0]).join('');
  } while (rooms.has(code));
  return code;
}

function publicRoom(room) {
  return {
    code: room.code,
    seed: room.seed,
    started: room.started,
    hostId: room.hostId,
    mapId: room.mapId,
    gravity: room.gravity,
    weapons: room.weapons,
    // customMap deliberately isn't here: it's tens of KB and only needed once,
    // by the 'start' payload, not on every lobby broadcast.
    players: room.players.map((p) => ({
      slot: p.slot,
      name: p.name,
      connected: p.connected,
      isHost: p.id === room.hostId,
    })),
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit('room', publicRoom(room));
}

function dropRoom(room) {
  rooms.delete(room.code);
  console.log(`[blobwar] room ${room.code} closed`);
}

io.on('connection', (socket) => {
  let room = null;
  let me = null;

  const leave = () => {
    if (!room || !me) return;
    me.connected = false;
    me.socketId = null;

    if (!room.started) {
      // Nobody's invested yet — just free the slot.
      room.players = room.players.filter((p) => p !== me);
      room.players.forEach((p, i) => (p.slot = i));
      if (room.hostId === me.id) room.hostId = room.players[0]?.id ?? null;
    }

    if (room.players.every((p) => !p.connected)) {
      dropRoom(room);
    } else {
      io.to(room.code).emit('peerLeft', { slot: me.slot, name: me.name, started: room.started });
      broadcastRoom(room);
      // If the absent player was mid-turn, ask the host to move things along.
      if (room.started && room.turnSlot === me.slot) {
        const host = room.players.find((p) => p.id === room.hostId && p.connected);
        if (host) io.to(host.socketId).emit('forceAdvance', { slot: me.slot });
      }
    }
    room = null;
    me = null;
  };

  socket.on('create', ({ name, teamCount, mapId, gravity, weapons, customMap }, ack) => {
    const code = makeCode();
    const sanitizedCustomMap = mapId === CUSTOM_MAP_ID ? sanitizeCustomMap(customMap) : null;
    room = {
      code,
      seed: (Math.random() * 1e9) | 0,
      teamCount: Math.min(MAX_TEAMS, Math.max(2, teamCount || 2)),
      mapId: sanitizeMapId(mapId, !!sanitizedCustomMap),
      gravity: sanitizeGravity(gravity),
      weapons: sanitizeWeapons(weapons),
      customMap: sanitizedCustomMap,
      players: [],
      started: false,
      hostId: socket.id,
      turnSlot: 0,
      lastSnapshot: null,
    };
    me = { id: socket.id, socketId: socket.id, name: name || 'Player', slot: 0, connected: true };
    room.players.push(me);
    rooms.set(code, room);
    socket.join(code);
    console.log(`[blobwar] room ${code} created by ${me.name}`);
    ack?.({ ok: true, room: publicRoom(room), slot: 0, teamCount: room.teamCount });
    broadcastRoom(room);
  });

  socket.on('join', ({ code, name }, ack) => {
    const target = rooms.get((code || '').toUpperCase());
    if (!target) return ack?.({ ok: false, error: 'No room with that code.' });
    if (target.started) return ack?.({ ok: false, error: 'That match has already started.' });
    if (target.players.length >= target.teamCount) return ack?.({ ok: false, error: 'That room is full.' });

    room = target;
    me = {
      id: socket.id,
      socketId: socket.id,
      name: name || 'Player',
      slot: room.players.length,
      connected: true,
    };
    room.players.push(me);
    socket.join(room.code);
    ack?.({ ok: true, room: publicRoom(room), slot: me.slot, teamCount: room.teamCount });
    socket.to(room.code).emit('peerJoined', { slot: me.slot, name: me.name });
    broadcastRoom(room);
  });

  socket.on('setTeamCount', (n) => {
    if (!room || room.hostId !== socket.id || room.started) return;
    room.teamCount = Math.min(MAX_TEAMS, Math.max(room.players.length, Math.max(2, n | 0)));
    broadcastRoom(room);
  });

  socket.on('start', () => {
    if (!room || room.hostId !== socket.id || room.started) return;
    if (room.players.length < 2) return;
    room.started = true;
    room.teamCount = room.players.length;
    room.turnSlot = 0;
    io.to(room.code).emit('start', {
      seed: room.seed,
      teamCount: room.teamCount,
      players: publicRoom(room).players,
      mapId: room.mapId,
      gravity: room.gravity,
      weapons: room.weapons,
      customMap: room.customMap,
    });
    console.log(`[blobwar] room ${room.code} started with ${room.players.length} players`);
  });

  // --- in-match relay -------------------------------------------------------

  socket.on('cmd', (cmd) => {
    if (!room) return;
    socket.to(room.code).emit('cmd', cmd);
  });

  socket.on('pose', (pose) => {
    if (!room) return;
    socket.to(room.code).emit('pose', pose);
  });

  socket.on('turnEnd', (snapshot) => {
    if (!room) return;
    room.lastSnapshot = snapshot;
    room.turnSlot = snapshot.team;
    socket.to(room.code).emit('turnEnd', snapshot);
  });

  /** Terrain drift fallback: a client asks for, and the actor supplies, raw heights. */
  socket.on('resyncRequest', () => {
    if (!room) return;
    const host = room.players.find((p) => p.id === room.hostId && p.connected);
    if (host) io.to(host.socketId).emit('resyncRequest', { to: socket.id });
  });

  socket.on('resyncData', ({ to, heights }) => {
    if (!room) return;
    io.to(to).emit('resyncData', { heights });
  });

  socket.on('chat', (text) => {
    if (!room || !me) return;
    io.to(room.code).emit('chat', { name: me.name, text: String(text).slice(0, 140) });
  });

  socket.on('leave', leave);
  socket.on('disconnect', leave);
});

http.listen(PORT, () => {
  console.log(`[blobwar] listening on http://localhost:${PORT}`);
});
