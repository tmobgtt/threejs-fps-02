// palette.js — the yard's colours and shared materials in one place.
//
// Dusk freight yard: warm sodium light on cool concrete. The Vultures wear
// amber, the Wardens wear teal, and everything else stays desaturated so
// players and sites read at a glance. Materials are cached by key so the
// whole map shares a handful of programs.

import * as THREE from "three";

export const TEAMS = {
  atk: { id: "atk", name: "VULTURES", color: 0xf2a33c, dark: 0x8a5a1d, light: 0xffcf87 },
  def: { id: "def", name: "WARDENS", color: 0x3fb7ac, dark: 0x1f6f68, light: 0x9fe8df },
};

export const BOT_NAMES = {
  atk: ["YOU", "MARLOWE", "IBARRA", "KESSEL"],
  def: ["VANE", "OKONKWO", "PETROV", "LINDQVIST"],
};

export const INK = {
  sky: 0x2b3444,
  fog: 0x353d49,
  ground: 0x565049,
  groundDark: 0x453f38,
  concrete: 0x7d7f7c,
  concreteDark: 0x5b5d5c,
  crate: 0x8a6b42,
  crateAlt: 0x6e7b4f,
  containerA: 0x9c4a2f,
  containerB: 0x2f5d8a,
  containerC: 0x707a3a,
  wallTrim: 0xd8b25a,
  sitePaint: 0xd8b25a,
  metal: 0x494f57,
  darkMetal: 0x2e3238,
  lamp: 0xffc37a,
  railSteel: 0x3a3f45,
  white: 0xe8e2d4,
};

const cache = new Map();

// One Lambert material per (colour, flat) pair, reused by every mesh.
export function mat(color, flat = false) {
  const key = color * 2 + (flat ? 1 : 0);
  let m = cache.get(key);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color });
    if (flat) m.flatShading = true;
    cache.set(key, m);
  }
  return m;
}

export function emissiveMat(color, intensity = 1) {
  const key = `e${color}`;
  let m = cache.get(key);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color });
    m.userData.intensity = intensity;
    cache.set(key, m);
  }
  return m;
}
