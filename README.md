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
| Arrow keys / `W A S D` | Move on the current floor (camera-relative) |
| `PgUp` (or `E` / `Space`) | Go up a floor — sits right above the arrow keys |
| `PgDn` (or `Q` / `Shift`) | Go down a floor |
| On-screen `▲` / `▼` buttons | Same, for mouse or touch |
| `C` | Cycle camera: FOLLOW / FIXED / TOP-DOWN |
| Mouse drag / wheel | Orbit and zoom the camera |

Three camera views (cycled with `C`, shown as a toast):
- **FOLLOW** — drifts gently behind Pac-Man's heading (slow, eased, with a deadband so
  the view stays calm; it only rotates while he's actually moving).
- **FIXED** — completely steady view, zero rotation, for maximum focus.
- **TOP-DOWN** — tactical overhead view.

Dragging the mouse pauses any auto-rotation for a few seconds. Floor changes glide with
an ease-in-out and the floor fade crossfades during the ride.

## Art direction

Anime/cel-shaded look throughout: toon-shaded (3-step gradient) Pac-Man and ghosts with
inked outlines, big sparkly anime eyes (each ghost has its own iris color), blush marks
on Pac-Man, wavy spirit skirts and a floating bob on the ghosts, soft bloom glow over
the neon maze, a starfield, and drifting sakura petals. The HUD uses rounded anime-style
typography (Baloo 2 / M PLUS Rounded 1c) on violet glass panels.
| `Enter` | Start / restart |

Floor changes are **queued**: press `PgUp`/`PgDn` any time and Pac-Man rides the next
shaft he crosses (the queue expires after a few seconds; the ▲/▼ button lights up while
one is pending). One press moves exactly one floor.

Cyan glowing columns mark the vertical shafts; they pulse when you're standing on one,
with a `▲ PGUP / ▼ PGDN` prompt on screen. Each floor has its own color (teal / blue /
violet). The floor you're on renders solid; the others keep bright wireframe outlines so
you can always read the whole maze. A floor-stack widget on the right shows which floor
you and each ghost are on.

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
