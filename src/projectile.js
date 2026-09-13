import * as THREE from 'three';
import { CFG } from './config.js';
import { WEAPONS } from './weapons.js';

/**
 * A shot in flight. Wind pushes it, gravity pulls it, terrain and blobs stop it.
 * Behaviour comes entirely from the weapon record — bouncing, fuses, homing and
 * splitting into child munitions are all data, not subclasses.
 */
export class Projectile {
  constructor(game, weapon, origin, velocity, owner, opts = {}) {
    this.game = game;
    this.weapon = weapon;
    this.owner = owner;
    this.position = origin.clone();
    this.velocity = velocity.clone();
    this.target = opts.target ?? null;
    this.age = 0;
    this.dead = false;
    this.spin = new THREE.Vector3(Math.random(), Math.random(), Math.random()).multiplyScalar(6);

    this.mesh = new THREE.Mesh(makeShape(weapon), makeMaterial(weapon));
    this.mesh.castShadow = true;
    this.mesh.position.copy(this.position);
    game.scene.add(this.mesh);

    // Smoke trail: a ribbon of points appended as the shot flies.
    this.trailPoints = 0;
    this.trailGeo = new THREE.BufferGeometry();
    this.trailGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(MAX_TRAIL * 3), 3)
    );
    this.trailGeo.setDrawRange(0, 0);
    this.trail = new THREE.Line(
      this.trailGeo,
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45 })
    );
    this.trail.frustumCulled = false;
    game.scene.add(this.trail);

    if (!opts.silent) {
      if (weapon.category === 'gun') game.audio.gunshot();
      else if (weapon.category === 'throw') game.audio.toss();
      else game.audio.launch();
    }
    if (weapon.chant) game.audio.hallelujah();
  }

  update(dt) {
    if (this.dead) return;
    const terrain = this.game.terrain;
    const w = this.weapon;
    this.age += dt;

    // Homing: bend the velocity toward the locked target without changing speed.
    if (w.homing && this.target && this.target.alive && this.age > w.homing.delay) {
      const speed = this.velocity.length();
      const desired = _v1.subVectors(this.target.position, this.position).normalize();
      const cur = _v2.copy(this.velocity).normalize();
      cur.lerp(desired, Math.min(1, w.homing.strength * dt)).normalize();
      this.velocity.copy(cur).multiplyScalar(speed);
    }

    this.velocity.y -= CFG.physics.gravity * (w.gravityScale ?? 1) * dt;
    this.velocity.addScaledVector(this.game.wind, (w.wind ?? 0) * dt);
    this.position.addScaledVector(this.velocity, dt);

    if (w.shape === 'ball' || w.shape === 'banana' || w.shape === 'melon' || w.shape === 'mine') {
      this.mesh.rotation.x += this.spin.x * dt;
      this.mesh.rotation.y += this.spin.y * dt;
      this.mesh.rotation.z += this.spin.z * dt;
    } else {
      _q.setFromUnitVectors(_up, _dir.copy(this.velocity).normalize());
      this.mesh.quaternion.copy(_q);
    }
    this.mesh.position.copy(this.position);
    this.pushTrail();

    if (this.age > 0.05 && w.scale > 0.25) this.game.fx.smokePuff(this.position, w.color);

    if (!terrain.inBounds(this.position.x, this.position.z) || this.position.y > 400) {
      if (this.position.y < 400) {
        this.game.log(`${this.owner ? this.owner.name + "'s" : 'The'} shot sailed off the map.`);
      }
      this.destroy();
      return;
    }

    if (this.position.y < CFG.terrain.waterLevel) {
      this.game.fx.splash(
        new THREE.Vector3(this.position.x, CFG.terrain.waterLevel, this.position.z),
        18
      );
      this.game.audio.splash();
      this.destroy();
      return;
    }

    for (const blob of this.game.blobs) {
      if (!blob.alive) continue;
      // A dropped weapon (dynamite) sits right at the owner's feet for its
      // whole fuse — only the timer should ever end it, not brushing its owner.
      if (blob === this.owner && (this.age < 0.14 || w.delivery === 'drop')) continue;
      if (blob.position.distanceTo(this.position) < CFG.blob.radius + w.scale) {
        this.explode();
        return;
      }
    }

    // Crates cook off when shot.
    for (const crate of this.game.crates) {
      if (crate.dead) continue;
      if (crate.position.distanceTo(this.position) < 1.5 + w.scale) {
        this.explode();
        return;
      }
    }

    const gh = terrain.heightAt(this.position.x, this.position.z);
    if (this.position.y <= gh) {
      if (w.bounce && (w.detonate !== 'fuse' || this.age < w.fuse)) {
        this.position.y = gh + 0.02;
        const n = terrain.normalAt(this.position.x, this.position.z, _n);
        const vn = this.velocity.dot(n);
        this.velocity.addScaledVector(n, -(1 + w.bounce) * vn);
        this.velocity.multiplyScalar(0.86);
        // Only a real hop makes a noise — a rolling grenade micro-bounces every
        // frame and would otherwise rattle like a machine gun.
        if (-vn > 2.5) this.game.audio.bounce();
        if (this.velocity.lengthSq() < 1.2) this.velocity.set(0, 0, 0);
      } else {
        this.position.y = gh;
        this.explode();
        return;
      }
    }

    if (w.detonate === 'fuse' && this.age >= w.fuse) this.explode();
  }

  pushTrail() {
    if (this.trailPoints >= MAX_TRAIL) return;
    const arr = this.trailGeo.attributes.position.array;
    const i = this.trailPoints;
    arr[i * 3] = this.position.x;
    arr[i * 3 + 1] = this.position.y;
    arr[i * 3 + 2] = this.position.z;
    this.trailPoints++;
    this.trailGeo.setDrawRange(0, this.trailPoints);
    this.trailGeo.attributes.position.needsUpdate = true;
  }

  explode() {
    if (this.dead) return;
    const w = this.weapon;
    const at = this.position.clone();
    this.destroy();

    if (w.radius > 0) {
      // A bullet finding a target isn't an explosion - skip the boom and play
      // a small sharp impact instead.
      if (w.category === 'gun') {
        this.game.audio.bulletImpact();
        this.game.detonate(at, w.radius, w.damage, this.owner, w.name, { silentBoom: true });
      } else {
        this.game.detonate(at, w.radius, w.damage, this.owner, w.name);
      }
    }

    if (w.children) {
      const child = WEAPONS[w.children.weapon];
      const spawnAt = at.clone();
      spawnAt.y += 1.2;
      const rng = this.game.rng;
      for (let i = 0; i < w.children.count; i++) {
        const a = (i / w.children.count) * Math.PI * 2 + rng.next() * 0.6;
        const s = w.children.spread * (0.5 + rng.next() * 0.8);
        const vel = new THREE.Vector3(
          Math.cos(a) * s,
          w.children.up * (0.7 + rng.next() * 0.6),
          Math.sin(a) * s
        );
        this.game.spawnProjectile(child, spawnAt.clone(), vel, this.owner, { silent: true });
      }
    }
  }

  destroy() {
    if (this.dead) return;
    this.dead = true;
    this.game.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.game.fx.fadeOut(this.trail, 1.1);
  }
}

// --- meshes -----------------------------------------------------------------

function makeShape(w) {
  const s = w.scale ?? 0.4;
  switch (w.shape) {
    case 'ball':
      return new THREE.IcosahedronGeometry(s, 1);
    case 'banana': {
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(-s, -s * 0.4, 0),
        new THREE.Vector3(0, s * 0.5, 0),
        new THREE.Vector3(s, -s * 0.4, 0),
      ]);
      return new THREE.TubeGeometry(curve, 8, s * 0.3, 6, false);
    }
    case 'melon':
      return new THREE.SphereGeometry(s, 14, 10);
    case 'mine':
      return new THREE.DodecahedronGeometry(s, 0);
    case 'stick':
      return new THREE.CylinderGeometry(s * 0.35, s * 0.35, s * 2.2, 8);
    case 'slug':
      return new THREE.SphereGeometry(s, 6, 5);
    case 'mule':
      return new THREE.BoxGeometry(s * 1.4, s * 1.8, s * 2.4);
    case 'rocket':
    default:
      return new THREE.ConeGeometry(s * 0.55, s * 2.2, 10);
  }
}

function makeMaterial(w) {
  return new THREE.MeshStandardMaterial({
    color: w.color ?? 0xffffff,
    emissive: new THREE.Color(w.color ?? 0xffffff).multiplyScalar(0.3),
    roughness: 0.45,
    metalness: 0.3,
  });
}

const MAX_TRAIL = 900;
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _n = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/**
 * Headless copy of the projectile integrator. Used for the on-screen aim arc and
 * by the AI when it searches for a firing solution, so what you preview is what
 * the real shot does.
 */
export function simulateTrajectory(origin, velocity, weapon, terrain, wind, opts = {}) {
  const dt = opts.dt ?? 1 / 60;
  const maxT = opts.maxT ?? 10;
  const g = CFG.physics.gravity * (weapon.gravityScale ?? 1);
  const pos = origin.clone();
  const vel = velocity.clone();
  const points = [pos.clone()];
  const n = new THREE.Vector3();
  let t = 0;

  while (t < maxT) {
    t += dt;
    vel.y -= g * dt;
    vel.addScaledVector(wind, (weapon.wind ?? 0) * dt);
    pos.addScaledVector(vel, dt);
    points.push(pos.clone());

    if (!terrain.inBounds(pos.x, pos.z) || pos.y > 400) {
      return { points, impact: null, reason: 'offmap', time: t };
    }
    if (pos.y < CFG.terrain.waterLevel) {
      return { points, impact: pos.clone(), reason: 'water', time: t };
    }

    if (opts.blobs) {
      for (const b of opts.blobs) {
        if (!b.alive) continue;
        if (b === opts.ignore && t < 0.14) continue;
        if (b.position.distanceTo(pos) < CFG.blob.radius + weapon.scale) {
          return { points, impact: pos.clone(), reason: 'blob', hitBlob: b, time: t };
        }
      }
    }

    const gh = terrain.heightAt(pos.x, pos.z);
    if (pos.y <= gh) {
      if (weapon.bounce && (weapon.detonate !== 'fuse' || t < weapon.fuse)) {
        pos.y = gh + 0.02;
        terrain.normalAt(pos.x, pos.z, n);
        vel.addScaledVector(n, -(1 + weapon.bounce) * vel.dot(n));
        vel.multiplyScalar(0.86);
        if (vel.lengthSq() < 1.2) vel.set(0, 0, 0);
      } else {
        pos.y = gh;
        return { points, impact: pos.clone(), reason: 'terrain', time: t };
      }
    }

    if (weapon.detonate === 'fuse' && t >= weapon.fuse) {
      return { points, impact: pos.clone(), reason: 'fuse', time: t };
    }
  }
  return { points, impact: pos.clone(), reason: 'timeout', time: t };
}
