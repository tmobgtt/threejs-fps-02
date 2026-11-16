# TIDELINE - threejs-fps-02, entry v2 build log

Repo: ~/workspace/makefun/fps2-build-v2
Game: TIDELINE - Pier 9 freight terminal at dawn. Ember (attack) vs
Harbor (defence), 5v5, charge plant/defuse on two sites.

## Why v2 exists, and what it changes vs v1 (YARDLINE)

v1 was a complete 4v4 CS-style round game that placed mid-field. The
gap research said the leaders win on execution of the same loop, not
on more features: full 5v5, team-plan bots with roles and callouts,
one strongly themed map with a deliberate light script, juice and
sound, readable in 30 seconds, lean bytes. v2 is a ground-up rewrite
(no v1 game code carried over; only the kit's three.js, the kit
vendor library, the LICENSE and the owner claim file were kept) built
to exactly that brief:

- 5v5 (was 4v4): player + 4 Ember bots vs 5 Harbor bots, 12 rounds,
  halftime side swap with economy reset, first to 7.
- Team plan, called every round (hit the Coldstore / hit the Crane
  Dock, never the same site three rounds running) and announced in the
  HUD and the radio log; bot roles: entry, support, carrier, holds,
  a mid roamer.
- Radio callouts: first contact per team (throttled), charge down,
  charge planted, defusing - rendered in a radio feed and mirrored in
  the radar's intel rules (the radar only shows what the team has
  actually seen in the last 3 s).
- Bot aim is a model, not a lock-on: per-bot skill drives reaction
  time, an angular error that starts wide and settles while tracking,
  burst sizes by range, stop-to-shoot, strafe between bursts, crouch
  on settled long shots, cover-node peeking, rotation on shared
  intel, grouped retakes with a flash, kit-first defuser choice, and
  a stall fix: a carrier who recovers the dropped charge re-enters
  the push instead of holding a random spot.
- Gunplay deepened: per-weapon recoil patterns (the VK-7 climbs and
  hooks, the Ripper climbs loose), tagging (hits slow the victim),
  armour absorption by weapon penetration, distance falloff, wooden
  crates are thin cover and can be shot through at 55% damage, the
  Longshot is only accurate scoped and still. Six guns (knife, P9,
  Sidekick .45, Ripper SMG, Breacher 12 - new shotgun, VK-7,
  Longshot) plus HE / flash / smoke, vest, helmet, defuse kit.
- One map, art-directed: TIDELINE, a dawn freight pier - fog script,
  gradient dawn dome, low warm sun with shadows, lamp pools at the
  fights, roof-beamed coldstore with hanging work lamps, and red
  alert lights that pulse over a planted site. Ground markings,
  site letters and plant rings are painted by code onto the asphalt.
- Juice: tracers coloured per team, material-aware impact particles,
  soft-sprite particle system, shell casings, muzzle and explosion
  lights, shockwave rings, hitmarker + headshot/kill confirm sounds,
  damage-direction arc, hurt vignette, flashbang white-out graded by
  view angle, scope overlay, death spectate with click-to-cycle.
- Performance for a 1-CPU judge machine: instanced meshes for every
  repeated prop (one draw per material), pooled tracers / particles /
  casings / smoke (zero allocation in hot loops), fixed 60 Hz
  simulation split from rendering, pixel ratio capped at 1.5, one
  2048 shadow map, staggered bot perception (10 Hz), A* over a
  51-node waypoint graph with line-of-sight string-pulling.

## Layout

- main.ts (root): hands the entry in - copies game/ + screenshots/
  to the output dir, writes dossier.json with the kit's buildDossier.
- serve.ts (root): tiny static server for local play / screenshots.
- game/index.html: import map ("three" -> the vendored 0.187.0),
  HUD DOM, one module script.
- game/src/: palette (art direction), state (the one match state),
  world (map, collision, raycast, waypoints, A*), audio (all
  synthesized WebAudio), input, effects (pooled FX + smoke sight
  blocking), weapon (armoury, recoil patterns, hitscan, grenades),
  player (bodies, shared physics, controller, camera, view model),
  bots (perception, intel, aim model, tactics), hud (HUD, radar,
  buy menu, scoreboard), main (fixed-step loop, round machine,
  director mode). One job each; 150,353 bytes of source in total,
  under the 163,840-byte dossier text cap, so the judge reads every
  file whole.

## Tests (all local, this machine)

- Syntax: `node --check` passes on every game module.
- Headless play (puppeteer-core + Chromium, SwiftShader) driving
  real matches in director mode (?autoplay=1, ?timescale=N), with a
  read-only window.__probe() exposing phase, score, per-bot brain
  state and positions:
  - Full loop verified end to end across many rounds: buy -> plan
    called -> push -> NATURAL plant (carrier channels 3.2 s on a
    site waypoint) -> post-plant holds -> grouped retake -> rounds
    decided by detonation ("ROUND WON - CHARGE DETONATED +$2900"),
    by defuse ("CHARGE DEFUSED"), by elimination and by the clock,
    with economy, loss streaks and score carrying across rounds.
  - Final verification soaks: zero page errors, zero console errors.
  - Bugs the soaks caught, all fixed: (1) knife swings emitted
    gunfire-radius noise and a muzzle flash; (2) a carrier who
    recovered the dropped charge while holding camped it and
    stalled the round - carriers re-enter the push, and attackers
    commit when the clock drops under 45 s; (3) THE carrier bug:
    the plant destination was the site CENTRE, which sits inside
    solid scenery on both sites (the cold room, a container), so
    carriers ground the wall and no natural plant ever happened -
    carriers now plant from the site waypoint nearest the centre;
    (4) the waypoint graph was fragmented by the strict sight-line
    edge test (a cover node cannot link out through its own box),
    which also made siteCover('B') return undefined and crash bot
    brains - edges now use nav clearance (boxes shrunk by the body
    radius, 19 m reach, nearest-neighbour stitch), the graph is
    pruned to its largest component (46 nodes, both sites with
    cover and hold nodes, none isolated), and siteCover can no
    longer return undefined; (5) staging nodes were re-rolled every
    step, resetting paths and freezing squads at mid - they are
    picked once per plan now; (6) a surviving carrier kept the bomb
    flag into the next round, creating two "carriers" - the flag is
    reset with the round; (7) goTo now gives up on a destination
    after 16 s so no state machine can grind forever.
- Entrypoint determinism: two `MAKEFUN_OUTPUT_DIR=... node main.ts`
  runs produce byte-identical output trees (diff -r clean).
  dossier.json: 402,453 bytes (cap 1.5 MiB), 4 images, text
  155,870 of the 163,840-byte cap with the tail of every source
  file present - the judge reads the whole game. game/ ships
  16 files, 2,289,472 bytes (mostly the untouched three.js
  0.187.0 vendor pair, sha256 ef510bae...).
- Screenshots (in screenshots/, 1280x720 JPEG, all real renders of
  this code, verified by eye): 1-cover.jpg (the squad advancing
  through mid containers, both teams calling contact), 2-buy.jpg
  (buy menu over spawn, plan called), 3-planted.jpg (post-plant hold
  inside the coldstore, alert lights red, planter in frame),
  4-roundwon.jpg (round-end banner).
- Note: SwiftShader on this VM renders a few fps, so the timescale
  aid staged the screenshots; the simulation itself is fixed-step
  60 Hz and the frame loop clamps its delta, so slow machines stay
  correct, just slower.

## HEAD

Game code, entrypoint and screenshots:
15077eb78d7717db95a01c8f8a7bf3e68730c85f
(this log is committed on top of it; `git log -1` in this repo is
the final HEAD.)
