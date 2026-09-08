// Central tuning knobs. Everything gameplay-ish lives here so it can be tweaked
// without hunting through the simulation code. Weapons live in weapons.js.

export const CFG = {
  terrain: {
    size: 280,        // world units across (square island)
    seg: 280,         // heightmap cells per side (1 unit per cell)
    maxHeight: 62,
    seaFloor: -11,
    waterLevel: 0,   // mutable: sudden death raises it (reset on every new match)
    waterRise: 0.6,  // units the sea climbs per turn once sudden death starts
  },
  physics: {
    gravity: 24,      // mutable: a match can pick a preset below (reset on every new match)
    bounce: 0.42,     // vertical restitution when a blob lands hard
    friction: 0.72,   // horizontal damping per landing
    airDrag: 0.06,
  },

  gravityPresets: [
    { id: 'low', name: 'Low', value: 16 },
    { id: 'normal', name: 'Normal', value: 24 },
    { id: 'high', name: 'High', value: 34 },
  ],
  defaultGravityPreset: 'normal',
  blob: {
    radius: 1.15,
    walkSpeed: 9.5,
    // Peak is jumpSpeed^2 / 2*gravity: 14 gives ~4.1 units, enough to hop a
    // ledge a blob can't walk up, and it lands under fallSafeSpeed so a jump on
    // the flat never hurts.
    jumpSpeed: 14,
    jumpForward: 6.5,        // horizontal shove, ~7.5 units of ground covered
    maxClimb: 1.15,          // max slope (rise/run) a blob can walk up
    turnSpeed: 3.0,          // rad/s pivoting in place, firearms only (A/D)
    maxHealth: 100,
    // Coupled to jumpSpeed: a jump lands at jumpSpeed, so this has to clear it
    // with room to spare or every hop onto lower ground costs health. The gap
    // buys ~3.7 units of drop below the takeoff point, free.
    fallSafeSpeed: 19.5,
    fallDamageScale: 2.6,
    knockback: 1.05,
    pickupRange: 2.6,
  },
  shot: {
    minPower: 14,
    maxPower: 58,
    chargeRate: 38,          // power per second while holding fire
  },
  dig: {
    maxHold: 3,              // seconds; burrow/drill scale their effect by how long you hold
  },
  turn: {
    time: 45,                // seconds to aim
    settleTime: 1.4,         // grace period after everything stops moving
    aiThinkTime: 1.6,
    extraShotTime: 14,       // clock granted for a second barrel
    suddenDeathTurn: 60,     // after this many turns the sea starts rising
    suddenDeathHealth: 25,   // everyone is knocked down to this when it triggers
  },
  wind: {
    max: 7,
  },
  crates: {
    chance: 0.5,             // probability of a drop at the start of a turn
    max: 6,                  // crates allowed on the map at once
    fallSpeed: 11,
    healthAmount: 30,
    blastRadius: 5.5,        // weapon crates cook off when caught in an explosion
    blastDamage: 30,
  },

  // --- match shape ----------------------------------------------------------
  // `teams` is the pool of available squads; a match uses the first `teamCount`
  // of them. Raising maxTeams just means adding entries here — the turn order,
  // victory check, roster and netcode are all written against teams.length.
  maxTeams: 4,
  defaultTeamCount: 2,
  blobsPerTeam: 4,
  /** Fewer blobs each when the island is shared by more squads. */
  blobsFor(teamCount) {
    return teamCount <= 2 ? this.blobsPerTeam : 3;
  },

  teams: [
    {
      id: 0,
      name: 'CRIMSON',
      color: 0xef4a4a,
      dark: 0x8c1f1f,
      css: '#ef4a4a',
      names: ['Squelch', 'Bloop', 'Gunk', 'Dollop'],
    },
    {
      id: 1,
      name: 'AZURE',
      color: 0x3f9bff,
      dark: 0x1c4a8c,
      css: '#3f9bff',
      names: ['Splat', 'Wobble', 'Ooze', 'Dribble'],
    },
    {
      id: 2,
      name: 'VERDANT',
      color: 0x4ad991,
      dark: 0x1d6b48,
      css: '#4ad991',
      names: ['Sludge', 'Mulch', 'Pickle', 'Fern'],
    },
    {
      id: 3,
      name: 'AMBER',
      color: 0xf5a623,
      dark: 0x8a5a0d,
      css: '#f5a623',
      names: ['Custard', 'Yolk', 'Blister', 'Tangy'],
    },
  ],
};
