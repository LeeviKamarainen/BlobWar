/**
 * Weapon registry.
 *
 * Everything is data-driven — `Projectile` and `Game.fire()` read these fields
 * rather than special-casing weapon ids, so a new weapon is usually just a new
 * entry here.
 *
 * Fields:
 *   delivery   'launch' (aimed arc) | 'drop' (at your feet) | 'airstrike'
 *              (falls from the sky onto the aim marker) | 'melee' | 'teleport' |
 *              'build' (raises terrain at the aim marker) | 'burrow' (hold to
 *              dig in at your own feet, deeper the longer you hold) | 'drill'
 *              (hold to bore a shaft at the aim marker, deeper the longer you
 *              hold) — 'burrow'/'drill' read CFG.dig.maxHold as their cap and
 *              scale their `dig`/`drill` shape by the held fraction, see
 *              Game.startDig/stopDig
 *   detonate   'impact' | 'fuse' | 'proximity' | 'never'
 *   wind       how hard the wind pushes it, 0..1
 *   gravityScale  multiplier on gravity (homing missiles float, slugs ignore it)
 *   bounce     restitution off terrain; absent means it detonates on contact
 *   children   spawn N copies of another weapon when it goes off
 *   burst      fire N rounds over time from one trigger pull
 *   shots      trigger pulls per ammo unit (shotgun gets two)
 *   retreat    seconds of free movement after use, before the turn ends
 *   noCharge   fires at fixed `power` the moment you press fire
 *   internal   spawned by other weapons; never shown in the inventory
 */

export const CATEGORIES = [
  { id: 'launch', name: 'Launchers' },
  { id: 'throw', name: 'Throwables' },
  { id: 'gun', name: 'Firearms' },
  { id: 'air', name: 'Airborne' },
  { id: 'tool', name: 'Utility' },
];

export const WEAPONS = {
  // --- launchers ------------------------------------------------------------
  bazooka: {
    id: 'bazooka',
    name: 'Bazooka',
    icon: '🚀',
    category: 'launch',
    desc: 'The workhorse. Fully at the mercy of the wind.',
    ammo: Infinity,
    delivery: 'launch',
    detonate: 'impact',
    damage: 50,
    radius: 7,
    wind: 1,
    shape: 'rocket',
    color: 0xffd166,
    scale: 0.5,
  },
  homing: {
    id: 'homing',
    name: 'Homing Missile',
    icon: '🎯',
    category: 'launch',
    desc: 'Locks onto the enemy you point it at once the booster lights.',
    ammo: 2,
    delivery: 'launch',
    detonate: 'impact',
    damage: 46,
    radius: 6.5,
    wind: 0.3,
    gravityScale: 0.35,
    homing: { delay: 0.6, strength: 2.4 },
    shape: 'rocket',
    color: 0xff7ad9,
    scale: 0.5,
  },
  mortar: {
    id: 'mortar',
    name: 'Mortar',
    icon: '⚗️',
    category: 'launch',
    desc: 'Modest blast that kicks five shards straight back up.',
    ammo: 3,
    delivery: 'launch',
    detonate: 'impact',
    damage: 28,
    radius: 5,
    wind: 0.7,
    children: { weapon: 'mortarShard', count: 5, spread: 5, up: 15 },
    shape: 'rocket',
    color: 0x9fb4c7,
    scale: 0.44,
  },
  cluster: {
    id: 'cluster',
    name: 'Cluster Bomb',
    icon: '☄️',
    category: 'launch',
    desc: 'Bursts into six bomblets that scatter wide.',
    ammo: 3,
    delivery: 'launch',
    detonate: 'impact',
    damage: 22,
    radius: 4.2,
    wind: 0.85,
    children: { weapon: 'clusterShard', count: 6, spread: 9, up: 11 },
    shape: 'ball',
    color: 0xc77dff,
    scale: 0.46,
  },
  firebomb: {
    id: 'firebomb',
    name: 'Firebomb',
    icon: '🔥',
    category: 'launch',
    desc: 'Splashes burning embers across a wide patch of ground.',
    ammo: 2,
    delivery: 'launch',
    detonate: 'impact',
    damage: 18,
    radius: 4,
    wind: 0.9,
    children: { weapon: 'ember', count: 11, spread: 13, up: 7 },
    shape: 'ball',
    color: 0xff6a2b,
    scale: 0.44,
  },

  // --- throwables -----------------------------------------------------------
  grenade: {
    id: 'grenade',
    name: 'Grenade',
    icon: '💣',
    category: 'throw',
    desc: 'Bounces, then goes off on a three second fuse.',
    ammo: Infinity,
    delivery: 'launch',
    detonate: 'fuse',
    fuse: 3,
    bounce: 0.52,
    damage: 45,
    radius: 6,
    wind: 0.2,
    shape: 'ball',
    color: 0x7ed957,
    scale: 0.42,
  },
  fruitBomb: {
    id: 'fruitBomb',
    name: 'Fruit Bomb',
    icon: '🍌',
    category: 'throw',
    desc: 'Splits into five bouncing fruitlets with short fuses.',
    ammo: 2,
    delivery: 'launch',
    detonate: 'fuse',
    fuse: 3.4,
    bounce: 0.5,
    damage: 30,
    radius: 5,
    wind: 0.25,
    children: { weapon: 'fruitlet', count: 5, spread: 8, up: 10 },
    shape: 'banana',
    color: 0xffe14d,
    scale: 0.5,
  },
  melon: {
    id: 'melon',
    name: 'Sacred Melon',
    icon: '🍈',
    category: 'throw',
    desc: 'One per match. Sing a hymn and take cover.',
    ammo: 1,
    delivery: 'launch',
    detonate: 'fuse',
    fuse: 4,
    bounce: 0.58,
    damage: 115,
    radius: 14,
    wind: 0.3,
    chant: true,
    shape: 'melon',
    color: 0x8ce36b,
    scale: 0.75,
  },
  dynamite: {
    id: 'dynamite',
    name: 'Dynamite',
    icon: '🧨',
    category: 'throw',
    desc: 'Planted at your feet. Four seconds to get clear.',
    ammo: 3,
    delivery: 'drop',
    detonate: 'fuse',
    fuse: 4,
    bounce: 0.15,
    damage: 85,
    radius: 10,
    wind: 0,
    retreat: 4.5,
    noCharge: true,
    shape: 'stick',
    color: 0xd94f3d,
    scale: 0.5,
  },
  mine: {
    id: 'mine',
    name: 'Land Mine',
    icon: '⚫',
    category: 'throw',
    desc: 'Arms after a moment, then waits. Stays put between turns.',
    ammo: 4,
    delivery: 'drop',
    detonate: 'proximity',
    armTime: 2.5,
    trigger: 3.2,
    damage: 55,
    radius: 6.5,
    wind: 0,
    retreat: 3.5,
    noCharge: true,
    shape: 'mine',
    color: 0x2e3440,
    scale: 0.45,
  },

  // --- firearms -------------------------------------------------------------
  scattergun: {
    id: 'scattergun',
    name: 'Scattergun',
    icon: '🔫',
    category: 'gun',
    desc: 'Two barrels, two shots per pickup. Flat trajectory.',
    ammo: 4,
    delivery: 'launch',
    detonate: 'impact',
    damage: 28,
    radius: 2.8,
    wind: 0,
    gravityScale: 0.12,
    noCharge: true,
    power: 95,
    shots: 2,
    shape: 'slug',
    color: 0xf5f0e1,
    scale: 0.2,
  },
  uzi: {
    id: 'uzi',
    name: 'Uzi',
    icon: '🔩',
    category: 'gun',
    desc: 'Ten rounds downrange. Individually pathetic, collectively rude.',
    ammo: 3,
    delivery: 'launch',
    detonate: 'impact',
    damage: 9,
    radius: 1.4,
    wind: 0,
    gravityScale: 0.1,
    noCharge: true,
    power: 105,
    burst: { count: 10, interval: 0.07, spread: 0.035 },
    shape: 'slug',
    color: 0xffe9a8,
    scale: 0.15,
  },

  // --- airborne -------------------------------------------------------------
  airstrike: {
    id: 'airstrike',
    name: 'Air Strike',
    icon: '✈️',
    category: 'air',
    desc: 'Five bombs walked across wherever your marker sits.',
    ammo: 2,
    delivery: 'airstrike',
    strike: { weapon: 'strikeBomb', count: 5, spacing: 7, height: 95 },
    damage: 0,
    radius: 0,
    wind: 0,
    shape: 'ball',
    color: 0x8fa3b8,
    scale: 0.4,
  },
  mule: {
    id: 'mule',
    name: 'Iron Mule',
    icon: '🐴',
    category: 'air',
    desc: 'One per match. A very heavy animal, delivered from orbit.',
    ammo: 1,
    delivery: 'airstrike',
    strike: { weapon: 'muleBody', count: 1, spacing: 0, height: 120 },
    damage: 0,
    radius: 0,
    wind: 0,
    shape: 'ball',
    color: 0x7a7f88,
    scale: 0.5,
  },

  // --- utility --------------------------------------------------------------
  bat: {
    id: 'bat',
    name: 'Baseball Bat',
    icon: '🏏',
    category: 'tool',
    desc: 'Sends anything within swinging distance on a long journey.',
    ammo: 3,
    delivery: 'melee',
    range: 5.5,
    damage: 30,
    radius: 0,
    launchSpeed: 34,
    wind: 0,
    noCharge: true,
    retreat: 0,
  },
  teleport: {
    id: 'teleport',
    name: 'Teleport',
    icon: '✨',
    category: 'tool',
    desc: 'Blink to wherever the aim marker is resting.',
    ammo: 3,
    delivery: 'teleport',
    damage: 0,
    radius: 0,
    wind: 0,
  },
  wallBuilder: {
    id: 'wallBuilder',
    name: 'Wall Builder',
    icon: '🧱',
    category: 'tool',
    desc: 'Mounds a ridge of earth wherever the aim marker lands. Charge for range.',
    ammo: 3,
    delivery: 'build',
    damage: 0,
    radius: 2.6,
    wind: 0,
    wall: { segments: 3, spacing: 2.3, radius: 2.6, height: 9 },
  },
  burrow: {
    id: 'burrow',
    name: 'Burrow',
    icon: '🕳️',
    category: 'tool',
    desc: 'Hold to dig down at your feet — the longer you hold, the deeper you go.',
    ammo: 3,
    delivery: 'burrow',
    damage: 0,
    radius: 0,
    wind: 0,
    dig: { minRadius: 1.6, radius: 5.5 },
  },
  drill: {
    id: 'drill',
    name: 'Drill',
    icon: '⛏️',
    category: 'tool',
    desc: 'Hold to bore into the aim marker — the longer you hold, the deeper the shaft.',
    ammo: 3,
    delivery: 'drill',
    damage: 0,
    radius: 2.6,
    wind: 0,
    noCharge: true,
    power: 34,
    drill: { radius: 2.6, minSteps: 1, maxSteps: 6 },
  },

  // --- internal munitions ---------------------------------------------------
  clusterShard: {
    id: 'clusterShard',
    name: 'bomblet',
    internal: true,
    delivery: 'launch',
    detonate: 'impact',
    damage: 26,
    radius: 4.6,
    wind: 0.85,
    shape: 'ball',
    color: 0xc77dff,
    scale: 0.24,
  },
  mortarShard: {
    id: 'mortarShard',
    name: 'mortar shard',
    internal: true,
    delivery: 'launch',
    detonate: 'impact',
    damage: 24,
    radius: 4.2,
    wind: 0.6,
    shape: 'slug',
    color: 0x9fb4c7,
    scale: 0.2,
  },
  fruitlet: {
    id: 'fruitlet',
    name: 'fruitlet',
    internal: true,
    delivery: 'launch',
    detonate: 'fuse',
    fuse: 1.7,
    bounce: 0.48,
    damage: 32,
    radius: 5,
    wind: 0.25,
    shape: 'banana',
    color: 0xffe14d,
    scale: 0.26,
  },
  ember: {
    id: 'ember',
    name: 'ember',
    internal: true,
    delivery: 'launch',
    detonate: 'impact',
    damage: 12,
    radius: 3,
    wind: 0.9,
    shape: 'ball',
    color: 0xff8c3a,
    scale: 0.18,
  },
  strikeBomb: {
    id: 'strikeBomb',
    name: 'Air Strike',
    internal: true,
    delivery: 'launch',
    detonate: 'impact',
    damage: 38,
    radius: 6,
    wind: 0.15,
    shape: 'rocket',
    color: 0x8fa3b8,
    scale: 0.42,
  },
  muleBody: {
    id: 'muleBody',
    name: 'Iron Mule',
    internal: true,
    delivery: 'launch',
    detonate: 'impact',
    damage: 130,
    radius: 16,
    wind: 0,
    gravityScale: 1.8,
    shape: 'mule',
    color: 0x7a7f88,
    scale: 1.5,
  },
};

/** Player-visible weapons, in inventory order. */
export const WEAPON_ORDER = Object.keys(WEAPONS).filter((id) => !WEAPONS[id].internal);

/** The first nine get number-key shortcuts. */
export const QUICK_SLOTS = WEAPON_ORDER.slice(0, 9);

/** Weapons the AI understands how to aim: plain arcing shots only. */
export const AI_WEAPONS = ['bazooka', 'grenade', 'homing', 'cluster', 'mortar', 'melon', 'fruitBomb'];

/** Always available — the two infinite-ammo staples can't be turned off. */
export const CORE_WEAPONS = ['bazooka', 'grenade'];

/**
 * @param {Set<string>|null} enabledIds  weapons the match allows, beyond the
 *   core two; null means every weapon is on (the default).
 */
export function startingAmmo(enabledIds = null) {
  const out = {};
  for (const id of WEAPON_ORDER) {
    const allowed = !enabledIds || CORE_WEAPONS.includes(id) || enabledIds.has(id);
    out[id] = allowed ? WEAPONS[id].ammo : 0;
  }
  return out;
}

/** Practice Range: everything unlocked, nothing ever runs out. */
export function practiceAmmo() {
  const out = {};
  for (const id of WEAPON_ORDER) out[id] = Infinity;
  return out;
}

/** Weapons a crate can hand out, weighted so the big ones stay rare. */
export const CRATE_LOOT = [
  { id: 'grenade', n: 2, w: 3 },
  { id: 'cluster', n: 2, w: 3 },
  { id: 'mortar', n: 2, w: 3 },
  { id: 'homing', n: 1, w: 3 },
  { id: 'scattergun', n: 2, w: 3 },
  { id: 'uzi', n: 2, w: 3 },
  { id: 'dynamite', n: 1, w: 3 },
  { id: 'mine', n: 2, w: 2 },
  { id: 'firebomb', n: 1, w: 2 },
  { id: 'fruitBomb', n: 1, w: 2 },
  { id: 'airstrike', n: 1, w: 2 },
  { id: 'teleport', n: 2, w: 2 },
  { id: 'bat', n: 1, w: 2 },
  { id: 'wallBuilder', n: 2, w: 2 },
  { id: 'burrow', n: 2, w: 2 },
  { id: 'drill', n: 2, w: 2 },
  { id: 'melon', n: 1, w: 1 },
  { id: 'mule', n: 1, w: 1 },
];
