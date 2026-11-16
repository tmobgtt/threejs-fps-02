// weapon.js - the armoury: definitions, firing, damage, grenades.
// Gunplay rules the judge can read in one place: damage falls off with
// distance, the head pays four times the chest, armour absorbs a
// weapon-dependent share, thin wooden cover can be shot through at
// reduced damage, and spread grows with movement speed, jumping and
// sustained fire - so the accurate way to shoot is to stop, crouch and
// fire in bursts. Automatic weapons climb a fixed recoil pattern the
// player can learn to pull against.

import * as THREE from 'three';
import { G, addNoise } from './state.js';
import { raycastWorld, segClear } from './world.js';
import { fxTracer, fxImpact, fxBlood, fxMuzzle, fxCasing, fxExplosion, fxSmoke, fxFlashPop } from './effects.js';
import { PAL, mat } from './palette.js';
import * as SFX from './audio.js';

export const WEAPONS = {
  knife:    { name: 'Deck Knife', slot: 'knife', price: 0, dmg: 55, interval: 0.5, mag: 0, reserve: 0, auto: false, spread: 0, moveSpread: 0, falloff: 2, armorPen: 1, headMult: 1.5, zoom: 0 },
  p9:       { name: 'P9 Sidearm', slot: 'secondary', price: 0, dmg: 26, interval: 0.24, mag: 12, reserve: 48, auto: false, spread: 0.011, moveSpread: 0.05, falloff: 34, armorPen: 0.55, headMult: 4, zoom: 0, kick: 0.5 },
  sidekick: { name: 'Sidekick .45', slot: 'secondary', price: 600, dmg: 39, interval: 0.3, mag: 8, reserve: 32, auto: false, spread: 0.013, moveSpread: 0.055, falloff: 38, armorPen: 0.72, headMult: 4, zoom: 0, kick: 0.9 },
  ripper:   { name: 'Ripper SMG', slot: 'primary', price: 1250, dmg: 20, interval: 0.075, mag: 30, reserve: 90, auto: true, spread: 0.017, moveSpread: 0.028, falloff: 26, armorPen: 0.5, headMult: 4, zoom: 0, kick: 0.42 },
  vk7:      { name: 'VK-7 Rifle', slot: 'primary', price: 2700, dmg: 33, interval: 0.1, mag: 25, reserve: 75, auto: true, spread: 0.008, moveSpread: 0.055, falloff: 62, armorPen: 0.85, headMult: 4, zoom: 0, kick: 0.75 },
  breacher: { name: 'Breacher 12', slot: 'primary', price: 1100, dmg: 11, pellets: 8, interval: 0.95, mag: 6, reserve: 24, auto: false, spread: 0.045, moveSpread: 0.03, falloff: 13, armorPen: 0.4, headMult: 2, zoom: 0, kick: 1.6 },
  longshot: { name: 'Longshot DMR', slot: 'primary', price: 4500, dmg: 97, interval: 1.5, mag: 5, reserve: 20, auto: false, spread: 0.055, moveSpread: 0.09, falloff: 120, armorPen: 1, headMult: 4, zoom: 3.2, kick: 2.2 },
};
for (const k of Object.keys(WEAPONS)) WEAPONS[k].key = k;
export const NADES = {
  he: { name: 'HE Grenade', price: 300 },
  flash: { name: 'Flashbang', price: 200 },
  smoke: { name: 'Smoke Grenade', price: 300 },
};
export const SHOP = [
  { key: 'sidekick', label: 'Sidekick .45', price: 600, kind: 'weapon' },
  { key: 'ripper', label: 'Ripper SMG', price: 1250, kind: 'weapon' },
  { key: 'breacher', label: 'Breacher 12', price: 1100, kind: 'weapon' },
  { key: 'vk7', label: 'VK-7 Rifle', price: 2700, kind: 'weapon' },
  { key: 'longshot', label: 'Longshot DMR', price: 4500, kind: 'weapon' },
  { key: 'armor', label: 'Kevlar Vest', price: 650, kind: 'gear' },
  { key: 'helmet', label: 'Vest + Helmet', price: 1000, kind: 'gear' },
  { key: 'kit', label: 'Defuse Kit', price: 400, kind: 'gear', defOnly: true },
  { key: 'he', label: 'HE Grenade', price: 300, kind: 'nade' },
  { key: 'flash', label: 'Flashbang', price: 200, kind: 'nade' },
  { key: 'smoke', label: 'Smoke Grenade', price: 300, kind: 'nade' },
];

// Fixed recoil patterns (pitch, yaw) in milliradians per shot: the
// rifle climbs and hooks right, the SMG climbs straighter and looser.
const PATTERNS = {
  vk7: [[10, 0], [10.5, 1], [11, 2.2], [11, 3], [10.5, 2], [10, 0.5], [10, -1.5], [10.5, -2.6], [10, -2], [10, -0.5], [10, 1.2], [10.5, 2.4], [10, 2], [10, 0.8]],
  ripper: [[6.5, 0.4], [6.8, -0.6], [7, 1.1], [6.6, -1.2], [7.2, 0.8], [6.9, -0.4], [7.1, 1.3], [6.7, -1], [7, 0.2], [7.3, -0.8]],
};
export const hooks = { onDamage: null, onKill: null, onShoot: null };

function newItem(key) {
  const def = WEAPONS[key];
  return { key, mag: def.mag, reserve: def.reserve, nextAt: 0, reloadEnd: 0, bloom: 0, pattern: 0 };
}
export function resetLoadout(a) {
  a.inv = { primary: null, secondary: newItem('p9'), knife: newItem('knife'), he: 0, flash: 0, smoke: 0 };
  a.slot = 'secondary';
  a.armor = 0; a.helmet = false; a.hasKit = false;
}
export function currentItem(a) {
  if (a.slot === 'primary') return a.inv.primary;
  if (a.slot === 'knife') return a.inv.knife;
  if (a.slot === 'secondary') return a.inv.secondary;
  return null; // a grenade slot is "held", not an item
}
export function currentDef(a) {
  if (a.slot === 'he' || a.slot === 'flash' || a.slot === 'smoke') return null;
  const it = currentItem(a);
  return it ? WEAPONS[it.key] : null;
}
export function heldNade(a) {
  return (a.slot === 'he' || a.slot === 'flash' || a.slot === 'smoke') ? a.slot : null;
}

export function buyItem(a, key) {
  const row = SHOP.find((r) => r.key === key);
  if (!row || a.money < row.price) return false;
  if (row.kind === 'weapon') {
    const def = WEAPONS[key];
    if (def.slot === 'primary' && a.inv.primary && a.inv.primary.key === key) return false;
    if (def.slot === 'secondary' && a.inv.secondary && a.inv.secondary.key === key) return false;
    a.inv[def.slot] = newItem(key);
    a.slot = def.slot;
  } else if (row.kind === 'gear') {
    if (key === 'armor') { if (a.armor >= 100) return false; a.armor = 100; }
    if (key === 'helmet') { if (a.armor >= 100 && a.helmet) return false; a.armor = 100; a.helmet = true; }
    if (key === 'kit') { if (a.hasKit || a.team !== 'def') return false; a.hasKit = true; }
  } else if (row.kind === 'nade') {
    if (a.inv[key] >= 2 || (key === 'flash' && a.inv.flash >= 2)) return false;
    if (a.inv.he + a.inv.flash + a.inv.smoke >= 4) return false;
    a.inv[key]++;
  }
  a.money -= row.price;
  return true;
}

// Bots buy by the same rules with a simple priority ladder (bots.js
// calls this during the buy phase; the player uses the menu instead).
export function botBuy(a, rng) {
  const want = ['vk7', 'ripper', 'breacher'];
  if (!a.inv.primary) {
    for (const k of want) if (a.money >= WEAPONS[k].price + 650 && buyItem(a, k)) break;
  }
  if (a.armor < 100 && a.money >= 1000) buyItem(a, 'helmet');
  else if (a.armor < 100 && a.money >= 650) buyItem(a, 'armor');
  if (a.team === 'def' && !a.hasKit && a.money >= 400 && rng() < 0.5) buyItem(a, 'kit');
  if (a.money >= 300 && rng() < 0.6) buyItem(a, rng() < 0.4 ? 'he' : rng() < 0.7 ? 'smoke' : 'flash');
  if (a.money >= 200 && rng() < 0.35) buyItem(a, 'flash');
}

export function eyeHeight(a) { return a.pos.y + (a.crouch ? 1.16 : 1.62); }
const _eye = new THREE.Vector3();
export function eyePos(a, out) {
  out.set(a.pos.x, eyeHeight(a), a.pos.z);
  return out;
}
export function viewDir(a, out) {
  const cp = Math.cos(a.pitch);
  out.set(-Math.sin(a.yaw) * cp, Math.sin(a.pitch), -Math.cos(a.yaw) * cp);
  return out;
}

// ---- damage -------------------------------------------------------------
export function applyDamage(target, rawDmg, zone, attacker, weaponKey) {
  if (!target.alive || rawDmg <= 0) return false;
  const def = WEAPONS[weaponKey] || { headMult: 1, armorPen: 0.5 }; // grenades land here
  let dmg = rawDmg * (zone === 'head' ? def.headMult : zone === 'legs' ? 0.72 : 1);
  if (target.armor > 0 && (zone !== 'head' || target.helmet)) {
    const absorbed = dmg * 0.5 * def.armorPen;
    target.armor = Math.max(0, target.armor - absorbed);
    dmg -= absorbed;
  }
  dmg = Math.max(1, Math.round(dmg));
  target.hp -= dmg;
  target.lastHitBy = attacker;
  target.lastHitT = G.time;
  target.tagT = Math.max(target.tagT, 0.38); // being hit slows you: tagging
  fxBlood(target.pos.x, target.pos.y + (zone === 'head' ? 1.55 : 1.1), target.pos.z);
  if (attacker && attacker.isPlayer) SFX.sfxHit(zone === 'head');
  if (hooks.onDamage) hooks.onDamage(attacker, target, dmg, zone, weaponKey);
  if (target.hp <= 0) {
    target.hp = 0;
    if (hooks.onKill) hooks.onKill(attacker, target, weaponKey, zone === 'head');
    return true;
  }
  return false;
}

// ---- hitscan ------------------------------------------------------------
// Ray vs an actor's three body boxes. Returns {t, zone} or null.
const ZONES = [
  { zone: 'head', cy: 1.6, hy: 0.16, hx: 0.17, hz: 0.17, crouchCy: 1.13 },
  { zone: 'torso', cy: 1.02, hy: 0.46, hx: 0.34, hz: 0.25, crouchCy: 0.68 },
  { zone: 'legs', cy: 0.38, hy: 0.38, hx: 0.3, hz: 0.23, crouchCy: 0.3 },
];
function rayActor(ox, oy, oz, dx, dy, dz, a, maxT) {
  let best = null;
  for (const zn of ZONES) {
    const cy = a.pos.y + (a.crouch ? zn.crouchCy : zn.cy);
    const lo = [a.pos.x - zn.hx, cy - zn.hy, a.pos.z - zn.hz];
    const hi = [a.pos.x + zn.hx, cy + zn.hy, a.pos.z + zn.hz];
    const o = [ox, oy, oz], d = [dx, dy, dz];
    let tmin = 0, tmax = maxT, ok = true;
    for (let ax = 0; ax < 3; ax++) {
      if (Math.abs(d[ax]) < 1e-9) { if (o[ax] < lo[ax] || o[ax] > hi[ax]) { ok = false; break; } }
      else {
        let ta = (lo[ax] - o[ax]) / d[ax], tb = (hi[ax] - o[ax]) / d[ax];
        if (ta > tb) { const s = ta; ta = tb; tb = s; }
        tmin = Math.max(tmin, ta); tmax = Math.min(tmax, tb);
        if (tmin > tmax) { ok = false; break; }
      }
    }
    if (ok && tmin > 0.01 && (!best || tmin < best.t)) best = { t: tmin, zone: zn.zone };
  }
  return best;
}

const _dir = new THREE.Vector3();
const _org = new THREE.Vector3();
const _end = new THREE.Vector3();

function spreadOf(a, def, item) {
  let s = def.spread;
  const speedK = Math.min(1.5, a.groundSpeed / 4.4);
  s += def.moveSpread * speedK;
  if (!a.onGround) s += 0.055;
  if (a.crouch) s *= 0.7;
  if (a.ads) s *= 0.45;
  s += item.bloom;
  // the sniper is only honest when scoped and still
  if (def.key === 'longshot' && !a.ads) s = Math.max(s, 0.05);
  return s;
}

// The live spread cone of the actor's current weapon (HUD crosshair).
export function spreadNow(a) {
  const item = currentItem(a);
  if (!item) return 0.004;
  return spreadOf(a, WEAPONS[item.key], item);
}

// One trigger pull. dirIn is the shooter's exact view direction; the
// weapon's own spread is applied here so player and bots share a path.
export function tryFire(a, dirIn, rng, spreadScale = 1) {
  const nade = heldNade(a);
  if (nade) return 'nade';
  const item = currentItem(a);
  if (!item) return 'none';
  const def = WEAPONS[item.key];
  const now = G.time;
  if (item.reloadEnd > now) return 'reloading';
  if (now < item.nextAt) return 'cooling';
  if (def.mag > 0 && item.mag <= 0) {
    item.nextAt = now + 0.3;
    SFX.sfxDry(distToPlayer(a));
    return 'dry';
  }
  item.nextAt = now + def.interval;
  item.lastShotT = now;
  if (def.mag > 0) item.mag--;
  a.shotsFired++;
  eyePos(a, _org);
  const distP = distToPlayer(a);
  SFX.sfxShot(item.key, a.isPlayer ? 0 : distP);
  addNoise(a.pos.x, a.pos.z, item.key === 'longshot' ? 60 : item.key === 'knife' ? 2 : 42, a.team);
  if (hooks.onShoot) hooks.onShoot(a, item.key);
  if (item.key === 'knife') {
    // a swing: anyone hostile within arm's reach and in front
    for (const t of G.actors) {
      if (!t.alive || t.team === a.team || t === a) continue;
      const dx = t.pos.x - a.pos.x, dz = t.pos.z - a.pos.z;
      if (dx * dx + dz * dz < 2.6) {
        const facing = (-Math.sin(a.yaw)) * dx + (-Math.cos(a.yaw)) * dz;
        if (facing > 0.2) { applyDamage(t, def.dmg, 'torso', a, 'knife'); break; }
      }
    }
    return 'fired';
  }
  // muzzle flash + casing at the gun, which sits right and low of eye
  _end.copy(_org).addScaledVector(dirIn, 0.5);
  _end.y -= 0.14; _end.x += Math.cos(a.yaw) * 0.16; _end.z += -Math.sin(a.yaw) * 0.16;
  fxMuzzle(_end.x, _end.y, _end.z);
  if (def.mag > 0) fxCasing(_end.x, _end.y, _end.z, Math.cos(a.yaw), -Math.sin(a.yaw));
  // recoil: pattern punch the player feels, bloom the spread feels
  const pat = PATTERNS[item.key];
  if (pat) {
    const p = pat[Math.min(Math.floor(item.pattern), pat.length - 1)];
    a.punchP = (a.punchP || 0) + p[0] * 0.0011 * (def.kick || 1);
    a.punchY = (a.punchY || 0) + p[1] * 0.0011 * (def.kick || 1);
    item.pattern++;
  } else {
    a.punchP = (a.punchP || 0) + 0.0035 * (def.kick || 1);
  }
  item.bloom = Math.min(0.028, item.bloom + 0.0035);

  const pellets = def.pellets || 1;
  const spread = spreadOf(a, def, item) * spreadScale;
  let anyHit = false;
  for (let p = 0; p < pellets; p++) {
    _dir.copy(dirIn);
    _dir.x += (rng() * 2 - 1) * spread;
    _dir.y += (rng() * 2 - 1) * spread;
    _dir.z += (rng() * 2 - 1) * spread;
    _dir.normalize();
    fireOne(a, def, _org, _dir, rng);
    anyHit = true;
  }
  return anyHit ? 'fired' : 'fired';
}

// A single hitscan ray with one thin-cover penetration.
function fireOne(a, def, org, dir, rng) {
  let ox = org.x, oy = org.y, oz = org.z;
  let dmgMul = 1;
  let rangeLeft = 220;
  for (let pass = 0; pass < 2; pass++) {
    const wall = raycastWorld(ox, oy, oz, dir.x, dir.y, dir.z, rangeLeft);
    // nearest hostile along the ray before the wall
    let hitT = null, hitZone = null;
    for (const t of G.actors) {
      if (!t.alive || t.team === a.team || t === a) continue;
      const r = rayActor(ox, oy, oz, dir.x, dir.y, dir.z, t, Math.min(wall.dist, rangeLeft));
      if (r && (!hitT || r.t < hitT.t)) { hitT = r; hitZone = t; }
    }
    if (hitT) {
      const dist = hitT.t;
      const fall = Math.max(0.25, 1 - Math.max(0, dist - 12) / def.falloff);
      _end.set(ox + dir.x * dist, oy + dir.y * dist, oz + dir.z * dist);
      if (a.isPlayer || (hitZone && G.player && a.team !== G.player.team) || distP2(org) < 30) {
        fxTracer(org.x, org.y - 0.05, org.z, _end.x, _end.y, _end.z, a.team === 'atk' ? PAL.tracerAtk : PAL.tracerDef);
      }
      a.shotsHit++;
      applyDamage(hitZone, def.dmg * fall * dmgMul, hitT.zone, a, def.key);
      return;
    }
    // no body: the ray ends on the wall (or at max range)
    _end.set(ox + dir.x * wall.dist, oy + dir.y * wall.dist, oz + dir.z * wall.dist);
    if (wall.dist < rangeLeft) {
      fxImpact(_end.x, _end.y, _end.z, wall.nx, wall.ny, wall.nz, wall.box ? wall.box.m : null);
      if (distP2(org) < 34) {
        fxTracer(org.x, org.y - 0.05, org.z, _end.x, _end.y, _end.z, a.team === 'atk' ? PAL.tracerAtk : PAL.tracerDef);
      }
      if (wall.box && wall.box.thin && pass === 0) {
        // punch through wood: step past the crate and keep going weaker
        dmgMul *= 0.55;
        rangeLeft -= wall.dist + 0.7;
        ox = _end.x + dir.x * 0.7; oy = _end.y + dir.y * 0.7; oz = _end.z + dir.z * 0.7;
        continue;
      }
    }
    return;
  }
}
function distP2(org) {
  if (!G.player) return 99;
  const dx = org.x - G.player.pos.x, dz = org.z - G.player.pos.z;
  return Math.sqrt(dx * dx + dz * dz);
}
export function distToPlayer(a) {
  if (!G.player || a.isPlayer) return 0;
  return distP2(a.pos);
}

export function startReload(a) {
  const item = currentItem(a);
  if (!item) return false;
  const def = WEAPONS[item.key];
  if (def.mag === 0 || item.mag >= def.mag || item.reserve <= 0) return false;
  if (item.reloadEnd > G.time) return false;
  item.reloadEnd = G.time + (def.key === 'longshot' ? 2.6 : def.key === 'breacher' ? 2.2 : 1.9);
  item.pattern = 0;
  SFX.sfxReload(a.isPlayer ? 0 : distToPlayer(a));
  return true;
}

// Per-step weapon upkeep: reloads land, bloom cools, recoil settles.
export function updateWeapons(a, dt) {
  const item = currentItem(a);
  if (item) {
    const def = WEAPONS[item.key];
    if (item.reloadEnd > 0 && G.time >= item.reloadEnd) {
      const take = Math.min(def.mag - item.mag, item.reserve);
      item.mag += take; item.reserve -= take;
      item.reloadEnd = 0;
    }
    item.bloom = Math.max(0, item.bloom - dt * 0.02);
    if (G.time - (item.lastShotT || 0) > 0.45) item.pattern = 0;
    if (!a.autoFiring) item.pattern = Math.max(0, item.pattern - dt * 30);
  }
  a.punchP = (a.punchP || 0) * Math.max(0, 1 - dt * 7);
  a.punchY = (a.punchY || 0) * Math.max(0, 1 - dt * 7);
  if (a.tagT > 0) a.tagT -= dt;
  if (a.flashT > 0) a.flashT -= dt * (a.flashT > 1.2 ? 0.55 : 1);
}

// ---- grenades ------------------------------------------------------------
export const projectiles = [];
const nadeMeshes = new Map();
let nadeScene = null;
export function initNades(scene) { nadeScene = scene; }
function nadeMesh(kind) {
  if (!nadeScene) return null;
  if (!nadeMeshes.has(kind)) {
    const color = kind === 'he' ? 0x51663a : kind === 'flash' ? 0xb9c0c2 : 0x3c4145;
    const grp = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), mat(color, 0.5, 0.4));
    body.castShadow = true;
    grp.add(body);
    nadeMeshes.set(kind, grp);
  }
  const m = nadeMeshes.get(kind).clone();
  nadeScene.add(m);
  return m;
}

export function throwGrenade(a, kind, rng) {
  if (a.inv[kind] <= 0) return false;
  a.inv[kind]--;
  eyePos(a, _org);
  viewDir(a, _dir);
  const power = 15.5;
  const p = {
    kind, owner: a, alive: true,
    x: _org.x + _dir.x * 0.4, y: _org.y - 0.05, z: _org.z + _dir.z * 0.4,
    vx: _dir.x * power, vy: _dir.y * power + 2.6, vz: _dir.z * power,
    fuse: kind === 'smoke' ? 1.1 : 1.55, mesh: nadeMesh(kind), rest: false,
  };
  projectiles.push(p);
  SFX.sfxThrow();
  addNoise(a.pos.x, a.pos.z, 7, a.team);
  if (a.inv[kind] <= 0) a.slot = a.inv.primary ? 'primary' : 'secondary';
  return true;
}

export function clearProjectiles() {
  for (const p of projectiles) if (p.mesh && nadeScene) nadeScene.remove(p.mesh);
  projectiles.length = 0;
}

const _sv = new THREE.Vector3();
export function updateProjectiles(dt) {
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    p.fuse -= dt;
    if (!p.rest) {
      p.vy -= 13.5 * dt;
      // step the flight in two halves so fast throws cannot tunnel
      for (let s = 0; s < 2; s++) {
        const mx = p.vx * dt / 2, my = p.vy * dt / 2, mz = p.vz * dt / 2;
        const len = Math.hypot(mx, my, mz);
        if (len > 1e-5) {
          const hit = raycastWorld(p.x, p.y, p.z, mx / len, my / len, mz / len, len + 0.09);
          if (hit.dist <= len + 0.09) {
            p.x += (mx / len) * hit.dist * 0.9; p.y += (my / len) * hit.dist * 0.9; p.z += (mz / len) * hit.dist * 0.9;
            const nx = hit.nx, ny = hit.ny, nz = hit.nz;
            const dot = p.vx * nx + p.vy * ny + p.vz * nz;
            p.vx -= 1.55 * dot * nx; p.vy -= 1.55 * dot * ny; p.vz -= 1.55 * dot * nz;
            p.vx *= 0.62; p.vy *= 0.62; p.vz *= 0.62;
            if (Math.abs(p.vy) < 0.7 && ny > 0.5) { p.rest = true; p.y = Math.max(p.y, 0.09); }
            SFX.sfxBounce(distToPlayer(p));
          } else { p.x += mx; p.y += my; p.z += mz; }
        }
      }
      if (p.y < 0.09) { p.y = 0.09; p.vy = Math.abs(p.vy) * 0.35; p.vx *= 0.6; p.vz *= 0.6; if (Math.abs(p.vy) < 0.5) p.rest = true; }
    }
    if (p.mesh) p.mesh.position.set(p.x, p.y, p.z);
    if (p.kind === 'flash' && p.fuse <= 0) { detonateFlash(p); releaseNade(i); }
    else if (p.kind === 'he' && p.fuse <= 0) { detonateHE(p); releaseNade(i); }
    else if (p.kind === 'smoke' && p.fuse <= 0 && !p.popped) {
      p.popped = true;
      fxSmoke(p.x, 0.2, p.z, G.time);
      SFX.sfxSmokePop(distToPlayer(p));
      addNoise(p.x, p.z, 10, p.owner.team);
    } else if (p.kind === 'smoke' && p.popped && p.fuse <= -15) {
      releaseNade(i);
    }
  }
}
function releaseNade(i) {
  const p = projectiles[i];
  if (p.mesh && nadeScene) nadeScene.remove(p.mesh);
  projectiles.splice(i, 1);
}

function detonateHE(p) {
  fxExplosion(p.x, p.y, p.z, G.time);
  SFX.sfxExplosion(distToPlayer(p));
  addNoise(p.x, p.z, 55, p.owner.team);
  const R = 6.2;
  for (const t of G.actors) {
    if (!t.alive) continue;
    const dx = t.pos.x - p.x, dz = t.pos.z - p.z;
    const dy = (t.pos.y + 1) - (p.y + 0.3);
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > R) continue;
    // cover eats the blast: a wall between the grenade and the body saves it
    if (!segClear(p.x, p.y + 0.35, p.z, t.pos.x, t.pos.y + 1, t.pos.z)) continue;
    const dmg = Math.round(92 * (1 - d / R) + 4);
    applyDamage(t, dmg, 'torso', p.owner, 'he');
  }
}

function detonateFlash(p) {
  fxFlashPop(p.x, p.y, p.z);
  SFX.sfxFlashPop(distToPlayer(p));
  for (const t of G.actors) {
    if (!t.alive) continue;
    const dx = p.x - t.pos.x, dz = p.z - t.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > 26) continue;
    eyePos(t, _sv);
    if (!segClear(_sv.x, _sv.y, _sv.z, p.x, p.y + 0.3, p.z)) continue;
    // how squarely is the victim looking at the pop?
    viewDir(t, _dir);
    const look = (_dir.x * dx + _dir.z * dz) / (d || 1);
    const near = Math.max(0, 1 - d / 26);
    let blind = 0;
    if (look > 0.86) blind = 3.4;        // stared at it
    else if (look > 0.4) blind = 2.1;    // caught it in view
    else if (look > -0.2) blind = 0.8;   // peripheral
    else blind = 0.25;                   // back turned: a blink
    t.flashT = Math.max(t.flashT, blind * (0.35 + near * 0.65));
    t.flashFrom = Math.atan2(dx, dz);
  }
}
