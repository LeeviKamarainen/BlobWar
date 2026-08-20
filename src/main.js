import * as THREE from 'three';
import { CFG } from './config.js';
import { Game } from './game.js';
import { COL } from './terrain.js';
import { HUD } from './hud.js';
import { Audio } from './audio.js';
import { Input } from './input.js';
import { Net } from './net.js';
import { Menu } from './menu.js';
import { Minimap } from './minimap.js';
import { PRACTICE_MAP } from './maps.js';

// --- renderer ---------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x9fc4e8, 300, 950);

const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.4, 2600);
camera.position.set(0, 40, 70);

// --- sky --------------------------------------------------------------------

const sky = new THREE.Mesh(
  new THREE.SphereGeometry(1500, 32, 20),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color(0x2f6fd0) },
      middle: { value: new THREE.Color(0x8fc0f0) },
      bottom: { value: new THREE.Color(0xf2e3c6) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vPos;
      uniform vec3 top, middle, bottom;
      void main() {
        float h = normalize(vPos).y;
        vec3 c = h > 0.0 ? mix(middle, top, pow(h, 0.7)) : mix(middle, bottom, pow(-h, 0.5));
        gl_FragColor = vec4(c, 1.0);
      }`,
  })
);
sky.frustumCulled = false;
scene.add(sky);

// --- lighting ---------------------------------------------------------------

const hemi = new THREE.HemisphereLight(0xbfe0ff, 0x5a4a32, 0.5);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xfff3d6, 1.55);
sun.position.set(90, 130, 60);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 20;
sun.shadow.camera.far = 700;
// Follows the action rather than covering the whole 280-unit island, which keeps
// blob shadows crisp on a map this size.
const SHADOW_EXTENT = 150;
sun.shadow.camera.left = -SHADOW_EXTENT;
sun.shadow.camera.right = SHADOW_EXTENT;
sun.shadow.camera.top = SHADOW_EXTENT;
sun.shadow.camera.bottom = -SHADOW_EXTENT;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);

scene.add(new THREE.AmbientLight(0xffffff, 0.1));

// --- ocean ------------------------------------------------------------------

const waterGeo = new THREE.PlaneGeometry(1800, 1800, 90, 90);
waterGeo.rotateX(-Math.PI / 2);
const waterBase = Float32Array.from(waterGeo.attributes.position.array);
const water = new THREE.Mesh(
  waterGeo,
  new THREE.MeshStandardMaterial({
    color: 0x2b7fbf,
    transparent: true,
    opacity: 0.82,
    roughness: 0.18,
    metalness: 0.25,
    flatShading: true,
  })
);
water.position.y = CFG.terrain.waterLevel;
water.receiveShadow = true;
scene.add(water);

// The island is a 280-unit square of heightmap and the waves are a 1800-unit
// plane, so from anything but ground level you can see where both stop: the
// terrain's sea-floor rim reads as a square shelf, and the waves end in mid-sea.
// Two static sheets carry the ocean out past the fog in every direction.
//
// The abyss sits just under the terrain's outer rim (a flat -8 all round, once
// the island falloff has bottomed out) and wears the same colour that rim is
// painted, so the two are indistinguishable through the water.
const abyss = new THREE.Mesh(
  new THREE.PlaneGeometry(6000, 6000),
  new THREE.MeshStandardMaterial({
    color: new THREE.Color().setRGB(COL.deep[0], COL.deep[1], COL.deep[2], THREE.LinearSRGBColorSpace),
    roughness: 0.95,
    metalness: 0,
  })
);
abyss.geometry.rotateX(-Math.PI / 2);
abyss.position.y = -8.15;
scene.add(abyss);

// The far water is an annulus with a square hole cut exactly to the animated
// plane, so the two never overlap. That matters: they share one material, and
// two translucent sheets stacked would blend twice and print the seam we're
// trying to hide. No overlap, one material, no seam — only the waves stop.
const FAR = 2600;
const NEAR_EDGE = 900;
const shelf = new THREE.Shape();
shelf.moveTo(-FAR, -FAR);
shelf.lineTo(FAR, -FAR);
shelf.lineTo(FAR, FAR);
shelf.lineTo(-FAR, FAR);
shelf.closePath();
const hole = new THREE.Path();
hole.moveTo(-NEAR_EDGE, -NEAR_EDGE);
hole.lineTo(-NEAR_EDGE, NEAR_EDGE);
hole.lineTo(NEAR_EDGE, NEAR_EDGE);
hole.lineTo(NEAR_EDGE, -NEAR_EDGE);
hole.closePath();
shelf.holes.push(hole);
const farWaterGeo = new THREE.ShapeGeometry(shelf);
farWaterGeo.rotateX(-Math.PI / 2);
const farWater = new THREE.Mesh(farWaterGeo, water.material);
scene.add(farWater);

function animateWater(t) {
  // Sudden death raises the sea, so the plane tracks the config value.
  water.position.y += (CFG.terrain.waterLevel - water.position.y) * 0.06;
  farWater.position.y = water.position.y;
  const pos = waterGeo.attributes.position;
  const arr = pos.array;
  for (let i = 0; i < arr.length; i += 3) {
    const x = waterBase[i];
    const z = waterBase[i + 2];
    arr[i + 1] =
      Math.sin(x * 0.05 + t * 1.1) * 0.35 +
      Math.cos(z * 0.062 - t * 0.85) * 0.3 +
      Math.sin((x + z) * 0.021 + t * 0.5) * 0.5;
  }
  pos.needsUpdate = true;
  waterGeo.computeVertexNormals();
}

// --- wiring -----------------------------------------------------------------

const hud = new HUD();
const audio = new Audio();
const input = new Input(renderer.domElement);
const game = new Game({ scene, camera, hud, audio, input });
game.minimap = new Minimap({ game, scene, renderer });
const net = new Net();

const menu = new Menu({
  overlay: document.getElementById('overlay'),
  net,
  onStartLocal: ({ teamCount, aiTeams, mapId, gravity, weapons, customMap }) => {
    audio.resume();
    game.net = null;
    game.start({
      mode: 'local',
      teamCount,
      aiTeams,
      localTeams: null,
      mapId,
      gravity,
      enabledWeapons: weapons,
      customMap,
    });
    menu.hide();
  },
  onStartOnline: ({ seed, teamCount, players, mapId, gravity, weapons, customMap }) => {
    audio.resume();
    game.net = net.session(game);
    game.start({
      mode: 'online',
      seed,
      teamCount,
      aiTeams: [],
      localTeams: [net.slot],
      labels: players.map((p) => p.name),
      mapId,
      gravity,
      enabledWeapons: weapons,
      customMap,
    });
    menu.hide();
  },
  onStartPractice: () => {
    audio.resume();
    game.net = null;
    game.start({ mode: 'practice', mapId: PRACTICE_MAP, teamCount: 1, blobsPerTeam: 1, aiTeams: [], localTeams: null });
    menu.hide();
  },
  onResume: () => menu.hide(),
  onQuit: () => {
    net.leave();
    game.net = null;
    game.teardown();
    game.state = 'idle';
    menu.show('title');
  },
});

net.on('start', (info) => menu.onStartOnline(info));
net.on('peerLeft', ({ name, started }) => {
  if (started) hud.toast(`${name} disconnected`, '#ff6b6b', 2000);
});

// Esc during a match opens the pause screen; the menu owns the overlay.
game.onPause = () => menu.show('pause');
game.onExit = () => {
  net.leave();
  game.net = null;
  menu.show('title');
};

menu.show('title');

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Keep audio alive after tab switches.
window.addEventListener('pointerdown', () => audio.resume(), { once: true });

// --- loop -------------------------------------------------------------------

const clock = new THREE.Clock();
let elapsed = 0;

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 1 / 20);
  elapsed += dt;

  game.update(dt, elapsed);
  animateWater(elapsed);

  // Keep the shadow frustum centred on the action.
  sun.target.position.copy(game.rig ? game.rig.target : scene.position);
  sun.position.copy(sun.target.position).add(SUN_OFFSET);
  sun.target.updateMatrixWorld();

  // The full map's 3D mode renders the same scene from a camera orbiting high
  // above the island, in place of the play camera, not alongside it.
  if (game.minimap.renders3D()) {
    sky.position.copy(game.minimap.camera.position);
    game.minimap.render3D();
  } else {
    sky.position.copy(camera.position);
    renderer.render(scene, camera);
  }
}

const SUN_OFFSET = new THREE.Vector3(90, 130, 60);
frame();

// Handy for tinkering from the console.
window.__game = game;
