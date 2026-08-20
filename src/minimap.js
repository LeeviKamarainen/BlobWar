import * as THREE from 'three';
import { CFG } from './config.js';
import { clamp } from './noise.js';
import { paintHeightmapImage } from './heightmapImage.js';

/**
 * Two ways to look at the island.
 *
 * A small top-down map always sits in the corner. `M` blows it up to full screen,
 * where it has two modes: the same top-down chart — zoomable and pannable — or a
 * live 3D view from a camera orbiting high above the map. `Tab` swaps between
 * them while the full map is open.
 *
 * The top-down chart is drawn from the heightmap itself rather than from a
 * render, so it costs nothing per frame beyond a scaled drawImage: the island is
 * baked into a `dim × dim` offscreen canvas and only redrawn when the terrain
 * revision changes (a crater) or the sea moves (sudden death).
 */
export class Minimap {
  constructor({ game, scene, renderer }) {
    this.game = game;
    this.scene = scene;
    this.renderer = renderer;

    this.full = false;
    this.mode = '2d';

    // Set while the map is open specifically to place a weapon target (see
    // Game.onMapPick): 'point' for a strike location, 'blob' for a homing
    // lock. A plain browse-the-map open leaves this null.
    this.pickMode = null;
    this.onPick = null;

    // Top-down view state, in world units.
    this.zoom = 1;
    this.cx = 0;
    this.cz = 0;

    // Orbit state for the 3D view.
    this.yaw = 0.6;
    this.pitch = 0.85;
    this.dist = CFG.terrain.size * 1.25;
    this.camera = new THREE.PerspectiveCamera(46, 1, 1, 4000);
    this.lookAt = new THREE.Vector3(0, 10, 0);
    this.fog = new THREE.Fog(0x9fc4e8, 400, 1000);

    // Cached picture of the island.
    this.base = document.createElement('canvas');
    this.baseCtx = this.base.getContext('2d');
    this.baseTerrain = null;
    this.baseRev = -1;
    this.baseWater = NaN;
    this.rebuildIn = 0;

    this.el = {
      wrap: document.getElementById('minimap'),
      small: document.getElementById('minimapCanvas'),
      view: document.getElementById('mapView'),
      big: document.getElementById('mapCanvas'),
      hint: document.getElementById('mapHint'),
      modes: document.getElementById('mapModes'),
      close: document.getElementById('mapClose'),
    };
    this.smallCtx = this.el.small.getContext('2d');
    this.bigCtx = this.el.big.getContext('2d');
    this.smallSize = 152;
    this.bigSize = 600;

    // Team-coloured pillars, so blobs are findable from 300 units up.
    this.beacons = new THREE.Group();
    this.beacons.visible = false;
    scene.add(this.beacons);
    this.beaconGeo = new THREE.CylinderGeometry(0.45, 0.45, 16, 6);

    this.bindUI();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  // --- open / close ---------------------------------------------------------

  toggle() {
    this.full ? this.close() : this.open();
  }

  /** Open specifically to place a weapon target. `mode` is 'point' or 'blob'. */
  openForPick(mode, onPick) {
    this.pickMode = mode;
    this.onPick = onPick;
    if (this.mode !== '2d') this.setMode('2d');
    this.open();
  }

  open() {
    if (this.full || !this.game.terrain) return;
    this.full = true;
    this.resize();
    // Start looking at whoever is up, which matters once you're zoomed in.
    const b = this.game.activeBlob;
    if (b) {
      this.cx = b.position.x;
      this.cz = b.position.z;
    }
    this.clampCenter();
    this.el.view.classList.remove('hidden');
    document.getElementById('ui').classList.add('mapping');
    this.applyMode();
  }

  close() {
    if (!this.full) return;
    this.full = false;
    this.el.view.classList.add('hidden');
    document.getElementById('ui').classList.remove('mapping');
    this.beacons.visible = false;
    this.drag = null;
    this.pickMode = null;
    this.onPick = null;
  }

  setMode(mode) {
    this.mode = mode === '3d' ? '3d' : '2d';
    this.applyMode();
  }

  cycleMode() {
    this.setMode(this.mode === '2d' ? '3d' : '2d');
  }

  /** True while the frame loop should render from the orbit camera instead. */
  renders3D() {
    return this.full && this.mode === '3d';
  }

  applyMode() {
    const v = this.el.view;
    v.classList.toggle('mode3d', this.mode === '3d');
    v.classList.toggle('mode2d', this.mode === '2d');
    this.beacons.visible = this.full && this.mode === '3d';
    for (const b of this.el.modes.querySelectorAll('button')) {
      b.classList.toggle('on', b.dataset.v === this.mode);
    }
    this.el.hint.textContent = this.pickMode
      ? this.pickMode === 'blob'
        ? 'click an enemy to lock on · Esc to cancel'
        : 'click to set the target · Esc to cancel'
      : this.mode === '3d'
        ? 'drag or A/D to orbit · wheel to zoom · Tab for top-down'
        : 'drag or WASD to pan · wheel to zoom · Tab for 3D';
  }

  /** New match: forget where we were looking. */
  reset() {
    this.close();
    // The corner canvas is display:none before a match exists, so this is the
    // first moment it has a real laid-out size to back with device pixels.
    this.resize();
    this.mode = '2d';
    this.zoom = 1;
    this.cx = this.cz = 0;
    this.yaw = 0.6;
    this.pitch = 0.85;
    this.dist = CFG.terrain.size * 1.25;
    this.baseRev = -1;
    this.applyMode();
  }

  // --- input ----------------------------------------------------------------

  bindUI() {
    for (const b of this.el.modes.querySelectorAll('button')) {
      b.onclick = () => this.setMode(b.dataset.v);
    }
    this.el.close.onclick = () => this.close();
    this.el.wrap.onclick = () => this.open();

    const v = this.el.view;
    v.addEventListener('pointerdown', (e) => {
      if (e.target.closest('#mapBar')) return;
      this.drag = { x: e.clientX, y: e.clientY, moved: 0 };
      v.setPointerCapture(e.pointerId);
    });
    v.addEventListener('pointerup', (e) => {
      // A drag that barely moved reads as a click — resolve the pick from
      // where it landed rather than treating it as a pan that went nowhere.
      if (this.pickMode && this.drag && this.drag.moved < 6) this.resolvePick(e);
      this.drag = null;
      if (v.hasPointerCapture(e.pointerId)) v.releasePointerCapture(e.pointerId);
    });
    v.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const dx = e.clientX - this.drag.x;
      const dy = e.clientY - this.drag.y;
      this.drag.moved += Math.abs(dx) + Math.abs(dy);
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
      if (this.mode === '3d') this.orbit(dx, dy);
      else this.pan(dx, dy);
    });
    v.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoomBy(-Math.sign(e.deltaY));
      },
      { passive: false }
    );
  }

  /** A click landed while `pickMode` was set — resolve it to a world target. */
  resolvePick(e) {
    const rect = this.el.big.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * this.bigSize;
    const py = ((e.clientY - rect.top) / rect.height) * this.bigSize;
    const scale = (this.bigSize / CFG.terrain.size) * this.zoom;
    const wx = this.cx + (px - this.bigSize / 2) / scale;
    const wz = this.cz + (py - this.bigSize / 2) / scale;

    const game = this.game;
    let result = null;
    if (this.pickMode === 'blob') {
      const pxThreshold = 26;
      let bestD = pxThreshold / scale;
      for (const b of game.blobs) {
        if (!b.alive || b.team === game.activeTeam) continue;
        const d = Math.hypot(b.position.x - wx, b.position.z - wz);
        if (d < bestD) {
          bestD = d;
          result = b;
        }
      }
      if (!result) return void game.hud.toast('NO ENEMY THERE', '#ff6b6b', 800);
    } else if (this.pickMode === 'point') {
      if (!game.terrain.inBounds(wx, wz)) return void game.hud.toast('OFF THE MAP', '#ff6b6b', 800);
      result = { x: wx, z: wz };
    }

    const cb = this.onPick;
    this.close();
    cb?.(result);
  }

  /** Pan by a pixel delta on the big canvas. */
  pan(dx, dy) {
    const scale = (this.bigSize / CFG.terrain.size) * this.zoom;
    this.cx -= dx / scale;
    this.cz -= dy / scale;
    this.clampCenter();
  }

  orbit(dx, dy) {
    this.yaw -= dx * 0.006;
    this.pitch = clamp(this.pitch - dy * 0.004, 0.2, 1.45);
  }

  zoomBy(steps) {
    if (this.mode === '3d') {
      const t = CFG.terrain.size;
      this.dist = clamp(this.dist * Math.pow(0.88, steps), t * 0.45, t * 1.8);
    } else {
      this.zoom = clamp(this.zoom * Math.pow(1.25, steps), 1, 8);
      this.clampCenter();
    }
  }

  /** Keep the visible window over the island rather than out at sea. */
  clampCenter() {
    const half = CFG.terrain.size / 2;
    const room = Math.max(0, half - half / this.zoom);
    this.cx = clamp(this.cx, -room, room);
    this.cz = clamp(this.cz, -room, room);
  }

  // --- frame ----------------------------------------------------------------

  update(dt) {
    const t = this.game.terrain;
    if (!t || !t.heights) return;

    this.rebuildIn -= dt;
    const stale =
      this.baseTerrain !== t ||
      this.baseRev !== t.revision ||
      this.baseWater !== CFG.terrain.waterLevel;
    if (stale && this.rebuildIn <= 0) {
      this.baseTerrain = t;
      this.baseRev = t.revision;
      this.baseWater = CFG.terrain.waterLevel;
      this.redrawBase();
      // Craters arrive in bursts; one redraw every 200ms is plenty.
      this.rebuildIn = 0.2;
    }

    this.readKeys(dt);
    this.paint(this.smallCtx, this.smallSize, 1, 0, 0, true);
    if (this.full && this.mode === '2d') {
      this.paint(this.bigCtx, this.bigSize, this.zoom, this.cx, this.cz, false);
    }
    if (this.full && this.mode === '3d') this.updateBeacons();
  }

  /** WASD/arrows drive the map while it's open — movement is blocked anyway. */
  readKeys(dt) {
    if (!this.full) return;
    const i = this.game.input;
    let h = 0;
    let v = 0;
    if (i.down('a', 'left')) h -= 1;
    if (i.down('d', 'right')) h += 1;
    if (i.down('w', 'up')) v -= 1;
    if (i.down('s', 'down')) v += 1;
    if (!h && !v) return;

    if (this.mode === '3d') {
      this.yaw -= h * dt * 1.1;
      this.pitch = clamp(this.pitch - v * dt * 0.8, 0.2, 1.45);
    } else {
      const speed = (CFG.terrain.size * 0.42 * dt) / this.zoom;
      this.cx += h * speed;
      this.cz += v * speed;
      this.clampCenter();
    }
  }

  // --- the island image -----------------------------------------------------

  redrawBase() {
    const t = this.game.terrain;
    const dim = t.dim;
    if (this.base.width !== dim) this.base.width = this.base.height = dim;
    paintHeightmapImage(this.baseCtx, t, CFG.terrain.waterLevel);
  }

  // --- the top-down chart ---------------------------------------------------

  /**
   * World +x runs right, world +z runs down, so north (−z, matching the wind
   * compass) is up.
   */
  paint(ctx, size, zoom, cx, cz, small) {
    const game = this.game;
    const t = game.terrain;
    const scale = (size / t.size) * zoom;
    const ox = size / 2 - cx * scale;
    const oz = size / 2 - cz * scale;
    const X = (x) => ox + x * scale;
    const Y = (z) => oz + z * scale;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, size, size);
    ctx.clip();

    // Open water beyond the island's square.
    ctx.fillStyle = '#0b2c44';
    ctx.fillRect(0, 0, size, size);
    // One texel is one world unit, so past a few times magnification smoothing
    // is inventing detail that isn't there. Zoomed in, show the actual cells.
    ctx.imageSmoothingEnabled = small || zoom < 2.5;
    ctx.drawImage(this.base, X(-t.half), Y(-t.half), t.size * scale, t.size * scale);

    const dot = small ? 2.6 : 4.4;
    const pulse = 0.5 + 0.5 * Math.sin(game.time * 5);

    // Where the play camera is pointing, so the chart and the screen agree.
    const cam = game.camera;
    const dir = cam.getWorldDirection(_v);
    const camAngle = Math.atan2(dir.x, dir.z);
    const camLen = small ? 20 : 46;
    ctx.beginPath();
    ctx.moveTo(X(cam.position.x), Y(cam.position.z));
    for (const s of [-0.36, 0.36]) {
      ctx.lineTo(
        X(cam.position.x) + Math.sin(camAngle + s) * camLen,
        Y(cam.position.z) + Math.cos(camAngle + s) * camLen
      );
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fill();

    // Mines first — they belong under everything else.
    for (const m of game.mines) {
      if (m.dead) continue;
      ctx.beginPath();
      ctx.arc(X(m.position.x), Y(m.position.z), dot * 0.55, 0, TAU);
      ctx.fillStyle = m.armed ? '#ff5f4d' : '#8a5a0d';
      ctx.fill();
    }

    for (const c of game.crates) {
      if (c.dead) continue;
      const s = dot * 1.5;
      const px = X(c.position.x);
      const py = Y(c.position.z);
      ctx.fillStyle = c.type === 'health' ? '#35c95f' : '#f2a13c';
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 1.5;
      ctx.fillRect(px - s / 2, py - s / 2, s, s);
      ctx.strokeRect(px - s / 2, py - s / 2, s, s);
      // Still under the chute: ring it so you know it hasn't landed.
      if (!c.landed) {
        ctx.beginPath();
        ctx.arc(px, py, s * 1.3, 0, TAU);
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.stroke();
      }
    }

    for (const b of game.blobs) {
      if (!b.alive) continue;
      const px = X(b.position.x);
      const py = Y(b.position.z);
      const active = b === game.activeBlob;

      if (active) {
        ctx.beginPath();
        ctx.arc(px, py, dot + 2 + pulse * (small ? 2 : 4), 0, TAU);
        ctx.strokeStyle = `rgba(255,255,255,${0.25 + pulse * 0.5})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(px, py, active ? dot * 1.3 : dot, 0, TAU);
      ctx.fillStyle = b.team.def.css;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.stroke();

      if (!small) {
        // Health pip and name, once there's room for them.
        const w = 22;
        const frac = clamp(b.health / CFG.blob.maxHealth, 0, 1);
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(px - w / 2, py + dot + 4, w, 3);
        ctx.fillStyle = frac > 0.5 ? '#5ddb6a' : frac > 0.25 ? '#f3c33b' : '#e8503a';
        ctx.fillRect(px - w / 2, py + dot + 4, w * frac, 3);
      }
    }

    // Which way the active blob is aiming.
    const ab = game.activeBlob;
    if (ab && ab.alive && game.rig) {
      const a = game.rig.aimYaw;
      const len = small ? 13 : 26;
      ctx.beginPath();
      ctx.moveTo(X(ab.position.x), Y(ab.position.z));
      ctx.lineTo(X(ab.position.x) + Math.sin(a) * len, Y(ab.position.z) + Math.cos(a) * len);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.restore();

    // Frame, and a compass rose on the big chart.
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, size - 1, size - 1);

    if (!small) {
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.font = 'bold 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('N', size / 2, 20);
      ctx.beginPath();
      ctx.moveTo(size / 2, 26);
      ctx.lineTo(size / 2, 38);
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.stroke();

      // Scale bar: the nearest tidy number of world units to ~90 px.
      const units = niceUnits(90 / scale);
      const barW = units * scale;
      const y = size - 22;
      ctx.beginPath();
      ctx.moveTo(18, y);
      ctx.lineTo(18 + barW, y);
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.textAlign = 'left';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(`${units} units · ${this.zoom.toFixed(1)}×`, 18, y - 6);
    }
  }

  // --- the 3D view ----------------------------------------------------------

  updateBeacons() {
    const blobs = this.game.blobs;
    while (this.beacons.children.length < blobs.length) {
      const mesh = new THREE.Mesh(
        this.beaconGeo,
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5, depthWrite: false })
      );
      this.beacons.add(mesh);
    }
    this.beacons.children.forEach((mesh, i) => {
      const b = blobs[i];
      mesh.visible = !!b && b.alive;
      if (!mesh.visible) return;
      mesh.position.set(b.position.x, b.position.y + 9, b.position.z);
      mesh.material.color.set(b.team.def.color);
      mesh.material.opacity = b === this.game.activeBlob ? 0.85 : 0.4;
    });
  }

  /**
   * Render the scene from the orbit camera.
   *
   * The play fog starts at 300 units and the island sits further away than that
   * from up here, so it would haze over the whole map. The shot gets its own fog
   * scaled to the orbit distance instead: clear across the island, closing in
   * beyond it for a bit of aerial perspective.
   */
  render3D() {
    const cam = this.camera;
    const cp = Math.cos(this.pitch);
    cam.aspect = window.innerWidth / window.innerHeight;
    cam.position.set(
      this.lookAt.x + Math.sin(this.yaw) * cp * this.dist,
      this.lookAt.y + Math.sin(this.pitch) * this.dist,
      this.lookAt.z + Math.cos(this.yaw) * cp * this.dist
    );
    cam.updateProjectionMatrix();
    cam.lookAt(this.lookAt);

    const fog = this.scene.fog;
    this.fog.near = this.dist * 1.1;
    this.fog.far = this.dist * 2.4;
    this.scene.fog = this.fog;
    this.renderer.render(this.scene, cam);
    this.scene.fog = fog;
  }

  // --- sizing ---------------------------------------------------------------

  resize() {
    this.smallSize = this.el.small.clientWidth || 152;
    fit(this.el.small, this.smallCtx, this.smallSize);

    this.bigSize = Math.round(Math.min(window.innerWidth, window.innerHeight) * 0.82);
    this.el.big.style.width = `${this.bigSize}px`;
    this.el.big.style.height = `${this.bigSize}px`;
    fit(this.el.big, this.bigCtx, this.bigSize);
  }
}

/** Back the canvas with real device pixels so the chart isn't a blurry mess. */
function fit(canvas, ctx, cssSize) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(cssSize * dpr);
  canvas.height = Math.round(cssSize * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
}

function niceUnits(raw) {
  const steps = [10, 20, 25, 50, 100, 200];
  for (const s of steps) if (raw <= s) return s;
  return 280;
}

const TAU = Math.PI * 2;
const _v = new THREE.Vector3();
