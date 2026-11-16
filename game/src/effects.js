// effects.js - every transient visual, pooled.
// Tracers, impact particles, shell casings, smoke puffs, muzzle and
// explosion lights are all pre-allocated at boot and recycled: the hot
// loop writes into typed arrays and instance buffers and allocates
// nothing, so a firefight cannot hitch the frame rate. Smoke is also
// data: the cloud list here is what blocks bot sight lines.

import * as THREE from 'three';
import { PAL } from './palette.js';

const TRACERS = 96;
const PARTICLES = 1400;
const CASINGS = 48;
const PUFFS = 90;

let scene = null;
let tracerGeo, tracerPos, tracerCol, tracerLife, tracerHead = 0;
let pts, pPos, pCol, pVel, pLife, pMax, pGrav, pHead = 0;
let casingIM, casingData;
let puffIM, puffData;
let flashLight, boomLight;
let rings = [];
export const smokeClouds = []; // {x, y, z, r, until} in sim seconds

const _c = new THREE.Color();

export function initEffects(s) {
  scene = s;
  // tracers: additive line segments, faded by writing colour toward 0
  tracerPos = new Float32Array(TRACERS * 6);
  tracerCol = new Float32Array(TRACERS * 6);
  tracerLife = new Float32Array(TRACERS);
  tracerGeo = new THREE.BufferGeometry();
  tracerGeo.setAttribute('position', new THREE.BufferAttribute(tracerPos, 3));
  tracerGeo.setAttribute('color', new THREE.BufferAttribute(tracerCol, 3));
  const lines = new THREE.LineSegments(tracerGeo, new THREE.LineBasicMaterial({
    vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
  }));
  lines.frustumCulled = false;
  scene.add(lines);
  // particles: one Points cloud for sparks, dust, blood and debris
  pPos = new Float32Array(PARTICLES * 3);
  pCol = new Float32Array(PARTICLES * 3);
  pVel = new Float32Array(PARTICLES * 3);
  pLife = new Float32Array(PARTICLES);
  pMax = new Float32Array(PARTICLES);
  pGrav = new Float32Array(PARTICLES);
  for (let i = 0; i < PARTICLES; i++) pPos[i * 3 + 1] = -999;
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  pg.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
  pts = new THREE.Points(pg, new THREE.PointsMaterial({
    size: 0.09, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false,
    sizeAttenuation: true, map: makePuffTexture(), alphaTest: 0.02,
  }));
  pts.frustumCulled = false;
  scene.add(pts);
  // casings: tiny brass boxes with a short ballistic hop
  casingData = [];
  for (let i = 0; i < CASINGS; i++) casingData.push({ life: 0, x: 0, y: -99, z: 0, vx: 0, vy: 0, vz: 0, rx: 0, rz: 0 });
  casingIM = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.016, 0.016, 0.045),
    new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.35, metalness: 0.8 }),
    CASINGS,
  );
  casingIM.frustumCulled = false;
  scene.add(casingIM);
  // smoke puffs: soft sprites scaled up over their life
  const puffTex = makePuffTexture();
  puffData = [];
  for (let i = 0; i < PUFFS; i++) puffData.push({ life: 0, max: 1, x: 0, y: 0, z: 0, s: 1 });
  puffIM = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: puffTex, transparent: true, opacity: 0.34, depthWrite: false, color: PAL.smoke }),
    PUFFS,
  );
  puffIM.frustumCulled = false;
  scene.add(puffIM);
  // two shared lights, moved to the newest event: muzzle and explosion
  flashLight = new THREE.PointLight(0xffc37a, 0, 13, 1.9);
  scene.add(flashLight);
  boomLight = new THREE.PointLight(0xff8a3e, 0, 26, 1.6);
  scene.add(boomLight);
  // explosion shock rings
  const ringGeo = new THREE.RingGeometry(0.8, 1.0, 28);
  for (let i = 0; i < 4; i++) {
    const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
      color: 0xffb36b, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
    }));
    m.rotation.x = -Math.PI / 2;
    m.visible = false;
    rings.push({ mesh: m, life: 0 });
    scene.add(m);
  }
}

function makePuffTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.4)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  return t;
}

export function fxTracer(x0, y0, z0, x1, y1, z1, colorHex) {
  const i = tracerHead; tracerHead = (tracerHead + 1) % TRACERS;
  tracerPos.set([x0, y0, z0, x1, y1, z1], i * 6);
  _c.setHex(colorHex);
  tracerCol.set([_c.r, _c.g, _c.b, _c.r * 0.25, _c.g * 0.25, _c.b * 0.25], i * 6);
  tracerLife[i] = 0.055;
  tracerGeo.attributes.position.needsUpdate = true;
  tracerGeo.attributes.color.needsUpdate = true;
}

function spawnP(x, y, z, vx, vy, vz, life, grav, r, g, b) {
  const i = pHead; pHead = (pHead + 1) % PARTICLES;
  pPos.set([x, y, z], i * 3);
  pVel.set([vx, vy, vz], i * 3);
  pCol.set([r, g, b], i * 3);
  pLife[i] = life; pMax[i] = life; pGrav[i] = grav;
}

export function fxImpact(x, y, z, nx, ny, nz, matKey) {
  // colour and character by the surface the bullet met
  let col = [0.62, 0.6, 0.55], n = 5, speed = 1.6; // concrete dust
  if (matKey === 'wood' || matKey === 'woodDark') { col = [0.55, 0.4, 0.22]; n = 7; }
  else if (matKey && (matKey.startsWith('container') || matKey.startsWith('steel'))) { col = [1.0, 0.8, 0.4]; n = 4; speed = 2.6; }
  else if (matKey === 'coldroom') { col = [0.85, 0.92, 0.95]; n = 6; }
  for (let k = 0; k < n; k++) {
    const vx = nx * speed * (0.4 + Math.random() * 0.8) + (Math.random() - 0.5) * 1.2;
    const vy = Math.abs(ny) * speed * Math.random() + Math.random() * 1.1;
    const vz = nz * speed * (0.4 + Math.random() * 0.8) + (Math.random() - 0.5) * 1.2;
    spawnP(x, y, z, vx, vy, vz, 0.28 + Math.random() * 0.3, 3.4, col[0], col[1], col[2]);
  }
}

export function fxBlood(x, y, z) {
  _c.setHex(PAL.blood);
  for (let k = 0; k < 7; k++) {
    spawnP(x, y, z,
      (Math.random() - 0.5) * 1.6, Math.random() * 1.2, (Math.random() - 0.5) * 1.6,
      0.3 + Math.random() * 0.25, 4.2, _c.r, _c.g, _c.b);
  }
}

export function fxMuzzle(x, y, z) {
  flashLight.position.set(x, y, z);
  flashLight.intensity = 26;
  _c.setHex(0xffd9a0);
  for (let k = 0; k < 3; k++) {
    spawnP(x, y, z, (Math.random() - 0.5) * 0.8, Math.random() * 0.7, (Math.random() - 0.5) * 0.8,
      0.07, 0, _c.r, _c.g, _c.b);
  }
}

export function fxCasing(x, y, z, rx, rz) {
  for (const c of casingData) {
    if (c.life <= 0) {
      c.life = 1.4; c.x = x; c.y = y; c.z = z;
      c.vx = rx * (0.7 + Math.random() * 0.5); c.vz = rz * (0.7 + Math.random() * 0.5);
      c.vy = 1.1 + Math.random() * 0.5;
      c.rx = Math.random() * 6; c.rz = Math.random() * 6;
      return;
    }
  }
}

export function fxExplosion(x, y, z, now) {
  boomLight.position.set(x, y + 1, z);
  boomLight.intensity = 320;
  for (let k = 0; k < 42; k++) {
    const a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 7;
    spawnP(x, y + 0.4, z, Math.cos(a) * sp, 1.5 + Math.random() * 4.5, Math.sin(a) * sp,
      0.4 + Math.random() * 0.5, 2.2, 1.0, 0.45 + Math.random() * 0.3, 0.15);
  }
  for (const r of rings) {
    if (r.life <= 0) {
      r.life = 0.45; r.mesh.visible = true;
      r.mesh.position.set(x, 0.15, z);
      return;
    }
  }
}

export function fxSmoke(x, y, z, now) {
  smokeClouds.push({ x, y: y + 1, z, r: 3.1, until: now + 17 });
  let placed = 0;
  for (const p of puffData) {
    if (p.life <= 0) {
      p.life = p.max = 15 + Math.random() * 3;
      p.x = x + (Math.random() - 0.5) * 3.4;
      p.y = y + 0.8 + Math.random() * 1.6;
      p.z = z + (Math.random() - 0.5) * 3.4;
      p.s = 2.6 + Math.random() * 2.2;
      if (++placed >= 13) break;
    }
  }
}

export function fxFlashPop(x, y, z) {
  boomLight.position.set(x, y + 0.5, z);
  boomLight.intensity = 200;
  boomLight.color.setHex(0xffffff);
  setTimeout(() => boomLight.color.setHex(0xff8a3e), 90);
}

// Does a sight line pass through live smoke? Bots (and only bots -
// bullets fly straight through) cannot see across a smoke cloud.
export function smokeBlocks(x0, y0, z0, x1, y1, z1, now) {
  for (const c of smokeClouds) {
    if (now > c.until) continue;
    // distance from the cloud centre to the segment, in 3D
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    const len2 = dx * dx + dy * dy + dz * dz || 1;
    let t = ((c.x - x0) * dx + (c.y - y0) * dy + (c.z - z0) * dz) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = x0 + dx * t - c.x, py = y0 + dy * t - c.y, pz = z0 + dz * t - c.z;
    if (px * px + py * py + pz * pz < c.r * c.r) return true;
  }
  return false;
}

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _sv = new THREE.Vector3(1, 1, 1);
let camQuat = null;
export function setFxCamera(camera) { camQuat = camera.quaternion; }

export function updateEffects(dt, now) {
  // tracers fade out over their short life
  let anyTracer = false;
  for (let i = 0; i < TRACERS; i++) {
    if (tracerLife[i] > 0) {
      tracerLife[i] -= dt;
      anyTracer = true;
      if (tracerLife[i] <= 0) tracerCol.fill(0, i * 6, i * 6 + 6);
    }
  }
  if (anyTracer) tracerGeo.attributes.color.needsUpdate = true;
  // particles integrate
  for (let i = 0; i < PARTICLES; i++) {
    if (pLife[i] <= 0) continue;
    pLife[i] -= dt;
    if (pLife[i] <= 0) { pPos[i * 3 + 1] = -999; continue; }
    pVel[i * 3 + 1] -= pGrav[i] * dt;
    pPos[i * 3] += pVel[i * 3] * dt;
    pPos[i * 3 + 1] += pVel[i * 3 + 1] * dt;
    pPos[i * 3 + 2] += pVel[i * 3 + 2] * dt;
    if (pPos[i * 3 + 1] < 0.03) { pPos[i * 3 + 1] = 0.03; pVel[i * 3 + 1] = 0; }
  }
  pts.geometry.attributes.position.needsUpdate = true;
  // casings hop, land, rest, then shrink away
  casingData.forEach((c, i) => {
    if (c.life > 0) {
      c.life -= dt;
      if (c.y > 0.03 || c.vy > 0) {
        c.vy -= 6.5 * dt;
        c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt;
        if (c.y < 0.03) { c.y = 0.03; c.vy = 0; }
      }
    }
    const s = c.life > 0.25 || c.life <= 0 ? (c.life <= 0 ? 0.0001 : 1) : c.life / 0.25;
    _e.set(c.rx, 0, c.rz); _q.setFromEuler(_e);
    _v.set(c.x, c.y, c.z); _sv.set(s, s, s);
    _m4.compose(_v, _q, _sv);
    casingIM.setMatrixAt(i, _m4);
  });
  casingIM.instanceMatrix.needsUpdate = true;
  // smoke puffs billboard toward the camera and grow as they age
  puffData.forEach((p, i) => {
    if (p.life > 0) p.life -= dt;
    const age = 1 - Math.max(0, p.life) / p.max;
    const s = p.life <= 0 ? 0.0001 : p.s * (0.55 + age * 0.9);
    _v.set(p.x, p.y + age * 0.7, p.z);
    _sv.set(s, s, s);
    _m4.compose(_v, camQuat || _q.identity(), _sv);
    puffIM.setMatrixAt(i, _m4);
  });
  puffIM.instanceMatrix.needsUpdate = true;
  // prune dead smoke from the sight-line list
  for (let i = smokeClouds.length - 1; i >= 0; i--) {
    if (now > smokeClouds[i].until) smokeClouds.splice(i, 1);
  }
  // lights decay
  flashLight.intensity = Math.max(0, flashLight.intensity - dt * 340);
  boomLight.intensity = Math.max(0, boomLight.intensity - dt * 620);
  for (const r of rings) {
    if (r.life > 0) {
      r.life -= dt;
      const k = 1 - Math.max(0, r.life) / 0.45;
      r.mesh.scale.setScalar(1 + k * 9);
      r.mesh.material.opacity = 0.55 * (1 - k);
      if (r.life <= 0) r.mesh.visible = false;
    }
  }
}
