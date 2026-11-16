// main.js - TIDELINE's conductor.
// Boots three.js, builds the world and the ten combatants, then runs a
// fixed-step simulation (60 Hz, accumulator, rendering interpolated by
// the frame itself) that owns the round state machine: buy, live,
// planted, over - with the halftime side swap, the economy payouts,
// bomb plant / defuse / detonation, spectating after death, and the
// director mode (?autoplay=1) that lets a bot drive the player so the
// game's own systems can be watched and photographed.

import * as THREE from 'three';
import { G, TEAM_NAMES, PAY, lossStreak, lossPay, payActor, makeActor, aliveOf, resetMatch, resetBomb } from './state.js';
import { buildWorld, SPAWNS, SITES, siteAt, nodes } from './world.js';
import { mat } from './palette.js';
import { initAudio, resumeAudio } from './audio.js';
import { initInput, mouse, consumeMouse, down, takePress, clearPresses } from './input.js';
import { initEffects, updateEffects, setFxCamera, smokeClouds, fxExplosion } from './effects.js';
import {
  WEAPONS, NADES, hooks, resetLoadout, currentItem, heldNade, tryFire, startReload,
  throwGrenade, updateWeapons, updateProjectiles, clearProjectiles, initNades, buyItem, botBuy, viewDir,
} from './weapon.js';
import { createBody, syncBody, controlPlayer, buildViewModel, syncViewModel, updateCamera, stepPhysics } from './player.js';
import { makeBrain, updateBot, assignRoles } from './bots.js';
import * as HUD from './hud.js';
import * as SFX from './audio.js';

const STEP = 1 / 60;
const params = new URLSearchParams(location.search);
const AUTOPLAY = params.has('autoplay');
const TIMESCALE = Math.min(20, Math.max(0.25, Number(params.get('timescale') || 1)));
const STAGE = params.get('stage');
const rng = Math.random;

// ---- renderer / scene -------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.domElement.className = 'webgl';
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(90, innerWidth / innerHeight, 0.08, 420);
scene.add(camera);
buildWorld(scene);
initEffects(scene);
initNades(scene);
setFxCamera(camera);
buildViewModel(camera);

// site alert lights: dark until the charge is planted, then pulsing red
const alertLights = {};
for (const k of ['A', 'B']) {
  const l = new THREE.PointLight(0xff3524, 0, 34, 1.5);
  l.position.set(SITES[k].cx, 4.2, SITES[k].cz);
  scene.add(l);
  alertLights[k] = l;
}
// the charge itself: a dark box with a blinking tell-tale
const bombMesh = new THREE.Group();
{
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.2, 0.13), mat(0x23272a, 0.5, 0.4));
  box.castShadow = true;
  bombMesh.add(box);
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6),
    new THREE.MeshStandardMaterial({ color: 0xff3524, emissive: 0xff3524, emissiveIntensity: 2 }));
  lamp.position.set(0.1, 0.12, 0);
  bombMesh.add(lamp);
  bombMesh.userData.lamp = lamp;
  scene.add(bombMesh);
}

// ---- cast ---------------------------------------------------------------------
const player = makeActor('atk', 'YOU', true);
player.pos = new THREE.Vector3(); player.vel = new THREE.Vector3();
G.player = player;
const CAST = [
  ['atk', 'Vex', 0.55], ['atk', 'Rook', 0.7], ['atk', 'Sable', 0.45], ['atk', 'Iona', 0.62],
  ['def', 'Cato', 0.6], ['def', 'Wren', 0.5], ['def', 'Hollis', 0.72], ['def', 'Marsh', 0.48], ['def', 'Vane', 0.66],
];
for (const [team, name, skill] of CAST) {
  const a = makeActor(team, name, false);
  a.pos = new THREE.Vector3(); a.vel = new THREE.Vector3();
  makeBrain(a, skill);
}
if (AUTOPLAY) makeBrain(player, 0.62);
for (const a of G.actors) {
  createBody(a, scene);
  if (a.isPlayer) a.body.grp.visible = false;
  resetLoadout(a);
}

// ---- combat hooks ---------------------------------------------------------------
let hurtT = 0;
let spectateTarget = null;
hooks.onDamage = (attacker, target, dmg, zone) => {
  if (target.isPlayer && attacker && attacker !== target) {
    const ang = Math.atan2(-(attacker.pos.x - target.pos.x), -(attacker.pos.z - target.pos.z));
    HUD.damageFrom(ang, target.yaw);
    hurtT = 0.35;
    SFX.sfxHurt();
  }
  if (attacker && attacker.isPlayer) HUD.showHitmarker(zone === 'head', false);
};
hooks.onKill = (attacker, target, key, head) => {
  target.alive = false;
  target.deaths++;
  if (attacker && attacker !== target) {
    attacker.kills++;
    payActor(attacker, PAY.kill);
    if (attacker.isPlayer) { SFX.sfxKill(); HUD.showHitmarker(head, true); }
  }
  G.killfeed.push({
    killer: attacker ? attacker.name : 'THE PIER',
    killerTeam: attacker ? attacker.team : target.team,
    victim: target.name, victimTeam: target.team,
    weapon: (WEAPONS[key] && WEAPONS[key].name) || (NADES[key] && NADES[key].name) || key,
    head, t: G.time,
  });
  if (target.hasBomb) {
    target.hasBomb = false;
    G.bomb.carrier = null;
    G.bomb.droppedAt = { x: target.pos.x, y: 0, z: target.pos.z };
    G.callouts.push({ team: target.team, text: 'The charge is down!', t: G.time });
  }
  if (target.isPlayer) spectateTarget = null;
};

// ---- round / match flow -----------------------------------------------------------
let planHistory = [];
let defuseCalled = false;
let playerChannelT = 0;
let beepT = 0;
let stageApplied = false;
let stageHoldPlayer = false;

function sideToSquad(side) { return (side === 'atk') !== G.swapped ? 'ember' : 'harbor'; }

function pickPlan() {
  let site = rng() < 0.5 ? 'A' : 'B';
  if (planHistory.length >= 2 && planHistory[planHistory.length - 1] === site && planHistory[planHistory.length - 2] === site) {
    site = site === 'A' ? 'B' : 'A';
  }
  planHistory.push(site);
  return site;
}

function doSwap() {
  G.swapped = true;
  for (const a of G.actors) {
    a.team = a.team === 'atk' ? 'def' : 'atk';
    scene.remove(a.body.grp);
    createBody(a, scene);
    if (a.isPlayer) a.body.grp.visible = false;
    resetLoadout(a);
    a.money = 800;
  }
  lossStreak.atk = 0; lossStreak.def = 0;
  G.score.atk = 0; G.score.def = 0;
}

function startRound() {
  if (G.round === 6 && !G.swapped) doSwap();
  resetBomb();
  clearProjectiles();
  smokeClouds.length = 0;
  G.events.length = 0;
  G.channel = null;
  defuseCalled = false;
  playerChannelT = 0;
  const byTeam = { atk: 0, def: 0 };
  for (const a of G.actors) {
    const idx = byTeam[a.team]++;
    const [sx, sz] = SPAWNS[a.team][idx % SPAWNS[a.team].length];
    a.pos.set(sx, 0, sz);
    a.vel.set(0, 0, 0);
    a.yaw = a.team === 'atk' ? -Math.PI / 2 : Math.PI / 2;
    a.pitch = 0; a.punchP = 0; a.punchY = 0;
    a.crouch = false; a.ads = false;
    a.hp = 100; a.alive = true;
    a.hasBomb = false; // last round's carrier must not keep the flag
    a.tagT = 0; a.flashT = 0; a.lastHitT = -9;
    if (a._diedLast) { resetLoadout(a); a._diedLast = false; }
    else {
      const it = currentItem(a);
      if (it) { it.reloadEnd = 0; it.nextAt = 0; it.bloom = 0; }
    }
    if (a.brain) { a.brain.target = null; a.brain.seenT = -9; a.brain.channelT = 0; a.brain.hasDest = false; }
  }
  // the charge goes to a random attacker; the plan is called
  const atks = aliveOf('atk');
  const carrier = atks[Math.floor(rng() * atks.length)];
  carrier.hasBomb = true;
  G.bomb.carrier = carrier;
  G.planSite = pickPlan();
  assignRoles();
  for (const a of G.actors) if (!a.isPlayer && a.brain) botBuy(a, rng);
  G.phase = 'buy';
  G.phaseT = 12;
  G.callouts.push({
    team: 'atk',
    text: carrier.isPlayer ? 'You have the charge. Team plan: ' + (G.planSite === 'A' ? 'hit the Coldstore' : 'hit the Crane Dock')
      : `${carrier.name} has the charge. Plan: ${G.planSite === 'A' ? 'hit the Coldstore' : 'hit the Crane Dock'}`,
    t: G.time,
  });
  HUD.showBanner(`ROUND ${G.round + 1}`, player.team === 'atk'
    ? (G.planSite === 'A' ? 'PLANT AT THE COLDSTORE - OR WIPE THEM OUT' : 'PLANT AT THE CRANE DOCK - OR WIPE THEM OUT')
    : 'HOLD THE SITES', 2.4);
  if (STAGE === 'buy') HUD.setBuyOpen(true);
}

function endRound(winnerSide, reason) {
  if (G.phase === 'over' || G.phase === 'matchover') return;
  const objective = reason.includes('CHARGE');
  for (const a of G.actors) {
    if (a.team === winnerSide) payActor(a, objective ? PAY.winObjective : PAY.winElim);
    else payActor(a, lossPay(lossStreak[a.team] + 1));
    a._diedLast = !a.alive;
  }
  lossStreak[winnerSide] = 0;
  lossStreak[winnerSide === 'atk' ? 'def' : 'atk']++;
  G.score[winnerSide]++;
  G.squadScore[sideToSquad(winnerSide)]++;
  G.roundLog.push(`R${G.round + 1}: ${winnerSide} - ${reason}`);
  G.round++;
  const playerWon = player.team === winnerSide;
  SFX.sfxRound(playerWon);
  const decided = G.squadScore.ember >= G.winsNeeded || G.squadScore.harbor >= G.winsNeeded || G.round >= G.maxRounds;
  if (reason === 'CHARGE DETONATED' && G.bomb.pos) {
    fxExplosion(G.bomb.pos.x, 0.6, G.bomb.pos.z, G.time);
    SFX.sfxExplosion(4);
  }
  if (decided) {
    G.phase = 'matchover';
    G.over = true;
    const emberWon = G.squadScore.ember > G.squadScore.harbor;
    const playerSquadWon = (sideToSquad(player.team) === 'ember') === emberWon;
    G.winner = emberWon ? 'ember' : 'harbor';
    SFX.sfxMatch(playerSquadWon);
    HUD.showBanner(G.squadScore.ember === G.squadScore.harbor ? 'MATCH DRAWN' : playerSquadWon ? 'MATCH WON' : 'MATCH LOST',
      `EMBER ${G.squadScore.ember} - ${G.squadScore.harbor} HARBOR - PRESS ENTER TO PLAY AGAIN`, 30);
  } else {
    G.phase = 'over';
    G.phaseT = 5.5;
    HUD.showBanner(playerWon ? 'ROUND WON' : 'ROUND LOST', `${reason} - ${playerWon ? '+' : ''}$${playerWon ? (objective ? PAY.winObjective : PAY.winElim) : lossPay(lossStreak[player.team])}`, 4.6);
  }
}

function startMatch() {
  const wasSwapped = G.swapped;
  resetMatch();
  planHistory = [];
  for (const a of G.actors) { resetLoadout(a); a._diedLast = false; }
  if (wasSwapped) doSwapBack();
  G.round = 0;
  stageApplied = false;
  stageHoldPlayer = false;
  startRound();
}
function doSwapBack() {
  // undo the halftime swap for a fresh match (teams flip back, quietly)
  G.swapped = false;
  for (const a of G.actors) {
    a.team = a.team === 'atk' ? 'def' : 'atk';
    scene.remove(a.body.grp);
    createBody(a, scene);
    if (a.isPlayer) a.body.grp.visible = false;
  }
}

// ---- events from the bots ------------------------------------------------------
function drainEvents() {
  for (const ev of G.events) {
    if (ev.type === 'planted' && !G.bomb.planted) {
      const a = ev.actor;
      G.bomb.planted = true;
      G.bomb.site = ev.site;
      G.bomb.pos = { x: a.pos.x, y: 0, z: a.pos.z };
      G.bomb.carrier = null;
      G.bomb.fuse = 40;
      a.hasBomb = false;
      G.bomb.planter = a;
      payActor(a, PAY.plant);
      for (const t of aliveOf('atk')) payActor(t, PAY.plantTeam);
      G.phase = 'planted';
      G.callouts.push({ team: 'atk', text: `${a.name}: charge planted, ${SITES[ev.site].name.toLowerCase()}`, t: G.time });
      SFX.sfxPlantBeep(true);
      if (player.team === 'def') HUD.showBanner('CHARGE PLANTED', `SITE ${ev.site} - RETAKE AND DEFUSE`, 2.6);
      if (player.team === 'atk') HUD.showBanner('CHARGE PLANTED', 'DEFEND THE SITE', 2.2);
    } else if (ev.type === 'defused') {
      endRound('def', 'CHARGE DEFUSED');
    }
  }
  G.events.length = 0;
}

// ---- staging for screenshots (real game states, arranged) -----------------------
function applyStage() {
  if (stageApplied || !STAGE) return;
  stageApplied = true;
  if (STAGE === 'planted') {
    // arrange a genuine post-plant: charge down at A, player holding it,
    // three attackers on the site, the defence about to retake
    const give = (a, key) => { buyItem(a, key); };
    player.money = 9000;
    give(player, 'vk7'); give(player, 'helmet');
    player.slot = 'primary';
    player.pos.set(29.5, 0, -29);
    player.yaw = -Math.PI / 2; // looking east across the site at the planter
    stageHoldPlayer = true; // the camera stays composed; the fight comes to it
    for (const a of G.actors) a.hasBomb = false;
    G.bomb.carrier = null;
    const vex = G.actors.find((a) => a.name === 'Vex');
    vex.hasBomb = true;
    const rook = G.actors.find((a) => a.name === 'Rook');
    const sable = G.actors.find((a) => a.name === 'Sable');
    vex.pos.set(35, 0, -28); rook.pos.set(48, 0, -16); sable.pos.set(28, 0, -13);
    const nearNode = (x, z) => nodes.reduce((best, n) => {
      const d = (n.x - x) ** 2 + (n.z - z) ** 2;
      return !best || d < best.d ? { n, d } : best;
    }, null).n;
    for (const [a, nx, nz] of [[vex, 33, -24], [rook, 48, -15], [sable, 30, -19]]) {
      a.brain.state = 'hold';
      a.brain.post = nearNode(nx, nz);
    }
    G.events.push({ type: 'planted', actor: vex, site: 'A' });
    G.phaseT = Math.min(G.phaseT, 90);
  }
}

// ---- the player ------------------------------------------------------------------
const _dir = new THREE.Vector3();
const BUY_KEYS = ['sidekick', 'ripper', 'breacher', 'vk7', 'longshot', 'armor', 'helmet', 'kit', 'he', 'flash'];
function playerActions(a, dt, m) {
  // slot switching
  const slots = ['primary', 'secondary', 'knife', 'he', 'flash', 'smoke'];
  const codes = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6'];
  for (let i = 0; i < slots.length; i++) {
    if (takePress(codes[i])) {
      const s = slots[i];
      if (s === 'primary' && !a.inv.primary) continue;
      if ((s === 'he' || s === 'flash' || s === 'smoke') && a.inv[s] <= 0) continue;
      a.slot = s;
      SFX.sfxScope(false);
    }
  }
  if (takePress('KeyR')) startReload(a);
  a.autoFiring = m.down;
  viewDir(a, _dir);
  const nade = heldNade(a);
  if (nade) {
    if (m.clicked) throwGrenade(a, nade, rng);
    return;
  }
  if (m.down) {
    const r = tryFire(a, _dir, rng, 1);
    if (r === 'dry') startReload(a);
  }
  // plant / defuse channel on E
  let channeling = false;
  if (G.phase === 'live' && a.hasBomb && siteAt(a.pos.x, a.pos.z) && down('KeyE') && a.groundSpeed < 0.6) {
    channeling = true;
    playerChannelT += dt;
    G.channel = { actor: a, label: 'PLANTING THE CHARGE', frac: playerChannelT / 3.2 };
    if (playerChannelT >= 3.2) {
      G.events.push({ type: 'planted', actor: a, site: siteAt(a.pos.x, a.pos.z) });
      playerChannelT = 0;
    }
  } else if (G.phase === 'planted' && a.team === 'def' && G.bomb.pos
    && Math.hypot(G.bomb.pos.x - a.pos.x, G.bomb.pos.z - a.pos.z) < 1.7 && down('KeyE') && a.groundSpeed < 0.6) {
    channeling = true;
    const need = a.hasKit ? 2.6 : 5.2;
    playerChannelT += dt;
    G.channel = { actor: a, label: 'DEFUSING THE CHARGE', frac: playerChannelT / need };
    if (playerChannelT >= need) {
      G.events.push({ type: 'defused', actor: a });
      playerChannelT = 0;
    }
  }
  if (!channeling) playerChannelT = Math.max(0, playerChannelT - dt * 3);
  if (a.lastHitT > G.time - 0.8) playerChannelT = 0; // shot while working: start over
}

// ---- simulation step ---------------------------------------------------------------
function simStep(dt, m) {
  G.time += dt;
  G.channel = null;
  drainEvents();
  const phase = G.phase;
  if (phase === 'buy' || phase === 'live' || phase === 'over') G.phaseT -= dt;
  if (phase === 'planted') {
    G.bomb.fuse -= dt;
    beepT -= dt;
    if (beepT <= 0) {
      beepT = G.bomb.fuse > 12 ? 1 : G.bomb.fuse > 5 ? 0.5 : 0.24;
      SFX.sfxPlantBeep(false);
    }
    if (G.bomb.fuse <= 0) endRound('atk', 'CHARGE DETONATED');
  }
  if (phase === 'buy' && G.phaseT <= 0) {
    G.phase = 'live';
    G.phaseT = 105;
    HUD.setBuyOpen(false);
    applyStage();
  }
  if (phase === 'live') {
    if (aliveOf('def').length === 0) endRound('atk', 'TEAM ELIMINATED');
    else if (aliveOf('atk').length === 0) endRound('def', 'TEAM ELIMINATED');
    else if (G.phaseT <= 0) endRound('def', 'TIME EXPIRED');
  }
  if (phase === 'planted') {
    if (aliveOf('def').length === 0) endRound('atk', 'TEAM ELIMINATED');
  }
  if (phase === 'over' && G.phaseT <= 0) startRound();

  // bomb pickup by walking over it
  if (G.bomb.droppedAt && !G.bomb.planted) {
    for (const a of aliveOf('atk')) {
      if (Math.hypot(G.bomb.droppedAt.x - a.pos.x, G.bomb.droppedAt.z - a.pos.z) < 1.35) {
        a.hasBomb = true;
        G.bomb.carrier = a;
        G.bomb.droppedAt = null;
        if (a.isPlayer) SFX.sfxPickup();
        break;
      }
    }
  }
  // a defender starting a defuse gets a callout, once per round
  if (!defuseCalled && G.bomb.planted) {
    const d = G.actors.find((x) => x.alive && x.team === 'def' && x.brain && x.brain.state === 'defuse');
    if (d) {
      defuseCalled = true;
      G.callouts.push({ team: 'def', text: `${d.name}: defusing, cover me`, t: G.time });
      SFX.sfxDefuse();
    }
  }

  const frozen = phase === 'over' || phase === 'matchover';
  for (const a of G.actors) {
    if (!a.alive) continue;
    if (frozen) { stepPhysics(a, dt, 0, 0, 0, false); continue; }
    if (a.isPlayer) {
      if (AUTOPLAY && stageHoldPlayer) stepPhysics(a, dt, 0, 0, 0, false);
      else if (AUTOPLAY) updateBot(a, dt, rng);
      else if (phase === 'buy') {
        // freeze time for the human too: look around, no walking
        a.yaw -= m.dx * 0.0021;
        a.pitch = Math.max(-1.45, Math.min(1.45, a.pitch - m.dy * 0.0021));
        stepPhysics(a, dt, 0, 0, 0, false);
      } else {
        controlPlayer(a, dt, m);
        if (phase === 'live' || phase === 'planted') playerActions(a, dt, m);
      }
    } else {
      updateBot(a, dt, rng);
    }
    updateWeapons(a, dt);
  }
  if (!frozen) updateProjectiles(dt);
  // prune stale noise
  while (G.noise.length && G.time - G.noise[0].t > 3) G.noise.shift();
}

// ---- boot, input plumbing, frame loop ---------------------------------------------
initInput(renderer.domElement);
HUD.initHUD((key) => {
  if (G.phase === 'buy' && buyItem(player, key)) SFX.sfxBuy();
  else SFX.sfxDeny();
});
const startscreen = document.getElementById('startscreen');
let playing = AUTOPLAY;
if (AUTOPLAY) {
  startscreen.classList.add('done');
  document.getElementById('hud').classList.remove('hidden');
  initAudio();
}
startscreen.addEventListener('click', () => {
  initAudio();
  resumeAudio();
  startscreen.classList.add('done');
  document.getElementById('hud').classList.remove('hidden');
  playing = true;
  clearPresses();
  renderer.domElement.requestPointerLock();
});
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement !== renderer.domElement && playing && !AUTOPLAY) {
    startscreen.classList.remove('done');
    playing = false;
  }
});
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

function frameKeys() {
  if (G.phase === 'buy' && playing) {
    if (takePress('KeyB') || takePress('Escape')) HUD.setBuyOpen(!HUD.isBuyOpen());
    if (HUD.isBuyOpen()) {
      const codes = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'];
      for (let i = 0; i < codes.length; i++) {
        if (takePress(codes[i])) {
          if (buyItem(player, BUY_KEYS[i])) SFX.sfxBuy(); else SFX.sfxDeny();
        }
      }
    }
  } else if (takePress('KeyB')) { /* swallow outside buy */ }
  if (takePress('Tab')) HUD.setBoardOpen(true);
  if (!down('Tab') && HUD.isBoardOpen()) HUD.setBoardOpen(false);
  if (G.over && takePress('Enter')) startMatch();
  if (!player.alive && mouse.clicked) spectateTarget = null; // re-pick below
}

let last = performance.now() / 1000;
let acc = 0;
const EMPTY_M = { dx: 0, dy: 0, clicked: false, rightClicked: false, wheel: 0, rightDown: false, down: false };
let firstFrame = true;

function frame() {
  requestAnimationFrame(frame);
  const nowS = performance.now() / 1000;
  let dt = Math.min(0.1, nowS - last);
  last = nowS;
  const renderDt = dt;
  dt *= TIMESCALE;
  frameKeys();
  const m = consumeMouse();
  if (playing || AUTOPLAY) {
    acc += dt;
    let first = true;
    let guard = 0;
    const maxSteps = 6 + Math.ceil(TIMESCALE * 6);
    while (acc >= STEP && guard < maxSteps) {
      simStep(STEP, first ? m : EMPTY_M);
      first = false;
      acc -= STEP;
      guard++;
    }
    if (guard === maxSteps) acc = 0;
  }
  // visuals
  for (const a of G.actors) syncBody(a, renderDt);
  let scoped = false;
  let spectating = null;
  if (player.alive) {
    scoped = updateCamera(player, camera, renderDt);
    syncViewModel(player, renderDt);
    camera.children.forEach((c) => { c.visible = true; });
  } else {
    // spectate a living teammate, cycling on click
    const mates = G.actors.filter((x) => x.alive && x.team === player.team && !x.isPlayer);
    if (!spectateTarget || !spectateTarget.alive) spectateTarget = mates[0] || null;
    if (m.clicked && mates.length > 1) {
      const i = mates.indexOf(spectateTarget);
      spectateTarget = mates[(i + 1) % mates.length];
    }
    if (spectateTarget) {
      scoped = updateCamera(spectateTarget, camera, renderDt);
      spectating = spectateTarget.name;
    } else {
      camera.position.set(0, 55, 30);
      camera.lookAt(0, 0, 0);
      camera.fov = 60;
      camera.updateProjectionMatrix();
    }
    camera.children.forEach((c) => { c.visible = false; });
  }
  // the charge prop follows its state
  const b = G.bomb;
  if (b.planted && b.pos) {
    bombMesh.visible = true;
    bombMesh.position.set(b.pos.x, 0.13, b.pos.z);
    const rate = b.fuse > 12 ? 2 : b.fuse > 5 ? 5 : 11;
    bombMesh.userData.lamp.material.emissiveIntensity = (Math.sin(nowS * rate * Math.PI) > 0 ? 2.6 : 0.2);
  } else if (b.droppedAt) {
    bombMesh.visible = true;
    bombMesh.position.set(b.droppedAt.x, 0.13, b.droppedAt.z);
    bombMesh.userData.lamp.material.emissiveIntensity = 1.4;
  } else if (b.carrier) {
    bombMesh.visible = true;
    bombMesh.position.set(b.carrier.pos.x, b.carrier.pos.y + 1.28, b.carrier.pos.z);
    bombMesh.rotation.y = b.carrier.yaw;
  } else bombMesh.visible = false;
  // alert lights breathe red over a planted site
  for (const k of ['A', 'B']) {
    const l = alertLights[k];
    if (b.planted && b.site === k) l.intensity = 30 + 22 * Math.sin(nowS * 9);
    else l.intensity = Math.max(0, l.intensity - renderDt * 60);
  }
  hurtT = Math.max(0, hurtT - renderDt);
  updateEffects(renderDt, G.time);
  HUD.updateHUD(renderDt, { playing: playing || AUTOPLAY, scoped, spectating, hurtT });
  renderer.render(scene, camera);
  if (firstFrame) {
    firstFrame = false;
    startMatch();
  }
}

// Probes for local play-testing and screenshot staging: the game's own
// state, read-only, so a headless driver can wait for real moments.
window.__probe = () => ({
  phase: G.phase, round: G.round + 1, time: Math.round(G.time * 10) / 10,
  score: { ...G.squadScore }, planted: G.bomb.planted, fuse: Math.round(G.bomb.fuse),
  aliveAtk: aliveOf('atk').length, aliveDef: aliveOf('def').length,
  killfeed: G.killfeed.length, hp: Math.ceil(player.hp), money: player.money,
  buyOpen: HUD.isBuyOpen(), playerAlive: player.alive, plan: G.planSite,
  bots: G.actors.filter((a) => !a.isPlayer).map((a) => ({
    n: a.name, t: a.team, st: a.brain ? a.brain.state : '-', hp: Math.ceil(a.hp),
    x: Math.round(a.pos.x), z: Math.round(a.pos.z), bomb: a.hasBomb,
  })),
});
frame();
