import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  LAYERS, ROWS, COLS, cellAt, canStep, canMoveVertical, collectCells, GHOST_HOUSE,
} from "./maze.js";
import { GHOST_DEFS, pickTarget, chooseDirection, bfsDirection } from "./ghosts.js";
import { sfx } from "./audio.js";

// ---------------------------------------------------------------- constants
const LAYER_H = 2.4; // world height between floors
const PAC_SPEED = 3.6; // cells per second
const GHOST_SPEED = 3.1;
const FRIGHT_SPEED = 2.1;
const EYES_SPEED = 7.0;
const EXIT_SPEED = 2.4;
const FRIGHT_TIME = 8.0;
const FRIGHT_BLINK = 2.5;
// scatter/chase wave schedule (seconds); last chase runs forever
const WAVES = [
  ["scatter", 7], ["chase", 20], ["scatter", 7], ["chase", 20],
  ["scatter", 5], ["chase", 20], ["scatter", 5], ["chase", Infinity],
];

const cellToWorld = (l, r, c, out = new THREE.Vector3()) =>
  out.set(c - (COLS - 1) / 2, l * LAYER_H, r - (ROWS - 1) / 2);

// ---------------------------------------------------------------- three.js setup
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x02020a);
scene.fog = new THREE.Fog(0x02020a, 22, 55);

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 200);
camera.position.set(0, LAYER_H * 2 + 9, 13);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.minDistance = 5;
controls.maxDistance = 32;
controls.maxPolarAngle = Math.PI * 0.49;

scene.add(new THREE.AmbientLight(0x8888aa, 0.7));
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(8, 20, 6);
scene.add(sun);
const pacLight = new THREE.PointLight(0xffe000, 14, 9);
scene.add(pacLight);

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- maze visuals
const mazeData = collectCells();
const layerWallMaterials = [];

{
  const wallGeo = new THREE.BoxGeometry(1, 1.0, 1);
  for (let l = 0; l < LAYERS; l++) {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x1428c8,
      emissive: 0x0a14aa,
      emissiveIntensity: 0.55,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    layerWallMaterials.push(mat);
    const cellsHere = mazeData.walls.filter(([wl]) => wl === l);
    const inst = new THREE.InstancedMesh(wallGeo, mat, cellsHere.length);
    const m = new THREE.Matrix4();
    const v = new THREE.Vector3();
    cellsHere.forEach(([wl, r, c], i) => {
      cellToWorld(wl, r, c, v);
      m.makeTranslation(v.x, v.y, v.z);
      inst.setMatrixAt(i, m);
    });
    inst.renderOrder = 1;
    scene.add(inst);

    // faint floor plate under each layer
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(COLS, ROWS),
      new THREE.MeshBasicMaterial({
        color: 0x0a0a2a, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false,
      })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = l * LAYER_H - 0.55;
    scene.add(floor);
  }

  // vertical shaft beams: show where floors connect
  const shaftMat = new THREE.MeshBasicMaterial({
    color: 0x00ffcc, transparent: true, opacity: 0.14, depthWrite: false,
  });
  const shaftGeo = new THREE.CylinderGeometry(0.32, 0.32, LAYER_H, 12, 1, true);
  for (const [l, r, c] of mazeData.shafts) {
    for (const nl of [l - 1, l + 1]) {
      if (nl > l && canMoveVertical(l, nl, r, c)) {
        const beam = new THREE.Mesh(shaftGeo, shaftMat);
        cellToWorld(l, r, c, beam.position);
        beam.position.y += LAYER_H / 2;
        scene.add(beam);
      }
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

// pellets
const pelletGeo = new THREE.SphereGeometry(0.09, 10, 8);
const powerGeo = new THREE.SphereGeometry(0.24, 14, 12);
const pelletMat = new THREE.MeshStandardMaterial({
  color: 0xffd9a8, emissive: 0xffb060, emissiveIntensity: 0.7,
});
const pelletKey = (l, r, c) => `${l},${r},${c}`;
const pelletMeshes = new Map(); // key -> { mesh, power }
const powerMeshes = [];

function spawnPellets() {
  for (const { mesh } of pelletMeshes.values()) scene.remove(mesh);
  pelletMeshes.clear();
  powerMeshes.length = 0;
  for (const [l, r, c] of mazeData.pellets) {
    const mesh = new THREE.Mesh(pelletGeo, pelletMat);
    cellToWorld(l, r, c, mesh.position);
    scene.add(mesh);
    pelletMeshes.set(pelletKey(l, r, c), { mesh, power: false });
  }
  for (const [l, r, c] of mazeData.powerPellets) {
    const mesh = new THREE.Mesh(powerGeo, pelletMat.clone());
    cellToWorld(l, r, c, mesh.position);
    scene.add(mesh);
    pelletMeshes.set(pelletKey(l, r, c), { mesh, power: true });
    powerMeshes.push(mesh);
  }
}

// ---------------------------------------------------------------- pac-man visual
const PAC_R = 0.42;
const mouthGeos = [];
for (let i = 0; i < 7; i++) {
  const mouth = (i / 6) * 0.9; // radians of half-mouth opening
  const g = new THREE.SphereGeometry(PAC_R, 28, 20, mouth, Math.PI * 2 - 2 * mouth);
  g.rotateZ(Math.PI / 2); // mouth opens along +X so quaternion aiming works
  mouthGeos.push(g);
}
const pacMesh = new THREE.Mesh(
  mouthGeos[3],
  new THREE.MeshStandardMaterial({ color: 0xffe000, emissive: 0x665500, roughness: 0.35 })
);
scene.add(pacMesh);

// ---------------------------------------------------------------- ghost visuals
function makeGhostMesh(color) {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.4 });
  const body = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.4, 0.42, 20), bodyMat);
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(0.36, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), bodyMat);
  dome.position.y = 0.21;
  trunk.position.y = 0;
  body.add(trunk, dome);
  body.position.y = -0.05;
  group.add(body);

  const eyes = new THREE.Group();
  for (const side of [-1, 1]) {
    const white = new THREE.Mesh(
      new THREE.SphereGeometry(0.11, 12, 10),
      new THREE.MeshBasicMaterial({ color: 0xffffff }));
    white.position.set(side * 0.15, 0.18, 0.28);
    const pupil = new THREE.Mesh(
      new THREE.SphereGeometry(0.055, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0x2222cc }));
    pupil.position.set(side * 0.15, 0.18, 0.37);
    eyes.add(white, pupil);
  }
  group.add(eyes);
  return { group, body, bodyMat, eyes };
}

// ---------------------------------------------------------------- entities
function segmentLength(dir) {
  return dir && dir[0] !== 0 ? LAYER_H : 1;
}

const pac = {
  cell: null, dir: [0, 0, 0], desired: null, next: null, t: 0,
  pos: new THREE.Vector3(), mouthPhase: 0, moving: false,
};

const ghosts = GHOST_DEFS.map((def, i) => {
  const vis = makeGhostMesh(def.color);
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
  $("layer").textContent = `${(pac.cell ? pac.cell[0] : 1) + 1} / ${LAYERS}`;
}
function addScore(n) {
  state.score += n;
  if (state.score > state.high) {
    state.high = state.score;
    localStorage.setItem("pacman3d-high", String(state.high));
  }
}

function resetPositions() {
  pac.cell = [...mazeData.pacmanSpawn];
  pac.dir = [0, 0, 0];
  pac.desired = null;
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
const keyState = {};
addEventListener("keydown", (e) => {
  keyState[e.code] = true;
  sfx.unlock();

  if (e.code === "Enter") {
    if (state.phase === "menu" || state.phase === "gameover" || state.phase === "win") {
      newGame();
    }
    return;
  }
  if (state.phase !== "playing" && state.phase !== "ready") return;

  const dir = keyToDir(e.code);
  if (dir) {
    pac.desired = dir;
    e.preventDefault();
  }
});
addEventListener("keyup", (e) => { keyState[e.code] = false; });

// Horizontal input is camera-relative: "up" means away from the camera,
// snapped to the nearest maze axis, so steering stays intuitive while orbiting.
function keyToDir(code) {
  if (code === "KeyE" || code === "Space") return [1, 0, 0];
  if (code === "KeyQ" || code === "ShiftLeft" || code === "ShiftRight") return [-1, 0, 0];

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

// ---------------------------------------------------------------- pac-man update
function updatePac(dt) {
  const speed = PAC_SPEED;

  if (!pac.moving) {
    // try to start moving toward desired (or keep last direction)
    const tryDirs = [pac.desired, pac.dir].filter(Boolean);
    for (const d of tryDirs) {
      if ((d[0] || d[1] || d[2]) && canStep(...pac.cell, d)) {
        pac.dir = d;
        pac.next = [pac.cell[0] + d[0], pac.cell[1] + d[1], pac.cell[2] + d[2]];
        pac.t = 0;
        pac.moving = true;
        break;
      }
    }
  } else {
    // mid-segment reversal
    if (pac.desired && pac.dir &&
        pac.desired[0] === -pac.dir[0] && pac.desired[1] === -pac.dir[1] && pac.desired[2] === -pac.dir[2]) {
      const tmp = pac.cell;
      pac.cell = pac.next;
      pac.next = tmp;
      pac.t = 1 - pac.t;
      pac.dir = pac.desired;
    }
    pac.t += (speed * dt) / segmentLength(pac.dir);
    if (pac.t >= 1) {
      pac.cell = pac.next;
      pac.moving = false;
      pac.t = 0;
      if (pac.dir[0] !== 0) sfx.layerShift();
      eatAt(pac.cell);
      // immediately chain into next segment: prefer desired, else continue
      updatePac(0);
    }
  }

  // world position
  const a = cellToWorld(...pac.cell, new THREE.Vector3());
  if (pac.moving) {
    const b = cellToWorld(...pac.next, new THREE.Vector3());
    pac.pos.lerpVectors(a, b, pac.t);
  } else {
    pac.pos.copy(a);
  }

  // mouth + orientation
  pac.mouthPhase += dt * (pac.moving ? 10 : 3);
  const idx = Math.floor((Math.sin(pac.mouthPhase) * 0.5 + 0.5) * (mouthGeos.length - 1));
  pacMesh.geometry = mouthGeos[idx];
  pacMesh.position.copy(pac.pos);
  if (pac.dir && (pac.dir[0] || pac.dir[1] || pac.dir[2])) {
    const world = new THREE.Vector3(pac.dir[2], pac.dir[0], pac.dir[1]).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), world);
    pacMesh.quaternion.slerp(q, Math.min(1, dt * 14));
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

  // world position
  const a = cellToWorld(...g.cell, new THREE.Vector3());
  if (g.next) {
    const b = cellToWorld(...g.next, new THREE.Vector3());
    g.pos.lerpVectors(a, b, g.t);
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
  const { group, body, bodyMat, eyes } = g.vis;
  group.position.copy(g.pos);

  const isEyes = g.state === "eyes" || g.state === "entering";
  body.visible = !isEyes;

  if (g.frightened && !isEyes) {
    const blinking = state.frightTimer < FRIGHT_BLINK &&
      Math.floor(state.frightTimer * 5) % 2 === 0;
    bodyMat.color.setHex(blinking ? 0xeeeeee : 0x2233dd);
  } else {
    bodyMat.color.setHex(g.color);
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
      addScore(100 * 2 ** state.eatChain); // 200 / 400 / 800 / 1600
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

// ---------------------------------------------------------------- wall fading
// Floors above/below Pac-Man fade out so you can always see where you are.
function updateLayerVisibility() {
  const pl = pac.cell ? pac.cell[0] : 1;
  for (let l = 0; l < LAYERS; l++) {
    const d = Math.abs(l - pl);
    layerWallMaterials[l].opacity = d === 0 ? 0.92 : d === 1 ? 0.22 : 0.07;
    layerWallMaterials[l].emissiveIntensity = d === 0 ? 0.6 : 0.15;
  }
}

// ---------------------------------------------------------------- main loop
let lastTime = performance.now();

function tick(now) {
  requestAnimationFrame(tick);
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;
  state.elapsed += dt;

  // power pellet pulse
  const pulse = 1 + Math.sin(state.elapsed * 6) * 0.25;
  for (const mesh of powerMeshes) mesh.scale.setScalar(pulse);

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
      updateHud();
      break;
    }

    case "dying": {
      state.phaseTimer -= dt;
      // spiral-shrink animation
      const p = Math.max(state.phaseTimer / 1.6, 0);
      pacMesh.scale.setScalar(Math.max(p, 0.001));
      pacMesh.rotation.y += dt * 12;
      if (state.phaseTimer <= 0) {
        pacMesh.scale.setScalar(1);
        pacMesh.rotation.set(0, 0, 0);
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

  updateLayerVisibility();

  // camera follows pac-man smoothly
  const targetPos = pac.cell ? pac.pos : new THREE.Vector3(0, LAYER_H, 0);
  const delta = targetPos.clone().sub(controls.target).multiplyScalar(Math.min(1, dt * 4));
  controls.target.add(delta);
  camera.position.add(delta);
  controls.update();

  renderer.render(scene, camera);
}

// ---------------------------------------------------------------- boot
spawnPellets();
state.pelletsLeft = pelletMeshes.size;
resetPositions();
updateHud();
setMessage("PAC-MAN 3D", "PRESS ENTER TO START");
requestAnimationFrame(tick);

// debug/test hook: lets automated tests drive frames when rAF is throttled
window.__pacman3d = {
  state, pac, ghosts,
  step(ms) { lastTime = performance.now() - ms; tick(performance.now()); },
};
