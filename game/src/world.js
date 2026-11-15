// world.js — the Switchyard: geometry, collision, routes and raycasts.
//
// An original dusk freight yard. Two bomb sites: A, an open crane yard in
// the north-west, and B, inside the warehouse in the south-east. Three
// lanes join them (Long A on the west edge, Mid through the centre, the
// east corridor to B), with a north and a south connector so rotations
// have choices. Every solid is an axis-aligned box: the same list drives
// the meshes, character collision, bullet raycasts and bot line of sight,
// so what you see is exactly what blocks you.

import * as THREE from "three";
import { INK, mat, emissiveMat } from "./palette.js";

const unitBox = new THREE.BoxGeometry(1, 1, 1);

// A solid box: x,z centre, w,d footprint, h height, sitting on y=0.
function solid(list, x, z, w, d, h, material) {
  const c = { x0: x - w / 2, x1: x + w / 2, z0: z - d / 2, z1: z + d / 2, top: h };
  list.push(c);
  return { c, material };
}

function addMesh(scene, s, yBase = 0) {
  const { c, material } = s;
  const m = new THREE.Mesh(unitBox, material);
  m.scale.set(c.x1 - c.x0, c.top - yBase, c.z1 - c.z0);
  m.position.set((c.x0 + c.x1) / 2, yBase + (c.top - yBase) / 2, (c.z0 + c.z1) / 2);
  m.castShadow = true;
  m.receiveShadow = true;
  scene.add(m);
  return m;
}

// Painted ground: asphalt, rail lines, lane arrows and the two site
// circles, drawn once onto a canvas so the yard ships no image files.
function groundTexture() {
  const cv = document.createElement("canvas");
  cv.width = 1024;
  cv.height = 768;
  const g = cv.getContext("2d");
  const px = (x) => ((x + 38) / 76) * 1024;
  const pz = (z) => ((z + 28) / 56) * 768;
  g.fillStyle = "#5a534a";
  g.fillRect(0, 0, 1024, 768);
  for (let i = 0; i < 9000; i++) {
    g.fillStyle = `rgba(${30 + Math.random() * 40},${28 + Math.random() * 34},${24 + Math.random() * 26},0.25)`;
    g.fillRect(Math.random() * 1024, Math.random() * 768, 2, 2);
  }
  // concrete aprons under the sites and spawns
  g.fillStyle = "rgba(140,138,128,0.5)";
  g.fillRect(px(-30), pz(-24), px(-6) - px(-30), pz(-4) - pz(-24));
  g.fillRect(px(10), pz(4), px(34) - px(10), pz(24) - pz(4));
  // rail tracks: two steel lines and sleepers, running east-west
  for (const zLine of [-19.5, 21]) {
    g.fillStyle = "#3c3f36";
    g.fillRect(0, pz(zLine) - 14, 1024, 28);
    g.fillStyle = "#2e2c28";
    for (let x = 0; x < 1024; x += 18) g.fillRect(x, pz(zLine) - 13, 9, 26);
    g.fillStyle = "#8f97a3";
    g.fillRect(0, pz(zLine) - 9, 1024, 3);
    g.fillRect(0, pz(zLine) + 6, 1024, 3);
  }
  // lane paint
  g.strokeStyle = "rgba(216,178,90,0.75)";
  g.lineWidth = 4;
  g.setLineDash([22, 16]);
  g.beginPath(); g.moveTo(px(-30), pz(0)); g.lineTo(px(32), pz(0)); g.stroke();
  g.beginPath(); g.moveTo(px(-28), pz(20)); g.lineTo(px(-28), pz(-18)); g.stroke();
  g.setLineDash([]);
  // site circles and letters
  for (const [sx, sz, letter] of [[-20, -14, "A"], [21, 13, "B"]]) {
    g.strokeStyle = "#d8b25a";
    g.lineWidth = 6;
    g.beginPath(); g.arc(px(sx), pz(sz), 78, 0, Math.PI * 2); g.stroke();
    g.fillStyle = "rgba(216,178,90,0.9)";
    g.font = "bold 92px monospace";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(letter, px(sx), pz(sz) + 4);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function buildWorld(scene) {
  const solids = [];
  const S = (x, z, w, d, h, material) => addMesh(scene, solid(solids, x, z, w, d, h, material));

  // --- ground, skyline, light rigs (visual only) -------------------------
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(76, 56),
    new THREE.MeshLambertMaterial({ map: groundTexture() })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const skylineMat = mat(0x232830);
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + 0.22;
    const dist = 95 + (i % 4) * 22;
    const h = 14 + ((i * 37) % 23);
    const m = new THREE.Mesh(unitBox, skylineMat);
    m.scale.set(16 + (i % 3) * 9, h, 12);
    m.position.set(Math.cos(a) * dist, h / 2 - 1, Math.sin(a) * dist * 0.8);
    scene.add(m);
  }
  // sodium lamp poles at the sites and mid (emissive heads, real lights)
  const lampHeads = [];
  for (const [lx, lz] of [[-20, -19], [21, 7.5], [0, -3], [-30, 12]]) {
    const pole = new THREE.Mesh(unitBox, mat(INK.darkMetal));
    pole.scale.set(0.22, 5.4, 0.22);
    pole.position.set(lx, 2.7, lz);
    scene.add(pole);
    const head = new THREE.Mesh(unitBox, emissiveMat(INK.lamp));
    head.scale.set(0.7, 0.18, 0.4);
    head.position.set(lx, 5.45, lz);
    scene.add(head);
    lampHeads.push([lx, lz]);
  }

  // --- perimeter ---------------------------------------------------------
  const wallM = mat(INK.concreteDark);
  S(0, -27, 76, 2, 4.4, wallM);
  S(0, 27, 76, 2, 4.4, wallM);
  S(-37, 0, 2, 56, 4.4, wallM);
  S(37, 0, 2, 56, 4.4, wallM);

  // --- site A: crane yard -------------------------------------------------
  const contA = mat(INK.containerA), contB = mat(INK.containerB), contC = mat(INK.containerC);
  S(-27, -20, 7.6, 2.5, 2.5, contA);
  solids[solids.length - 1].top = 5.0; // a second container stacked on top
  const stackTop = new THREE.Mesh(unitBox, contB);
  stackTop.scale.set(7.6, 2.5, 2.5);
  stackTop.position.set(-27, 3.75, -20);
  stackTop.castShadow = true;
  scene.add(stackTop);
  S(-13, -20, 7.6, 2.5, 2.5, contC);
  S(-12, -8, 2.5, 7.6, 2.5, contA);
  S(-24, -6, 2.5, 5.4, 2.5, contB);
  // crane legs (the jib above is visual, high enough to never block play)
  const craneM = mat(INK.darkMetal);
  S(-21.5, -17.5, 0.6, 0.6, 7, craneM);
  S(-18.5, -17.5, 0.6, 0.6, 7, craneM);
  S(-21.5, -10.5, 0.6, 0.6, 7, craneM);
  S(-18.5, -10.5, 0.6, 0.6, 7, craneM);
  const jib = new THREE.Mesh(unitBox, craneM);
  jib.scale.set(1.1, 0.8, 12.5);
  jib.position.set(-20, 7.4, -14);
  scene.add(jib);
  const hanging = new THREE.Mesh(unitBox, contC);
  hanging.scale.set(6.4, 2.5, 2.4);
  hanging.position.set(-20, 4.6, -11);
  hanging.castShadow = true;
  scene.add(hanging);

  // --- mid ----------------------------------------------------------------
  const crateM = mat(INK.crate), crateAltM = mat(INK.crateAlt);
  S(-4, -2.2, 6.4, 1.1, 1.15, mat(INK.concrete)); // mid low wall, south lip
  S(5, -2.2, 6.4, 1.1, 1.15, mat(INK.concrete));
  S(0.5, -2.2, 1.1, 1.1, 2.5, mat(INK.concreteDark)); // mid doors pillar
  S(-9, 3.4, 2.3, 2.3, 1.15, crateM);
  solids[solids.length - 1].top = 2.3; // a second crate stacked on top
  const crateTop = new THREE.Mesh(unitBox, crateM);
  crateTop.scale.set(2.3, 1.15, 2.3);
  crateTop.position.set(-9, 1.15 + 0.575, 3.4);
  crateTop.castShadow = true;
  scene.add(crateTop);
  S(10, 3.6, 2.3, 2.3, 1.15, crateAltM);
  S(2, 5.5, 3.4, 1.6, 1.15, crateM);
  S(-16, -3, 2.3, 2.3, 2.3, crateAltM);
  S(16, -4, 2.3, 4.6, 2.5, contB);
  S(-2, -8, 5.6, 2.5, 2.5, contA);

  // --- north connector and defender side ----------------------------------
  S(2, -18, 7.6, 2.5, 2.5, contC);
  S(12, -20, 2.5, 5.4, 2.5, contA);
  S(24, -10, 2.3, 2.3, 2.3, crateM);
  S(30, -6, 4.6, 2.3, 1.15, crateAltM);

  // --- south lanes ----------------------------------------------------------
  S(-18, 16, 5.6, 2.5, 2.5, contB);
  S(-4, 18, 2.3, 2.3, 1.15, crateM);
  S(6, 12, 2.3, 4.6, 2.3, crateAltM);

  // --- warehouse (site B): walls with door gaps -----------------------------
  const whM = mat(INK.concrete), whTrim = mat(INK.wallTrim);
  // north wall z=6, door at x 19.6..22.4
  S(15.8, 6, 7.6, 0.8, 4.4, whM);
  S(26.2, 6, 7.6, 0.8, 4.4, whM);
  // south wall z=22, door at x 24..27
  S(18, 22, 12, 0.8, 4.4, whM);
  S(28.5, 22, 3, 0.8, 4.4, whM);
  // west wall x=12, door at z 12..15
  S(12, 9, 0.8, 6, 4.4, whM);
  S(12, 18.5, 0.8, 7, 4.4, whM);
  // east wall x=30, door at z 11.6..14.4
  S(30, 8.8, 0.8, 5.6, 4.4, whM);
  S(30, 18.2, 0.8, 7.6, 4.4, whM);
  // interior cover
  S(17, 16, 2.3, 2.3, 2.3, crateM);
  S(25, 17.5, 3.4, 1.6, 1.15, crateAltM);
  S(21, 10, 1.6, 3.4, 1.15, crateM);
  // roof beams (visual only, above head height)
  for (const bx of [15, 21, 27]) {
    const beam = new THREE.Mesh(unitBox, whTrim);
    beam.scale.set(0.5, 0.5, 16.8);
    beam.position.set(bx, 4.6, 14);
    scene.add(beam);
  }

  // scattered barrels (cylinders read as boxes to physics)
  const barrelM = mat(0x74552e);
  const barrelGeo = new THREE.CylinderGeometry(0.42, 0.42, 1.05, 10);
  for (const [bx, bz] of [[-15.5, -18.5], [7.5, -5.5], [26, -16], [-24, 5], [18.5, 3]]) {
    const b = new THREE.Mesh(barrelGeo, barrelM);
    b.position.set(bx, 0.53, bz);
    b.castShadow = true;
    scene.add(b);
    solids.push({ x0: bx - 0.42, x1: bx + 0.42, z0: bz - 0.42, z1: bz + 0.42, top: 1.05 });
  }

  // --- sites, spawns, waypoints ---------------------------------------------
  const sites = {
    A: { id: "A", x: -20, z: -14, r: 6.5 },
    B: { id: "B", x: 21, z: 13, r: 6.5 },
  };
  const spawns = {
    atk: [
      { x: -30, z: 20, yaw: -1.0 }, { x: -27, z: 21.5, yaw: -1.1 },
      { x: -25, z: 18, yaw: -0.85 }, { x: -30.5, z: 16.5, yaw: -0.95 },
    ],
    def: [
      { x: 30, z: -20, yaw: 2.14 }, { x: 27, z: -21.5, yaw: 2.25 },
      { x: 25, z: -18, yaw: 2.0 }, { x: 30.5, z: -16.5, yaw: 2.2 },
    ],
  };

  const nodes = [
    [-28, 18], [-28, 8], [-28, -4], [-26, -12], [-20, -14], [-14, -16],
    [-18, 2], [-8, 0], [0, 0], [8, 0], [14, 2], [8, 10],
    [21, 13], [32, 13], [30, -2], [30, -14], [28, -18],
    [16, -14], [6, -12], [-6, -12], [-14, -8], [21, 2], [21, 9],
    [-2, 12], [-16, 12], [10, 14], [-24, -20], [14, -18], [27, 15],
    [16, 18], [14, 13],
  ].map(([x, z]) => ({ x, z }));
  const edgePairs = [
    [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [4, 26], [5, 27], [27, 17],
    [17, 16], [16, 15], [15, 14], [14, 13], [13, 28], [28, 12], [12, 29],
    [29, 30], [30, 12], [30, 11], [11, 10], [10, 9], [9, 8], [8, 7],
    [7, 6], [6, 2], [6, 20], [20, 19], [19, 18], [18, 17], [19, 5],
    [8, 18], [9, 17], [10, 21], [21, 22], [22, 12], [21, 14],
    [0, 24], [24, 23], [23, 25], [25, 11], [24, 6], [23, 6], [1, 24],
    [3, 26], [14, 15],
  ];
  const edges = nodes.map(() => []);
  for (const [a, b] of edgePairs) {
    edges[a].push(b);
    edges[b].push(a);
  }

  return { solids, sites, spawns, nodes, edges, lampHeads };
}

// Highest standable top under a point, for things already near that height.
export function groundHeightAt(W, x, z, feetY) {
  let g = 0;
  for (const c of W.solids) {
    if (x >= c.x0 && x <= c.x1 && z >= c.z0 && z <= c.z1 && c.top <= feetY + 0.55 && c.top > g) {
      g = c.top;
    }
  }
  return g;
}

// Push a character (feet position, radius) out of every solid it cannot
// stand on. Mutates pos; returns true when a push happened.
const STEP = 0.55;
export function collide(W, pos, radius, height) {
  let pushed = false;
  for (const c of W.solids) {
    if (c.top <= pos.y + STEP) continue; // standable: not a wall for us
    if (pos.y + height <= 0.2) continue;
    const nx = Math.max(c.x0, Math.min(pos.x, c.x1));
    const nz = Math.max(c.z0, Math.min(pos.z, c.z1));
    const dx = pos.x - nx, dz = pos.z - nz;
    const d2 = dx * dx + dz * dz;
    if (d2 > radius * radius) continue;
    if (d2 > 1e-9) {
      const d = Math.sqrt(d2);
      pos.x = nx + (dx / d) * radius;
      pos.z = nz + (dz / d) * radius;
    } else {
      // centre inside the box: leave by the shallowest face
      const pl = pos.x - c.x0, pr = c.x1 - pos.x, pn = pos.z - c.z0, pf = c.z1 - pos.z;
      const m = Math.min(pl, pr, pn, pf);
      if (m === pl) pos.x = c.x0 - radius;
      else if (m === pr) pos.x = c.x1 + radius;
      else if (m === pn) pos.z = c.z0 - radius;
      else pos.z = c.z1 + radius;
    }
    pushed = true;
  }
  return pushed;
}

// Ray vs the world (solids + ground plane). Fills `out` {dist, nx,ny,nz}
// and returns true on a hit within maxDist. No allocation.
export function raycastWorld(W, ox, oy, oz, dx, dy, dz, maxDist, out) {
  let best = maxDist;
  let nx = 0, ny = 1, nz = 0;
  if (dy < -1e-8) {
    const t = -oy / dy;
    if (t > 0 && t < best) { best = t; nx = 0; ny = 1; nz = 0; }
  }
  for (const c of W.solids) {
    let t0 = 0, t1 = best;
    let ax = -1;
    // X slab
    if (Math.abs(dx) < 1e-9) { if (ox < c.x0 || ox > c.x1) continue; }
    else {
      let ta = (c.x0 - ox) / dx, tb = (c.x1 - ox) / dx;
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      if (ta > t0) { t0 = ta; ax = 0; }
      if (tb < t1) t1 = tb;
      if (t0 > t1) continue;
    }
    // Y slab (solids stand on y=0)
    if (Math.abs(dy) < 1e-9) { if (oy < 0 || oy > c.top) continue; }
    else {
      let ta = (0 - oy) / dy, tb = (c.top - oy) / dy;
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      if (ta > t0) { t0 = ta; ax = 1; }
      if (tb < t1) t1 = tb;
      if (t0 > t1) continue;
    }
    // Z slab
    if (Math.abs(dz) < 1e-9) { if (oz < c.z0 || oz > c.z1) continue; }
    else {
      let ta = (c.z0 - oz) / dz, tb = (c.z1 - oz) / dz;
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      if (ta > t0) { t0 = ta; ax = 2; }
      if (tb < t1) t1 = tb;
      if (t0 > t1) continue;
    }
    if (t0 <= 0 || t0 >= best) continue;
    best = t0;
    nx = ax === 0 ? (dx > 0 ? -1 : 1) : 0;
    ny = ax === 1 ? (dy > 0 ? -1 : 1) : 0;
    nz = ax === 2 ? (dz > 0 ? -1 : 1) : 0;
  }
  if (best >= maxDist) return false;
  out.dist = best;
  out.nx = nx; out.ny = ny; out.nz = nz;
  return true;
}

// Line of sight between two points: false when a solid or a smoke sphere
// blocks the segment.
export function hasLOS(W, ax, ay, az, bx, by, bz, smokes) {
  let dx = bx - ax, dy = by - ay, dz = bz - az;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-6) return true;
  dx /= len; dy /= len; dz /= len;
  const hit = _losHit;
  if (raycastWorld(W, ax, ay, az, dx, dy, dz, len, hit)) return false;
  if (smokes) {
    for (const s of smokes) {
      // distance from the segment to the smoke centre
      const vx = s.x - ax, vy = s.y - ay, vz = s.z - az;
      const t = Math.max(0, Math.min(len, vx * dx + vy * dy + vz * dz));
      const ex = ax + dx * t - s.x, ey = ay + dy * t - s.y, ez = az + dz * t - s.z;
      if (ex * ex + ey * ey + ez * ez < s.r * s.r) return false;
    }
  }
  return true;
}
const _losHit = { dist: 0, nx: 0, ny: 0, nz: 0 };

// Breadth-first route over the waypoint graph. Returns node indices.
export function findPath(W, fromIdx, toIdx, out) {
  out.length = 0;
  if (fromIdx === toIdx) { out.push(fromIdx); return out; }
  const prev = _prev;
  prev.fill(-1);
  const queue = _queue;
  let qHead = 0, qTail = 0;
  queue[qTail++] = fromIdx;
  prev[fromIdx] = fromIdx;
  while (qHead < qTail) {
    const cur = queue[qHead++];
    if (cur === toIdx) break;
    for (const nb of W.edges[cur]) {
      if (prev[nb] === -1) {
        prev[nb] = cur;
        queue[qTail++] = nb;
      }
    }
  }
  if (prev[toIdx] === -1) return out;
  let cur = toIdx;
  const stack = [];
  while (cur !== fromIdx) {
    stack.push(cur);
    cur = prev[cur];
  }
  stack.push(fromIdx);
  for (let i = stack.length - 1; i >= 0; i--) out.push(stack[i]);
  return out;
}
const _prev = new Int16Array(64);
const _queue = new Int16Array(64);

export function nearestNode(W, x, z) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < W.nodes.length; i++) {
    const dx = W.nodes[i].x - x, dz = W.nodes[i].z - z;
    const d = dx * dx + dz * dz;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

export function inSite(site, x, z) {
  const dx = x - site.x, dz = z - site.z;
  return dx * dx + dz * dz <= site.r * site.r;
}
