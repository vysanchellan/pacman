# PAC-MAN 3D

Classic Pac-Man, extended into a true third dimension: the maze has **three stacked floors**
connected by vertical shafts, and every entity — Pac-Man and all four ghosts — moves in
**six directions** (north / south / east / west / up / down).

![Stack](https://img.shields.io/badge/three.js-r164-blue) ![Build](https://img.shields.io/badge/build-none%20needed-brightgreen)

## Play

No build step. Serve the folder with any static server and open it:

```bash
npx serve .
# or
python -m http.server 8000
```

Then visit `http://localhost:8000` (or deploy to GitHub Pages — it works as-is).

## Controls

| Input | Action |
|---|---|
| `W A S D` / Arrow keys | Move on the current floor (camera-relative) |
| `E` / `Space` | Move up a floor (at a glowing shaft) |
| `Q` / `Shift` | Move down a floor (at a glowing shaft) |
| Mouse drag / wheel | Orbit and zoom the camera |
| `Enter` | Start / restart |

Cyan glowing columns mark the vertical shafts where you can change floors.
Floors above and below you fade out so the current floor is always readable.

## The ghosts — classic AI in 3D

All four ghost personalities are faithful ports of the arcade logic, with targeting and
pathing generalized to `(floor, row, col)` space and six-way movement:

- **Blinky** (red) — targets Pac-Man's cell directly.
- **Pinky** (pink) — targets 4 cells ahead of Pac-Man's heading, including straight up or
  down a shaft.
- **Inky** (cyan) — doubles the vector from Blinky through the point 2 cells ahead of
  Pac-Man.
- **Clyde** (orange) — chases like Blinky when more than 8 cells away (3D Euclidean),
  otherwise retreats to his corner.

Scatter/chase waves, the no-reversing rule, frightened mode with blinking, eaten-ghost
eyes returning to the house, staggered house releases, and the 200/400/800/1600 eat chain
all work exactly like the original — the scatter corners are just spread across different
floors now.

## Tech

- [three.js](https://threejs.org/) via CDN import map — zero dependencies, zero build.
- Vanilla ES modules: `src/maze.js` (3D maze + movement rules), `src/ghosts.js` (AI),
  `src/main.js` (engine/rendering), `src/audio.js` (WebAudio synth SFX).
- `node tools/validate.mjs` — BFS sanity check that every pellet in the 3D maze is
  reachable and no cell is a dead-end trap.

## Roadmap

This is level 1 of a longer project: more levels, bigger mazes, more floors, difficulty
scaling per level, fruit bonuses, and mobile/touch controls are planned.
