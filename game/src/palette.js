// palette.js - TIDELINE's art direction in one place.
// Pier 9 at dawn: cold harbour blue and fog grey against signal orange,
// with the two teams told apart by colour alone - Ember (attack) wears
// burnt orange, Harbor (defence) wears steel blue. Every material the
// world, characters and view models use comes from here, so the whole
// scene shares one set of colours and one roughness language.

import * as THREE from 'three';

export const PAL = {
  // environment
  sky: 0x2e4356,
  fog: 0x8fa3b0,
  dawn: 0xffb36b,
  ground: 0x4a4d4f,
  groundLine: 0xc8cdd0,
  concrete: 0x9aa0a2,
  concreteDark: 0x6d7276,
  steel: 0x5b7183,
  steelDark: 0x3c4c59,
  rust: 0x9c5a36,
  wood: 0x8a6a44,
  woodDark: 0x6b5133,
  containerBlue: 0x2f5d7a,
  containerRed: 0x8c3f31,
  containerGreen: 0x3f6b4f,
  containerGrey: 0x707880,
  coldroom: 0xb9c8cc,
  glass: 0xa8c4cc,
  hazard: 0xd8a722,
  lampGlow: 0xffd9a0,
  // teams
  atk: 0xd96c27,
  atkDark: 0x8f4517,
  def: 0x3f6f9f,
  defDark: 0x2a4c6e,
  skin: 0xc9a186,
  kitDark: 0x2c2f31,
  // effects and HUD accents
  tracerAtk: 0xffc37a,
  tracerDef: 0x9fd0ff,
  blood: 0x7a1f1f,
  smoke: 0xb9c0c2,
  flash: 0xffffff,
  he: 0xff7a2e,
};

// Materials are shared, never built per object: the world is a few
// hundred boxes but only a handful of distinct surfaces.
const cache = new Map();

export function mat(color, rough = 0.9, metal = 0.0) {
  const key = color + '|' + rough + '|' + metal;
  let m = cache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
    cache.set(key, m);
  }
  return m;
}

export function teamMat(team, dark = false) {
  if (team === 'atk') return mat(dark ? PAL.atkDark : PAL.atk, 0.75);
  return mat(dark ? PAL.defDark : PAL.def, 0.75);
}

// The ground is one big plane with a canvas texture painted by code:
// asphalt, lane paint, the quay edge and the two site letters. Painting
// it here keeps the map readable at a glance with no image assets.
export function groundTexture() {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 768;
  const g = c.getContext('2d');
  g.fillStyle = '#4a4d4f';
  g.fillRect(0, 0, 1024, 768);
  // asphalt noise
  for (let i = 0; i < 2600; i++) {
    const x = Math.random() * 1024, y = Math.random() * 768;
    g.fillStyle = Math.random() < 0.5 ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.05)';
    g.fillRect(x, y, 2, 2);
  }
  // world x -60..60 -> u 0..1024, z -44..44 -> v 0..768
  const px = (x) => ((x + 60) / 120) * 1024;
  const pz = (z) => ((z + 44) / 88) * 768;
  // painted lane lines on the two roads
  g.strokeStyle = 'rgba(216,167,34,0.55)';
  g.lineWidth = 3;
  g.setLineDash([18, 14]);
  g.beginPath(); g.moveTo(px(-56), pz(-30)); g.lineTo(px(26), pz(-30)); g.stroke();
  g.beginPath(); g.moveTo(px(-56), pz(30)); g.lineTo(px(28), pz(30)); g.stroke();
  g.setLineDash([]);
  // site letters, big and worn
  g.fillStyle = 'rgba(217,108,39,0.8)';
  g.font = 'bold 92px system-ui, sans-serif';
  g.textAlign = 'center';
  g.fillText('A', px(42), pz(-22));
  g.fillStyle = 'rgba(63,111,159,0.85)';
  g.fillText('B', px(44), pz(30));
  // plant zone rings
  g.strokeStyle = 'rgba(255,255,255,0.5)';
  g.lineWidth = 4;
  g.strokeRect(px(35), pz(-33), px(49) - px(35), pz(-17) - pz(-33));
  g.strokeRect(px(37), pz(21), px(51) - px(37), pz(35) - pz(21));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
