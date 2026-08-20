import * as THREE from 'three';
import { CFG } from './config.js';
import { WEAPONS, AI_WEAPONS } from './weapons.js';
import { simulateTrajectory } from './projectile.js';

/**
 * Computer opponent.
 *
 * It solves for a firing arc by brute force: run the same headless trajectory
 * integrator the aim preview uses over a coarse pitch/power grid, keep the shot
 * that lands closest to a target, refine around it, then smear the result with a
 * skill-dependent aiming error so it isn't a perfect sniper.
 */
export function planShot(game, blob, skill = 0.72) {
  const enemies = game.blobs.filter((b) => b.alive && b.team !== blob.team);
  if (!enemies.length) return null;

  const friends = game.blobs.filter((b) => b.alive && b.team === blob.team && b !== blob);

  // Consider the two closest enemies, and prefer weak ones.
  const ranked = enemies
    .map((e) => ({
      blob: e,
      d: e.position.distanceTo(blob.position),
    }))
    .sort((a, b) => a.d - b.d + (a.blob.health - b.blob.health) * 0.12)
    .slice(0, 2);

  const options = [];
  for (const { blob: target } of ranked) {
    for (const weaponId of pickWeapons(game, blob, target)) {
      const w = WEAPONS[weaponId];
      const shot = solve(game, blob, target, w, friends);
      // Bias toward the option that would actually hurt, not just land close.
      if (shot) options.push({ ...shot, score: shot.score - w.damage * 0.05, weaponId, target });
    }
  }
  if (!options.length) return null;

  options.sort((a, b) => a.score - b.score);
  const best = options[0];

  // Aiming error: worse skill means a wilder shot. Seeded so a solo match
  // replays identically, and so an online host's AI agrees with every client.
  const rng = game.rng;
  const slop = 1 - skill;
  best.yaw += rng.spread(0.045) * slop;
  best.pitch = THREE.MathUtils.clamp(best.pitch + rng.spread(0.035) * slop, -0.3, 1.3);
  best.power *= 1 + rng.spread(0.08) * slop;
  best.power = THREE.MathUtils.clamp(best.power, CFG.shot.minPower, CFG.shot.maxPower);
  return best;
}

/**
 * The solver only models plain arcing shots, so the AI sticks to launchers and
 * throwables it has ammo for. Two candidates per target keeps the search cheap.
 */
function pickWeapons(game, blob, target) {
  const ammo = blob.team.ammo;
  const d = blob.position.distanceTo(target.position);
  const usable = AI_WEAPONS.filter(
    (id) => ammo[id] > 0 && WEAPONS[id].delivery === 'launch' && !WEAPONS[id].burst
  );
  // Prefer heavy ordnance, but always keep the bazooka as a dependable fallback.
  const ranked = usable
    .filter((id) => id !== 'bazooka')
    .sort((a, b) => WEAPONS[b].damage - WEAPONS[a].damage)
    .filter((id) => (WEAPONS[id].detonate === 'fuse' ? d < 60 : true));
  const pick = ranked.length && game.rng.chance(0.6) ? [ranked[0]] : [];
  return ['bazooka', ...pick];
}

function solve(game, blob, target, weapon, friends) {
  const base = Math.atan2(
    target.position.x - blob.position.x,
    target.position.z - blob.position.z
  );

  let best = null;
  const evaluate = (yaw, pitch, power) => {
    const dir = dirFrom(yaw, pitch, _dir);
    const origin = game.shotOrigin(blob, dir, _origin);
    const vel = _vel.copy(dir).multiplyScalar(power);
    // No blob collision here: it costs a distance check per blob per step, and
    // scoring by impact-to-target distance already rewards direct hits.
    const res = simulateTrajectory(origin, vel, weapon, game.terrain, game.wind, {
      dt: 1 / 40,
      maxT: 7,
    });
    if (!res.impact) return;

    let score = res.impact.distanceTo(target.position);
    if (res.reason === 'water') score += 26;
    // Don't nuke your own squad (or yourself).
    for (const f of friends) {
      const d = res.impact.distanceTo(f.position);
      if (d < weapon.radius) score += (weapon.radius - d) * 4;
    }
    const selfD = res.impact.distanceTo(blob.position);
    if (selfD < weapon.radius) score += (weapon.radius - selfD) * 7;

    if (!best || score < best.score) best = { yaw, pitch, power, score, impact: res.impact };
  };

  // Coarse sweep.
  for (let yi = -1; yi <= 1; yi++) {
    const yaw = base + yi * 0.09;
    for (let p = 0; p < 9; p++) {
      const pitch = 0.12 + (p / 8) * 1.08;
      for (let s = 0; s < 8; s++) {
        const power = CFG.shot.minPower + (s / 7) * (CFG.shot.maxPower - CFG.shot.minPower);
        evaluate(yaw, pitch, power);
      }
    }
  }
  if (!best) return null;

  // Local refinement around the best coarse hit.
  const b = { ...best };
  for (let yi = -2; yi <= 2; yi++) {
    for (let pi = -2; pi <= 2; pi++) {
      for (let si = -2; si <= 2; si++) {
        evaluate(
          b.yaw + yi * 0.022,
          THREE.MathUtils.clamp(b.pitch + pi * 0.05, -0.3, 1.3),
          THREE.MathUtils.clamp(
            b.power + si * 1.5,
            CFG.shot.minPower,
            CFG.shot.maxPower
          )
        );
      }
    }
  }
  return best;
}

function dirFrom(yaw, pitch, out) {
  const cp = Math.cos(pitch);
  return out.set(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp);
}

const _dir = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _origin = new THREE.Vector3();
