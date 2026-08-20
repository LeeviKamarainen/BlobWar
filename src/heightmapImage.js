import { clamp } from './noise.js';

/**
 * Paint a terrain's heightmap into a `dim × dim` 2D canvas context, coloured by
 * band (see Terrain.bandAt) with a hillshade from finite differences, lit from
 * the same direction the ground shader and minimap use (+x, +z). Below
 * `waterLevel` it paints depth-shaded sea instead.
 *
 * Shared by the live corner/full-screen minimap and the map-preview thumbnails
 * in the setup menu, so both read the terrain exactly the same way.
 */
export function paintHeightmapImage(ctx, terrain, waterLevel) {
  const dim = terrain.dim;
  const img = ctx.createImageData(dim, dim);
  const d = img.data;
  const h = terrain.heights;

  for (let iz = 0; iz < dim; iz++) {
    const zPrev = Math.max(0, iz - 1) * dim;
    const zNext = Math.min(dim - 1, iz + 1) * dim;
    const row = iz * dim;
    for (let ix = 0; ix < dim; ix++) {
      const idx = row + ix;
      const y = h[idx];
      let r;
      let g;
      let b;

      if (y < waterLevel) {
        const k = clamp((waterLevel - y) / 13, 0, 1);
        const f = 1 - k * 0.72;
        r = 0.17 * f;
        g = 0.5 * f;
        b = 0.75 * f;
      } else {
        const c = terrain.bandAt(idx);
        const dx = h[row + Math.min(dim - 1, ix + 1)] - h[row + Math.max(0, ix - 1)];
        const dz = h[zNext + ix] - h[zPrev + ix];
        const shade = clamp(1 - (dx * 0.9 + dz * 0.6) * 0.075, 0.45, 1.5);
        r = c[0] * shade;
        g = c[1] * shade;
        b = c[2] * shade;
      }

      const p = idx * 4;
      d[p] = Math.min(255, r * 255);
      d[p + 1] = Math.min(255, g * 255);
      d[p + 2] = Math.min(255, b * 255);
      d[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}
