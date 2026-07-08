# PAC-MAN 3D — Night Castle

Classic Pac-Man extended into a true third dimension: a **three-floor neon castle**
connected by vertical shafts, six-direction movement, and the four arcade ghost
personalities faithfully generalized to 3D — wrapped in an anime night-world
(cel shading, inked outlines, bloom, moon, starfield, sakura petals).

![Stack](https://img.shields.io/badge/three.js-r164-blue) ![Build](https://img.shields.io/badge/build-none%20needed-brightgreen)

## Play

No build step. Serve the folder with any static server and open it:

```bash
npx serve .
```

## Controls

| Input | Action |
|---|---|
| Arrow keys / `W A S D` | Move on the current floor (camera-relative) |
| `PgUp` (or `E` / `Space`) | Go up a floor at a shaft |
| `PgDn` (or `Q` / `Shift`) | Go down a floor at a shaft |
| On-screen `▲` / `▼` buttons | Same, for mouse or touch |
| `C` | Cycle camera: FIXED / FOLLOW / TOP-DOWN |
| Mouse drag / wheel | Orbit and zoom |
| `Enter` | Start / restart |

Floor changes are **queued**: press the key any time and you ride the next glowing
shaft you cross (one press = one floor; the queue expires after ~6 s). Shaft beams
pulse when usable, with an on-screen prompt.

## Orientation — never lose your bearings

- **FIXED camera is the default**: the map never rotates on its own, so directions
  stay constant. FOLLOW (gentle eased drift behind your heading) and TOP-DOWN are a
  `C` press away.
- A **compass dial** (bottom-left) always shows maze-north (`N`) relative to your
  screen, and its gold needle points the way you're currently travelling.
- The **floor-stack widget** (right) shows which floor you and every ghost are on.
- Your current floor renders solid; the others keep bright wireframe outlines
  (per-floor colors: teal / blue / violet) and their pellets fade, so the maze
  always reads at a glance.

## The world

A floating night castle: rounded battlement blocks with glowing edges, corner
watchtowers with conical roofs on every floor, a gradient dusk sky-dome, a huge
anime moon, a starfield, a distant ground grid, and sakura petals drifting through
the maze. Soft bloom makes the emissive things (pellets, shafts, eyes) actually glow —
tuned so Pac-Man himself no longer floods the screen with light.

## The characters — killer anime redesign

- **Pac-Man** is an **oni hunter**: deep-gold cel-shaded chomper with dark horns,
  fierce glowing slit eyes, an inked outline, and an ember trail while he runs.
- **The ghosts are yokai wraiths**: hooded lathe-built cloaks with tattered hems,
  inked outlines, a floating bob, and angry glowing eye slits. Each keeps a
  signature trait tied to its arcade personality:
  - **Blinky** (crimson) — oni horns. *The relentless one.*
  - **Pinky** (rose) — trailing ribbons. *The ambusher.*
  - **Inky** (cyan) — a white kitsune mask. *The unpredictable one.*
  - **Clyde** (amber) — hulking, wider build. *The coward.*

When eaten, a wraith collapses to just its glowing eye slits, which race back to the
castle keep to be reborn.

## How the game works

### The maze (`src/maze.js`)
Three 13×13 floors defined as ASCII maps. `#` walls, `.` pellets, `o` power pellets,
`X` shaft cells (vertical travel allowed when the matching cell on the next floor is
open), `-` the ghost-house door (ghost-only), `G` house interior, `P` spawn. All
movement rules live here: `canStep(layer,row,col,dir)` answers every "can I go this
way?" question for the six axis directions. `node tools/validate.mjs` BFS-checks that
every pellet is reachable and no open cell is a dead-end trap.

### Movement engine (`src/main.js`)
Everything moves cell-to-cell on the grid with interpolated world positions
(vertical rides eased in/out). Pac-Man keeps three input channels that can't fight
each other: a *desired* horizontal direction (latest arrow press, applied at each
cell center — he keeps running in his current direction until you change it or hit
a wall, like the arcade), a *queued vertical* slot (immune to arrow auto-repeat),
and mid-segment reversal for instant 180°s.

### Ghost AI (`src/ghosts.js`)
The original arcade brain, in 3D:
- **Modes** alternate on the arcade wave schedule (scatter 7s → chase 20s → … → chase
  forever); every mode switch forces all ghosts to reverse. Each ghost's **scatter
  corner is on a different floor**, so they patrol different levels.
- At every cell a ghost picks the legal direction (never reversing) that minimizes
  straight-line 3D distance to its **target**:
  - *Blinky* targets Pac-Man's cell.
  - *Pinky* targets 4 cells ahead of Pac-Man's heading — including straight up/down.
  - *Inky* doubles the vector from Blinky through the point 2 ahead of Pac-Man.
  - *Clyde* chases like Blinky beyond 8 cells, else flees to his corner.
- **Power pellets** trigger frightened mode (slow, random turns, blue, blinking
  before it ends; timer bar in the HUD). Eating ghosts chains 200/400/800/1600.
- Eaten ghosts become **eyes** that BFS the shortest path home, re-enter through the
  door, and re-release. House releases stagger 0/2/5/8 seconds.

### Rendering
three.js r164 via CDN import map (zero build). Cel shading = `MeshToonMaterial` with
a 3-step gradient + inverted-hull outlines. Post-processing = `UnrealBloomPass`.
Per-floor materials let wall fill, wireframes, pellets, and towers crossfade
continuously with Pac-Man's actual height during shaft rides.

## Roadmap

More levels, bigger castles, more floors, per-level difficulty scaling, fruit
bonuses, mobile/touch controls.
