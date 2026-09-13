import * as THREE from 'three';
import { CFG } from './config.js';
import { createNoise2D, fbm, smoothstep, clamp, mulberry32, bilinear } from './noise.js';
import { MAPS, DEFAULT_MAP } from './maps.js';

/**
 * Destructible heightmap island.
 *
 * The heightmap is a (seg+1)^2 grid of Y values. Explosions carve a hemisphere
 * out of it (`carve`), which is what makes the terrain destructible: a vertex is
 * pushed down to the lowest point of the blast sphere above it, never up by
 * carve itself. The one thing that does push a vertex up is `raise`, used by
 * the wall-building tool to mound earth rather than remove it.
 */
export class Terrain {
  constructor(seed = 1, mapDef = MAPS[DEFAULT_MAP]) {
    const { size, seg } = CFG.terrain;
    this.mapDef = mapDef;
    this.mapId = mapDef.id;
    this.size = size;
    this.seg = seg;
    this.step = size / seg;
    this.half = size / 2;
    this.dim = seg + 1;
    this.heights = new Float32Array(this.dim * this.dim);
    this.craterLog = [];
    // Bumped whenever the heightmap changes, so the minimap knows when its
    // cached image of the island has gone stale.
    this.revision = 0;

    this.geometry = new THREE.PlaneGeometry(size, size, seg, seg);
    this.geometry.rotateX(-Math.PI / 2);
    this.geometry.setAttribute(
      'color',
      new THREE.BufferAttribute(new Float32Array(this.dim * this.dim * 3), 3)
    );

    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.95,
      metalness: 0,
      map: sharedDetailTexture(),
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.receiveShadow = true;
    // Deliberately not a shadow caster: a 170x170 heightmap self-shadowing at
    // this scale is all acne and no information.
    this.mesh.castShadow = false;

    this.generate(seed);
  }

  // --- generation -----------------------------------------------------------

  generate(seed) {
    if (this.mapDef.custom) return this.generateCustom(seed);

    const m = this.mapDef;
    const noise = createNoise2D(seed);
    const ridgeNoise = createNoise2D(seed + 7717);
    const { maxHeight, seaFloor } = CFG.terrain;

    for (let iz = 0; iz < this.dim; iz++) {
      for (let ix = 0; ix < this.dim; ix++) {
        const x = ix * this.step - this.half;
        const z = iz * this.step - this.half;

        // Base landmass. Kept low-frequency so a 280-unit island still has
        // broad, walkable plateaus rather than a field of spikes.
        let n = fbm(noise, x * m.freq, z * m.freq, m.octaves);
        n = n * 0.5 + 0.5;

        // Ridges give the island some climbable spines and valleys.
        const r = 1 - Math.abs(fbm(ridgeNoise, x * m.ridgeFreq + 40, z * m.ridgeFreq - 12, m.ridgeOctaves));
        n = n * (1 - m.ridgeWeight) + r * r * m.ridgeWeight;

        // Radial falloff so the edges of the map drop into the sea.
        const d = Math.hypot(x, z) / (this.half * m.islandRadius);
        const island = 1 - smoothstep(m.falloffStart, m.falloffEnd, d);

        let h = maxHeight * m.heightScale * Math.pow(n, m.heightPow) * island + m.baseOffset;

        // Flatten the very deep water so the sea floor reads as a floor.
        if (h < seaFloor) h = seaFloor + (h - seaFloor) * 0.15;

        this.heights[iz * this.dim + ix] = h;
      }
    }

    this.rebuildAll();
  }

  /**
   * Hand-painted map: `mapDef.controlHeights` is a `controlDim × controlDim`
   * grid of 0..1 values authored in the map editor. Bilinear-sampled up to the
   * full heightmap resolution as the base shape, then a procedural noise layer
   * — the same kind every other map uses, scaled by `mapDef.noiseAmount` — is
   * blended on top. That's what keeps two matches on the same painted map from
   * looking identical, exactly like the formula-driven presets vary by seed.
   */
  generateCustom(seed) {
    const m = this.mapDef;
    const noise = createNoise2D(seed);
    const { maxHeight, seaFloor } = CFG.terrain;
    const cdim = m.controlDim;
    const grid = m.controlHeights;
    const amount = m.noiseAmount ?? 0.3;

    for (let iz = 0; iz < this.dim; iz++) {
      for (let ix = 0; ix < this.dim; ix++) {
        const x = ix * this.step - this.half;
        const z = iz * this.step - this.half;

        const u = (ix / this.seg) * (cdim - 1);
        const v = (iz / this.seg) * (cdim - 1);
        const base = bilinear(grid, cdim, u, v);

        let n = fbm(noise, x * 0.02, z * 0.02, 4);
        n = n * 0.5 + 0.5;

        const h01 = clamp(base + (n - 0.5) * amount, 0, 1);
        // A power curve, same trick the formula-driven presets use: it keeps
        // "Mid" reading as a walkable green plain and reserves snow for
        // genuinely high paint, instead of a linear map turning half the
        // canvas white the moment you paint above the middle swatch.
        let h = Math.pow(h01, 1.6) * maxHeight - 8;

        if (h < seaFloor) h = seaFloor + (h - seaFloor) * 0.15;

        this.heights[iz * this.dim + ix] = h;
      }
    }

    this.rebuildAll();
  }

  // --- sampling -------------------------------------------------------------

  /** Bilinear height lookup in world space. */
  heightAt(x, z) {
    const gx = clamp((x + this.half) / this.step, 0, this.seg - 1e-4);
    const gz = clamp((z + this.half) / this.step, 0, this.seg - 1e-4);
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const fx = gx - ix;
    const fz = gz - iz;
    const h = this.heights;
    const d = this.dim;
    const h00 = h[iz * d + ix];
    const h10 = h[iz * d + ix + 1];
    const h01 = h[(iz + 1) * d + ix];
    const h11 = h[(iz + 1) * d + ix + 1];
    const a = h00 + (h10 - h00) * fx;
    const b = h01 + (h11 - h01) * fx;
    return a + (b - a) * fz;
  }

  /** Surface normal from finite differences. */
  normalAt(x, z, out = new THREE.Vector3()) {
    const e = this.step;
    const hl = this.heightAt(x - e, z);
    const hr = this.heightAt(x + e, z);
    const hd = this.heightAt(x, z - e);
    const hu = this.heightAt(x, z + e);
    return out.set(hl - hr, 2 * e, hd - hu).normalize();
  }

  /** Steepness at a point, as rise over run (0 = flat). */
  slopeAt(x, z) {
    const n = this.normalAt(x, z, _tmpN);
    return Math.hypot(n.x, n.z) / Math.max(1e-4, n.y);
  }

  inBounds(x, z) {
    return Math.abs(x) < this.half - 1 && Math.abs(z) < this.half - 1;
  }

  // --- destruction ----------------------------------------------------------

  /**
   * Blow a hemisphere-shaped crater out of the heightmap.
   * Returns true if anything actually changed.
   */
  carve(cx, cy, cz, radius) {
    const r2 = radius * radius;
    const minIx = Math.max(0, Math.floor((cx - radius + this.half) / this.step));
    const maxIx = Math.min(this.seg, Math.ceil((cx + radius + this.half) / this.step));
    const minIz = Math.max(0, Math.floor((cz - radius + this.half) / this.step));
    const maxIz = Math.min(this.seg, Math.ceil((cz + radius + this.half) / this.step));
    let changed = false;

    for (let iz = minIz; iz <= maxIz; iz++) {
      const z = iz * this.step - this.half;
      const dz = z - cz;
      for (let ix = minIx; ix <= maxIx; ix++) {
        const x = ix * this.step - this.half;
        const dx = x - cx;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r2) continue;
        const idx = iz * this.dim + ix;
        const depth = Math.sqrt(r2 - d2);
        const target = cy - depth;
        if (this.heights[idx] > target) {
          this.heights[idx] = Math.max(target, CFG.terrain.seaFloor - 2);
          changed = true;
        }
      }
    }

    if (changed) {
      this.revision++;
      this.refreshRegion(minIx, minIz, maxIx, maxIz);
      // Craters are the entire diff of the terrain over a match, and carving is
      // pure compare/subtract/sqrt — all IEEE-exact — so replaying this log on
      // another machine reproduces the heightmap bit for bit. It's also
      // idempotent (min()), so applying the same crater twice is harmless.
      this.craterLog.push({ x: cx, y: cy, z: cz, r: radius });
    }
    return changed;
  }

  /**
   * Push a dome of terrain upward out of the heightmap, never down — the
   * mirror image of `carve`. `radius` is the footprint, `height` the apex
   * rise above `cy`, kept as a separate knob (rather than reusing radius the
   * way carve's hemisphere does) so a wall can be tall and narrow instead of
   * a shallow wide mound.
   */
  raise(cx, cy, cz, radius, height) {
    const r2 = radius * radius;
    const minIx = Math.max(0, Math.floor((cx - radius + this.half) / this.step));
    const maxIx = Math.min(this.seg, Math.ceil((cx + radius + this.half) / this.step));
    const minIz = Math.max(0, Math.floor((cz - radius + this.half) / this.step));
    const maxIz = Math.min(this.seg, Math.ceil((cz + radius + this.half) / this.step));
    let changed = false;

    for (let iz = minIz; iz <= maxIz; iz++) {
      const z = iz * this.step - this.half;
      const dz = z - cz;
      for (let ix = minIx; ix <= maxIx; ix++) {
        const x = ix * this.step - this.half;
        const dx = x - cx;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r2) continue;
        const idx = iz * this.dim + ix;
        const target = cy + height * Math.sqrt(1 - d2 / r2);
        if (this.heights[idx] < target) {
          this.heights[idx] = Math.min(target, CFG.terrain.maxHeight + 20);
          changed = true;
        }
      }
    }

    if (changed) {
      this.revision++;
      this.refreshRegion(minIx, minIz, maxIx, maxIz);
      // Same replay trick as craters (see carve): pure arithmetic, IEEE-exact,
      // and max() makes it idempotent, so it can share the crater log and be
      // replayed on other clients the same way.
      this.craterLog.push({ x: cx, y: cy, z: cz, r: radius, h: height, type: 'raise' });
    }
    return changed;
  }

  applyCraters(list) {
    for (const c of list) {
      if (c.type === 'raise') this.raise(c.x, c.y, c.z, c.r, c.h);
      else this.carve(c.x, c.y, c.z, c.r);
    }
  }

  /** Last-resort online resync: overwrite the whole heightmap. */
  setHeights(source) {
    this.heights.set(source);
    this.craterLog = [];
    this.rebuildAll();
  }

  takeCraterLog() {
    const out = this.craterLog;
    this.craterLog = [];
    return out;
  }

  /** FNV-1a over the raw height bits — used to detect terrain drift online. */
  checksum() {
    const view = new Uint32Array(this.heights.buffer);
    let h = 0x811c9dc5;
    for (let i = 0; i < view.length; i++) {
      h ^= view[i];
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  // --- mesh sync ------------------------------------------------------------

  rebuildAll() {
    this.revision++;
    const pos = this.geometry.attributes.position;
    for (let i = 0; i < this.heights.length; i++) {
      pos.setY(i, this.heights[i]);
      this.paintVertex(i);
    }
    pos.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere();
  }

  refreshRegion(minIx, minIz, maxIx, maxIz) {
    const pos = this.geometry.attributes.position;
    for (let iz = Math.max(0, minIz - 1); iz <= Math.min(this.seg, maxIz + 1); iz++) {
      for (let ix = Math.max(0, minIx - 1); ix <= Math.min(this.seg, maxIx + 1); ix++) {
        const idx = iz * this.dim + ix;
        pos.setY(idx, this.heights[idx]);
        this.paintVertex(idx);
      }
    }
    pos.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
    // No computeVertexNormals here on purpose. The material is flat-shaded, so
    // the fragment shader derives normals from screen-space derivatives and the
    // attribute is only used for shadow normal-bias. Recomputing it over ~79k
    // vertices on every crater would cost more than the whole rest of the frame.
  }

  /**
   * Which surface band a grid vertex falls in. Split out of paintVertex so the
   * minimap can colour the island exactly like the ground you're standing on.
   */
  bandAt(idx) {
    const h = this.heights[idx];
    const ix = idx % this.dim;
    const iz = (idx / this.dim) | 0;

    // Cheap slope estimate straight from the array (avoids bilinear lookups).
    const hl = this.heights[iz * this.dim + Math.max(0, ix - 1)];
    const hr = this.heights[iz * this.dim + Math.min(this.seg, ix + 1)];
    const hd = this.heights[Math.max(0, iz - 1) * this.dim + ix];
    const hu = this.heights[Math.min(this.seg, iz + 1) * this.dim + ix];
    const slope = Math.hypot(hr - hl, hu - hd) / (2 * this.step);

    if (h < -1.6) return COL.deep;
    if (h < 2.6 - slope) return COL.sand;
    if (slope > 1.05) return COL.rock;
    if (h > 26) return COL.snow;
    if (h > 13) return COL.highGrass;
    return COL.grass;
  }

  paintVertex(idx) {
    const ix = idx % this.dim;
    const iz = (idx / this.dim) | 0;
    const x = ix * this.step - this.half;
    const z = iz * this.step - this.half;

    const c = this.bandAt(idx);
    const wobble = (Math.sin(x * 0.7) + Math.cos(z * 0.63)) * 0.012;

    const col = this.geometry.attributes.color;
    col.setXYZ(
      idx,
      clamp(c[0] + wobble, 0, 1),
      clamp(c[1] + wobble, 0, 1),
      clamp(c[2] + wobble, 0, 1)
    );
  }

  // --- spawning -------------------------------------------------------------

  /**
   * Find `count` well-separated, reasonably flat, above-water spawn points.
   */
  findSpawnPoints(count, seed = 99, minDist = 26) {
    const rand = mulberry32(seed);
    const picks = [];
    let attempts = 0;
    let dist = minDist;

    while (picks.length < count && attempts < 6000) {
      attempts++;
      if (attempts % 1200 === 0) dist *= 0.78; // relax if the island is cramped

      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * this.half * 0.7;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const h = this.heightAt(x, z);
      if (h < 2.5) continue;
      if (this.slopeAt(x, z) > 0.55) continue;
      if (picks.some((p) => Math.hypot(p.x - x, p.z - z) < dist)) continue;
      picks.push(new THREE.Vector3(x, h, z));
    }

    // Fallback: if the island refused to cooperate, just take the highest spots.
    while (picks.length < count) {
      let best = null;
      for (let i = 0; i < 400; i++) {
        const x = (rand() * 2 - 1) * this.half * 0.6;
        const z = (rand() * 2 - 1) * this.half * 0.6;
        const h = this.heightAt(x, z);
        if (!best || h > best.y) best = new THREE.Vector3(x, h, z);
      }
      picks.push(best);
    }
    return picks;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

const _tmpN = new THREE.Vector3();

// A subtle mottled detail texture, multiplied over the vertex-coloured
// terrain so the flat-shaded biome bands aren't perfectly flat colour up
// close. Built once from the same noise the terrain itself uses, and shared
// across every Terrain instance (a new one is built per match).
let _detailTex = null;
function sharedDetailTexture() {
  if (_detailTex) return _detailTex;
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const noise = createNoise2D(1337);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(noise, x * 0.045, y * 0.045, 4) * 0.5 + 0.5;
      const v = Math.round(198 + n * 57); // stays light: a modulation, not a shadow
      const idx = (y * size + x) * 4;
      img.data[idx] = v;
      img.data[idx + 1] = v;
      img.data[idx + 2] = v;
      img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  _detailTex = new THREE.CanvasTexture(c);
  _detailTex.wrapS = _detailTex.wrapT = THREE.RepeatWrapping;
  _detailTex.repeat.set(46, 46);
  _detailTex.colorSpace = THREE.SRGBColorSpace;
  return _detailTex;
}

export const COL = {
  deep: [0.34, 0.29, 0.21],
  sand: [0.78, 0.69, 0.44],
  grass: [0.27, 0.5, 0.19],
  highGrass: [0.19, 0.38, 0.17],
  rock: [0.38, 0.36, 0.35],
  snow: [0.88, 0.91, 0.95],
};
