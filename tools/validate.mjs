// Maze sanity checker: run with `node tools/validate.mjs`
import {
  LAYERS, ROWS, COLS, cellAt, isOpen, canStep, DIRS, collectCells, GHOST_HOUSE,
} from "../src/maze.js";

const { pellets, powerPellets, pacmanSpawn } = collectCells();
if (!pacmanSpawn) throw new Error("No pacman spawn (P) found");

// BFS over all open cells from pacman spawn using the same movement rules the game uses.
const key = (l, r, c) => `${l},${r},${c}`;
const visited = new Set([key(...pacmanSpawn)]);
const queue = [pacmanSpawn];
while (queue.length) {
  const [l, r, c] = queue.shift();
  for (const { v } of DIRS) {
    if (!canStep(l, r, c, v)) continue;
    const next = [l + v[0], r + v[1], c + v[2]];
    const k = key(...next);
    if (!visited.has(k)) {
      visited.add(k);
      queue.push(next);
    }
  }
}

let errors = 0;
for (const [l, r, c] of [...pellets, ...powerPellets]) {
  if (!visited.has(key(l, r, c))) {
    console.error(`UNREACHABLE: (layer ${l}, row ${r}, col ${c}) '${cellAt(l, r, c)}'`);
    errors++;
  }
}

// Every open cell should have at least 2 exits (no dead-end traps for ghost AI).
for (let l = 0; l < LAYERS; l++) {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (!isOpen(l, r, c)) continue;
      const exits = DIRS.filter(({ v }) => canStep(l, r, c, v)).length;
      if (exits < 2) {
        console.error(`DEAD END (${exits} exit): layer ${l}, row ${r}, col ${c}`);
        errors++;
      }
    }
  }
}

// Ghost house door must sit next to its outside cell.
const [dl, dr, dc] = GHOST_HOUSE.door;
const [ol, or_, oc] = GHOST_HOUSE.outside;
if (cellAt(dl, dr, dc) !== "-") { console.error("Door cell mismatch"); errors++; }
if (!isOpen(ol, or_, oc)) { console.error("Outside cell not open"); errors++; }

console.log(`Pellets: ${pellets.length}, Power pellets: ${powerPellets.length}`);
console.log(`Open cells reached: ${visited.size}`);
console.log(errors ? `FAILED with ${errors} error(s)` : "MAZE OK");
process.exit(errors ? 1 : 0);
