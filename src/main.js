import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import {
  LAYERS, ROWS, COLS, canStep, stepCell, canMoveVertical, collectCells, GHOST_HOUSE,
} from "./maze.js";
import { GHOST_DEFS, pickTarget, chooseDirection, bfsDirection } from "./ghosts.js";
import { sfx } from "./audio.js";

// ---------------------------------------------------------------- constants
const LAYER_H = 2.4; // world height between floors
const FRIGHT_SPEED = 2.6;
const EYES_SPEED = 10.0;
const EXIT_SPEED = 3.0;
const FRIGHT_BLINK = 2.0;
const PENDING_VERT_TTL = 6.0; // queued floor-change expires after this many seconds

// Difficulty curve: level 1 is fast but fair; from level 2 on you need to
// know the routes and read ghost behaviour. Ghosts close the speed gap,
// scatter breaks shrink, power pellets weaken, releases come sooner.
function levelTuning(level) {
  const l = Math.min(level, 6);
  return {
    pacSpeed: 4.6 + 0.06 * (l - 1),
    ghostSpeed: Math.min(4.05 + 0.18 * (l - 1), 4.6),
    frightTime: Math.max(8 - 1.7 * (l - 1), 1.2),
    releaseDelays: [
      0,
      Math.max(2 - 0.45 * (l - 1), 0.3),
      Math.max(5 - 1.1 * (l - 1), 0.8),
      Math.max(8 - 1.7 * (l - 1), 1.2),
    ],
    waves: l === 1
      ? [["scatter", 7], ["chase", 20], ["scatter", 7], ["chase", 20],
         ["scatter", 5], ["chase", 20], ["scatter", 5], ["chase", Infinity]]
      : l === 2
        ? [["scatter", 5], ["chase", 25], ["scatter", 4], ["chase", 25],
           ["scatter", 3], ["chase", Infinity]]
        : [["scatter", 3], ["chase", 35], ["scatter", 2], ["chase", Infinity]],
  };
}

// per-floor accent colors: bottom teal, middle blue, top violet
const FLOOR_COLORS = [0x2dd6c8, 0x4d6bff, 0xb36bff];

// glowing eye color per wraith
const IRIS_COLORS = { blinky: 0xff2244, pinky: 0xff66aa, inky: 0x33ddff, clyde: 0xffaa33 };

const OUTLINE_COLOR = 0x140a24;

const cellToWorld = (l, r, c, out = new THREE.Vector3()) =>
  out.set(c - (COLS - 1) / 2, l * LAYER_H, r - (ROWS - 1) / 2);

// ease-in-out used for vertical rides and camera blends
const smooth = (t) => t * t * (3 - 2 * t);

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
scene.fog = new THREE.Fog(0x10061f, 45, 135);

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 300);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

// soft anime-glow post-processing (threshold high so only true emitters bloom)
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.38, 0.5, 0.85);
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

// ---------------------------------------------------------------- backdrop
// night-sky dome, anime moon, distant ground grid, stars, sakura petals
{
  const skyCanvas = document.createElement("canvas");
  skyCanvas.width = 16;
  skyCanvas.height = 256;
  const ctx = skyCanvas.getContext("2d");
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.0, "#05020f");
  grad.addColorStop(0.5, "#160a30");
  grad.addColorStop(0.78, "#341050");
  grad.addColorStop(1.0, "#61205f");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 16, 256);
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(180, 24, 16),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(skyCanvas), side: THREE.BackSide, fog: false })
  );
  scene.add(sky);

  const moonCanvas = document.createElement("canvas");
  moonCanvas.width = moonCanvas.height = 128;
  const mc = moonCanvas.getContext("2d");
  const mg = mc.createRadialGradient(64, 64, 10, 64, 64, 64);
  mg.addColorStop(0, "rgba(255,244,208,1)");
  mg.addColorStop(0.45, "rgba(255,236,180,0.95)");
  mg.addColorStop(0.55, "rgba(255,220,150,0.35)");
  mg.addColorStop(1, "rgba(255,210,130,0)");
  mc.fillStyle = mg;
  mc.fillRect(0, 0, 128, 128);
  const moon = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(moonCanvas), fog: false, depthWrite: false,
  }));
  moon.position.set(-48, 40, -70);
  moon.scale.setScalar(30);
  scene.add(moon);

  const grid = new THREE.GridHelper(160, 80, 0x5a2d8a, 0x241040);
  grid.position.y = -1.6;
  grid.material.transparent = true;
  grid.material.opacity = 0.45;
  scene.add(grid);

  // jagged mountain skyline ringing the horizon
  const mCanvas = document.createElement("canvas");
  mCanvas.width = 1024;
  mCanvas.height = 128;
  const mctx = mCanvas.getContext("2d");
  mctx.fillStyle = "#150a2e";
  mctx.beginPath();
  mctx.moveTo(0, 128);
  let mx = 0;
  while (mx < 1024) {
    mctx.lineTo(mx + 30 + Math.random() * 40, 128 - (35 + Math.random() * 70));
    mx += 60 + Math.random() * 50;
    mctx.lineTo(Math.min(mx, 1024), 128 - (8 + Math.random() * 22));
  }
  mctx.lineTo(1024, 128);
  mctx.closePath();
  mctx.fill();
  const mTex = new THREE.CanvasTexture(mCanvas);
  mTex.wrapS = THREE.RepeatWrapping;
  mTex.repeat.x = 3;
  const mountains = new THREE.Mesh(
    new THREE.CylinderGeometry(130, 130, 48, 64, 1, true),
    new THREE.MeshBasicMaterial({ map: mTex, transparent: true, side: THREE.BackSide, fog: false, depthWrite: false })
  );
  mountains.position.y = 16;
  scene.add(mountains);

  const starGeo = new THREE.BufferGeometry();
  const starPos = new Float32Array(500 * 3);
  for (let i = 0; i < 500; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(100 + Math.random() * 60);
    v.y = Math.abs(v.y) * 0.7 - 4;
    starPos.set([v.x, v.y, v.z], i * 3);
  }
  starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
  scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({
    color: 0x9aa8ff, size: 0.4, transparent: true, opacity: 0.8, sizeAttenuation: true, fog: false,
  })));
}

// soft drifting clouds
const cloudSprites = [];
{
  const cCanvas = document.createElement("canvas");
  cCanvas.width = 256;
  cCanvas.height = 128;
  const cctx = cCanvas.getContext("2d");
  const cg = cctx.createRadialGradient(128, 64, 8, 128, 64, 120);
  cg.addColorStop(0, "rgba(205,180,255,0.55)");
  cg.addColorStop(0.55, "rgba(180,150,240,0.25)");
  cg.addColorStop(1, "rgba(160,130,230,0)");
  cctx.fillStyle = cg;
  cctx.fillRect(0, 0, 256, 128);
  const cTex = new THREE.CanvasTexture(cCanvas);
  for (let i = 0; i < 6; i++) {
    const cloud = new THREE.Sprite(new THREE.SpriteMaterial({
      map: cTex, transparent: true, opacity: 0.5, fog: false, depthWrite: false,
    }));
    cloud.position.set((Math.random() - 0.5) * 180, 24 + Math.random() * 16, (Math.random() - 0.5) * 180);
    cloud.scale.set(34 + Math.random() * 18, 12 + Math.random() * 6, 1);
    cloud.userData.speed = 0.8 + Math.random() * 1.0;
    scene.add(cloud);
    cloudSprites.push(cloud);
  }
}

function updateClouds(dt) {
  for (const cloud of cloudSprites) {
    cloud.position.x += cloud.userData.speed * dt;
    if (cloud.position.x > 110) cloud.position.x = -110;
  }
}

const PETALS = 140;
const petalGeo = new THREE.BufferGeometry();
const petalPos = new Float32Array(PETALS * 3);
const petalSeed = new Float32Array(PETALS);
for (let i = 0; i < PETALS; i++) {
  petalPos.set([(Math.random() - 0.5) * 40, Math.random() * 10 - 1, (Math.random() - 0.5) * 44], i * 3);
  petalSeed[i] = Math.random() * Math.PI * 2;
}
petalGeo.setAttribute("position", new THREE.BufferAttribute(petalPos, 3));
scene.add(new THREE.Points(petalGeo, new THREE.PointsMaterial({
  color: 0xffa8d4, size: 0.14, transparent: true, opacity: 0.75, sizeAttenuation: true,
})));

function updatePetals(dt, elapsed) {
  const p = petalGeo.attributes.position;
  for (let i = 0; i < PETALS; i++) {
    let y = p.getY(i) - dt * (0.35 + 0.15 * Math.sin(petalSeed[i]));
    if (y < -1.2) y = 8;
    p.setY(i, y);
    p.setX(i, p.getX(i) + Math.sin(elapsed * 0.8 + petalSeed[i]) * dt * 0.4);
  }
  p.needsUpdate = true;
}

// ---------------------------------------------------------------- castle visuals
const mazeData = collectCells();
const wallFillMats = []; // solid fill per floor
const wallEdgeMats = []; // glowing wireframe per floor
const floorPlateMats = [];
const towerMats = []; // corner towers per floor

{
  // rounded battlement blocks instead of raw cubes
  const wallGeo = new RoundedBoxGeometry(1, 1.0, 1, 3, 0.14);
  const edgeTemplate = new THREE.EdgesGeometry(new THREE.BoxGeometry(0.98, 0.98, 0.98));
  const v = new THREE.Vector3();

  for (let l = 0; l < LAYERS; l++) {
    const color = FLOOR_COLORS[l];
    const cellsHere = mazeData.walls.filter(([wl]) => wl === l);

    const fillMat = new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 0.18,
      transparent: true, opacity: 0.8, depthWrite: false,
      roughness: 0.35, metalness: 0.15,
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

    // floor plate
    const plateMat = new THREE.MeshBasicMaterial({
      color: 0x0d0724, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false,
    });
    floorPlateMats.push(plateMat);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(COLS, ROWS), plateMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = l * LAYER_H - 0.55;
    scene.add(floor);

    // watchtowers on the four corners give each floor a castle silhouette
    const towerMat = toonMat(color, { transparent: true, opacity: 0.9 });
    towerMats.push(towerMat);
    const hx = (COLS - 1) / 2 + 0.7;
    const hz = (ROWS - 1) / 2 + 0.7;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const tower = new THREE.Group();
        const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.68, 1.7, 12), towerMat);
        const roof = new THREE.Mesh(new THREE.ConeGeometry(0.78, 0.95, 12), towerMat);
        roof.position.y = 1.3;
        const glow = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 8),
          new THREE.MeshBasicMaterial({ color: 0xffd447 }));
        glow.position.y = 1.85;
        tower.add(barrel, roof, glow);
        tower.position.set(sx * hx, l * LAYER_H + 0.25, sz * hz);
        scene.add(tower);
      }
    }
  }
}

// vertical shaft beams — highlighted when Pac-Man can use them
const shaftBeams = []; // { mesh, mat, lowLayer, r, c }
{
  const shaftGeo = new THREE.CylinderGeometry(0.34, 0.34, LAYER_H, 14, 1, true);
  const seen = new Set();
  for (const [l, r, c] of mazeData.shafts) {
    for (const low of [l - 1, l]) {
      const key = `${low},${r},${c}`;
      if (low < 0 || seen.has(key)) continue;
      if (!canMoveVertical(low, low + 1, r, c)) continue;
      seen.add(key);
      const mat = new THREE.MeshBasicMaterial({
        color: 0x4dffdf, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide,
      });
      const beam = new THREE.Mesh(shaftGeo, mat);
      cellToWorld(low, r, c, beam.position);
      beam.position.y += LAYER_H / 2;
      beam.renderOrder = 3;
      scene.add(beam);
      shaftBeams.push({ mesh: beam, mat, lowLayer: low, r, c });
    }
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
  const m = new THREE.Matrix4();
  const v = new THREE.Vector3();
  pelletsByFloor.forEach((list, l) => {
    list.forEach(([ll, r, c], i) => {
      cellToWorld(ll, r, c, v);
      m.makeTranslation(v.x, v.y, v.z);
      pelletInst[l].setMatrixAt(i, m);
      pelletMeshes.set(pelletKey(ll, r, c), { power: false, floor: l, index: i });
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
// yokai wraiths: hooded lathe cloaks with tattered hems, inked outlines and
// angry glowing eye slits. Each keeps a signature trait:
//   blinky — oni horns   pinky — trailing ribbons
//   inky — kitsune mask  clyde — hulking build
function makeGhostMesh(color, name) {
  const group = new THREE.Group();

  const pts = [
    new THREE.Vector2(0.001, 0.52),
    new THREE.Vector2(0.14, 0.44),
    new THREE.Vector2(0.28, 0.24),
    new THREE.Vector2(0.33, 0.02),
    new THREE.Vector2(0.37, -0.16),
    new THREE.Vector2(0.44, -0.34),
  ];
  const cloakGeo = new THREE.LatheGeometry(pts, 24);
  const cp = cloakGeo.attributes.position;
  for (let i = 0; i < cp.count; i++) {
    if (cp.getY(i) < -0.28) {
      const ang = Math.atan2(cp.getZ(i), cp.getX(i));
      cp.setY(i, cp.getY(i) + Math.sin(ang * 5) * 0.06);
    }
  }
  cloakGeo.computeVertexNormals();

  const cloakMat = toonMat(color, { side: THREE.DoubleSide });
  const body = new THREE.Group();
  const cloak = new THREE.Mesh(cloakGeo, cloakMat);
  const outline = new THREE.Mesh(cloakGeo,
    new THREE.MeshBasicMaterial({ color: OUTLINE_COLOR, side: THREE.BackSide }));
  outline.scale.setScalar(1.07);
  body.add(cloak, outline);
  body.position.y = -0.02;

  const tintMats = [cloakMat];

  // signature traits
  if (name === "blinky") {
    for (const side of [-1, 1]) {
      const horn = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.2, 8), toonMat(0x55111f));
      horn.position.set(side * 0.13, 0.44, 0);
      horn.rotation.z = side * -0.55;
      body.add(horn);
    }
  } else if (name === "pinky") {
    for (const side of [-1, 1]) {
      const ribbonMat = toonMat(0xffb2d8);
      const ribbon = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.34, 0.02), ribbonMat);
      ribbon.position.set(side * 0.17, 0.4, -0.12);
      ribbon.rotation.x = -0.7;
      ribbon.rotation.z = side * 0.35;
      body.add(ribbon);
    }
  } else if (name === "inky") {
    const mask = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12), toonMat(0xf2f4ff));
    mask.position.set(0, 0.2, 0.2);
    mask.scale.set(1.05, 1.25, 0.4);
    body.add(mask);
  } else if (name === "clyde") {
    body.scale.set(1.18, 0.94, 1.18);
  }
  group.add(body);

  // angry glowing eye slits (also serve as the "eyes" state when eaten)
  const eyes = new THREE.Group();
  const eyeMats = [];
  for (const side of [-1, 1]) {
    const mat = new THREE.MeshBasicMaterial({ color: IRIS_COLORS[name] });
    eyeMats.push(mat);
    const slit = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.05, 0.03), mat);
    const zOff = name === "inky" ? 0.34 : 0.3;
    slit.position.set(side * 0.13, 0.2, zOff);
    slit.rotation.z = side * 0.38; // "\ /" glare
    eyes.add(slit);
  }
  group.add(eyes);
  return { group, body, tintMats, eyeMats, eyes };
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
  const sig = `${pl}|${ghostFloors.join(",")}`;
  if (sig === floorStackSig) return;
  floorStackSig = sig;

  let html = `<div class="fs-title">FLOORS</div>`;
  for (let l = LAYERS - 1; l >= 0; l--) {
    const dots = [`${pl === l ? '<span class="dot pac"></span>' : ""}`];
    ghosts.forEach((g, i) => {
      if (ghostFloors[i] === l) {
        const col = `#${g.color.toString(16).padStart(6, "0")}`;
        dots.push(`<span class="dot" style="background:${col};box-shadow:0 0 5px ${col}"></span>`);
      }
    });
    html += `<div class="floor-row${pl === l ? " active" : ""}">
      <span class="fl">${l + 1}</span>${dots.join("")}</div>`;
  }
  floorStackEl.innerHTML = html;
}

function resetPositions() {
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
  resetPositions();
  state.phase = "ready";
  state.phaseTimer = 2.2;
  setMessage("READY!");
  sfx.start();
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

// on-screen floor buttons (mouse / touch). preventDefault stops the button
// from taking focus — a focused button would swallow Space/Enter presses.
for (const [id, dl] of [["btn-up", 1], ["btn-down", -1]]) {
  const el = $(id);
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    sfx.unlock();
    queueVertical(dl);
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
  { name: "FIXED", offset: new THREE.Vector3(0, 12.5, 11.5), rotate: false },
  { name: "FOLLOW", offset: new THREE.Vector3(0, 12.5, 11.5), rotate: true },
  { name: "TOP-DOWN", offset: new THREE.Vector3(0, 30, 0.05), rotate: false },
];
let camMode = 0;
let camTween = null;

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
controls.addEventListener("end", () => { userOrbiting = false; orbitCooldown = 3.0; });

function autoRotateCamera(dt) {
  if (!CAM_MODES[camMode].rotate || camTween || userOrbiting) return;
  if (orbitCooldown > 0) { orbitCooldown -= dt; return; }
  if (state.phase !== "playing" || !pac.lastHorizWorld || !pac.moving) return;

  const offset = camera.position.clone().sub(controls.target);
  const sph = new THREE.Spherical().setFromVector3(offset);
  // camera sits behind pac: offset direction is the opposite of his heading
  const desired = Math.atan2(-pac.lastHorizWorld.x, -pac.lastHorizWorld.z);
  let dTheta = desired - sph.theta;
  while (dTheta > Math.PI) dTheta -= Math.PI * 2;
  while (dTheta < -Math.PI) dTheta += Math.PI * 2;
  // deadband so the view sits still on small corrections; slow eased drift
  if (Math.abs(dTheta) < 0.06) return;
  sph.theta += dTheta * Math.min(1, dt * 0.7);
  offset.setFromSpherical(sph);
  camera.position.copy(controls.target).add(offset);
}

// compass: the rose rotates so "N" marks maze-north on screen; the needle
// points the way Pac-Man is currently travelling
const compassRoseEl = $("compass-rose");
const compassNeedleEl = $("compass-needle");

function updateCompass() {
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) return;
  fwd.normalize();
  const bearing = (x, z) =>
    Math.atan2(fwd.x * z - fwd.z * x, fwd.x * x + fwd.z * z);
  // maze north is world -z
  compassRoseEl.style.transform = `rotate(${bearing(0, -1)}rad)`;
  if (pac.moving && pac.lastHorizWorld && pac.dir[0] === 0) {
    const b = bearing(pac.lastHorizWorld.x, pac.lastHorizWorld.z);
    compassNeedleEl.style.transform =
      `translate(-50%, -100%) rotate(${b}rad)`;
    compassNeedleEl.classList.remove("idle");
  } else {
    compassNeedleEl.classList.add("idle");
  }
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
  const a = cellToWorld(...pac.cell, new THREE.Vector3());
  if (pac.moving) {
    const b = segmentTarget(pac.cell, pac.next, pac.dir, new THREE.Vector3());
    pac.pos.lerpVectors(a, b, pac.dir[0] !== 0 ? smooth(pac.t) : pac.t);
    if (pac.dir[0] === 0) {
      pac.lastHorizWorld = new THREE.Vector3(pac.dir[2], 0, pac.dir[1]);
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
    const world = new THREE.Vector3(pac.dir[2], pac.dir[0], pac.dir[1]).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), world);
    pacGroup.quaternion.slerp(q, Math.min(1, dt * 14));
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
  if (entry.power) {
    addScore(50);
    sfx.power();
    state.frightTimer = state.tuning.frightTime;
    state.frightMax = state.tuning.frightTime;
    state.eatChain = 0;
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
  resetPositions();
  state.phase = "ready";
  state.phaseTimer = 2.6;
  setMessage(`LEVEL ${state.level}`, state.level === 2 ? "NOW IT GETS SERIOUS" : "THE CASTLE SHARPENS");
  sfx.win();
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
  // Cruise Elroy: Blinky accelerates as the dots run out — learn to feel it
  if (g.name === "blinky") {
    if (state.pelletsLeft < 50) speed += 0.55;
    else if (state.pelletsLeft < 120) speed += 0.28;
  }
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
  const a = cellToWorld(...g.cell, new THREE.Vector3());
  if (g.next) {
    const b = g.dir
      ? segmentTarget(g.cell, g.next, g.dir, new THREE.Vector3())
      : cellToWorld(...g.next, new THREE.Vector3());
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
  const { group, body, tintMats, eyeMats, eyes, beacon, beaconMat } = g.vis;
  group.position.copy(g.pos);

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
  // floating spirit bob
  body.position.y = -0.02 + Math.sin(state.elapsed * 5 + g.releaseDelay * 2) * 0.045;

  const isEyes = g.state === "eyes" || g.state === "entering";
  body.visible = !isEyes;

  if (g.frightened && !isEyes) {
    const blinking = state.frightTimer < FRIGHT_BLINK &&
      Math.floor(state.frightTimer * 5) % 2 === 0;
    for (const m of tintMats) m.color.setHex(blinking ? 0xe8ecff : 0x2438e0);
    for (const m of eyeMats) m.color.setHex(0xffffff);
  } else {
    for (const m of tintMats) m.color.setHex(g.color);
    for (const m of eyeMats) m.color.setHex(IRIS_COLORS[g.name]);
  }

  // face the travel direction (horizontal component)
  if (g.dir && (g.dir[1] || g.dir[2])) {
    const look = g.pos.clone().add(new THREE.Vector3(g.dir[2], 0, g.dir[1]));
    const q = new THREE.Quaternion();
    const m = new THREE.Matrix4().lookAt(look, g.pos, new THREE.Vector3(0, 1, 0));
    q.setFromRotationMatrix(m);
    group.quaternion.slerp(q, Math.min(1, dt * 10));
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
      state.eatChain = Math.min(state.eatChain + 1, 4);
      const pts = 100 * 2 ** state.eatChain; // 200 / 400 / 800 / 1600
      addScore(pts);
      popup(`+${pts}`, g.pos, "#66ccff");
      sfx.eatGhost();
      updateHud();
    } else {
      state.phase = "dying";
      state.phaseTimer = 1.6;
      sfx.death();
      setMessage("");
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
    wallFillMats[l].opacity = at(above ? [0.94, 0.025, 0.01] : [0.94, 0.1, 0.04], d);
    wallFillMats[l].emissiveIntensity = at([0.35, 0.1, 0.05], d);
    wallEdgeMats[l].opacity = at(above ? [1.0, 0.08, 0.03] : [1.0, 0.26, 0.1], d);
    floorPlateMats[l].opacity = at([0.55, 0.08, 0.04], d);
    pelletMatByFloor[l].opacity = at(above ? [1.0, 0.05, 0.02] : [1.0, 0.2, 0.08], d);
    powerMatByFloor[l].opacity = at(above ? [1.0, 0.2, 0.1] : [1.0, 0.4, 0.18], d);
    towerMats[l].opacity = at([0.95, 0.25, 0.1], d);
  }

  // shaft beams: glow when Pac-Man is standing where they can be used
  const [cl, cr, cc] = pac.cell || [1, 0, 0];
  let canUp = false;
  let canDown = false;
  for (const b of shaftBeams) {
    const usable = !pac.moving && b.r === cr && b.c === cc &&
      (b.lowLayer === cl || b.lowLayer + 1 === cl);
    if (usable) {
      if (b.lowLayer === cl) canUp = true;
      if (b.lowLayer + 1 === cl) canDown = true;
      b.mat.opacity = 0.4 + Math.sin(state.elapsed * 8) * 0.15;
    } else {
      b.mat.opacity = 0.18;
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
  $("btn-up").classList.toggle("queued", !!pac.pendingVertical && pac.pendingVertical[0] > 0);
  $("btn-down").classList.toggle("queued", !!pac.pendingVertical && pac.pendingVertical[0] < 0);

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

// ---------------------------------------------------------------- main loop
let lastTime = performance.now();

function tick(now) {
  requestAnimationFrame(tick);
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;
  state.elapsed += dt;

  // power pellet pulse + ambience
  const pulse = 1 + Math.sin(state.elapsed * 6) * 0.25;
  for (const mesh of powerMeshes) mesh.scale.setScalar(pulse);
  updatePetals(dt, state.elapsed);
  updateClouds(dt);

  switch (state.phase) {
    case "menu":
      break;

    case "ready":
      state.phaseTimer -= dt;
      if (state.phaseTimer <= 0) {
        state.phase = "playing";
        setMessage("");
      }
      break;

    case "playing": {
      // mode waves (paused while frightened, like the arcade)
      if (state.frightTimer > 0) {
        state.frightTimer -= dt;
        if (state.frightTimer <= 0) {
          state.frightTimer = 0;
          for (const g of ghosts) g.frightened = false;
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
    if (k >= 1) camTween = null;
  }
  const targetPos = pac.cell ? pac.pos : new THREE.Vector3(0, LAYER_H, 0);
  const delta = targetPos.clone().sub(controls.target).multiplyScalar(Math.min(1, dt * 5));
  controls.target.add(delta);
  camera.position.add(delta);
  autoRotateCamera(dt);
  controls.update();
  updateCompass();

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
setMessage("PAC-MAN 3D", "パックマン 3D — PRESS ENTER TO START");
requestAnimationFrame(tick);

// debug/test hook: lets automated tests drive frames when rAF is throttled
window.__pacman3d = {
  state, pac, ghosts, camera, controls,
  step(ms) { lastTime = performance.now() - ms; tick(performance.now()); },
};
