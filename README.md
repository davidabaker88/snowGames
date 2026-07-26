# Snowball Fight

A 3/4 top-down multiplayer snowball fight for the browser, built mobile-first.

**Playable now:** five game modes, on one device against bots or across several
devices over WebRTC. One phone hosts, shows a four-character code, and everyone else
joins with it. Pack snowballs by circling your thumb, throw them with a flick, build
and wreck snow walls, take the hill, steal the flag, or outlast a closing blizzard.

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
| `/?net=1` | Play through a real host and net client in the same tab |
| `/?netdebug=1` | The above, plus the netcode overlay |
| `/?lat=150&loss=3` | Inject latency and packet loss, so you can *feel* a bad link |
| `/?signal=https://…` | Point at a signalling server, overriding the built-in one |
| `/?dev=rtc` | **WebRTC lab**: a page that can be either end of a peer connection |

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

Every mode except Practice plays across devices too — pick one, then tap **Play with
other devices**.

Bots are not a separate code path. A bot produces the same `InputFrame` a thumb
does — move axes, aim, buttons, pack delta — and its objective comes from the mode
itself via `mode.botObjective`, so a new mode gets bots that understand it without
touching the bot. It also means the automated tests play real matches: one check
runs a full bot match in a browser and asserts somebody actually wins.

## How it's put together

```
packages/
  shared/   simulation, animation, game rules, netcode -- runs in Node AND the browser
  client/   rendering, input, HUD, WebRTC transport
workers/
  signal/   the room mailbox: a Cloudflare Worker, deployed separately
```

`shared/` has no build step: the client resolves it straight to source through a
Vite alias. Its `tsconfig` deliberately excludes both `DOM` and `@types/node`, so
`window` and `process` don't even typecheck there. That is what lets the simulation
*and the authoritative host* run unchanged in a browser, under Node, or in a Web
Worker — enforced by the compiler rather than by remembering to.

Three ideas carry most of the weight:

**The simulation is a pure function.** `step(world, inputs, ctx)` has no ambient
time, no `Math.random`, no I/O. The seeded RNG lives inside world state. That is what
makes client-side prediction work — the client replays its own unacked inputs through
the very same function the host used — and it's covered by a test that hashes 1,200
ticks and compares runs.

**Characters are a procedural skeleton driven by data.** A "skin" is a bone
hierarchy plus a `RoleMap`. Animation clips target *roles* (`throwLimb`, `leg.0`),
never bone names, and tracks whose role a skin lacks are dropped when the clip is
compiled. So the chicken uses the identical clip library as the stick figure and
needed **zero engine changes** — its throw reads as a wing flap purely because its
`throwLimb` is a `frontal`-swing bone instead of a `sagittal` one. One rig covers
all 360° of facing via a turntable projection, rather than eight sets of artwork.

**Gameplay tunables live in one file.** `shared/src/constants.ts` owns tick rate,
the throw arc, wall heights and every action duration. Animation clips are stretched
to fit the simulation's timings, never the reverse — the authoritative host has no clips
in memory and must not be able to disagree about how long a throw takes.

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
pnpm test           # unit tests
pnpm typecheck
pnpm verify         # drives the real game in headless Chromium, writes screenshots
pnpm verify:webrtc  # two browser pages, one real peer connection, one real match
```

`pnpm verify` is the interesting one: it launches Chromium, dispatches real
`PointerEvent`s through the actual gesture recognizer, and asserts the game
responds — packing, throwing, placing, picking up, hitting a dummy, building a wall,
chipping one down, swapping skins, booting every game mode, playing a bot match
through to a winner, and doing all of it again through the authoritative host over a
90ms link with 2% packet loss.

The netcode also has its own in-process suite: a real host and eight real clients in
one process, playing every mode to completion, first on a clean link and then at
150ms latency, 40ms jitter, 3% loss and 1% reorder — asserting a valid winner, that
every client converges tick-for-tick with the host, and that traffic stays inside
8 KB/s down and 1.2 KB/s up per player.

`pnpm verify:webrtc` is the one that proves cross-device play: a `GameHost` in one
browser context, a `NetClient` in another, two genuine `RTCPeerConnection`s, and the
test process acting as the signalling mailbox exactly as the Worker does. Two separate
contexts rather than two peers in one page, deliberately — same-page peers share a
network stack and an mDNS resolver, so they connect in situations where independent
contexts cannot, which makes them the weaker test.
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
- The host needs an **input jitter buffer**. Client and host both run at exactly
  30Hz, so with no cushion the slightest jitter leaves the host with nothing to apply
  and it substitutes a frame the client cannot know about. That one effect dominated
  prediction error: 2.3 units at p90, against 0.1 with two frames of buffer.
- Interpolation delay is tuned from measured **snapshot age**, not from jitter.
  Jitter is one term; latency and snapshot cadence are the others. Tuning on jitter
  alone had the client rendering ahead of its own buffer, extrapolating every frame,
  and remote players advancing in 28-unit lurches.
- A "full" snapshot lists only what exists, so it has to **wipe first** or anything
  the client still holds and the host has forgotten survives as an unkillable ghost.
- Inactive entity slots are **canonically zero on the wire**. Left as whatever
  happened to be in the struct, they differ between host and client, and a delta
  reports them as changed on every snapshot for the whole match.
- `actionTicks` **saturates** on the wire. It increments forever on an idle player,
  so without a ceiling every player differs from every baseline every snapshot and
  delta compression achieves precisely nothing.
- A lost Welcome used to strand a client permanently: the host had already marked it
  joined, so every retried Hello was ignored while snapshots it could not use
  streamed past. Hello is answered idempotently now.
- ICE gathering **never reports `complete`** in this project's test browser — measured
  at nine seconds with no STUN configured — and can stall in the wild whenever a
  configured STUN server is unreachable. Non-trickle gathering therefore waits for
  candidates to *stop arriving*, not for a state transition that may never come.
- "Has the match started" cannot be inferred from `world.tick > 0`. The host starts
  ticking the moment it exists, because otherwise the handshake never completes, so
  that test is already true before the first player has joined. The symptom was a
  hosted match that ran perfectly and had no bots in it.
- A room code the player misread is **rejected, not guessed at**. Folding `0` onto `Q`
  is tempting, but `0` resembles `O`, `Q` and `D` about equally and silently joining
  the wrong match is worse than being told the code is wrong. The real fix is upstream:
  the generator never emits a confusable character.

## Roadmap

| Phase | Work | State |
| --- | --- | --- |
| 4 | Snow walls: build and destroy | **done** |
| 5 | Pluggable game-mode framework + the four game modes + bots | **done** |
| 6 | Authoritative netcode: host, prediction, interpolation, lag compensation | **done** |
| 7 | WebRTC transport, signalling, room codes — one phone hosts for the others | **done** |
| — | Bluetooth, accounts, ranked play, spectator streams | not planned |

## Playing across devices

A browser **cannot listen on a TCP port** — there is no server-socket API in
JavaScript, on any platform. So a phone can never be the thing other people type a URL
into, and that is why this took a transport rather than a server.

What a phone browser *can* do is run the authoritative simulation with everyone else
attached over **WebRTC DataChannels**, which connect peer-to-peer with neither side
listening. So: the page comes from static hosting, and the *game* runs on whichever
phone tapped Host.

Everything above the transport was already written and tested against
`createLocalPair()` in Phase 6, and needed no changes. Phase 7 replaced one line:

```
createLocalPair()   ->   a WebRTC DataChannel pair
```

### Setting up the signalling server

Two peers cannot use each other to exchange the descriptions they need in order to
reach each other, so something has to carry a few hundred bytes each way at join time.
That is all the signalling server does — it never sees an input, a snapshot, or
anything about the game.

That distinction is what makes it free rather than expensive. A *relaying* game server
carries every message of every match, which worked out at roughly **14 eight-player
matches a day** on Cloudflare's free tier. This carries about six requests per player
per **join**, so the same free tier covers thousands of matches a day. The difference
is not optimisation; it is that peer-to-peer traffic never arrives there at all.

```bash
cd workers/signal
npx wrangler deploy          # prints https://snowball-signal.<you>.workers.dev
```

Then build the client with that origin baked in:

```bash
VITE_SIGNAL_URL=https://snowball-signal.<you>.workers.dev pnpm build
```

No account is needed to *play* and no credit card is needed to deploy. Note the
wrangler config uses `new_sqlite_classes` for the Durable Object: that is the storage
backend available on the free plan, and the older key-value one deploys fine and then
fails at runtime with a billing error.

Leaving `VITE_SIGNAL_URL` unset is a valid configuration — the game just has no online
mode, and says so plainly when you tap Host. Single-device play is unaffected.

### Known risks, stated honestly

**mDNS candidates.** Chrome and Safari hide local IPs behind `.local` hostnames in ICE
candidates, so two phones on the same WiFi need mDNS resolution between them. That
usually works on a home network and can fail where multicast is blocked — guest and
enterprise networks especially. This is the one part not proven here: the automated test
disables mDNS because two containerised browser contexts cannot resolve each other's
`.local` names, so **real two-device LAN play is worth testing on actual hardware
before trusting it.** Public STUN is configured, which covers play across the internet
and provides a fallback.

**No TURN server.** A relay is the one part of WebRTC that genuinely costs money at
volume, so there is none. Connections that would need one — some symmetric NATs — will
fail rather than quietly bill somebody.

### The transport seam earned its keep

Rule 3 of `net/transport.ts` was *"assume nothing about reliability or ordering, even
though WebSocket provides both."* Phase 7 is where that paid off. WebRTC offers an
unreliable unordered channel, and for the hot path it is strictly better: on a reliable
ordered channel a lost snapshot **head-of-line blocks every later one** behind a
retransmit of data that is already obsolete.

So the transport opens two channels. Snapshots, inputs and pings go down the unreliable
one and are allowed to vanish — each is re-stated by the next. Joins, events and the
rest go down the reliable one. The netcode picks per message via `send(data, reliable)`,
a delivery hint carrying no game vocabulary, defaulting to reliable so anything
unconsidered is safe.

### The netcode

Run `/?netdebug=1&lat=150&loss=3` and you are playing against a real authoritative
host over a link with 150ms of latency and 3% packet loss. It is in the same tab, but
nothing about it is a mock: those are the real codecs and the real prediction path.

Four decisions carry it.

**The host is not a server.** It ships in every player's bundle, because whoever taps
"host" runs it. So it lives in `shared/`, where the tsconfig supplies neither DOM nor
`node:*` — which means host portability is enforced by the compiler rather than by
good intentions. The same file runs in a browser, under Node for the tests, and would
run behind a WebSocket unchanged.

**Deltas are encoded against what a client acknowledged, never against what was last
sent.** Sent is not received. When a snapshot is lost the client keeps acknowledging
its older tick, the host keeps encoding from that baseline, and the missing state is
naturally included again — so loss recovery needs no retransmit logic, no nacks, and
costs exactly one extra delta.

**Prediction is deliberately narrow.** The client predicts its own movement and its
own action state, and nothing else — not damage, not deaths, not pickups, not scores,
not anybody else's position. That is what keeps drift small enough that bit-exact
determinism is never required, only *structural* determinism. Hits render only from
host events, because predicting your own hits is exactly where "why didn't my hit
count" comes from.

**Snowball lag compensation is not shooter-style rewind.** Flight time is 0.4–1.2s,
which dwarfs any plausible latency, so rewinding the victim would produce the
notorious *"I was clearly behind that wall and still got hit"* — and the player would
be right, because the ball was visibly in the air for a second first. Instead the ball
spawns where the thrower actually was when they flicked, fast-forwards through the
time since, and then collides against where bodies are **now**. Thrower-favoured
spawn, victim-favoured hit.

One simulation change fell out of all this and is worth knowing about: ball allocation
takes the **lowest free slot** rather than popping a free list. A free list's order
encodes its entire allocation history, which a snapshot does not carry — so a client
that rebuilt its world from one would disagree with the host about the very next
snowball thrown.

Cats and other creatures are a data file each: add a skin, add one line to the skin
registry.
