// player.js - bodies and the human controller.
// One physics stepper moves every combatant (the bots' brains ask for
// the same step the keyboard does), so a bot and the player accelerate,
// collide, jump and get tagged by bullets under identical rules. This
// file also builds the low-poly operator models and the first-person
// view model, and it owns the camera: eye height, recoil punch, bob,
// and the scoped field of view.

import * as THREE from 'three';
import { G, addNoise } from './state.js';
import { groundY, collideAxis } from './world.js';
import { PAL, mat, teamMat } from './palette.js';
import { WEAPONS, currentItem } from './weapon.js';
import { down } from './input.js';
import * as SFX from './audio.js';

export const RADIUS = 0.36;
const GRAV = 22;
const ACCEL = 42;
const FRICTION = 9.5;

// ---- physics -------------------------------------------------------------
// wish is a world-space direction (already normalised or zero), cap is
// the speed this character may move at right now.
export function stepPhysics(a, dt, wishX, wishZ, cap, wantJump) {
  const tagSlow = a.tagT > 0 ? 0.55 : 1;
  cap *= tagSlow;
  const vx = a.vel.x, vz = a.vel.z;
  const speed = Math.hypot(vx, vz);
  if (wishX !== 0 || wishZ !== 0) {
    a.vel.x += wishX * ACCEL * dt;
    a.vel.z += wishZ * ACCEL * dt;
    const s2 = Math.hypot(a.vel.x, a.vel.z);
    if (s2 > cap) {
      // accelerate freely up to the cap, bleed off excess gently
      const k = (cap + (s2 - cap) * Math.max(0, 1 - dt * 6)) / s2;
      a.vel.x *= k; a.vel.z *= k;
    }
  } else {
    const f = Math.max(0, 1 - FRICTION * dt);
    a.vel.x *= f; a.vel.z *= f;
  }
  if (wantJump && a.onGround) {
    a.vel.y = 7.3;
    a.onGround = false;
    if (a.isPlayer) SFX.sfxJump();
  }
  a.vel.y -= GRAV * dt;
  a.pos.x += a.vel.x * dt;
  collideAxis(a.pos, RADIUS, 'x');
  a.pos.z += a.vel.z * dt;
  collideAxis(a.pos, RADIUS, 'z');
  a.pos.y += a.vel.y * dt;
  const g = groundY(a.pos.x, a.pos.z, a.pos.y);
  if (a.pos.y <= g) {
    if (!a.onGround && a.vel.y < -6 && a.isPlayer) SFX.sfxLand();
    a.pos.y = g;
    a.vel.y = 0;
    a.onGround = true;
  } else if (a.pos.y > g + 0.03) {
    a.onGround = false;
  }
  a.groundSpeed = Math.hypot(a.vel.x, a.vel.z);
  // footsteps are simulation events: bots hear them, the player hears his own
  if (a.onGround && a.groundSpeed > 1.2) {
    a.stepT -= dt * a.groundSpeed;
    if (a.stepT <= 0) {
      a.stepT = 2.6;
      const run = a.groundSpeed > 3.4;
      addNoise(a.pos.x, a.pos.z, run ? 15 : 6, a.team);
      if (!a.isPlayer) SFX.sfxStep(distTo(a), run);
    }
  }
}
function distTo(a) {
  if (!G.player) return 30;
  return Math.hypot(a.pos.x - G.player.pos.x, a.pos.z - G.player.pos.z);
}

// ---- bodies ---------------------------------------------------------------
const gunCache = new Map();
export function gunModel(key) {
  if (gunCache.has(key)) return gunCache.get(key);
  const grp = new THREE.Group();
  const dark = mat(PAL.kitDark, 0.45, 0.55);
  const accent = mat(PAL.steel, 0.4, 0.6);
  const add = (w, h, d, x, y, z, m = dark) => {
    const q = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    q.position.set(x, y, z);
    q.castShadow = true;
    grp.add(q);
    return q;
  };
  if (key === 'p9' || key === 'sidekick') {
    add(0.07, 0.11, 0.24, 0, 0, -0.1);
    add(0.06, 0.14, 0.08, 0, -0.09, 0.02);
  } else if (key === 'ripper') {
    add(0.08, 0.13, 0.5, 0, 0, -0.2);
    add(0.07, 0.2, 0.09, 0, -0.13, -0.08);
    add(0.05, 0.05, 0.2, 0, 0.09, -0.28, accent);
  } else if (key === 'breacher') {
    add(0.09, 0.14, 0.62, 0, 0, -0.24);
    add(0.11, 0.09, 0.2, 0, -0.05, -0.42, mat(PAL.wood, 0.8));
    add(0.08, 0.16, 0.1, 0, -0.1, 0.08);
  } else if (key === 'longshot') {
    add(0.08, 0.12, 0.78, 0, 0, -0.3);
    const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.22, 8), dark);
    scope.rotation.x = Math.PI / 2;
    scope.position.set(0, 0.11, -0.2);
    grp.add(scope);
    add(0.06, 0.18, 0.08, 0, -0.12, -0.02);
  } else if (key === 'knife') {
    add(0.03, 0.05, 0.12, 0, -0.02, 0.02);
    add(0.012, 0.07, 0.24, 0, 0.03, -0.14, accent);
  } else { // vk7 and anything else: the rifle silhouette
    add(0.08, 0.14, 0.58, 0, 0, -0.22);
    add(0.07, 0.22, 0.09, 0, -0.14, -0.06);
    add(0.05, 0.06, 0.3, 0, 0.1, -0.3, accent);
    add(0.07, 0.1, 0.16, 0, -0.02, 0.18, mat(PAL.woodDark, 0.8));
  }
  gunCache.set(key, grp);
  return grp;
}

export function createBody(a, scene) {
  const grp = new THREE.Group();
  const team = teamMat(a.team);
  const teamDark = teamMat(a.team, true);
  const dark = mat(PAL.kitDark, 0.8);
  const skin = mat(PAL.skin, 0.7);
  const mk = (w, h, d, m, x, y, z, parent = grp) => {
    const q = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    q.position.set(x, y, z);
    q.castShadow = true;
    parent.add(q);
    return q;
  };
  // legs pivot at the hip so they can swing
  const legL = new THREE.Group(); legL.position.set(-0.12, 0.84, 0); grp.add(legL);
  const legR = new THREE.Group(); legR.position.set(0.12, 0.84, 0); grp.add(legR);
  mk(0.17, 0.84, 0.2, dark, 0, -0.42, 0, legL);
  mk(0.17, 0.84, 0.2, dark, 0, -0.42, 0, legR);
  const upper = new THREE.Group(); grp.add(upper);
  mk(0.5, 0.34, 0.27, teamDark, 0, 0.98, 0, upper);            // hips / belt
  mk(0.54, 0.5, 0.3, team, 0, 1.28, 0, upper);                 // torso
  mk(0.56, 0.42, 0.1, dark, 0, 1.3, -0.13, upper);             // vest plate
  const headG = new THREE.Group(); headG.position.set(0, 1.56, 0); upper.add(headG);
  mk(0.25, 0.27, 0.25, skin, 0, 0.1, 0, headG);                // head
  const hat = mk(0.29, 0.12, 0.29, teamDark, 0, 0.26, 0, headG); // helmet or cap
  // arms: right holds the gun forward, left supports it
  const armR = new THREE.Group(); armR.position.set(0.31, 1.44, 0); upper.add(armR);
  mk(0.13, 0.13, 0.44, team, 0, -0.02, -0.2, armR);
  const armL = new THREE.Group(); armL.position.set(-0.31, 1.44, 0); upper.add(armL);
  mk(0.13, 0.13, 0.4, team, 0.06, -0.06, -0.18, armL);
  const gunSlot = new THREE.Group();
  gunSlot.position.set(0.16, 1.34, -0.3);
  upper.add(gunSlot);
  grp.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  scene.add(grp);
  const body = { grp, upper, legL, legR, headG, gunSlot, hat, gunKey: null, deathT: 0, walkPhase: 0 };
  a.body = body;
  return body;
}

export function setBodyGun(a) {
  const b = a.body;
  if (!b) return;
  const item = currentItem(a);
  const key = a.slot === 'knife' ? 'knife' : item ? item.key : 'p9';
  if (b.gunKey === key) return;
  b.gunKey = key;
  while (b.gunSlot.children.length) b.gunSlot.remove(b.gunSlot.children[0]);
  b.gunSlot.add(gunModel(key).clone());
}

export function syncBody(a, dt) {
  const b = a.body;
  if (!b) return;
  b.grp.position.copy(a.pos);
  b.grp.rotation.y = a.yaw;
  if (!a.alive) {
    // fall where you stand, then settle
    b.deathT = Math.min(1, b.deathT + dt * 2.4);
    b.grp.rotation.x = -Math.PI / 2 * b.deathT * 0.92;
    b.grp.position.y = a.pos.y + 0.12 * (1 - b.deathT);
    return;
  }
  b.deathT = 0;
  b.grp.rotation.x = 0;
  const moving = a.groundSpeed > 0.4;
  b.walkPhase += dt * (moving ? a.groundSpeed * 1.9 : 0);
  const swing = moving ? Math.sin(b.walkPhase) * 0.5 : 0;
  b.legL.rotation.x = swing;
  b.legR.rotation.x = -swing;
  const crouchK = a.crouch ? 1 : 0;
  b.upper.position.y = -0.34 * crouchK;
  b.legL.rotation.x += crouchK * 0.7;
  b.legR.rotation.x += crouchK * 0.4;
  b.headG.rotation.x = -a.pitch * 0.55;
  setBodyGun(a);
}

// ---- the human -------------------------------------------------------------
export function controlPlayer(a, dt, m) {
  // m: consumed mouse {dx, dy, clicked, rightClicked, wheel}
  const sens = a.ads ? 0.0011 : 0.0021;
  a.yaw -= m.dx * sens;
  a.pitch -= m.dy * sens;
  a.pitch = Math.max(-1.45, Math.min(1.45, a.pitch));
  const f = (down('KeyW') ? 1 : 0) - (down('KeyS') ? 1 : 0);
  const r = (down('KeyD') ? 1 : 0) - (down('KeyA') ? 1 : 0);
  const sin = Math.sin(a.yaw), cos = Math.cos(a.yaw);
  let wx = (-sin) * f + cos * r;
  let wz = (-cos) * f + (-sin) * r;
  const len = Math.hypot(wx, wz) || 1;
  wx /= len; wz /= len;
  a.crouch = down('ControlLeft') || down('KeyC');
  const item = currentItem(a);
  const heavy = item && (item.key === 'longshot') ? 0.92 : 1;
  let cap = 4.6 * heavy;
  if (a.crouch) cap = 2.1;
  else if (down('ShiftLeft')) cap = 2.3;      // walking: quiet and steadier
  else if (a.ads) cap = 2.5;
  if (a.slot === 'knife') cap = 5.0;
  stepPhysics(a, dt, wx, wz, cap, down('Space'));
  a.ads = m.rightDown && !!item && item.key !== 'knife';
}

// ---- camera and view model ---------------------------------------------------
let vm = null;
let vmKey = null;
let bobT = 0;
export function buildViewModel(camera) {
  vm = new THREE.Group();
  vm.position.set(0.24, -0.22, -0.45);
  camera.add(vm);
  return vm;
}
export function syncViewModel(a, dt) {
  if (!vm) return;
  const item = currentItem(a);
  const key = a.slot === 'knife' ? 'knife' : item ? item.key : null;
  if (key !== vmKey) {
    vmKey = key;
    while (vm.children.length) vm.remove(vm.children[0]);
    if (key) {
      const g = gunModel(key).clone();
      g.scale.setScalar(1.15);
      g.traverse((o) => { o.castShadow = false; });
      vm.add(g);
    }
  }
  bobT += dt * (a.groundSpeed > 0.4 && a.onGround ? a.groundSpeed * 1.6 : 0);
  const bobY = Math.sin(bobT * 2) * 0.008 * (a.groundSpeed / 4.6);
  const bobX = Math.cos(bobT) * 0.006 * (a.groundSpeed / 4.6);
  let dip = 0, tilt = 0;
  if (item && item.reloadEnd > G.time) { dip = 0.13; tilt = 0.5; }
  const adsK = a.ads ? 1 : 0;
  vm.position.set(
    0.24 - 0.24 * adsK + bobX,
    -0.22 + 0.1 * adsK + bobY - dip,
    -0.45 + 0.12 * adsK,
  );
  vm.rotation.set(tilt * 0.6, 0, tilt * 0.3);
  vm.visible = !(a.ads && item && WEAPONS[item.key].zoom > 0);
}

const _eyeV = new THREE.Vector3();
export function updateCamera(a, camera, dt) {
  const item = currentItem(a);
  const scoped = a.ads && item && WEAPONS[item.key].zoom > 0;
  const targetFov = scoped ? 26 : a.ads ? 74 : 90;
  camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 11);
  camera.updateProjectionMatrix();
  const eyeY = a.pos.y + (a.crouch ? 1.16 : 1.62);
  _eyeV.set(a.pos.x, eyeY, a.pos.z);
  camera.position.copy(_eyeV);
  const pitch = a.pitch + (a.punchP || 0);
  const yaw = a.yaw + (a.punchY || 0);
  camera.rotation.set(0, 0, 0);
  camera.rotation.order = 'YXZ';
  camera.rotation.y = yaw;
  camera.rotation.x = pitch;
  // a breath of roll when strafing sells the movement
  const strafe = (a.vel.x * Math.cos(a.yaw) - a.vel.z * Math.sin(a.yaw));
  camera.rotation.z = THREE.MathUtils.clamp(-strafe * 0.0035, -0.02, 0.02);
  return scoped;
}
