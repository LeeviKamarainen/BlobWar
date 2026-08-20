import { Terrain } from './terrain.js';
import { MAPS } from './maps.js';
import { paintHeightmapImage } from './heightmapImage.js';

// One fixed seed for every preview — this is a picture of the map's *shape*,
// not of any particular match, so it has to be the same for everyone and
// stable across renders (see cache below).
const PREVIEW_SEED = 20260820;

const cache = new Map();

/**
 * Lazily render and cache a small top-down PNG of a map preset, for the
 * setup menu's map picker. Reuses Terrain's real generation code — same
 * params the match itself would use — so the thumbnail isn't a guess at
 * what the map looks like.
 */
export function mapPreviewUrl(mapId) {
  if (cache.has(mapId)) return cache.get(mapId);
  const mapDef = MAPS[mapId];
  if (!mapDef) return null;

  const terrain = new Terrain(PREVIEW_SEED, mapDef);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = terrain.dim;
  // Sea level 0, not whatever a live match's sudden death left CFG.terrain.waterLevel
  // at — this preview has no match behind it.
  paintHeightmapImage(canvas.getContext('2d'), terrain, 0);
  const url = canvas.toDataURL('image/png');
  terrain.dispose();

  cache.set(mapId, url);
  return url;
}
