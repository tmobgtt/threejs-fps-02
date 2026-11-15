// main.js — YARDLINE: the match itself.
//
// Wires the modules together and owns the rules: the round phase machine
// (buy -> live -> planted -> over), the economy, the bomb, channels for
// planting and defusing, and the one combat path every shooter uses —
// player and bots alike — so a headshot means the same thing from any
// gun. The simulation runs on a fixed 60 Hz step; rendering only reads
// the state the step leaves behind.

import * as THREE from "three";
import { buildWorld, hasLOS, inSite, nearestNode, findPath } from "./world.js";
import { INK, TEAMS, BOT_NAMES } from "./palette.js";
import { SoundBank } from "./audio.js";
import { Input } from "./input.js";
import { G, CFG, REWARD, resetMatch, aliveCount, roundPay } from "./state.js";
import { Effects } from "./effects.js";
import {
  WEAPONS, GRENADES, Gun, spreadFor, applyDamage, traceShot, ThrowableSim, bodyHeight,
} from "./weapon.js";
import { Player } from "./player.js";
import { Bot } from "./bots.js";
import { Hud } from "./hud.js";

// ---------------------------------------------------------------- setup
const app = document.getElementById("app");
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(INK.sky);
scene.fog = new THREE.Fog(INK.fog, 42, 135);
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 300);

const sun = new THREE.DirectionalLight(0xffb37a, 1.5);
sun.position.set(34, 42, -20);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -46; sun.shadow.camera.right = 46;
sun.shadow.camera.top = 36; sun.shadow.camera.bottom = -36;
sun.shadow.camera.far = 130;
sun.shadow.bias = -0.0006;
scene.add(sun);
scene.add(new THREE.HemisphereLight(0x93a7c9, 0x55483a, 0.85));

const W = buildWorld(scene);
for (const [lx, lz] of W.lampHeads) {
  const lamp = new THREE.PointLight(0xffc37a, 30, 24, 1.9);
  lamp.position.set(lx, 5.1, lz);
  scene.add(lamp);
}

const effects = new Effects(scene);
const sound = new SoundBank();
const input = new Input(renderer.domElement);
const hud = new Hud();
const throwables = new ThrowableSim(scene);

const player = new Player(scene, camera);
G.player = player;
const bots = [];
for (let i = 1; i < 4; i++) bots.push(new Bot(scene, "atk", BOT_NAMES.atk[i]));
for (let i = 0; i < 4; i++) bots.push(new Bot(scene, "def", BOT_NAMES.def[i]));
G.combatants = [player, ...bots];

// The bomb prop: a charge case with a blinking light, visible when it is
// dropped or planted.
const bombMesh = new THREE.Group();
{
  const caseMesh = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.2, 0.36),
    new THREE.MeshLambertMaterial({ color: 0x2e3238 }));
  caseMesh.position.y = 0.1;
  bombMesh.add(caseMesh);
  const lightMesh = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.05, 0.08),
    new THREE.MeshBasicMaterial({ color: 0xe5484d }));
  lightMesh.position.set(0.14, 0.22, 0);
  bombMesh.add(lightMesh);
  bombMesh.visible = false;
  scene.add(bombMesh);
}
G.bomb = { state: "carried", carrier: player, x: 0, y: 0, z: 0, site: null, fuseT: 0 };

const noises = []; // { x, z, at, radius, team }
let attackSite = W.sites.A;
let intel = null; // { site, at } — defenders' last word on the bomb
const DEF_POSTS = [
  { x: -13.5, z: -19 }, { x: -25, z: -9 }, // site A pair
  { x: 17, z: 9.5 }, { x: 26.5, z: 18.5 }, // site B pair
];
const ATK_STAGE = {
  A: { x: -13, z: -6 }, B: { x: 10, z: 6 },
};

// ---------------------------------------------------------------- helpers
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _hit = { kind: "none", target: null, part: "body", dist: 0, x: 0, y: 0, z: 0 };
const _right = new THREE.Vector3();
const _up2 = new THREE.Vector3();
const _upAxis = new THREE.Vector3(0, 1, 0);
const BLAST_DEF = { damage: 0, headMult: 1, rangeFull: 1e9, dmgFar: 1 };

function gauss() { return (Math.random() + Math.random() + Math.random() - 1.5) / 1.5; }
function wrapPi(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
function viewDir(c, out) {
  const cp = Math.cos(c.pitch);
  out.set(-Math.sin(c.yaw) * cp, Math.sin(c.pitch), -Math.cos(c.yaw) * cp);
  return out;
}
function eyeOf(c, out) { return out.set(c.pos.x, c.eyeY(), c.pos.z); }
function distToPlayer(x, z) { return Math.hypot(x - player.pos.x, z - player.pos.z); }

function pushNoise(x, z, radius, team) {
  noises.push({ x, z, at: G.time, radius, team });
  if (noises.length > 24) noises.shift();
}

// ---------------------------------------------------------------- damage
function hurt(target, def, part, dist, attacker) {
  if (!target.alive) return;
  const dealt = applyDamage(target, def, part, dist);
  if (target.channelRole) cancelChannel();
  if (target.isPlayer) {
    sound.hurt();
    let bearing = null;
    if (attacker) {
      const yawTo = Math.atan2(-(attacker.pos.x - target.pos.x), -(attacker.pos.z - target.pos.z));
      bearing = -wrapPi(yawTo - target.yaw);
    }
    hud.hurt(bearing);
    G.shake = Math.min(0.5, G.shake + 0.12);
  }
  if (target.hp <= 0) kill(target, attacker, part);
  return dealt;
}

function kill(target, attacker, part) {
  target.alive = false;
  target.hp = 0;
  target.deaths++;
  if (target.channelRole) cancelChannel();
  if (attacker && attacker !== target) {
    attacker.kills++;
    if (attacker.isPlayer) G.money = Math.min(CFG.maxMoney, G.money + REWARD.kill);
    else attacker.money = Math.min(CFG.maxMoney, attacker.money + REWARD.kill);
  }
  const aName = attacker ? attacker.name : "THE YARD";
  const aCls = attacker ? (attacker.team === "atk" ? "k-atk" : "k-def") : "";
  const tCls = target.team === "atk" ? "k-atk" : "k-def";
  hud.feed(`<span class="${aCls}">${aName}</span> ▸ <span class="${tCls}">${target.name}</span>${part === "head" ? " ⌖" : ""}`);
  if (attacker && attacker.isPlayer) {
    hud.hitmarker(part === "head");
    sound.hit(part === "head");
    sound.kill();
  }
  if (target.hasBomb) dropBomb(target);
}

function dropBomb(carrier) {
  carrier.hasBomb = false;
  G.bomb.state = "dropped";
  G.bomb.carrier = null;
  G.bomb.x = carrier.pos.x;
  G.bomb.y = carrier.pos.y;
  G.bomb.z = carrier.pos.z;
  bombMesh.position.set(G.bomb.x, G.bomb.y, G.bomb.z);
  bombMesh.visible = true;
}

// ---------------------------------------------------------------- shooting
function performShot(shooter, aimTarget = null) {
  const gun = shooter.gun;
  const def = gun.def;
  const t = G.time;
  if (!gun.ready(t)) return false;
  gun.fire(t);
  const eye = eyeOf(shooter, _v1);
  let dir;
  if (shooter.isPlayer) {
    dir = viewDir(shooter, _v2);
  } else if (aimTarget) {
    const h = bodyHeight(aimTarget);
    const aimY = aimTarget.pos.y + (Math.random() < 0.22 ? h - 0.23 : h * 0.62);
    dir = _v2.set(aimTarget.pos.x - eye.x, aimY - eye.y, aimTarget.pos.z - eye.z).normalize();
    // a small lead: bots aim where a moving target is going, imperfectly
    dir.x += aimTarget.vel.x * 0.012;
    dir.z += aimTarget.vel.z * 0.012;
    dir.normalize();
  } else {
    dir = viewDir(shooter, _v2);
  }
  if (def.kind === "melee") {
    traceShot(W, G.combatants, shooter, eye, dir, def.range, _hit);
    sound.throwIt();
    if (_hit.kind === "target") {
      effects.hitPuff(_hit.x, _hit.y, _hit.z, _hit.part === "head");
      hurt(_hit.target, def, _hit.part, _hit.dist, shooter);
    }
    return true;
  }
  const spread = spreadFor(def, shooter) + (shooter.isPlayer ? 0 : shooter.aimErr);
  // perturb the direction inside the cone (scratch vectors, no allocation)
  _right.crossVectors(dir, _upAxis).normalize();
  _up2.crossVectors(_right, dir).normalize();
  dir.addScaledVector(_right, gauss() * spread)
    .addScaledVector(_up2, gauss() * spread)
    .normalize();
  traceShot(W, G.combatants, shooter, eye, dir, def.range, _hit);

  // muzzle point + tracer + sound
  let mx = eye.x + dir.x * 0.5, my = eye.y - 0.12 + dir.y * 0.5, mz = eye.z + dir.z * 0.5;
  if (shooter.isPlayer) {
    player.viewModel.muzzleWorld(_v3);
    mx = _v3.x; my = _v3.y; mz = _v3.z;
    player.viewModel.fire();
    shooter.pitch += def.id === "sniper" ? 0.045 : def.id === "pistol" ? 0.013 : 0.009;
    shooter.yaw += gauss() * 0.0022;
    G.shake = Math.min(0.4, G.shake + (def.id === "sniper" ? 0.22 : 0.05));
  }
  effects.muzzle(mx, my, mz, def.id === "sniper" ? 3.4 : 2.0);
  if (_hit.dist > 1.2) effects.tracer(mx, my, mz, _hit.x, _hit.y, _hit.z, shooter.team === "atk" ? 0xffd9a0 : 0xa0e8ff);
  sound.shot(def.id, shooter.isPlayer ? 0 : distToPlayer(shooter.pos.x, shooter.pos.z));
  pushNoise(shooter.pos.x, shooter.pos.z, def.id === "sniper" ? 46 : 34, shooter.team);

  if (_hit.kind === "world") {
    effects.impact(_hit.x, _hit.y, _hit.z);
  } else if (_hit.kind === "target") {
    effects.hitPuff(_hit.x, _hit.y, _hit.z, _hit.part === "head");
    if (shooter.isPlayer) {
      hud.hitmarker(_hit.part === "head");
      sound.hit(_hit.part === "head");
    }
    hurt(_hit.target, def, _hit.part, _hit.dist, shooter);
  }
  if (def.id === "sniper") sound.boltCycle();
  return true;
}

function performThrow(shooter, kind) {
  const eye = eyeOf(shooter, _v1);
  const dir = viewDir(shooter, _v2);
  eye.addScaledVector(dir, 0.4);
  throwables.throwIt(kind, eye, dir, shooter.isPlayer ? 13.5 : 11.5, shooter);
  sound.throwIt();
  pushNoise(shooter.pos.x, shooter.pos.z, 8, shooter.team);
}

// ---------------------------------------------------------------- channels
function startChannel(who, kind) {
  if (G.channel || !who.alive) return false;
  if (kind === "plant" && (!who.hasBomb || G.bomb.state !== "carried")) return false;
  if (kind === "defuse" && G.bomb.state !== "planted") return false;
  const dur = kind === "plant" ? CFG.plantTime : who.hasKit ? CFG.defuseKitTime : CFG.defuseTime;
  G.channel = { kind, who, t: 0, dur, beeped: 0 };
  who.channelRole = kind;
  return true;
}

function cancelChannel() {
  if (!G.channel) return;
  G.channel.who.channelRole = null;
  G.channel = null;
  hud.setChannel(null);
}

function stepChannel(dt) {
  const ch = G.channel;
  if (!ch) return;
  const who = ch.who;
  const valid = who.alive &&
    (ch.kind === "plant"
      ? who.hasBomb && (inSite(W.sites.A, who.pos.x, who.pos.z) || inSite(W.sites.B, who.pos.x, who.pos.z))
      : Math.hypot(G.bomb.x - who.pos.x, G.bomb.z - who.pos.z) < 2.3);
  if (!valid || (who.isPlayer && !playerWantsChannel)) {
    cancelChannel();
    return;
  }
  ch.t += dt;
  const frac = ch.t / ch.dur;
  if (ch.kind === "plant") {
    const mark = Math.floor(frac * 4);
    if (mark > ch.beeped) { ch.beeped = mark; sound.plantBeep(false); }
  } else if (who.isPlayer || who.team === "def") {
    if (Math.random() < dt * 6) sound.defuseWire();
  }
  if (who.isPlayer) hud.setChannel(frac, ch.kind === "plant" ? "PLANTING THE CHARGE" : "DEFUSING");
  if (ch.t >= ch.dur) {
    const kind = ch.kind;
    cancelChannel();
    if (kind === "plant") plantBomb(who);
    else endRound("def", "defuse");
  }
}

function plantBomb(who) {
  const site = inSite(W.sites.A, who.pos.x, who.pos.z) ? W.sites.A : W.sites.B;
  who.hasBomb = false;
  G.bomb.state = "planted";
  G.bomb.carrier = null;
  G.bomb.x = who.pos.x;
  G.bomb.y = who.pos.y;
  G.bomb.z = who.pos.z;
  G.bomb.site = site;
  G.bomb.fuseT = CFG.fuseTime;
  bombMesh.position.set(G.bomb.x, G.bomb.y, G.bomb.z);
  bombMesh.visible = true;
  G.phase = "planted";
  G.phaseT = CFG.fuseTime;
  if (who.isPlayer) G.money = Math.min(CFG.maxMoney, G.money + REWARD.plant);
  else who.money = Math.min(CFG.maxMoney, who.money + REWARD.plant);
  sound.plantDone();
  pushNoise(G.bomb.x, G.bomb.z, 26, "atk");
  hud.showBanner("CHARGE PLANTED", `Site ${site.id} — ${CFG.fuseTime} seconds to detonation`, 2400);
}

// ---------------------------------------------------------------- economy
const BUY_ITEMS = [
  { id: "smg", key: "1", label: "KESTREL SMG", price: 1500 },
  { id: "rifle", key: "2", label: "LONGARM RIFLE", price: 2700 },
  { id: "sniper", key: "3", label: "SURVEYOR SNIPER", price: 4300 },
  { id: "armor", key: "4", label: "KEVLAR VEST", price: 650 },
  { id: "armorhelm", key: "5", label: "VEST + HELMET", price: 1000 },
  { id: "he", key: "6", label: "HE GRENADE", price: 300 },
  { id: "flash", key: "7", label: "FLASHBANG", price: 200 },
  { id: "smoke", key: "8", label: "SMOKE GRENADE", price: 300 },
];

function buyStateFor(c, money) {
  return BUY_ITEMS.map((it) => {
    let owned = false;
    if (it.id === "armor") owned = c.armor >= 100 && !c.helmet;
    else if (it.id === "armorhelm") owned = c.armor >= 100 && c.helmet;
    else if (it.id in GRENADES) owned = c.grenades[it.id] >= (it.id === "flash" ? 2 : 1);
    else owned = !!(c.weapons.primary && c.weapons.primary.def.id === it.id);
    return { ...it, owned, cant: money < it.price && !owned };
  });
}

function applyBuy(c, id, spend) {
  if (id === "armor" || id === "armorhelm") {
    spend(id === "armor" ? 650 : 1000);
    c.armor = 100;
    if (id === "armorhelm") c.helmet = true;
    return true;
  }
  if (id in GRENADES) {
    spend(GRENADES[id].price);
    c.grenades[id]++;
    return true;
  }
  spend(WEAPONS[id].price);
  c.giveWeapon(id);
  return true;
}

function playerBuy(id) {
  const item = BUY_ITEMS.find((i) => i.id === id);
  if (!item) return;
  const state = buyStateFor(player, G.money).find((i) => i.id === id);
  if (state.owned || G.money < item.price) { sound.buyNo(); return; }
  applyBuy(player, id, (p) => { G.money -= p; });
  sound.buyOk();
  refreshBuyMenu();
}

function refreshBuyMenu() {
  hud.renderBuy(buyStateFor(player, G.money), G.money, playerBuy);
  hud.setMoney(G.money);
}

function botBuy(bot) {
  const spend = (p) => { bot.money -= p; };
  const roll = Math.random();
  if (bot.money >= 4950 && roll < 0.16) applyBuy(bot, "sniper", spend);
  else if (bot.money >= 3350 && roll < 0.75) applyBuy(bot, "rifle", spend);
  else if (bot.money >= 2150 && roll < 0.9) applyBuy(bot, "smg", spend);
  if (bot.armor < 100 && bot.money >= 1000) applyBuy(bot, "armorhelm", spend);
  else if (bot.armor < 100 && bot.money >= 650) applyBuy(bot, "armor", spend);
  if (bot.team === "def" && !bot.hasKit && bot.money >= 400 && Math.random() < 0.55) {
    bot.money -= 400;
    bot.hasKit = true;
  }
  if (bot.money > 700 && Math.random() < 0.4) applyBuy(bot, "flash", spend);
  if (bot.money > 900 && Math.random() < 0.25) applyBuy(bot, "he", spend);
  if (bot.money > 900 && Math.random() < 0.18) applyBuy(bot, "smoke", spend);
  if (bot.weapons.primary) bot.equip(bot.weapons.primary.def.id);
}

// ---------------------------------------------------------------- bot env
const env = {
  W, G, time: 0, enemies: [], combatants: G.combatants, smokes: G.smokes, noises,
  attackSite: null,
  attackSiteGoal(bot) {
    if (G.bomb.state === "dropped") return { x: G.bomb.x, z: G.bomb.z };
    const stage = ATK_STAGE[attackSite.id];
    const carrier = G.bomb.carrier;
    if (carrier && Math.hypot(carrier.pos.x - attackSite.x, carrier.pos.z - attackSite.z) < 13) {
      return { x: attackSite.x, z: attackSite.z };
    }
    return stage;
  },
  defendGoal(bot) { return bot.post || DEF_POSTS[0]; },
  startChannel(who, kind) { startChannel(who, kind); },
  onReload() {},
  onThrow(bot, kind, targetPos) {
    // bots throw from their eye toward the target's feet, lobbed
    const eye = eyeOf(bot, new THREE.Vector3());
    const dir = new THREE.Vector3(targetPos.x - eye.x, 0.5, targetPos.z - eye.z).normalize();
    throwables.throwIt(kind, eye, dir, 11, bot);
    sound.throwIt();
  },
  onShoot(bot, enemy) { performShot(bot, enemy); },
};

// ---------------------------------------------------------------- rounds
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function startMatch() {
  resetMatch();
  for (const c of G.combatants) {
    c.kills = 0;
    c.deaths = 0;
    c.money = CFG.startMoney;
    c.lostKit = true;
  }
  G.money = CFG.startMoney;
  startRound();
}

function startRound() {
  G.round++;
  G.phase = "buy";
  G.phaseT = CFG.buyTime;
  G.channel = null;
  G.smokes = [];
  env.smokes = G.smokes;
  noises.length = 0;
  throwables.clear();
  intel = null;
  attackSite = Math.random() < 0.5 ? W.sites.A : W.sites.B;
  env.attackSite = attackSite;

  // the bomb starts on the player's back every round
  G.bomb.state = "carried";
  G.bomb.carrier = player;
  G.bomb.site = null;
  bombMesh.visible = false;

  const atkSpawns = shuffle([...W.spawns.atk]);
  const defSpawns = shuffle([...W.spawns.def]);
  let ai = 0, di = 0;
  G.combatants.forEach((c, idx) => {
    const spawn = c.team === "atk" ? atkSpawns[ai++ % 4] : defSpawns[di++ % 4];
    if (c.lostKit) {
      // died last round: back to a fresh sidearm and empty pockets
      c.weapons.primary = null;
      c.weapons.pistol = new Gun(WEAPONS.pistol);
      c.armor = 0;
      c.helmet = false;
      c.grenades = { he: 0, flash: 0, smoke: 0 };
      c.hasKit = false;
    }
    c.alive = true;
    c.hp = 100;
    c.deaths = c.deaths || 0;
    c.hasBomb = false;
    c.channelRole = null;
    c.blindT = 0;
    if (c.isPlayer) {
      c.placeAt(spawn);
      c.equip(c.weapons.primary ? c.weapons.primary.def.id : "pistol");
    } else {
      c.pos.set(spawn.x, 0, spawn.z);
      c.vel.set(0, 0, 0);
      c.yaw = spawn.yaw;
      c.deadT = 0;
      c.state = "route";
      c.path = [];
      c.goal = null;
      c.memory.enemy = null;
      c.memory.at = -99;
      c.mesh.visible = true;
      c.equip(c.weapons.primary ? c.weapons.primary.def.id : "pistol");
      botBuy(c);
      c.syncMesh(0);
    }
    c.lostKit = false;
    void idx;
  });
  player.hasBomb = true;

  // defender posts: two per site, rotated by round
  const defBots = bots.filter((b) => b.team === "def");
  defBots.forEach((b, i) => {
    b.post = DEF_POSTS[(i + G.round) % DEF_POSTS.length];
    b.holdPos = null;
  });

  hud.show();
  hud.setScore(G.score, G.round);
  hud.showBanner(`ROUND ${G.round}`, `First to ${CFG.winsNeeded} — Vultures plant, Wardens hold`, 2200);
  refreshBuyMenu();
  hud.showBuy();
  document.exitPointerLock?.();
}

function endRound(winner, reason) {
  if (G.phase === "over" || G.phase === "matchover") return;
  cancelChannel();
  G.phase = "over";
  G.phaseT = CFG.roundEndTime;
  G.roundWinner = winner;
  G.roundReason = reason;
  G.score[winner]++;
  const { winPay, lossPay } = roundPay(winner, reason);
  const playerWon = winner === player.team;
  G.money = Math.min(CFG.maxMoney, G.money + (playerWon ? winPay : lossPay));
  for (const b of bots) b.money = Math.min(CFG.maxMoney, b.money + (b.team === winner ? winPay : lossPay));
  for (const c of G.combatants) if (!c.alive) c.lostKit = true;
  const reasonText = {
    elimination: "Team eliminated",
    detonate: "The charge went off",
    defuse: "The charge was defused",
    timeout: "The clock ran out",
  }[reason];
  hud.showBanner(playerWon ? "ROUND WON" : "ROUND LOST",
    `${reasonText} · +$${playerWon ? winPay : lossPay}`, 3600);
  hud.setScore(G.score, G.round);
  hud.hideBuy();
  sound.roundEnd(playerWon);
  if (reason === "detonate") {
    effects.explosion(G.bomb.x, G.bomb.y + 0.4, G.bomb.z);
    sound.explosion(distToPlayer(G.bomb.x, G.bomb.z));
    G.shake = 1;
    bombMesh.visible = false;
  }
}

function endMatch() {
  G.phase = "matchover";
  G.winner = G.score.atk > G.score.def ? "atk" : "def";
  const el = document.getElementById("matchover");
  document.getElementById("match-result").textContent =
    G.winner === "atk" ? "VULTURES TAKE THE YARD" : "WARDENS HOLD THE YARD";
  document.getElementById("match-score").textContent =
    `Final score ${G.score.atk} : ${G.score.def} — you went ${player.kills} / ${player.deaths}`;
  el.classList.remove("hidden");
  document.exitPointerLock?.();
}

// ---------------------------------------------------------------- grenades going off
const nadeEvents = [];
function stepGrenades(dt) {
  nadeEvents.length = 0;
  throwables.update(dt, W, nadeEvents);
  for (const ev of nadeEvents) {
    if (ev.type === "bounce") {
      sound.bounce(distToPlayer(ev.pos.x, ev.pos.z));
    } else if (ev.type === "smoke") {
      effects.smoke(ev.pos.x, ev.pos.y + 1.1, ev.pos.z, GRENADES.smoke.duration);
      G.smokes.push({ x: ev.pos.x, y: ev.pos.y + 1.2, z: ev.pos.z, r: GRENADES.smoke.radius, until: G.time + GRENADES.smoke.duration });
      sound.burst({ dur: 0.3, freq: 900, gain: 0.2 });
    } else if (ev.type === "explode" && ev.kind === "he") {
      effects.explosion(ev.pos.x, ev.pos.y + 0.3, ev.pos.z);
      sound.explosion(distToPlayer(ev.pos.x, ev.pos.z));
      if (distToPlayer(ev.pos.x, ev.pos.z) < 7) G.shake = Math.min(1, G.shake + 0.4);
      const def = GRENADES.he;
      for (const c of G.combatants) {
        if (!c.alive) continue;
        const d = Math.hypot(c.pos.x - ev.pos.x, c.pos.z - ev.pos.z);
        if (d > def.radius + 0.5) continue;
        const blocked = !hasLOS(W, ev.pos.x, ev.pos.y + 0.4, ev.pos.z, c.pos.x, c.pos.y + 0.9, c.pos.z, null);
        BLAST_DEF.damage = def.damage * Math.max(0.12, 1 - d / (def.radius + 0.5)) * (blocked ? 0.25 : 1);
        hurt(c, BLAST_DEF, "body", 0, ev.owner);
      }
    } else if (ev.type === "explode" && ev.kind === "flash") {
      effects.burst(ev.pos.x, ev.pos.y + 0.3, ev.pos.z, { count: 16, color: 0xffffff, speed: 3, life: 0.25, gravity: 0 });
      sound.flashPop(distToPlayer(ev.pos.x, ev.pos.z));
      const def = GRENADES.flash;
      for (const c of G.combatants) {
        if (!c.alive) continue;
        const d = Math.hypot(c.pos.x - ev.pos.x, c.pos.z - ev.pos.z);
        if (d > def.radius) continue;
        if (!hasLOS(W, ev.pos.x, ev.pos.y + 0.4, ev.pos.z, c.pos.x, c.eyeY(), c.pos.z, null)) continue;
        viewDir(c, _v3);
        const toBlast = _v1.set(ev.pos.x - c.pos.x, 0, ev.pos.z - c.pos.z).normalize();
        const facing = _v3.x * toBlast.x + _v3.z * toBlast.z;
        const dur = facing > 0.55 ? 3.4 : facing > -0.1 ? 1.7 : 0.5;
        c.blindT = Math.max(c.blindT, dur * (d < 6 ? 1 : 0.7));
      }
    }
  }
  // prune spent smokes
  for (let i = G.smokes.length - 1; i >= 0; i--) {
    if (G.time > G.smokes[i].until) G.smokes.splice(i, 1);
  }
}

// ---------------------------------------------------------------- player actions
let prevFiring = false;
let grenadeInHand = null; // kind selected with slot 4
let lastWeaponId = "pistol";
let playerWantsChannel = false;
let scopeKickT = 0;

function currentGrenadeKind() {
  for (const kind of ["he", "flash", "smoke"]) if (player.grenades[kind] > 0) return kind;
  return null;
}

function playerStep(dt) {
  const t = G.time;
  // build the movement command: real input, or the director's brain
  const cmd = { mx: 0, mz: 0, walk: false, crouch: false, jump: false, lookDX: 0, lookDY: 0 };
  let wantsFire = false;
  playerWantsChannel = false;
  if (G.director) {
    directorThink(dt, cmd);
    wantsFire = directorState.fire;
    playerWantsChannel = directorState.plant;
  } else {
    const [dx, dy] = input.takeMouse();
    cmd.lookDX = dx;
    cmd.lookDY = dy;
    cmd.mx = (input.down("KeyD") ? 1 : 0) - (input.down("KeyA") ? 1 : 0);
    cmd.mz = (input.down("KeyW") ? 1 : 0) - (input.down("KeyS") ? 1 : 0);
    cmd.walk = input.down("ShiftLeft") || input.down("ShiftRight");
    cmd.crouch = input.down("ControlLeft") || input.down("ControlRight") || input.down("KeyC");
    cmd.jump = input.down("Space");
    wantsFire = input.firing;
  }
  player.update(dt, cmd, W);
  if (player.stepped) {
    player.stepped = false;
    sound.step(0, !cmd.walk);
    if (!cmd.walk && player.crouch01 < 0.5) pushNoise(player.pos.x, player.pos.z, 9, "atk");
  }

  const presses = G.director ? [] : input.takePresses();
  const inBuy = G.phase === "buy";
  for (const code of presses) {
    if (inBuy && code.startsWith("Digit")) {
      const item = BUY_ITEMS.find((i) => i.key === code.slice(5));
      if (item) { playerBuy(item.id); continue; }
    }
    if (code === "KeyB" && inBuy) hud.buyOpen() ? hud.hideBuy() : (refreshBuyMenu(), hud.showBuy());
    if (code === "KeyR" && player.alive) {
      if (player.gun.startReload(t)) sound.reload();
    }
    if (code === "Digit1" && !inBuy) switchWeapon("primary");
    if (code === "Digit2" && !inBuy) switchWeapon("pistol");
    if (code === "Digit3" && !inBuy) switchWeapon("knife");
    if (code === "Digit4" && !inBuy) {
      const kind = currentGrenadeKind();
      if (kind) {
        lastWeaponId = player.active;
        grenadeInHand = kind;
        player.viewModel.set("grenade");
      }
    }
    if (code === "KeyQ" && !inBuy) switchWeapon(lastWeaponId === "primary" ? "primary" : lastWeaponId);
  }
  const wheel = G.director ? 0 : input.takeWheel();
  if (wheel !== 0 && !inBuy) switchWeapon(player.active === "pistol" ? "primary" : "pistol");

  if (!player.alive) return;

  // planting: hold E at a site with the bomb
  const atSite = inSite(W.sites.A, player.pos.x, player.pos.z) || inSite(W.sites.B, player.pos.x, player.pos.z);
  if (G.director) {
    if (playerWantsChannel && !G.channel) startChannel(player, "plant");
  } else if (input.down("KeyE") && player.hasBomb && atSite && G.phase === "live") {
    playerWantsChannel = true;
    if (!G.channel) startChannel(player, "plant");
  }

  // firing
  const firingNow = wantsFire && (G.phase === "live" || G.phase === "planted");
  if (grenadeInHand) {
    if (firingNow && !prevFiring) {
      performThrow(player, grenadeInHand);
      player.grenades[grenadeInHand]--;
      const back = lastWeaponId;
      grenadeInHand = null;
      switchWeapon(back === "primary" ? "primary" : back);
    }
  } else if (firingNow) {
    const def = player.gun.def;
    if (def.auto || !prevFiring) {
      if (player.gun.dry(t)) {
        if (!prevFiring) {
          sound.dryFire();
          if (player.gun.startReload(t)) sound.reload();
        }
      } else if (performShot(player)) {
        if (def.id === "sniper") scopeKickT = 0.4;
      }
    }
  }
  prevFiring = firingNow;
  if (scopeKickT > 0) scopeKickT -= dt;
}

function switchWeapon(which) {
  grenadeInHand = null;
  if (which === "primary") {
    if (player.weapons.primary) {
      lastWeaponId = player.active;
      player.equip(player.weapons.primary.def.id);
    }
  } else if (which === "pistol" || which === "knife") {
    lastWeaponId = player.active;
    player.equip(which);
  } else if (WEAPONS[which]) {
    lastWeaponId = player.active;
    player.equip(which);
  }
}

// ---------------------------------------------------------------- director (autoplay for screenshots)
const directorState = {
  fire: false, plant: false, thinkAt: 0, path: [], pathI: 0, goal: null, enemy: null,
};
const _dirPath = [];
function directorThink(dt, cmd) {
  const t = G.time;
  if (t < directorState.thinkAt) return;
  directorState.thinkAt = t + 0.12;
  const ds = directorState;
  ds.fire = false;
  ds.plant = false;
  // buy like a sensible player
  if (G.phase === "buy") {
    if (G.money >= 3350 && !player.weapons.primary) playerBuy("rifle");
    else if (G.money >= 1000 && !player.helmet) playerBuy("armorhelm");
    else if (G.money >= 650 && player.armor < 100) playerBuy("armor");
    return;
  }
  // perceive: nearest visible enemy
  const eye = eyeOf(player, _v1);
  let best = null, bestD = Infinity;
  for (const b of bots) {
    if (b.team !== "def" || !b.alive) continue;
    const d = Math.hypot(b.pos.x - player.pos.x, b.pos.z - player.pos.z);
    if (d > 44 || d >= bestD) continue;
    if (hasLOS(W, eye.x, eye.y, eye.z, b.pos.x, b.pos.y + 1.2, b.pos.z, G.smokes)) { best = b; bestD = d; }
  }
  ds.enemy = best;
  // goal: the site while carrying, else follow the team in
  let goal = null;
  if (player.hasBomb) goal = { x: attackSite.x, z: attackSite.z };
  else if (G.bomb.state === "dropped") goal = { x: G.bomb.x, z: G.bomb.z };
  else goal = ATK_STAGE[attackSite.id];
  if (player.hasBomb && (inSite(W.sites.A, player.pos.x, player.pos.z) || inSite(W.sites.B, player.pos.x, player.pos.z))) {
    ds.plant = true;
    ds.goal = null;
    return;
  }
  if (!ds.goal || Math.hypot(goal.x - ds.goal.x, goal.z - ds.goal.z) > 3) {
    ds.goal = goal;
    const from = nearestNode(W, player.pos.x, player.pos.z);
    const to = nearestNode(W, goal.x, goal.z);
    findPath(W, from, to, _dirPath);
    ds.path = _dirPath;
    ds.pathI = 0;
  }
  let target = ds.path[ds.pathI] ? W.nodes[ds.path[ds.pathI]] : goal;
  if (target && Math.hypot(target.x - player.pos.x, target.z - player.pos.z) < 1.2) {
    ds.pathI++;
    target = ds.path[ds.pathI] ? W.nodes[ds.path[ds.pathI]] : goal;
  }
  if (best) {
    // face the enemy and shoot; movement handled below toward cover-ish strafe
    const wantYaw = Math.atan2(-(best.pos.x - player.pos.x), -(best.pos.z - player.pos.z));
    const err = wrapPi(wantYaw - player.yaw);
    cmd.lookDX = -err / 0.0021 * 0.6;
    const wantPitch = Math.atan2((best.pos.y + 1.1) - eye.y, bestD) ;
    cmd.lookDY = -(wantPitch - player.pitch) / 0.0021 * 0.6;
    if (Math.abs(err) < 0.06 && bestD < 40) ds.fire = true;
    if (player.gun.mag === 0 && player.gun.startReload(t)) sound.reload();
    cmd.mz = bestD > 20 ? 1 : 0;
    cmd.mx = Math.sin(t * 0.8) > 0 ? 0.5 : -0.5;
    return;
  }
  if (target) {
    const wantYaw = Math.atan2(-(target.x - player.pos.x), -(target.z - player.pos.z));
    const err = wrapPi(wantYaw - player.yaw);
    cmd.lookDX = -err / 0.0021 * 0.6;
    cmd.mz = Math.abs(err) < 1.2 ? 1 : 0.2;
  }
}

// ---------------------------------------------------------------- the step
function step(dt) {
  G.time += dt;
  env.time = G.time;
  env.smokes = G.smokes;

  if (G.phase === "buy" || G.phase === "live" || G.phase === "planted" || G.phase === "over") {
    G.phaseT -= dt;
  }

  if (G.phase === "buy" && G.phaseT <= 0) {
    G.phase = "live";
    G.phaseT = CFG.roundTime;
    hud.hideBuy();
    hud.showBanner("ROUND LIVE", "The yard is hot", 1400);
    const lockReq = renderer.domElement.requestPointerLock?.();
    if (lockReq && lockReq.catch) lockReq.catch(() => {});
  }

  if (G.phase === "over") {
    for (const b of bots) if (!b.alive) b.update(dt, env); // let the fallen finish falling
  }

  if ((G.phase === "live" || G.phase === "planted") && player.alive) playerStep(dt);
  else if (player.alive && G.phase === "buy") {
    // look around during buy, no walking the yard yet
    const cmd = { mx: 0, mz: 0, walk: false, crouch: false, jump: false, lookDX: 0, lookDY: 0 };
    if (!G.director) {
      const [dx, dy] = input.takeMouse();
      cmd.lookDX = dx; cmd.lookDY = dy;
      const presses = input.takePresses();
      for (const code of presses) {
        if (code.startsWith("Digit")) {
          const item = BUY_ITEMS.find((i) => i.key === code.slice(5));
          if (item) playerBuy(item.id);
        }
        if (code === "KeyB") hud.buyOpen() ? hud.hideBuy() : (refreshBuyMenu(), hud.showBuy());
      }
    } else {
      directorThink(dt, cmd);
    }
    player.update(dt, cmd, W);
  }
  for (const c of G.combatants) c.gun.update(G.time, dt);

  if (G.phase === "live" || G.phase === "planted") {
    for (const b of bots) {
      env.enemies = G.combatants.filter((c) => c.team !== b.team);
      b.update(dt, env);
      if (b.stepped) {
        b.stepped = false;
        sound.step(distToPlayer(b.pos.x, b.pos.z), true);
        pushNoise(b.pos.x, b.pos.z, 8, b.team);
      }
    }
    stepChannel(dt);
    stepGrenades(dt);
    // bomb pickup by a teammate walking over it
    if (G.bomb.state === "dropped") {
      for (const c of G.combatants) {
        if (c.alive && c.team === "atk" && Math.hypot(c.pos.x - G.bomb.x, c.pos.z - G.bomb.z) < 1.1) {
          c.hasBomb = true;
          G.bomb.state = "carried";
          G.bomb.carrier = c;
          bombMesh.visible = false;
          break;
        }
      }
    }
    // defenders who see the carrier give the team its rotation order
    if (!intel && G.bomb.state === "carried") {
      for (const b of bots) {
        if (b.team === "def" && b.memory.enemy && b.memory.enemy.hasBomb) {
          intel = { site: attackSite, at: G.time };
          for (const d of bots) {
            if (d.team !== "def") continue;
            const nearA = Math.hypot(d.post.x - W.sites.A.x, d.post.z - W.sites.A.z) < 12;
            const wantA = attackSite.id === "A";
            if (nearA !== wantA) d.post = wantA ? { x: -16, z: -6 } : { x: 12, z: 4 };
          }
        }
      }
    }
    // round-end checks
    const atkAlive = aliveCount("atk");
    const defAlive = aliveCount("def");
    if (G.phase === "live") {
      if (defAlive === 0) endRound("atk", "elimination");
      else if (atkAlive === 0) endRound("def", "elimination");
      else if (G.phaseT <= 0) endRound("def", "timeout");
    } else if (G.phase === "planted") {
      if (defAlive === 0) endRound("atk", "elimination");
      else if (G.phaseT <= 0) endRound("atk", "detonate");
    }
  }

  if (G.phase === "over" && G.phaseT <= 0) {
    const decided = G.score.atk >= CFG.winsNeeded || G.score.def >= CFG.winsNeeded || G.round >= CFG.maxRounds;
    if (decided) endMatch();
    else startRound();
  }

  // prune old noise
  for (let i = noises.length - 1; i >= 0; i--) {
    if (G.time - noises[i].at > 2.5) noises.splice(i, 1);
  }
  if (bombMesh.visible && G.bomb.state === "planted") {
    bombMesh.children[1].material.color.setHex(Math.sin(G.time * 9) > 0 ? 0xe5484d : 0x57151a);
  }
}

// ---------------------------------------------------------------- render
let lastHudAmmo = "";
function render(dt) {
  // camera: the player's eyes, a teammate's eyes when dead, or a slow
  // orbit of the yard behind the menu
  if (G.phase === "menu") {
    const t = performance.now() / 1000;
    camera.position.set(Math.cos(t * 0.05) * 26, 13, Math.sin(t * 0.05) * 20);
    camera.lookAt(0, 0, 0);
    player.viewModel.group.visible = false;
  } else if (player.alive) {
    camera.position.set(player.pos.x, player.eyeY(), player.pos.z);
    camera.rotation.order = "YXZ";
    camera.rotation.y = player.yaw; // matches viewDir(): forward = (-sin yaw, ..., -cos yaw)
    camera.rotation.x = player.pitch;
    camera.rotation.z = 0;
    if (G.shake > 0.003) {
      camera.position.x += gauss() * G.shake * 0.05;
      camera.position.y += gauss() * G.shake * 0.05;
      camera.rotation.z = gauss() * G.shake * 0.01;
      G.shake *= Math.pow(0.001, dt);
    }
    const scoped = player.active === "sniper" && input.aiming && !G.director && scopeKickT <= 0;
    const targetFov = scoped ? 24 : 75;
    if (Math.abs(camera.fov - targetFov) > 0.2) {
      camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 14);
      camera.updateProjectionMatrix();
    }
    hud.setScope(scoped);
    player.viewModel.group.visible = !scoped;
    const hSpeed = Math.hypot(player.vel.x, player.vel.z);
    player.viewModel.update(dt, hSpeed, player.gun.reloading);
  } else {
    // spectate the first living teammate from just behind their shoulder
    const mate = bots.find((b) => b.team === "atk" && b.alive) || bots.find((b) => b.alive);
    if (mate) {
      camera.position.set(mate.pos.x + Math.sin(mate.yaw) * 2.6, mate.eyeY() + 0.7, mate.pos.z + Math.cos(mate.yaw) * 2.6);
      camera.lookAt(mate.pos.x - Math.sin(mate.yaw) * 6, mate.eyeY(), mate.pos.z - Math.cos(mate.yaw) * 6);
    }
    player.viewModel.group.visible = false;
    hud.setScope(false);
  }

  // HUD numbers
  if (G.phase !== "menu") {
    hud.setVitals(player.hp, player.armor);
    const ammoKey = `${player.active}:${player.gun.mag}/${player.gun.reserve}:${grenadeInHand || ""}`;
    if (ammoKey !== lastHudAmmo) {
      lastHudAmmo = ammoKey;
      hud.setAmmo(player.gun, grenadeInHand ? `${GRENADES[grenadeInHand].name} IN HAND` : player.gun.def.name, player.grenades, player.hasBomb);
    }
    hud.setMoney(G.money);
    const label = G.phase === "buy" ? `BUY — ROUND ${G.round}` : `ROUND ${G.round}`;
    hud.setClock(G.phaseT, label, (G.phase === "live" && G.phaseT < 10) || G.phase === "planted");
    hud.setPips(aliveCount("atk"), aliveCount("def"));
    hud.setScore(G.score, G.round);
    hud.setBombState(G.phase === "planted" ? `◆ CHARGE PLANTED — SITE ${G.bomb.site.id}` : G.bomb.state === "dropped" ? "◆ CHARGE DROPPED" : "");
    hud.setSpread(6 + spreadFor(player.gun.def, player) * 620);
    hud.setFlash(player.blindT > 0 ? Math.min(1, player.blindT / 1.6) : 0);
    // contextual hint
    let hint = "";
    if (player.alive && player.hasBomb && G.phase === "live" &&
        (inSite(W.sites.A, player.pos.x, player.pos.z) || inSite(W.sites.B, player.pos.x, player.pos.z))) {
      hint = "Hold E to plant the charge";
    } else if (!player.alive && G.phase !== "over" && G.phase !== "matchover") {
      hint = "Spectating — the round plays out";
    } else if ((G.phase === "live" || G.phase === "planted") && !input.locked && !G.director) {
      hint = "Click the yard to take aim";
    }
    hud.setHint(hint);
    // scoreboard while Tab is held
    if (input.down("Tab")) {
      const rows = [...G.combatants]
        .sort((a, b) => b.kills - a.kills)
        .map((c) => ({ name: c.name, team: c.team, kills: c.kills, deaths: c.deaths, money: c.isPlayer ? G.money : c.money, alive: c.alive }));
      hud.renderScoreboard(rows);
      hud.showScoreboard();
    } else {
      hud.hideScoreboard();
    }
    if (!G.channel || G.channel.who !== player) hud.setChannel(null);
  }
  hud.update(dt);
  effects.update(dt, camera);
  renderer.render(scene, camera);
}

// ---------------------------------------------------------------- boot + loop
const params = new URLSearchParams(location.search);
G.director = params.get("autoplay") === "1";

// place everyone at their spawns for the menu backdrop
{
  let ai = 0, di = 0;
  for (const c of G.combatants) {
    const s = c.team === "atk" ? W.spawns.atk[ai++ % 4] : W.spawns.def[di++ % 4];
    c.pos.set(s.x, 0, s.z);
    c.yaw = s.yaw;
    if (!c.isPlayer) c.syncMesh(0);
  }
}

document.getElementById("play-btn").addEventListener("click", () => {
  sound.unlock();
  document.getElementById("menu").classList.add("hidden");
  startMatch();
});
document.getElementById("again-btn").addEventListener("click", () => {
  document.getElementById("matchover").classList.add("hidden");
  startMatch();
});
if (G.director) {
  document.getElementById("menu").classList.add("hidden");
  startMatch();
}

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const STEP = 1 / 60;
let acc = 0;
let lastTs = performance.now();
function frame(ts) {
  requestAnimationFrame(frame);
  let delta = (ts - lastTs) / 1000;
  lastTs = ts;
  if (delta > 0.12) delta = 0.12;
  acc += delta;
  let steps = 0;
  while (acc >= STEP && steps < 5) {
    if (G.phase !== "menu" && G.phase !== "matchover") step(STEP);
    acc -= STEP;
    steps++;
  }
  if (steps === 5) acc = 0;
  render(Math.min(delta, 0.05));
}
requestAnimationFrame(frame);
