import { createNoise2D, fbm, smoothstep, clamp } from './noise.js';

/**
 * Canvas-side helpers for the map editor's paint tool. Kept separate from
 * customMap.js (storage) and terrain.js (real generation) — this is purely
 * "draw a brush stroke into a small grid" and "give that grid a quick, cheap
 * colour for the paint canvas," neither of which the server or the match
 * simulation ever needs.
 */

/** Push the cells under a soft-edged circular brush toward `target`. */
export function paintBrush(grid, dim, cx, cz, radius, target, strength) {
  const r2 = radius * radius;
  const minX = Math.max(0, Math.floor(cx - radius));
  const maxX = Math.min(dim - 1, Math.ceil(cx + radius));
  const minZ = Math.max(0, Math.floor(cz - radius));
  const maxZ = Math.min(dim - 1, Math.ceil(cz + radius));

  for (let iz = minZ; iz <= maxZ; iz++) {
    for (let ix = minX; ix <= maxX; ix++) {
      const dx = ix + 0.5 - cx;
      const dz = iz + 0.5 - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      const falloff = 1 - Math.sqrt(d2) / radius;
      const idx = iz * dim + ix;
      grid[idx] += (target - grid[idx]) * falloff * strength;
    }
  }
}

/**
 * Fill the whole grid with a fresh random island shape — a cheap, smaller
 * cousin of Terrain's own formula. Gives "randomly generate some noise on
 * it" a literal button, and a decent starting point to paint over.
 */
export function randomizeControlGrid(grid, dim) {
  const seed = (Math.random() * 1e9) | 0;
  const noise = createNoise2D(seed);
  const ridgeNoise = createNoise2D(seed + 999);

  for (let iz = 0; iz < dim; iz++) {
    for (let ix = 0; ix < dim; ix++) {
      const u = ix / (dim - 1) - 0.5;
      const v = iz / (dim - 1) - 0.5;

      let n = fbm(noise, ix * 0.09, iz * 0.09, 4);
      n = n * 0.5 + 0.5;
      const r = 1 - Math.abs(fbm(ridgeNoise, ix * 0.16 + 40, iz * 0.16 - 12, 3));
      n = n * 0.7 + r * r * 0.3;

      const d = Math.hypot(u, v) / 0.62;
      const island = 1 - smoothstep(0.5, 1.0, d);

      grid[iz * dim + ix] = clamp(n * island, 0, 1);
    }
  }
}

/** Quick 4-stop height gradient for the paint canvas — not the real in-game
 *  band colours (see heightmapImage.js), just enough to paint by feel. */
function heightColor(v) {
  if (v < 0.22) {
    const k = v / 0.22;
    return `rgb(${20 + k * 20},${40 + k * 60},${90 + k * 70})`;
  }
  if (v < 0.45) {
    const k = (v - 0.22) / 0.23;
    return `rgb(${200 - k * 160},${190 - k * 70},${130 - k * 90})`;
  }
  if (v < 0.75) {
    const k = (v - 0.45) / 0.3;
    return `rgb(${40 + k * 30},${120 - k * 30},${40 + k * 20})`;
  }
  const k = (v - 0.75) / 0.25;
  const g = 90 + k * 150;
  return `rgb(${g},${g},${g})`;
}

export function drawControlGrid(ctx, grid, dim, canvasSize) {
  const cell = canvasSize / dim;
  for (let iz = 0; iz < dim; iz++) {
    for (let ix = 0; ix < dim; ix++) {
      ctx.fillStyle = heightColor(grid[iz * dim + ix]);
      // The +1 bleeds each cell into its neighbour by a pixel so there's no
      // seam from canvas rounding between cells.
      ctx.fillRect(ix * cell, iz * cell, cell + 1, cell + 1);
    }
  }
}
