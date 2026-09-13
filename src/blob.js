import * as THREE from 'three';
import { CFG } from './config.js';

const R = CFG.blob.radius;

/**
 * A blob: the little gelatinous soldier you take turns launching explosives at.
 *
 * Movement has two modes. While `grounded` it walks along the heightmap (snapped
 * to the surface, refusing slopes steeper than maxClimb). Once it leaves the
 * ground — jumping, knockback, or the ground being blown out from under it — it
 * becomes a plain ballistic body until it lands again.
 */
export class Blob {
  constructor(game, team, name, position) {
    this.game = game;
    this.team = team;
    this.name = name;
    this.health = CFG.blob.maxHealth;
    this.alive = true;
    this.dying = false;

    this.position = position.clone();
    this.position.y += R;
    this.velocity = new THREE.Vector3();
    this.grounded = true;
    // Seeded: facing feeds jump direction, so it changes outcomes.
    this.facing = game.rng.next() * Math.PI * 2;
    this.moveInput = new THREE.Vector2();
    this.wobble = Math.random() * 10;
    this.squash = 1;

    this.group = new THREE.Group();
    this.group.position.copy(this.position);

    const bodyGeo = new THREE.IcosahedronGeometry(R, 3);
    this.bodyMat = new THREE.MeshStandardMaterial({
      color: team.color,
      roughness: 0.42,
      metalness: 0.05,
      flatShading: false,
    });
    this.body = new THREE.Mesh(bodyGeo, this.bodyMat);
    this.body.castShadow = true;
    this.body.receiveShadow = true;
    this.group.add(this.body);

    // Face: two eyes with pupils, pointing along +Z of the group.
    const eyeGeo = new THREE.SphereGeometry(R * 0.3, 14, 12);
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.25 });
    const pupilGeo = new THREE.SphereGeometry(R * 0.14, 10, 8);
    const pupilMat = new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.3 });
    this.eyes = new THREE.Group();
    for (const sx of [-1, 1]) {
      const eye = new THREE.Mesh(eyeGeo, eyeMat);
      eye.position.set(sx * R * 0.38, R * 0.28, R * 0.76);
      const pupil = new THREE.Mesh(pupilGeo, pupilMat);
      pupil.position.set(sx * R * 0.42, R * 0.28, R * 0.96);
      this.eyes.add(eye, pupil);
    }
    this.group.add(this.eyes);

    // A little band of team colour so blobs read at a distance.
    const bandGeo = new THREE.TorusGeometry(R * 0.95, R * 0.1, 8, 24);
    const bandMat = new THREE.MeshStandardMaterial({ color: team.dark, roughness: 0.5 });
    this.band = new THREE.Mesh(bandGeo, bandMat);
    this.band.rotation.x = Math.PI / 2;
    this.band.position.y = -R * 0.25;
    this.group.add(this.band);

    this.label = makeLabel(team.css);
    this.label.position.y = R + 1.35;
    this.group.add(this.label);
    this.drawLabel();
  }

  get isActive() {
    return this.game.activeBlob === this;
  }

  // --- simulation -----------------------------------------------------------

  update(dt) {
    if (!this.alive) return;
    const terrain = this.game.terrain;
    const p = this.position;
    const v = this.velocity;
    const ground = terrain.heightAt(p.x, p.z);

    if (this.grounded && p.y - R > ground + 0.35) {
      // Ground vanished (crater!) — start falling.
      this.grounded = false;
    }

    if (this.grounded) {
      this.walk(dt, ground);
    } else {
      this.walking = false;
      v.y -= CFG.physics.gravity * dt;
      const drag = Math.max(0, 1 - CFG.physics.airDrag * dt);
      v.x *= drag;
      v.z *= drag;
      p.addScaledVector(v, dt);

      const gh = terrain.heightAt(p.x, p.z);
      if (p.y - R <= gh) {
        p.y = gh + R;
        const impact = Math.abs(v.y);
        if (impact > CFG.blob.fallSafeSpeed) {
          const dmg = Math.round((impact - CFG.blob.fallSafeSpeed) * CFG.blob.fallDamageScale);
          this.damage(dmg, 'the ground');
          this.game.fx.dust(p.clone(), 10);
          this.game.audio.thud();
        }
        if (impact > 9) {
          v.y = impact * CFG.physics.bounce;
          v.x *= 0.8;
          v.z *= 0.8;
          this.squash = 0.6;
        } else {
          v.y = 0;
          v.x *= CFG.physics.friction;
          v.z *= CFG.physics.friction;
          this.grounded = true;
        }
      }
    }

    // Drowning. Practice Range is a sandbox, not a survival test — nobody sinks.
    if (p.y < CFG.terrain.waterLevel - 0.2 && this.alive && !this.game.practice) {
      this.game.fx.splash(new THREE.Vector3(p.x, CFG.terrain.waterLevel, p.z), 26);
      this.game.audio.splash();
      this.game.log(`${this.name} sank without a trace.`);
      this.health = 0;
      this.drowned = true;
      this.kill(false);
    }

    this.updateVisual(dt);
  }

  walk(dt, ground) {
    const p = this.position;
    const v = this.velocity;
    const terrain = this.game.terrain;
    const input = this.moveInput;

    if (input.lengthSq() > 0.001) {
      const dir = _v2.copy(input).normalize();
      const speed = CFG.blob.walkSpeed;
      const nx = p.x + dir.x * speed * dt;
      const nz = p.z + dir.y * speed * dt;

      if (!terrain.inBounds(nx, nz)) {
        input.set(0, 0);
      } else {
        const nh = terrain.heightAt(nx, nz);
        const run = Math.hypot(nx - p.x, nz - p.z);
        const rise = nh - ground;
        if (rise / Math.max(run, 1e-4) <= CFG.blob.maxClimb) {
          p.x = nx;
          p.z = nz;
          if (rise < -1.2) {
            // Walked off a ledge.
            this.grounded = false;
            v.set(dir.x * speed, 0, dir.y * speed);
          } else {
            p.y = nh + R;
          }
        }
        this.facing = Math.atan2(dir.x, dir.y);
        this.walking = true;
      }
    } else {
      this.walking = false;
      p.y = ground + R;
    }

    v.x = 0;
    v.z = 0;
    v.y = 0;
  }

  /**
   * Hop. `angle` is where to throw yourself; it comes down in the jump command
   * so every client launches the blob the same way, rather than each reading its
   * own idea of which way this blob was facing.
   */
  jump(angle) {
    if (!this.grounded || !this.alive) return;
    const a = angle ?? this.facing;
    this.facing = a;
    this.grounded = false;
    this.velocity.y = CFG.blob.jumpSpeed;
    this.velocity.x = Math.sin(a) * CFG.blob.jumpForward;
    this.velocity.z = Math.cos(a) * CFG.blob.jumpForward;
    this.squash = 1.35;
    this.game.audio.jump();
  }

  applyImpulse(vec) {
    this.grounded = false;
    this.velocity.add(vec);
    this.squash = 1.3;
  }

  damage(amount, source = '') {
    if (!this.alive || amount <= 0) return 0;
    // Practice Range never lets health reach zero — you can still see the
    // numbers a weapon deals, but there's nothing to actually die from.
    const floor = this.game.practice ? 1 : 0;
    if (this.health <= floor) return 0;
    const dealt = Math.min(this.health - floor, Math.round(amount));
    this.health -= dealt;
    this.drawLabel();
    this.game.fx.damageNumber(this.position, dealt);
    this.flash = 0.35;
    if (this.health <= 0) {
      this.health = 0;
      this.pendingDeath = true;
      if (source) this.game.log(`${this.name} was finished off by ${source}.`);
    }
    return dealt;
  }

  heal(amount) {
    const gained = Math.min(amount, CFG.blob.maxHealth - this.health);
    this.health += gained;
    this.drawLabel();
    return gained;
  }

  /** Remove from play. `explode` fires the classic death blast. */
  kill(explode = true) {
    if (!this.alive) return;
    this.alive = false;
    this.pendingDeath = false;
    this.group.visible = false;
    this.walking = false;
    if (explode) {
      this.game.detonate(this.position.clone(), 5.5, 22, this, 'a dying blob');
    }
    this.game.onBlobDied(this);
  }

  // --- presentation ---------------------------------------------------------

  updateVisual(dt) {
    const prevWobble = this.wobble;
    this.wobble += dt * (this.walking ? 13 : 3.2);
    this.squash += (1 - this.squash) * Math.min(1, dt * 9);

    // A footfall each time the bob cycle hits the ground (bob back to 0),
    // so the sound stays locked to the animation instead of a separate timer.
    if (this.walking && Math.floor(this.wobble / Math.PI) !== Math.floor(prevWobble / Math.PI)) {
      this.game.audio.footstep();
    }

    const bob = this.walking ? Math.abs(Math.sin(this.wobble)) * 0.16 : 0;
    const breathe = Math.sin(this.wobble * 0.9) * 0.035;
    const sy = this.squash + breathe;
    const sxz = 1 / Math.sqrt(Math.max(0.2, sy));

    this.group.position.copy(this.position);
    this.group.position.y += bob;
    this.group.rotation.y += angleDelta(this.group.rotation.y, this.facing) * Math.min(1, dt * 10);
    this.body.scale.set(sxz, sy, sxz);
    this.band.scale.set(sxz, sxz, sy);

    if (this.flash > 0) {
      this.flash -= dt;
      const t = Math.max(0, this.flash) / 0.35;
      this.bodyMat.emissive.setRGB(t, t * 0.25, t * 0.2);
    } else if (this.isActive) {
      const pulse = 0.12 + Math.sin(performance.now() * 0.005) * 0.06;
      this.bodyMat.emissive.setRGB(pulse, pulse, pulse);
    } else {
      this.bodyMat.emissive.setRGB(0, 0, 0);
    }

    this.label.position.y = R + 1.35 + bob * 0.5;
  }

  drawLabel() {
    const { canvas, ctx, texture } = this.label.userData;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    ctx.font = 'bold 34px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(this.name, w / 2, 26);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(this.name, w / 2, 26);

    const bw = w * 0.72;
    const bx = (w - bw) / 2;
    const by = 54;
    const bh = 18;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    roundRect(ctx, bx - 3, by - 3, bw + 6, bh + 6, 6);
    ctx.fill();
    const frac = this.health / CFG.blob.maxHealth;
    ctx.fillStyle = frac > 0.5 ? '#5ddb6a' : frac > 0.25 ? '#f3c33b' : '#e8503a';
    roundRect(ctx, bx, by, Math.max(2, bw * frac), bh, 4);
    ctx.fill();

    texture.needsUpdate = true;
  }

  dispose() {
    this.body.geometry.dispose();
    this.bodyMat.dispose();
    this.band.geometry.dispose();
    this.label.material.map.dispose();
    this.label.material.dispose();
  }
}

// Scratch vector for walk(), which runs every frame for the active blob.
const _v2 = new THREE.Vector2();

function makeLabel(cssColor) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 84;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(2.7, 0.89, 1);
  sprite.userData = { canvas, ctx, texture, cssColor };
  return sprite;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function angleDelta(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function separateBlobs(blobs) {
  for (let i = 0; i < blobs.length; i++) {
    const a = blobs[i];
    if (!a.alive) continue;
    for (let j = i + 1; j < blobs.length; j++) {
      const b = blobs[j];
      if (!b.alive) continue;
      const dx = b.position.x - a.position.x;
      const dz = b.position.z - a.position.z;
      const d = Math.hypot(dx, dz);
      const min = R * 2;
      if (d < min && d > 1e-4) {
        const push = (min - d) * 0.5;
        const nx = (dx / d) * push;
        const nz = (dz / d) * push;
        a.position.x -= nx;
        a.position.z -= nz;
        b.position.x += nx;
        b.position.z += nz;
      }
    }
  }
}
