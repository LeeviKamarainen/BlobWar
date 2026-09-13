import * as THREE from 'three';
import { CFG } from './config.js';
import { WEAPONS, WEAPON_ORDER, QUICK_SLOTS, startingAmmo, practiceAmmo } from './weapons.js';
import { Terrain } from './terrain.js';
import { MAPS, DEFAULT_MAP } from './maps.js';
import { CUSTOM_MAP_ID, customMapDef } from './customMap.js';
import { Blob, separateBlobs } from './blob.js';
import { Projectile, simulateTrajectory } from './projectile.js';
import { Mine } from './mine.js';
import { Crate, chooseDropSite, rollLoot } from './crate.js';
import { CameraRig, AimState } from './cameraRig.js';
import { FX } from './fx.js';
import { planShot } from './ai.js';
import { clamp } from './noise.js';
import { RNG } from './rng.js';

const STATE = {
  IDLE: 'idle',
  AIM: 'aim',
  FLIGHT: 'flight',
  RETREAT: 'retreat',
  SETTLE: 'settle',
  // Real-time mode: every team's current blob can move/aim/fire at once, for
  // the whole match. There's no per-turn AIM/FLIGHT/RETREAT/SETTLE handoff —
  // see updateRealtime() — so this one state covers the whole thing.
  PLAY: 'play',
  OVER: 'over',
};

/**
 * Real-time mode's per-team "what today's Game singular fields hold" — see
 * Game.runInTeamContext. Turn-based mode never touches team.rt; these same
 * names are the actual singular fields on Game while a team's turn/context is
 * loaded (either because it's the local player's resting context, or because
 * runInTeamContext just swapped it in).
 */
const RT_FIELDS = [
  'selectedWeapon',
  'power',
  'charging',
  'chargeDir',
  'digging',
  'digTimer',
  'digTickAt',
  'digDest',
  'shotsLeft',
  'fireCooldown',
  'wallRotation',
  'mapTarget',
  'mapHomingTarget',
  'burst',
  'aiPhase',
  'aiTimer',
  'aiPlan',
  'aiWalkTimer',
  'aiCrate',
];

function makeTeamRT() {
  return {
    selectedWeapon: 'bazooka',
    power: CFG.shot.minPower,
    charging: false,
    chargeDir: 1,
    digging: false,
    digTimer: 0,
    digTickAt: 0,
    digDest: null,
    shotsLeft: 0,
    fireCooldown: 0,
    wallRotation: null,
    mapTarget: null,
    mapHomingTarget: null,
    burst: null,
    aiPhase: 'aim',
    aiTimer: CFG.turn.aiThinkTime,
    aiPlan: undefined,
    aiWalkTimer: 0,
    aiCrate: null,
    // Stand-in for the real CameraRig while this team's context is loaded —
    // see Game.runInTeamContext. Created lazily there.
    shadowRig: null,
  };
}

export class Game {
  constructor({ scene, camera, hud, audio, input }) {
    this.scene = scene;
    this.camera = camera;
    this.hud = hud;
    this.audio = audio;
    this.input = input;

    this.fx = new FX(scene);
    this.wind = new THREE.Vector3();
    this.projectiles = [];
    this.mines = [];
    this.crates = [];
    this.blobs = [];
    this.teams = [];
    this.state = STATE.IDLE;
    this.time = 0;
    this.shotsLeft = 0;
    this.burst = null;
    this.fireCooldown = 0;
    this.previewImpact = null;
    this.rng = new RNG(1);
    this.poseTimer = 0;
    this.acc = 0;
    this.wasAiming = false;
    this.aiming = false;
    this.digging = false;
    this.digTimer = 0;
    this.digDest = null;
    // Absolute world-yaw the wall builder's ridge runs along. Null means
    // "not set yet" — updatePreview picks a default (perpendicular to aim)
    // the first time it previews a build, then the wheel adjusts it from there.
    this.wallRotation = null;

    // Set by main.js once the renderer exists.
    this.minimap = null;

    // Networking hooks. `net` is set by the online session; when it's null the
    // game behaves exactly as it always has.
    this.net = null;
    this.localTeams = null; // null = every non-AI team is played on this machine

    // Real-time mode. See runInTeamContext/updateRealtime.
    this.realtime = false;
    this.myTeamIndex = null;
    this.matchTime = 0;
    this.crateTimer = 0;

    this.buildAimPreview();
    this.bindInput();
    this.hud.onPick = (id) => this.selectWeapon(id, true);
  }

  // --- setup ----------------------------------------------------------------

  /**
   * Begin a match.
   *
   * @param {object} opts
   *   seed         shared across every client in an online match
   *   teamCount    2..CFG.maxTeams
   *   blobsPerTeam defaults to CFG.blobsFor(teamCount)
   *   aiTeams      team indices played by the computer
   *   localTeams   team indices this machine controls (null = all non-AI teams)
   *   labels       optional per-team display names (online player names)
   *   mapId        key into MAPS, or 'custom' (default: DEFAULT_MAP)
   *   customMap    { name, noiseAmount, heights } — required when mapId is 'custom';
   *                the caller resolves this (from localStorage locally, or from the
   *                host's relayed settings online) since Game doesn't touch storage
   *   gravity      numeric override for CFG.physics.gravity
   *   enabledWeapons  array of extra weapon ids allowed beyond the core two
   *                   (null/omitted = every weapon)
   *   realtime     every team's current blob can act simultaneously, all
   *                match — no turn order at all. See runInTeamContext.
   */
  start(opts = {}) {
    const {
      seed = Math.floor(Math.random() * 100000),
      teamCount = CFG.defaultTeamCount,
      aiTeams = [],
      localTeams = null,
      labels = null,
      mode = 'local',
      mapId = DEFAULT_MAP,
      customMap = null,
      gravity = CFG.gravityPresets.find((p) => p.id === CFG.defaultGravityPreset).value,
      enabledWeapons = null,
      realtime = false,
    } = opts;

    this.mode = mode;
    this.practice = mode === 'practice';
    this.realtime = realtime && !this.practice;
    this.seed = seed;
    this.localTeams = localTeams;
    // An explicit array (even empty — everything turned off but the core two) is
    // a real restriction; only a missing/null value means "every weapon".
    this.enabledWeapons = Array.isArray(enabledWeapons) ? new Set(enabledWeapons) : null;
    this.lastOptions = { ...opts };
    this.rng.reset(seed);
    this.teardown();

    CFG.physics.gravity = gravity;

    // Practice Range is a solo sandbox: one squad, nobody to fight, nothing to
    // clamp to the usual 2-team minimum.
    const count = this.practice ? 1 : clamp(teamCount, 2, CFG.teams.length);
    const perTeam = opts.blobsPerTeam ?? (this.practice ? 1 : CFG.blobsFor(count));

    const mapDef =
      mapId === CUSTOM_MAP_ID && customMap ? customMapDef(customMap) : (MAPS[mapId] ?? MAPS[DEFAULT_MAP]);
    this.terrain = new Terrain(seed, mapDef);
    this.scene.add(this.terrain.mesh);

    if (!this.rig) this.rig = new CameraRig(this.camera, this.terrain);
    else this.rig.terrain = this.terrain;

    const total = count * perTeam;
    // Spacing has to shrink as the island fills up, or spawn placement fails.
    const minDist = Math.max(20, 118 / Math.sqrt(total));
    const spawns = this.terrain.findSpawnPoints(total, seed + 5, minDist);

    this.teams = CFG.teams.slice(0, count).map((def, i) => ({
      ...def,
      def,
      index: i,
      label: labels?.[i] ?? null,
      blobs: [],
      ammo: this.practice ? practiceAmmo() : startingAmmo(this.enabledWeapons),
      isAI: aiTeams.includes(i),
      rt: this.realtime ? makeTeamRT() : null,
    }));

    this.myTeamIndex = this.realtime
      ? (localTeams?.[0] ?? this.teams.findIndex((t) => !t.isAI))
      : null;

    // Interleave spawns so no squad gets the whole good half of the island.
    for (let i = 0; i < total; i++) {
      const team = this.teams[i % count];
      const idx = Math.floor(i / count);
      const blob = new Blob(this, team, team.def.names[idx], spawns[i]);
      blob.id = i;
      team.blobs.push(blob);
      this.blobs.push(blob);
      this.scene.add(blob.group);
    }

    this.hud.setControlScheme(this.realtime);
    this.hud.buildInventory(this.practice ? null : this.enabledWeapons);
    this.hud.buildRoster(this.teams);
    this.minimap?.reset();
    this.hud.hideOverlay();
    this.hud.toggleInventory(false);
    this.hud.setControlsVisible(true);

    // waterLevel is mutable (sudden death raises it), so reset it per match.
    CFG.terrain.waterLevel = 0;
    this.suddenDeath = false;

    this.turnCount = 0;
    this.activeTeamIndex = this.teams.length - 1;
    this.cursor = this.teams.map(() => -1);
    this.selectedWeapon = 'bazooka';
    this.shotsLeft = 0;
    this.burst = null;
    this.mapTarget = null;
    this.mapHomingTarget = null;
    this.matchTime = 0;
    this.crateTimer = CFG.turn.realtimeCrateInterval;

    if (this.realtime) {
      this.log(count > 2 ? `${count} squads land on the island — everybody moves.` : 'The island is contested. Go!');
      this.beginRealtime();
      return;
    }

    this.log(
      this.practice
        ? 'Practice range — every weapon, unlimited ammo, nothing that can kill you.'
        : count > 2
          ? `${count} squads land on the island. ${this.teams[0].def.name} moves first.`
          : 'The island is contested. Crimson moves first.'
    );
    this.nextTurn();
  }

  // --- ownership ------------------------------------------------------------

  /** True when the blob currently taking its turn is driven by this machine. */
  isLocalTurn() {
    if (!this.activeTeam || this.activeTeam.isAI) return false;
    if (!this.localTeams) return true;
    return this.localTeams.includes(this.activeTeam.index);
  }

  playerControlled() {
    return this.activeBlob && this.activeBlob.alive && this.isLocalTurn();
  }

  /** Real-time only: the team this machine plays as. Null in turn-based matches. */
  get myTeam() {
    return this.myTeamIndex != null ? this.teams[this.myTeamIndex] : null;
  }

  /**
   * Real-time mode's whole trick: every weapon/aim method on Game (fire,
   * executeFire, updateAI, updatePreview, readMovement, …) reads and writes a
   * handful of singular fields (selectedWeapon, power, charging, this.rig, …)
   * because turn-based mode only ever has one team's turn loaded into them at
   * once. Rather than rewrite all of that to take an explicit actor
   * parameter, this temporarily loads a *different* team's saved state into
   * those same fields, runs `fn`, and writes it back — so every existing
   * method keeps working unchanged for whichever team is "current" for the
   * duration of the call.
   *
   * The local player's own team is the resting state: its fields live
   * directly on `this`/`this.rig` at all times between frames, so real input
   * events (which only ever fire between frames) keep working with no swap at
   * all. Only AI and remote teams ever actually get swapped in.
   */
  runInTeamContext(team, fn) {
    if (!team || team === this.myTeam) return fn();
    const rt = team.rt;
    if (!rt.shadowRig) rt.shadowRig = new AimState();

    const saved = { activeTeam: this.activeTeam, activeBlob: this.activeBlob, rig: this.rig };
    for (const k of RT_FIELDS) saved[k] = this[k];

    this.activeTeam = team;
    this.activeBlob = team.blobs[this.cursor[team.index]] ?? null;
    this.rig = rt.shadowRig;
    for (const k of RT_FIELDS) this[k] = rt[k];

    try {
      return fn();
    } finally {
      for (const k of RT_FIELDS) rt[k] = this[k];
      Object.assign(this, saved);
    }
  }

  teardown() {
    if (this.terrain) {
      this.scene.remove(this.terrain.mesh);
      this.terrain.dispose();
    }
    for (const b of this.blobs) {
      this.scene.remove(b.group);
      b.dispose();
    }
    for (const p of this.projectiles) p.destroy();
    for (const m of this.mines) m.remove();
    for (const c of this.crates) c.remove();
    this.projectiles.length = 0;
    this.mines.length = 0;
    this.crates.length = 0;
    this.blobs.length = 0;
    this.teams.length = 0;
    this.fx.clear();
    this.aimPreview.visible = false;
    this.impactMarker.visible = false;
    this.lockMarker.visible = false;
    this.wallShadow.visible = false;
  }

  buildAimPreview() {
    const positions = new Float32Array(PREVIEW_DOTS * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.aimPreview = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        color: 0xffffff,
        size: 0.34,
        transparent: true,
        opacity: 0.85,
        sizeAttenuation: true,
      })
    );
    this.aimPreview.frustumCulled = false;
    this.aimPreview.visible = false;
    this.scene.add(this.aimPreview);

    this.impactMarker = new THREE.Mesh(
      new THREE.RingGeometry(0.88, 1.0, 36),
      new THREE.MeshBasicMaterial({
        color: 0xffd166,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.6,
      })
    );
    this.impactMarker.visible = false;
    this.scene.add(this.impactMarker);

    // Ring around a homing target locked in from the map (see onMapPick).
    this.lockMarker = new THREE.Mesh(
      new THREE.RingGeometry(1.3, 1.55, 36),
      new THREE.MeshBasicMaterial({
        color: 0xff7ad9,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.75,
      })
    );
    this.lockMarker.rotation.x = -Math.PI / 2;
    this.lockMarker.visible = false;
    this.scene.add(this.lockMarker);

    // Footprint preview for the wall builder — one flat disc per stamp the
    // final build will raise, laid out and rotated exactly like buildWall
    // itself (see WALL_SHADOW_MAX for the pool size). Hidden segments beyond
    // a given weapon's actual count just stay invisible.
    this.wallShadow = new THREE.Group();
    this.wallShadowDiscs = [];
    for (let i = 0; i < WALL_SHADOW_MAX; i++) {
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(1, 24),
        new THREE.MeshBasicMaterial({
          color: 0x9fd8ff,
          transparent: true,
          opacity: 0.35,
          side: THREE.DoubleSide,
          depthWrite: false,
        })
      );
      disc.rotation.x = -Math.PI / 2;
      disc.visible = false;
      this.wallShadowDiscs.push(disc);
      this.wallShadow.add(disc);
    }
    this.wallShadow.visible = false;
    this.scene.add(this.wallShadow);
  }

  bindInput() {
    const i = this.input;
    // Fire is the left mouse button in both modes; Space is always jump.
    i.onFireDown = () => this.beginFireAction();
    i.onFireUp = () => this.endFireAction();
    i.onPress('space', () => this.tryJump());
    i.onPress('j', () => this.tryJump());
    i.onPress('shift', () => {
      if (this.realtime) this.switchCharacter(1);
      else this.tryJump();
    });
    i.onPress('escape', () => {
      if (this.mapOpen) this.minimap.close();
      else if (this.hud.inventoryOpen) this.hud.toggleInventory(false);
      else if (this.state !== STATE.IDLE) this.onPause?.();
    });
    i.onPress('tab', () => {
      // While the full map is up, Tab swaps top-down for the 3D orbit.
      if (this.mapOpen) return void this.minimap.cycleMode();
      if (this.canAct() || this.hud.inventoryOpen) {
        this.hud.toggleInventory();
        this.charging = false;
        this.digging = false;
      }
    });
    i.onPress('m', () => {
      if (this.state === STATE.IDLE || !this.minimap) return;
      if (this.mapOpen) return void this.minimap.close();
      const weapon = WEAPONS[this.selectedWeapon];
      if (this.canAct() && weapon.homing) {
        this.minimap.openForPick('blob', (blob) => this.onMapPick('blob', blob));
      } else if (this.canAct() && weapon.delivery === 'airstrike') {
        this.minimap.openForPick('point', (pt) => this.onMapPick('point', pt));
      } else {
        this.minimap.open();
      }
    });
    i.onPress('q', () => this.cycleWeapon(-1));
    i.onPress('e', () => this.cycleWeapon(1));
    QUICK_SLOTS.forEach((id, idx) => {
      i.onPress(String(idx + 1), () => this.selectWeapon(id));
    });
    i.onPress('n', () => {
      // "Hold position" ends a turn — meaningless once nobody's turn ever ends.
      if (this.realtime) return;
      if (this.canAct()) {
        this.log(`${this.activeBlob.name} holds position.`);
        this.emit({ t: 'endTurn' });
      }
    });
    i.onPress('c', () => this.rig?.recenter());
    i.onPress('k', () => {
      this.audio.setEnabled(!this.audio.enabled);
      this.hud.toast(this.audio.enabled ? 'SOUND ON' : 'MUTED', '#9fb0c6', 900);
    });
  }

  /** The full-screen map takes over input the same way the armory does. */
  get mapOpen() {
    return !!this.minimap?.full;
  }

  tryJump() {
    if (this.state !== STATE.AIM && this.state !== STATE.RETREAT && this.state !== STATE.PLAY) return;
    // Same gate as firing: a panel that swallows movement has to swallow the
    // jump too, or you hop blind behind the armory or the map.
    if (!this.playerControlled() || this.hud.inventoryOpen || this.mapOpen) return;
    const b = this.activeBlob;
    // Jump the way you're steering; standing still, jump the way you're facing.
    const mv = b.moveInput;
    const angle = mv.lengthSq() > 0.01 ? Math.atan2(mv.x, mv.y) : b.facing;
    this.emit({ t: 'jump', a: round2(angle) });
  }

  canAct() {
    return (
      (this.state === STATE.AIM || this.state === STATE.PLAY) &&
      this.fireCooldown <= 0 &&
      this.playerControlled() &&
      !this.hud.inventoryOpen &&
      !this.mapOpen
    );
  }

  /** Left-click-down: start charging, digging, or fire instantly. */
  beginFireAction() {
    if (!this.canAct()) return;
    const w = WEAPONS[this.selectedWeapon];
    if (w.delivery === 'burrow' || w.delivery === 'drill') {
      this.startDig(w);
    } else if (w.noCharge || w.delivery === 'teleport') {
      this.power = w.power ?? CFG.shot.maxPower;
      this.fire();
    } else {
      this.charging = true;
      this.power = CFG.shot.minPower;
      this.chargeDir = 1;
    }
  }

  /** Left-click-up: fire the charge, or stop digging. */
  endFireAction() {
    if (this.charging) this.fire();
    else if (this.digging) this.stopDig();
  }

  teamState(team) {
    return team;
  }

  log(text) {
    this.hud.log(text);
  }

  // --- command layer --------------------------------------------------------
  // Every decision that changes the game goes through applyCommand. Local input
  // calls emit() (apply here + forward to the network); remote players' commands
  // arrive from the session and call applyCommand directly. One code path, so
  // online and offline can't drift apart in behaviour.

  emit(cmd) {
    // Auto-tag which team this is: at the moment any local input fires,
    // this.activeTeam is always the resting local-team context (see
    // runInTeamContext) — never a team we've deliberately swapped in for
    // an AI/remote tick. 'crate' is host-authoritative, not team-specific.
    if (this.realtime && cmd.team === undefined && cmd.t !== 'crate' && this.activeTeam) {
      cmd.team = this.activeTeam.index;
    }
    this.applyCommand(cmd);
    if (this.net) this.net.sendCommand(cmd);
  }

  applyCommand(cmd) {
    if (this.realtime) return this.applyRealtimeCommand(cmd);
    switch (cmd.t) {
      case 'weapon':
        this.setWeapon(cmd.id);
        break;
      case 'jump':
        if (this.activeBlob && this.activeBlob.alive) this.activeBlob.jump(cmd.a);
        break;
      case 'fire':
        this.executeFire(cmd);
        break;
      case 'endTurn':
        this.endTurn();
        break;
      case 'pose':
        this.applyPose(cmd);
        break;
    }
  }

  /**
   * Real-time's command dispatch. Every command (except the host-authoritative
   * 'crate') names the team it belongs to, so a command from an AI or remote
   * team is applied with that team's own weapon/aim/power state loaded (see
   * runInTeamContext) rather than whatever the local player happens to be
   * doing right now.
   */
  applyRealtimeCommand(cmd) {
    if (cmd.t === 'crate') {
      this.spawnCrate(cmd.type, cmd.loot, new THREE.Vector3(cmd.x, cmd.y, cmd.z));
      return;
    }
    const team = this.teams[cmd.team];
    if (!team) return;
    if (cmd.t === 'switch') return void this.applySwitchCommand(team, cmd);
    if (cmd.t === 'pose') return void this.applyRealtimePose(team, cmd);
    this.runInTeamContext(team, () => {
      switch (cmd.t) {
        case 'weapon':
          this.setWeapon(cmd.id);
          break;
        case 'jump':
          if (this.activeBlob && this.activeBlob.alive) this.activeBlob.jump(cmd.a);
          break;
        case 'fire':
          this.executeFire(cmd);
          break;
      }
    });
  }

  /** Real-time: another client switched which of their team's blobs is current. */
  applySwitchCommand(team, cmd) {
    const idx = team.blobs.findIndex((b) => b.id === cmd.blob);
    if (idx >= 0) this.cursor[team.index] = idx;
  }

  /** Real-time: a remote team's current blob transform + aim, streamed continuously. */
  applyRealtimePose(team, cmd) {
    const b = team.blobs[this.cursor[team.index]];
    if (!b || !b.alive) return;
    b.netPose = { x: cmd.x, y: cmd.y, z: cmd.z };
    b.facing = cmd.f;
    if (!team.rt.shadowRig) team.rt.shadowRig = new AimState();
    team.rt.shadowRig.aimYaw = cmd.yaw;
    team.rt.shadowRig.aimPitch = cmd.pitch;
    team.rt.power = cmd.p;
    team.rt.charging = !!cmd.c;
  }

  /** Remote player's blob transform + aim, streamed while it's their turn. */
  applyPose(cmd) {
    const b = this.activeBlob;
    if (!b || !b.alive) return;
    b.netPose = { x: cmd.x, y: cmd.y, z: cmd.z };
    b.facing = cmd.f;
    // Smoothed toward every frame below, not snapped — a raw assignment here
    // would step the camera once per pose packet (~15 Hz) and read as jitter.
    this.rig.netAimYaw = cmd.yaw;
    this.rig.netAimPitch = cmd.pitch;
    this.power = cmd.p;
    this.charging = !!cmd.c;
  }

  /** Snapshot of what the local player is doing, for the pose stream. */
  capturePose() {
    const b = this.activeBlob;
    return {
      t: 'pose',
      team: this.activeTeam.index,
      x: round2(b.position.x),
      y: round2(b.position.y),
      z: round2(b.position.z),
      f: round2(b.facing),
      yaw: round2(this.rig.aimYaw),
      pitch: round2(this.rig.aimPitch),
      p: round2(this.power),
      c: this.charging ? 1 : 0,
    };
  }

  // --- weapon selection -----------------------------------------------------

  /** Local intent: validate, then broadcast. */
  selectWeapon(id, fromMenu = false) {
    if ((this.state !== STATE.AIM && this.state !== STATE.PLAY) || !this.playerControlled()) return;
    if (!WEAPONS[id]) return;
    if (this.activeTeam.ammo[id] <= 0) {
      this.hud.toast('OUT OF AMMO', '#ff6b6b', 800);
      return;
    }
    if (this.shotsLeft > 0) {
      this.hud.toast('FINISH THE BARREL', '#ff6b6b', 800);
      return;
    }
    this.emit({ t: 'weapon', id });
    if (fromMenu) this.hud.toggleInventory(false);
  }

  /** Applied form — runs on every client. */
  setWeapon(id) {
    if (!WEAPONS[id]) return;
    this.selectedWeapon = id;
    this.charging = false;
    this.digging = false;
    this.wallRotation = null;
    this.mapTarget = null;
    this.mapHomingTarget = null;
    if (this.activeTeam) this.hud.updateInventory(this.activeTeam.ammo, id);
    this.audio.bounce();
  }

  cycleWeapon(dir) {
    if ((this.state !== STATE.AIM && this.state !== STATE.PLAY) || !this.playerControlled()) return;
    const usable = WEAPON_ORDER.filter((id) => this.activeTeam.ammo[id] > 0);
    if (!usable.length) return;
    const at = usable.indexOf(this.selectedWeapon);
    const next = usable[(at + dir + usable.length) % usable.length];
    this.selectWeapon(next);
  }

  // --- turn flow ------------------------------------------------------------

  /**
   * Advance to the next squad's turn. In an online match only the client that
   * just acted runs this; everyone else waits for the resulting snapshot, so
   * turn order can't fork.
   */
  nextTurn() {
    if (this.checkVictory()) return;

    for (let step = 1; step <= this.teams.length; step++) {
      const idx = (this.activeTeamIndex + step) % this.teams.length;
      if (this.teams[idx].blobs.some((b) => b.alive)) {
        this.activeTeamIndex = idx;
        break;
      }
    }

    const team = this.teams[this.activeTeamIndex];
    let blob = null;
    for (let step = 1; step <= team.blobs.length; step++) {
      const idx = (this.cursor[team.index] + step) % team.blobs.length;
      if (team.blobs[idx].alive) {
        this.cursor[team.index] = idx;
        blob = team.blobs[idx];
        break;
      }
    }
    if (!blob) return void this.checkVictory();

    this.turnCount++;
    // Stream A — the turn-setup rolls. Only the acting client runs these; every
    // other client receives their results in the snapshot.
    this.rng.reset(this.seed + this.turnCount * 7919);

    this.randomizeWind();
    this.updateSuddenDeath();
    this.maybeDropCrate();
    this.beginTurn(team, blob);
  }

  /** Shared turn setup. Reached locally via nextTurn, remotely via a snapshot. */
  beginTurn(team, blob) {
    // Stream B — everything rolled *during* play (shrapnel spread, burst
    // scatter). Re-seeded here, the one point both the acting client and every
    // observer pass through, so they draw the same numbers all turn. Seeding it
    // in nextTurn instead left the actor several draws ahead, which scattered
    // cluster bomblets differently and forced a terrain resync.
    this.rng.reset(this.seed + this.turnCount * 7919 + 104729);

    this.activeTeam = team;
    this.activeBlob = blob;
    this.state = STATE.AIM;
    this.timer = this.practice ? Infinity : CFG.turn.time;
    this.charging = false;
    this.digging = false;
    this.digTimer = 0;
    this.digDest = null;
    this.wallRotation = null;
    this.power = CFG.shot.minPower;
    this.shotsLeft = 0;
    this.burst = null;
    this.fireCooldown = 0;
    this.lastBlast = null;
    this.explodePause = 0;
    this.lastTickSecond = Math.ceil(this.timer);
    if (team.ammo[this.selectedWeapon] <= 0) this.selectedWeapon = 'bazooka';

    const enemy = this.nearestEnemy(blob);
    this.rig.setTarget(blob.position, true);
    this.rig.faceFrom(blob.position, enemy ? enemy.position : new THREE.Vector3());
    this.rig.targetDistance = 24;

    this.hud.setTurn(team, blob, team.isAI);
    this.hud.setWind(this.wind);
    this.hud.updateInventory(team.ammo, this.selectedWeapon);
    this.hud.toggleInventory(false);
    const mine = this.isLocalTurn();
    this.hud.setControlsVisible(mine);
    this.hud.setTurnOwner(team, mine, this.net ? team.label : null);
    this.hud.toast(
      mine || !this.net ? `${team.def.name}: ${blob.name}` : `${team.label ?? team.def.name} is up`,
      team.def.css,
      1200
    );
    this.audio.turnStart();
    for (const b of this.blobs) b.netPose = null;
    this.rig.netAimYaw = null;
    this.rig.netAimPitch = null;
    this.mapTarget = null;
    this.mapHomingTarget = null;

    if (team.isAI) {
      this.aiPhase = 'walk';
      this.aiWalkTimer = 0;
      this.aiTimer = CFG.turn.aiThinkTime;
      this.aiPlan = undefined;
      this.aiCrate = this.findAICrate(blob);
      if (!this.aiCrate) this.aiPhase = 'aim';
    }
  }

  // --- real-time mode ---------------------------------------------------

  /** Real-time match setup — every team's first living blob goes live at once. */
  beginRealtime() {
    this.state = STATE.PLAY;
    this.randomizeWind();

    for (const team of this.teams) {
      let blob = null;
      for (let i = 0; i < team.blobs.length; i++) {
        if (team.blobs[i].alive) {
          blob = team.blobs[i];
          this.cursor[team.index] = i;
          break;
        }
      }
      if (!blob) continue;

      const enemy = this.nearestEnemy(blob);
      const yaw = enemy
        ? Math.atan2(enemy.position.x - blob.position.x, enemy.position.z - blob.position.z)
        : blob.facing;

      if (team === this.myTeam) {
        this.activeTeam = team;
        this.activeBlob = blob;
        this.rig.aimYaw = yaw;
        this.rig.aimPitch = 0.45;
        this.rig.yawOffset = 0;
        this.rig.pitchOffset = 0;
        this.rig.setTarget(blob.position, true);
        this.rig.targetDistance = 24;
      } else {
        if (!team.rt.shadowRig) team.rt.shadowRig = new AimState();
        team.rt.shadowRig.aimYaw = yaw;
        team.rt.shadowRig.aimPitch = 0.45;
      }
    }

    const myBlob = this.myTeam?.blobs[this.cursor[this.myTeamIndex]];
    this.hud.setTurn(this.myTeam, myBlob, false);
    this.hud.setWind(this.wind);
    this.hud.updateInventory(this.myTeam.ammo, this.selectedWeapon);
    this.hud.toggleInventory(false);
    this.hud.setControlsVisible(true);
    this.hud.setTurnOwner(this.myTeam, true, null);
    this.hud.setTimer(Infinity, 'off');
    this.audio.turnStart();
  }

  /** The blob a team is currently acting through, auto-advancing off a dead one. */
  currentBlobOf(team) {
    const idx = this.cursor[team.index];
    if (idx >= 0 && team.blobs[idx]?.alive) return team.blobs[idx];
    for (let i = 0; i < team.blobs.length; i++) {
      if (team.blobs[i].alive) {
        this.cursor[team.index] = i;
        return team.blobs[i];
      }
    }
    return null;
  }

  /** Shift: cycle the local player's own current character, if they have a spare. */
  switchCharacter(dir = 1) {
    if (!this.realtime || !this.playerControlled()) return;
    const team = this.activeTeam;
    if (team.blobs.filter((b) => b.alive).length < 2) return;

    let idx = this.cursor[team.index];
    for (let step = 1; step <= team.blobs.length; step++) {
      const next = (idx + dir * step + team.blobs.length) % team.blobs.length;
      if (team.blobs[next].alive) {
        idx = next;
        break;
      }
    }
    this.cursor[team.index] = idx;
    const blob = team.blobs[idx];
    this.activeBlob = blob;
    this.charging = false;
    this.digging = false;
    this.shotsLeft = 0;
    this.wallRotation = null;
    this.mapTarget = null;
    this.mapHomingTarget = null;
    this.aimPreview.visible = false;
    this.impactMarker.visible = false;
    this.rig.setTarget(blob.position, true);
    this.hud.setTurn(team, blob, false);
    this.audio.bounce();
    this.emit({ t: 'switch', blob: blob.id });
  }

  /** One real-time frame: every team's current blob acts at once. */
  updateRealtime(dt) {
    // Turn-based funnels a fatal hit through the SETTLE phase (one death at a
    // time, camera following each) since only one blob can ever go down per
    // turn. Real-time never enters SETTLE — it's STATE.PLAY for the whole
    // match — so nothing was converting a 0-HP "pendingDeath" blob into an
    // actual kill: it just sat there alive at 0 HP forever. Here a fatal hit
    // kills immediately instead, chain reactions (death blast catching
    // another blob) included.
    for (const b of this.blobs) {
      if (b.alive && b.pendingDeath) b.kill(true);
    }

    if (this.checkVictory()) return;
    this.matchTime += dt;

    if (!this.hud.inventoryOpen && !this.mapOpen) {
      const blob = this.currentBlobOf(this.myTeam);
      if (blob) {
        this.activeBlob = blob;
        if (this.fireCooldown > 0) this.fireCooldown = Math.max(0, this.fireCooldown - dt);
        this.readMovement(blob);
        if (!this.updateChargeOrDig(dt)) {
          this.rig.setTarget(blob.position);
          this.rig.followSpeed = 8;
          this.updatePreview();
        }
        const frac = (this.power - CFG.shot.minPower) / (CFG.shot.maxPower - CFG.shot.minPower);
        const digFrac = this.digTimer / CFG.dig.maxHold;
        this.hud.setPower(
          this.charging ? frac : this.digging ? digFrac : 0,
          (this.rig.aimPitch * 180) / Math.PI,
          this.charging || this.digging
        );
      }
    }

    // Every other team: AI teams think and act for themselves; remote human
    // teams drive their blob through the generic netPose-lerp loop in step()
    // and just need their cooldown ticked and any in-flight burst continued
    // (a burst is only ever seeded by the one 'fire' command that started
    // it — see launch() — every client, including this one, ticks its
    // rounds forward locally off the same fixed timestep from there).
    for (const team of this.teams) {
      if (team === this.myTeam) continue;
      const blob = this.currentBlobOf(team);
      if (!blob) continue;
      this.runInTeamContext(team, () => {
        this.activeBlob = blob;
        if (team.isAI) {
          this.updateAI(dt);
        } else if (this.fireCooldown > 0) {
          this.fireCooldown = Math.max(0, this.fireCooldown - dt);
        }
        if (this.burst) {
          this.burst.t -= dt;
          if (this.burst.t <= 0) this.fireBurstRound();
        }
      });
    }

    this.updateSuddenDeathRealtime(dt);
    this.maybeDropCrateRealtime(dt);
  }

  /** Shared charge/dig tick, used by turn-based updateAim and updateRealtime alike. */
  updateChargeOrDig(dt) {
    if (this.charging) {
      this.power += CFG.shot.chargeRate * dt * this.chargeDir;
      if (this.power >= CFG.shot.maxPower) {
        this.power = CFG.shot.maxPower;
        this.chargeDir = -1;
      } else if (this.power <= CFG.shot.minPower) {
        this.power = CFG.shot.minPower;
        this.chargeDir = 1;
      }
    } else if (this.digging) {
      this.digTimer = Math.min(CFG.dig.maxHold, this.digTimer + dt);
      // Actually carve a bit more every ~0.25s instead of only charging up
      // silently and dumping the whole shaft/pit out on release — burrow
      // and drill scale their own effect by the current (still-growing)
      // hold fraction, so each tick pushes the blob a little further down
      // (burrow) or bores a little deeper (drill) while Space stays held.
      if (this.digTimer - this.digTickAt >= 0.25) {
        this.digTickAt = this.digTimer;
        const w = WEAPONS[this.selectedWeapon];
        const frac = this.digTimer / CFG.dig.maxHold;
        if (w.delivery === 'burrow') this.burrowSelf(w, frac, true);
        else this.drillShaft(w, frac, true, this.digDest);
      }
      if (this.digTimer >= CFG.dig.maxHold) {
        this.stopDig();
        return true;
      }
    }
    return false;
  }

  /** Real-time sudden death: elapsed match time instead of a turn count. */
  updateSuddenDeathRealtime(dt) {
    if (this.matchTime < CFG.turn.realtimeSuddenDeathAt) return;
    if (!this.suddenDeath) {
      this.suddenDeath = true;
      for (const b of this.blobs) {
        if (!b.alive) continue;
        b.health = Math.min(b.health, CFG.turn.suddenDeathHealth);
        b.drawLabel();
      }
      this.log('SUDDEN DEATH — the tide is coming in.');
      this.hud.toast('SUDDEN DEATH', '#ff6b6b', 2200);
      this.audio.siren();
    } else {
      CFG.terrain.waterLevel += (CFG.terrain.waterRise / CFG.turn.time) * dt;
    }
  }

  /**
   * Real-time supply drops. Rolled on a timer instead of once per turn. Online,
   * only the host rolls — the shared-seed RNG stream that keeps craters and
   * turn-scoped rolls in sync across clients only works when exactly one actor
   * draws from it at a time, which a turn guaranteed and real-time no longer
   * does — so the host resolves the drop once and broadcasts the concrete
   * result instead of asking every client to (possibly divergently) roll it.
   */
  maybeDropCrateRealtime(dt) {
    if (this.crates.length >= CFG.crates.max) return;
    this.crateTimer -= dt;
    if (this.crateTimer > 0) return;
    this.crateTimer = CFG.turn.realtimeCrateInterval;
    if (this.net && !this.net.isHost) return;
    if (!this.rng.chance(CFG.crates.chance)) return;
    const site = chooseDropSite(this);
    if (!site) return;
    const wounded = this.blobs.some((b) => b.alive && b.health < CFG.blob.maxHealth * 0.7);
    const type = this.rng.chance(wounded ? 0.34 : 0.18) ? 'health' : 'weapon';
    const loot = type === 'weapon' ? rollLoot(this.rng, this.enabledWeapons) : null;
    this.emit({
      t: 'crate',
      type,
      loot,
      x: round2(site.x),
      y: round2(site.y),
      z: round2(site.z),
    });
  }

  spawnCrate(type, loot, site) {
    if (this.crates.length >= CFG.crates.max) return;
    const crate = new Crate(this, type, site, loot);
    this.crates.push(crate);
    this.hud.toast(type === 'health' ? 'MEDKIT INBOUND' : 'SUPPLY DROP', '#cfe0f5', 1100);
  }

  /**
   * Which blobs the maps/roster should highlight: `mine` gets the strong
   * ring, `watch` (an array) gets the subdued one. What they mean depends on
   * the mode — see the plan doc / minimap.js for the reasoning.
   */
  highlightBlobs() {
    if (this.realtime) {
      const myBlob = this.myTeam ? this.myTeam.blobs[this.cursor[this.myTeamIndex]] : null;
      const watch = this.teams
        .filter((t) => t !== this.myTeam)
        .map((t) => t.blobs[this.cursor[t.index]])
        .filter((b) => b && b.alive);
      return { mine: myBlob && myBlob.alive ? myBlob : null, watch };
    }
    if (this.isLocalTurn()) return { mine: this.activeBlob, watch: [] };
    const myTeam = this.teams.find((t) => !t.isAI && (!this.localTeams || this.localTeams.includes(t.index)));
    const next = myTeam ? myTeam.blobs[this.cursor[myTeam.index]] : null;
    return { mine: null, watch: next && next.alive ? [next] : [] };
  }

  /** True when this machine is responsible for driving the current turn. */
  iAmActor() {
    if (!this.activeTeam) return false;
    if (this.activeTeam.isAI) return !this.net || this.net.isHost;
    return this.isLocalTurn();
  }

  /**
   * Turn handoff. Offline this is just nextTurn(). Online, only the acting
   * client advances and then publishes the authoritative result; everyone else
   * sits in settle until that snapshot lands.
   */
  completeTurn() {
    if (this.net && !this.iAmActor()) return;
    this.nextTurn();
    if (this.net && this.state !== STATE.OVER) this.net.sendTurnEnd(this.captureSnapshot());
  }

  /**
   * Host-only: a player vanished mid-turn, so take the turn away from them and
   * publish the result. Bypasses the usual ownership check on purpose.
   */
  forceAdvanceTurn() {
    if (this.state === STATE.OVER || !this.teams.length) return;
    this.log('A player dropped out — skipping their turn.');
    this.nextTurn();
    if (this.net && this.state !== STATE.OVER) this.net.sendTurnEnd(this.captureSnapshot());
  }

  // --- reconciliation -------------------------------------------------------

  /**
   * Authoritative state, captured by the acting client just after it advances
   * the turn. Small enough (~1 KB) to send every single turn, which is what lets
   * us skip cross-machine determinism entirely.
   */
  captureSnapshot() {
    return {
      turn: this.turnCount,
      team: this.activeTeamIndex,
      blob: this.activeBlob ? this.activeBlob.id : 0,
      cursor: this.cursor.slice(),
      wind: [round2(this.wind.x), round2(this.wind.z)],
      water: CFG.terrain.waterLevel,
      sudden: this.suddenDeath,
      weapon: this.selectedWeapon,
      craters: this.terrain.takeCraterLog(),
      check: this.terrain.checksum(),
      // Note the write-back: we adopt the rounded values we're about to send, so
      // the acting client and every observer begin the next turn from bit-identical
      // state. Without it the actor keeps full precision, its shots drift a few
      // millimetres from everyone else's, and craters land in different places.
      blobs: this.blobs.map((b) => {
        const x = round2(b.position.x);
        const y = round2(b.position.y);
        const z = round2(b.position.z);
        b.position.set(x, y, z);
        return { i: b.id, x, y, z, h: b.health, a: b.alive ? 1 : 0 };
      }),
      ammo: this.teams.map((t) =>
        Object.fromEntries(
          WEAPON_ORDER.map((id) => [id, t.ammo[id] === Infinity ? null : t.ammo[id]])
        )
      ),
      crates: this.crates
        .filter((c) => !c.dead)
        .map((c) => {
          const x = round2(c.position.x);
          const y = round2(c.position.y);
          const z = round2(c.position.z);
          // age and bob drive the descent drift, so a crate still in the air
          // has to resume from the same phase on every client.
          const g = round2(c.age);
          c.position.set(x, y, z);
          c.age = g;
          return { t: c.type, l: c.loot, x, y, z, d: c.landed ? 1 : 0, g, b: c.bob };
        }),
      mines: this.mines
        .filter((m) => !m.dead)
        .map((m) => {
          const x = round2(m.position.x);
          const y = round2(m.position.y);
          const z = round2(m.position.z);
          const age = round2(m.age);
          m.position.set(x, y, z);
          m.age = age;
          return { x, y, z, age, o: m.owner ? m.owner.id : -1 };
        }),
    };
  }

  /** Adopt a snapshot from the acting client, then start the turn it names. */
  applySnapshot(s) {
    this.terrain.applyCraters(s.craters);
    this.terrain.takeCraterLog();

    for (const b of s.blobs) {
      const blob = this.blobs[b.i];
      if (!blob) continue;
      blob.position.set(b.x, b.y, b.z);
      blob.velocity.set(0, 0, 0);
      blob.netPose = null;
      blob.grounded = true;
      blob.pendingDeath = false;
      const wasAlive = blob.alive;
      blob.health = b.h;
      blob.alive = !!b.a;
      if (wasAlive && !blob.alive) {
        blob.group.visible = false;
        this.hud.updateRoster(this.activeBlob);
      }
      blob.drawLabel();
    }

    s.ammo.forEach((set, i) => {
      const team = this.teams[i];
      if (!team) return;
      for (const [id, n] of Object.entries(set)) team.ammo[id] = n === null ? Infinity : n;
    });

    // Crates and mines are cheap to rebuild wholesale, and it keeps ids simple.
    for (const c of this.crates) c.remove();
    this.crates.length = 0;
    for (const c of s.crates) {
      const crate = new Crate(this, c.t, new THREE.Vector3(c.x, c.y, c.z), c.l);
      crate.landed = !!c.d;
      crate.age = c.g ?? 0;
      crate.bob = c.b ?? 0;
      if (crate.landed) crate.dropChute();
      this.crates.push(crate);
    }
    for (const m of this.mines) m.remove();
    this.mines.length = 0;
    for (const m of s.mines) {
      const mine = new Mine(this, WEAPONS.mine, new THREE.Vector3(m.x, m.y, m.z), this.blobs[m.o]);
      mine.age = m.age;
      mine.armed = m.age >= WEAPONS.mine.armTime;
      mine.grounded = true;
      this.mines.push(mine);
    }

    for (const p of this.projectiles) p.destroy();
    this.projectiles.length = 0;
    this.burst = null;

    CFG.terrain.waterLevel = s.water;
    this.suddenDeath = s.sudden;
    this.turnCount = s.turn;
    this.cursor = s.cursor.slice();
    this.activeTeamIndex = s.team;
    this.selectedWeapon = s.weapon;
    this.wind.set(s.wind[0], 0, s.wind[1]);

    const drift = this.terrain.checksum() !== s.check;
    if (this.checkVictory()) return drift;
    this.beginTurn(this.teams[s.team], this.blobs[s.blob]);
    return drift;
  }

  /** End the shooting phase. Physics still has to settle before the next turn. */
  endTurn() {
    if (this.state === STATE.OVER) return;
    this.state = STATE.SETTLE;
    this.settleTimer = CFG.turn.settleTime;
    this.charging = false;
    this.digging = false;
    this.aimPreview.visible = false;
    this.impactMarker.visible = false;
    if (this.activeBlob) this.activeBlob.moveInput.set(0, 0);
    this.hud.toggleInventory(false);
  }

  checkVictory() {
    if (this.practice) return false; // a solo sandbox never ends
    const alive = this.teams.filter((t) => t.blobs.some((b) => b.alive));
    if (alive.length > 1) return false;
    this.state = STATE.OVER;
    this.aimPreview.visible = false;
    this.impactMarker.visible = false;
    this.hud.setControlsVisible(false);
    this.hud.toggleInventory(false);
    this.minimap?.close();
    const winner = alive[0];
    this.audio.victory();

    const title = winner ? `${winner.label ?? winner.def.name} WINS` : 'MUTUAL DESTRUCTION';
    const color = winner ? winner.def.css : '#ffd166';
    const survivors = winner ? winner.blobs.filter((b) => b.alive) : [];
    const rematch = this.net ? '' : '<button id="btnAgain">REMATCH</button>';
    const html = `
      <h2 style="color:${color}">${title}</h2>
      <p>${
        survivors.length
          ? `${survivors.map((b) => b.name).join(', ')} still wobbling after ${this.turnCount} turns.`
          : `Everybody lost. It took ${this.turnCount} turns.`
      }</p>
      <div class="modes">
        ${rematch}
        <button id="btnMenu" class="alt">MAIN MENU</button>
      </div>`;
    const overlay = this.hud.showOverlay(html);
    overlay.querySelector('#btnAgain')?.addEventListener('click', () =>
      this.start({ ...this.lastOptions, seed: Math.floor(Math.random() * 100000) })
    );
    overlay.querySelector('#btnMenu').onclick = () => this.onExit?.();
    return true;
  }

  onBlobDied(blob) {
    this.audio.death();
    this.log(`${blob.name} is gone.`);
    this.hud.updateRoster(this.activeBlob);
  }

  // --- firing ---------------------------------------------------------------

  shotOrigin(blob, dir, out = new THREE.Vector3()) {
    out.copy(blob.position).addScaledVector(dir, CFG.blob.radius + 0.75);
    out.y += 0.3;
    const gh = this.terrain.heightAt(out.x, out.z);
    if (out.y < gh + 0.25) out.y = gh + 0.25;
    return out;
  }

  /** Local/AI intent: package the shot as a command so remotes reproduce it. */
  fire() {
    if (this.state !== STATE.AIM && this.state !== STATE.PLAY) return;
    if (!this.playerControlled() && !this.activeTeam.isAI) return;
    const weapon = WEAPONS[this.selectedWeapon];
    if (this.shotsLeft <= 0 && this.activeTeam.ammo[weapon.id] <= 0) return;
    const b = this.activeBlob;
    // A homing lock made on the map wins over the aim-direction guess.
    const target = weapon.homing ? (this.mapHomingTarget ?? this.pickHomingTarget(this.rig.aimDirection())) : null;
    this.emit({
      t: 'fire',
      w: this.selectedWeapon,
      yaw: this.rig.aimYaw,
      pitch: this.rig.aimPitch,
      p: this.power,
      // The muzzle position travels with the shot. An observer only knows this
      // blob through the interpolated pose stream, so without it their barrel
      // sits a few centimetres away and the crater lands somewhere else.
      x: round2(b.position.x),
      y: round2(b.position.y),
      z: round2(b.position.z),
      tg: target ? target.id : -1,
      // A map-picked strike point, so every client (not just the one who
      // clicked the map) walks the bombs over the same spot.
      mt: weapon.delivery === 'airstrike' && this.mapTarget ? [round2(this.mapTarget.x), round2(this.mapTarget.z)] : null,
      // How long Space was held, 0..1 of the 3s cap — burrow/drill scale their
      // dig by this instead of by shot power.
      hold: weapon.delivery === 'burrow' || weapon.delivery === 'drill' ? round2(clamp(this.digTimer / CFG.dig.maxHold, 0, 1)) : undefined,
      // The wall's chosen facing — an observer has no wheel input of its own
      // to have rotated it with, so the exact angle has to ride along.
      wr: weapon.delivery === 'build' ? round2(this.wallRotation ?? this.defaultWallRotation()) : undefined,
    });
  }

  /**
   * Applied form. Everything the shot needs is in the command, so an observing
   * client produces the same launch without having watched the aiming.
   */
  executeFire(cmd) {
    // Tolerate an observer that drifted into settle: the shot is authoritative,
    // so pull the state back rather than dropping it.
    if (this.state === STATE.SETTLE && this.net && !this.isLocalTurn()) this.state = STATE.AIM;
    if (this.state !== STATE.AIM && this.state !== STATE.PLAY) return;
    this.selectedWeapon = cmd.w;
    this.rig.aimYaw = cmd.yaw;
    this.rig.aimPitch = cmd.pitch;
    this.rig.netAimYaw = null;
    this.rig.netAimPitch = null;
    this.power = cmd.p;

    const weapon = WEAPONS[this.selectedWeapon];
    const blob = this.activeBlob;

    // Snap to the shooter's exact muzzle position — on the firing client too, so
    // both sides launch from the identical (rounded) coordinates.
    if (cmd.x !== undefined) {
      blob.position.set(cmd.x, cmd.y, cmd.z);
      blob.netPose = null;
    }
    this.homingTarget = cmd.tg >= 0 ? this.blobs[cmd.tg] : null;
    // Whichever client clicked the map sent the exact point, so every client
    // — including that one — walks the strike over the identical spot rather
    // than each recomputing it from their own camera state.
    this.mapTarget = cmd.mt ? new THREE.Vector3(cmd.mt[0], this.terrain.heightAt(cmd.mt[0], cmd.mt[1]), cmd.mt[1]) : null;

    // A multi-shot weapon spends ammo only on the first trigger pull.
    if (this.shotsLeft > 0) {
      this.shotsLeft--;
    } else {
      if (this.activeTeam.ammo[weapon.id] <= 0) return;
      this.activeTeam.ammo[weapon.id] -= 1;
      this.shotsLeft = (weapon.shots ?? 1) - 1;
    }
    this.hud.updateInventory(this.activeTeam.ammo, this.selectedWeapon);

    const dir = this.rig.aimDirection();
    let usedProjectile = true;

    switch (weapon.delivery) {
      case 'melee':
        this.swingMelee(weapon, dir);
        usedProjectile = false;
        break;
      case 'teleport':
        this.doTeleport(weapon);
        usedProjectile = false;
        break;
      case 'airstrike':
        this.callAirstrike(weapon);
        break;
      case 'drop':
        this.dropAtFeet(weapon);
        break;
      case 'build':
        this.buildWall(weapon, cmd.wr);
        usedProjectile = false;
        break;
      case 'burrow':
        this.burrowSelf(weapon, cmd.hold ?? 1);
        usedProjectile = false;
        break;
      case 'drill':
        // this.digDest is only set on the client that actually held Space for
        // this shaft — the tick-carved spot it must finish at. A remote
        // client replaying the command never held it, so it resolves the
        // marker fresh against its own (still-untouched) terrain instead.
        this.drillShaft(weapon, cmd.hold ?? 1, false, this.digDest);
        usedProjectile = false;
        break;
      default:
        this.launch(weapon, dir);
    }

    this.charging = false;
    this.digging = false;
    this.digTimer = 0;
    this.digDest = null;
    this.wallRotation = null;
    this.aimPreview.visible = false;
    this.impactMarker.visible = false;
    this.lockMarker.visible = false;
    this.wallShadow.visible = false;
    this.mapTarget = null;
    this.mapHomingTarget = null;
    blob.moveInput.set(0, 0);
    this.log(`${blob.name} uses the ${weapon.name}.`);

    if (this.practice) {
      // Practice range: no turn handoff, just a short cooldown before the
      // next shot — stay in AIM so movement and the camera never leave your
      // hands, and projectiles/explosions resolve in the background.
      this.state = STATE.AIM;
      this.fireCooldown = CFG.practice.fireCooldown;
      return;
    }

    if (this.realtime) {
      // No turn to hand off — every other team keeps playing regardless of
      // what this shot was. Just rate-limit this team's next shot: a weapon
      // that used to buy a turn-based RUN! window now just makes you wait
      // that long before firing again; everything else gets the practice
      // range's default cooldown so charge-and-release can't be spammed.
      this.fireCooldown = (weapon.retreat ?? 0) > 0 ? weapon.retreat : CFG.practice.fireCooldown;
      if (this.activeTeam === this.myTeam) {
        this.rig.followSpeed = 9;
        if (usedProjectile) this.rig.targetDistance = 28;
      }
      return;
    }

    const retreat = weapon.retreat ?? 0;
    if (retreat > 0 && blob.alive) {
      this.state = STATE.RETREAT;
      this.retreatTimer = retreat;
      this.hud.toast('RUN!', '#ffd166', 1000);
    } else {
      this.state = STATE.FLIGHT;
      this.flightTimeout = 14;
      this.rig.followSpeed = 9;
      if (usedProjectile) this.rig.targetDistance = 28;
    }
  }

  launch(weapon, dir) {
    if (weapon.burst) {
      this.burst = {
        weapon,
        remaining: weapon.burst.count,
        interval: weapon.burst.interval,
        spread: weapon.burst.spread,
        t: 0,
      };
      this.fireBurstRound();
    } else {
      const origin = this.shotOrigin(this.activeBlob, dir);
      // Lock chosen by the shooter and carried in the command, so every client
      // guides the missile at the same blob.
      const target = weapon.homing ? (this.homingTarget ?? this.pickHomingTarget(dir)) : null;
      this.spawnProjectile(weapon, origin, dir.clone().multiplyScalar(this.power), this.activeBlob, {
        target,
      });
    }
  }

  fireBurstRound() {
    const b = this.burst;
    if (!b || b.remaining <= 0) return;
    b.remaining--;
    b.t = b.interval;
    b.round = (b.round ?? 0) + 1;
    // Read the live aim every round instead of the direction frozen at the
    // trigger pull, so full-auto fire tracks the mouse in real time rather
    // than spraying the whole burst at wherever you were originally aiming.
    //
    // Real-time mode can have several teams mid-burst at once, each ticked
    // independently by its own client — the shared this.rng stream that
    // keeps turn-based spread in sync across machines only works because a
    // turn guarantees exactly one actor draws from it at a time. A pure hash
    // of the shot's own identity (seed/blob/round) sidesteps that: every
    // client reaches the same round number for the same blob independently
    // (same burst.count/interval, same fixed timestep), so it reproduces
    // identical spread with no shared mutable state at all.
    const jitter = this.realtime
      ? new THREE.Vector3(
          hashSpread(this.seed, this.activeBlob.id, b.round, 1) * (b.spread / 2),
          hashSpread(this.seed, this.activeBlob.id, b.round, 2) * (b.spread / 2),
          hashSpread(this.seed, this.activeBlob.id, b.round, 3) * (b.spread / 2)
        )
      : new THREE.Vector3(
          this.rng.spread(b.spread / 2),
          this.rng.spread(b.spread / 2),
          this.rng.spread(b.spread / 2)
        );
    const dir = this.rig.aimDirection().add(jitter).normalize();
    const origin = this.shotOrigin(this.activeBlob, dir);
    this.spawnProjectile(b.weapon, origin, dir.multiplyScalar(b.weapon.power ?? this.power), this.activeBlob, {
      silent: b.remaining % 2 !== 0,
    });
    if (b.remaining <= 0) this.burst = null;
  }

  dropAtFeet(weapon) {
    const blob = this.activeBlob;
    const at = blob.position.clone();
    at.y += 0.2;
    if (weapon.detonate === 'proximity') {
      this.mines.push(new Mine(this, weapon, at, blob));
      this.audio.tick();
    } else {
      this.spawnProjectile(weapon, at, new THREE.Vector3(0, 1.5, 0), blob);
    }
  }

  /** Callback from Minimap.openForPick — a target chosen on the full map. */
  onMapPick(kind, result) {
    if (!this.canAct()) return;
    if (kind === 'blob' && result) {
      this.mapHomingTarget = result;
      this.hud.toast(`LOCKED: ${result.name}`, '#ff7ad9', 900);
    } else if (kind === 'point' && result) {
      this.mapTarget = new THREE.Vector3(result.x, this.terrain.heightAt(result.x, result.z), result.z);
      this.hud.toast('TARGET SET', '#ffd166', 900);
    }
  }

  /**
   * Where the current aim would land. Derived from the shot parameters rather
   * than from the preview's cached result, so an observing client resolves the
   * same target point without having seen the aim marker.
   */
  resolveAimImpact(weapon) {
    const dir = this.rig.aimDirection();
    const origin = this.shotOrigin(this.activeBlob, dir, _v2);
    const vel = _v3.copy(dir).multiplyScalar(this.power);
    const res = simulateTrajectory(origin, vel, weapon, this.terrain, this.wind, {
      dt: 1 / 40,
      maxT: 8,
    });
    return res.impact && res.reason !== 'offmap' ? res.impact : null;
  }

  callAirstrike(weapon) {
    const s = weapon.strike;
    const child = WEAPONS[s.weapon];
    // A point placed on the map wins over the old aim-a-shot-and-see-where-it-
    // lands guess — that guess is a real ballistic simulation of a shot that
    // was never fired, so a small aim change could swing the landing spot
    // unpredictably. The map gives you the exact spot directly.
    const aimed = this.mapTarget ?? this.resolveAimImpact(weapon);
    const center = aimed
      ? aimed.clone()
      : this.activeBlob.position.clone().addScaledVector(this.rig.aimDirection(), 40);

    // Walk the bombs toward the target from the blob, or along the camera
    // facing if the target sits right on top of the blob.
    const toTarget = new THREE.Vector3(center.x - this.activeBlob.position.x, 0, center.z - this.activeBlob.position.z);
    const along =
      toTarget.lengthSq() > 1
        ? toTarget.normalize()
        : new THREE.Vector3(Math.sin(this.rig.aimYaw), 0, Math.cos(this.rig.aimYaw));
    for (let i = 0; i < s.count; i++) {
      const offset = (i - (s.count - 1) / 2) * s.spacing;
      const at = center.clone().addScaledVector(along, offset);
      at.y = center.y + s.height + i * 3;
      this.spawnProjectile(child, at, new THREE.Vector3(0, -14, 0), this.activeBlob, {
        silent: i > 0,
      });
    }
    this.audio.siren();
    this.rig.targetDistance = 44;
  }

  swingMelee(weapon, dir) {
    const blob = this.activeBlob;
    const flat = new THREE.Vector3(dir.x, 0, dir.z).normalize();
    let hit = 0;
    this.audio.swing();
    this.fx.burst(blob.position.clone().addScaledVector(flat, 2), 14, {
      speed: 8,
      size: 0.35,
      color: 0xffffff,
      gravity: 10,
      life: 0.6,
    });

    for (const other of this.blobs) {
      if (!other.alive || other === blob) continue;
      const to = _v1.subVectors(other.position, blob.position);
      const dist = to.length();
      if (dist > weapon.range) continue;
      if (to.normalize().dot(flat) < 0.25) continue;
      other.damage(weapon.damage, 'a baseball bat');
      const impulse = flat.clone().multiplyScalar(weapon.launchSpeed);
      impulse.y = weapon.launchSpeed * 0.65;
      other.applyImpulse(impulse);
      hit++;
    }
    this.log(hit ? `${blob.name} connects with ${hit} blob${hit > 1 ? 's' : ''}!` : `${blob.name} swings at thin air.`);
    this.rig.addShake(0.6);
  }

  doTeleport(weapon) {
    const blob = this.activeBlob;
    const dest = this.resolveAimImpact(weapon);
    if (!dest || !this.terrain.inBounds(dest.x, dest.z)) {
      this.hud.toast('NO DESTINATION', '#ff6b6b', 900);
      return;
    }
    this.fx.burst(blob.position, 26, { speed: 9, size: 0.45, color: 0x9fd8ff, gravity: 4, life: 0.9 });
    blob.position.set(dest.x, this.terrain.heightAt(dest.x, dest.z) + CFG.blob.radius, dest.z);
    blob.velocity.set(0, 0, 0);
    blob.grounded = true;
    this.fx.burst(blob.position, 26, { speed: 9, size: 0.45, color: 0x9fd8ff, gravity: 4, life: 0.9 });
    this.audio.warp();
    this.rig.setTarget(blob.position, true);
  }

  /**
   * Begin holding Space on the burrow/drill tools. The actual carving happens
   * bit by bit while Space stays down (see the digging tick in `updateAim`,
   * which calls burrowSelf/drillShaft directly, locally, every ~0.25s) so the
   * blob visibly sinks/bores deeper the whole time it's held rather than only
   * at release. Release (`stopDig`) still sends the single authoritative
   * `fire` command that every other weapon uses — remote clients, who never
   * ran these local ticks, apply the whole effect from that one command, the
   * same as before.
   */
  startDig(weapon) {
    if (this.shotsLeft <= 0 && this.activeTeam.ammo[weapon.id] <= 0) return;
    // Drill aims with a fixed power (like any other noCharge weapon) rather
    // than ramping one — Space is spoken for by the hold-to-dig timer — so
    // pin it now, before resolveAimImpact reads it in updatePreview/stopDig.
    if (weapon.power != null) this.power = weapon.power;
    this.digging = true;
    this.digTimer = 0;
    this.digTickAt = 0;
    // Lock the shaft's spot once for the whole hold: drillShaft re-carves from
    // the surface down on every tick (see updateAim), and re-resolving the aim
    // marker each tick would have it chase its own freshly dug pit — the
    // simulated throw would sail further now that the ground it used to land
    // on is gone. Burrow has no such feedback loop since it always targets the
    // blob's own (settling) feet, so it needs no cached spot.
    this.digDest = weapon.delivery === 'drill' ? this.resolveAimImpact(weapon) : null;
  }

  /** Release (or the 3-second cap) commits the dig as one fired shot. */
  stopDig() {
    if (!this.digging) return;
    this.digging = false;
    this.fire();
  }

  /**
   * Mound a short straight ridge of earth at the aim marker — the wall
   * builder. `rotation` is the world-yaw the ridge runs along (see
   * `defaultWallRotation`/`updateWallShadow` — it defaults to perpendicular
   * to the aim direction, but the player can spin it with the scroll wheel
   * while lining the shot up, and the shadow preview shows exactly this).
   */
  buildWall(weapon, rotation) {
    const dest = this.resolveAimImpact(weapon);
    if (!dest || !this.terrain.inBounds(dest.x, dest.z)) {
      this.hud.toast('NO SITE', '#ff6b6b', 900);
      return;
    }
    const rot = rotation ?? this.defaultWallRotation();
    const side = _v1.set(Math.sin(rot), 0, Math.cos(rot)).normalize();
    const w = weapon.wall;
    let changed = false;
    for (let i = 0; i < w.segments; i++) {
      const offset = (i - (w.segments - 1) / 2) * w.spacing;
      const px = dest.x + side.x * offset;
      const pz = dest.z + side.z * offset;
      const py = this.terrain.heightAt(px, pz);
      if (this.terrain.raise(px, py, pz, w.radius, w.height)) changed = true;
    }
    if (!changed) {
      this.hud.toast('NOTHING TO BUILD ON', '#ff6b6b', 900);
      return;
    }
    this.fx.dust(dest.clone().add(new THREE.Vector3(0, 1, 0)), 20);
    this.audio.build();
    this.rig.addShake(0.3);
    this.log(`${this.activeBlob.name} raises a wall.`);
  }

  /**
   * Dig straight down at your own feet and drop into the pit — the burrow
   * tool. `holdFrac` (0..1, how long Space was held against the 3s cap)
   * scales the pit from a shallow scrape up to its full radius. Called on
   * every tick while Space is held (see `updateAim`) as well as once more
   * on release, so the blob sinks bit by bit instead of all at once — each
   * call carves from wherever the blob has already settled, and carving the
   * same pit again is a harmless no-op, so the final call on release (which
   * always logs) just tops it off to the exact final radius. `silent` skips
   * the log line for the in-hold ticks.
   */
  burrowSelf(weapon, holdFrac = 1, silent = false) {
    const blob = this.activeBlob;
    const at = blob.position.clone();
    const d = weapon.dig;
    const radius = d.minRadius + (d.radius - d.minRadius) * holdFrac;
    const changed = this.terrain.carve(at.x, at.y + 0.3, at.z, radius);
    this.fx.dust(at, Math.round(silent ? 6 : 10 + 16 * holdFrac));
    this.audio.dig();
    this.rig.addShake(silent ? 0.08 : 0.15 + 0.15 * holdFrac);
    // Settle into the new pit immediately rather than waiting a physics frame,
    // so the blob doesn't look like it's briefly floating over the hole it
    // just dug.
    blob.position.y = this.terrain.heightAt(blob.position.x, blob.position.z) + CFG.blob.radius;
    blob.velocity.y = Math.min(blob.velocity.y, 0);
    blob.grounded = true;
    if (!silent) this.log(changed ? `${blob.name} digs in for cover.` : `${blob.name} scrapes at solid rock.`);
  }

  /**
   * Bore a deep narrow shaft at the aim marker — the drill tool. `holdFrac`
   * (0..1, how long Space was held against the 3s cap) scales the number of
   * overlapping passes, so a tap barely scuffs the ground and a full 3s hold
   * bores the whole shaft. Called on every tick while Space is held (see
   * `updateAim`) as well as once more on release: each call re-bores from
   * the surface down to the current step count, so re-carving passes that
   * were already cut on an earlier tick is a harmless no-op and the shaft
   * simply reads as boring deeper, bit by bit, the longer Space stays down.
   * `silent` skips the log line for the in-hold ticks.
   */
  drillShaft(weapon, holdFrac = 1, silent = false, dest = null) {
    dest = dest ?? this.resolveAimImpact(weapon);
    if (!dest || !this.terrain.inBounds(dest.x, dest.z)) {
      if (!silent) this.hud.toast('NO TARGET', '#ff6b6b', 900);
      return;
    }
    const d = weapon.drill;
    const steps = Math.max(1, Math.round(d.minSteps + (d.maxSteps - d.minSteps) * holdFrac));
    let cy = dest.y + 0.5;
    let changed = false;
    for (let i = 0; i < steps; i++) {
      if (this.terrain.carve(dest.x, cy, dest.z, d.radius)) changed = true;
      // Each pass bores a hemisphere of its own radius; stepping by less than
      // 2x the radius keeps consecutive passes overlapping so the shaft reads
      // as one continuous bore instead of a stack of separate craters.
      cy -= d.radius * 1.4;
    }
    this.fx.dust(dest, Math.round(silent ? 6 : 10 + 16 * holdFrac));
    this.audio.dig();
    this.rig.addShake(silent ? 0.08 : 0.15 + 0.2 * holdFrac);
    if (!silent) {
      this.log(
        changed
          ? `${this.activeBlob.name} bores a shaft into the ground.`
          : `${this.activeBlob.name}'s drill hits bedrock.`
      );
    }
  }

  pickHomingTarget(dir) {
    let best = null;
    let bestScore = -Infinity;
    for (const b of this.blobs) {
      if (!b.alive || b.team === this.activeTeam) continue;
      const to = _v1.subVectors(b.position, this.activeBlob.position);
      const dist = to.length();
      const align = to.normalize().dot(dir);
      const score = align * 2 - dist / 120;
      if (score > bestScore) {
        bestScore = score;
        best = b;
      }
    }
    return best;
  }

  spawnProjectile(weapon, origin, velocity, owner, opts) {
    this.projectiles.push(new Projectile(this, weapon, origin, velocity, owner, opts));
  }

  /** Blast: carve the ground, hurt and fling everything nearby. */
  detonate(pos, radius, damage, owner, sourceName = 'an explosion', opts = {}) {
    this.terrain.carve(pos.x, pos.y, pos.z, radius);
    this.fx.explosion(pos, radius);
    if (!opts.silentBoom) this.audio.explosion(clamp(radius / 6, 0.5, 1.8));

    const camDist = this.camera.position.distanceTo(pos);
    this.rig?.addShake(clamp((radius * 12) / Math.max(8, camDist), 0.1, 1.8));
    this.lastBlast = pos.clone();

    for (const blob of this.blobs) {
      if (!blob.alive) continue;
      const d = blob.position.distanceTo(pos);
      const reach = radius + CFG.blob.radius;
      if (d >= reach) continue;

      const falloff = 1 - d / reach;
      const dealt = blob.damage(damage * falloff, sourceName);

      const dir = _v1.subVectors(blob.position, pos);
      if (dir.lengthSq() < 1e-4) dir.set(0, 1, 0);
      dir.normalize();
      dir.y = Math.abs(dir.y) * 0.6 + 0.75;
      dir.normalize();
      blob.applyImpulse(dir.multiplyScalar(falloff * radius * 2.6 * CFG.blob.knockback));

      if (dealt > 0 && owner && owner.team === blob.team && owner !== blob) {
        this.log(`Friendly fire! ${owner.name} clipped ${blob.name}.`);
      }
    }

    // Chain reactions. Snapshot first — these calls re-enter detonate().
    for (const mine of this.mines.slice()) {
      if (!mine.dead && mine.position.distanceTo(pos) < radius + 1.5) mine.detonate();
    }
    for (const crate of this.crates.slice()) {
      if (!crate.dead && crate.position.distanceTo(pos) < radius + 1.5) crate.cookOff();
    }

    this.hud.updateRoster(this.activeBlob);
  }

  nearestEnemy(blob) {
    let best = null;
    let bestD = Infinity;
    for (const b of this.blobs) {
      if (!b.alive || b.team === blob.team) continue;
      const d = b.position.distanceTo(blob.position);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  // --- supply drops ---------------------------------------------------------

  /**
   * Sudden death. Two evenly matched squads with medkits raining down can heal
   * about as fast as they take damage, so past a turn limit everybody drops to a
   * sliver of health and the sea starts climbing. Guarantees the match ends.
   */
  updateSuddenDeath() {
    if (this.practice || this.turnCount < CFG.turn.suddenDeathTurn) return;

    if (!this.suddenDeath) {
      this.suddenDeath = true;
      for (const b of this.blobs) {
        if (!b.alive) continue;
        b.health = Math.min(b.health, CFG.turn.suddenDeathHealth);
        b.drawLabel();
      }
      this.log('SUDDEN DEATH — the tide is coming in.');
      this.hud.toast('SUDDEN DEATH', '#ff6b6b', 2200);
      this.audio.siren();
    } else {
      CFG.terrain.waterLevel += CFG.terrain.waterRise;
    }
  }

  maybeDropCrate() {
    if (this.crates.length >= CFG.crates.max) return;
    if (!this.rng.chance(CFG.crates.chance)) return;
    const site = chooseDropSite(this);
    if (!site) return;
    const wounded = this.blobs.some((b) => b.alive && b.health < CFG.blob.maxHealth * 0.7);
    const type = this.rng.chance(wounded ? 0.34 : 0.18) ? 'health' : 'weapon';
    const crate = new Crate(this, type, site, type === 'weapon' ? rollLoot(this.rng, this.enabledWeapons) : null);
    this.crates.push(crate);
    this.hud.toast(type === 'health' ? 'MEDKIT INBOUND' : 'SUPPLY DROP', '#cfe0f5', 1100);
  }

  findAICrate(blob) {
    let best = null;
    let bestD = 42;
    for (const c of this.crates) {
      if (c.dead) continue;
      const d = c.position.distanceTo(blob.position);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  // --- frame ----------------------------------------------------------------

  update(dt, time) {
    this.time = time;
    if (this.state === STATE.IDLE) return;

    // The armory and the full map both swallow the mouse; drain it either way so
    // a drag made over a panel doesn't jerk the camera when it closes.
    if (!this.hud.inventoryOpen && !this.mapOpen) {
      const weapon = WEAPONS[this.selectedWeapon];
      const aimingNow = this.input.dragging === 1;
      const wasAiming = this.wasAiming;
      const inPlay = this.state === STATE.AIM || this.state === STATE.PLAY;
      if (aimingNow && !wasAiming && inPlay && this.playerControlled()) {
        // Right button just went down: start the aim fresh from wherever the
        // camera is already looking (view yaw, which folds in any ctrl+right
        // free look) rather than the blob's own facing. The blob's facing can
        // diverge from the view — it follows movement direction while
        // walking or strafing — so snapping aim to it instead yanked the
        // camera around to face the blob rather than holding still where the
        // player was already looking.
        this.rig.aimYaw = this.rig.viewYaw;
        this.rig.yawOffset = 0;
        this.rig.pitchOffset = 0;
      }
      this.wasAiming = aimingNow;
      this.aiming = aimingNow;
      this.rig.handleDrag(this.input.takeDrag());
      const wheel = this.input.takeWheel();
      // While actually lining up a wall, the scroll wheel spins its facing
      // instead of zooming — camera zoom during that window isn't as useful
      // as being able to rotate the ridge to match the terrain.
      if (wheel && weapon?.delivery === 'build' && inPlay && (this.aiming || this.charging)) {
        if (this.wallRotation == null) this.wallRotation = this.defaultWallRotation();
        this.wallRotation += wheel * WALL_ROTATE_STEP;
      } else if (wheel) {
        this.rig.zoom(wheel);
      }
    } else {
      this.aiming = false;
      this.input.takeDrag();
      this.input.takeWheel();
    }

    // The simulation advances in fixed slices, the presentation in real time.
    //
    // This is what keeps online clients agreeing without a determinism audit of
    // every float: projectile and blob physics use only +,-,*,/ and sqrt, all of
    // which IEEE 754 pins down exactly, so identical inputs and an identical
    // timestep give identical results on any machine. With a variable frame dt
    // two clients integrate the same rocket differently and carve craters in
    // slightly different places, which forced a full terrain resync every shot.
    this.acc = Math.min(this.acc + dt, 0.25); // cap: never spiral on a stall
    while (this.acc >= FIXED_DT) {
      this.acc -= FIXED_DT;
      this.step(FIXED_DT);
    }

    this.fx.update(dt, time);
    this.rig.update(dt);
    this.minimap?.update(dt);
    this.hud.updateRoster(this.activeBlob);
    this.hud.updateHighlights(this.highlightBlobs());
  }

  /** One fixed simulation slice. */
  step(dt) {
    switch (this.state) {
      case STATE.AIM:
        this.updateAim(dt);
        break;
      case STATE.RETREAT:
        this.updateRetreat(dt);
        break;
      case STATE.FLIGHT:
        this.updateFlight(dt);
        break;
      case STATE.SETTLE:
        this.updateSettle(dt);
        break;
      case STATE.PLAY:
        this.updateRealtime(dt);
        break;
    }

    // Burst fire keeps feeding the barrel regardless of phase.
    if (this.burst) {
      this.burst.t -= dt;
      if (this.burst.t <= 0) this.fireBurstRound();
    }

    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.update(dt);
      if (p.dead) this.projectiles.splice(i, 1);
    }

    // Mines and crates live outside the turn state machine.
    for (let i = this.mines.length - 1; i >= 0; i--) {
      this.mines[i].update(dt);
      if (this.mines[i].dead) this.mines.splice(i, 1);
    }
    for (let i = this.crates.length - 1; i >= 0; i--) {
      this.crates[i].update(dt);
      if (this.crates[i].dead) this.crates.splice(i, 1);
    }

    for (const b of this.blobs) b.update(dt);

    // Firearms: the body/gun visually tracks the live mouse aim while you're
    // actively aiming. This has to happen after the blob update above —
    // walk() there re-derives facing from the movement direction, which
    // would otherwise spin the model away from the barrel while strafing.
    if ((this.state === STATE.AIM || this.state === STATE.PLAY) && this.isLocalTurn()) {
      const blob = this.activeBlob;
      if (blob.alive && this.aiming && WEAPONS[this.selectedWeapon].category === 'gun') {
        blob.facing = this.rig.aimYaw;
      }
    }

    // A remotely driven blob is interpolated toward the streamed transform
    // rather than simulated, so walking can never drift between clients.
    for (const b of this.blobs) {
      if (!b.netPose) continue;
      b.position.lerp(_v1.set(b.netPose.x, b.netPose.y, b.netPose.z), Math.min(1, dt * 14));
      b.velocity.set(0, 0, 0);
    }
    separateBlobs(this.blobs);

    // Same treatment for the remote camera/aim angles — lerp toward the last
    // received target instead of snapping, and use the shortest way around for
    // yaw so it doesn't spin the long way past the -PI/PI seam.
    if (this.rig.netAimYaw !== null) {
      const k = Math.min(1, dt * 14);
      this.rig.aimYaw += shortestAngle(this.rig.aimYaw, this.rig.netAimYaw) * k;
      this.rig.aimPitch += (this.rig.netAimPitch - this.rig.aimPitch) * k;
    }

    // Publish our own blob while it's our turn. Kept alive through a burst
    // even once state has moved on to FLIGHT, so an observer's aim keeps
    // tracking the live mouse for the rest of a full-auto spray instead of
    // freezing on the direction of the first round.
    if (
      this.net &&
      this.isLocalTurn() &&
      (this.state === STATE.AIM || this.state === STATE.RETREAT || this.state === STATE.PLAY || this.burst)
    ) {
      this.poseTimer -= dt;
      if (this.poseTimer <= 0) {
        this.poseTimer = 1 / 15;
        this.net.sendPose(this.capturePose());
      }
    }
  }

  updateAim(dt) {
    const blob = this.activeBlob;
    if (!blob.alive) return void this.endTurn();

    if (this.fireCooldown > 0) this.fireCooldown = Math.max(0, this.fireCooldown - dt);

    if (this.activeTeam.isAI) {
      if (this.iAmActor()) this.updateAI(dt);
    } else if (this.isLocalTurn() && !this.hud.inventoryOpen && !this.mapOpen) {
      this.readMovement(blob);
      if (this.charging) {
        // Bounces between min and max instead of maxing out and auto-firing —
        // release has to be timed, same as the arc/impact preview it drives.
        this.power += CFG.shot.chargeRate * dt * this.chargeDir;
        if (this.power >= CFG.shot.maxPower) {
          this.power = CFG.shot.maxPower;
          this.chargeDir = -1;
        } else if (this.power <= CFG.shot.minPower) {
          this.power = CFG.shot.minPower;
          this.chargeDir = 1;
        }
      } else if (this.digging) {
        this.digTimer = Math.min(CFG.dig.maxHold, this.digTimer + dt);
        // Actually carve a bit more every ~0.25s instead of only charging up
        // silently and dumping the whole shaft/pit out on release — burrow
        // and drill scale their own effect by the current (still-growing)
        // hold fraction, so each tick pushes the blob a little further down
        // (burrow) or bores a little deeper (drill) while Space stays held.
        if (this.digTimer - this.digTickAt >= 0.25) {
          this.digTickAt = this.digTimer;
          const w = WEAPONS[this.selectedWeapon];
          const frac = this.digTimer / CFG.dig.maxHold;
          if (w.delivery === 'burrow') this.burrowSelf(w, frac, true);
          else this.drillShaft(w, frac, true, this.digDest);
        }
        if (this.digTimer >= CFG.dig.maxHold) {
          this.stopDig();
          return;
        }
      }
    } else {
      // Somebody else's turn: their blob is driven by the pose stream, and our
      // keyboard must not touch it.
      blob.moveInput.set(0, 0);
    }

    this.rig.setTarget(blob.position);
    this.rig.followSpeed = 8;

    // The armory pauses the clock, same as picking a weapon in the original.
    // So does the full map — reading it is planning, not playing.
    if (!this.hud.inventoryOpen && !this.mapOpen) {
      this.timer -= dt;
      const secs = Math.ceil(this.timer);
      if (secs <= 5 && secs !== this.lastTickSecond && secs > 0) this.audio.tick();
      this.lastTickSecond = secs;
    }
    this.hud.setTimer(this.timer, 'run');
    // Only whoever owns the turn may end it. An observer that ended its own copy
    // of the turn would drop into SETTLE and then reject the incoming fire
    // command, so the shot would never appear on their screen.
    if (this.timer <= 0 && (this.iAmActor() || !this.net)) {
      this.log(`${blob.name} ran out of time.`);
      this.emit({ t: 'endTurn' });
      return;
    }

    this.updatePreview();
    const frac = (this.power - CFG.shot.minPower) / (CFG.shot.maxPower - CFG.shot.minPower);
    const digFrac = this.digTimer / CFG.dig.maxHold;
    this.hud.setPower(
      this.charging ? frac : this.digging ? digFrac : 0,
      (this.rig.aimPitch * 180) / Math.PI,
      this.charging || this.digging
    );
  }

  updateRetreat(dt) {
    const blob = this.activeBlob;
    this.retreatTimer -= dt;
    this.hud.setTimer(this.retreatTimer, 'retreat');
    if (blob.alive && this.isLocalTurn() && !this.mapOpen) this.readMovement(blob);
    this.rig.setTarget(blob.position);
    if (this.retreatTimer <= 0 || !blob.alive) {
      blob.moveInput.set(0, 0);
      this.state = STATE.FLIGHT;
      this.flightTimeout = 14;
    }
  }

  readMovement(blob) {
    const i = this.input;
    let f = 0;
    let r = 0;
    if (i.down('w', 'up')) f += 1;
    if (i.down('s', 'down')) f -= 1;
    if (i.down('d', 'right')) r += 1;
    if (i.down('a', 'left')) r -= 1;

    if (!f && !r) {
      blob.moveInput.set(0, 0);
      return;
    }
    // Camera-relative, using the full view direction (aim plus any right-drag
    // free look) rather than just the aim yaw — otherwise WASD kept moving
    // you toward wherever you last dragged your *shot* to, even while you'd
    // since looked somewhere else entirely with a free look.
    const yaw = this.rig.aimYaw + this.rig.yawOffset;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    blob.moveInput.set(fx * f - fz * r, fz * f + fx * r);
  }

  updateAI(dt) {
    const blob = this.activeBlob;
    // Real-time can have several AI teams thinking at once, all sharing this
    // one Game — but the HUD widgets below are the single local player's
    // power meter/inventory/preview, so only the AI standing in as *my* team's
    // context (never true in turn-based, where isLocalTurn() already keeps
    // AI off this path) gets to touch them.
    const showOnHud = !this.realtime || this.activeTeam === this.myTeam;
    if (showOnHud) this.hud.setPower(0, (this.rig.aimPitch * 180) / Math.PI, false);
    if (this.fireCooldown > 0) this.fireCooldown = Math.max(0, this.fireCooldown - dt);

    // Phase 1: waddle over to a nearby supply crate if there is one.
    if (this.aiPhase === 'walk') {
      this.aiWalkTimer += dt;
      const crate = this.aiCrate;
      if (!crate || crate.dead || this.aiWalkTimer > 5) {
        blob.moveInput.set(0, 0);
        this.aiPhase = 'aim';
      } else {
        const dx = crate.position.x - blob.position.x;
        const dz = crate.position.z - blob.position.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.5) {
          this.aiPhase = 'aim';
          blob.moveInput.set(0, 0);
        } else {
          blob.moveInput.set(dx / d, dz / d);
          this.rig.setTarget(blob.position);
          this.timer -= dt;
          return;
        }
      }
    }

    this.aiTimer -= dt;
    if (this.aiPlan === undefined && this.aiTimer < CFG.turn.aiThinkTime * 0.75) {
      this.aiPlan = planShot(this, blob) || null;
      if (this.aiPlan) {
        this.selectedWeapon = this.aiPlan.weaponId;
        if (showOnHud) this.hud.updateInventory(this.activeTeam.ammo, this.selectedWeapon);
      }
    }

    if (this.aiPlan) {
      const k = Math.min(1, dt * 4.5);
      this.rig.aimYaw += shortestAngle(this.rig.aimYaw, this.aiPlan.yaw) * k;
      this.rig.aimPitch += (this.aiPlan.pitch - this.rig.aimPitch) * k;
      this.power = this.aiPlan.power;
      if (showOnHud) this.updatePreview(0.55);
    }

    if (this.aiTimer <= 0) {
      if (!this.aiPlan) {
        this.log(`${blob.name} can't find a shot.`);
        // Turn-based: nothing to shoot with, so pass. Real-time: there's no
        // turn to end — just try again once it's had time to reconsider.
        if (this.realtime) this.aiTimer = CFG.turn.aiThinkTime;
        else this.endTurn();
        return;
      }
      // Real-time only: the post-shot cooldown from the last round (see
      // executeFire) has to run out before firing again, same as it does for
      // the human player.
      if (this.realtime && this.fireCooldown > 0) return;
      this.rig.aimYaw = this.aiPlan.yaw;
      this.rig.aimPitch = this.aiPlan.pitch;
      this.power = this.aiPlan.power;
      this.fire();
      if (this.realtime) {
        // Re-think for the next shot instead of firing this stale plan again
        // next frame — turn-based never reaches a second shot here since the
        // turn ends (or, at most, a fresh beginTurn resets all of this).
        this.aiPlan = undefined;
        this.aiTimer = CFG.turn.aiThinkTime;
      }
    }
  }

  updatePreview(opacity = 0.85) {
    const weapon = WEAPONS[this.selectedWeapon];

    // A homing lock made on the map: highlight it regardless of what the
    // camera is currently pointed at, so the lock reads as "set" rather than
    // something that might still change with the next mouse move.
    this.lockMarker.visible = !!(weapon.homing && this.mapHomingTarget?.alive);
    if (this.lockMarker.visible) {
      this.lockMarker.position.copy(this.mapHomingTarget.position);
      this.lockMarker.position.y += 0.15;
    }

    const arcs =
      weapon.delivery === 'launch' ||
      weapon.delivery === 'airstrike' ||
      weapon.delivery === 'teleport' ||
      weapon.delivery === 'build' ||
      weapon.delivery === 'drill';
    if (!arcs) {
      this.aimPreview.visible = false;
      this.impactMarker.visible = false;
      this.wallShadow.visible = false;
      this.previewImpact = null;
      return;
    }

    // A point placed on the map: show the marker there directly instead of
    // simulating an imaginary shot to guess a landing spot (see callAirstrike).
    if (weapon.delivery === 'airstrike' && this.mapTarget) {
      this.aimPreview.visible = false;
      this.wallShadow.visible = false;
      this.previewImpact = this.mapTarget;
      const normal = this.terrain.normalAt(this.mapTarget.x, this.mapTarget.z, _v1);
      this.impactMarker.visible = true;
      this.impactMarker.position.copy(this.mapTarget).addScaledVector(normal, 0.6);
      this.impactMarker.quaternion.setFromUnitVectors(_ringAxis, normal);
      this.impactMarker.scale.setScalar((weapon.strike.count * weapon.strike.spacing) / 2.4);
      return;
    }

    // Mid-bore, the marker has to stay put at the spot startDig locked in —
    // re-simulating the arc against camera movement here would drift the
    // ring away from where the shaft is actually being carved (see
    // startDig's note on why the dig target itself is cached).
    if (weapon.delivery === 'drill' && this.digging && this.digDest) {
      this.aimPreview.visible = false;
      this.wallShadow.visible = false;
      this.previewImpact = this.digDest;
      const normal = this.terrain.normalAt(this.digDest.x, this.digDest.z, _v1);
      this.impactMarker.visible = true;
      this.impactMarker.position.copy(this.digDest).addScaledVector(normal, 0.6);
      this.impactMarker.quaternion.setFromUnitVectors(_ringAxis, normal);
      this.impactMarker.scale.setScalar(Math.max(2, weapon.radius * 0.5));
      return;
    }

    // The live simulated arc is only useful while you're actively pointing
    // it — for your own turn, that means holding the aim button or charging
    // a shot. Otherwise it's a stale line pointing wherever the camera last
    // happened to face, which is exactly the clutter that made a free-look
    // followed by a fresh drag read as broken. AI planning and watching a
    // remote player's turn are unaffected — playerControlled() is false then.
    if (this.playerControlled() && !this.aiming && !this.charging && !this.digging) {
      this.aimPreview.visible = false;
      this.impactMarker.visible = false;
      this.wallShadow.visible = false;
      this.previewImpact = null;
      return;
    }

    const dir = this.rig.aimDirection();
    const origin = this.shotOrigin(this.activeBlob, dir, _v2);
    const power = this.charging || this.activeTeam.isAI
      ? this.power
      : weapon.noCharge
        ? (weapon.power ?? CFG.shot.maxPower)
        : CFG.shot.maxPower * 0.6;
    const vel = _v3.copy(dir).multiplyScalar(power);

    const res = simulateTrajectory(origin, vel, weapon, this.terrain, this.wind, {
      dt: 1 / 40,
      maxT: 8,
    });

    const pts = res.points;
    const arr = this.aimPreview.geometry.attributes.position.array;
    const stride = Math.max(1, Math.floor(pts.length / PREVIEW_DOTS));
    let count = 0;
    for (let i = 0; i < pts.length && count < PREVIEW_DOTS; i += stride) {
      arr[count * 3] = pts[i].x;
      arr[count * 3 + 1] = pts[i].y;
      arr[count * 3 + 2] = pts[i].z;
      count++;
    }
    this.aimPreview.geometry.setDrawRange(0, count);
    this.aimPreview.geometry.attributes.position.needsUpdate = true;
    this.aimPreview.material.opacity = this.charging ? 0.95 : opacity * 0.55;
    this.aimPreview.visible = count > 1;

    this.previewImpact = res.impact && res.reason !== 'offmap' ? res.impact : null;
    if (this.previewImpact && weapon.delivery === 'build') {
      // The wall builder gets its own footprint shadow instead of the
      // generic ring — see updateWallShadow.
      this.impactMarker.visible = false;
      if (this.wallRotation == null) this.wallRotation = this.defaultWallRotation();
      this.updateWallShadow(weapon, this.previewImpact, this.wallRotation);
    } else if (this.previewImpact) {
      this.wallShadow.visible = false;
      const normal = this.terrain.normalAt(res.impact.x, res.impact.z, _v1);
      this.impactMarker.visible = true;
      this.impactMarker.position.copy(res.impact).addScaledVector(normal, 0.6);
      // RingGeometry faces +Z, so that's the axis we align with the surface.
      this.impactMarker.quaternion.setFromUnitVectors(_ringAxis, normal);
      const size =
        weapon.delivery === 'airstrike'
          ? (weapon.strike.count * weapon.strike.spacing) / 2.4
          : Math.max(2, weapon.radius * 0.5);
      this.impactMarker.scale.setScalar(size);
    } else {
      this.impactMarker.visible = false;
      this.wallShadow.visible = false;
    }
  }

  /** Perpendicular-to-aim default for the wall builder's facing, in the same yaw convention as rig.aimYaw. */
  defaultWallRotation() {
    return this.rig.aimYaw - Math.PI / 2;
  }

  /**
   * Lay out the wall builder's footprint preview — one flat disc per stamp
   * buildWall will raise, positioned with the exact same spacing formula so
   * the shadow always matches what pressing build actually produces.
   */
  updateWallShadow(weapon, dest, rotation) {
    const w = weapon.wall;
    const side = _v1.set(Math.sin(rotation), 0, Math.cos(rotation)).normalize();
    const sx = side.x;
    const sz = side.z;
    for (let i = 0; i < WALL_SHADOW_MAX; i++) {
      const disc = this.wallShadowDiscs[i];
      if (i >= w.segments) {
        disc.visible = false;
        continue;
      }
      const offset = (i - (w.segments - 1) / 2) * w.spacing;
      const px = dest.x + sx * offset;
      const pz = dest.z + sz * offset;
      const py = this.terrain.heightAt(px, pz);
      disc.position.set(px, py + 0.08, pz);
      disc.scale.setScalar(w.radius);
      disc.visible = true;
    }
    this.wallShadow.visible = true;
  }

  updateFlight(dt) {
    this.hud.setTimer(0, 'off');
    this.flightTimeout -= dt;

    const live = this.projectiles.find((p) => !p.dead);
    if (live) {
      this.rig.setTarget(live.position);
      this.rig.followSpeed = 7;
    } else if (this.lastBlast) {
      this.rig.setTarget(this.lastBlast);
    } else if (this.activeBlob) {
      this.rig.setTarget(this.activeBlob.position);
    }

    const quiet = !this.projectiles.length && !this.burst;
    if ((quiet || this.flightTimeout <= 0) && !this.explodePause) this.explodePause = 0.9;
    if (this.explodePause > 0) {
      this.explodePause -= dt;
      if (this.explodePause <= 0) {
        this.explodePause = 0;
        this.endTurn();
      }
    }
  }

  updateSettle(dt) {
    this.hud.setTimer(0, 'off');

    // Chain reactions: blow up anything that hit zero health, one at a time.
    const dying = this.blobs.find((b) => b.alive && b.pendingDeath);
    if (dying) {
      this.rig.setTarget(dying.position);
      dying.kill(true);
      this.settleTimer = CFG.turn.settleTime;
      return;
    }

    const busy =
      this.projectiles.length > 0 ||
      this.burst ||
      this.blobs.some((b) => b.alive && (!b.grounded || b.velocity.lengthSq() > 0.6));

    if (busy) {
      this.settleTimer = CFG.turn.settleTime;
      const mover = this.blobs.find((b) => b.alive && !b.grounded);
      if (mover && !this.lastBlast) this.rig.setTarget(mover.position);
      return;
    }

    this.settleTimer -= dt;
    if (this.settleTimer <= 0) {
      this.lastBlast = null;
      this.explodePause = 0;

      // Second barrel of a multi-shot weapon: same blob keeps the floor.
      if (this.shotsLeft > 0 && this.activeBlob && this.activeBlob.alive && !this.checkVictory()) {
        this.state = STATE.AIM;
        this.timer = this.practice
          ? Infinity
          : Math.min(this.timer > 0 ? this.timer : CFG.turn.extraShotTime, CFG.turn.extraShotTime);
        this.lastTickSecond = Math.ceil(this.timer);
        this.hud.setControlsVisible(!this.activeTeam.isAI);
        this.hud.toast('SECOND BARREL', '#ffd166', 900);
        if (this.activeTeam.isAI) {
          this.aiPhase = 'aim';
          this.aiTimer = CFG.turn.aiThinkTime * 0.6;
          this.aiPlan = undefined;
        }
        return;
      }
      this.shotsLeft = 0;
      this.completeTurn();
    }
  }

  randomizeWind() {
    const a = this.rng.next() * Math.PI * 2;
    const m = Math.pow(this.rng.next(), 0.8) * CFG.wind.max;
    // Rounded to the precision the snapshot transmits: the acting client must
    // fly its shot through exactly the wind everyone else is told about.
    this.wind.set(round2(Math.cos(a) * m), 0, round2(Math.sin(a) * m));
  }
}

const PREVIEW_DOTS = 110;
/** Pool size for the wall builder's footprint preview — covers any wall's segment count. */
const WALL_SHADOW_MAX = 8;
/** Radians the wall builder's facing rotates per wheel notch while aiming it. */
const WALL_ROTATE_STEP = Math.PI / 12;
/** Simulation slice. Must be identical on every client — see Game.update. */
const FIXED_DT = 1 / 60;
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _ringAxis = new THREE.Vector3(0, 0, 1);

/** Trim float noise out of network payloads. */
function round2(v) {
  return Math.round(v * 100) / 100;
}

function shortestAngle(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Pure deterministic pseudo-random value in [-1, 1] — a murmur3-style integer
 * hash of the inputs, not a stream. See fireBurstRound: real-time mode needs
 * spread jitter that every client can reproduce independently, without a
 * shared mutable RNG whose draw order can no longer be guaranteed once more
 * than one team can be firing at the same time.
 */
function hashSpread(seed, blobId, round, axis) {
  let h = (seed ^ Math.imul(blobId + 1, 2654435761) ^ Math.imul(round, 2246822519) ^ Math.imul(axis, 3266489917)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}
