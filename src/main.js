import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
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

// Rough device-capability guess: fewer/cheaper post passes on phones and
// low-core machines so bloom+SMAA don't tank the frame rate there.
const LOW_END = /Mobi|Android/i.test(navigator.userAgent) || (navigator.hardwareConcurrency || 8) <= 4;

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
      time: { value: 0 },
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
      uniform float time;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }
      float valueNoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        float a = hash(i), b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
      }
      float cloudFbm(vec2 p) {
        float v = 0.0, amp = 0.5;
        for (int i = 0; i < 4; i++) {
          v += amp * valueNoise(p);
          p *= 2.05;
          amp *= 0.5;
        }
        return v;
      }

      void main() {
        vec3 dir = normalize(vPos);
        float h = dir.y;
        vec3 c = h > 0.0 ? mix(middle, top, pow(h, 0.7)) : mix(middle, bottom, pow(-h, 0.5));

        if (h > 0.015) {
          vec2 cloudUv = dir.xz / max(h, 0.06) * 0.22 + vec2(time * 0.006, time * 0.0035);
          float clouds = cloudFbm(cloudUv);
          clouds = smoothstep(0.52, 0.82, clouds) * smoothstep(0.015, 0.22, h);
          c = mix(c, vec3(1.0, 0.99, 0.97), clouds * 0.8);
        }

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

// Cool fill light from the opposite side so shadowed faces on the flat-shaded
// geometry don't go fully flat and black — no shadow casting, it's just there
// to lift the dark side a touch.
const fill = new THREE.DirectionalLight(0x9fc7ff, 0.32);
fill.position.set(-80, 55, -70);
scene.add(fill);

scene.add(new THREE.AmbientLight(0xffffff, 0.1));

// --- ocean ------------------------------------------------------------------

const waterGeo = new THREE.PlaneGeometry(1800, 1800, 90, 90);
waterGeo.rotateX(-Math.PI / 2);
const waterBase = Float32Array.from(waterGeo.attributes.position.array);
const waterMat = new THREE.MeshStandardMaterial({
  color: 0x2b7fbf,
  transparent: true,
  opacity: 0.82,
  roughness: 0.18,
  metalness: 0.25,
  flatShading: true,
  normalMap: makeRippleNormalTexture(),
  normalScale: new THREE.Vector2(0.22, 0.22),
});
waterMat.normalMap.wrapS = waterMat.normalMap.wrapT = THREE.RepeatWrapping;
waterMat.normalMap.repeat.set(30, 30);

// Grazing-angle fresnel: the water reads as opaque and a little brighter at
// shallow viewing angles (looking across it) and stays translucent looking
// straight down, instead of one flat opacity everywhere.
waterMat.onBeforeCompile = (shader) => {
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <opaque_fragment>',
    /* glsl */ `
    {
      vec3 viewDir = normalize( vViewPosition );
      float fresnel = pow( 1.0 - saturate( dot( normal, viewDir ) ), 3.0 );
      diffuseColor.a = mix( diffuseColor.a, 1.0, fresnel * 0.65 );
      outgoingLight += fresnel * vec3( 0.35, 0.45, 0.5 );
    }
    #include <opaque_fragment>`
  );
};

const water = new THREE.Mesh(waterGeo, waterMat);
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
  waterMat.normalMap.offset.set(t * 0.018, t * 0.012);
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

function makeRippleNormalTexture() {
  // A small tileable "bump" texture standing in for real water normal data:
  // each texel gets a random flat-ish normal (mostly +Z, nudged in x/y) so
  // MeshStandardMaterial's normalMap picks up fine ripples the vertex
  // displacement is too coarse to carry, without needing an asset file.
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const nx = (Math.random() - 0.5) * 0.5;
    const ny = (Math.random() - 0.5) * 0.5;
    const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
    img.data[i * 4] = (nx * 0.5 + 0.5) * 255;
    img.data[i * 4 + 1] = (ny * 0.5 + 0.5) * 255;
    img.data[i * 4 + 2] = nz * 255;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}

// --- post-processing ---------------------------------------------------------

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

const bloomRes = new THREE.Vector2(window.innerWidth, window.innerHeight).multiplyScalar(LOW_END ? 0.5 : 1);
const bloomPass = new UnrealBloomPass(bloomRes, 0.55, 0.4, 0.86);
composer.addPass(bloomPass);

// Chromatic-aberration + vignette "punch" pulsed briefly on big hits (see
// postFX.punch below), decaying back to nothing every frame.
const punchPass = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, amount: { value: 0 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float amount;
    varying vec2 vUv;
    void main() {
      vec2 dir = vUv - 0.5;
      float dist = length(dir);
      vec2 offset = dir * amount * 0.018;
      float r = texture2D(tDiffuse, vUv - offset).r;
      float g = texture2D(tDiffuse, vUv).g;
      float b = texture2D(tDiffuse, vUv + offset).b;
      float vig = 1.0 - smoothstep(0.35, 0.95, dist) * amount * 0.5;
      gl_FragColor = vec4(vec3(r, g, b) * vig, 1.0);
    }`,
});
composer.addPass(punchPass);

if (!LOW_END) {
  const smaaPass = new SMAAPass();
  composer.addPass(smaaPass);
}
composer.addPass(new OutputPass());

let punchAmount = 0;
const postFX = {
  /** A brief chromatic-aberration/vignette kick, e.g. on a big explosion. */
  punch(amount) {
    punchAmount = Math.min(1.3, punchAmount + amount);
  },
  update(dt) {
    punchAmount = Math.max(0, punchAmount - dt * 2.6);
    punchPass.uniforms.amount.value = punchAmount;
  },
};

// --- wiring -----------------------------------------------------------------

const hud = new HUD();
const audio = new Audio();
// ?mute=1 forces sound off from the start — for automated/background testing
// (e.g. a browser-driven agent poking at the app) where SFX would otherwise
// play out loud on the developer's machine. resume() still runs normally
// (autoplay-gesture bookkeeping), it just never produces audible output.
if (new URLSearchParams(window.location.search).has('mute')) audio.setEnabled(false);
const input = new Input(renderer.domElement);
const game = new Game({ scene, camera, hud, audio, input });
game.minimap = new Minimap({ game, scene, renderer });
game.postFX = postFX;
const net = new Net();

const menu = new Menu({
  overlay: document.getElementById('overlay'),
  net,
  onStartLocal: ({ teamCount, aiTeams, mapId, gravity, weapons, customMap, realtime, scarcity }) => {
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
      realtime,
      scarcity,
    });
    menu.hide();
  },
  onStartOnline: ({ seed, teamCount, players, mapId, gravity, weapons, customMap, realtime, scarcity }) => {
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
      realtime,
      scarcity,
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
  composer.setSize(window.innerWidth, window.innerHeight);
  composer.setPixelRatio(renderer.getPixelRatio());
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
  postFX.update(dt);
  sky.material.uniforms.time.value = elapsed;

  // Keep the shadow frustum centred on the action.
  sun.target.position.copy(game.rig ? game.rig.target : scene.position);
  sun.position.copy(sun.target.position).add(SUN_OFFSET);
  sun.target.updateMatrixWorld();

  // The full map's 3D mode renders the same scene from a camera orbiting high
  // above the island, in place of the play camera, not alongside it. It
  // bypasses the composer — bloom/SMAA aren't worth the cost on a rarely-open
  // orbit view.
  if (game.minimap.renders3D()) {
    sky.position.copy(game.minimap.camera.position);
    game.minimap.render3D();
  } else {
    sky.position.copy(camera.position);
    composer.render();
  }
}

const SUN_OFFSET = new THREE.Vector3(90, 130, 60);
frame();

// Handy for tinkering from the console.
window.__game = game;
