// bots.js — the other seven people in the yard.
//
// Each bot is a box-built figure in its team's colour and a small brain:
// a state machine (route, hold, engage, hunt, plant, defuse, fetch) fed by
// perception. Bots see through a vision cone with real occlusion, hear
// gunfire as noise events, follow waypoint routes through the lanes, hold
// site positions as defenders, rotate when the bomb is spotted or planted,
// and channel plants and defuses exactly like the player does. Shooting
// itself is resolved by main (one combat path for everyone); a bot only
// decides, aims with an error that shrinks while it tracks a target, and
// asks to fire in bursts.

import * as THREE from "three";
import { collide, groundHeightAt, hasLOS, findPath, nearestNode } from "./world.js";
import { WEAPONS, Gun, bodyHeight } from "./weapon.js";
import { TEAMS, mat } from "./palette.js";

const SIGHT_RANGE = 46;
const SIGHT_COS = Math.cos(1.35); // ~77 degree half-cone

export class Bot {
  constructor(scene, team, name) {
    this.isPlayer = false;
    this.team = team;
    this.name = name;
    this.alive = true;
    this.hp = 100;
    this.armor = 0;
    this.helmet = false;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.crouch01 = 0;
    this.onGround = true;
    this.kills = 0;
    this.deaths = 0;
    this.money = 800;
    this.weapons = { primary: null, pistol: new Gun(WEAPONS.pistol), knife: new Gun(WEAPONS.knife) };
    this.active = "pistol";
    this.gun = this.weapons.pistol;
    this.grenades = { he: 0, flash: 0, smoke: 0 };
    this.hasBomb = false;
    this.hasKit = false;
    this.blindT = 0;
    this.stepAcc = 0;
    this.stepped = false;
    // brain
    this.state = "route";
    this.path = [];
    this.pathI = 0;
    this.goal = null; // {x, z} final destination of the current order
    this.holdPos = null;
    this.memory = { enemy: null, x: 0, z: 0, at: -99 };
    this.thinkAt = Math.random() * 0.2;
    this.reactAt = 0;
    this.burstLeft = 0;
    this.burstWaitUntil = 0;
    this.aimErr = 0.04;
    this.stuckT = 0;
    this.lastX = 0; this.lastZ = 0;
    this.threwAt = -99;
    this.deadT = 0;
    this.buildMesh(scene);
  }

  eyeY() { return this.pos.y + bodyHeight(this) - 0.14; }

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
    this.gunMesh.visible = id !== "knife";
    return true;
  }

  buildMesh(scene) {
    const T = TEAMS[this.team];
    const grp = new THREE.Group();
    const body = new THREE.Group();
    grp.add(body);
    const legM = mat(0x33373d);
    const torsoM = mat(T.color);
    const darkM = mat(T.dark);
    const skinM = mat(0xc9a183);
    const mk = (w, h, d, x, y, z, m) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      body.add(mesh);
      return mesh;
    };
    this.legL = mk(0.17, 0.78, 0.19, -0.13, 0.39, 0, legM);
    this.legR = mk(0.17, 0.78, 0.19, 0.13, 0.39, 0, legM);
    mk(0.54, 0.62, 0.3, 0, 1.09, 0, torsoM); // torso
    mk(0.56, 0.34, 0.34, 0, 1.16, 0, darkM); // vest
    mk(0.2, 0.5, 0.14, -0.36, 1.12, 0, torsoM); // left arm
    const armR = mk(0.2, 0.5, 0.14, 0.36, 1.12, 0.02, torsoM);
    armR.rotation.x = -0.5;
    this.head = mk(0.27, 0.28, 0.27, 0, 1.56, 0, skinM);
    mk(0.28, 0.1, 0.28, 0, 1.66, 0, darkM); // cap
    mk(0.24, 0.06, 0.02, 0, 1.56, -0.14, mat(0x14181d)); // visor
    this.gunMesh = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.12, 0.62), mat(0x22262c));
    this.gunMesh.position.set(0.3, 1.24, -0.34);
    this.gunMesh.castShadow = true;
    body.add(this.gunMesh);
    this.body = body;
    this.mesh = grp;
    scene.add(grp);
  }

  syncMesh(walkPhase) {
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.y = this.yaw; // model front (-Z) lands on (-sin yaw, -cos yaw)
    this.body.position.y = -0.5 * this.crouch01;
    this.legL.rotation.x = Math.sin(walkPhase) * 0.55;
    this.legR.rotation.x = -Math.sin(walkPhase) * 0.55;
    if (!this.alive) {
      const t = Math.min(1, this.deadT / 0.45);
      this.mesh.rotation.x = -t * Math.PI / 2 * 0.92;
      this.mesh.position.y = this.pos.y - t * 0.2;
    } else {
      this.mesh.rotation.x = 0;
    }
  }

  // ---- perception -----------------------------------------------------------
  perceive(env) {
    const eye = _eye.set(this.pos.x, this.eyeY(), this.pos.z);
    let bestEnemy = null, bestDist = Infinity;
    for (const e of env.enemies) {
      if (!e.alive) continue;
      const dx = e.pos.x - this.pos.x, dz = e.pos.z - this.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > SIGHT_RANGE) continue;
      if (dist > 4.5) {
        const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
        const dot = (dx * fx + dz * fz) / (dist || 1);
        if (dot < SIGHT_COS) continue;
      }
      const ey = e.pos.y + bodyHeight(e) * 0.72;
      if (!hasLOS(env.W, eye.x, eye.y, eye.z, e.pos.x, ey, e.pos.z, env.smokes)) continue;
      if (dist < bestDist) { bestDist = dist; bestEnemy = e; }
    }
    if (bestEnemy) {
      const fresh = this.memory.enemy !== bestEnemy;
      this.memory.enemy = bestEnemy;
      this.memory.x = bestEnemy.pos.x;
      this.memory.z = bestEnemy.pos.z;
      this.memory.at = env.time;
      if (fresh || this.state !== "engage") {
        this.reactAt = env.time + 0.34 + Math.random() * 0.26;
        this.aimErr = 0.042;
      }
      return bestEnemy;
    }
    return null;
  }

  hearNoise(env) {
    for (const n of env.noises) {
      if (n.team === this.team || env.time - n.at > 1.2) continue;
      const d = Math.hypot(n.x - this.pos.x, n.z - this.pos.z);
      if (d < n.radius && env.time - (this.memory.at) > 1.5) {
        this.memory.x = n.x;
        this.memory.z = n.z;
        this.memory.at = env.time - 1.2; // a hint, not a lock
        this.memory.enemy = null;
        if (this.state === "hold" || this.state === "route") this.state = "hunt";
        this.setGoal(env, n.x, n.z);
      }
    }
  }

  setGoal(env, x, z) {
    this.goal = { x, z };
    const from = nearestNode(env.W, this.pos.x, this.pos.z);
    const to = nearestNode(env.W, x, z);
    findPath(env.W, from, to, this.path);
    this.pathI = 0;
  }

  // ---- the brain --------------------------------------------------------------
  update(dt, env) {
    if (!this.alive) {
      this.deadT += dt;
      this.syncMesh(0);
      return;
    }
    if (this.blindT > 0) this.blindT -= dt;
    const time = env.time;
    this.gun.update(time, dt);

    // think at ~7 Hz: perception, state changes, orders
    if (time >= this.thinkAt) {
      this.thinkAt = time + 0.14 + Math.random() * 0.05;
      const seen = this.blindT > 0.4 ? null : this.perceive(env);
      this.hearNoise(env);
      this.decide(env, seen);
    }

    this.act(dt, env);
    this.syncMesh(this.walkPhase || 0);
  }

  decide(env, seen) {
    const G = env.G;
    const mem = this.memory;
    const memFresh = env.time - mem.at < 2.6 && (mem.enemy ? mem.enemy.alive : true);

    if (seen && this.state !== "plant" && this.state !== "defuse") {
      this.state = "engage";
      return;
    }
    if (this.state === "engage") {
      if (!memFresh) {
        this.state = "hunt";
        this.setGoal(env, mem.x, mem.z);
      }
      return;
    }
    if (this.state === "plant" || this.state === "defuse") {
      // still channeling only while main's channel is ours; a cancelled
      // channel (damage, a moved planter) frees the bot to fight again
      if (env.G.channel && env.G.channel.who === this) return;
      this.state = "route";
    }

    // bomb-driven orders outrank routine ones
    if (G.bomb && G.bomb.state === "planted") {
      if (this.team === "def") {
        const b = G.bomb;
        const d = Math.hypot(b.x - this.pos.x, b.z - this.pos.z);
        if (d < 1.6) {
          const otherDefusing = env.combatants.some((c) => c !== this && c.team === "def" && c.channelRole === "defuse");
          if (!otherDefusing) { this.state = "defuse"; env.startChannel(this, "defuse"); return; }
        }
        this.state = "goto";
        this.setGoal(env, b.x, b.z);
        return;
      }
      // attackers fall back and guard the bomb
      this.state = "hold";
      this.holdPos = { x: G.bomb.x + (this.pos.x > G.bomb.x ? 4 : -4), z: G.bomb.z + 3 };
      return;
    }
    if (this.team === "atk") {
      if (this.hasBomb) {
        const site = env.attackSite;
        if (Math.hypot(site.x - this.pos.x, site.z - this.pos.z) < site.r - 1.2) {
          this.state = "plant";
          env.startChannel(this, "plant");
        } else {
          this.state = "goto";
          this.setGoal(env, site.x, site.z);
        }
        return;
      }
      if (G.bomb && G.bomb.state === "dropped") {
        const nearest = env.combatants
          .filter((c) => c.team === "atk" && c.alive && !c.hasBomb)
          .sort((a, b) => (Math.hypot(a.pos.x - G.bomb.x, a.pos.z - G.bomb.z) - Math.hypot(b.pos.x - G.bomb.x, b.pos.z - G.bomb.z)))[0];
        if (nearest === this) {
          this.state = "goto";
          this.setGoal(env, G.bomb.x, G.bomb.z);
          return;
        }
      }
    }
    if (this.state === "hunt" && this.goal &&
        Math.hypot(this.goal.x - this.pos.x, this.goal.z - this.pos.z) < 1.6) {
      this.state = this.team === "def" ? "hold" : "route";
      this.holdPos = { x: this.pos.x, z: this.pos.z };
    }
    if ((this.state === "route" || this.state === "goto") && this.goal &&
        Math.hypot(this.goal.x - this.pos.x, this.goal.z - this.pos.z) < 1.2) {
      // arrived: defenders settle onto their post and hold the angle
      if (this.team === "def") {
        this.state = "hold";
        this.holdPos = { x: this.dual.x, z: this.dual.z };
      }
    }
    if (this.state === "route" || this.state === "goto") {
      const goal = this.team === "atk" ? env.attackSiteGoal(this) : env.defendGoal(this);
      if (goal && (!this.goal || Math.hypot(goal.x - this.goal.x, goal.z - this.goal.z) > 3)) {
        this.setGoal(env, goal.x, goal.z);
      }
    }
    if (this.state === "idle") this.state = this.team === "def" ? "hold" : "route";
  }

  act(dt, env) {
    const time = env.time;
    let moveX = 0, moveZ = 0, wantSpeed = 0;
    let faceYaw = this.yaw;
    const mem = this.memory;
    const engaging = this.state === "engage" && mem.enemy && mem.enemy.alive && env.time - mem.at < 2.6;

    if (this.state === "plant" || this.state === "defuse") {
      // stand still and channel; main owns the timer and interruption
      this.crouch01 += (0.6 - this.crouch01) * Math.min(1, dt * 8);
      this.applyMove(dt, env, 0, 0, 0);
      return;
    }

    if (engaging) {
      const e = mem.enemy;
      faceYaw = Math.atan2(-(e.pos.x - this.pos.x), -(e.pos.z - this.pos.z));
      const dist = Math.hypot(e.pos.x - this.pos.x, e.pos.z - this.pos.z);
      // keep a fighting distance, strafe in short unpredictable steps
      const strafe = Math.sin(time * 0.9 + this.pos.x) > 0 ? 1 : -1;
      const radial = dist > 26 ? 1 : dist < 9 ? -0.7 : 0;
      const fx = -Math.sin(faceYaw), fz = -Math.cos(faceYaw);
      moveX = fx * radial + -fz * strafe * 0.55;
      moveZ = fz * radial + fx * strafe * 0.55;
      wantSpeed = this.gun.def.moveSpeed * 0.5;
      this.crouch01 += ((Math.sin(time * 0.37 + this.pos.z) > 0.72 ? 0.85 : 0) - this.crouch01) * Math.min(1, dt * 6);
      this.combat(dt, env, e);
    } else {
      this.crouch01 += (0 - this.crouch01) * Math.min(1, dt * 8);
      // follow the path
      let target = null;
      if (this.path.length && this.pathI < this.path.length) {
        target = env.W.nodes[this.path[this.pathI]];
        if (Math.hypot(target.x - this.pos.x, target.z - this.pos.z) < 1.1) {
          this.pathI++;
          target = this.pathI < this.path.length ? env.W.nodes[this.path[this.pathI]] : null;
        }
      }
      if (!target && this.goal) target = this.goal;
      if (this.state === "hold" && this.holdPos) target = this.holdPos;
      if (target) {
        const dx = target.x - this.pos.x, dz = target.z - this.pos.z;
        const d = Math.hypot(dx, dz);
        const arrived = this.state === "hold" ? d < 0.5 : d < 0.9;
        if (!arrived) {
          moveX = dx / (d || 1);
          moveZ = dz / (d || 1);
          faceYaw = Math.atan2(-dx, -dz);
          wantSpeed = this.gun.def.moveSpeed * (this.state === "hold" ? 0.6 : 0.92);
        } else if (this.state === "hold") {
          faceYaw += Math.sin(time * 0.4 + this.pos.x * 2) * 0.0035; // scan the lane
        }
      }
      if (this.gun.mag === 0 && !this.gun.reloading) {
        if (this.gun.startReload(time)) env.onReload(this);
      }
    }

    // face where we mean to face, at a human turn rate
    let dy = faceYaw - this.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.yaw += Math.max(-3.4 * dt, Math.min(3.4 * dt, dy));
    this.pitch = engaging ? Math.max(-0.2, Math.min(0.2, this.pitch)) : 0;

    this.applyMove(dt, env, moveX, moveZ, wantSpeed);
  }

  applyMove(dt, env, mx, mz, speed) {
    const k = Math.min(1, dt * 8);
    this.vel.x += (mx * speed - this.vel.x) * k;
    this.vel.z += (mz * speed - this.vel.z) * k;
    this.vel.y -= 23 * dt;
    this.pos.addScaledVector(this.vel, dt);
    // gentle separation from allies so bots do not stack into one target
    for (const c of env.combatants) {
      if (c === this || !c.alive) continue;
      const dx = this.pos.x - c.pos.x, dz = this.pos.z - c.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 0.49 && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        this.pos.x += (dx / d) * (0.7 - d) * 0.5;
        this.pos.z += (dz / d) * (0.7 - d) * 0.5;
      }
    }
    collide(env.W, this.pos, 0.36, bodyHeight(this));
    const ground = groundHeightAt(env.W, this.pos.x, this.pos.z, this.pos.y);
    if (this.pos.y <= ground) {
      this.pos.y = ground;
      this.vel.y = 0;
      this.onGround = true;
    } else {
      this.onGround = false;
    }
    const hSpeed = Math.hypot(this.vel.x, this.vel.z);
    this.walkPhase = (this.walkPhase || 0) + dt * hSpeed * 1.9;
    if (this.onGround && hSpeed > 1) {
      this.stepAcc += dt * hSpeed;
      if (this.stepAcc > 2.6) { this.stepAcc = 0; this.stepped = true; }
    }
    // stuck detection: ordered to move but not moving -> sidestep impulse
    if (speed > 0.5) {
      const moved = Math.hypot(this.pos.x - this.lastX, this.pos.z - this.lastZ);
      if (moved < dt * speed * 0.25) {
        this.stuckT += dt;
        if (this.stuckT > 0.9) {
          this.pos.x += Math.cos(this.yaw) * 0.5;
          this.pos.z -= Math.sin(this.yaw) * 0.5;
          this.stuckT = 0;
        }
      } else this.stuckT = 0;
    }
    this.lastX = this.pos.x;
    this.lastZ = this.pos.z;
  }

  // Burst fire with a reaction delay and a tracking error that settles.
  combat(dt, env, enemy) {
    const time = env.time;
    if (this.blindT > 0.4) return;
    const dist = Math.hypot(enemy.pos.x - this.pos.x, enemy.pos.z - this.pos.z);
    const eye = _eye.set(this.pos.x, this.eyeY(), this.pos.z);
    const cy = enemy.pos.y + bodyHeight(enemy) * 0.68;
    if (!hasLOS(env.W, eye.x, eye.y, eye.z, enemy.pos.x, cy, enemy.pos.z, env.smokes)) {
      this.burstLeft = 0;
      return;
    }
    this.aimErr = Math.max(0.011, this.aimErr - dt * 0.02);
    if (this.gun.reloading) return;
    if (this.gun.mag === 0) {
      if (this.gun.startReload(time)) env.onReload(this);
      return;
    }
    // a flash through the choke before pushing a held angle, once in a while
    if (this.grenades.flash > 0 && time - this.threwAt > 20 && dist > 9 && dist < 22 && Math.random() < 0.006) {
      this.grenades.flash--;
      this.threwAt = time;
      env.onThrow(this, "flash", enemy.pos);
      this.burstWaitUntil = time + 0.8;
      return;
    }
    if (time < this.reactAt || time < this.burstWaitUntil) return;
    if (this.burstLeft <= 0) {
      this.burstLeft = this.gun.def.id === "sniper" ? 1 : 3 + (Math.random() * 3 | 0);
    }
    if (this.gun.ready(time)) {
      env.onShoot(this, enemy);
      this.burstLeft--;
      if (this.burstLeft <= 0) {
        this.burstWaitUntil = time + 0.45 + Math.random() * 0.5;
      }
    }
  }
}

const _eye = new THREE.Vector3();
