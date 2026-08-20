/**
 * Map presets — parameters for Terrain.generate(). Pure data, no three.js
 * dependency, so the server can import it too (room validation) without
 * pulling in a renderer.
 *
 * freq/octaves         base landmass noise (low frequency = broad plateaus)
 * ridgeFreq/octaves    the ridge layer that gives climbable spines and valleys
 * ridgeWeight          how much the ridge layer contributes vs. the base noise
 * islandRadius         fraction of the half-size the radial falloff is measured against
 * falloffStart/End     smoothstep range (in that normalized distance) where land turns to sea
 * heightPow            n^heightPow before scaling — higher flattens the mid-range, chunks the peaks
 * heightScale          multiplier on CFG.terrain.maxHeight
 * baseOffset           flat height shift applied after scaling
 */
export const MAPS = {
  archipelago: {
    id: 'archipelago',
    name: 'Archipelago',
    desc: 'The classic island — broad plateaus, climbable ridges, deep water at the edges.',
    freq: 0.0072,
    octaves: 5,
    ridgeFreq: 0.013,
    ridgeOctaves: 3,
    ridgeWeight: 0.28,
    islandRadius: 0.94,
    falloffStart: 0.42,
    falloffEnd: 1.0,
    heightPow: 1.5,
    heightScale: 1,
    baseOffset: -8,
  },
  highlands: {
    id: 'highlands',
    name: 'Highlands',
    desc: 'Taller, ridgier terrain and less flat ground — cover everywhere, sightlines short.',
    freq: 0.0068,
    octaves: 5,
    ridgeFreq: 0.016,
    ridgeOctaves: 4,
    ridgeWeight: 0.48,
    islandRadius: 0.96,
    falloffStart: 0.5,
    falloffEnd: 1.0,
    heightPow: 1.15,
    heightScale: 1.25,
    baseOffset: -6,
  },
  flatlands: {
    id: 'flatlands',
    name: 'Flatlands',
    desc: 'Low, rolling plains with wide open ground — shots carry a long way before cover.',
    freq: 0.0065,
    octaves: 4,
    ridgeFreq: 0.011,
    ridgeOctaves: 2,
    ridgeWeight: 0.1,
    islandRadius: 0.94,
    falloffStart: 0.55,
    falloffEnd: 1.0,
    heightPow: 2.1,
    heightScale: 0.5,
    baseOffset: -8,
  },
  atoll: {
    id: 'atoll',
    name: 'Atoll',
    desc: 'A small landmass ringed by a lot of sea — crowded, and one bad step from a swim.',
    freq: 0.0085,
    octaves: 5,
    ridgeFreq: 0.015,
    ridgeOctaves: 3,
    ridgeWeight: 0.22,
    islandRadius: 0.94,
    falloffStart: 0.26,
    falloffEnd: 0.72,
    heightPow: 1.4,
    heightScale: 0.85,
    baseOffset: -8,
  },

  // Not offered in the regular map picker — this is what Practice Range loads.
  // Barely any relief at all, so a shot's landing spot is down to the weapon
  // and the wind, not the ground getting in the way.
  practiceRange: {
    id: 'practiceRange',
    name: 'Practice Range',
    desc: 'Pancake flat and wide open — a sandbox for getting a feel for every weapon.',
    freq: 0.006,
    octaves: 3,
    ridgeFreq: 0.009,
    ridgeOctaves: 1,
    ridgeWeight: 0.03,
    islandRadius: 0.92,
    falloffStart: 0.6,
    falloffEnd: 1.0,
    heightPow: 2.6,
    heightScale: 0.07,
    baseOffset: 3,
  },
};

export const MAP_ORDER = ['archipelago', 'highlands', 'flatlands', 'atoll'];
export const DEFAULT_MAP = 'archipelago';
export const PRACTICE_MAP = 'practiceRange';
