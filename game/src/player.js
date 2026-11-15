// player.js — the local player's body and the gun in their hands.
//
// Movement is tactical-shooter movement: strong ground friction and a
// short acceleration curve, so a player who stops is accurate at once and
// a player who strafes is not. Crouching lowers the body (and the hitbox
// with it) and tightens spread. The view model is a small set of boxes per
// weapon with recoil kick, reload dip and walk bob, driven from main.

import * as THREE from "three";
import { collide, groundHeightAt } from "./world.js";
import { WEAPONS, Gun, bodyHeight } from "./weapon.js";
import { INK, mat, TEAMS } from "./palette.js";

const GRAVITY = -23;
const JUMP_VEL = 7.4;
const ACCEL = 42;
const FRICTION = 10.5;
export const PLAYER_RADIUS = 0.36;

export class Player {
  constructor(scene, camera) {
    this.isPlayer = true;
    this.team = "atk";
    this.name = "YOU";
    this.alive = true;
    this.hp = 100;
    this.armor = 0;
    this.helmet = false;
    this.pos = new THREE.Vector3(-28, 0, 18);
    this.vel = new THREE.Vector3();
    this.yaw = -2.2;
    this.pitch = 0;
    this.crouch01 = 0;
    this.onGround = true;
    this.kills = 0;
    this.deaths = 0;
    this.money = 0;
    this.weapons = { primary: null, pistol: new Gun(WEAPONS.pistol), knife: new Gun(WEAPONS.knife) };
    this.active = "pistol"; // weapon id in hand
    this.gun = this.weapons.pistol;
    this.grenades = { he: 0, flash: 0, smoke: 0 };
    this.hasBomb = false;
    this.stepAcc = 0;
    this.blindT = 0; // flashbang time left
    this.lastHurtAt = -99;
    this.hurtFrom = null; // world position of the last attacker
    this.buildViewModel(scene, camera);
  }

  eyeY() { return this.pos.y + bodyHeight(this) - 0.14; }

  placeAt(spawn) {
    this.pos.set(spawn.x, 0, spawn.z);
    this.vel.set(0, 0, 0);
    this.yaw = spawn.yaw;
    this.pitch = 0;
    this.alive = true;
    this.hp = 100;
    this.blindT = 0;
  }

  giveWeapon(id) {
    const def = WEAPONS[id];
    const gun = new Gun(def);
    if (def.slot === 1) this.weapons.primary = gun;
    else if (def.slot === 2) this.weapons.pistol = gun;
    if (def.slot !== 3) this.equip(id);
    return gun;
  }

  equip(id) {
    const gun = id === "knife" ? this.weapons.knife
      : WEAPONS[id].slot === 1 ? this.weapons.primary : this.weapons.pistol;
    if (!gun) return false;
    this.active = id;
    this.gun = gun;
    this.viewModel.set(id);
    this.drawT = 0.28;
    return true;
  }

  // cmd: { mx, mz (strafe/forward -1..1), walk, crouch, jump, lookDX, lookDY }
  update(dt, cmd, W) {
    this.yaw -= cmd.lookDX * 0.0021;
    this.pitch -= cmd.lookDY * 0.0021;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));

    const crouchTarget = cmd.crouch ? 1 : 0;
    this.crouch01 += (crouchTarget - this.crouch01) * Math.min(1, dt * 11);

    const speedBase = this.gun.def.moveSpeed * (cmd.walk ? 0.52 : 1) * (1 - 0.55 * this.crouch01);
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    // forward on the ground plane for this yaw (yaw 0 faces -Z)
    const fx = -sin, fz = -cos;
    const rx = cos, rz = -sin;
    let wx = fx * cmd.mz + rx * cmd.mx;
    let wz = fz * cmd.mz + rz * cmd.mx;
    const wl = Math.hypot(wx, wz);
    if (wl > 1) { wx /= wl; wz /= wl; }

    if (this.onGround) {
      const fr = Math.max(0, 1 - FRICTION * dt);
      this.vel.x *= fr;
      this.vel.z *= fr;
      this.vel.x += wx * ACCEL * dt;
      this.vel.z += wz * ACCEL * dt;
      const sp = Math.hypot(this.vel.x, this.vel.z);
      if (sp > speedBase) {
        this.vel.x *= speedBase / sp;
        this.vel.z *= speedBase / sp;
      }
      if (cmd.jump && this.crouch01 < 0.4) {
        this.vel.y = JUMP_VEL;
        this.onGround = false;
      }
    } else {
      this.vel.x += wx * ACCEL * 0.14 * dt;
      this.vel.z += wz * ACCEL * 0.14 * dt;
    }
    this.vel.y += GRAVITY * dt;

    this.pos.addScaledVector(this.vel, dt);
    collide(W, this.pos, PLAYER_RADIUS, bodyHeight(this));
    const ground = groundHeightAt(W, this.pos.x, this.pos.z, this.pos.y);
    if (this.pos.y <= ground) {
      if (!this.onGround && this.vel.y < -6) this.landedHard = true;
      this.pos.y = ground;
      this.vel.y = 0;
      this.onGround = true;
    } else if (this.pos.y > ground + 0.02) {
      this.onGround = false;
    }

    // footstep cadence for the sound bank
    const hSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (this.onGround && hSpeed > 0.8) {
      this.stepAcc += dt * hSpeed;
      const stride = cmd.walk || this.crouch01 > 0.5 ? 3.4 : 2.5;
      if (this.stepAcc > stride) {
        this.stepAcc = 0;
        this.stepped = true;
      }
    }
    if (this.drawT > 0) this.drawT -= dt;
    if (this.blindT > 0) this.blindT -= dt;
    // gun timing is advanced by main, on the match clock, like every bot's
  }

  // ---- view model ---------------------------------------------------------
  buildViewModel(scene, camera) {
    const vm = new ViewModel();
    this.viewModel = vm;
    camera.add(vm.group);
    scene.add(camera);
  }
}

// The gun in view: one small group per weapon kind, boxes only, in the
// team's amber. Kick, dip and bob are cheap transforms on the group.
class ViewModel {
  constructor() {
    this.group = new THREE.Group();
    this.group.position.set(0.27, -0.24, -0.5);
    this.models = {};
    this.muzzles = {};
    const dark = mat(INK.darkMetal);
    const metal = mat(INK.metal);
    const accent = mat(TEAMS.atk.dark);

    const build = (id, parts) => {
      const g = new THREE.Group();
      for (const [w, h, d, x, y, z, m] of parts) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m ?? metal);
        mesh.position.set(x, y, z);
        g.add(mesh);
      }
      g.visible = false;
      this.group.add(g);
      this.models[id] = g;
      const tip = new THREE.Object3D();
      tip.position.copy(parts.tip);
      g.add(tip);
      this.muzzles[id] = tip;
    };

    build("pistol", Object.assign([
      [0.05, 0.07, 0.24, 0, 0, -0.1, dark],
      [0.045, 0.11, 0.06, 0, -0.08, 0.03, accent],
    ], { tip: new THREE.Vector3(0, 0.02, -0.24) }));
    build("smg", Object.assign([
      [0.055, 0.08, 0.44, 0, 0, -0.16, dark],
      [0.04, 0.16, 0.05, 0, -0.1, -0.14, metal],
      [0.045, 0.1, 0.06, 0, -0.07, 0.06, accent],
      [0.03, 0.03, 0.12, 0, 0.05, -0.4, dark],
    ], { tip: new THREE.Vector3(0, 0.01, -0.48) }));
    build("rifle", Object.assign([
      [0.055, 0.085, 0.62, 0, 0, -0.24, dark],
      [0.04, 0.17, 0.05, 0, -0.11, -0.18, metal],
      [0.045, 0.11, 0.07, 0, -0.08, 0.1, accent],
      [0.05, 0.1, 0.16, 0, -0.02, 0.24, accent],
      [0.025, 0.05, 0.03, 0, 0.07, -0.3, dark],
    ], { tip: new THREE.Vector3(0, 0.01, -0.58) }));
    build("sniper", Object.assign([
      [0.05, 0.08, 0.8, 0, 0, -0.3, dark],
      [0.055, 0.07, 0.09, 0, 0.09, -0.22, metal],
      [0.04, 0.15, 0.05, 0, -0.1, -0.2, metal],
      [0.05, 0.11, 0.2, 0, -0.03, 0.28, accent],
    ], { tip: new THREE.Vector3(0, 0.01, -0.74) }));
    build("knife", Object.assign([
      [0.03, 0.09, 0.05, 0, -0.03, 0.02, accent],
      [0.012, 0.03, 0.26, 0, 0.02, -0.16, mat(0xb9bec4)],
    ], { tip: new THREE.Vector3(0, 0.02, -0.3) }));
    build("grenade", Object.assign([
      [0.075, 0.09, 0.075, 0, -0.02, -0.05, mat(0x4c5b3c)],
      [0.02, 0.04, 0.02, 0, 0.04, -0.05, mat(0xb9bec4)],
    ], { tip: new THREE.Vector3(0, 0, -0.1) }));

    // hands: two small amber sleeves anchor the gun visually
    for (const [x, y, z] of [[0.02, -0.13, -0.3], [-0.03, -0.12, 0.05]]) {
      const hand = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.06, 0.12), accent);
      hand.position.set(x, y, z);
      this.group.add(hand);
    }
    this.current = null;
    this.kick = 0;
    this.bobT = 0;
    this.reloadDip = 0;
  }

  set(id) {
    if (this.current) this.models[this.current].visible = false;
    this.current = id;
    if (id) this.models[id].visible = true;
    this.kick = 0;
  }

  muzzleWorld(out) {
    return this.muzzles[this.current].getWorldPosition(out);
  }

  fire() { this.kick = Math.min(0.09, this.kick + 0.045); }

  update(dt, speed, reloading) {
    this.kick = Math.max(0, this.kick - dt * 0.5);
    this.bobT += dt * speed * 1.6;
    this.reloadDip += ((reloading ? 1 : 0) - this.reloadDip) * Math.min(1, dt * 7);
    const bobY = Math.sin(this.bobT * 2) * 0.006 * Math.min(1, speed / 4);
    const bobX = Math.cos(this.bobT) * 0.005 * Math.min(1, speed / 4);
    this.group.position.set(0.27 + bobX, -0.24 + bobY - this.reloadDip * 0.09, -0.5 + this.kick);
    this.group.rotation.x = this.kick * 1.6 - this.reloadDip * 0.55;
  }
}
