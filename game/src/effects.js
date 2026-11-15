// effects.js — tracers, impact sparks, hit puffs, muzzle light, explosions
// and smoke clouds, all from preallocated pools.
//
// Nothing here allocates after construction: the hot loop writes into
// fixed buffers, so a firefight never feeds the garbage collector.

import * as THREE from "three";

const TRACERS = 40;
const PARTICLES = 420;
const SMOKES = 10;

function smokeTexture() {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 128;
  const g = cv.getContext("2d");
  const grad = g.createRadialGradient(64, 64, 6, 64, 64, 62);
  grad.addColorStop(0, "rgba(196,198,200,0.85)");
  grad.addColorStop(0.6, "rgba(170,172,175,0.45)");
  grad.addColorStop(1, "rgba(160,162,165,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Effects {
  constructor(scene) {
    this.scene = scene;

    // Tracers: thin stretched boxes with an additive material.
    this.tracerGeo = new THREE.BoxGeometry(0.02, 0.02, 1);
    this.tracers = [];
    for (let i = 0; i < TRACERS; i++) {
      const m = new THREE.Mesh(this.tracerGeo, new THREE.MeshBasicMaterial({
        color: 0xffd9a0, transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      m.visible = false;
      scene.add(m);
      this.tracers.push({ mesh: m, life: 0 });
    }
    this.tracerIdx = 0;

    // Particles: one Points cloud, positions and colours in fixed arrays.
    this.pGeo = new THREE.BufferGeometry();
    this.pPos = new Float32Array(PARTICLES * 3);
    this.pCol = new Float32Array(PARTICLES * 3);
    this.pVel = new Float32Array(PARTICLES * 3);
    this.pLife = new Float32Array(PARTICLES);
    this.pGrav = new Float32Array(PARTICLES);
    for (let i = 0; i < PARTICLES; i++) this.pPos[i * 3 + 1] = -999;
    this.pGeo.setAttribute("position", new THREE.BufferAttribute(this.pPos, 3));
    this.pGeo.setAttribute("color", new THREE.BufferAttribute(this.pCol, 3));
    this.points = new THREE.Points(this.pGeo, new THREE.PointsMaterial({
      size: 0.09, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false,
    }));
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.pIdx = 0;

    // One shared point light does muzzle flashes and the explosion.
    this.light = new THREE.PointLight(0xffc37a, 0, 14, 1.6);
    scene.add(this.light);
    this.lightLife = 0;

    // Smoke clouds: a few sprite planes per grenade, grown then faded.
    this.smokeTex = smokeTexture();
    this.smokes = [];
    for (let i = 0; i < SMOKES; i++) {
      const grp = new THREE.Group();
      const planes = [];
      for (let j = 0; j < 5; j++) {
        const p = new THREE.Mesh(
          new THREE.PlaneGeometry(1, 1),
          new THREE.MeshBasicMaterial({ map: this.smokeTex, transparent: true, opacity: 0, depthWrite: false })
        );
        grp.add(p);
        planes.push(p);
      }
      grp.visible = false;
      scene.add(grp);
      this.smokes.push({ grp, planes, life: 0, dur: 0, x: 0, y: 0, z: 0 });
    }
    this.smokeIdx = 0;
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
  }

  tracer(ax, ay, az, bx, by, bz, color = 0xffd9a0) {
    const t = this.tracers[this.tracerIdx];
    this.tracerIdx = (this.tracerIdx + 1) % TRACERS;
    const m = t.mesh;
    m.material.color.setHex(color);
    this._v.set(bx - ax, by - ay, bz - az);
    const len = this._v.length();
    if (len < 0.1) return;
    m.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    m.scale.set(1, 1, len);
    m.lookAt(bx, by, bz);
    m.visible = true;
    t.life = 0.055;
  }

  burst(x, y, z, { count = 8, color = 0xd8c9a0, speed = 2.4, spread = 1, gravity = 5, life = 0.4 } = {}) {
    const c = new THREE.Color(color);
    for (let n = 0; n < count; n++) {
      const i = this.pIdx;
      this.pIdx = (this.pIdx + 1) % PARTICLES;
      this.pPos[i * 3] = x; this.pPos[i * 3 + 1] = y; this.pPos[i * 3 + 2] = z;
      this.pVel[i * 3] = (Math.random() - 0.5) * 2 * spread * speed;
      this.pVel[i * 3 + 1] = Math.random() * speed * 0.9 + 0.4;
      this.pVel[i * 3 + 2] = (Math.random() - 0.5) * 2 * spread * speed;
      this.pCol[i * 3] = c.r; this.pCol[i * 3 + 1] = c.g; this.pCol[i * 3 + 2] = c.b;
      this.pLife[i] = life * (0.6 + Math.random() * 0.7);
      this.pGrav[i] = gravity;
    }
  }

  impact(x, y, z) {
    this.burst(x, y, z, { count: 6, color: 0xcfc4a6, speed: 1.8, life: 0.3 });
  }

  hitPuff(x, y, z, head = false) {
    this.burst(x, y, z, { count: head ? 12 : 8, color: head ? 0xe5484d : 0xb03a3e, speed: 1.6, life: 0.35 });
  }

  muzzle(x, y, z, intensity = 2.2) {
    this.light.position.set(x, y, z);
    this.light.intensity = intensity;
    this.light.color.setHex(0xffc37a);
    this.lightLife = 0.05;
  }

  explosion(x, y, z) {
    this.burst(x, y, z, { count: 60, color: 0xff9a3c, speed: 7, life: 0.7, gravity: 2 });
    this.burst(x, y, z, { count: 30, color: 0x55483a, speed: 3.4, life: 1.1, gravity: -0.5 });
    this.light.position.set(x, y + 1, z);
    this.light.intensity = 60;
    this.light.color.setHex(0xff8a3c);
    this.lightLife = 0.4;
  }

  smoke(x, y, z, dur = 14) {
    const s = this.smokes[this.smokeIdx];
    this.smokeIdx = (this.smokeIdx + 1) % SMOKES;
    s.x = x; s.y = y; s.z = z;
    s.life = dur;
    s.dur = dur;
    s.grp.position.set(x, y, z);
    s.grp.visible = true;
    for (let j = 0; j < s.planes.length; j++) {
      const p = s.planes[j];
      const a = (j / s.planes.length) * Math.PI * 2;
      p.position.set(Math.cos(a) * 0.8, 0.4 + (j % 3) * 0.55, Math.sin(a) * 0.8);
      p.scale.set(3.4, 2.6, 1);
    }
    return s;
  }

  update(dt, camera) {
    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      if (t.life <= 0) t.mesh.visible = false;
    }
    for (let i = 0; i < PARTICLES; i++) {
      if (this.pLife[i] <= 0) continue;
      this.pLife[i] -= dt;
      if (this.pLife[i] <= 0) { this.pPos[i * 3 + 1] = -999; continue; }
      this.pVel[i * 3 + 1] -= this.pGrav[i] * dt;
      this.pPos[i * 3] += this.pVel[i * 3] * dt;
      this.pPos[i * 3 + 1] += this.pVel[i * 3 + 1] * dt;
      this.pPos[i * 3 + 2] += this.pVel[i * 3 + 2] * dt;
      if (this.pPos[i * 3 + 1] < 0.02) this.pPos[i * 3 + 1] = 0.02;
    }
    this.pGeo.attributes.position.needsUpdate = true;
    this.pGeo.attributes.color.needsUpdate = true;
    if (this.lightLife > 0) {
      this.lightLife -= dt;
      if (this.lightLife <= 0) this.light.intensity = 0;
    }
    for (const s of this.smokes) {
      if (s.life <= 0) continue;
      s.life -= dt;
      const age = 1 - s.life / s.dur;
      const fade = age < 0.12 ? age / 0.12 : s.life < 2.5 ? s.life / 2.5 : 1;
      for (const p of s.planes) {
        p.material.opacity = 0.55 * fade;
        p.lookAt(camera.position);
      }
      if (s.life <= 0) s.grp.visible = false;
    }
  }
}
