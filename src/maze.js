// 3D maze: the original arcade maze layout (28x31), stacked as 3 floors of a
// castle and connected by vertical shafts.
// Legend:
//   #  wall
//   .  pellet
//   o  power pellet
//   X  vertical shaft cell (open, has pellet, allows moving between floors)
//   -  ghost house door (ghost-only, scripted passage)
//   G  ghost house interior
//   P  pac-man spawn (open, no pellet)
//   (space) open, no pellet
// The tunnel row (14) is open at both edges and wraps around, like the arcade.

export const COLS = 28;
export const ROWS = 31;
export const LAYERS = 3;

// the original maze, adapted: ghost house sits on the middle floor only
const OG = [
  "############################",
  "#............##............#",
  "#.####.#####.##.#####.####.#",
  "#o####.#####.##.#####.####o#",
  "#.####.#####.##.#####.####.#",
  "#..........................#",
  "#.####.##.########.##.####.#",
  "#.####.##.########.##.####.#",
  "#......##....##....##......#",
  "######.##### ## #####.######",
  "######.##### ## #####.######",
  "######.##          ##.######",
  "######.## ###--### ##.######",
  "######.## #GGGGGG# ##.######",
  "      .   #GGGGGG#   .      ",
  "######.## #GGGGGG# ##.######",
  "######.## ######## ##.######",
  "######.##          ##.######",
  "######.## ######## ##.######",
  "######.## ######## ##.######",
  "#............##............#",
  "#.####.#####.##.#####.####.#",
  "#o..##.......P........##..o#",
  "###.##.##.########.##.##.###",
  "###.##.##.########.##.##.###",
  "#......##....##....##......#",
  "#.##########.##.##########.#",
  "#.##########.##.##########.#",
  "#..........................#",
  "#..........................#",
  "############################",
];

// shaft cells — identical (row, col) on every floor so the columns stack
const SHAFTS = [
  [1, 6], [1, 21],
  [5, 6], [5, 21],
  [8, 12], [8, 15],
  [14, 6], [14, 21],
  [22, 6], [22, 21],
  [28, 13],
];

function buildLayer(isMiddle) {
  return OG.map((row, r) => {
    let out = "";
    for (let c = 0; c < COLS; c++) {
      let ch = row[c];
      if (!isMiddle) {
        // seal the ghost house on the other floors; it reads as the keep
        if (ch === "G" || ch === "-") ch = "#";
        if (ch === "P") ch = ".";
      }
      if (SHAFTS.some(([sr, sc]) => sr === r && sc === c)) ch = "X";
      out += ch;
    }
    return out;
  });
}

const LAYER_MAPS = [buildLayer(false), buildLayer(true), buildLayer(false)];

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

// The cell one step away in a direction, with arcade tunnel wrap on the
// columns; null when the move is blocked.
export function stepCell(layer, row, col, dir) {
  const [dl, dr, dc] = dir;
  if (dl !== 0) {
    return canMoveVertical(layer, layer + dl, row, col) ? [layer + dl, row, col] : null;
  }
  const nr = row + dr;
  let nc = col + dc;
  if (nc < 0) nc = COLS - 1;
  else if (nc >= COLS) nc = 0;
  if (nr < 0 || nr >= ROWS) return null;
  return isOpen(layer, nr, nc) ? [layer, nr, nc] : null;
}

export function canStep(layer, row, col, dir) {
  return stepCell(layer, row, col, dir) !== null;
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

// Ghost spawns and scripted house-exit geometry (middle floor keep).
export const GHOST_HOUSE = {
  door: [1, 12, 13], // [layer, row, col]
  outside: [1, 11, 13], // first normal cell after leaving the house
  inside: [
    [1, 13, 13], // center slot (Pinky)
    [1, 13, 11], // left slot (Inky)
    [1, 13, 15], // right slot (Clyde)
  ],
};

// 3D scatter corners, one per ghost, spread across floors.
export const SCATTER_TARGETS = {
  blinky: [2, 1, 26],
  pinky: [2, 1, 1],
  inky: [0, 29, 26],
  clyde: [0, 29, 1],
};
