// bots.js - the bot brain: perception, memory, aim and tactics.
// Each bot runs the same loop a player does - see, decide, move, shoot -
// through the same physics and weapon code, so a fair fight is possible.
//
// Perception is honest: a bot only knows what it can see (a field-of-view
// cone, a real line-of-sight test against the map boxes, smoke blocks
// sight) or hear (gunfire and footsteps are noise events with a radius).
// Sightings go into the team's shared intel with a timestamp, so one
// bot's contact becomes the whole team's rotation a second later.
//
// Aim is a model, not a lock-on: acquiring a target starts with a wide
// angular error that settles toward a skill floor while the bot tracks,
// and firing disturbs it again. Bots fire in bursts sized by range,
// stop moving to shoot, strafe between bursts, and use cover nodes to
// peek. Skill is per-bot: reaction time, settle rate and error floor.
//
// Tactics are state machines over the waypoint graph: defenders take
// hold positions at the sites and rotate on intel; attackers run a
// called plan (hit A, hit B, split mid), throw flash and smoke at the
// entry, plant, and then hold the site from cover; defenders retake
// together, one defusing while the others watch the doors.

import * as THREE from 'three';
import { G, enemiesOf, aliveOf, reportIntel, freshIntel } from './state.js';
import { nodes, findPath, segClear, SITES, siteAt, nearestZoneName } from './world.js';
import { stepPhysics } from './player.js';
import { currentItem, currentDef, tryFire, startReload, throwGrenade, eyePos } from './weapon.js';
import { smokeBlocks } from './effects.js';

const _eye = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _aim = new THREE.Vector3();

let uid = 1;
export function makeBrain(a, skill) {
  const b = {
    id: uid++,
    skill,                       // 0..1
    state: 'route',
    path: [], pathI: 0, destX: 0, destZ: 0, hasDest: false,
    post: null,                  // node this bot holds or pushes to
    role: 'rifle',               // 'entry' | 'support' | 'carrier' | 'hold' | 'roam'
    senseT: Math.random() * 0.1,
    target: null,                // actor currently engaged
    seenT: -9,                   // last time the target was visible
    reactAt: 0,                  // may not fire before this time
    aimErr: 0.1,
    burstLeft: 0, burstPauseT: 0,
    strafeDir: 1, strafeT: 0,
    peekT: 0, peekOut: true,
    channelT: 0,
    stuckT: 0, stepSide: 0,
    nadeUsed: false,
    rotateAt: 0,
    waitT: 0,
    faceX: 0, faceZ: 0, hasFace: false,
    lastKnown: null,             // {x, z, t} of the current target
    knifeRun: false,
  };
  a.brain = b;
  return b;
}

function reactionTime(b, dist) {
  return (0.62 - b.skill * 0.34) * (dist > 30 ? 1.25 : 1);
}
function aimFloor(b) { return 0.007 + (1 - b.skill) * 0.02; }

// ---- perception ------------------------------------------------------------
function canSee(a, b, t) {
  const e = t;
  const dx = e.pos.x - a.pos.x, dz = e.pos.z - a.pos.z;
  const d2 = dx * dx + dz * dz;
  if (d2 > 75 * 75) return false;
  const d = Math.sqrt(d2);
  if (d > 6.5) {
    // field of view: 110 degrees around the facing direction
    const fx = -Math.sin(a.yaw), fz = -Math.cos(a.yaw);
    const dot = (fx * dx + fz * dz) / (d || 1);
    if (dot < 0.34) return false;
  }
  eyePos(a, _eye);
  const ty = e.pos.y + (e.crouch ? 1.0 : 1.35);
  if (!segClear(_eye.x, _eye.y, _eye.z, e.pos.x, ty, e.pos.z)) return false;
  if (smokeBlocks(_eye.x, _eye.y, _eye.z, e.pos.x, ty, e.pos.z, G.time)) return false;
  return true;
}

function sense(a, b, dt) {
  b.senseT -= dt;
  // hearing works every step: noise events are cheap to scan
  for (const n of G.noise) {
    if (n.team === a.team || G.time - n.t > 1.1) continue;
    const d = Math.hypot(n.x - a.pos.x, n.z - a.pos.z);
    if (d < n.r) {
      reportIntel(a.team, { id: -1 }, n.x, n.z); // position-only intel
      if ((b.state === 'hold' || b.state === 'route') && d < 20) { b.faceX = n.x; b.faceZ = n.z; b.hasFace = true; }
    }
  }
  if (b.senseT > 0) return;
  b.senseT = 0.1;
  let best = null, bestD = 1e9;
  for (const e of enemiesOf(a)) {
    if (canSee(a, b, e)) {
      reportIntel(a.team, e, e.pos.x, e.pos.z);
      const d = Math.hypot(e.pos.x - a.pos.x, e.pos.z - a.pos.z);
      if (d < bestD) { bestD = d; best = e; }
    }
  }
  if (best) {
    if (b.target !== best) {
      b.target = best;
      b.reactAt = G.time + reactionTime(b, bestD);
      b.aimErr = 0.05 + (1 - b.skill) * 0.085;
      // radio callout on first contact, throttled per team
      if (G.time - G.contactT[a.team] > 18) {
        G.contactT[a.team] = G.time;
        G.callouts.push({ team: a.team, text: `${a.name}: contact, ${nearestZoneName(best.pos.x, best.pos.z)}`, t: G.time });
      }
    }
    b.seenT = G.time;
    b.lastKnown = { x: best.pos.x, z: best.pos.z, t: G.time };
  }
}

// ---- movement helpers --------------------------------------------------------
function faceToward(a, x, z, dt, rate = 9) {
  const want = Math.atan2(-(x - a.pos.x), -(z - a.pos.z));
  let d = want - a.yaw;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  a.yaw += THREE.MathUtils.clamp(d, -rate * dt, rate * dt);
}
function setDest(b, x, z) {
  if (b.hasDest && Math.hypot(b.destX - x, b.destZ - z) < 1.5 && b.path.length) return;
  b.destX = x; b.destZ = z; b.hasDest = true;
  b.destT = 0;
  b.path = findPath(b._ax, b._az, x, z);
  b.pathI = 0;
}
// A staging node is picked once per plan, not re-rolled every step:
// re-rolling kept resetting paths and froze whole squads at mid.
function stagingFor(b, key, site) {
  if (b.stageFor !== key) { b.stageNode = siteStaging(site); b.stageFor = key; }
  return b.stageNode;
}
// Walk the path; returns true on arrival. Steering faces travel dir.
function goTo(a, b, dt, cap, arrive = 1.1) {
  if (!b.hasDest) return true;
  // give up on a destination that cannot be reached: better for the
  // state machine to advance than to grind a wall for a whole round
  b.destT = (b.destT || 0) + dt;
  if (b.destT > 16) { b.hasDest = false; b.destT = 0; stepPhysics(a, dt, 0, 0, cap, false); return true; }
  const dx = b.destX - a.pos.x, dz = b.destZ - a.pos.z;
  if (Math.hypot(dx, dz) < arrive) { b.hasDest = false; stepPhysics(a, dt, 0, 0, cap, false); return true; }
  let tx = b.destX, tz = b.destZ;
  if (b.pathI < b.path.length) {
    tx = b.path[b.pathI].x; tz = b.path[b.pathI].z;
    if (Math.hypot(tx - a.pos.x, tz - a.pos.z) < 1.4) { b.pathI++; return goTo(a, b, dt, cap, arrive); }
  }
  const d = Math.hypot(tx - a.pos.x, tz - a.pos.z) || 1;
  let wx = (tx - a.pos.x) / d, wz = (tz - a.pos.z) / d;
  // stuck? sidestep briefly, hop if that fails
  if (a.groundSpeed < 0.35) {
    b.stuckT += dt;
    if (b.stuckT > 0.55) {
      if (b.stepSide === 0) b.stepSide = Math.random() < 0.5 ? 1 : -1;
      const px = -wz * b.stepSide, pz = wx * b.stepSide;
      wx = px; wz = pz;
      if (b.stuckT > 1.1) { stepPhysics(a, dt, wx, wz, cap, true); b.stuckT = 0; b.stepSide = 0; return false; }
    }
  } else { b.stuckT = 0; b.stepSide = 0; }
  faceToward(a, a.pos.x + wx, a.pos.z + wz, dt, 7);
  stepPhysics(a, dt, wx, wz, cap, false);
  return false;
}
function holdStill(a, dt) { stepPhysics(a, dt, 0, 0, 0, false); }

// ---- combat ------------------------------------------------------------------
function engage(a, b, dt, rng) {
  const t = b.target;
  if (!t || !t.alive) { b.target = null; return false; }
  const visible = G.time - b.seenT < 0.22;
  const dx = t.pos.x - a.pos.x, dz = t.pos.z - a.pos.z;
  const dist = Math.hypot(dx, dz);
  if (!visible && G.time - b.seenT > 3) { b.target = null; return false; }
  // flashed bots turn away and stop shooting: the flash did its job
  if (a.flashT > 0.5) {
    a.yaw += dt * 5.5;
    holdStill(a, dt);
    return true;
  }
  if (a.slot === 'knife') a.slot = a.inv.primary ? 'primary' : 'secondary';
  faceToward(a, t.pos.x, t.pos.z, dt, 12);
  // aim point: head for a settled, skilled shot at a still target,
  // otherwise centre mass
  const settle = b.aimErr < aimFloor(b) * 1.7;
  const aimY = t.pos.y + (settle && b.skill > 0.45 && t.groundSpeed < 1 ? 1.52 : 1.12);
  eyePos(a, _eye);
  _aim.set(t.pos.x - _eye.x, aimY - _eye.y, t.pos.z - _eye.z).normalize();
  a.pitch = Math.asin(THREE.MathUtils.clamp(_aim.y, -1, 1));
  // the error model: settle while tracking, jump when the target sprints
  const floor = aimFloor(b) * (1 + t.groundSpeed * 0.14);
  const rate = 1.6 + b.skill * 2.4;
  b.aimErr += (floor - b.aimErr) * (1 - Math.exp(-dt * rate));
  const canFire = G.time >= b.reactAt && visible && G.phase !== 'buy';
  const item = currentItem(a);
  const def = currentDef(a);
  if (!item || !def) return true;
  if (item.mag === 0 && def.mag > 0) { startReload(a); }
  let wantMove = 0;
  if (b.burstPauseT > 0) {
    b.burstPauseT -= dt;
    wantMove = 1; // strafe between bursts
  } else if (canFire) {
    if (b.burstLeft <= 0) {
      b.burstLeft = dist < 11 ? 6 : dist < 26 ? 3 + Math.floor(rng() * 2) : 2;
      if (def.key === 'longshot' || def.key === 'breacher' || !def.auto) b.burstLeft = 1;
    }
    // fire one bullet along the perturbed aim direction
    const err = b.aimErr * (a.groundSpeed > 1 ? 1.7 : 1);
    _dir.copy(_aim);
    _dir.x += ((rng() * 2 - 1) + (rng() * 2 - 1)) * 0.5 * err;
    _dir.y += ((rng() * 2 - 1) + (rng() * 2 - 1)) * 0.5 * err * 0.7;
    _dir.z += ((rng() * 2 - 1) + (rng() * 2 - 1)) * 0.5 * err;
    _dir.normalize();
    a.ads = def.key === 'longshot';
    const r = tryFire(a, _dir, rng, 0.5);
    if (r === 'fired') {
      b.burstLeft--;
      b.aimErr += 0.005;
      if (b.burstLeft <= 0) b.burstPauseT = 0.55 - b.skill * 0.27;
    } else if (r === 'dry') startReload(a);
    a.ads = false;
  }
  // movement while fighting: strafe in the pause, plant feet to fire,
  // crouch for long settled shots, close distance if far with a short gun
  if (wantMove) {
    b.strafeT -= dt;
    if (b.strafeT <= 0) { b.strafeT = 0.45 + rng() * 0.6; b.strafeDir = rng() < 0.5 ? -1 : 1; }
    const px = -dz / (dist || 1) * b.strafeDir, pz = dx / (dist || 1) * b.strafeDir;
    stepPhysics(a, dt, px, pz, 3.4, false);
  } else if (dist > 34 && def.falloff < 40) {
    stepPhysics(a, dt, dx / dist, dz / dist, 4.2, false); // SMG/shotgun pushes in
  } else {
    a.crouch = settle && dist > 16 && b.skill > 0.4;
    holdStill(a, dt);
  }
  if (!visible && b.lastKnown) {
    // lost him: push the last known position
    setDest(b, b.lastKnown.x, b.lastKnown.z);
    goTo(a, b, dt, 4.4);
    if (G.time - b.seenT > 3) b.target = null;
  }
  return true;
}

// ---- roles and plans -----------------------------------------------------------
const SMOKES = { A: { x: 29, z: -24 }, B: { x: 33, z: 25 } };
const FLASHES = { A: { x: 34, z: -25, y: 2.4 }, B: { x: 39, z: 28, y: 2.6 } };

export function assignRoles() {
  const defs = aliveOf('def').filter((x) => !x.isPlayer);
  const atks = aliveOf('atk').filter((x) => !x.isPlayer);
  const holdA = nodes.filter((n) => n.hold && n.site === 'A');
  const holdB = nodes.filter((n) => n.hold && n.site === 'B');
  const mid = nodes.filter((n) => n.zone === 'mid' && n.cover);
  defs.forEach((d, i) => {
    const b = d.brain;
    b.role = 'hold';
    const holds = i % 2 === 0 ? holdA : holdB;
    b.post = i % 5 === 4 ? mid[Math.floor(Math.random() * mid.length)]
      : holds.length ? holds[Math.floor(i / 2) % holds.length] : mid[0];
    b.state = 'route';
    b.hasDest = false;
    b.nadeUsed = false;
  });
  const site = G.planSite;
  atks.forEach((d, i) => {
    const b = d.brain;
    b.role = d.hasBomb ? 'carrier' : i === 0 ? 'entry' : 'support';
    b.post = null;
    b.state = 'route';
    b.hasDest = false;
    b.nadeUsed = false;
    b.site = site;
  });
  // the human's teammates use the same plan; the human is free
  const mates = aliveOf('atk').filter((x) => x.isPlayer);
  void mates;
}

function siteStaging(site) {
  // a cover node just outside the site to group up on
  const cands = nodes.filter((n) => n.cover && Math.hypot(n.x - SITES[site].cx, n.z - SITES[site].cz) < 26);
  return cands[Math.floor(Math.random() * cands.length)] || nodes[0];
}
function siteCover(site) {
  const cands = nodes.filter((n) => n.site === site && n.cover);
  // never hand back undefined: a missing cover node must degrade to
  // any node, not crash the brain that asked for it
  return cands[Math.floor(Math.random() * cands.length)]
    || nodes.find((n) => n.site === site) || nodes[0];
}

function throwAt(a, b, kind, spot, rng) {
  if (a.inv[kind] <= 0) return false;
  a.slot = kind;
  faceToward(a, spot.x, spot.z, 1, 99);
  eyePos(a, _eye);
  const dx = spot.x - _eye.x, dz = spot.z - _eye.z;
  const d = Math.hypot(dx, dz);
  a.pitch = Math.atan2((spot.y || 1.2) - _eye.y + d * 0.16, d);
  const ok = throwGrenade(a, kind, rng);
  a.slot = a.inv.primary ? 'primary' : 'secondary';
  return ok;
}

// ---- the per-step brain ---------------------------------------------------------
export function updateBot(a, dt, rng) {
  const b = a.brain;
  if (!b || !a.alive) return;
  b._ax = a.pos.x; b._az = a.pos.z;
  a.crouch = false;
  if (G.phase === 'buy') { holdStill(a, dt); return; } // freeze time: nobody moves
  sense(a, b, dt);
  const fighting = b.target && G.time - b.seenT < 3 && G.phase !== 'buy';
  if (fighting && engage(a, b, dt, rng)) return;
  if (a.flashT > 0.5) { holdStill(a, dt); return; }

  const bomb = G.bomb;
  switch (b.state) {
    case 'route': {
      // defenders to their posts, attackers toward the called site
      if (a.team === 'def') {
        if (b.post) {
          setDest(b, b.post.x, b.post.z);
          if (goTo(a, b, dt, b.knifeRun ? 5 : 4.5)) { b.state = 'hold'; b.peekT = 0; }
        }
      } else {
        const site = b.site || G.planSite;
        const stage = stagingFor(b, 'route:' + site, site);
        setDest(b, stage.x, stage.z);
        const near = Math.hypot(stage.x - a.pos.x, stage.z - a.pos.z) < 7;
        if (goTo(a, b, dt, 4.5) || near) b.state = 'push';
      }
      break;
    }
    case 'hold': {
      // watch the lane: peek in and out of the cover line on a timer
      b.peekT -= dt;
      if (b.peekT <= 0) { b.peekT = 0.9 + rng() * 1.4; b.peekOut = !b.peekOut; }
      if (b.hasFace) faceToward(a, b.faceX, b.faceZ, dt, 5);
      else if (b.post) faceToward(a, a.team === 'def' ? -20 : SITES[b.post.site || 'A'].cx, a.pos.z, dt, 3);
      a.crouch = !b.peekOut;
      holdStill(a, dt);
      // rotation: fresh intel says the fight is at the other site
      if (a.team === 'def' && !bomb.planted) {
        const intel = freshIntel('def', 5);
        const other = intel.find((s) => siteAt(s.x, s.z) && siteAt(s.x, s.z) !== (b.post && b.post.site));
        const mine = intel.some((s) => siteAt(s.x, s.z) === (b.post && b.post.site));
        if (other && !mine && rng() < 0.012 + b.skill * 0.01) {
          const s2 = siteAt(other.x, other.z);
          const posts = nodes.filter((n) => n.hold && n.site === s2);
          b.post = posts[Math.floor(rng() * posts.length)] || b.post;
          b.state = 'route'; b.hasDest = false;
        }
      }
      if (bomb.planted && a.team === 'def') { b.state = 'retake'; b.waitT = 0; }
      if (bomb.planted && a.team === 'atk') { /* already home: keep holding */ }
      break;
    }
    case 'push': {
      const site = b.site || G.planSite;
      // utility first: smoke the cross, flash the entry, then walk in
      if (!b.nadeUsed && b.role !== 'entry') {
        const sm = SMOKES[site];
        const dSm = Math.hypot(sm.x - a.pos.x, sm.z - a.pos.z);
        if (a.inv.smoke > 0 && dSm > 6 && dSm < 17 && throwAt(a, b, 'smoke', sm, rng)) b.nadeUsed = true;
      }
      if (!b.nadeUsed && b.role === 'support') {
        const fl = FLASHES[site];
        const dFl = Math.hypot(fl.x - a.pos.x, fl.z - a.pos.z);
        if (a.inv.flash > 0 && dFl > 6 && dFl < 17 && throwAt(a, b, 'flash', fl, rng)) { b.nadeUsed = true; b.waitT = 0.7; }
      }
      if (b.waitT > 0) { b.waitT -= dt; holdStill(a, dt); break; }
      if (a.hasBomb) {
        // plant from a waypoint on the site: the site CENTRE can sit
        // inside solid scenery (the cold room, a container), and a
        // carrier sent there grinds the wall and never arrives
        if (!b.plantNode || b.plantNodeFor !== site) {
          const s = SITES[site];
          b.plantNode = nodes.filter((n) => n.site === site)
            .reduce((best, n) => (!best || Math.hypot(n.x - s.cx, n.z - s.cz)
              < Math.hypot(best.x - s.cx, best.z - s.cz) ? n : best), null) || siteCover(site);
          b.plantNodeFor = site;
        }
        setDest(b, b.plantNode.x, b.plantNode.z);
        if (goTo(a, b, dt, 4.4, 0.9)) b.state = 'plant';
      } else {
        const cov = siteCover(site);
        setDest(b, cov.x, cov.z);
        if (goTo(a, b, dt, 4.4)) { b.state = 'hold'; b.post = cov; }
      }
      break;
    }
    case 'plant': {
      holdStill(a, dt);
      if (a.lastHitT > G.time - 1.2) { b.state = 'push'; b.channelT = 0; break; } // interrupted
      b.channelT += dt;
      G.channel = { actor: a, label: 'PLANTING THE CHARGE', frac: b.channelT / 3.2 };
      if (b.channelT >= 3.2) {
        G.events.push({ type: 'planted', actor: a, site: siteAt(a.pos.x, a.pos.z) || b.site || G.planSite });
        b.channelT = 0;
        b.state = 'hold';
        const cov = siteCover(b.site || G.planSite);
        b.post = cov; b.hasDest = false;
      }
      break;
    }
    case 'retake': {
      // group up at the staging node, then go in together
      const site = bomb.site;
      if (!site) { b.state = 'hold'; break; }
      const stage = stagingFor(b, 'retake:' + site + ':' + G.round, site);
      const mates = aliveOf('def').length;
      b.waitT += dt;
      const near = Math.hypot(stage.x - a.pos.x, stage.z - a.pos.z) < 8;
      if (!near && b.waitT < 7) { setDest(b, stage.x, stage.z); goTo(a, b, dt, 4.6); break; }
      if (!b.nadeUsed && a.inv.flash > 0) {
        const fl = FLASHES[site];
        if (Math.hypot(fl.x - a.pos.x, fl.z - a.pos.z) < 17 && throwAt(a, b, 'flash', fl, rng)) b.nadeUsed = true;
      }
      // one defuses (the kit owner first), the rest hold the doors
      const defusers = aliveOf('def').filter((x) => x.brain && x.brain.state === 'defuse');
      const iAmDefuser = (a.hasKit || aliveOf('def').every((x) => x === a || !x.hasKit)) && defusers.length === 0;
      if (iAmDefuser && bomb.pos) {
        setDest(b, bomb.pos.x, bomb.pos.z);
        if (goTo(a, b, dt, 4.6, 0.9)) b.state = 'defuse';
      } else {
        const cov = siteCover(site);
        setDest(b, cov.x, cov.z);
        if (goTo(a, b, dt, 4.5)) b.state = 'hold';
      }
      break;
    }
    case 'defuse': {
      holdStill(a, dt);
      faceToward(a, bomb.pos ? bomb.pos.x : a.pos.x, bomb.pos ? bomb.pos.z : a.pos.z, dt, 6);
      if (a.lastHitT > G.time - 0.8) { b.state = 'retake'; b.channelT = 0; break; }
      b.channelT += dt;
      const need = a.hasKit ? 2.6 : 5.2;
      G.channel = { actor: a, label: 'DEFUSING THE CHARGE', frac: b.channelT / need };
      if (b.channelT >= need) {
        G.events.push({ type: 'defused', actor: a });
        b.channelT = 0;
        b.state = 'hold';
      }
      break;
    }
    default: b.state = 'route';
  }
  // a carrier who picked the charge up mid-round goes back on the plan
  if (a.hasBomb && (b.state === 'hold' || b.state === 'route') && G.phase === 'live') {
    b.state = 'push';
    b.site = G.planSite;
    b.hasDest = false;
  }
  // late-round urgency: with the clock under 45 s and nothing planted,
  // attackers stop holding and commit to the plan site
  if (a.team === 'atk' && G.phase === 'live' && G.phaseT < 45 && !bomb.planted
    && (b.state === 'hold' || b.state === 'route') && !b.target) {
    b.state = 'push';
    b.site = G.planSite;
    b.hasDest = false;
  }
  // dropped bomb: the nearest attacker goes and picks it up
  if (a.team === 'atk' && bomb.droppedAt && !bomb.carrier && !bomb.planted) {
    const d = Math.hypot(bomb.droppedAt.x - a.pos.x, bomb.droppedAt.z - a.pos.z);
    const mates = aliveOf('atk').filter((x) => !x.isPlayer);
    const iAmNearest = mates.every((x) => x === a || Math.hypot(bomb.droppedAt.x - x.pos.x, bomb.droppedAt.z - x.pos.z) >= d);
    if (iAmNearest && b.state !== 'plant') {
      setDest(b, bomb.droppedAt.x, bomb.droppedAt.z);
      goTo(a, b, dt, 4.7, 0.9);
    }
  }
  // long quiet rotations are faster with the knife out
  const item = currentItem(a);
  b.knifeRun = b.state === 'route' && !fighting && (!b.hasDest || Math.hypot(b.destX - a.pos.x, b.destZ - a.pos.z) > 24);
  if (b.knifeRun && a.slot !== 'knife') a.slot = 'knife';
  else if (!b.knifeRun && a.slot === 'knife') a.slot = item && a.inv.primary ? 'primary' : 'secondary';
  if (item && item.mag === 0 && currentDef(a) && currentDef(a).mag > 0 && !fighting) startReload(a);
}
