import * as THREE from 'three';

/**
 * All the transient eye-candy: explosions, debris, smoke, splashes and floating
 * damage numbers. Everything registers itself as an "effect" with a lifetime and
 * is torn down automatically.
 */
export class FX {
  constructor(scene) {
    this.scene = scene;
    this.effects = [];
    this.lastPuff = 0;
    this.particleTex = makeSoftDot();
  }

  add(effect) {
    this.effects.push(effect);
    return effect;
  }

  update(dt, time) {
    this.time = time;
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.age += dt;
      const done = e.tick(dt, e.age / e.life);
      if (done || e.age >= e.life) {
        e.cleanup();
        this.effects.splice(i, 1);
      }
    }
  }

  clear() {
    for (const e of this.effects) e.cleanup();
    this.effects.length = 0;
  }

  // --- explosions -----------------------------------------------------------

  explosion(pos, radius) {
    // Flash core. Colour goes well above 1.0 — the renderer keeps HDR values
    // through the post-processing chain, so this is what the bloom pass
    // actually latches onto to give the flash a real glow instead of just a
    // flat bright disc.
    const flashMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0xffa53a).multiplyScalar(2.4),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const flash = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 3), flashMat);
    flash.position.copy(pos);
    this.scene.add(flash);

    // Ground shockwave ring.
    const ringMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0xffd9a0).multiplyScalar(1.8),
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.75, 1, 40), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(pos).y += 0.4;
    this.scene.add(ring);

    this.add({
      age: 0,
      life: 0.85,
      tick: (dt, t) => {
        const s = radius * (0.35 + t * 1.05);
        flash.scale.setScalar(s);
        flashMat.opacity = Math.pow(1 - t, 1.6);
        ring.scale.setScalar(radius * (0.4 + t * 2.6));
        ringMat.opacity = 0.7 * Math.pow(1 - t, 2);
      },
      cleanup: () => {
        this.scene.remove(flash, ring);
        flash.geometry.dispose();
        flashMat.dispose();
        ring.geometry.dispose();
        ringMat.dispose();
      },
    });

    this.burst(pos, Math.round(28 + radius * 5), {
      speed: radius * 2.6,
      size: 0.55,
      color: new THREE.Color(0xffb347).multiplyScalar(1.8),
      gravity: 26,
      life: 1.5,
    });
    this.burst(pos, Math.round(16 + radius * 3), {
      speed: radius * 1.5,
      size: 0.9,
      color: 0x6b5a4a,
      gravity: 6,
      life: 2.1,
      fade: 0.9,
    });
  }

  dust(pos, count = 12) {
    this.burst(pos, count, { speed: 4, size: 0.4, color: 0xbfae8e, gravity: 12, life: 0.9 });
  }

  splash(pos, count = 20) {
    this.burst(pos, count, { speed: 9, size: 0.4, color: 0x9fdcff, gravity: 22, life: 1.1, up: 1.4 });
  }

  /** Generic particle burst rendered as one Points object. */
  burst(pos, count, opts = {}) {
    const {
      speed = 6,
      size = 0.5,
      color = 0xffffff,
      gravity = 18,
      life = 1.2,
      up = 0.8,
      fade = 1,
    } = opts;

    const positions = new Float32Array(count * 3);
    const vel = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = pos.x;
      positions[i * 3 + 1] = pos.y;
      positions[i * 3 + 2] = pos.z;
      const a = Math.random() * Math.PI * 2;
      const b = Math.acos(2 * Math.random() - 1);
      const s = speed * (0.35 + Math.random() * 0.9);
      vel[i * 3] = Math.sin(b) * Math.cos(a) * s;
      vel[i * 3 + 1] = Math.abs(Math.cos(b)) * s * up + s * 0.25;
      vel[i * 3 + 2] = Math.sin(b) * Math.sin(a) * s;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color,
      size,
      map: this.particleTex,
      transparent: true,
      depthWrite: false,
      sizeAttenuation: true,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    this.scene.add(points);

    this.add({
      age: 0,
      life,
      tick: (dt, t) => {
        for (let i = 0; i < count; i++) {
          vel[i * 3 + 1] -= gravity * dt;
          positions[i * 3] += vel[i * 3] * dt;
          positions[i * 3 + 1] += vel[i * 3 + 1] * dt;
          positions[i * 3 + 2] += vel[i * 3 + 2] * dt;
        }
        geo.attributes.position.needsUpdate = true;
        mat.opacity = Math.pow(1 - t, fade);
      },
      cleanup: () => {
        this.scene.remove(points);
        geo.dispose();
        mat.dispose();
      },
    });
  }

  /** Thin smoke wisp behind a projectile (rate-limited). */
  smokePuff(pos, color = 0xffffff) {
    const now = this.time ?? 0;
    if (now - this.lastPuff < 0.035) return;
    this.lastPuff = now;

    const mat = new THREE.SpriteMaterial({
      map: this.particleTex,
      color: 0xdddddd,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.position.copy(pos);
    sprite.scale.setScalar(0.6);
    this.scene.add(sprite);
    this.add({
      age: 0,
      life: 1.1,
      tick: (dt, t) => {
        sprite.scale.setScalar(0.6 + t * 1.6);
        sprite.position.y += dt * 0.7;
        mat.opacity = 0.5 * (1 - t);
      },
      cleanup: () => {
        this.scene.remove(sprite);
        mat.dispose();
      },
    });
  }

  damageNumber(pos, amount) {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.font = 'bold 46px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 7;
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.strokeText(`-${amount}`, 64, 34);
    ctx.fillStyle = '#ffe27a';
    ctx.fillText(`-${amount}`, 64, 34);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.position.copy(pos).y += 2;
    sprite.scale.set(3, 1.5, 1);
    sprite.renderOrder = 999;
    this.scene.add(sprite);

    this.add({
      age: 0,
      life: 1.4,
      tick: (dt, t) => {
        sprite.position.y += dt * 2.4;
        mat.opacity = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
      },
      cleanup: () => {
        this.scene.remove(sprite);
        tex.dispose();
        mat.dispose();
      },
    });
  }

  /** Fade any object's material out, then remove and dispose it. */
  fadeOut(object, life = 1) {
    const mat = object.material;
    const start = mat.opacity ?? 1;
    mat.transparent = true;
    this.add({
      age: 0,
      life,
      tick: (dt, t) => {
        mat.opacity = start * (1 - t);
      },
      cleanup: () => {
        this.scene.remove(object);
        if (object.geometry) object.geometry.dispose();
        mat.dispose();
      },
    });
  }
}

export function makeSoftDot() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.75)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
