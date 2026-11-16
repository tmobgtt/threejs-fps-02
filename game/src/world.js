// world.js - the map "TIDELINE", Pier 9 freight terminal at dawn.
// One file owns the level: the collision boxes, the sites and spawns,
// the waypoint graph the bots walk, and every spatial query the rest of
// the game asks (movement collision, bullet raycasts, line of sight,
// pathfinding). The visuals are built from the same box list, so what
// you see is exactly what collides and exactly what blocks a bullet.
//
// Layout, three lanes west to east: the customs road (north) leads to
// the Coldstore, site A; the container rows (mid) split both ways; the
// quay road (south) leads to the crane dock, site B. A link corridor
// joins mid to A and a service tunnel joins mid to B, so rotations
// cross the map instead of backtracking.

import * as THREE from 'three';
import { PAL, mat, groundTexture } from './palette.js';

// A box: x0,z0..x1,z1 footprint, top at height h, a material key, and
// flags: thin (bullets punch through at reduced damage: wood, glass),
// decor (drawn, never collides - kept out of the collision list).
export const boxes = [];
function B(cx, cz, w, d, h, m, opts = {}) {
  const b = { x0: cx - w / 2, z0: cz - d / 2, x1: cx + w / 2, z1: cz + d / 2, h, m, thin: !!opts.thin };
  boxes.push(b);
  return b;
}

// ---- shell: perimeter and the two buildings --------------------------
B(0, -42.2, 120, 0.6, 6, 'concrete'); B(0, 42.2, 120, 0.6, 6, 'concrete');
B(-58.2, 0, 0.6, 85, 6, 'concrete'); B(58.2, 0, 0.6, 85, 6, 'concrete');
// Coldstore (site A): x 26..54, z -38..-10, doors west x2 and south x1
B(40, -38.2, 28.6, 0.5, 4.6, 'steel');            // north wall
B(54.2, -24, 0.5, 28.6, 4.6, 'steel');            // east wall
B(26, -34.5, 0.5, 7.6, 4.6, 'steel');             // west wall segments
B(26, -24, 0.5, 6.4, 4.6, 'steel');
B(26, -13.4, 0.5, 7, 4.6, 'steel');
B(33, -10, 14.4, 0.5, 4.6, 'steel');              // south wall segments
B(50, -10, 8.4, 0.5, 4.6, 'steel');
B(40, -26, 8, 8, 3.0, 'coldroom');                // the cold room block
B(31, -33, 5, 1.1, 1.1, 'steelDark');             // shelving rows
B(31, -18, 5, 1.1, 1.1, 'steelDark');
B(49, -33, 5, 1.1, 1.1, 'steelDark');
// Customs office (north lane): x -2..18, z -38..-27
B(8, -38.2, 20.6, 0.5, 4, 'concrete'); B(8, -26.8, 20.6, 0.5, 4, 'concrete');
B(-2.2, -32.5, 0.5, 11.4, 4, 'concrete'); B(18.2, -32.5, 0.5, 11.4, 4, 'concrete');
B(3, -32, 4.5, 1.2, 1.05, 'woodDark'); B(13, -32, 4.5, 1.2, 1.05, 'woodDark'); // desks
// Bait-and-tackle shop (south lane): x -6..10, z 26..38
B(2, 38.2, 16.6, 0.5, 3.6, 'woodDark'); B(2, 25.8, 16.6, 0.5, 3.6, 'woodDark');
B(-6.2, 32, 0.5, 12.4, 3.6, 'woodDark'); B(10.2, 32, 0.5, 12.4, 3.6, 'woodDark');
B(2, 32, 5, 1.4, 1.0, 'wood');                    // counter
// Link corridor walls (mid -> A) and service tunnel walls (mid -> B)
B(13.8, -17, 0.4, 12, 3.4, 'concrete'); B(20.2, -17, 0.4, 12, 3.4, 'concrete');
B(15.8, 19, 0.4, 12, 3.4, 'concrete'); B(22.2, 19, 0.4, 12, 3.4, 'concrete');

// ---- cover: containers, crates, barrels, dock gear --------------------
const containers = [
  // mid rows: three broken rows with staggered gaps
  [-2, -9, 6, 2.5, 'containerBlue'], [6, -9, 6, 2.5, 'containerRed'], [16, -10, 2.5, 6, 'containerGrey'],
  [-2, 3, 6, 2.5, 'containerGreen'], [8, 4, 2.5, 6, 'containerBlue'], [18, 2, 6, 2.5, 'containerRed'],
  [2, 13, 6, 2.5, 'containerGrey'], [14, 14, 2.5, 6, 'containerGreen'],
  // north road and A yard
  [-30, -33, 6, 2.5, 'containerGrey'], [-16, -25, 2.5, 6, 'containerBlue'], [22, -33, 6, 2.5, 'containerRed'],
  // south road and B dock
  [-28, 26, 6, 2.5, 'containerBlue'], [-14, 34, 2.5, 6, 'containerGreen'], [30, 18, 6, 2.5, 'containerRed'],
  [46, 15, 2.5, 6, 'containerGrey'], [33, 33, 6, 2.5, 'containerBlue'], [52, 27, 2.5, 6, 'containerGreen'],
  // spawns get a little cover too
  [-42, -14, 6, 2.5, 'containerGrey'], [48, -6, 2.5, 6, 'containerBlue'],
];
for (const [x, z, w, d, m] of containers) B(x, z, w, d, 2.6, m);
// stacked second-storey containers at B for the crane picture
B(33, 33, 6, 2.5, 5.2, 'containerRed'); B(46, 15, 2.5, 6, 5.2, 'containerGrey');

const crates = [
  [-46, -4], [-38, -28], [-24, -30], [-10, -20], [0, -14], [10, -18], [24, -20], [30, -14],
  [34, -30], [45, -20], [50, -34], [-8, -2], [12, -3], [20, 8], [-16, 12], [-4, 20],
  [24, 24], [30, 28], [42, 22], [50, 36], [-36, 28], [-22, 24], [-12, 30], [4, 24],
  [16, 30], [-48, 8], [50, 4], [36, -12], [-18, -34], [8, 34],
];
for (const [x, z] of crates) B(x, z, 1.25, 1.25, 1.2, 'wood', { thin: true });
// barrel clusters (drawn round, collide as small squares)
const barrels = [[-20, -12], [12, 8], [28, -20], [44, 30], [-32, 34], [6, -26], [38, 12], [-44, 16]];
for (const [x, z] of barrels) { B(x, z, 0.8, 0.8, 1.0, 'rust'); B(x + 0.85, z + 0.3, 0.8, 0.8, 1.0, 'rust'); }
// crane legs at B (the beam above is decor, out of the bullet's way)
B(38, 20, 1.2, 1.2, 9, 'steelDark'); B(52, 20, 1.2, 1.2, 9, 'steelDark');
B(38, 36, 1.2, 1.2, 9, 'steelDark'); B(52, 36, 1.2, 1.2, 9, 'steelDark');

export const SITES = {
  A: { x0: 35, z0: -33, x1: 49, z1: -17, cx: 42, cz: -25, name: 'COLDSTORE' },
  B: { x0: 37, z0: 21, x1: 51, z1: 35, cx: 44, cz: 28, name: 'CRANE DOCK' },
};
export function siteAt(x, z) {
  for (const k of ['A', 'B']) { const s = SITES[k]; if (x >= s.x0 && x <= s.x1 && z >= s.z0 && z <= s.z1) return k; }
  return null;
}

export const SPAWNS = {
  atk: [[-52, -10], [-52, -3], [-52, 4], [-49, -7], [-49, 1]],
  def: [[52, -8], [52, -1], [50, 5], [53, 3], [49, -4]],
};

// ---- waypoints ---------------------------------------------------------
// zone: rough area name; cover: a spot worth fighting from; hold: a spot
// a defender can watch a lane from; site: the site the node belongs to.
const N = (x, z, zone, o = {}) => ({ x, z, zone, cover: !!o.cover, hold: !!o.hold, site: o.site || null });
export const nodes = [
  N(-50, -2, 'atk'), N(-44, -8, 'atk', { cover: 1 }), N(-44, 5, 'atk', { cover: 1 }),
  N(-34, -29, 'roadN', { cover: 1 }), N(-20, -29, 'roadN'), N(-8, -30, 'roadN'), N(8, -30, 'roadN', { cover: 1 }), N(20, -28, 'roadN'),
  N(3, -33, 'office'), N(13, -33, 'office', { cover: 1 }),
  N(24, -26, 'aYard', { cover: 1 }), N(22, -29, 'aYard'), N(22, -19, 'aYard'),
  N(17, -20, 'link'), N(17, -13, 'link', { cover: 1 }),
  N(30, -29, 'A', { site: 'A' }), N(30, -19, 'A', { site: 'A' }), N(33, -24, 'A', { cover: 1, site: 'A' }),
  N(42, -25, 'A', { site: 'A' }), N(48, -30, 'A', { cover: 1, hold: 1, site: 'A' }), N(48, -15, 'A', { cover: 1, hold: 1, site: 'A' }),
  N(38, -13, 'A', { site: 'A' }), N(43, -6, 'aOut', { cover: 1 }),
  N(-14, -6, 'mid', { cover: 1 }), N(-14, 7, 'mid', { cover: 1 }), N(-4, -12, 'mid'), N(-4, 10, 'mid'),
  N(4, -3, 'mid', { cover: 1 }), N(7, 7, 'mid'), N(14, -6, 'mid'), N(15, 11, 'mid', { cover: 1 }), N(23, 0, 'mid', { cover: 1 }),
  N(19, 17, 'tunnel'), N(19, 23, 'tunnel', { cover: 1 }),
  N(-34, 30, 'roadS', { cover: 1 }), N(-20, 30, 'roadS'), N(-6, 30, 'roadS'), N(2, 32, 'shop'), N(9, 29, 'roadS', { cover: 1 }), N(20, 29, 'roadS'), N(27, 27, 'bYard'),
  N(32, 22, 'B', { cover: 1, site: 'B' }), N(40, 28, 'B', { site: 'B' }), N(44, 28, 'B', { site: 'B' }),
  N(47, 23, 'B', { cover: 1, hold: 1, site: 'B' }), N(48, 33, 'B', { cover: 1, hold: 1, site: 'B' }), N(35, 34, 'B', { site: 'B' }),
  N(50, 0, 'def'), N(47, -7, 'def', { cover: 1 }), N(47, 8, 'def', { cover: 1 }), N(44, 14, 'def'),
];
// Display names for the zones, used by bot radio callouts.
export const ZONE_NAMES = {
  atk: 'Ember Yard', roadN: 'Customs Road', office: 'Customs Office', aYard: 'A Yard',
  link: 'the Link', A: 'the Coldstore', aOut: 'A Yard', mid: 'Mid Containers',
  tunnel: 'the Service Tunnel', roadS: 'Quay Road', shop: 'the Bait Shop',
  bYard: 'B Yard', B: 'the Crane Dock', def: 'Harbor Yard',
};
export function nearestZoneName(x, z) {
  let best = null, bd = 1e9;
  for (const n of nodes) {
    const d = (n.x - x) ** 2 + (n.z - z) ** 2;
    if (d < bd) { bd = d; best = n; }
  }
  return best ? (ZONE_NAMES[best.zone] || best.zone) : 'the open';
}
export const edges = nodes.map(() => []);
function linkEdges() {
  // Edges join neighbours a walker can actually reach: nav clearance
  // (boxes shrunk by the body radius) out to 19 m, plus a stitch to
  // the nearest neighbour for any node that would otherwise strand.
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d < 19 && segClearNav(a.x, a.z, b.x, b.z)) { edges[i].push(j); edges[j].push(i); }
    }
  }
  for (let i = 0; i < nodes.length; i++) {
    if (edges[i].length >= 2) continue;
    let bj = -1, bd = 26;
    for (let j = 0; j < nodes.length; j++) {
      if (j === i) continue;
      const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].z - nodes[j].z);
      if (d < bd) { bd = d; bj = j; }
    }
    if (bj >= 0 && !edges[i].includes(bj)) { edges[i].push(bj); edges[bj].push(i); }
  }
}
linkEdges();
{
  // Keep only the largest connected component: a cover node tucked
  // behind its own box can end up with no edges at all, and a bot sent
  // to an unreachable node grinds the wall forever. Pruned nodes
  // simply stop being destinations; the lanes all stay connected.
  const comp = new Int32Array(nodes.length).fill(-1);
  let bestComp = 0, bestSize = 0, nComp = 0;
  for (let i = 0; i < nodes.length; i++) {
    if (comp[i] !== -1) continue;
    const stack = [i]; comp[i] = nComp; let size = 0;
    while (stack.length) {
      const u = stack.pop(); size++;
      for (const v of edges[u]) if (comp[v] === -1) { comp[v] = nComp; stack.push(v); }
    }
    if (size > bestSize) { bestSize = size; bestComp = nComp; }
    nComp++;
  }
  const kept = nodes.filter((_, i) => comp[i] === bestComp);
  nodes.splice(0, nodes.length, ...kept);
  edges.splice(0, edges.length, ...nodes.map(() => []));
  linkEdges();
}
function nearestNode(x, z) {
  let best = 0, bd = 1e9;
  for (let i = 0; i < nodes.length; i++) {
    const d = (nodes[i].x - x) ** 2 + (nodes[i].z - z) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}
// A* over the waypoint graph; returns world points, start excluded,
// the caller's exact target appended, with line-of-sight shortcuts.
export function findPath(fx, fz, tx, tz) {
  const s = nearestNode(fx, fz), t = nearestNode(tx, tz);
  const prev = new Int32Array(nodes.length).fill(-1);
  const cost = new Float32Array(nodes.length).fill(Infinity);
  const done = new Uint8Array(nodes.length);
  cost[s] = 0;
  for (;;) {
    let u = -1, uc = Infinity;
    for (let i = 0; i < nodes.length; i++) if (!done[i] && cost[i] < uc) { uc = cost[i]; u = i; }
    if (u < 0 || u === t) break;
    done[u] = 1;
    for (const v of edges[u]) {
      const c = cost[u] + Math.hypot(nodes[u].x - nodes[v].x, nodes[u].z - nodes[v].z);
      if (c < cost[v]) { cost[v] = c; prev[v] = u; }
    }
  }
  const chain = [];
  for (let u = t; u >= 0; u = prev[u]) chain.push(u);
  chain.reverse();
  if (chain[0] !== s) chain.length = 0;
  const pts = chain.map((i) => ({ x: nodes[i].x, z: nodes[i].z }));
  pts.push({ x: tx, z: tz });
  // string-pull: drop any point the previous kept point can walk to
  const out = [];
  let anchor = { x: fx, z: fz };
  for (let i = 0; i < pts.length; i++) {
    const last = i === pts.length - 1;
    if (last || !segClear(anchor.x, 1.2, anchor.z, pts[i + 1]?.x ?? pts[i].x, 1.2, pts[i + 1]?.z ?? pts[i].z)) {
      out.push(pts[i]); anchor = pts[i];
    }
  }
  return out;
}

// ---- spatial queries ---------------------------------------------------
const STEP = 0.55;
export function groundY(x, z, feetY) {
  let g = 0;
  for (const b of boxes) {
    if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && b.h <= feetY + STEP && b.h > g) g = b.h;
  }
  return g;
}
function blocksAt(b, feetY) { return b.h > feetY + STEP; }
// Circle vs boxes, resolved one axis at a time so walls slide.
export function collideAxis(pos, radius, axis) {
  for (const b of boxes) {
    if (!blocksAt(b, pos.y)) continue;
    const nx = Math.max(b.x0, Math.min(pos.x, b.x1));
    const nz = Math.max(b.z0, Math.min(pos.z, b.z1));
    const dx = pos.x - nx, dz = pos.z - nz;
    if (dx * dx + dz * dz < radius * radius) {
      if (axis === 'x') pos.x = pos.x < (b.x0 + b.x1) / 2 ? b.x0 - radius : b.x1 + radius;
      else pos.z = pos.z < (b.z0 + b.z1) / 2 ? b.z0 - radius : b.z1 + radius;
    }
  }
  pos.x = Math.max(-57.4, Math.min(57.4, pos.x));
  pos.z = Math.max(-41.4, Math.min(41.4, pos.z));
}
// Segment vs the box set (y is the segment's height at both ends is NOT
// assumed: full 3D slab test). Used for sight lines and walking checks.
export function segClear(x0, y0, z0, x1, y1, z1) {
  for (const b of boxes) {
    if (b.h < Math.min(y0, y1) - 0.01 && b.h < Math.max(y0, y1)) {
      // box top below the whole segment only when the segment stays above it
      if (Math.min(y0, y1) > b.h) continue;
    }
    if (segBox(x0, y0, z0, x1, y1, z1, b)) return false;
  }
  return true;
}
// Navigation clearance: like segClear at chest height, but boxes are
// shrunk by the walker's radius. The strict test severed the graph -
// a cover node hugging its own box could not link anywhere, because
// every segment out of it clipped the box it covers. A walker can
// graze corners the sight-line test must respect, so the graph gets
// the looser test and physics handles the rest.
function segClearNav(x0, z0, x1, z1) {
  for (const b of boxes) {
    if (b.h < 1.2) continue;
    const s = { x0: b.x0 + 0.45, x1: b.x1 - 0.45, z0: b.z0 + 0.45, z1: b.z1 - 0.45, h: b.h };
    if (s.x0 >= s.x1 || s.z0 >= s.z1) continue;
    if (segBox(x0, 1.2, z0, x1, 1.2, z1, s)) return false;
  }
  return true;
}
function segBox(x0, y0, z0, x1, y1, z1, b) {
  let t0 = 0, t1 = 1;
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const axes = [
    [x0, dx, b.x0, b.x1], [y0, dy, 0, b.h], [z0, dz, b.z0, b.z1],
  ];
  for (const [p, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-9) { if (p < lo || p > hi) return false; }
    else {
      let ta = (lo - p) / d, tb = (hi - p) / d;
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) return false;
    }
  }
  return true;
}
// Bullet raycast: nearest box or ground hit. Returns dist and the box
// (null for ground) so callers can apply material rules (thin = punch).
const _rh = { dist: 0, box: null, nx: 0, ny: 0, nz: 0 };
export function raycastWorld(ox, oy, oz, dx, dy, dz, maxDist) {
  let best = maxDist, hitBox = null, nx = 0, ny = 1, nz = 0;
  for (const b of boxes) {
    let tmin = 0, tmax = best;
    let axis = -1, sign = 0;
    const o = [ox, oy, oz], d = [dx, dy, dz];
    const lo = [b.x0, 0, b.z0], hi = [b.x1, b.h, b.z1];
    let ok = true;
    for (let a = 0; a < 3; a++) {
      if (Math.abs(d[a]) < 1e-9) { if (o[a] < lo[a] || o[a] > hi[a]) { ok = false; break; } }
      else {
        let ta = (lo[a] - o[a]) / d[a], tb = (hi[a] - o[a]) / d[a], s = -1;
        if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; s = 1; }
        if (ta > tmin) { tmin = ta; axis = a; sign = s; }
        tmax = Math.min(tmax, tb);
        if (tmin > tmax) { ok = false; break; }
      }
    }
    if (ok && tmin < best && tmin > 0.001) {
      best = tmin; hitBox = b;
      nx = axis === 0 ? sign : 0; ny = axis === 1 ? sign : 0; nz = axis === 2 ? sign : 0;
    }
  }
  if (dy < -1e-6) {
    const tg = -oy / dy;
    if (tg > 0.001 && tg < best) { best = tg; hitBox = null; nx = 0; ny = 1; nz = 0; }
  }
  _rh.dist = best; _rh.box = hitBox; _rh.nx = nx; _rh.ny = ny; _rh.nz = nz;
  return _rh;
}

// ---- visuals -----------------------------------------------------------
const MATKEY = {
  concrete: PAL.concrete, concreteDark: PAL.concreteDark, steel: PAL.steel, steelDark: PAL.steelDark,
  rust: PAL.rust, wood: PAL.wood, woodDark: PAL.woodDark, coldroom: PAL.coldroom,
  containerBlue: PAL.containerBlue, containerRed: PAL.containerRed, containerGreen: PAL.containerGreen,
  containerGrey: PAL.containerGrey,
};
export function buildWorld(scene) {
  scene.fog = new THREE.Fog(PAL.fog, 55, 165);
  // dawn dome: a big gradient sphere painted on a canvas
  const c = document.createElement('canvas'); c.width = 4; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#22384c'); grad.addColorStop(0.55, '#5d7484'); grad.addColorStop(0.8, '#c99a68'); grad.addColorStop(1, '#e8b07e');
  g.fillStyle = grad; g.fillRect(0, 0, 4, 256);
  const skyTex = new THREE.CanvasTexture(c);
  skyTex.colorSpace = THREE.SRGBColorSpace;
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(300, 24, 12),
    new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false }),
  );
  scene.add(sky);

  const hemi = new THREE.HemisphereLight(0xbcd0dd, 0x4c4438, 0.95);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffc890, 2.0);
  sun.position.set(-60, 42, -28);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -70; sun.shadow.camera.right = 70;
  sun.shadow.camera.top = 55; sun.shadow.camera.bottom = -55;
  sun.shadow.camera.far = 220;
  sun.shadow.bias = -0.0006;
  scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(120, 88),
    new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 0.96 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // one InstancedMesh per material: a few hundred boxes, a dozen draws
  const byMat = new Map();
  for (const b of boxes) {
    if (!byMat.has(b.m)) byMat.set(b.m, []);
    byMat.get(b.m).push(b);
  }
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const m4 = new THREE.Matrix4();
  for (const [key, list] of byMat) {
    const rough = key.startsWith('container') || key === 'steel' ? 0.55 : 0.9;
    const im = new THREE.InstancedMesh(unitBox, mat(MATKEY[key], rough, key === 'steel' ? 0.35 : 0.05), list.length);
    list.forEach((b, i) => {
      m4.makeScale(b.x1 - b.x0, b.h, b.z1 - b.z0);
      m4.setPosition((b.x0 + b.x1) / 2, b.h / 2, (b.z0 + b.z1) / 2);
      im.setMatrixAt(i, m4);
    });
    im.castShadow = true; im.receiveShadow = true;
    scene.add(im);
  }
  // barrels drawn round over their square collision
  const barrelGeo = new THREE.CylinderGeometry(0.34, 0.34, 1.0, 10);
  const barrelIM = new THREE.InstancedMesh(barrelGeo, mat(PAL.rust, 0.6, 0.3), barrels.length * 2);
  barrels.forEach(([x, z], i) => {
    m4.makeScale(1, 1, 1); m4.setPosition(x, 0.5, z); barrelIM.setMatrixAt(i * 2, m4);
    m4.setPosition(x + 0.85, 0.5, z + 0.3); barrelIM.setMatrixAt(i * 2 + 1, m4);
  });
  barrelIM.castShadow = true;
  scene.add(barrelIM);
  // crane beam and hook over site B (decor: above every bullet line)
  const beam = new THREE.Mesh(new THREE.BoxGeometry(17, 1.1, 1.4), mat(PAL.hazard, 0.6, 0.2));
  beam.position.set(45, 9.4, 28); beam.castShadow = true;
  scene.add(beam);
  const cable = new THREE.Mesh(new THREE.BoxGeometry(0.08, 4.4, 0.08), mat(PAL.kitDark, 0.7));
  cable.position.set(45, 7, 28);
  scene.add(cable);
  const hook = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 1.0), mat(PAL.hazard, 0.6, 0.2));
  hook.position.set(45, 4.7, 28);
  scene.add(hook);
  // lamp posts: emissive heads, three real lights where fights happen
  const lampGeo = new THREE.CylinderGeometry(0.09, 0.09, 4.6, 6);
  const lampHead = new THREE.SphereGeometry(0.22, 8, 6);
  const lampMat = new THREE.MeshStandardMaterial({ color: PAL.lampGlow, emissive: PAL.lampGlow, emissiveIntensity: 1.6 });
  const lampAt = [[-44, -26], [0, -30], [24, -6], [-20, 18], [10, 26], [42, -25], [44, 28], [-50, 2]];
  const lampIM = new THREE.InstancedMesh(lampGeo, mat(PAL.steelDark, 0.6, 0.4), lampAt.length);
  lampAt.forEach(([x, z], i) => {
    m4.makeScale(1, 1, 1); m4.setPosition(x, 2.3, z); lampIM.setMatrixAt(i, m4);
    const head = new THREE.Mesh(lampHead, lampMat);
    head.position.set(x, 4.7, z);
    scene.add(head);
  });
  scene.add(lampIM);
  for (const [x, z] of [[42, -25], [44, 28], [4, 0]]) {
    const pl = new THREE.PointLight(PAL.lampGlow, 60, 30, 1.8);
    pl.position.set(x, 5, z);
    scene.add(pl);
  }
  // roof beams over the buildings (decor only: they sit above every
  // sight line, so they are drawn but never collide) - they give the
  // coldstore and the office a roofed read from inside and out
  const beamMat = mat(PAL.steelDark, 0.6, 0.4);
  for (const z of [-37, -31, -25, -19, -12]) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(28.4, 0.28, 0.55), beamMat);
    beam.position.set(40, 4.75, z);
    beam.castShadow = true;
    scene.add(beam);
  }
  for (const x of [30, 36, 42, 48]) {
    const purlin = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.22, 28.4), beamMat);
    purlin.position.set(x, 4.95, -24);
    scene.add(purlin);
  }
  for (const z of [-36, -31, -27]) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(20.4, 0.24, 0.5), beamMat);
    beam.position.set(8, 4.15, z);
    scene.add(beam);
  }
  // hanging work lamps inside the coldstore, on short drops from the beams
  const dropMat = mat(PAL.kitDark, 0.7);
  for (const [x, z] of [[33, -25], [47, -25], [40, -31], [40, -19]]) {
    const drop = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.7, 0.06), dropMat);
    drop.position.set(x, 4.4, z);
    scene.add(drop);
    const head = new THREE.Mesh(lampHead, lampMat);
    head.position.set(x, 4.0, z);
    scene.add(head);
  }
}
