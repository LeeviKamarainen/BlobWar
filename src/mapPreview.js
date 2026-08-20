import { Terrain } from './terrain.js';
import { MAPS } from './maps.js';
import { paintHeightmapImage } from './heightmapImage.js';
import { CUSTOM_MAP_ID, loadCustomMap, customMapDef } from './customMap.js';

// One fixed seed for every cached preview — this is a picture of the map's
// *shape*, not of any particular match, so it has to be the same for
// everyone and stable across renders.
const PREVIEW_SEED = 20260820;

const cache = new Map();

function renderTerrainImage(mapDef, seed) {
  const terrain = new Terrain(seed, mapDef);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = terrain.dim;
  // Sea level 0, not whatever a live match's sudden death left
  // CFG.terrain.waterLevel at — a preview has no match behind it.
  paintHeightmapImage(canvas.getContext('2d'), terrain, 0);
  const url = canvas.toDataURL('image/png');
  terrain.dispose();
  return url;
}

/**
 * Lazily render and cache a small top-down PNG of a map, for the setup
 * menu's map picker. Reuses Terrain's real generation code — same params
 * the match itself would use — so the thumbnail isn't a guess at what the
 * map looks like. `'custom'` reads the player's saved hand-painted map.
 */
export function mapPreviewUrl(mapId) {
  if (cache.has(mapId)) return cache.get(mapId);

  let mapDef;
  if (mapId === CUSTOM_MAP_ID) {
    const saved = loadCustomMap();
    if (!saved) return null;
    mapDef = customMapDef(saved);
  } else {
    mapDef = MAPS[mapId];
  }
  if (!mapDef) return null;

  const url = renderTerrainImage(mapDef, PREVIEW_SEED);
  cache.set(mapId, url);
  return url;
}

/** Drop a cached thumbnail so it's regenerated next time it's asked for —
 *  call after saving or deleting the custom map. */
export function invalidateMapPreview(mapId) {
  cache.delete(mapId);
}

/** Used by the map editor's live preview while painting — not cached, since
 *  the definition changes on every stroke. */
export function renderCustomPreview(mapDef, seed = PREVIEW_SEED) {
  return renderTerrainImage(mapDef, seed);
}
