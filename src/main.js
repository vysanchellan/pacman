import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import {
  LAYERS, ROWS, COLS, canStep, stepCell, canMoveVertical, collectCells, GHOST_HOUSE,
} from "./maze.js";
import { GHOST_DEFS, pickTarget, chooseDirection, bfsDirection } from "./ghosts.js";
import { sfx } from "./audio.js";

// ---------------------------------------------------------------- constants
// bump on every visual change: shown in the HUD so a screenshot always tells
// us which build a player is actually running (stale-cache detector)
const BUILD = "V8 · SILK + SIREN";
const LAYER_H = 2.4; // world height between floors
const FULL_SPEED = 9.5; // arcade "100%" in tiles per second
const FRIGHT_SPEED = FULL_SPEED * 0.5; // frightened ghosts run at 50%, like the arcade
const EYES_SPEED = 14.0;
const EXIT_SPEED = 5.0;
const FRIGHT_BLINK = 2.0;
const PENDING_VERT_TTL = 6.0; // queued floor-change expires after this many seconds

// Arcade-parity difficulty: speeds follow the original game's percentages of
// full speed, so clearing one floor takes as long as clearing an arcade level.
// L1: Pac 80% / ghosts 75%. L2-4: 90% / 85%. L5+: 100% / 95%.
// It's hard from the first level — that's the point.
function levelTuning(level) {
  const pacPct = level === 1 ? 0.8 : level <= 4 ? 0.9 : 1.0;
  const ghostPct = level === 1 ? 0.75 : level <= 4 ? 0.85 : 0.95;
  return {
    pacSpeed: FULL_SPEED * pacPct,
    ghostSpeed: FULL_SPEED * ghostPct,
    frightTime: Math.max(6 - (level - 1), 1),
    releaseDelays: level === 1 ? [0, 1, 3, 5, 10] : [0, 0.5, 1.5, 2.5, 6],
    waves: level === 1
      ? [["scatter", 7], ["chase", 20], ["scatter", 7], ["chase", 20],
         ["scatter", 5], ["chase", 20], ["scatter", 5], ["chase", Infinity]]
      : level <= 4
        ? [["scatter", 5], ["chase", 25], ["scatter", 4], ["chase", 25],
           ["scatter", 3], ["chase", Infinity]]
        : [["scatter", 3], ["chase", 35], ["scatter", 2], ["chase", Infinity]],
  };
}

// Bonus fruits — one per level tier, arcade point values. Like the arcade they
// appear at the center court just below the keep, but the floor is random:
// they spawn at 25% / 50% / 75% of dots eaten and last 12 seconds —
// detouring across floors for them is the risk/reward.
const FRUITS = [
  { name: "CHERRY", color: 0xff3355, points: 100 },
  { name: "STRAWBERRY", color: 0xff5c8a, points: 300 },
  { name: "ORANGE", color: 0xff9933, points: 500 },
  { name: "APPLE", color: 0xdd2222, points: 700 },
  { name: "MELON", color: 0x66dd44, points: 1000 },
  { name: "GALAXIAN", color: 0x4488ff, points: 2000 },
  { name: "BELL", color: 0xffd447, points: 3000 },
  { name: "KEY", color: 0xdddddd, points: 5000 },
];
const FRUIT_LIFETIME = 12;
// the arcade fruit spot: the open court directly below the ghost house,
// centered between the two middle columns (open on every floor)
const FRUIT_SPOT = [17, 13];

// per-floor accent colors: bottom teal, middle blue, top violet
const FLOOR_COLORS = [0x2dd6c8, 0x4d6bff, 0xb36bff];

// glowing eye color per wraith
const IRIS_COLORS = { blinky: 0xff2244, pinky: 0xff66aa, inky: 0x33ddff, clyde: 0xffaa33, wisp: 0x99ffbb };

const OUTLINE_COLOR = 0x140a24;

const cellToWorld = (l, r, c, out = new THREE.Vector3()) =>
  out.set(c - (COLS - 1) / 2, l * LAYER_H, r - (ROWS - 1) / 2);

// ease-in-out used for vertical rides and camera blends
const smooth = (t) => t * t * (3 - 2 * t);

// scratch objects reused by the per-frame hot paths — the update loop should
// allocate nothing
const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _vC = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m4 = new THREE.Matrix4();
const _sph = new THREE.Spherical();
const X_AXIS = new THREE.Vector3(1, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);

// world position of a segment's end; when the segment crosses the tunnel wrap
// the target is rendered one cell past the edge so motion stays smooth
function segmentTarget(cellA, cellB, dir, out) {
  cellToWorld(cellB[0], cellB[1], cellB[2], out);
  if (Math.abs(cellB[2] - cellA[2]) > 1) {
    out.x = cellA[2] - (COLS - 1) / 2 + dir[2];
  }
  return out;
}

// ---------------------------------------------------------------- three.js setup
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
scene.fog = new THREE.Fog(0x000000, 45, 135);

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 300);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setSize(innerWidth, innerHeight);
// 1.5x is visually identical under bloom but ~44% fewer pixels than 2x
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
// filmic response + soft studio reflections give the dark surfaces real sheen
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
document.body.appendChild(renderer.domElement);

{
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.32;
  pmrem.dispose();
}

// soft anime-glow post-processing (threshold high so only true emitters bloom)
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
// half-resolution bloom buffer: the glow is soft anyway, and it's ~4x cheaper
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), 0.5, 0.55, 0.8);
composer.addPass(bloom);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.minDistance = 6;
controls.maxDistance = 55;
controls.maxPolarAngle = Math.PI * 0.49;

scene.add(new THREE.HemisphereLight(0x8f9dff, 0x2a1440, 0.85));
const sun = new THREE.DirectionalLight(0xfff4e0, 1.0);
sun.position.set(8, 20, 6);
scene.add(sun);
// pac lantern: warm but modest, so he reads as a character, not a sun
const pacLight = new THREE.PointLight(0xffb040, 4.5, 7);
scene.add(pacLight);

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

// 3-step gradient for cel (toon) shading
const gradientMap = (() => {
  const data = new Uint8Array([90, 90, 90, 255, 175, 175, 175, 255, 255, 255, 255, 255]);
  const tex = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
})();
const toonMat = (color, opts = {}) =>
  new THREE.MeshToonMaterial({ color, gradientMap, ...opts });

// procedural maps for the castle masonry
const wallMaps = (() => {
  // neon trim: a bright band near the top edge of every block face
  const trim = document.createElement("canvas");
  trim.width = trim.height = 64;
  const tc = trim.getContext("2d");
  tc.fillStyle = "#000";
  tc.fillRect(0, 0, 64, 64);
  tc.fillStyle = "#fff";
  tc.fillRect(0, 6, 64, 5);
  tc.fillStyle = "rgba(255,255,255,0.3)";
  tc.fillRect(0, 55, 64, 3);
  const trimTex = new THREE.CanvasTexture(trim);

  // blocky roughness noise so light breaks up across the stone
  const rough = document.createElement("canvas");
  rough.width = rough.height = 128;
  const rc = rough.getContext("2d");
  for (let y = 0; y < 128; y += 4) {
    for (let x = 0; x < 128; x += 4) {
      const v = 70 + Math.random() * 110;
      rc.fillStyle = `rgb(${v},${v},${v})`;
      rc.fillRect(x, y, 4, 4);
    }
  }
  const roughTex = new THREE.CanvasTexture(rough);

  // glowing tile seams for the polished floor plates
  const grid = document.createElement("canvas");
  grid.width = COLS * 8;
  grid.height = ROWS * 8;
  const gc = grid.getContext("2d");
  gc.fillStyle = "#000";
  gc.fillRect(0, 0, grid.width, grid.height);
  gc.strokeStyle = "rgba(255,255,255,0.55)";
  gc.lineWidth = 1;
  for (let x = 0; x <= COLS; x++) {
    gc.beginPath(); gc.moveTo(x * 8 + 0.5, 0); gc.lineTo(x * 8 + 0.5, grid.height); gc.stroke();
  }
  for (let y = 0; y <= ROWS; y++) {
    gc.beginPath(); gc.moveTo(0, y * 8 + 0.5); gc.lineTo(grid.width, y * 8 + 0.5); gc.stroke();
  }
  const gridTex = new THREE.CanvasTexture(grid);
  return { trimTex, roughTex, gridTex };
})();

// ---------------------------------------------------------------- backdrop
// classic arcade black, with a slowly drifting field of tiny white stars —
// the maze is where all the color lives
const starField = (() => {
  const COUNT = 900;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(COUNT * 3);
  for (let i = 0; i < COUNT; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(90 + Math.random() * 80);
    pos.set([v.x, v.y, v.z], i * 3);
  }
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const points = new THREE.Points(geo, new THREE.PointsMaterial({
    color: 0xffffff, size: 0.22, transparent: true, opacity: 0.85,
    sizeAttenuation: true, fog: false, depthWrite: false,
  }));
  scene.add(points);
  return points;
})();

// dust motes drifting slowly through the castle air
const motes = (() => {
  const COUNT = 180;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(COUNT * 3);
  for (let i = 0; i < COUNT; i++) {
    pos.set([
      (Math.random() - 0.5) * 30,
      Math.random() * 7 - 0.5,
      (Math.random() - 0.5) * 33,
    ], i * 3);
  }
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const points = new THREE.Points(geo, new THREE.PointsMaterial({
    color: 0xb9a8ff, size: 0.055, transparent: true, opacity: 0.5,
    sizeAttenuation: true, depthWrite: false,
  }));
  scene.add(points);
  return points;
})();

// soft violet halo the castle floats on
{
  const cv = document.createElement("canvas");
  cv.width = cv.height = 256;
  const ctx = cv.getContext("2d");
  const rg = ctx.createRadialGradient(128, 128, 20, 128, 128, 128);
  rg.addColorStop(0, "rgba(120,70,220,0.5)");
  rg.addColorStop(0.6, "rgba(80,40,170,0.18)");
  rg.addColorStop(1, "rgba(60,30,140,0)");
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, 256, 256);
  const halo = new THREE.Mesh(
    new THREE.CircleGeometry(27, 40),
    new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(cv), transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    })
  );
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = -1.58;
  scene.add(halo);
}

// aurora ribbons: three luminous bands orbiting the castle at different
// tilts and speeds — pure additive light, almost free to draw
const ribbons = [];
{
  const defs = [
    { radius: 24, y: 2.5, tilt: 0.10, color: 0x33ddff, speed: 0.05 },
    { radius: 28, y: 4.5, tilt: -0.14, color: 0xb36bff, speed: -0.035 },
    { radius: 33, y: 1.0, tilt: 0.05, color: 0xffd447, speed: 0.022 },
  ];
  for (const d of defs) {
    const pts = [];
    for (let i = 0; i <= 90; i++) {
      const a = (i / 90) * Math.PI * 2;
      pts.push(new THREE.Vector3(
        Math.cos(a) * d.radius,
        Math.sin(a * 3) * 0.9,
        Math.sin(a) * d.radius
      ));
    }
    const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 140, 0.055, 5, true);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: d.color, transparent: true, opacity: 0.32,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }));
    mesh.position.y = d.y;
    mesh.rotation.x = d.tilt;
    scene.add(mesh);
    ribbons.push({ mesh, speed: d.speed, baseY: d.y, bob: Math.random() * Math.PI * 2 });
  }
}

// arcane containment field: a vast, slowly turning hexagonal energy shell
// around the whole castle
const hexDome = (() => {
  const cv = document.createElement("canvas");
  cv.width = 256;
  cv.height = 224;
  const ctx = cv.getContext("2d");
  ctx.strokeStyle = "rgba(140, 210, 255, 0.85)";
  ctx.lineWidth = 1.5;
  const s = 32; // hex size
  const h = s * Math.sqrt(3) / 2;
  for (let row = -1; row < 5; row++) {
    for (let col = -1; col < 5; col++) {
      const cx = col * s * 3 + (row % 2 ? s * 1.5 : 0);
      const cy = row * h;
      ctx.beginPath();
      for (let i = 0; i <= 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const x = cx + Math.cos(a) * s;
        const y = cy + Math.sin(a) * s;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(10, 5);
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(44, 32, 20),
    new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: 0.05, side: THREE.BackSide,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    })
  );
  dome.position.y = 2;
  scene.add(dome);
  return dome;
})();

// shooting stars streaking across the black
const comets = [];
{
  const cv = document.createElement("canvas");
  cv.width = 64;
  cv.height = 8;
  const ctx = cv.getContext("2d");
  const grad = ctx.createLinearGradient(0, 0, 64, 0);
  grad.addColorStop(0, "rgba(255,255,255,0)");
  grad.addColorStop(0.75, "rgba(255,255,255,0.9)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 8);
  const tex = new THREE.CanvasTexture(cv);
  for (let i = 0; i < 2; i++) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }));
    sprite.scale.set(6, 0.5, 1);
    scene.add(sprite);
    comets.push({ sprite, vel: new THREE.Vector3(), life: 0, wait: 2 + i * 5 });
  }
}

function updateSky(dt) {
  for (const r of ribbons) {
    r.mesh.rotation.y += r.speed * dt;
    r.mesh.position.y = r.baseY + Math.sin(state.elapsed * 0.4 + r.bob) * 0.5;
  }
  hexDome.rotation.y += dt * 0.012;
  hexDome.material.opacity = 0.045 + 0.02 * Math.sin(state.elapsed * 0.9);

  for (const c of comets) {
    if (c.life <= 0) {
      c.wait -= dt;
      if (c.wait <= 0) {
        // launch from a random point high in the sky
        const a = Math.random() * Math.PI * 2;
        c.sprite.position.set(Math.cos(a) * 70, 25 + Math.random() * 25, Math.sin(a) * 70);
        c.vel.set(-Math.cos(a) * 30 + (Math.random() - 0.5) * 14, -6 - Math.random() * 6,
          -Math.sin(a) * 30 + (Math.random() - 0.5) * 14);
        c.sprite.material.rotation = Math.atan2(-c.vel.y, Math.hypot(c.vel.x, c.vel.z));
        c.life = 2.2;
        c.wait = 4 + Math.random() * 8;
      }
      continue;
    }
    c.life -= dt;
    c.sprite.position.addScaledVector(c.vel, dt);
    c.sprite.material.opacity = Math.min(1, c.life) * 0.8;
    if (c.life <= 0) c.sprite.material.opacity = 0;
  }
}

// ---------------------------------------------------------------- castle visuals
const mazeData = collectCells();
const wallFillMats = []; // solid fill per floor
const wallEdgeMats = []; // glowing wireframe per floor
const wallCapMats = []; // neon cornice caps per floor
const floorPlateMats = [];
const towerMats = []; // corner towers per floor
const towerGlowMats = []; // tower light rings / finials per floor
const floorMeshRefs = []; // per-floor meshes, so invisible floors skip rendering

{
  // rounded battlement blocks instead of raw cubes
  const wallGeo = new RoundedBoxGeometry(1, 1.0, 1, 3, 0.14);
  const edgeTemplate = new THREE.EdgesGeometry(new THREE.BoxGeometry(0.98, 0.98, 0.98));
  const v = new THREE.Vector3();

  for (let l = 0; l < LAYERS; l++) {
    const color = FLOOR_COLORS[l];
    const cellsHere = mazeData.walls.filter(([wl]) => wl === l);

    // obsidian masonry: near-black glossy stone with a neon trim band —
    // realistic sheen from the environment, vibrancy from the emissive trim
    const fillMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color).multiplyScalar(0.22),
      metalness: 0.78, roughness: 0.42, roughnessMap: wallMaps.roughTex,
      emissive: color, emissiveMap: wallMaps.trimTex, emissiveIntensity: 1.3,
      transparent: true, opacity: 0.94, depthWrite: false,
    });
    wallFillMats.push(fillMat);
    const inst = new THREE.InstancedMesh(wallGeo, fillMat, cellsHere.length);
    const m = new THREE.Matrix4();
    cellsHere.forEach(([wl, r, c], i) => {
      cellToWorld(wl, r, c, v);
      m.makeTranslation(v.x, v.y, v.z);
      inst.setMatrixAt(i, m);
    });
    inst.renderOrder = 1;
    scene.add(inst);

    // cornice caps: a slim glowing lid on every block, like inlaid neon piping
    const capMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color).multiplyScalar(0.5),
      emissive: color, emissiveIntensity: 0.75,
      metalness: 0.7, roughness: 0.3,
      transparent: true, opacity: 0.95, depthWrite: false,
    });
    wallCapMats.push(capMat);
    const capGeo = new THREE.BoxGeometry(1.04, 0.07, 1.04);
    const caps = new THREE.InstancedMesh(capGeo, capMat, cellsHere.length);
    cellsHere.forEach(([wl, r, c], i) => {
      cellToWorld(wl, r, c, v);
      m.makeTranslation(v.x, v.y + 0.52, v.z);
      caps.setMatrixAt(i, m);
    });
    caps.renderOrder = 1;
    scene.add(caps);

    // merged wireframe of every wall block on this floor: stays readable
    // even when the floor's solid fill is faded out
    const src = edgeTemplate.attributes.position;
    const positions = new Float32Array(src.count * 3 * cellsHere.length);
    cellsHere.forEach(([wl, r, c], i) => {
      cellToWorld(wl, r, c, v);
      for (let j = 0; j < src.count; j++) {
        const o = (i * src.count + j) * 3;
        positions[o] = src.getX(j) + v.x;
        positions[o + 1] = src.getY(j) + v.y;
        positions[o + 2] = src.getZ(j) + v.z;
      }
    });
    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const edgeMat = new THREE.LineBasicMaterial({
      color, transparent: true, opacity: 1.0, depthWrite: false,
    });
    wallEdgeMats.push(edgeMat);
    const lines = new THREE.LineSegments(edgeGeo, edgeMat);
    lines.renderOrder = 2;
    scene.add(lines);

    // polished floor: dark marble sheen with glowing tile seams
    const plateMat = new THREE.MeshStandardMaterial({
      color: 0x08080e, metalness: 0.9, roughness: 0.3,
      emissive: color, emissiveMap: wallMaps.gridTex, emissiveIntensity: 0.35,
      transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false,
    });
    floorPlateMats.push(plateMat);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(COLS, ROWS), plateMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = l * LAYER_H - 0.55;
    scene.add(floor);

    floorMeshRefs.push({ fill: inst, caps, lines, plate: floor });

    // ornate watchtowers: stone base, fluted barrel, glowing light rings,
    // dark spired roof with a gold finial
    const towerMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color).multiplyScalar(0.3),
      metalness: 0.8, roughness: 0.38, roughnessMap: wallMaps.roughTex,
      emissive: color, emissiveIntensity: 0.12,
      transparent: true, opacity: 0.95, depthWrite: false,
    });
    towerMats.push(towerMat);
    const glowMat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    towerGlowMats.push(glowMat);
    const goldMat = new THREE.MeshStandardMaterial({
      color: 0xffd447, metalness: 1.0, roughness: 0.25,
      emissive: 0xffd447, emissiveIntensity: 0.5,
      transparent: true, opacity: 0.95, depthWrite: false,
    });
    towerGlowMats.push(goldMat);
    // all four towers merged into one draw call per material (was 28 meshes
    // per floor — geometry is static, so bake the transforms in)
    const hx = (COLS - 1) / 2 + 0.7;
    const hz = (ROWS - 1) / 2 + 0.7;
    const stoneGeos = [];
    const goldGeos = [];
    const ringGeos = [];
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const tx = sx * hx;
        const ty = l * LAYER_H - 0.2;
        const tz = sz * hz;
        const at = (geo, y, rx = 0) => {
          if (rx) geo.rotateX(rx);
          geo.translate(tx, ty + y, tz);
          return geo;
        };
        stoneGeos.push(
          at(new THREE.CylinderGeometry(0.74, 0.88, 0.5, 12), 0),
          at(new THREE.CylinderGeometry(0.5, 0.64, 1.7, 14), 1.0),
          at(new THREE.ConeGeometry(0.85, 1.05, 12), 2.3));
        goldGeos.push(
          at(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 6), 3.0),
          at(new THREE.SphereGeometry(0.09, 10, 8), 3.28));
        for (const ry of [0.55, 1.5]) {
          ringGeos.push(at(new THREE.TorusGeometry(0.6, 0.022, 8, 24), ry, Math.PI / 2));
        }
      }
    }
    scene.add(new THREE.Mesh(mergeGeometries(stoneGeos), towerMat));
    scene.add(new THREE.Mesh(mergeGeometries(goldGeos), goldMat));
    scene.add(new THREE.Mesh(mergeGeometries(ringGeos), glowMat));
  }
}

// vertical shaft beams — ALL idle beams are one merged mesh (was 22 draws);
// two reusable highlight beams glow at whatever shaft Pac-Man can use.
// Elevator rings: every ring of the same animation phase shares one merged
// mesh whose whole geometry rides up together (44 draws → 2).
const shaftHighlights = []; // [upBeam, downBeam] repositioned on demand
const shaftRingPhases = []; // { mesh, mat, phase }
{
  const beamGeoAt = (low, r, c) => {
    const geo = new THREE.CylinderGeometry(0.34, 0.34, LAYER_H, 12, 1, true);
    const v = cellToWorld(low, r, c, new THREE.Vector3());
    geo.translate(v.x, v.y + LAYER_H / 2, v.z);
    return geo;
  };
  const beamGeos = [];
  const ringGeosByPhase = [[], []];
  const seen = new Set();
  for (const [l, r, c] of mazeData.shafts) {
    for (const low of [l - 1, l]) {
      const key = `${low},${r},${c}`;
      if (low < 0 || seen.has(key)) continue;
      if (!canMoveVertical(low, low + 1, r, c)) continue;
      seen.add(key);
      beamGeos.push(beamGeoAt(low, r, c));
      const v = cellToWorld(low, r, c, new THREE.Vector3());
      for (let k = 0; k < 2; k++) {
        const ring = new THREE.TorusGeometry(0.3, 0.022, 6, 16);
        ring.rotateX(Math.PI / 2);
        ring.translate(v.x, low * LAYER_H, v.z);
        ringGeosByPhase[k].push(ring);
      }
    }
  }
  const idleBeams = new THREE.Mesh(mergeGeometries(beamGeos), new THREE.MeshBasicMaterial({
    color: 0x4dffdf, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide,
  }));
  idleBeams.renderOrder = 3;
  scene.add(idleBeams);

  for (let k = 0; k < 2; k++) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0x4dffdf, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const mesh = new THREE.Mesh(mergeGeometries(ringGeosByPhase[k]), mat);
    mesh.renderOrder = 4;
    scene.add(mesh);
    shaftRingPhases.push({ mesh, mat, phase: k / 2 });
  }

  for (let i = 0; i < 2; i++) {
    const hl = new THREE.Mesh(
      new THREE.CylinderGeometry(0.34, 0.34, LAYER_H, 12, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x4dffdf, transparent: true, opacity: 0.4,
        depthWrite: false, side: THREE.DoubleSide,
      }));
    hl.renderOrder = 3;
    hl.visible = false;
    scene.add(hl);
    shaftHighlights.push(hl);
  }

  // ghost house door
  const [dl, dr, dc] = GHOST_HOUSE.door;
  const door = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 0.25, 0.9),
    new THREE.MeshBasicMaterial({ color: 0xffb8de, transparent: true, opacity: 0.8 })
  );
  cellToWorld(dl, dr, dc, door.position);
  scene.add(door);
}

// pellets — one material per floor so off-floor dots can fade
const pelletGeo = new THREE.SphereGeometry(0.09, 10, 8);
const powerGeo = new THREE.SphereGeometry(0.24, 14, 12);
const pelletMatByFloor = [];
const powerMatByFloor = [];
for (let l = 0; l < LAYERS; l++) {
  pelletMatByFloor.push(new THREE.MeshStandardMaterial({
    color: 0xffe2b8, emissive: 0xffb060, emissiveIntensity: 0.7, transparent: true,
  }));
  powerMatByFloor.push(new THREE.MeshStandardMaterial({
    color: 0xffe2b8, emissive: 0xff9040, emissiveIntensity: 1.2, transparent: true,
  }));
}
const pelletKey = (l, r, c) => `${l},${r},${c}`;
// ~800 pellets: instanced per floor (one draw call each); eating zero-scales
const pelletsByFloor = [[], [], []];
for (const cell of mazeData.pellets) pelletsByFloor[cell[0]].push(cell);
const pelletInst = pelletsByFloor.map((list, l) => {
  const inst = new THREE.InstancedMesh(pelletGeo, pelletMatByFloor[l], list.length);
  scene.add(inst);
  return inst;
});
const ZERO_M = new THREE.Matrix4().makeScale(0, 0, 0);
const pelletMeshes = new Map(); // key -> { power:false, floor, index } | { power:true, mesh }
const powerMeshes = [];

function spawnPellets() {
  pelletMeshes.clear();
  state.dotsPerFloor = [0, 0, 0];
  const m = new THREE.Matrix4();
  const v = new THREE.Vector3();
  pelletsByFloor.forEach((list, l) => {
    list.forEach(([ll, r, c], i) => {
      cellToWorld(ll, r, c, v);
      m.makeTranslation(v.x, v.y, v.z);
      pelletInst[l].setMatrixAt(i, m);
      pelletMeshes.set(pelletKey(ll, r, c), { power: false, floor: l, index: i });
      state.dotsPerFloor[l]++;
    });
    pelletInst[l].instanceMatrix.needsUpdate = true;
  });
  for (const mesh of powerMeshes) scene.remove(mesh);
  powerMeshes.length = 0;
  for (const [l, r, c] of mazeData.powerPellets) {
    const mesh = new THREE.Mesh(powerGeo, powerMatByFloor[l]);
    cellToWorld(l, r, c, mesh.position);
    scene.add(mesh);
    pelletMeshes.set(pelletKey(l, r, c), { power: true, mesh });
    powerMeshes.push(mesh);
    state.dotsPerFloor[l]++;
  }
}

// ---------------------------------------------------------------- fruit
function armFruit() {
  state.totalDots = pelletMeshes.size;
  state.fruitAt = [0.25, 0.5, 0.75].map((f) => Math.round(state.totalDots * f));
  state.fruitSpawned = 0;
  clearFruit();
}

function clearFruit() {
  if (state.fruit) {
    scene.remove(state.fruit.group);
    state.fruit = null;
  }
  document.getElementById("fruit-chip").classList.remove("on");
}

function spawnFruit() {
  clearFruit();
  state.fruitSpawned++;
  const def = FRUITS[Math.min(state.level - 1, FRUITS.length - 1)];
  const floor = Math.floor(Math.random() * LAYERS);
  const cell = [floor, FRUIT_SPOT[0], FRUIT_SPOT[1]];

  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 12),
    new THREE.MeshStandardMaterial({ color: def.color, emissive: def.color, emissiveIntensity: 0.7 }));
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.18, 6),
    new THREE.MeshBasicMaterial({ color: 0x2d7a2d }));
  stem.position.y = 0.36;
  // gold beacon so the detour reads from any floor
  const beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.4, 8),
    new THREE.MeshBasicMaterial({
      color: 0xffd447, transparent: true, opacity: 0.5,
      depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
  beacon.position.y = 1.1;
  beacon.renderOrder = 30;
  group.add(body, stem, beacon);
  cellToWorld(cell[0], cell[1], cell[2], group.position);
  group.position.x += 0.5; // sit dead-center between the two middle columns
  group.position.y += 0.1;
  scene.add(group);

  state.fruit = { def, cell, timer: FRUIT_LIFETIME, group };
  const hex = `#${def.color.toString(16).padStart(6, "0")}`;
  $("fruit-label").textContent = `${def.name} · FLOOR ${cell[0] + 1} · ${def.points} PTS`;
  const icon = $("fruit-icon");
  icon.style.background = hex;
  icon.style.color = hex;
  $("fruit-chip").classList.add("on");
  toast(`${def.name} ON FLOOR ${cell[0] + 1} — ${def.points} PTS`);
  sfx.fruit();
}

function updateFruit(dt) {
  const f = state.fruit;
  if (!f) return;
  f.timer -= dt;
  f.group.rotation.y += dt * 2;
  f.group.scale.setScalar(1 + Math.sin(state.elapsed * 5) * 0.12);
  $("fruit-bar").style.width = `${Math.max(0, (f.timer / FRUIT_LIFETIME) * 100)}%`;
  if (f.timer <= 0) {
    clearFruit();
    return;
  }
  if (state.phase === "playing" && pac.pos.distanceTo(f.group.position) < 0.75) {
    addScore(f.def.points);
    popup(`+${f.def.points}`, f.group.position, "#ffd447");
    sfx.fruitCollect();
    updateHud();
    clearFruit();
  }
}

// ---------------------------------------------------------------- pac-man visual
// oni-style hunter: deep-gold chomping demon with horns, fierce glowing
// slit eyes and an ember trail — mouth still opens along +X for aiming
const PAC_R = 0.42;
const mouthGeos = [];
for (let i = 0; i < 7; i++) {
  const mouth = (i / 6) * 0.9; // radians of half-mouth opening
  const g = new THREE.SphereGeometry(PAC_R, 28, 20, mouth, Math.PI * 2 - 2 * mouth);
  g.rotateZ(Math.PI / 2);
  mouthGeos.push(g);
}
const pacGroup = new THREE.Group();
const pacBody = new THREE.Mesh(mouthGeos[3],
  toonMat(0xffb818, { emissive: 0x452a00, emissiveIntensity: 0.35 }));
const pacOutline = new THREE.Mesh(
  mouthGeos[3],
  new THREE.MeshBasicMaterial({ color: OUTLINE_COLOR, side: THREE.BackSide })
);
pacOutline.scale.setScalar(1.07);
// dark maw inside the mouth so the chomp reads as a real bite
const maw = new THREE.Mesh(new THREE.SphereGeometry(0.36, 20, 14),
  toonMat(0x4a0d12));
pacGroup.add(pacBody, pacOutline, maw);

// soft warm aura behind him
{
  const aCanvas = document.createElement("canvas");
  aCanvas.width = aCanvas.height = 128;
  const actx = aCanvas.getContext("2d");
  const ag = actx.createRadialGradient(64, 64, 6, 64, 64, 64);
  ag.addColorStop(0, "rgba(255,190,60,0.5)");
  ag.addColorStop(0.5, "rgba(255,140,40,0.18)");
  ag.addColorStop(1, "rgba(255,120,30,0)");
  actx.fillStyle = ag;
  actx.fillRect(0, 0, 128, 128);
  const aura = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(aCanvas), transparent: true,
    depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  aura.scale.setScalar(1.9);
  pacGroup.add(aura);
}

// horns
for (const side of [-1, 1]) {
  const horn = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.24, 10), toonMat(0x3a1c08));
  horn.position.set(0.02, 0.4, side * 0.15);
  horn.rotation.x = side * -0.45;
  pacGroup.add(horn);

  // angry brow ridge over each eye
  const brow = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.035, 0.16), toonMat(0x3a1c08));
  brow.position.set(0.28, 0.33, side * 0.15);
  brow.rotation.x = side * 0.55;
  pacGroup.add(brow);

  // fierce glowing eye + black slit pupil
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.085, 12, 10),
    new THREE.MeshBasicMaterial({ color: 0xffc84d }));
  eye.position.set(0.27, 0.22, side * 0.16);
  eye.scale.set(0.5, 1.35, 0.85);
  eye.rotation.x = side * 0.5; // angry inward slant
  const slit = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.11, 0.035),
    new THREE.MeshBasicMaterial({ color: 0x1a0d00 }));
  slit.position.set(0.335, 0.22, side * 0.16);
  slit.rotation.x = side * 0.5;
  pacGroup.add(eye, slit);
}
scene.add(pacGroup);

// ember trail behind pac
const TRAIL = 24;
const trailGeo = new THREE.BufferGeometry();
const trailPos = new Float32Array(TRAIL * 3);
const trailCol = new Float32Array(TRAIL * 3);
for (let i = 0; i < TRAIL; i++) {
  const f = 1 - i / TRAIL;
  trailCol.set([1.0 * f, 0.55 * f * f, 0.08 * f * f], i * 3);
}
trailGeo.setAttribute("position", new THREE.BufferAttribute(trailPos, 3));
trailGeo.setAttribute("color", new THREE.BufferAttribute(trailCol, 3));
const trailMat = new THREE.PointsMaterial({
  size: 0.16, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false,
});
scene.add(new THREE.Points(trailGeo, trailMat));

function updateTrail() {
  const p = trailGeo.attributes.position;
  for (let i = TRAIL - 1; i > 0; i--) {
    p.setXYZ(i, p.getX(i - 1), p.getY(i - 1), p.getZ(i - 1));
  }
  p.setXYZ(0,
    pac.pos.x + (Math.random() - 0.5) * 0.08,
    pac.pos.y + (Math.random() - 0.5) * 0.08,
    pac.pos.z + (Math.random() - 0.5) * 0.08);
  p.needsUpdate = true;
  trailMat.opacity = pac.moving ? 0.85 : 0;
}

// ---------------------------------------------------------------- ghost visuals
// Neon-arcade wraiths. Classic silhouette (dome + torso + zig-zag hem) built
// ONLY from primitives that provably render on every GPU we've seen — the
// old sculpted-lathe cloak drew as a black shell on some hardware. Design
// layers: flat classic-color body, darker under-shade band + alternating hem,
// additive glow shell + hem ring, tinted aura sprite, white arcade eyes with
// glowing pupils under angry brows. Signature traits:
//   blinky — oni horns   pinky — head bow + ribbons
//   inky — kitsune mask  clyde — hulking shoulders   wisp — spirit flame
const ghostAuraTex = (() => {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 128;
  const ctx = cv.getContext("2d");
  const rg = ctx.createRadialGradient(64, 64, 8, 64, 64, 64);
  rg.addColorStop(0, "rgba(255,255,255,0.65)");
  rg.addColorStop(0.45, "rgba(255,255,255,0.22)");
  rg.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(cv);
})();

function makeGhostMesh(color, name) {
  const group = new THREE.Group();
  const shadeHex = new THREE.Color(color).multiplyScalar(0.55).getHex();

  const bodyMat = new THREE.MeshBasicMaterial({ color });
  const shadeMat = new THREE.MeshBasicMaterial({ color: shadeHex });
  const glowMat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.28,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });

  const body = new THREE.Group();
  // bake transforms into merged geometry: one draw call per material instead
  // of ~28 meshes per wraith (smoothness rule)
  const xf = (geo, x, y, z, rx = 0, rz = 0) => {
    if (rx) geo.rotateX(rx);
    if (rz) geo.rotateZ(rz);
    geo.translate(x, y, z);
    return geo;
  };
  const bodyGeos = [
    xf(new THREE.SphereGeometry(0.36, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2), 0, 0.18, 0),
    xf(new THREE.CylinderGeometry(0.36, 0.41, 0.48, 24), 0, -0.06, 0),
  ];
  // darker under-skirt band: cheap two-tone depth
  const shadeGeos = [xf(new THREE.CylinderGeometry(0.415, 0.44, 0.15, 24), 0, -0.29, 0)];
  // zig-zag hem: alternating long/short spikes in body/shade tones
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const long = i % 2 === 0;
    (long ? bodyGeos : shadeGeos).push(
      xf(new THREE.ConeGeometry(long ? 0.12 : 0.09, long ? 0.22 : 0.15, 6),
        Math.cos(a) * 0.32, long ? -0.4 : -0.38, Math.sin(a) * 0.32, Math.PI));
  }
  // additive neon shell over the dome + glow ring at the hem
  const glowGeos = [
    xf(new THREE.SphereGeometry(0.43, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.62), 0, 0.14, 0),
    xf(new THREE.TorusGeometry(0.43, 0.028, 8, 24), 0, -0.36, 0, Math.PI / 2),
  ];
  body.add(
    new THREE.Mesh(mergeGeometries(bodyGeos), bodyMat),
    new THREE.Mesh(mergeGeometries(shadeGeos), shadeMat),
    new THREE.Mesh(mergeGeometries(glowGeos), glowMat));
  // soft tinted aura so each wraith reads as a colored lantern from afar
  const auraMat = new THREE.SpriteMaterial({
    map: ghostAuraTex, color, transparent: true, opacity: 0.5,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const aura = new THREE.Sprite(auraMat);
  aura.scale.setScalar(1.9);
  aura.position.y = 0.05;
  body.add(aura);
  body.position.y = -0.02;

  const tintMats = [bodyMat];
  const shadeMats = [shadeMat];
  const glowMats = [glowMat, auraMat];

  // signature traits (all unlit — same reliability rule as the body),
  // merged into one draw call per material
  const flat = (c) => new THREE.MeshBasicMaterial({ color: c });
  const addMerged = (geos, mat) => body.add(new THREE.Mesh(mergeGeometries(geos), mat));
  if (name === "blinky") {
    // oni horns: dark blood-red, tipped with gold
    addMerged([-1, 1].map((s) =>
      xf(new THREE.ConeGeometry(0.075, 0.26, 8), s * 0.15, 0.58, 0, 0, s * -0.5)), flat(0x6e1020));
    addMerged([-1, 1].map((s) =>
      xf(new THREE.ConeGeometry(0.03, 0.09, 8), s * 0.21, 0.7, 0, 0, s * -0.5)), flat(0xffd447));
  } else if (name === "pinky") {
    // head bow: two cone loops + a knot, plus her trailing ribbons
    const bowGeos = [];
    for (const s of [-1, 1]) {
      bowGeos.push(
        xf(new THREE.ConeGeometry(0.09, 0.18, 8), s * 0.14, 0.52, -0.06, 0, s * (Math.PI / 2 + 0.25)),
        xf(new THREE.BoxGeometry(0.05, 0.36, 0.02), s * 0.17, 0.34, -0.2, -0.75, s * 0.35));
    }
    addMerged(bowGeos, flat(0xffe1f0));
    addMerged([xf(new THREE.SphereGeometry(0.055, 10, 8), 0, 0.52, -0.06)], flat(0xff8fc8));
  } else if (name === "inky") {
    // kitsune mask with cheek stripes
    const maskGeo = new THREE.SphereGeometry(0.22, 16, 12);
    maskGeo.scale(1.08, 1.3, 0.42);
    addMerged([xf(maskGeo, 0, 0.22, 0.18)], flat(0xf2f4ff));
    addMerged([-1, 1].map((s) =>
      xf(new THREE.BoxGeometry(0.1, 0.03, 0.02), s * 0.14, 0.14, 0.3, 0, s * 0.5)), flat(0x0088cc));
  } else if (name === "clyde") {
    // hulking: broad shoulder pads and extra girth
    addMerged([-1, 1].map((s) => {
      const pad = new THREE.SphereGeometry(0.14, 12, 10);
      pad.scale(1, 0.8, 1);
      return xf(pad, s * 0.34, 0.06, 0);
    }), shadeMat);
    body.scale.set(1.16, 0.95, 1.16);
  } else if (name === "wisp") {
    // layered spirit flame: pale core inside the green tongue
    addMerged([xf(new THREE.ConeGeometry(0.1, 0.32, 8), 0.04, 0.66, 0, 0, -0.35)], flat(0x99ffbb));
    addMerged([xf(new THREE.ConeGeometry(0.05, 0.18, 8), 0.045, 0.62, 0, 0, -0.35)], flat(0xeafff2));
  }
  group.add(body);

  // classic arcade eyes: white ovals + glowing per-ghost pupils under angry
  // brows (the eyes also serve as the disembodied "eyes" state when eaten).
  // Whites, pupils and brows are each one merged mesh.
  const eyes = new THREE.Group();
  const zOff = name === "inky" ? 0.3 : 0.25;
  const oval = (r) => {
    const geo = new THREE.SphereGeometry(r, 12, 10);
    geo.scale(0.75, 1.15, 0.7);
    return geo;
  };
  eyes.add(new THREE.Mesh(
    mergeGeometries([-1, 1].map((s) => xf(oval(0.105), s * 0.145, 0.3, zOff))),
    new THREE.MeshBasicMaterial({ color: 0xffffff })));
  const pupilMat = new THREE.MeshBasicMaterial({ color: IRIS_COLORS[name] });
  const eyeMats = [pupilMat];
  eyes.add(new THREE.Mesh(
    mergeGeometries([-1, 1].map((s) =>
      xf(new THREE.SphereGeometry(0.052, 10, 8), s * 0.145, 0.29, zOff + 0.065))),
    pupilMat));
  addMerged([-1, 1].map((s) =>
    xf(new THREE.BoxGeometry(0.17, 0.045, 0.05), s * 0.15, 0.43, zOff, 0, s * -0.42)),
  flat(new THREE.Color(color).multiplyScalar(0.3).getHex()));
  group.add(eyes);

  // every material in the rig, for whole-ghost fading when it's on another
  // floor — each remembers its own base opacity so glow layers stay subtle
  const fadeMats = [];
  group.traverse((o) => {
    if (o.isMesh || o.isSprite) {
      o.material.transparent = true;
      o.material.userData.baseOp = o.material.opacity;
      fadeMats.push(o.material);
    }
  });
  const baseScale = body.scale.clone();
  return { group, body, tintMats, shadeMats, glowMats, eyeMats, eyes, fadeMats, baseScale };
}

// ---------------------------------------------------------------- entities
function segmentLength(dir) {
  return dir && dir[0] !== 0 ? LAYER_H : 1;
}

const pac = {
  cell: null, dir: [0, 0, 0], desired: null, next: null, t: 0,
  pendingVertical: null, pendingSetAt: 0,
  pos: new THREE.Vector3(), mouthPhase: 0, moving: false,
  lastHorizWorld: null, // last horizontal heading in world space (for camera)
};

const ghosts = GHOST_DEFS.map((def, i) => {
  const vis = makeGhostMesh(def.color, def.name);
  scene.add(vis.group);
  // beacon pillar: always visible through walls so you can spot every wraith
  // and read its floor at a glance
  const beaconMat = new THREE.MeshBasicMaterial({
    color: def.color, transparent: true, opacity: 0.5,
    depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const beacon = new THREE.Group();
  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.5, 8), beaconMat);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.3, 8), beaconMat);
  tip.rotation.x = Math.PI; // point down at the wraith
  tip.position.y = -0.85;
  beacon.add(pillar, tip);
  beacon.renderOrder = 30;
  scene.add(beacon);
  vis.beacon = beacon;
  vis.beaconMat = beaconMat;
  return {
    ...def,
    vis,
    slot: i === 0 ? null : GHOST_HOUSE.inside[i - 1],
    cell: null, dir: null, next: null, t: 0,
    state: "house", // house | exiting | normal | eyes | entering
    frightened: false,
    releaseTimer: 0,
    path: null, // scripted cell path for exiting/entering
    pos: new THREE.Vector3(),
  };
});

// ---------------------------------------------------------------- game state
const state = {
  phase: "menu", // menu | ready | playing | dying | gameover
  phaseTimer: 0,
  score: 0,
  high: Number(localStorage.getItem("pacman3d-high") || 0),
  lives: 2, // remaining spare lives
  level: 1,
  tuning: levelTuning(1),
  pelletsLeft: 0,
  totalDots: 0,
  dotsPerFloor: [0, 0, 0],
  paused: false,
  fruit: null, // { def, cell, timer, group }
  fruitAt: [],
  fruitSpawned: 0,
  waveIndex: 0,
  waveTimer: 0,
  frightTimer: 0,
  frightMax: 8,
  eatChain: 0,
  elapsed: 0,
};

const $ = (id) => document.getElementById(id);
function setMessage(main, sub = "") {
  $("message").innerHTML = main
    ? `${main}${sub ? `<span class="sub">${sub}</span>` : ""}`
    : "";
}
function updateHud() {
  $("score").textContent = state.score;
  $("highscore").textContent = state.high;
  $("level").textContent = state.level;
  $("lives").innerHTML = "&#9679;".repeat(Math.max(0, state.lives)) || "&mdash;";
}
function addScore(n) {
  state.score += n;
  if (state.score > state.high) {
    state.high = state.score;
    localStorage.setItem("pacman3d-high", String(state.high));
  }
}

// ambient bed follows the game state: calm drone while playing, tension
// wobble while the wraiths are frightened, silence everywhere else
function syncMood() {
  if (state.paused || state.phase !== "playing") sfx.mood("off");
  else sfx.mood(state.frightTimer > 0 ? "fright" : "calm");
}

let toastTimer = null;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("on"), 1300);
}

// floating score popup at a world position
function popup(text, worldPos, color = "#66ccff") {
  const v = worldPos.clone().project(camera);
  if (v.z > 1) return;
  const el = document.createElement("div");
  el.className = "popup";
  el.textContent = text;
  el.style.left = `${(v.x * 0.5 + 0.5) * innerWidth}px`;
  el.style.top = `${(-v.y * 0.5 + 0.5) * innerHeight}px`;
  el.style.color = color;
  $("popups").appendChild(el);
  setTimeout(() => el.remove(), 950);
}

// ---------------------------------------------------------------- floor stack widget
const floorStackEl = $("floor-stack");
let floorStackSig = "";

function updateFloorStack() {
  const pl = pac.cell ? pac.cell[0] : 1;
  const ghostFloors = ghosts.map((g) =>
    g.state === "house" || g.state === "entering" ? -1 : g.cell[0]);
  const sig = `${pl}|${ghostFloors.join(",")}|${state.dotsPerFloor.join(",")}`;
  if (sig === floorStackSig) return;
  floorStackSig = sig;

  let html = `<div class="fs-title">FLOORS &middot; DOTS</div>`;
  for (let l = LAYERS - 1; l >= 0; l--) {
    const dots = [`${pl === l ? '<span class="dot pac"></span>' : ""}`];
    ghosts.forEach((g, i) => {
      if (ghostFloors[i] === l) {
        const col = `#${g.color.toString(16).padStart(6, "0")}`;
        dots.push(`<span class="dot" style="background:${col};box-shadow:0 0 5px ${col}"></span>`);
      }
    });
    const left = state.dotsPerFloor[l];
    html += `<div class="floor-row${pl === l ? " active" : ""}${left === 0 ? " cleared" : ""}">
      <span class="fl">${l + 1}</span>${dots.join("")}
      <span class="fd">${left === 0 ? "&#10003;" : left}</span></div>`;
  }
  floorStackEl.innerHTML = html;
}

// ---------------------------------------------------------------- minimap
// live map of the floor you're on: walls + shafts prerendered per floor,
// then just you, the wraiths sharing your floor, and any fruit
const MM_S = 5;
const miniCanvas = $("minimap");
miniCanvas.width = COLS * MM_S;
miniCanvas.height = ROWS * MM_S;
const mmCtx = miniCanvas.getContext("2d");

const mmWallLayers = FLOOR_COLORS.map((color, l) => {
  const cv = document.createElement("canvas");
  cv.width = miniCanvas.width;
  cv.height = miniCanvas.height;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "rgba(4,4,8,0.9)";
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = `#${new THREE.Color(color).multiplyScalar(0.8).getHexString()}`;
  for (const [wl, r, c] of mazeData.walls) {
    if (wl === l) ctx.fillRect(c * MM_S, r * MM_S, MM_S, MM_S);
  }
  ctx.fillStyle = "#4dffdf";
  for (const [sl, r, c] of mazeData.shafts) {
    if (sl === l) ctx.fillRect(c * MM_S + 1, r * MM_S + 1, MM_S - 2, MM_S - 2);
  }
  if (l === 1) {
    const [, dr, dc] = GHOST_HOUSE.door;
    ctx.fillStyle = "#ffb8de";
    ctx.fillRect(dc * MM_S, dr * MM_S, MM_S, MM_S);
  }
  return cv;
});

function mmDot(x, z, color, rad) {
  const px = (x + (COLS - 1) / 2 + 0.5) * MM_S;
  const py = (z + (ROWS - 1) / 2 + 0.5) * MM_S;
  mmCtx.fillStyle = color;
  mmCtx.beginPath();
  mmCtx.arc(px, py, rad, 0, Math.PI * 2);
  mmCtx.fill();
}

function updateMinimap() {
  const fl = pac.cell ? pac.cell[0] : 1;
  mmCtx.clearRect(0, 0, miniCanvas.width, miniCanvas.height);
  mmCtx.drawImage(mmWallLayers[fl], 0, 0);
  if (state.fruit && state.fruit.cell[0] === fl) {
    mmDot(state.fruit.group.position.x, state.fruit.group.position.z, "#ffd447", 3.2);
  }
  for (const g of ghosts) {
    if (g.cell[0] !== fl) continue; // this floor only
    const isEyes = g.state === "eyes" || g.state === "entering";
    const color = isEyes ? "rgba(255,255,255,0.45)"
      : g.frightened ? "#3355ff"
        : `#${g.color.toString(16).padStart(6, "0")}`;
    mmDot(g.pos.x, g.pos.z, color, 3);
  }
  mmDot(pac.pos.x, pac.pos.z, "#ffe000", 3.6);
}

function resetPositions() {
  clearFruit();
  pac.cell = [...mazeData.pacmanSpawn];
  pac.dir = [0, 0, 0];
  pac.desired = null;
  pac.pendingVertical = null;
  pac.next = null;
  pac.t = 0;
  pac.moving = false;
  cellToWorld(...pac.cell, pac.pos);

  ghosts.forEach((g, i) => {
    g.frightened = false;
    g.path = null;
    g.next = null;
    g.t = 0;
    if (i === 0) {
      g.state = "normal";
      g.cell = [...GHOST_HOUSE.outside];
      g.dir = [0, 0, 1];
    } else {
      g.state = "house";
      g.cell = [...g.slot];
      g.dir = null;
      g.releaseTimer = state.tuning.releaseDelays[i];
    }
    cellToWorld(...g.cell, g.pos);
  });

  state.waveIndex = 0;
  state.waveTimer = 0;
  state.frightTimer = 0;
  state.eatChain = 0;
}

function newGame() {
  state.score = 0;
  state.lives = 2;
  state.level = 1;
  state.tuning = levelTuning(1);
  spawnPellets();
  state.pelletsLeft = pelletMeshes.size;
  armFruit();
  resetPositions();
  state.phase = "ready";
  state.phaseTimer = 2.2;
  setMessage("READY!");
  sfx.start();
  syncMood();
  updateHud();
}

// ---------------------------------------------------------------- input
// Horizontal steering and floor changes are tracked separately, so holding an
// arrow key (with OS auto-repeat) can never stomp on a queued up/down press.
function queueVertical(dl) {
  pac.pendingVertical = [dl, 0, 0];
  pac.pendingSetAt = state.elapsed;
}

addEventListener("keydown", (e) => {
  sfx.unlock();
  // stop page scroll / focused-button activation before anything else
  if (e.code === "Space" || e.code === "PageUp" || e.code === "PageDown") e.preventDefault();
  if (e.repeat) return; // ignore OS key auto-repeat entirely

  if (e.code === "Escape") {
    if (state.paused) toggleInfo(false);
    return;
  }
  if (e.code === "KeyI") {
    toggleInfo();
    return;
  }
  if (e.code === "KeyP") {
    if (!$("info-modal").classList.contains("on") && state.phase === "playing") togglePause();
    return;
  }
  if (state.paused) return; // rules panel open: game input is frozen

  if (e.code === "Enter") {
    if (state.phase === "menu" || state.phase === "gameover") {
      newGame();
    }
    return;
  }
  if (e.code === "KeyC") {
    toggleCameraPreset();
    return;
  }
  if (e.code === "KeyR") {
    recenterView();
    return;
  }
  if (state.phase !== "playing" && state.phase !== "ready") return;

  switch (e.code) {
    case "PageUp": case "KeyE": case "Space":
      queueVertical(1);
      return;
    case "PageDown": case "KeyQ": case "ShiftLeft": case "ShiftRight":
      queueVertical(-1);
      return;
  }

  const dir = horizontalKeyToDir(e.code);
  if (dir) {
    pac.desired = dir;
    e.preventDefault();
  }
});

// on-screen buttons (mouse / touch). preventDefault stops the button from
// taking focus — a focused button would swallow Space/Enter presses.
// manual pause (P) — independent of the rules panel
let manualPause = false;
function togglePause() {
  manualPause = !manualPause;
  state.paused = manualPause;
  setMessage(manualPause ? "PAUSED" : "", manualPause ? "PRESS P TO RESUME" : "");
  syncMood();
}

// rules / how-to-play panel: opening it pauses the game
function toggleInfo(show) {
  const modal = $("info-modal");
  const on = show !== undefined ? show : !modal.classList.contains("on");
  modal.classList.toggle("on", on);
  state.paused = on || manualPause;
  syncMood();
}
$("info-modal").addEventListener("pointerdown", (e) => {
  if (e.target === $("info-modal")) toggleInfo(false);
});
$("info-close").addEventListener("click", () => toggleInfo(false));

for (const [id, action] of [
  ["btn-info", () => toggleInfo()],
]) {
  const el = $(id);
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    sfx.unlock();
    action();
  });
  el.addEventListener("click", (e) => e.preventDefault());
  el.addEventListener("focus", () => el.blur());
}

// Horizontal input is camera-relative: "up" means away from the camera,
// snapped to the nearest maze axis, so steering stays intuitive while orbiting.
function horizontalKeyToDir(code) {
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
  fwd.normalize();
  // grid: +col = +x (east), +row = +z (south)
  const forward = Math.abs(fwd.z) >= Math.abs(fwd.x)
    ? [0, Math.sign(fwd.z), 0]
    : [0, 0, Math.sign(fwd.x)];
  // right = forward rotated 90° clockwise viewed from above
  const rightDir = [0, forward[2], -forward[1]];

  switch (code) {
    case "ArrowUp": case "KeyW": return forward;
    case "ArrowDown": case "KeyS": return [0, -forward[1], -forward[2]];
    case "ArrowRight": case "KeyD": return rightDir;
    case "ArrowLeft": case "KeyA": return [0, -rightDir[1], -rightDir[2]];
  }
  return null;
}

// ---------------------------------------------------------------- camera
// FIXED is the default: the map never rotates on its own, which makes
// direction-reading trivial. FOLLOW adds a slow eased drift behind Pac-Man's
// heading, and the compass dial keeps you oriented in every mode.
const CAM_MODES = [
  { name: "FIXED", offset: new THREE.Vector3(0, 15, 9.5), rotate: false },
  { name: "FOLLOW", offset: new THREE.Vector3(0, 15, 9.5), rotate: true },
  { name: "TOP-DOWN", offset: new THREE.Vector3(0, 30, 0.05), rotate: false },
];
let camMode = 0;
let camTween = null;
// the angle the camera holds rigidly in non-rotating modes; orbiting adjusts
// it, everything else (shaft rides, respawns, damping) cannot move it
const camOffset = CAM_MODES[0].offset.clone();

function toggleCameraPreset() {
  camMode = (camMode + 1) % CAM_MODES.length;
  camTween = {
    from: camera.position.clone(),
    to: controls.target.clone().add(CAM_MODES[camMode].offset),
    t: 0,
  };
  toast(`VIEW: ${CAM_MODES[camMode].name}`);
}

// Manual orbiting pauses the auto-rotate briefly so the player can look around.
let userOrbiting = false;
let orbitCooldown = 0;
controls.addEventListener("start", () => { userOrbiting = true; });
controls.addEventListener("end", () => {
  userOrbiting = false;
  orbitCooldown = 3.0;
  // the player picked a new angle: that's the constant from now on
  camOffset.copy(camera.position).sub(controls.target);
});

function autoRotateCamera(dt) {
  if (!CAM_MODES[camMode].rotate || camTween || userOrbiting) return;
  if (orbitCooldown > 0) { orbitCooldown -= dt; return; }
  if (state.phase !== "playing" || !pac.lastHorizWorld || !pac.moving) return;

  const offset = _vA.copy(camera.position).sub(controls.target);
  _sph.setFromVector3(offset);
  // camera sits behind pac: offset direction is the opposite of his heading
  const desired = Math.atan2(-pac.lastHorizWorld.x, -pac.lastHorizWorld.z);
  let dTheta = desired - _sph.theta;
  while (dTheta > Math.PI) dTheta -= Math.PI * 2;
  while (dTheta < -Math.PI) dTheta += Math.PI * 2;
  // deadband so the view sits still on small corrections; slow eased drift
  if (Math.abs(dTheta) < 0.06) return;
  _sph.theta += dTheta * Math.min(1, dt * 0.7);
  offset.setFromSpherical(_sph);
  camera.position.copy(controls.target).add(offset);
}

// recenter: snap the camera back to the current mode's default framing
function recenterView() {
  camTween = {
    from: camera.position.clone(),
    to: controls.target.clone().add(CAM_MODES[camMode].offset),
    t: 0,
  };
  toast("VIEW RECENTERED");
}

// ---------------------------------------------------------------- pac-man update
function tryBeginSegment() {
  const candidates = [];
  if (pac.pendingVertical) candidates.push(pac.pendingVertical);
  if (pac.desired) candidates.push(pac.desired);
  // only horizontal movement auto-continues: floor changes are one press = one floor
  if (pac.dir && (pac.dir[1] || pac.dir[2])) candidates.push(pac.dir);
  for (const d of candidates) {
    const nxt = stepCell(...pac.cell, d); // wrap-aware
    if (!nxt) continue;
    if (d === pac.pendingVertical) pac.pendingVertical = null;
    pac.dir = d;
    pac.next = nxt;
    pac.t = 0;
    pac.moving = true;
    return true;
  }
  return false;
}

function updatePac(dt) {
  // expire stale queued floor-changes
  if (pac.pendingVertical && state.elapsed - pac.pendingSetAt > PENDING_VERT_TTL) {
    pac.pendingVertical = null;
  }

  if (!pac.moving) {
    tryBeginSegment();
  } else {
    // mid-segment reversal: vertical rides reverse on the opposite floor key,
    // horizontal runs reverse on the opposite arrow
    const rev = (d) => d &&
      d[0] === -pac.dir[0] && d[1] === -pac.dir[1] && d[2] === -pac.dir[2];
    if (pac.dir[0] !== 0 && rev(pac.pendingVertical)) {
      [pac.cell, pac.next] = [pac.next, pac.cell];
      pac.t = 1 - pac.t;
      pac.dir = pac.pendingVertical;
      pac.pendingVertical = null;
    } else if (pac.dir[0] === 0 && rev(pac.desired)) {
      [pac.cell, pac.next] = [pac.next, pac.cell];
      pac.t = 1 - pac.t;
      pac.dir = pac.desired;
    }

    pac.t += (state.tuning.pacSpeed * dt) / segmentLength(pac.dir);
    if (pac.t >= 1) {
      pac.cell = pac.next;
      pac.moving = false;
      pac.t = 0;
      if (pac.dir[0] !== 0) sfx.layerShift();
      eatAt(pac.cell);
      tryBeginSegment(); // chain straight into the next segment
    }
  }

  // world position — vertical rides get an ease-in-out so floor changes glide
  const a = cellToWorld(...pac.cell, _vA);
  if (pac.moving) {
    const b = segmentTarget(pac.cell, pac.next, pac.dir, _vB);
    pac.pos.lerpVectors(a, b, pac.dir[0] !== 0 ? smooth(pac.t) : pac.t);
    if (pac.dir[0] === 0) {
      (pac.lastHorizWorld ||= new THREE.Vector3()).set(pac.dir[2], 0, pac.dir[1]);
    }
  } else {
    pac.pos.copy(a);
  }

  // mouth + orientation
  pac.mouthPhase += dt * (pac.moving ? 10 : 3);
  const idx = Math.floor((Math.sin(pac.mouthPhase) * 0.5 + 0.5) * (mouthGeos.length - 1));
  pacBody.geometry = mouthGeos[idx];
  pacOutline.geometry = mouthGeos[idx];
  pacGroup.position.copy(pac.pos);
  if (pac.dir && (pac.dir[0] || pac.dir[1] || pac.dir[2])) {
    const world = _vC.set(pac.dir[2], pac.dir[0], pac.dir[1]).normalize();
    _q.setFromUnitVectors(X_AXIS, world);
    pacGroup.quaternion.slerp(_q, Math.min(1, dt * 14));
  }
  pacLight.position.copy(pac.pos).y += 0.6;
  updateTrail();
}

function eatAt(cell) {
  const k = pelletKey(...cell);
  const entry = pelletMeshes.get(k);
  if (!entry) return;
  if (entry.power) {
    scene.remove(entry.mesh);
  } else {
    pelletInst[entry.floor].setMatrixAt(entry.index, ZERO_M);
    pelletInst[entry.floor].instanceMatrix.needsUpdate = true;
  }
  pelletMeshes.delete(k);
  state.pelletsLeft--;
  state.dotsPerFloor[cell[0]]--;
  const eaten = state.totalDots - state.pelletsLeft;
  if (state.fruitSpawned < state.fruitAt.length && eaten >= state.fruitAt[state.fruitSpawned]) {
    spawnFruit();
  }
  if (entry.power) {
    addScore(50);
    sfx.power();
    state.frightTimer = state.tuning.frightTime;
    state.frightMax = state.tuning.frightTime;
    state.eatChain = 0;
    syncMood();
    for (const g of ghosts) {
      if (g.state === "eyes" || g.state === "entering") continue;
      g.frightened = true;
      if (g.state === "normal") reverseGhost(g);
    }
  } else {
    addScore(10);
    sfx.waka();
  }
  updateHud();
  if (state.pelletsLeft <= 0) levelUp();
}

// endless levels: each clear re-arms the castle harder
function levelUp() {
  state.level++;
  state.tuning = levelTuning(state.level);
  spawnPellets();
  state.pelletsLeft = pelletMeshes.size;
  armFruit();
  resetPositions();
  state.phase = "ready";
  state.phaseTimer = 2.6;
  setMessage(`LEVEL ${state.level}`, state.level === 2 ? "NOW IT GETS SERIOUS" : "THE CASTLE SHARPENS");
  sfx.win();
  syncMood();
  updateHud();
}

// ---------------------------------------------------------------- ghost update
function reverseGhost(g) {
  if (g.next) {
    const tmp = g.cell;
    g.cell = g.next;
    g.next = tmp;
    g.t = 1 - g.t;
  }
  if (g.dir) g.dir = [-g.dir[0], -g.dir[1], -g.dir[2]];
}

function ghostSpeed(g) {
  if (g.state === "eyes" || g.state === "entering") return EYES_SPEED;
  if (g.state === "exiting") return EXIT_SPEED;
  if (g.frightened) return FRIGHT_SPEED;
  let speed = state.tuning.ghostSpeed;
  // Cruise Elroy: Blinky accelerates as the dots run out (arcade +5% / +10%)
  if (g.name === "blinky") {
    if (state.pelletsLeft < 30) speed += FULL_SPEED * 0.1;
    else if (state.pelletsLeft < 60) speed += FULL_SPEED * 0.05;
  }
  // the wisp drifts a little slower — dying to him is on you
  if (g.name === "wisp") speed *= 0.85;
  return speed;
}

function currentMode() {
  const waves = state.tuning.waves;
  return waves[Math.min(state.waveIndex, waves.length - 1)][0];
}

function followPath(g, dt, speed, onDone) {
  // scripted movement along g.path (list of cells), ignoring wall rules
  if (!g.next) {
    if (!g.path || g.path.length === 0) { onDone(); return; }
    g.next = g.path.shift();
    g.t = 0;
  }
  const worldLen = Math.abs(g.next[0] - g.cell[0]) !== 0 ? LAYER_H : 1;
  g.t += (speed * dt) / worldLen;
  if (g.t >= 1) {
    g.cell = g.next;
    g.next = null;
    g.t = 0;
    if (!g.path || g.path.length === 0) onDone();
  }
}

function updateGhost(g, dt) {
  const speed = ghostSpeed(g);

  if (g.state === "house") {
    g.releaseTimer -= dt;
    cellToWorld(...g.cell, g.pos);
    g.pos.y += Math.sin(state.elapsed * 4 + g.releaseDelay) * 0.12;
    if (g.releaseTimer <= 0) {
      g.state = "exiting";
      const center = GHOST_HOUSE.inside[0];
      g.path = [];
      if (g.cell[1] !== center[1] || g.cell[2] !== center[2]) g.path.push([...center]);
      g.path.push([...GHOST_HOUSE.door], [...GHOST_HOUSE.outside]);
      g.next = null;
    }
    updateGhostVisual(g, dt);
    return;
  }

  if (g.state === "exiting") {
    followPath(g, dt, speed, () => {
      g.state = "normal";
      g.dir = [0, 0, Math.random() < 0.5 ? 1 : -1];
      g.next = null;
      g.t = 0;
    });
  } else if (g.state === "eyes") {
    // BFS shortest path back to the house entrance
    stepGhostNormally(g, dt, speed, GHOST_HOUSE.outside, false, true);
    if (!g.next && g.cell[0] === GHOST_HOUSE.outside[0] &&
        g.cell[1] === GHOST_HOUSE.outside[1] && g.cell[2] === GHOST_HOUSE.outside[2]) {
      g.state = "entering";
      g.path = [[...GHOST_HOUSE.door], [...(g.slot || GHOST_HOUSE.inside[0])]];
      g.next = null;
    }
  } else if (g.state === "entering") {
    followPath(g, dt, speed, () => {
      g.state = "house";
      g.releaseTimer = 1.2;
      g.frightened = false;
      g.dir = null;
    });
  } else if (g.name === "wisp") {
    // no brain, no mode, no target: every intersection is a coin flip
    stepGhostNormally(g, dt, speed, pac.cell, true);
  } else {
    // normal / frightened
    const mode = currentMode();
    const blinky = ghosts[0];
    const target = pickTarget(
      g.name, mode, g.cell,
      { cell: pac.cell, dir: pac.moving ? pac.dir : [0, 0, 0] },
      blinky.cell
    );
    stepGhostNormally(g, dt, speed, target, g.frightened);
  }

  // world position — same vertical easing as Pac-Man
  const a = cellToWorld(...g.cell, _vA);
  if (g.next) {
    const b = g.dir
      ? segmentTarget(g.cell, g.next, g.dir, _vB)
      : cellToWorld(...g.next, _vB);
    g.pos.lerpVectors(a, b, g.next[0] !== g.cell[0] ? smooth(g.t) : g.t);
  } else {
    g.pos.copy(a);
  }
  updateGhostVisual(g, dt);
}

function stepGhostNormally(g, dt, speed, target, frightened = false, useBfs = false) {
  if (!g.next) {
    const dir = useBfs
      ? bfsDirection(g.cell, target)
      : chooseDirection(g.cell, g.dir, target, frightened);
    if (!dir) return;
    const nxt = stepCell(...g.cell, dir);
    if (!nxt) return;
    g.dir = dir;
    g.next = nxt;
    g.t = 0;
  }
  g.t += (speed * dt) / segmentLength(g.dir);
  if (g.t >= 1) {
    g.cell = g.next;
    g.next = null;
    g.t = 0;
  }
}

function updateGhostVisual(g, dt) {
  const { group, body, tintMats, shadeMats, glowMats, eyeMats, eyes,
    beacon, beaconMat, fadeMats, baseScale } = g.vis;
  group.position.copy(g.pos);

  // ghosts on other floors go translucent — but stay clearly COLORED: at the
  // old 0.22 they read as black silhouettes against the dark backdrop. The
  // beacon + altitude difference still says "not on your floor". Each
  // material fades relative to its own base opacity (glow layers stay soft).
  const pacFloor = pac.cell ? pac.cell[0] : 1;
  const targetOp = g.cell[0] === pacFloor ? 1 : 0.55;
  const k = Math.min(1, dt * 10);
  for (const m of fadeMats) {
    m.opacity += (targetOp * (m.userData.baseOp || 1) - m.opacity) * k;
  }

  // beacon tracks the wraith from above, tinted by its state
  beacon.position.set(g.pos.x, g.pos.y + 1.5, g.pos.z);
  if (g.state === "eyes" || g.state === "entering") {
    beaconMat.color.setHex(0xffffff);
    beaconMat.opacity = 0.2;
  } else if (g.frightened) {
    beaconMat.color.setHex(0x3355ff);
    beaconMat.opacity = 0.45;
  } else {
    beaconMat.color.setHex(g.color);
    beaconMat.opacity = 0.5;
  }
  // floating spirit bob with a gentle squash-and-stretch breathe
  // (the wisp adds a drunken sway)
  const phase = state.elapsed * 5 + g.releaseDelay * 2;
  body.position.y = -0.02 + Math.sin(phase) * 0.05;
  body.scale.set(
    baseScale.x * (1 - Math.sin(phase) * 0.03),
    baseScale.y * (1 + Math.sin(phase) * 0.045),
    baseScale.z * (1 - Math.sin(phase) * 0.03));
  if (g.name === "wisp") body.rotation.z = Math.sin(state.elapsed * 6.5) * 0.14;

  const isEyes = g.state === "eyes" || g.state === "entering";
  body.visible = !isEyes;

  // tint writes only happen when the visual state actually flips
  const blinking = g.frightened && !isEyes && state.frightTimer < FRIGHT_BLINK &&
    Math.floor(state.frightTimer * 5) % 2 === 0;
  const tintKey = !g.frightened || isEyes ? 0 : blinking ? 2 : 1;
  if (g.vis.tintKey !== tintKey) {
    g.vis.tintKey = tintKey;
    if (tintKey > 0) {
      // frightened: bright arcade blue (white during the end-of-timer blink)
      for (const m of tintMats) m.color.setHex(blinking ? 0xffffff : 0x2438e0);
      for (const m of shadeMats) m.color.setHex(blinking ? 0xbfd0ff : 0x141e66);
      for (const m of glowMats) m.color.setHex(blinking ? 0xffffff : 0x3355ff);
      for (const m of eyeMats) m.color.setHex(blinking ? 0x2438e0 : 0xffffff);
    } else {
      for (const m of tintMats) m.color.setHex(g.color);
      for (const m of shadeMats) m.color.setHex(g.color).multiplyScalar(0.55);
      for (const m of glowMats) m.color.setHex(g.color);
      for (const m of eyeMats) m.color.setHex(IRIS_COLORS[g.name]);
    }
  }

  // face the travel direction (horizontal component)
  if (g.dir && (g.dir[1] || g.dir[2])) {
    const look = _vC.set(g.pos.x + g.dir[2], g.pos.y, g.pos.z + g.dir[1]);
    _m4.lookAt(look, g.pos, UP);
    _q.setFromRotationMatrix(_m4);
    group.quaternion.slerp(_q, Math.min(1, dt * 10));
  }
  eyes.visible = true;
}

// ---------------------------------------------------------------- collisions
function checkCollisions() {
  for (const g of ghosts) {
    if (g.state === "eyes" || g.state === "entering" || g.state === "house") continue;
    if (g.pos.distanceTo(pac.pos) > 0.62) continue;
    if (g.frightened) {
      g.frightened = false;
      g.state = "eyes";
      g.next = null;
      state.eatChain = Math.min(state.eatChain + 1, 5);
      const pts = 100 * 2 ** state.eatChain; // 200 / 400 / 800 / 1600 / 3200
      addScore(pts);
      popup(`+${pts}`, g.pos, "#66ccff");
      sfx.eatGhost();
      updateHud();
    } else {
      state.phase = "dying";
      state.phaseTimer = 1.6;
      sfx.death();
      setMessage("");
      syncMood();
      return;
    }
  }
}

// ---------------------------------------------------------------- visibility
// The current floor renders solid; other floors keep bright wireframes (so the
// maze structure always reads) but fade their fill, plates, and pellets.
function updateVisibility() {
  // fractional floor from Pac-Man's actual height, so opacities crossfade
  // continuously during a shaft ride instead of snapping at the end
  const fl = pac.pos.y / LAYER_H;
  const at = (vals, d) => {
    const i = Math.min(Math.floor(d), vals.length - 2);
    const f = Math.min(Math.max(d - i, 0), 1);
    return vals[i] + (vals[i + 1] - vals[i]) * f;
  };
  // asymmetric: floors ABOVE you fade almost out (they occlude the view),
  // floors below stay ghostly so depth still reads
  for (let l = 0; l < LAYERS; l++) {
    const rel = l - fl;
    const above = rel > 0;
    const d = Math.min(Math.abs(rel), 2);
    // breathing trim: the active floor's neon slowly pulses like a heartbeat
    const breathe = 0.88 + 0.12 * Math.sin(state.elapsed * 1.7 + l);
    wallFillMats[l].opacity = at(above ? [0.94, 0.012, 0.005] : [0.94, 0.07, 0.03], d);
    wallFillMats[l].emissiveIntensity = at([1.35, 0.2, 0.08], d) * breathe;
    wallCapMats[l].opacity = at(above ? [0.95, 0.012, 0.005] : [0.95, 0.07, 0.03], d);
    wallEdgeMats[l].opacity = at(above ? [0.85, 0.045, 0.015] : [0.85, 0.18, 0.07], d);
    floorPlateMats[l].opacity = at([0.55, 0.06, 0.03], d);
    pelletMatByFloor[l].opacity = at(above ? [1.0, 0.025, 0.01] : [1.0, 0.14, 0.05], d);
    powerMatByFloor[l].opacity = at(above ? [1.0, 0.12, 0.06] : [1.0, 0.3, 0.12], d);
    towerMats[l].opacity = at([0.95, 0.2, 0.08], d);
    towerGlowMats[l * 2].opacity = at([0.85, 0.15, 0.06], d);
    towerGlowMats[l * 2 + 1].opacity = at([0.95, 0.2, 0.08], d);

    // overdraw culling: a floor faded to nothing shouldn't cost fill rate
    const refs = floorMeshRefs[l];
    const show = wallFillMats[l].opacity > 0.015;
    refs.fill.visible = show;
    refs.caps.visible = show;
    refs.plate.visible = show;
    refs.lines.visible = wallEdgeMats[l].opacity > 0.02;
    pelletInst[l].visible = pelletMatByFloor[l].opacity > 0.02;
  }

  // shaft highlights: the two reusable glow beams park at whatever shaft
  // segment Pac-Man is standing on and can actually ride
  const [cl, cr, cc] = pac.cell || [1, 0, 0];
  const canUp = !pac.moving && canMoveVertical(cl, cl + 1, cr, cc);
  const canDown = !pac.moving && canMoveVertical(cl, cl - 1, cr, cc);
  const pulse2 = 0.4 + Math.sin(state.elapsed * 8) * 0.15;
  const [hlUp, hlDown] = shaftHighlights;
  hlUp.visible = canUp;
  hlDown.visible = canDown;
  if (canUp || canDown) {
    const v = cellToWorld(cl, cr, cc, _vA);
    if (canUp) {
      hlUp.position.set(v.x, cl * LAYER_H + LAYER_H / 2, v.z);
      hlUp.material.opacity = pulse2;
    }
    if (canDown) {
      hlDown.position.set(v.x, (cl - 1) * LAYER_H + LAYER_H / 2, v.z);
      hlDown.material.opacity = pulse2;
    }
  }

  // shaft hint + queued indicator
  const hint = $("shaft-hint");
  if (state.phase === "playing" && (canUp || canDown)) {
    hint.textContent =
      `${canUp ? "▲ PGUP  " : ""}${canDown ? "▼ PGDN" : ""}`.trim();
    hint.classList.add("on");
  } else if (state.phase === "playing" && pac.pendingVertical) {
    hint.textContent = pac.pendingVertical[0] > 0 ? "▲ QUEUED" : "▼ QUEUED";
    hint.classList.add("on");
  } else {
    hint.classList.remove("on");
  }
  // frightened timer bar
  const wrap = $("fright-wrap");
  if (state.frightTimer > 0) {
    wrap.classList.add("on");
    wrap.classList.toggle("blink", state.frightTimer < FRIGHT_BLINK);
    $("fright-bar").style.width = `${(state.frightTimer / state.frightMax) * 100}%`;
  } else {
    wrap.classList.remove("on", "blink");
  }
}

// ---------------------------------------------------------------- adaptive quality
// smoothness is non-negotiable: if the average frame cost creeps up, quietly
// step the render load down (never back up, to avoid oscillation)
let perfAcc = 0;
let perfFrames = 0;
let qualityLevel = 0; // 0 full → 1 lower pixel ratio → 2 bloom off

function adaptQuality(dt) {
  perfAcc += dt;
  perfFrames++;
  if (perfFrames < 150) return; // judge ~2.5s windows
  const avg = perfAcc / perfFrames;
  perfAcc = 0;
  perfFrames = 0;
  if (avg <= 1 / 45 || qualityLevel >= 2) return;
  qualityLevel++;
  if (qualityLevel === 1) {
    renderer.setPixelRatio(1);
    renderer.setSize(innerWidth, innerHeight);
    composer.setSize(innerWidth, innerHeight);
  } else {
    bloom.enabled = false;
  }
}

// ---------------------------------------------------------------- main loop
let lastTime = performance.now();
let mmAccum = 1; // minimap redraws at ~30 Hz — invisible, but cheaper

function tick(now) {
  requestAnimationFrame(tick);
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;
  state.elapsed += dt;

  // power pellet pulse + ambience
  const pulse = 1 + Math.sin(state.elapsed * 6) * 0.25;
  for (const mesh of powerMeshes) mesh.scale.setScalar(pulse);
  starField.rotation.y += dt * 0.008; // slow drift
  motes.rotation.y += dt * 0.012;
  for (const { mesh, mat, phase } of shaftRingPhases) {
    const t = (state.elapsed * 0.35 + phase) % 1;
    mesh.position.y = t * LAYER_H;
    mat.opacity = 0.5 * Math.sin(Math.PI * t);
  }
  updateSky(dt);
  adaptQuality(dt);

  if (state.paused) {
    controls.update();
    composer.render();
    return;
  }
  updateFruit(dt);

  switch (state.phase) {
    case "menu":
      break;

    case "ready":
      state.phaseTimer -= dt;
      if (state.phaseTimer <= 0) {
        state.phase = "playing";
        setMessage("");
        syncMood();
      }
      break;

    case "playing": {
      // mode waves (paused while frightened, like the arcade)
      if (state.frightTimer > 0) {
        state.frightTimer -= dt;
        if (state.frightTimer <= 0) {
          state.frightTimer = 0;
          for (const g of ghosts) g.frightened = false;
          syncMood();
        }
      } else {
        state.waveTimer += dt;
        const waves = state.tuning.waves;
        const waveLen = waves[Math.min(state.waveIndex, waves.length - 1)][1];
        if (state.waveTimer >= waveLen && state.waveIndex < waves.length - 1) {
          state.waveIndex++;
          state.waveTimer = 0;
          for (const g of ghosts) if (g.state === "normal") reverseGhost(g);
        }
      }

      updatePac(dt);
      for (const g of ghosts) updateGhost(g, dt);
      checkCollisions();
      break;
    }

    case "dying": {
      state.phaseTimer -= dt;
      // spiral-shrink animation
      const p = Math.max(state.phaseTimer / 1.6, 0);
      pacGroup.scale.setScalar(Math.max(p, 0.001));
      pacGroup.rotation.y += dt * 12;
      if (state.phaseTimer <= 0) {
        pacGroup.scale.setScalar(1);
        pacGroup.rotation.set(0, 0, 0);
        state.lives--;
        if (state.lives < 0) {
          state.phase = "gameover";
          setMessage("GAME OVER", "PRESS ENTER TO RESTART");
        } else {
          resetPositions();
          state.phase = "ready";
          state.phaseTimer = 2.0;
          setMessage("READY!");
        }
        updateHud();
      }
      break;
    }

    case "gameover":
      for (const g of ghosts) updateGhostVisual(g, dt);
      break;
  }

  updateVisibility();
  updateFloorStack();

  // camera: preset tween, then smooth follow
  if (camTween) {
    camTween.t += dt * 2.2;
    const k = Math.min(camTween.t, 1);
    camera.position.lerpVectors(camTween.from, camTween.to, smooth(k));
    if (k >= 1) {
      camTween = null;
      camOffset.copy(camera.position).sub(controls.target);
    }
  }
  const targetPos = pac.cell ? pac.pos : _vB.set(0, LAYER_H, 0);
  const delta = _vA.copy(targetPos).sub(controls.target).multiplyScalar(Math.min(1, dt * 8));
  controls.target.add(delta);
  camera.position.add(delta);
  autoRotateCamera(dt);
  controls.update();
  // constant angle: in non-rotating modes the offset is enforced rigidly, so
  // nothing (damping glide, follow lag, floor rides) can tilt the view
  if (!userOrbiting && !camTween && !CAM_MODES[camMode].rotate) {
    camera.position.copy(controls.target).add(camOffset);
  }
  mmAccum += dt;
  if (mmAccum >= 1 / 30) {
    mmAccum = 0;
    updateMinimap();
  }

  composer.render();
}

// ---------------------------------------------------------------- boot
spawnPellets();
state.pelletsLeft = pelletMeshes.size;
resetPositions();
controls.target.copy(pac.pos);
camera.position.copy(pac.pos).add(CAM_MODES[0].offset);
updateHud();
updateFloorStack();
$("build-tag").textContent = BUILD;
setMessage("PAC-MAN 3D", "PRESS ENTER TO START");
requestAnimationFrame(tick);

// debug/test hook: lets automated tests drive frames when rAF is throttled
window.__pacman3d = {
  state, pac, ghosts, camera, controls,
  step(ms) { lastTime = performance.now() - ms; tick(performance.now()); },
};
