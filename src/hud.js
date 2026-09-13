import { CFG } from './config.js';
import { WEAPONS, WEAPON_ORDER, QUICK_SLOTS, CATEGORIES, CORE_WEAPONS } from './weapons.js';

/** Thin wrapper over the DOM overlay. The game pushes state, this draws it. */
export class HUD {
  constructor() {
    this.el = {
      turnTeam: document.getElementById('turnTeam'),
      turnBlob: document.getElementById('turnBlob'),
      timer: document.getElementById('timer'),
      windArrow: document.getElementById('windArrow'),
      windFill: document.getElementById('windFill'),
      windVal: document.getElementById('windVal'),
      roster: document.getElementById('roster'),
      curIcon: document.getElementById('curIcon'),
      curName: document.getElementById('curName'),
      curAmmo: document.getElementById('curAmmo'),
      inventory: document.getElementById('inventory'),
      powerFill: document.getElementById('powerFill'),
      angleRead: document.getElementById('angleRead'),
      powerHint: document.getElementById('powerHint'),
      log: document.getElementById('log'),
      toast: document.getElementById('toast'),
      overlay: document.getElementById('overlay'),
      powerBox: document.getElementById('powerBox'),
      help: document.getElementById('help'),
      reticle: document.getElementById('reticle'),
    };
    this.rows = new Map();
    this.logLines = [];
    this.inventoryOpen = false;
    this.onPick = null;
    this.buildInventory();
  }

  /** Real-time adds Space-to-jump and character-switching on top of the shared aim/fire scheme. */
  setControlScheme(realtime) {
    this.el.help.innerHTML = realtime
      ? '<kbd>WASD</kbd> move · <kbd>Shift</kbd> switch character · <kbd>Space</kbd> jump · <kbd>right-drag</kbd> aim · <kbd>click</kbd> fire · <kbd>ctrl</kbd>+<kbd>right-drag</kbd> look · <kbd>wheel</kbd> zoom · <kbd>Tab</kbd> armory · <kbd>Q</kbd><kbd>E</kbd> cycle weapon · <kbd>M</kbd> map · <kbd>K</kbd> mute'
      : '<kbd>WASD</kbd> move · <kbd>J</kbd> jump · <kbd>right-drag</kbd> aim · <kbd>click</kbd> fire · <kbd>ctrl</kbd>+<kbd>right-drag</kbd> look · <kbd>wheel</kbd> zoom · <kbd>Tab</kbd> armory · <kbd>Q</kbd><kbd>E</kbd> cycle weapon · <kbd>M</kbd> map · <kbd>N</kbd> skip · <kbd>K</kbd> mute';
  }

  // --- armory ---------------------------------------------------------------

  /** @param {Set<string>|null} enabledIds  weapons this match allows; null = all. */
  buildInventory(enabledIds = null) {
    const inv = this.el.inventory;
    inv.innerHTML = '<h2>ARMORY</h2><div class="sub">click to equip · <b>Tab</b> closes · <b>Q</b>/<b>E</b> cycles</div>';
    this.invEls = {};

    for (const cat of CATEGORIES) {
      const ids = WEAPON_ORDER.filter(
        (id) => WEAPONS[id].category === cat.id && (!enabledIds || CORE_WEAPONS.includes(id) || enabledIds.has(id))
      );
      if (!ids.length) continue;
      const box = document.createElement('div');
      box.className = 'invCat';
      const h = document.createElement('h4');
      h.textContent = cat.name;
      box.appendChild(h);
      const grid = document.createElement('div');
      grid.className = 'invGrid';

      for (const id of ids) {
        const w = WEAPONS[id];
        const slot = QUICK_SLOTS.indexOf(id);
        const item = document.createElement('div');
        item.className = 'invItem';
        item.innerHTML =
          `<span class="ic">${w.icon}</span>` +
          `<span class="tx"><span class="nm"></span><div class="ds"></div></span>` +
          `<span class="am"></span>`;
        item.querySelector('.nm').textContent = slot >= 0 ? `${slot + 1}. ${w.name}` : w.name;
        item.querySelector('.ds').textContent = w.desc;
        item.title = w.desc;
        item.onclick = () => {
          if (this.onPick) this.onPick(id);
        };
        grid.appendChild(item);
        this.invEls[id] = item;
      }
      box.appendChild(grid);
      inv.appendChild(box);
    }
  }

  toggleInventory(open) {
    this.inventoryOpen = open ?? !this.inventoryOpen;
    this.el.inventory.classList.toggle('hidden', !this.inventoryOpen);
  }

  updateInventory(ammo, selected) {
    for (const id of WEAPON_ORDER) {
      const el = this.invEls[id];
      if (!el) continue;
      const n = ammo[id];
      el.classList.toggle('sel', id === selected);
      el.classList.toggle('out', n <= 0);
      el.querySelector('.am').textContent = n === Infinity ? '∞' : n;
    }
    this.setCurrentWeapon(selected, ammo[selected]);
  }

  setCurrentWeapon(id, count) {
    const w = WEAPONS[id];
    if (!w) return;
    this.el.curIcon.textContent = w.icon;
    this.el.curName.textContent = w.name;
    this.el.curAmmo.textContent = count === Infinity ? 'unlimited' : `${count} left`;
    const key = 'click';
    this.el.powerHint.innerHTML =
      w.delivery === 'burrow' || w.delivery === 'drill'
        ? `Hold <kbd>${key}</kbd> to dig, release to stop`
        : w.noCharge
          ? `Press <kbd>${key}</kbd> to use`
          : `Hold <kbd>${key}</kbd> to charge, release to fire`;
  }

  // --- roster ---------------------------------------------------------------

  buildRoster(teams) {
    this.el.roster.innerHTML = '';
    this.rows.clear();
    for (const team of teams) {
      const box = document.createElement('div');
      box.className = 'team panel';
      const h = document.createElement('h3');
      h.textContent = team.def.name;
      h.style.color = team.def.css;
      box.appendChild(h);
      for (const blob of team.blobs) {
        const row = document.createElement('div');
        row.className = 'blobRow';
        row.innerHTML = `<span class="nm"></span><span class="bar"><i></i></span><span class="hp"></span>`;
        row.querySelector('.nm').textContent = blob.name;
        box.appendChild(row);
        this.rows.set(blob, row);
      }
      this.el.roster.appendChild(box);
    }
  }

  updateRoster(activeBlob) {
    for (const [blob, row] of this.rows) {
      const frac = blob.health / CFG.blob.maxHealth;
      const bar = row.querySelector('.bar i');
      bar.style.width = `${Math.max(0, frac) * 100}%`;
      bar.style.background = frac > 0.5 ? '#5ddb6a' : frac > 0.25 ? '#f3c33b' : '#e8503a';
      row.querySelector('.hp').textContent = blob.alive ? blob.health : '☠';
      row.classList.toggle('dead', !blob.alive);
      row.classList.toggle('active', blob === activeBlob);
    }
  }

  /**
   * Two-tier highlight matching the maps (see Game.highlightBlobs): `mine`
   * gets the strong treatment, everything in `watch` gets the subdued one.
   */
  updateHighlights({ mine, watch }) {
    for (const [blob, row] of this.rows) {
      row.classList.toggle('mine-current', blob === mine);
      row.classList.toggle('next-up', blob !== mine && watch.includes(blob));
    }
  }

  // --- turn state -----------------------------------------------------------

  setTurn(team, blob, isAI) {
    this.el.turnTeam.textContent = team.label ?? team.def.name;
    this.el.turnTeam.style.color = team.def.css;
    this.el.turnBlob.textContent = isAI ? `${blob.name} (computer)` : blob.name;
  }

  /** Online: make it obvious whether you're playing or watching. */
  setTurnOwner(team, isMine, label) {
    const banner = document.getElementById('banner');
    banner.classList.toggle('waiting', label !== null && !isMine);
    if (label !== null && !isMine) {
      this.el.turnBlob.textContent = `${label} is playing…`;
    }
  }

  setTimer(seconds, mode = 'run') {
    if (mode === 'off') {
      this.el.timer.textContent = '—';
      this.el.timer.classList.remove('low');
      this.el.timer.style.color = '';
      return;
    }
    const s = seconds === Infinity ? '∞' : Math.max(0, Math.ceil(seconds));
    this.el.timer.textContent = mode === 'retreat' ? `RUN ${s}` : s;
    this.el.timer.style.color = mode === 'retreat' ? '#ffd166' : '';
    this.el.timer.classList.toggle('low', mode === 'run' && s !== '∞' && s <= 5);
  }

  setWind(wind) {
    const mag = Math.hypot(wind.x, wind.z);
    const pct = Math.min(100, (mag / CFG.wind.max) * 100);
    this.el.windFill.style.width = `${pct}%`;
    const deg = (Math.atan2(wind.x, -wind.z) * 180) / Math.PI;
    this.el.windArrow.style.transform = `rotate(${deg}deg)`;
    this.el.windArrow.textContent = '↑';
    this.el.windVal.textContent = mag < 0.4 ? 'calm' : `${mag.toFixed(1)} · ${compass(wind)}`;
  }

  setPower(fraction, angleDeg, charging) {
    this.el.powerFill.style.width = `${Math.round(fraction * 100)}%`;
    this.el.angleRead.textContent =
      `angle ${angleDeg.toFixed(0)}° · power ${Math.round(fraction * 100)}%${charging ? ' ▲' : ''}`;
  }

  setControlsVisible(on) {
    this.el.powerBox.classList.toggle('hidden', !on);
    this.el.help.classList.toggle('hidden', !on);
    this.el.reticle.classList.toggle('hidden', !on);
  }

  log(text) {
    this.logLines.push(text);
    if (this.logLines.length > 5) this.logLines.shift();
    this.el.log.innerHTML = '';
    for (const line of this.logLines) {
      const d = document.createElement('div');
      d.textContent = line;
      this.el.log.appendChild(d);
    }
  }

  toast(text, color = '#ffffff', ms = 1500) {
    this.el.toast.textContent = text;
    this.el.toast.style.color = color;
    this.el.toast.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.el.toast.classList.remove('show'), ms);
  }

  showOverlay(html) {
    this.el.overlay.innerHTML = `<div class="card panel">${html}</div>`;
    this.el.overlay.classList.remove('hidden');
    return this.el.overlay;
  }

  hideOverlay() {
    this.el.overlay.classList.add('hidden');
  }
}

function compass(wind) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const a = Math.atan2(wind.x, -wind.z);
  const idx = Math.round(((a + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
  return dirs[idx];
}
