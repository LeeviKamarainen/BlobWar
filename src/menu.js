import { CFG } from './config.js';
import { MAPS, MAP_ORDER, DEFAULT_MAP } from './maps.js';
import { mapPreviewUrl } from './mapPreview.js';
import { WEAPONS, WEAPON_ORDER, CORE_WEAPONS } from './weapons.js';

/**
 * Front end: title, local setup, online host/join, lobby, controls reference and
 * an in-match pause screen. Everything lives in the one #overlay element; each
 * screen is a render function returning HTML plus a wiring callback.
 */
export class Menu {
  constructor({ overlay, net, onStartLocal, onStartOnline, onStartPractice, onResume, onQuit }) {
    this.overlay = overlay;
    this.net = net;
    this.onStartLocal = onStartLocal;
    this.onStartOnline = onStartOnline;
    this.onStartPractice = onStartPractice;
    this.onResume = onResume;
    this.onQuit = onQuit;

    this.name = localStorage.getItem('blobwar.name') || '';
    this.teamCount = CFG.defaultTeamCount;
    this.opponents = 'ai';
    this.mapId = DEFAULT_MAP;
    this.gravityId = CFG.defaultGravityPreset;
    this.disabledWeapons = new Set();
    this.visible = true;
    this.screen = 'title';

    net.on('room', () => {
      if (this.screen === 'lobby') this.render();
    });
    net.on('peerJoined', (p) => {
      if (this.screen === 'lobby') this.toastLobby(`${p.name} joined`);
    });
    net.on('peerLeft', (p) => {
      if (this.screen === 'lobby') this.toastLobby(`${p.name} left`);
    });
    net.on('disconnected', () => {
      if (this.visible) this.show('title', { error: 'Lost connection to the server.' });
    });
  }

  // --- plumbing -------------------------------------------------------------

  show(screen, data = {}) {
    this.screen = screen;
    this.data = data;
    this.visible = true;
    this.overlay.classList.remove('hidden');
    this.syncHud();
    this.render();
  }

  hide() {
    this.visible = false;
    this.overlay.classList.add('hidden');
    this.syncHud();
  }

  /** Hide the in-match HUD behind the pre-game screens; keep it during pause. */
  syncHud() {
    document
      .getElementById('ui')
      .classList.toggle('preGame', this.visible && this.screen !== 'pause');
  }

  render() {
    const build = this[`screen_${this.screen}`];
    if (!build) return;
    this.overlay.innerHTML = `<div class="card panel">${build.call(this)}</div>`;
    this[`wire_${this.screen}`]?.call(this);
    // Shared: any element with data-go navigates to that screen.
    for (const el of this.overlay.querySelectorAll('[data-go]')) {
      el.addEventListener('click', () => this.show(el.dataset.go));
    }
  }

  $(sel) {
    return this.overlay.querySelector(sel);
  }

  rememberName() {
    const input = this.$('#pname');
    if (input) {
      this.name = input.value.trim().slice(0, 16) || 'Player';
      localStorage.setItem('blobwar.name', this.name);
    }
    return this.name || 'Player';
  }

  toastLobby(text) {
    const el = this.$('#lobbyNote');
    if (el) el.textContent = text;
  }

  err(msg) {
    const el = this.$('#err');
    if (el) el.textContent = msg;
  }

  // --- screens --------------------------------------------------------------

  screen_title() {
    return `
      <h1>BLOB WAR 3D</h1>
      <p>Turn-based artillery on a big destructible island. Sixteen weapons, supply
         crates parachuting in, and a great many ways to end up in the sea.</p>
      ${this.data?.error ? `<p style="color:#ff6b6b">${this.data.error}</p>` : ''}
      <div class="modes">
        <button data-go="local">LOCAL GAME</button>
        <button data-go="online" class="alt">PLAY ONLINE</button>
        <button id="practice" class="alt">PRACTICE RANGE</button>
        <button data-go="help" class="alt">HOW TO PLAY</button>
      </div>
      <p class="fine">Practice Range: flat, solo, unlimited ammo — try every weapon with nothing shooting back.</p>`;
  }

  wire_title() {
    this.$('#practice').onclick = () => this.onStartPractice();
  }

  screen_local() {
    return `
      <h2>LOCAL GAME</h2>
      <p>Everyone plays on this machine — against the computer, or passing the
         mouse around.</p>
      <div class="setup">
        <label>Squads</label>
        <div class="seg" id="segTeams">${this.segButtons(2, CFG.maxTeams, this.teamCount)}</div>
        <label>Opponents</label>
        <div class="seg" id="segOpp">
          <button data-v="ai" class="${this.opponents === 'ai' ? 'on' : ''}">Computer</button>
          <button data-v="human" class="${this.opponents === 'human' ? 'on' : ''}">Hotseat</button>
        </div>
        <label>Map</label>
        <div class="mapGrid" id="segMap">${this.mapButtons()}</div>
        <label>Gravity</label>
        <div class="seg" id="segGrav">${this.gravButtons()}</div>
        <label>Weapons</label>
        <div class="wgrid" id="wepGrid">${this.weaponChips()}</div>
      </div>
      <p class="fine" id="mapDesc">${escapeHtml(MAPS[this.mapId].desc)}</p>
      <p class="fine" id="localNote"></p>
      <div class="modes">
        <button id="go">START</button>
        <button data-go="title" class="alt">BACK</button>
      </div>`;
  }

  wire_local() {
    const refresh = () => {
      const blobs = CFG.blobsFor(this.teamCount);
      const note =
        this.opponents === 'human'
          ? `${this.teamCount} human squads taking turns on this keyboard.`
          : `You against ${this.teamCount - 1} computer squad${this.teamCount > 2 ? 's' : ''}.`;
      this.$('#localNote').textContent = `${note} ${blobs} blobs each.`;
    };
    this.segWire('#segTeams', (v) => {
      this.teamCount = +v;
      this.render();
    });
    this.segWire('#segOpp', (v) => {
      this.opponents = v;
      this.render();
    });
    this.segWire('#segMap', (v) => {
      this.mapId = v;
      this.render();
    });
    this.segWire('#segGrav', (v) => {
      this.gravityId = v;
      this.render();
    });
    this.wireWeaponChips('#wepGrid');
    refresh();
    this.$('#go').onclick = () => {
      const ai = [];
      if (this.opponents !== 'human') for (let i = 1; i < this.teamCount; i++) ai.push(i);
      this.onStartLocal({
        teamCount: this.teamCount,
        aiTeams: ai,
        mapId: this.mapId,
        gravity: this.gravityValue(),
        weapons: this.enabledWeaponList(),
      });
    };
  }

  screen_online() {
    return `
      <h2>PLAY ONLINE</h2>
      <p>One player hosts and shares the room code. Two to ${CFG.maxTeams} squads.</p>
      <div class="setup">
        <label>Your name</label>
        <input id="pname" maxlength="16" placeholder="Player" value="${escapeHtml(this.name)}" />
        <label>Squads</label>
        <div class="seg" id="segTeams">${this.segButtons(2, CFG.maxTeams, this.teamCount)}</div>
        <label>Room code</label>
        <input id="code" maxlength="4" placeholder="ABCD" style="text-transform:uppercase" />
        <label>Map</label>
        <div class="mapGrid" id="segMap">${this.mapButtons()}</div>
        <label>Gravity</label>
        <div class="seg" id="segGrav">${this.gravButtons()}</div>
        <label>Weapons</label>
        <div class="wgrid" id="wepGrid">${this.weaponChips()}</div>
      </div>
      <p class="fine">Map, gravity and weapons only matter if you host — joining a room uses the host's settings.</p>
      <p class="fine" id="err"></p>
      <div class="modes">
        <button id="host">HOST A ROOM</button>
        <button id="join" class="alt">JOIN WITH CODE</button>
        <button data-go="title" class="alt">BACK</button>
      </div>`;
  }

  wire_online() {
    this.segWire('#segTeams', (v) => {
      this.teamCount = +v;
      this.render();
    });
    this.segWire('#segMap', (v) => {
      this.mapId = v;
      this.render();
    });
    this.segWire('#segGrav', (v) => {
      this.gravityId = v;
      this.render();
    });
    this.wireWeaponChips('#wepGrid');

    const connect = async () => {
      this.err('Connecting…');
      try {
        await this.net.connect();
        return true;
      } catch (e) {
        this.err(e.message);
        return false;
      }
    };

    this.$('#host').onclick = async () => {
      const name = this.rememberName();
      if (!(await connect())) return;
      const res = await this.net.createRoom(name, this.teamCount, {
        mapId: this.mapId,
        gravity: this.gravityValue(),
        weapons: this.enabledWeaponList(),
      });
      if (!res?.ok) return this.err(res?.error || 'Could not create the room.');
      this.show('lobby');
    };

    this.$('#join').onclick = async () => {
      const name = this.rememberName();
      const code = this.$('#code').value.trim().toUpperCase();
      if (code.length !== 4) return this.err('Enter the four-character room code.');
      if (!(await connect())) return;
      const res = await this.net.joinRoom(code, name);
      if (!res?.ok) return this.err(res?.error || 'Could not join.');
      this.show('lobby');
    };
  }

  screen_lobby() {
    const room = this.net.room;
    if (!room) return '<h2>LOBBY</h2><p>Disconnected.</p>';
    const host = this.net.isHost;
    const slots = [];
    for (let i = 0; i < room.players.length; i++) {
      const p = room.players[i];
      const def = CFG.teams[i];
      slots.push(`
        <div class="slot">
          <span class="dot" style="background:${def.css}"></span>
          <span class="who">${escapeHtml(p.name)}${p.isHost ? ' <em>host</em>' : ''}</span>
          <span class="sq" style="color:${def.css}">${def.name}</span>
        </div>`);
    }
    const waiting = Math.max(0, 2 - room.players.length);
    return `
      <h2>ROOM ${room.code}</h2>
      <p>Share this code: <b class="code">${room.code}</b></p>
      <div class="slots">${slots.join('')}</div>
      <p class="fine" id="lobbyNote">${
        waiting > 0 ? 'Waiting for at least one more player…' : 'Ready when the host is.'
      }</p>
      <div class="modes">
        ${host ? `<button id="go" ${room.players.length < 2 ? 'disabled' : ''}>START MATCH</button>` : ''}
        <button id="leave" class="alt">LEAVE</button>
      </div>`;
  }

  wire_lobby() {
    const go = this.$('#go');
    if (go) go.onclick = () => this.net.startMatch();
    this.$('#leave').onclick = () => {
      this.net.leave();
      this.show('title');
    };
  }

  screen_help() {
    return `
      <h2>HOW TO PLAY</h2>
      <div class="keys">
        <span>Move</span><span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> (camera-relative)</span>
        <span>Jump</span><span><kbd>J</kbd></span>
        <span>Aim</span><span>drag with the left mouse button</span>
        <span>Free look</span><span>drag with the right mouse button · <kbd>C</kbd> recenters</span>
        <span>Fire</span><span>hold <kbd>Space</kbd> to build power, release to launch</span>
        <span>Armory</span><span><kbd>Tab</kbd> to browse · <kbd>Q</kbd><kbd>E</kbd> to cycle · <kbd>1</kbd>–<kbd>9</kbd> quick slots</span>
        <span>Map</span><span><kbd>M</kbd> opens it full screen · <kbd>Tab</kbd> swaps top-down for 3D orbit</span>
        <span>Supplies</span><span>walk over a parachuted crate to grab it</span>
        <span>Skip turn</span><span><kbd>N</kbd></span>
        <span>Mute</span><span><kbd>K</kbd></span>
        <span>Pause</span><span><kbd>Esc</kbd></span>
      </div>
      <p>Blast the other squads off the island, or into the sea. If nobody has won by
         turn ${CFG.turn.suddenDeathTurn}, sudden death drops everyone to
         ${CFG.turn.suddenDeathHealth} health and the tide starts rising.</p>
      <div class="modes"><button data-go="title">BACK</button></div>`;
  }

  screen_pause() {
    return `
      <h2>PAUSED</h2>
      <p class="fine">${this.net.room ? 'Online match — the clock keeps running for other players.' : 'Local match.'}</p>
      <div class="modes">
        <button id="resume">RESUME</button>
        <button data-go="help" class="alt">CONTROLS</button>
        <button id="quit" class="alt">QUIT TO MENU</button>
      </div>`;
  }

  wire_pause() {
    this.$('#resume').onclick = () => this.onResume();
    this.$('#quit').onclick = () => this.onQuit();
  }

  // --- match setup: map / gravity / weapons ---------------------------------

  mapButtons() {
    return MAP_ORDER.map((id) => {
      const m = MAPS[id];
      return `
        <button data-v="${id}" class="mapCard ${id === this.mapId ? 'on' : ''}">
          <img src="${mapPreviewUrl(id)}" alt="${escapeHtml(m.name)}" />
          <span>${escapeHtml(m.name)}</span>
        </button>`;
    }).join('');
  }

  gravButtons() {
    return CFG.gravityPresets
      .map((p) => `<button data-v="${p.id}" class="${p.id === this.gravityId ? 'on' : ''}">${p.name}</button>`)
      .join('');
  }

  gravityValue() {
    return (CFG.gravityPresets.find((p) => p.id === this.gravityId) ?? CFG.gravityPresets[1]).value;
  }

  /** Every weapon still on, beyond the two that can't be turned off. */
  enabledWeaponList() {
    return WEAPON_ORDER.filter((id) => !CORE_WEAPONS.includes(id) && !this.disabledWeapons.has(id));
  }

  weaponChips() {
    const core = CORE_WEAPONS.map(
      (id) => `<span class="wchip locked" title="Always available">${WEAPONS[id].icon} ${escapeHtml(WEAPONS[id].name)}</span>`
    ).join('');
    const rest = WEAPON_ORDER.filter((id) => !CORE_WEAPONS.includes(id))
      .map((id) => {
        const w = WEAPONS[id];
        const off = this.disabledWeapons.has(id) ? ' off' : '';
        return `<button type="button" data-w="${id}" class="wchip${off}" title="${escapeHtml(w.desc)}">${w.icon} ${escapeHtml(w.name)}</button>`;
      })
      .join('');
    return core + rest;
  }

  wireWeaponChips(sel) {
    const box = this.$(sel);
    if (!box) return;
    for (const b of box.querySelectorAll('button[data-w]')) {
      b.addEventListener('click', () => {
        const id = b.dataset.w;
        if (this.disabledWeapons.has(id)) this.disabledWeapons.delete(id);
        else this.disabledWeapons.add(id);
        b.classList.toggle('off');
      });
    }
  }

  // --- small helpers --------------------------------------------------------

  segButtons(min, max, active) {
    let out = '';
    for (let i = min; i <= max; i++) {
      out += `<button data-v="${i}" class="${i === active ? 'on' : ''}">${i}</button>`;
    }
    return out;
  }

  segWire(sel, fn) {
    const box = this.$(sel);
    if (!box) return;
    for (const b of box.querySelectorAll('button')) {
      b.addEventListener('click', () => fn(b.dataset.v));
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}
