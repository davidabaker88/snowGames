# Snowball Fight

A 3/4 top-down multiplayer snowball fight for the browser, built mobile-first.

**Playable now:** five game modes against bots — pack snowballs by circling your
thumb, throw them with a flick, build and wreck snow walls, take the hill, steal
the flag, or outlast a closing blizzard. Single device, no server — see
[Roadmap](#roadmap).

## Running it

Requires Node 22+ and [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm dev
```

That starts the dev server bound to your local network and prints a **QR code**.
Scan it with a phone on the same WiFi and you're playing — no app store, no build
step, no account.

```
  ⛄  Snowball Fight

  On this machine   http://localhost:5173
  On your phone     http://192.168.1.42:5173      <- scan the code below
```

**Play in landscape.** The 3/4 camera compresses world depth, so a portrait phone
shows a lot of empty ground for its width. Landscape also puts both thumbs in the
bottom corners where they belong. The game nudges you if you're in portrait.

If a phone can't reach the server, the usual cause is **AP isolation** — guest
networks and many mesh routers block device-to-device traffic. Put everything on the
main WiFi network, not the guest one.

### URL options

| URL | What it does |
| --- | --- |
| `/` | Opens the mode picker |
| `/?mode=teamWar` | Skip the picker and start a mode (see [Game modes](#game-modes)) |
| `/?mode=sandbox` | Free play with training dummies — no score, no timer |
| `/?bots=7` | Bot count, 0–9. Default 5. |
| `/?skin=chicken` | Play as a chicken — the swappable-model proof |
| `/?dev=rig` | **Rig Lab**: turntable and clip scrubber for inspecting skins |
| `/?debug` | On-screen state overlay (tick, gesture state, mode phase, scores) |

## Controls

**Touch** — the left half of the screen is movement, the right half is snowballs.

| Gesture | Action |
| --- | --- |
| Drag (left half) | Move. The stick centres wherever your thumb lands. |
| **Circle** your thumb (right half) | Pack a snowball. A ring shows progress; 2.5 turns makes one. |
| **Flick** (right half) | Throw in the flicked direction. Power comes from flick speed. |
| **Tap** (empty-handed, near a ball) | Pick it up |
| **Double-tap** or **long-press** (holding) | Set the ball down |
| **Brick button** (bottom centre, while holding) | Pack the snowball into a wall in front of you |

Building gets a button rather than a gesture on purpose: the right thumb already
carries five gestures, all of them specified up front, and overloading one of those
to also mean "build" would make a control you asked for less predictable in order to
squeeze in one you didn't.

One sentence covers the tap ambiguity: **picking up needs empty hands, so while
you're holding a ball, tap means put it down.** That's why pickup fires on the very
first tap instead of waiting to see if a second one is coming.

Frantic back-and-forth scrubbing also packs snow, at about a third of the rate of
clean circles — people naturally scrub, and refusing to reward it feels broken.

**Keyboard / mouse** (desktop, and how the automated tests drive the game):

| Key | Action |
| --- | --- |
| `WASD` / arrows | Move |
| Mouse | Aim |
| `J` (hold) | Pack a snowball |
| `Space` | Throw — hold longer for more power |
| `E` / `Q` | Pick up / put down |
| `B` | Build a snow wall |
| `K` | Cycle character skin |

A circular **mouse drag** on the right half feeds the real gesture recognizer too,
so the circle detection is exercised on desktop rather than bypassed.

## Game modes

Five modes plus a practice sandbox, all playable now against bots. The picker
opens on load; the slider sets how many bots join.

| Mode | How you win | The rule that makes it work |
| --- | --- | --- |
| **Practice** (`sandbox`) | You don't — it's free play with training dummies | No timer, no score, no bots |
| **Last One Standing** | Be the last one alive | A **closing blizzard** damages anyone outside the ring. Without it, two campers stall the match forever. |
| **Team Snowball War** | First team to 20 hits, or ahead at 5:00 | 4-second respawns, and you spawn **farthest from living enemies** |
| **Capture the Flag** | 3 captures, or ahead at 6:00 | Your own flag must be **home** to score, so you can't just trade steals |
| **King of the Hill** | Hold the centre for 60 points | Capture progress comes from `attackers − defenders`, so numbers matter |
| **Fort Defense** | Blue holds the fort to 4:00; Red wins by taking it *once* | 45-second build phase where **only Blue may build**, 40 walls to Red's 6, and no damage until it ends |

Fort Defense is not a fifth mode implementation — it is King of the Hill's file with
different numbers (a different zone, asymmetric build budgets, asymmetric respawn
timers, a long warm-up and a single-capture win). That's the payoff of putting mode
rules behind an interface: the *second* mode of a family costs a config block.

Bots are not a separate code path. A bot produces the same `InputFrame` a thumb
does — move axes, aim, buttons, pack delta — and its objective comes from the mode
itself via `mode.botObjective`, so a new mode gets bots that understand it without
touching the bot. It also means the automated tests play real matches: one check
runs a full bot match in a browser and asserts somebody actually wins.

## How it's put together

```
packages/
  shared/   simulation, animation, game rules -- runs in BOTH Node and the browser
  client/   rendering, input, HUD
```

`shared/` has no build step: the client resolves it straight to source through a
Vite alias. Its `tsconfig` deliberately excludes both `DOM` and `@types/node`, so
`window` and `process` don't even typecheck there — the cheapest possible guarantee
that the simulation will run unchanged on an authoritative server later.

Three ideas carry most of the weight:

**The simulation is a pure function.** `step(world, inputs, ctx)` has no ambient
time, no `Math.random`, no I/O. The seeded RNG lives inside world state. That's what
makes client-side prediction possible later, and it's covered by a test that hashes
1,200 ticks and compares runs.

**Characters are a procedural skeleton driven by data.** A "skin" is a bone
hierarchy plus a `RoleMap`. Animation clips target *roles* (`throwLimb`, `leg.0`),
never bone names, and tracks whose role a skin lacks are dropped when the clip is
compiled. So the chicken uses the identical clip library as the stick figure and
needed **zero engine changes** — its throw reads as a wing flap purely because its
`throwLimb` is a `frontal`-swing bone instead of a `sagittal` one. One rig covers
all 360° of facing via a turntable projection, rather than eight sets of artwork.

**Gameplay tunables live in one file.** `shared/src/constants.ts` owns tick rate,
the throw arc, wall heights and every action duration. Animation clips are stretched
to fit the simulation's timings, never the reverse — the future authoritative server
has no clips in memory and must not be able to disagree about how long a throw takes.

### Walls

Walls are a tilemap, and the whole mechanic rests on one function:

```
wallHeightAt(tile) = TIER_HEIGHT[tier] * (0.35 + 0.65 * hp/maxHp)
```

**Partial destruction is height reduction.** That single line couples the visuals,
projectile blocking and cover together, so:

- damage is visible as it happens, not only when a tile finally pops;
- "throw over a low wall" needs no special case — it is just
  `ball.z < wallHeightAt(tile)`;
- chipping a wall down until snowballs start clearing it is an *emergent* tactic
  rather than a scripted feature.

Building spends the snowball you are carrying, so packing feeds offence and defence
out of one pool — there is no second economy to explain. Snow accumulates and the
wall grows through low → full → ice, so you never pick a wall type.

One consequence worth knowing, because it looks like a bug and isn't: a ball leaves
the hand at height 40 and arcs to ~56 before falling, so against a 48-high wall there
is a **mid-range band where throws sail clean over it**, with connecting zones at
point blank and at longer range. Range is a real tactical variable, not just power.

### The mode framework

Adding a mode is one file plus one line in `shared/src/modes/registry.ts`. Nothing
in the simulation, the renderer or the HUD needs to know it exists. Two rules make
that true:

**Modes are stateless.** A `GameMode` is a bag of hooks — `init`, `assignTeam`,
`spawnPoint`, `onTick`, `onPlayerHit`, `onEliminate`, `onBuildRequest`, `checkWin`,
`hud`, `botObjective` — and every one of them reads the world it's handed. Nothing
mutable lives on the mode object, so the same instance can drive several worlds and
a mode can never quietly desync from the state it's judging.

**`ModeCtx` is the only mutation channel.** Modes score, damage, eliminate, respawn
and spawn through it and never reach into world arrays. That's one place to audit
when something changes state it shouldn't, instead of six.

**The HUD is pure data.** A mode fills in a `ModeHud` struct — title, headline, sub,
team scores — and the client draws it. No mode contains a line of canvas code, and a
new mode gets a working scoreboard for free. When a widget can't be expressed, the
fix is to extend `ModeHud`, not to hand a mode a drawing context.

## Tests

```bash
pnpm test          # unit tests
pnpm typecheck
pnpm verify        # drives the real game in headless Chromium, writes screenshots
```

`pnpm verify` is the interesting one: it launches Chromium, dispatches real
`PointerEvent`s through the actual gesture recognizer, and asserts the game
responds — packing, throwing, placing, picking up, hitting a dummy, building a wall,
chipping one down, swapping skins, booting every game mode, and playing a bot match
through to a winner.
A test that set `packProgress = 2.5` directly would prove nothing about whether
circling works.

Notable regression guards, each one written because the bug actually happened:

- A **straight** flick's centroid lies on its own path, so samples either side of it
  are 180° apart and fake a half-rotation with perfect consistency. Without a
  per-step angle cap, every throw also packed snow.
- Circling accumulates progress from the **per-frame sweep**, not from the rolling
  windowed angle — the latter plateaus, so packing stalled partway and could never
  finish.
- Snowball collision is **swept**. At 30Hz a fast ball travels further per tick than
  a player is wide, so a point-in-circle test tunnels straight through people. Tested
  across 40 sub-tick phase offsets.
- Depth sorting uses **ground y**, never screen y, or airborne snowballs vanish
  behind scenery they're visually above.
- Wall collision skips **internal tile faces**. Without that check every tile
  boundary along a flat wall is an inside corner that nudges you sideways, so
  walking along a wall feels like dragging across a cheese grater.
- `BUILD_REACH` must exceed `TILE_SIZE + PLAYER_RADIUS`, or the target tile overlaps
  the builder's own body and building silently fails about half the time.
- Canvas `rotate(t)` maps local +y to `(-sin t, cos t)`, so bone rotation needs
  `atan2(-dx, dy)`. The other sign draws every bone backwards from its own origin,
  which looks like a character turned inside out rather than like a sign error.

## Roadmap

| Phase | Work | State |
| --- | --- | --- |
| 4 | Snow walls: build and destroy | **done** |
| 5 | Pluggable game-mode framework + the four game modes + bots | **done** |
| — | Networked multiplayer and a game server | **not being built** |

**No server.** That is a deliberate decision, not an omission. It means there is no
networked multiplayer: no online play, and no same-WiFi play between devices. Each
device runs its own game.

What that does *not* rule out is same-device play against bots, which is what all
five modes above run on. The groundwork for networking is here anyway: `step()` is a
pure function a host could drive, bots already emit the same `InputFrame` structs a
human does, and `shared/net/localTransport.ts` carries messages in-process with
configurable latency and loss.

If networking is ever wanted, nothing here blocks it. `Transport` is bytes-only and
assumes nothing about ordering or reliability, so a WebSocket server — or WebRTC, or
a native Bluetooth bridge behind a Capacitor wrapper — would be a new file rather
than a rewrite.

Cats and other creatures are a data file each: add a skin, add one line to the skin
registry.
