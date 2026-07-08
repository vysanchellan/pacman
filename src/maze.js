// 3D maze definition. 3 layers (floors), each 13x13.
// Legend:
//   #  wall
//   .  pellet
//   o  power pellet
//   X  vertical shaft cell (open, has pellet, allows moving between floors)
//   -  ghost house door (ghost-only, scripted passage)
//   G  ghost house interior
//   P  pac-man spawn (open, no pellet)
//   (space) open, no pellet

export const COLS = 13;
export const ROWS = 13;
export const LAYERS = 3;

// layer 0 = bottom floor, layer 2 = top floor
const LAYER_MAPS = [
  // ---- layer 0 (bottom) ----
  [
    "#############",
    "#o....#....o#",
    "#.###.#.###.#",
    "#.#...X...#.#",
    "#.#.#####.#.#",
    "#.....#.....#",
    "###.#.#.#.###",
    "#.....#.....#",
    "#.#.#####.#.#",
    "#.#...X...#.#",
    "#.###.#.###.#",
    "#o....#....o#",
    "#############",
  ],
  // ---- layer 1 (middle, ghost house) ----
  [
    "#############",
    "#.....X.....#",
    "#.###.#.###.#",
    "#...........#",
    "#.#.##-##.#.#",
    "#.#.#GGG#.#.#",
    "#X..#####..X#",
    "#.#.......#.#",
    "#.#.#####.#.#",
    "#.....P.....#",
    "#.###.#.###.#",
    "#X....#....X#",
    "#############",
  ],
  // ---- layer 2 (top) ----
  [
    "#############",
    "#o....X....o#",
    "#.###.#.###.#",
    "#.....#.....#",
    "###.#.#.#.###",
    "#.....#.....#",
    "#X.#.....#.X#",
    "#.....#.....#",
    "###.#.#.#.###",
    "#.....#.....#",
    "#.###.#.###.#",
    "#X....o....X#",
    "#############",
  ],
];

export const WALL = "#";
export const DOOR = "-";
export const HOUSE = "G";

export function cellAt(layer, row, col) {
  if (layer < 0 || layer >= LAYERS) return WALL;
  if (row < 0 || row >= ROWS) return WALL;
  if (col < 0 || col >= COLS) return WALL;
  return LAYER_MAPS[layer][row][col];
}

// Open for normal (non-scripted) movement: walls, door and house interior block.
export function isOpen(layer, row, col) {
  const ch = cellAt(layer, row, col);
  return ch !== WALL && ch !== DOOR && ch !== HOUSE;
}

// A vertical move between adjacent layers is allowed when both cells are open
// and at least one of them is a shaft cell.
export function canMoveVertical(fromLayer, toLayer, row, col) {
  if (Math.abs(toLayer - fromLayer) !== 1) return false;
  if (!isOpen(fromLayer, row, col) || !isOpen(toLayer, row, col)) return false;
  return cellAt(fromLayer, row, col) === "X" || cellAt(toLayer, row, col) === "X";
}

// The six axis directions: [dLayer, dRow, dCol]
export const DIRS = [
  { key: "east", v: [0, 0, 1] },
  { key: "west", v: [0, 0, -1] },
  { key: "south", v: [0, 1, 0] },
  { key: "north", v: [0, -1, 0] },
  { key: "up", v: [1, 0, 0] },
  { key: "down", v: [-1, 0, 0] },
];

export function canStep(layer, row, col, dir) {
  const [dl, dr, dc] = dir;
  if (dl !== 0) return canMoveVertical(layer, layer + dl, row, col);
  return isOpen(layer, row + dr, col + dc);
}

export function collectCells() {
  const pellets = [];
  const powerPellets = [];
  const walls = [];
  const shafts = [];
  let pacmanSpawn = null;
  let doorCell = null;
  const houseCells = [];

  for (let l = 0; l < LAYERS; l++) {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const ch = cellAt(l, r, c);
        if (ch === WALL) walls.push([l, r, c]);
        else if (ch === ".") pellets.push([l, r, c]);
        else if (ch === "o") powerPellets.push([l, r, c]);
        else if (ch === "X") {
          pellets.push([l, r, c]);
          shafts.push([l, r, c]);
        } else if (ch === "P") pacmanSpawn = [l, r, c];
        else if (ch === DOOR) doorCell = [l, r, c];
        else if (ch === HOUSE) houseCells.push([l, r, c]);
      }
    }
  }
  return { pellets, powerPellets, walls, shafts, pacmanSpawn, doorCell, houseCells };
}

// Ghost spawns and scripted house-exit geometry.
export const GHOST_HOUSE = {
  door: [1, 4, 6], // [layer, row, col]
  outside: [1, 3, 6], // first normal cell after leaving the house
  inside: [
    [1, 5, 6], // center slot (Pinky)
    [1, 5, 5], // left slot (Inky)
    [1, 5, 7], // right slot (Clyde)
  ],
};

// 3D scatter corners, one per ghost, spread across floors.
export const SCATTER_TARGETS = {
  blinky: [2, 1, 11],
  pinky: [2, 1, 1],
  inky: [0, 11, 11],
  clyde: [0, 11, 1],
};
