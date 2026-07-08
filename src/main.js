import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import {
  LAYERS, ROWS, COLS, canStep, canMoveVertical, collectCells, GHOST_HOUSE,
} from "./maze.js";
import { GHOST_DEFS, pickTarget, chooseDirection, bfsDirection } from "./ghosts.js";
import { sfx } from "./audio.js";

// ---------------------------------------------------------------- constants
const LAYER_H = 2.4; // world height between floors
const PAC_SPEED = 3.8; // cells per second
const GHOST_SPEED = 3.1;
const FRIGHT_SPEED = 2.1;
const EYES_SPEED = 7.0;
const EXIT_SPEED = 2.4;
const FRIGHT_TIME = 8.0;
const FRIGHT_BLINK = 2.5;
const PENDING_VERT_TTL = 6.0; // queued floor-change expires after this many seconds
// scatter/chase wave schedule (seconds); last chase runs forever
const WAVES = [
  ["scatter", 7], ["chase", 20], ["scatter", 7], ["chase", 20],
  ["scatter", 5], ["chase", 20], ["scatter", 5], ["chase", Infinity],
];

// per-floor accent colors: bottom teal, middle blue, top violet
const FLOOR_COLORS = [0x2dd6c8, 0x4d6bff, 0xb36bff];

// anime iris color per ghost
const IRIS_COLORS = { blinky: 0xff3355, pinky: 0xff66aa, inky: 0x33ddff, clyde: 0xffaa33 };

const OUTLINE_COLOR = 0x140a24;

const cellToWorld = (l, r, c, out = new THREE.Vector3()) =>
  out.set(c - (COLS - 1) / 2, l * LAYER_H, r - (ROWS - 1) / 2);

// ease-in-out used for vertical rides and camera blends
const smooth = (t) => t * t * (3 - 2 * t);

// ---------------------------------------------------------------- three.js setup
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x070312);
scene.fog = new THREE.Fog(0x070312, 30, 80);

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 220);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

// soft anime-glow post-processing
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.5, 0.55, 0.8);
composer.addPass(bloom);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.minDistance = 5;
controls.maxDistance = 34;
controls.maxPolarAngle = Math.PI * 0.49;

scene.add(new THREE.HemisphereLight(0x8f9dff, 0x2a1440, 0.85));
const sun = new THREE.DirectionalLight(0xfff4e0, 1.0);
sun.position.set(8, 20, 6);
scene.add(sun);
const pacLight = new THREE.PointLight(0xffe000, 14, 10);
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
// inverted-hull outline for that inked anime look
function addOutline(mesh, scale = 1.07) {
  const outline = new THREE.Mesh(
    mesh.geometry,
    new THREE.MeshBasicMaterial({ color: OUTLINE_COLOR, side: THREE.BackSide })
  );
  outline.position.copy(mesh.position);
  outline.rotation.copy(mesh.rotation);
  outline.scale.copy(mesh.scale).multiplyScalar(scale);
  mesh.parent ? mesh.parent.add(outline) : null;
  return outline;
}

// ---------------------------------------------------------------- ambience
// starfield + drifting sakura petals
{
  const starGeo = new THREE.BufferGeometry();
  const starPos = new Float32Array(400 * 3);
  for (let i = 0; i < 400; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(60 + Math.random() * 40);
    v.y = Math.abs(v.y) * 0.6 - 5;
    starPos.set([v.x, v.y, v.z], i * 3);
  }
  starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
  scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({
    color: 0x9aa8ff, size: 0.35, transparent: true, opacity: 0.8, sizeAttenuation: true,
  })));
}

const PETALS = 140;
const petalGeo = new THREE.BufferGeometry();
const petalPos = new Float32Array(PETALS * 3);
const petalSeed = new Float32Array(PETALS);
for (let i = 0; i < PETALS; i++) {
  petalPos.set([(Math.random() - 0.5) * 26, Math.random() * 9 - 1, (Math.random() - 0.5) * 26], i * 3);
  petalSeed[i] = Math.random() * Math.PI * 2;
}
petalGeo.setAttribute("position", new THREE.BufferAttribute(petalPos, 3));
const petals = new THREE.Points(petalGeo, new THREE.PointsMaterial({
  color: 0xffa8d4, size: 0.14, transparent: true, opacity: 0.75, sizeAttenuation: true,
}));
scene.add(petals);

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

// ---------------------------------------------------------------- maze visuals
const mazeData = collectCells();
const wallFillMats = []; // solid fill per floor
const wallEdgeMats = []; // glowing wireframe per floor
const floorPlateMats = [];

{
  const wallGeo = new THREE.BoxGeometry(1, 1.0, 1);
  const edgeTemplate = new THREE.EdgesGeometry(wallGeo);
  const v = new THREE.Vector3();

  for (let l = 0; l < LAYERS; l++) {
    const color = FLOOR_COLORS[l];
    const cellsHere = mazeData.walls.filter(([wl]) => wl === l);

    const fillMat = new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 0.22,
      transparent: true, opacity: 0.8, depthWrite: false,
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
    color: 0xffe2b8, emissive: 0xffb060, emissiveIntensity: 0.9, transparent: true,
  }));
  powerMatByFloor.push(new THREE.MeshStandardMaterial({
    color: 0xffe2b8, emissive: 0xff9040, emissiveIntensity: 1.4, transparent: true,
  }));
}
const pelletKey = (l, r, c) => `${l},${r},${c}`;
const pelletMeshes = new Map(); // key -> { mesh, power }
const powerMeshes = [];

function spawnPellets() {
  for (const { mesh } of pelletMeshes.values()) scene.remove(mesh);
  pelletMeshes.clear();
  powerMeshes.length = 0;
  for (const [l, r, c] of mazeData.pellets) {
    const mesh = new THREE.Mesh(pelletGeo, pelletMatByFloor[l]);
    cellToWorld(l, r, c, mesh.position);
    scene.add(mesh);
    pelletMeshes.set(pelletKey(l, r, c), { mesh, power: false });
  }
  for (const [l, r, c] of mazeData.powerPellets) {
    const mesh = new THREE.Mesh(powerGeo, powerMatByFloor[l]);
    cellToWorld(l, r, c, mesh.position);
    scene.add(mesh);
    pelletMeshes.set(pelletKey(l, r, c), { mesh, power: true });
    powerMeshes.push(mesh);
  }
}

// ---------------------------------------------------------------- pac-man visual
// chibi anime style: cel-shaded chomping ball, inked outline, big sparkly
// eyes and blush marks — the mouth still opens along +X for aiming
const PAC_R = 0.42;
const mouthGeos = [];
for (let i = 0; i < 7; i++) {
  const mouth = (i / 6) * 0.9; // radians of half-mouth opening
  const g = new THREE.SphereGeometry(PAC_R, 28, 20, mouth, Math.PI * 2 - 2 * mouth);
  g.rotateZ(Math.PI / 2);
  mouthGeos.push(g);
}
const pacGroup = new THREE.Group();
const pacBody = new THREE.Mesh(mouthGeos[3], toonMat(0xffdd33));
const pacOutline = new THREE.Mesh(
  mouthGeos[3],
  new THREE.MeshBasicMaterial({ color: OUTLINE_COLOR, side: THREE.BackSide })
);
pacOutline.scale.setScalar(1.07);
pacGroup.add(pacBody, pacOutline);

for (const side of [-1, 1]) {
  const white = new THREE.Mesh(new THREE.SphereGeometry(0.105, 14, 12),
    new THREE.MeshBasicMaterial({ color: 0xffffff }));
  white.position.set(0.26, 0.24, side * 0.17);
  white.scale.set(0.7, 1.25, 1);
  const iris = new THREE.Mesh(new THREE.SphereGeometry(0.062, 12, 10),
    new THREE.MeshBasicMaterial({ color: 0x3a2410 }));
  iris.position.set(0.32, 0.24, side * 0.17);
  iris.scale.set(0.6, 1.25, 1);
  const spark = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xffffff }));
  spark.position.set(0.36, 0.28, side * 0.15);
  const blush = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xffa07a, transparent: true, opacity: 0.85 }));
  blush.position.set(0.24, 0.02, side * 0.33);
  blush.scale.set(0.5, 0.7, 1.1);
  pacGroup.add(white, iris, spark, blush);
}
scene.add(pacGroup);

// ---------------------------------------------------------------- ghost visuals
// anime spirits: cel-shaded body with a wavy skirt, inked outline, big
// colored irises with highlights, gentle floating bob
function makeGhostMesh(color, name) {
  const group = new THREE.Group();
  const bodyMat = toonMat(color);
  const body = new THREE.Group();

  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.4, 0.42, 20), bodyMat);
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(0.36, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), bodyMat);
  dome.position.y = 0.21;

  const skirtGeo = new THREE.CylinderGeometry(0.40, 0.47, 0.2, 24, 1, true);
  const sp = skirtGeo.attributes.position;
  for (let i = 0; i < sp.count; i++) {
    if (sp.getY(i) < 0) {
      const ang = Math.atan2(sp.getZ(i), sp.getX(i));
      sp.setY(i, sp.getY(i) + Math.sin(ang * 6) * 0.05);
    }
  }
  const skirt = new THREE.Mesh(skirtGeo, bodyMat.clone());
  skirt.material.side = THREE.DoubleSide;
  skirt.position.y = -0.26;

  body.add(trunk, dome, skirt);
  body.position.y = -0.02;
  for (const mesh of [trunk, dome]) {
    body.add((() => {
      const o = new THREE.Mesh(mesh.geometry,
        new THREE.MeshBasicMaterial({ color: OUTLINE_COLOR, side: THREE.BackSide }));
      o.position.copy(mesh.position);
      o.scale.setScalar(1.08);
      return o;
    })());
  }
  group.add(body);

  const eyes = new THREE.Group();
  const irisMats = [];
  for (const side of [-1, 1]) {
    const white = new THREE.Mesh(new THREE.SphereGeometry(0.115, 14, 12),
      new THREE.MeshBasicMaterial({ color: 0xffffff }));
    white.position.set(side * 0.15, 0.2, 0.29);
    white.scale.set(1, 1.3, 0.55);
    const irisMat = new THREE.MeshBasicMaterial({ color: IRIS_COLORS[name] });
    irisMats.push(irisMat);
    const iris = new THREE.Mesh(new THREE.SphereGeometry(0.062, 12, 10), irisMat);
    iris.position.set(side * 0.15, 0.19, 0.365);
    iris.scale.set(1, 1.35, 0.6);
    const spark = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff }));
    spark.position.set(side * 0.12, 0.25, 0.41);
    eyes.add(white, iris, spark);
  }
  group.add(eyes);
  return { group, body, bodyMat, skirtMat: skirt.material, eyes, irisMats };
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
  phase: "menu", // menu | ready | playing | dying | gameover | win
  phaseTimer: 0,
  score: 0,
  high: Number(localStorage.getItem("pacman3d-high") || 0),
  lives: 2, // remaining spare lives
  pelletsLeft: 0,
  waveIndex: 0,
  waveTimer: 0,
  frightTimer: 0,
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
      g.releaseTimer = g.releaseDelay;
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
    if (state.phase === "menu" || state.phase === "gameover" || state.phase === "win") {
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
// Three views, cycled with C:
//   FOLLOW — drifts gently behind Pac-Man's heading (very slow, eased)
//   FIXED  — classic steady view, no rotation at all
//   TOP    — top-down tactical view
const CAM_MODES = [
  { name: "FOLLOW", offset: new THREE.Vector3(0, 10.5, 9.5), rotate: true },
  { name: "FIXED", offset: new THREE.Vector3(0, 10.5, 9.5), rotate: false },
  { name: "TOP-DOWN", offset: new THREE.Vector3(0, 16.5, 0.02), rotate: false },
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

// ---------------------------------------------------------------- pac-man update
function tryBeginSegment() {
  const candidates = [];
  if (pac.pendingVertical) candidates.push(pac.pendingVertical);
  if (pac.desired) candidates.push(pac.desired);
  // only horizontal movement auto-continues: floor changes are one press = one floor
  if (pac.dir && (pac.dir[1] || pac.dir[2])) candidates.push(pac.dir);
  for (const d of candidates) {
    if (!canStep(...pac.cell, d)) continue;
    if (d === pac.pendingVertical) pac.pendingVertical = null;
    pac.dir = d;
    pac.next = [pac.cell[0] + d[0], pac.cell[1] + d[1], pac.cell[2] + d[2]];
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

    pac.t += (PAC_SPEED * dt) / segmentLength(pac.dir);
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
    const b = cellToWorld(...pac.next, new THREE.Vector3());
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
}

function eatAt(cell) {
  const k = pelletKey(...cell);
  const entry = pelletMeshes.get(k);
  if (!entry) return;
  scene.remove(entry.mesh);
  pelletMeshes.delete(k);
  state.pelletsLeft--;
  if (entry.power) {
    addScore(50);
    sfx.power();
    state.frightTimer = FRIGHT_TIME;
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
  if (state.pelletsLeft <= 0) {
    state.phase = "win";
    setMessage("YOU WIN!", "PRESS ENTER TO PLAY AGAIN");
    sfx.win();
  }
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
  return GHOST_SPEED;
}

function currentMode() {
  return WAVES[Math.min(state.waveIndex, WAVES.length - 1)][0];
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
    const b = cellToWorld(...g.next, new THREE.Vector3());
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
    g.dir = dir;
    g.next = [g.cell[0] + dir[0], g.cell[1] + dir[1], g.cell[2] + dir[2]];
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
  const { group, body, bodyMat, skirtMat, eyes, irisMats } = g.vis;
  group.position.copy(g.pos);
  // floating spirit bob
  body.position.y = -0.02 + Math.sin(state.elapsed * 5 + g.releaseDelay * 2) * 0.045;

  const isEyes = g.state === "eyes" || g.state === "entering";
  body.visible = !isEyes;

  if (g.frightened && !isEyes) {
    const blinking = state.frightTimer < FRIGHT_BLINK &&
      Math.floor(state.frightTimer * 5) % 2 === 0;
    const c = blinking ? 0xeeeeee : 0x2233dd;
    bodyMat.color.setHex(c);
    skirtMat.color.setHex(c);
    for (const im of irisMats) im.color.setHex(0x222244);
  } else {
    bodyMat.color.setHex(g.color);
    skirtMat.color.setHex(g.color);
    for (const im of irisMats) im.color.setHex(IRIS_COLORS[g.name]);
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
  for (let l = 0; l < LAYERS; l++) {
    const d = Math.min(Math.abs(l - fl), 2);
    wallFillMats[l].opacity = at([0.8, 0.10, 0.05], d);
    wallEdgeMats[l].opacity = at([1.0, 0.5, 0.22], d);
    floorPlateMats[l].opacity = at([0.4, 0.12, 0.12], d);
    pelletMatByFloor[l].opacity = at([1.0, 0.35, 0.15], d);
    powerMatByFloor[l].opacity = at([1.0, 0.5, 0.25], d);
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
    $("fright-bar").style.width = `${(state.frightTimer / FRIGHT_TIME) * 100}%`;
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
        const waveLen = WAVES[Math.min(state.waveIndex, WAVES.length - 1)][1];
        if (state.waveTimer >= waveLen && state.waveIndex < WAVES.length - 1) {
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
    case "win":
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
