/**
 * The one map a player hand-paints in the map editor. Persisted to
 * localStorage as plain 0..1 floats (no need to be clever about size — 65×65
 * numbers is a few KB of JSON) so it survives a reload, and it's exactly the
 * shape sent to an online room's guests so everyone builds the same terrain
 * (see net.js/server/index.js).
 *
 * Pure data + storage only — no THREE, no canvas — so the server can import
 * `CONTROL_DIM` for validation without dragging in a renderer.
 */

export const CONTROL_DIM = 65;
export const CUSTOM_MAP_ID = 'custom';

const KEY = 'blobwar.customMap';

function clamp01(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

/** Returns `{ name, noiseAmount, heights: Float32Array }`, or null if nothing's saved. */
export function loadCustomMap() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.heights) || data.heights.length !== CONTROL_DIM * CONTROL_DIM) return null;
    return {
      name: typeof data.name === 'string' && data.name ? data.name.slice(0, 24) : 'My Map',
      noiseAmount: clamp01(data.noiseAmount, 0.3),
      heights: Float32Array.from(data.heights, (v) => clamp01(v, 0.45)),
    };
  } catch {
    return null;
  }
}

export function saveCustomMap({ name, noiseAmount, heights }) {
  localStorage.setItem(
    KEY,
    JSON.stringify({
      name: (name || 'My Map').slice(0, 24),
      noiseAmount: clamp01(noiseAmount, 0.3),
      // Rounded — full float precision buys nothing for a painted heightmap.
      heights: Array.from(heights, (v) => Math.round(clamp01(v, 0.45) * 1000) / 1000),
    })
  );
}

export function deleteCustomMap() {
  localStorage.removeItem(KEY);
}

/** A flat starting canvas for a brand-new map: mid-height, walkable everywhere. */
export function blankControlGrid(fill = 0.45) {
  return new Float32Array(CONTROL_DIM * CONTROL_DIM).fill(fill);
}

/** Build the Terrain-consumable map definition from stored/relayed data. */
export function customMapDef({ name, noiseAmount, heights }) {
  return {
    id: CUSTOM_MAP_ID,
    name: name || 'My Map',
    desc: 'A hand-painted map.',
    custom: true,
    controlDim: CONTROL_DIM,
    controlHeights: heights,
    noiseAmount: clamp01(noiseAmount, 0.3),
  };
}
