import * as THREE from 'three';
import { CFG } from './config.js';
import { WEAPONS, CRATE_LOOT, CORE_WEAPONS } from './weapons.js';

/**
 * Supply drop. Parachutes in at the start of a turn, sits on the ground until a
 * blob walks into it, and cooks off if it's caught in an explosion.
 */
export class Crate {
  constructor(game, type, position, loot) {
    this.game = game;
    this.type = type; // 'health' | 'weapon'
    this.loot = loot; // { id, n } for weapon crates
    this.position = position.clone();
    this.velocity = new THREE.Vector3(0, -CFG.crates.fallSpeed, 0);
    this.landed = false;
    this.dead = false;
    this.age = 0;
    // Seeded: bob is the phase of the descent drift, so it moves the landing spot.
    this.bob = game.rng.next() * 6;

    const accent = type === 'health' ? 0x35c95f : 0xf2a13c;
    this.group = new THREE.Group();

    const box = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 1.5, 1.5),
      new THREE.MeshStandardMaterial({ color: 0x8a6742, roughness: 0.8 })
    );
    box.castShadow = true;
    box.receiveShadow = true;
    this.group.add(box);

    // Coloured banding so you can read the type at a distance.
    for (const axis of ['x', 'y']) {
      const band = new THREE.Mesh(
        new THREE.BoxGeometry(axis === 'x' ? 1.56 : 0.34, axis === 'x' ? 0.34 : 1.56, 1.56),
        new THREE.MeshStandardMaterial({ color: accent, roughness: 0.5, emissive: accent, emissiveIntensity: 0.25 })
      );
      this.group.add(band);
    }

    this.chute = new THREE.Mesh(
      new THREE.SphereGeometry(1.9, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshStandardMaterial({
        color: accent,
        roughness: 0.9,
        side: THREE.DoubleSide,
      })
    );
    this.chute.position.y = 2.4;
    this.group.add(this.chute);

    this.icon = makeIconSprite(type === 'health' ? '✚' : '?', accent);
    this.icon.position.y = 1.7;
    this.group.add(this.icon);

    this.group.position.copy(this.position);
    game.scene.add(this.group);
  }

  update(dt) {
    if (this.dead) return;
    // Own age, not wall-clock time: the drift below moves the landing spot, and
    // two clients never share a clock origin.
    this.age += dt;

    if (!this.landed) {
      this.position.addScaledVector(this.velocity, dt);
      // Gentle drift so the descent doesn't look like an elevator.
      this.position.x += Math.sin(this.age * 1.4 + this.bob) * dt * 1.6;
      this.position.z += Math.cos(this.age * 1.1 + this.bob) * dt * 1.6;
      this.group.rotation.y += dt * 0.5;

      const gh = this.game.terrain.heightAt(this.position.x, this.position.z);
      if (this.position.y - 0.75 <= gh) {
        this.position.y = gh + 0.75;
        this.landed = true;
        this.dropChute();
        this.game.fx.dust(this.position, 8);
      }
      if (this.position.y < CFG.terrain.waterLevel) {
        this.game.fx.splash(
          new THREE.Vector3(this.position.x, CFG.terrain.waterLevel, this.position.z),
          14
        );
        this.game.audio.splash();
        this.remove();
        return;
      }
    } else {
      // Ground blown out from under it — resume falling.
      const gh = this.game.terrain.heightAt(this.position.x, this.position.z);
      if (this.position.y - 0.75 > gh + 0.3) {
        this.landed = false;
        this.velocity.set(0, -CFG.crates.fallSpeed, 0);
      } else {
        this.position.y = gh + 0.75;
      }
      // Swallowed by the rising sudden-death tide.
      if (this.position.y < CFG.terrain.waterLevel) {
        this.game.fx.splash(
          new THREE.Vector3(this.position.x, CFG.terrain.waterLevel, this.position.z),
          10
        );
        this.remove();
        return;
      }
    }

    this.group.position.copy(this.position);
    this.icon.position.y = 1.7 + Math.sin(this.age * 2.5 + this.bob) * 0.12;

    for (const blob of this.game.blobs) {
      if (!blob.alive) continue;
      if (blob.position.distanceTo(this.position) < CFG.blob.radius + CFG.blob.pickupRange) {
        this.collect(blob);
        return;
      }
    }
  }

  /** Detach and free the parachute — on landing, or when restored as landed. */
  dropChute() {
    if (!this.chute || !this.chute.parent) return;
    this.group.remove(this.chute);
    this.chute.geometry.dispose();
    this.chute.material.dispose();
  }

  collect(blob) {
    if (this.dead) return;
    if (this.type === 'health') {
      const healed = blob.heal(CFG.crates.healthAmount);
      this.game.log(`${blob.name} picked up a medkit (+${healed}).`);
      this.game.hud.toast(`+${healed} HEALTH`, '#5ddb6a', 1200);
    } else {
      const w = WEAPONS[this.loot.id];
      blob.team.ammo[this.loot.id] += this.loot.n;
      this.game.log(`${blob.name} found ${this.loot.n}× ${w.name}.`);
      this.game.hud.toast(`${w.icon} ${w.name} ×${this.loot.n}`, '#f2a13c', 1400);
      // A blob flung onto a crate can collect for a team that isn't up; only
      // refresh the panel when it belongs to whoever's turn it is.
      if (blob.team === this.game.activeTeam) {
        this.game.hud.updateInventory(blob.team.ammo, this.game.selectedWeapon);
      }
    }
    this.game.audio.pickup();
    this.game.fx.burst(this.position, 22, {
      speed: 7,
      size: 0.4,
      color: this.type === 'health' ? 0x5ddb6a : 0xf2a13c,
      gravity: 14,
      life: 1,
    });
    this.remove();
  }

  /** Caught in a blast: weapon crates go off, medkits just get shredded. */
  cookOff() {
    if (this.dead) return;
    const at = this.position.clone();
    const isWeapon = this.type === 'weapon';
    this.remove();
    if (isWeapon) {
      this.game.detonate(at, CFG.crates.blastRadius, CFG.crates.blastDamage, null, 'a supply crate');
    } else {
      this.game.fx.burst(at, 16, { speed: 6, size: 0.4, color: 0xbbbbbb, gravity: 16, life: 0.9 });
    }
  }

  remove() {
    if (this.dead) return;
    this.dead = true;
    this.game.scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
      if (o.material && o.material.map) o.material.map.dispose();
    });
  }
}

/** Pick a drop location: above water, not too steep, not right on top of a blob. */
export function chooseDropSite(game, tries = 60) {
  const t = game.terrain;
  const rng = game.rng;
  for (let i = 0; i < tries; i++) {
    const x = rng.spread(1) * t.half * 0.72;
    const z = rng.spread(1) * t.half * 0.72;
    const h = t.heightAt(x, z);
    if (h < CFG.terrain.waterLevel + 2) continue;
    if (t.slopeAt(x, z) > 0.7) continue;
    if (game.blobs.some((b) => b.alive && Math.hypot(b.position.x - x, b.position.z - z) < 6)) continue;
    return new THREE.Vector3(x, h + 70, z);
  }
  return null;
}

/** @param {Set<string>|null} enabledIds  weapons the match allows; null = all. */
export function rollLoot(rng, enabledIds = null) {
  const pool = enabledIds
    ? CRATE_LOOT.filter((e) => CORE_WEAPONS.includes(e.id) || enabledIds.has(e.id))
    : CRATE_LOOT;
  const list = pool.length ? pool : CRATE_LOOT;
  const total = list.reduce((s, e) => s + e.w, 0);
  let r = rng.next() * total;
  for (const entry of list) {
    r -= entry.w;
    if (r <= 0) return { id: entry.id, n: entry.n };
  }
  return { id: list[0].id, n: list[0].n };
}

function makeIconSprite(glyph, color) {
  const c = document.createElement('canvas');
  c.width = c.height = 96;
  const ctx = c.getContext('2d');
  ctx.font = 'bold 72px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.strokeText(glyph, 48, 52);
  ctx.fillStyle = '#' + color.toString(16).padStart(6, '0');
  ctx.fillText(glyph, 48, 52);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  sprite.scale.set(1.5, 1.5, 1);
  return sprite;
}
