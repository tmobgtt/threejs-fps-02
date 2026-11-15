// weapon.js — the yard's arsenal: definitions, gun state, the damage
// model, hitscan tracing and thrown grenades.
//
// Accuracy is the game's promise: spread grows with movement and with
// every shot fired (bloom) and shrinks when a shooter stops and crouches,
// so the patient shot wins. Damage is checked against three body parts —
// head, body, legs — and falls off with distance per weapon.

import * as THREE from "three";
import { raycastWorld } from "./world.js";

export const WEAPONS = {
  knife: {
    id: "knife", name: "YARD KNIFE", slot: 3, price: 0, kind: "melee",
    damage: 55, headMult: 1.6, rpm: 85, magSize: Infinity, reserveStart: 0,
    reloadTime: 0, spread: 0, spreadMove: 0, bloomPerShot: 0, range: 1.8,
    rangeFull: 1.8, dmgFar: 1, moveSpeed: 5.6, auto: false,
  },
  pistol: {
    id: "pistol", name: "SIDEARM P9", slot: 2, price: 0, kind: "gun",
    damage: 32, headMult: 4, rpm: 340, magSize: 12, reserveStart: 100,
    reloadTime: 1.6, spread: 0.010, spreadMove: 0.045, bloomPerShot: 0.006,
    range: 90, rangeFull: 16, dmgFar: 0.5, moveSpeed: 5.2, auto: false,
  },
  smg: {
    id: "smg", name: "KESTREL SMG", slot: 1, price: 1500, kind: "gun",
    damage: 26, headMult: 3, rpm: 760, magSize: 30, reserveStart: 120,
    reloadTime: 2.0, spread: 0.02, spreadMove: 0.06, bloomPerShot: 0.007,
    range: 80, rangeFull: 12, dmgFar: 0.38, moveSpeed: 5.35, auto: true,
  },
  rifle: {
    id: "rifle", name: "LONGARM RIFLE", slot: 1, price: 2700, kind: "gun",
    damage: 40, headMult: 4, rpm: 600, magSize: 30, reserveStart: 90,
    reloadTime: 2.3, spread: 0.006, spreadMove: 0.05, bloomPerShot: 0.008,
    range: 120, rangeFull: 30, dmgFar: 0.8, moveSpeed: 4.9, auto: true,
  },
  sniper: {
    id: "sniper", name: "SURVEYOR", slot: 1, price: 4300, kind: "gun",
    damage: 125, headMult: 2, rpm: 42, magSize: 5, reserveStart: 30,
    reloadTime: 3.0, spread: 0.0012, spreadMove: 0.09, bloomPerShot: 0.02,
    range: 160, rangeFull: 200, dmgFar: 1, moveSpeed: 4.6, auto: false, scoped: true,
  },
};

export const GRENADES = {
  he: { id: "he", name: "HE GRENADE", price: 300, fuse: 1.7, damage: 92, radius: 5.2 },
  flash: { id: "flash", name: "FLASHBANG", price: 200, fuse: 1.45, radius: 16 },
  smoke: { id: "smoke", name: "SMOKE", price: 300, fuse: 0.5, radius: 3.1, duration: 14 },
};

export function bodyHeight(c) { return 1.78 - 0.5 * c.crouch01; }
export function eyeHeight(c) { return bodyHeight(c) - 0.14; }

// One gun's live state: magazine, reserve, cadence, reload, bloom.
export class Gun {
  constructor(def) {
    this.def = def;
    this.mag = def.magSize;
    this.reserve = def.reserveStart;
    this.nextAt = 0;
    this.reloadEnd = -1;
    this.bloom = 0;
  }
  get reloading() { return this.reloadEnd >= 0; }
  ready(t) { return !this.reloading && t >= this.nextAt && this.mag > 0; }
  dry(t) { return !this.reloading && t >= this.nextAt && this.mag === 0; }
  fire(t) {
    if (this.def.magSize !== Infinity) this.mag--;
    this.nextAt = t + 60 / this.def.rpm;
    this.bloom = Math.min(0.05, this.bloom + this.def.bloomPerShot);
  }
  startReload(t) {
    if (this.reloading || this.mag >= this.def.magSize || this.reserve <= 0) return false;
    this.reloadEnd = t + this.def.reloadTime;
    return true;
  }
  update(t, dt) {
    if (this.reloadEnd >= 0 && t >= this.reloadEnd) {
      const take = Math.min(this.def.magSize - this.mag, this.reserve);
      this.mag += take;
      this.reserve -= take;
      this.reloadEnd = -1;
    }
    if (this.bloom > 0) this.bloom = Math.max(0, this.bloom - dt * 0.028);
  }
}

// The cone a shot can land in, in radians, for a shooter in this state.
export function spreadFor(def, c) {
  const speed = Math.hypot(c.vel.x, c.vel.z);
  const move = Math.min(1, speed / def.moveSpeed) * def.spreadMove;
  const air = c.onGround ? 0 : 0.055;
  const crouch = 1 - 0.38 * c.crouch01;
  return (def.spread + move + c.gun.bloom) * crouch + air;
}

// Apply one hit. Armour halves gun damage while it lasts (a helmet is
// what makes a headshot survivable); the knife ignores armour's discount
// on the head only through its own multiplier. Returns the health lost.
export function applyDamage(target, def, part, dist) {
  let mult = part === "head" ? def.headMult : part === "leg" ? 0.75 : 1;
  let fall = 1;
  if (dist > def.rangeFull) {
    const t = Math.min(1, (dist - def.rangeFull) / 45);
    fall = 1 - t * (1 - def.dmgFar);
  }
  let raw = def.damage * mult * fall;
  if (target.armor > 0 && (part !== "head" || target.helmet)) {
    const absorbed = Math.min(target.armor, raw * 0.5);
    target.armor -= absorbed;
    raw -= absorbed;
  }
  target.hp -= raw;
  return raw;
}

const _worldHit = { dist: 0, nx: 0, ny: 0, nz: 0 };

// Ray vs bodies: the body is a box, the head a sphere on top of it.
// Fills `out` and returns the kind of thing hit.
export function traceShot(W, targets, shooter, o, d, maxDist, out) {
  let best = maxDist;
  let kind = "none";
  let hitTarget = null;
  let part = "body";
  if (raycastWorld(W, o.x, o.y, o.z, d.x, d.y, d.z, maxDist, _worldHit)) {
    best = _worldHit.dist;
    kind = "world";
  }
  for (const t of targets) {
    if (!t.alive || t === shooter || t.team === shooter.team) continue;
    const h = bodyHeight(t);
    const cx = t.pos.x, cz = t.pos.z;
    // body box
    const tb = rayBox(o, d, cx - 0.36, t.pos.y, cz - 0.36, cx + 0.36, t.pos.y + h, cz + 0.36, best);
    // head sphere
    const th = raySphere(o, d, cx, t.pos.y + h - 0.23, cz, 0.235, best);
    let tt = -1, pp = "body";
    if (th > 0 && (tb < 0 || th < tb)) { tt = th; pp = "head"; }
    else if (tb > 0) {
      tt = tb;
      const hy = o.y + d.y * tb;
      pp = hy < t.pos.y + h * 0.42 ? "leg" : "body";
    }
    if (tt > 0 && tt < best) {
      best = tt;
      kind = "target";
      hitTarget = t;
      part = pp;
    }
  }
  out.kind = kind;
  out.target = hitTarget;
  out.part = part;
  out.dist = best;
  out.x = o.x + d.x * best;
  out.y = o.y + d.y * best;
  out.z = o.z + d.z * best;
  return kind;
}

function rayBox(o, d, x0, y0, z0, x1, y1, z1, maxT) {
  let t0 = 0, t1 = maxT;
  if (Math.abs(d.x) < 1e-9) { if (o.x < x0 || o.x > x1) return -1; }
  else {
    let ta = (x0 - o.x) / d.x, tb = (x1 - o.x) / d.x;
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return -1;
  }
  if (Math.abs(d.y) < 1e-9) { if (o.y < y0 || o.y > y1) return -1; }
  else {
    let ta = (y0 - o.y) / d.y, tb = (y1 - o.y) / d.y;
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return -1;
  }
  if (Math.abs(d.z) < 1e-9) { if (o.z < z0 || o.z > z1) return -1; }
  else {
    let ta = (z0 - o.z) / d.z, tb = (z1 - o.z) / d.z;
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return -1;
  }
  return t0 > 0.01 ? t0 : -1;
}

function raySphere(o, d, cx, cy, cz, r, maxT) {
  const ox = o.x - cx, oy = o.y - cy, oz = o.z - cz;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t > 0.01 && t < maxT ? t : -1;
}

// Thrown grenades in flight. update() fills `events` with what went off.
const nadeGeo = new THREE.SphereGeometry(0.09, 10, 8);
const nadeMats = {
  he: new THREE.MeshLambertMaterial({ color: 0x4c5b3c }),
  flash: new THREE.MeshLambertMaterial({ color: 0xb9bec4 }),
  smoke: new THREE.MeshLambertMaterial({ color: 0x707880 }),
};

export class ThrowableSim {
  constructor(scene) {
    this.scene = scene;
    this.live = [];
  }
  throwIt(kind, origin, dir, strength, owner) {
    const mesh = new THREE.Mesh(nadeGeo, nadeMats[kind]);
    mesh.position.copy(origin);
    this.scene.add(mesh);
    this.live.push({
      kind, mesh, owner,
      pos: mesh.position,
      vel: new THREE.Vector3(dir.x * strength, dir.y * strength + 2.2, dir.z * strength),
      fuse: GRENADES[kind].fuse,
      rested: false,
    });
  }
  update(dt, W, events) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const n = this.live[i];
      n.fuse -= dt;
      if (!n.rested) {
        n.vel.y -= 16 * dt;
        n.pos.addScaledVector(n.vel, dt);
        if (n.pos.y < 0.1) {
          n.pos.y = 0.1;
          if (Math.abs(n.vel.y) > 1.4) {
            n.vel.y *= -0.38;
            n.vel.x *= 0.72; n.vel.z *= 0.72;
            events.push({ type: "bounce", pos: n.pos });
          } else {
            n.rested = true;
            n.vel.set(0, 0, 0);
            if (n.kind === "smoke") n.fuse = Math.min(n.fuse, 0.1);
          }
        }
        // bounce off walls: if the centre entered a solid, step back out
        for (const c of W.solids) {
          if (n.pos.x > c.x0 - 0.09 && n.pos.x < c.x1 + 0.09 &&
              n.pos.z > c.z0 - 0.09 && n.pos.z < c.z1 + 0.09 && n.pos.y < c.top) {
            const dl = n.pos.x - c.x0, dr = c.x1 - n.pos.x;
            const dn = n.pos.z - c.z0, df = c.z1 - n.pos.z;
            const m = Math.min(dl, dr, dn, df);
            if (m === dl || m === dr) { n.vel.x *= -0.4; n.pos.x = m === dl ? c.x0 - 0.1 : c.x1 + 0.1; }
            else { n.vel.z *= -0.4; n.pos.z = m === dn ? c.z0 - 0.1 : c.z1 + 0.1; }
          }
        }
      }
      if (n.fuse <= 0) {
        events.push({ type: n.kind === "smoke" ? "smoke" : "explode", kind: n.kind, pos: n.pos, owner: n.owner });
        this.scene.remove(n.mesh);
        this.live.splice(i, 1);
      }
    }
  }
  clear() {
    for (const n of this.live) this.scene.remove(n.mesh);
    this.live.length = 0;
  }
}
