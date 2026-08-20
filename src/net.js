import { io } from 'socket.io-client';

/**
 * Client side of online play.
 *
 * `Net` owns the socket and the lobby; `NetSession` is the thin object handed to
 * `Game` while a match is running (game.net). The game only ever calls
 * sendCommand / sendPose / sendTurnEnd on it, and the session pushes remote
 * commands back in through game.applyCommand / game.applySnapshot.
 */
export class Net {
  constructor() {
    this.socket = null;
    this.room = null;
    this.slot = -1;
    this.game = null;
    this.listeners = {};
  }

  on(event, fn) {
    (this.listeners[event] ||= []).push(fn);
    return this;
  }

  fire(event, payload) {
    for (const fn of this.listeners[event] ?? []) fn(payload);
  }

  get isHost() {
    return !!this.room && this.room.players.some((p) => p.slot === this.slot && p.isHost);
  }

  connect(url) {
    if (this.socket) return Promise.resolve();
    return new Promise((resolve, reject) => {
      // Same origin by default: one Node process serves the page and the socket.
      this.socket = io(url || undefined, { transports: ['websocket', 'polling'] });
      const fail = (err) => reject(new Error(err?.message || 'Could not reach the server.'));
      this.socket.once('connect', () => {
        this.socket.off('connect_error', fail);
        this.bind();
        resolve();
      });
      this.socket.once('connect_error', fail);
    });
  }

  bind() {
    const s = this.socket;
    s.on('room', (room) => {
      this.room = room;
      this.fire('room', room);
    });
    s.on('peerJoined', (p) => this.fire('peerJoined', p));
    s.on('peerLeft', (p) => this.fire('peerLeft', p));
    s.on('start', (info) => this.fire('start', info));
    s.on('chat', (m) => this.fire('chat', m));
    s.on('disconnect', () => this.fire('disconnected'));

    s.on('cmd', (cmd) => this.game?.applyCommand(cmd));
    s.on('pose', (pose) => this.game?.applyCommand(pose));
    s.on('turnEnd', (snap) => {
      if (!this.game) return;
      const drift = this.game.applySnapshot(snap);
      if (drift) {
        console.warn('[net] terrain drift detected, requesting resync');
        s.emit('resyncRequest');
      }
    });
    s.on('resyncRequest', ({ to }) => {
      if (!this.game) return;
      s.emit('resyncData', { to, heights: this.game.terrain.heights.buffer });
    });
    s.on('resyncData', ({ heights }) => {
      if (!this.game) return;
      this.game.terrain.setHeights(new Float32Array(heights));
      console.info('[net] terrain resynced from host');
    });
    s.on('forceAdvance', () => {
      // We're the host and the player who was mid-turn vanished. Skip them.
      if (this.game && this.game.state !== 'over') this.game.forceAdvanceTurn();
    });
  }

  createRoom(name, teamCount, settings = {}) {
    const { mapId, gravity, weapons, customMap } = settings;
    // customMap.heights is a Float32Array — socket.io's JSON encoding won't
    // touch it kindly, so send a plain array over the wire.
    const wireCustomMap = customMap ? { ...customMap, heights: Array.from(customMap.heights) } : null;
    return new Promise((resolve) =>
      this.socket.emit('create', { name, teamCount, mapId, gravity, weapons, customMap: wireCustomMap }, (res) => {
        if (res?.ok) {
          this.room = res.room;
          this.slot = res.slot;
        }
        resolve(res);
      })
    );
  }

  joinRoom(code, name) {
    return new Promise((resolve) =>
      this.socket.emit('join', { code, name }, (res) => {
        if (res?.ok) {
          this.room = res.room;
          this.slot = res.slot;
        }
        resolve(res);
      })
    );
  }

  setTeamCount(n) {
    this.socket.emit('setTeamCount', n);
  }

  startMatch() {
    this.socket.emit('start');
  }

  leave() {
    this.socket?.emit('leave');
    this.room = null;
    this.slot = -1;
    this.game = null;
  }

  /** Hand this to Game as `game.net` when a match begins. */
  session(game) {
    this.game = game;
    const s = this.socket;
    const self = this;
    return {
      get isHost() {
        return self.isHost;
      },
      sendCommand: (cmd) => s.emit('cmd', cmd),
      sendPose: (pose) => s.emit('pose', pose),
      sendTurnEnd: (snap) => s.emit('turnEnd', snap),
    };
  }
}
