// Classic ghost AI, generalized to three dimensions.
// Each ghost keeps its arcade personality; targeting simply happens in
// (layer, row, col) space and movement considers all six directions,
// including the wrap-around tunnel row.
import { DIRS, stepCell, GHOST_HOUSE, SCATTER_TARGETS } from "./maze.js";

export const GHOST_DEFS = [
  { name: "blinky", color: 0xff0000, releaseDelay: 0 },
  { name: "pinky", color: 0xffb8ff, releaseDelay: 2 },
  { name: "inky", color: 0x00ffff, releaseDelay: 5 },
  { name: "clyde", color: 0xffb852, releaseDelay: 8 },
];

const dist2 = (a, b) =>
  (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

// Target cell for a ghost given the current mode.
// pac: { cell:[l,r,c], dir:[dl,dr,dc] }
export function pickTarget(name, mode, ghostCell, pac, blinkyCell) {
  if (mode === "scatter") return SCATTER_TARGETS[name];
  switch (name) {
    case "blinky":
      // Blinky targets Pac-Man directly.
      return pac.cell;
    case "pinky": {
      // Pinky ambushes 4 cells ahead of Pac-Man — in any of the 6 directions,
      // including straight up or down a shaft.
      const d = pac.dir;
      return [pac.cell[0] + 4 * d[0], pac.cell[1] + 4 * d[1], pac.cell[2] + 4 * d[2]];
    }
    case "inky": {
      // Inky doubles the vector from Blinky to the point 2 cells ahead of Pac-Man.
      const d = pac.dir;
      const pivot = [pac.cell[0] + 2 * d[0], pac.cell[1] + 2 * d[1], pac.cell[2] + 2 * d[2]];
      return [
        blinkyCell[0] + 2 * (pivot[0] - blinkyCell[0]),
        blinkyCell[1] + 2 * (pivot[1] - blinkyCell[1]),
        blinkyCell[2] + 2 * (pivot[2] - blinkyCell[2]),
      ];
    }
    case "clyde":
      // Clyde chases like Blinky when far, retreats to his corner when
      // within 8 cells (3D Euclidean).
      return dist2(ghostCell, pac.cell) > 64 ? pac.cell : SCATTER_TARGETS.clyde;
  }
}

// Choose the next direction at a cell. Ghosts may not reverse, and pick the
// legal direction that minimizes straight-line distance to the target
// (the original arcade rule, in 3D). Frightened ghosts pick randomly.
export function chooseDirection(cell, currentDir, target, frightened, rng = Math.random) {
  const [l, r, c] = cell;
  const reverse = currentDir ? [-currentDir[0], -currentDir[1], -currentDir[2]] : null;
  const options = [];
  for (const { v } of DIRS) {
    if (reverse && v[0] === reverse[0] && v[1] === reverse[1] && v[2] === reverse[2]) continue;
    const next = stepCell(l, r, c, v);
    if (next) options.push({ v, next });
  }
  if (options.length === 0) return reverse; // dead end: only then reverse
  if (frightened) return options[Math.floor(rng() * options.length)].v;
  let best = options[0];
  let bestD = Infinity;
  for (const o of options) {
    const d = dist2(o.next, target);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best.v;
}

// BFS shortest-path first step — used by eaten-ghost eyes so they always
// find their way home (greedy steering can orbit a wall forever).
export function bfsDirection(from, to) {
  const key = (c) => `${c[0]},${c[1]},${c[2]}`;
  const target = key(to);
  if (key(from) === target) return null;
  const prev = new Map([[key(from), null]]);
  const queue = [from];
  while (queue.length) {
    const cell = queue.shift();
    for (const { v } of DIRS) {
      const next = stepCell(cell[0], cell[1], cell[2], v);
      if (!next) continue;
      const k = key(next);
      if (prev.has(k)) continue;
      prev.set(k, { cell, dir: v });
      if (k === target) {
        // walk back to find the first step
        let cur = prev.get(k);
        while (key(cur.cell) !== key(from)) cur = prev.get(key(cur.cell));
        return cur.dir;
      }
      queue.push(next);
    }
  }
  return null;
}

export { GHOST_HOUSE, SCATTER_TARGETS };
