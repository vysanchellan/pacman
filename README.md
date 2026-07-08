# PAC-MAN 3D — Night Castle

Classic Pac-Man extended into a true third dimension: the **original arcade maze
(28×31), stacked as a three-floor neon castle** connected by vertical shafts, with
six-direction movement, wrap-around side tunnels, and the four arcade ghost
personalities faithfully generalized to 3D — wrapped in an anime night-world
(cel shading, inked outlines, bloom, moon, mountain skyline, drifting clouds,
starfield, sakura petals).

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
- **Ghost beacons**: every wraith carries a colored light pillar visible through
  walls — you always know where each one is and (by the pillar's height) which
  floor it's on. Beacons turn blue when frightened, faint white for returning eyes.
- The **floor-stack widget** (right) shows which floor you and every ghost are on.
- **Asymmetric floor fading**: floors above you fade almost completely out (they
  used to occlude the action); the floor below stays ghostly for depth; your own
  floor renders bright and solid with boosted glow.

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
The **original arcade maze layout (28×31)** on all three floors — including the
side tunnels, which wrap around exactly like the arcade. The ghost house (the keep)
lives on the middle floor; on the other floors it's a sealed block. Eleven shaft
cells per floor-pair stack vertically through the castle. `#` walls, `.` pellets,
`o` power pellets, `X` shafts, `-` the ghost-house door, `G` house interior, `P`
spawn. All movement rules live here: `stepCell(layer,row,col,dir)` answers every
"can I go this way?" question (wrap included). `node tools/validate.mjs` BFS-checks
that all 719 dots are reachable and no open cell is a dead-end trap.

### Difficulty — endless levels
Level 1 is fast but fair. Every clear re-arms the castle harder: ghosts close the
speed gap (4.05 → 4.6 vs your 4.6+), power pellets weaken (8 s of frightened time
down to 1.2 s), scatter breaks shrink (7 s → 3 s → 2 s), and house releases come
almost immediately. **Cruise Elroy** is in: Blinky gains speed when the dots run
low (+0.28 under 120 left, +0.55 under 50) — from level 2 on you must know your
routes and read the four behaviours to survive.

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
