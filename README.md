# Snowball Fight

A 3/4 top-down multiplayer snowball fight for the browser, built mobile-first.

**Playable now:** move, pack a snowball by circling your thumb, throw it with a
flick, set it down and pick it back up, knock over training dummies, and build or
wreck snow walls. Game modes and real multiplayer are designed but not built yet —
see [Roadmap](#roadmap).

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
| `/` | Play |
| `/?skin=chicken` | Play as a chicken — the swappable-model proof |
| `/?dev=rig` | **Rig Lab**: turntable and clip scrubber for inspecting skins |
| `/?debug` | On-screen state overlay (tick, gesture state, pack progress) |

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

## Tests

```bash
pnpm test          # unit tests
pnpm typecheck
pnpm verify        # drives the real game in headless Chromium, writes screenshots
```

`pnpm verify` is the interesting one: it launches Chromium, dispatches real
`PointerEvent`s through the actual gesture recognizer, and asserts the game
responds — packing, throwing, placing, picking up, hitting a dummy, building a wall,
chipping one down, and swapping skins.
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

Designed and agreed, not yet built:

| Phase | Work |
| --- | --- |
| ~~4~~ | ~~Snow walls: build and destroy~~ — **done** |
| 5 | Pluggable game-mode framework + Team Snowball War + Last One Standing |
| 6 | Real netcode: host-authoritative WebSocket, client prediction, snapshot interpolation |
| 7 | Capture the Flag, King of the Hill / Fort Defense, rooms and lobby |
| 8 | Production server, LAN + `cloudflared` tunnel, hardening |

Multiplayer will be host-authoritative over WebSocket, and can run entirely free:
one machine hosts for same-WiFi play, or a free `cloudflared` quick tunnel exposes
it to a friend in another city. The `Transport` interface already in `shared/net/`
is bytes-only and assumes nothing about ordering or reliability, so adding WebRTC —
or a native Bluetooth bridge behind a Capacitor wrapper — is a new file rather than
a rewrite.

Cats and other creatures are a data file each: add a skin, add one line to the skin
registry.
