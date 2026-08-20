# Online multiplayer — design & build notes

Status: **implemented.** 2–4 players, room codes, Cloudflare Tunnel hosting.
See "What actually happened" at the bottom for the four desync bugs the plan
didn't anticipate.

## TL;DR

- **Model:** actor-authoritative with end-of-turn reconciliation. Whoever's turn it is
  simulates their own turn and broadcasts the result; the opponent watches live and snaps
  to the authoritative state when the turn ends.
- **Transport:** Socket.IO over a ~150-line relay server that does *not* simulate the game.
- **Hosting:** one Node process serving both the static build and the socket. Deploy to
  Fly.io / Railway for always-on, or run it on your own PC behind a Cloudflare Tunnel.
- **Bandwidth:** under 1 KB per turn plus ~400 B/s while someone is actively moving. A
  whole 60-turn match is well under a megabyte.
- **Effort:** roughly 3–4 focused days, and the first day is a refactor that's worth doing
  regardless.

---

## 1. Why this is easier than it looks

Blob War is turn-based, and exactly one blob is under player control at any moment. That
removes essentially every hard problem in game networking:

| Realtime games need | We need |
| --- | --- |
| 20–60 Hz state sync | ~15 Hz while one player walks, nothing otherwise |
| Client-side prediction | None — the acting player is already local |
| Server rollback / lag compensation | None — nobody else is acting |
| Interest management | None — 8 blobs, one map |
| Sub-100 ms latency | 300 ms would be unnoticeable |

The only genuinely networked moments are: *"I moved here"*, *"I fired this, like this"*,
and *"here's what the world looks like now"*.

---

## 2. Architecture options considered

### A. Deterministic lockstep (send inputs only, both sides simulate)

Tempting, because the payload would be a handful of floats per turn. **Rejected as the
primary mechanism** — I audited the codebase and it isn't deterministic today, and making
it reliably deterministic *across different browsers* is a trap.

Two problems, both real:

**Gameplay randomness uses `Math.random()`.** These call sites change the outcome of a
turn and would desync immediately:

| File | What it decides |
| --- | --- |
| `src/game.js:1000` | wind direction and strength each turn |
| `src/game.js:658,662` | whether a crate drops, and whether it's a medkit |
| `src/game.js:460` | Uzi burst spread |
| `src/crate.js:176,189` | crate drop location and loot roll |
| `src/projectile.js:162` | cluster/mortar/fruitlet child directions |
| `src/blob.js:27` | starting facing — which matters, `jump()` reads it |

(The rest — `fx.js`, `cameraRig.js`, `audio.js`, `blob.js:29` — is cosmetic and can keep
using `Math.random()` freely.)

That part is fixable in an afternoon with a seeded RNG. The second problem is not:

**Floating-point transcendentals aren't cross-engine exact.** The simulation calls
`Math.sin/cos/atan2/pow/hypot` throughout — 8 sites in `terrain.js`, 8 in `blob.js`, 6 in
`game.js`, 4 in `crate.js`. IEEE 754 pins down `+ - * /` and `sqrt` exactly, but *not*
those. V8 and SpiderMonkey can disagree in the last bit. Feed a 1-ULP difference into a
bouncing grenade and the two clients will eventually disagree about who died.

Lockstep would work fine if both players are on Chrome. That's not a promise worth
building on.

### B. Server-authoritative (server runs the real simulation)

The correct answer for a competitive game, and the wrong one here. The simulation classes
build three.js objects in their constructors — `Blob` creates a `THREE.Group`, geometries,
materials and a `<canvas>` name label; `Projectile`, `Crate`, `Mine` and `Terrain` all do
the same. Running this on Node means either a headless-render abstraction over every
entity or a second copy of the physics. That's a multi-day refactor buying anti-cheat you
don't need to play with a friend.

Worth noting it stays *possible*: `simulateTrajectory()` in `projectile.js` is already a
pure headless integrator, which is the proof that the physics can be lifted out. Keep it
as the upgrade path, don't pay for it now.

### C. Actor-authoritative + end-of-turn reconciliation ← **recommended**

The acting client owns the outcome of its own turn. Concretely:

1. While aiming/walking, it streams its aim angles and blob transform. The opponent
   **interpolates** the remote blob's transform — no simulation, so no divergence.
2. On fire, it sends `{weapon, origin, velocity, homingTargetId}`. Both clients spawn the
   projectile and simulate locally, so both *see* the rocket fly and explode in real time.
3. When the turn settles, the acting client sends an authoritative snapshot. The opponent
   applies it, silently correcting any drift.

Divergence can never accumulate past one turn, so the transcendental problem evaporates —
a few centimetres of disagreement mid-flight get overwritten before it matters.

**Terrain is the nice surprise here.** `Terrain.carve()` uses only comparison, subtraction
and `Math.sqrt` — all IEEE-exact. Replaying the same list of `carve(x, y, z, r)` calls
produces a *bit-identical* heightmap on any engine. So terrain never needs to be sent as
bulk data; craters are 16 bytes each.

**Tradeoff, stated plainly:** the acting client reports its own damage numbers, so a
modified client could cheat. For playing with friends that's irrelevant. Option B is the
fix if it ever stops being irrelevant.

---

## 3. Protocol sketch

```
C→S  create_room  {name}                 S→C  room_created {code, seed, slot:0}
C→S  join_room    {code, name}           S→C  room_joined  {code, seed, slot:1, peer}
                                         S→C  peer_joined | peer_left | peer_back
                                         S→C  start        {seed, firstTeam}

-- only the client whose turn it is transmits --
C→S→C  aim     {yaw, pitch, power}        ~10 Hz, so you watch them line it up
C→S→C  move    {x, y, z, facing}          ~15 Hz, opponent lerps toward it
C→S→C  weapon  {id}
C→S→C  jump    {}
C→S→C  fire    {weaponId, origin[3], velocity[3], targetId?}
C→S→C  turn_end {snapshot}                authoritative reconciliation
```

Snapshot payload:

```jsonc
{
  "blobs":  [{ "id": 0, "x": 1.2, "y": 8.4, "z": -3.1, "hp": 72, "alive": true }],
  "craters":[{ "x": 4.0, "y": 7.7, "z": 2.0, "r": 7 }],   // replayed exactly
  "ammo":   { "0": { "bazooka": null, "cluster": 2 } },   // null = Infinity
  "crates": [{ "id": 7, "type": "weapon", "loot": {...}, "x":0,"y":0,"z":0, "landed": true }],
  "mines":  [{ "id": 3, "x": 0, "y": 0, "z": 0, "age": 4.2, "owner": 1 }],
  "water":  0,
  "sudden": false,
  "nextWind": { "x": 2.1, "z": -4.4 },
  "nextTurn": { "team": 1, "blob": 2 }
}
```

Note `nextWind` and any crate drop are decided by the client *ending* its turn and shipped
in `turn_end`, so both sides start the next turn already agreeing.

Sizes: ~8 blobs × 20 B + ~20 craters × 16 B + crates/mines/ammo ≈ **under 1 KB per turn**.
The aim/move streams are ~400 B/s and only while one person is actually moving.

---

## 4. Transport: Socket.IO vs raw `ws` vs WebRTC

| | Verdict |
| --- | --- |
| **Socket.IO** | **Recommended.** Rooms, automatic reconnection, acknowledgements and binary support out of the box — all three are things you'd otherwise hand-roll. Reconnection matters a lot here: a turn-based game can survive a 20-second dropout invisibly if the server can replay the last snapshot. Protocol overhead is irrelevant at these payload sizes. |
| **Raw `ws`** | Perfectly viable, ~30 KB lighter, but you will end up writing room management, heartbeat and reconnect logic yourself. Pick this only if you want zero magic. |
| **WebRTC (PeerJS / simple-peer)** | Sounds appealing ("no server!") but *still needs a signalling server*, and adds STUN/TURN — and TURN relays cost money for the ~10–20 % of connections where NAT traversal fails. Strictly more infrastructure than a 150-line relay. Skip. |

The server does **not** simulate anything. It's a room registry and a message forwarder:
roughly `io.on('connection')`, a `Map<code, room>`, and `socket.to(room).emit(...)`. Keep
the last snapshot per room so a reconnecting player can be caught up.

---

## 5. Hosting

Serve the Vite build **and** the socket from the same Node process on the same origin.
Splitting static hosting (Netlify/Vercel) from the socket server means CORS config and an
absolute WS URL for no benefit.

### Cloud (always on)

| Option | Effort | Notes |
| --- | --- | --- |
| **Fly.io** | `fly launch`, ~10 min | WebSockets work natively, deploys close to you, scales to zero when idle. Good default. |
| **Railway** | Connect repo, ~5 min | Probably the least friction of any of these. |
| **Render** | ~10 min | Has a genuine free tier, but it idles the instance out — a ~50 s cold start when a friend clicks your link is a bad first impression for a game. |
| **PartyKit / Cloudflare Durable Objects** | ~20 min, different model | Purpose-built for exactly this ("a room is an object"). Genuinely elegant fit, and the free allowance is generous. Costs you learning a new runtime, and you can't just `require('socket.io')`. |

Pricing on all of these moves around — check current tiers before committing.

### From your own PC

**Cloudflare Tunnel is the answer**, not port forwarding.

```bash
cloudflared tunnel --url http://localhost:3000
```

That gives you a public HTTPS URL immediately, with WSS working, no router config, no
dynamic DNS, no certificate to manage, free. A named tunnel gives you a stable hostname if
you want to keep it.

Why not plain port forwarding: the page must be HTTPS for anyone to trust it, and an HTTPS
page **cannot** open a plain `ws://` socket — browsers block mixed content. So you'd need a
real TLS certificate on your home IP, which means a domain, Let's Encrypt and a reverse
proxy. The tunnel skips all of it.

**LAN play needs none of this.** Serving over plain `http://192.168.x.x:3000` means the
origin is already insecure, so `ws://` is allowed. Two machines on your wifi will work with
zero extra setup.

---

## 6. Implementation order

### Phase 0 — seeded RNG *(half a day, worth doing anyway)*

New `src/rng.js` wrapping the existing `mulberry32` from `noise.js`. Replace the ~14
gameplay call sites listed in §2A; leave the cosmetic ones alone.

Independently valuable: it makes solo matches exactly reproducible from a seed, which
would have made the sudden-death stalemate hunt much easier to bisect.

### Phase 1 — command layer *(~1 day)*

Today `Game` reads `this.input` directly and mutates state inline. Introduce
`Game.applyCommand({type, ...})` covering `weapon`, `move`, `jump`, `aim`, `fire`,
`end_turn`, and route **local input through it too**. When solo play still works unchanged,
the networking is nearly free — remote commands enter through the same door.

Also add `captureTurnResult()` / `applyTurnResult(snapshot)` and a `Terrain` crater log.

### Phase 2 — relay server *(half a day)*

`server/index.js`: Express static + Socket.IO, room codes, 2 players per room, last-snapshot
retention, disconnect grace period. Add an `npm run serve` script.

### Phase 3 — client session + lobby *(~1 day)*

`src/net/connection.js` and `src/net/session.js`. Title screen gets **Host game** / **Join
with code** next to the existing two buttons. Remote blob transforms interpolate rather
than simulate. Disable the AI in online mode.

### Phase 4 — robustness *(rest of the time)*

Server-enforced turn timeout so an AFK player can't stall the match, reconnect-and-catch-up,
"opponent disconnected" UI, optional spectators (free — they just receive the same stream).

---

## 7. Decisions (settled)

1. **2 to 4 players**, configurable — `CFG.maxTeams` is the only cap; add a team
   definition to `CFG.teams` to raise it.
2. **Cloudflare Tunnel from the dev machine.** No cloud host for now.
3. **Cheating doesn't matter**, so actor-authoritative stands and Phase 1 stayed simple.

---

## 8. What actually happened

The architecture survived contact with reality, but four desync bugs showed up that this
plan did not predict. All four were found by running two real browser clients against the
server and comparing terrain checksums, not by reading code.

**1. Variable frame `dt`.** The original loop stepped physics by whatever the frame took.
Two clients therefore integrated the same rocket with different step sizes and carved
craters in different places — a full terrain resync *every single shot*. Fixed by moving
the simulation onto a fixed 1/60 accumulator (`Game.step`), leaving only rendering on real
time. The projectile and blob physics use nothing but `+ - * /` and `sqrt`, all IEEE-exact,
so an identical timestep makes them bit-identical across machines. Side benefit: the game
is now frame-rate independent — verified identical results at 30, 60 and 144 fps.

**2. The muzzle moved.** An observer only knows the acting blob through the interpolated
pose stream, so its `shotOrigin()` sat centimetres away from the shooter's. Fixed by
carrying the exact firing position (and the homing lock) in the `fire` command, and
snapping the blob to it on *every* client including the shooter's.

**3. Two RNG streams, one seed.** The acting client burned draws on wind and crate rolls
during `nextTurn`, so it entered the turn body several values ahead of every observer —
and cluster bomblets scattered differently. Fixed by splitting into two streams: stream A
(`seed + turn*7919`) for turn setup, which only the actor runs, and stream B
(`seed + turn*7919 + 104729`) re-seeded inside `beginTurn`, the one point every client
passes through.

**4. The actor didn't eat its own rounding.** Snapshots round to two decimals to keep them
small, but the acting client kept full precision — so it flew its shots through marginally
different wind, from marginally different positions, than everyone it had just told. Fixed
by writing the rounded values back onto the actor in `captureSnapshot()` and rounding wind
at the point it's generated. **Transmit exactly what you use.**

After these, a 19-turn two-client match using the RNG-heaviest weapons (cluster, mortar,
firebomb, uzi, fruit bomb) produced **zero** drift events and identical terrain checksums,
health and crate counts on both clients. The resync path is now genuinely a safety net
rather than a per-turn cost.

### Where it landed

```
server/index.js   relay: rooms, slots, turn tracking, reconnect grace. No simulation.
src/net.js        client socket + the session object handed to Game as game.net
src/menu.js       title / local setup / host / join / lobby / pause screens
src/rng.js        seeded generator for everything that changes an outcome
```

`Game` gained `applyCommand`, `captureSnapshot`, `applySnapshot`, `beginTurn` and
`completeTurn`; local input and remote players now enter through the same door, which is
why offline behaviour is unchanged (16/16 weapons and 6/6 AI matches still pass).
