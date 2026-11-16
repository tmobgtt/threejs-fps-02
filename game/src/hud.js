// hud.js - everything the player reads: vitals, ammunition, money,
// the round clock and score, alive pips, killfeed, radio callouts, the
// buy menu, the scoreboard, banners, the plant/defuse progress bar,
// damage direction, flash and hurt overlays, and the radar.
//
// The radar is a live canvas: the map's boxes are painted once to an
// offscreen canvas, then each frame blits that and plots teammates,
// the bomb, and any enemy the team's intel has seen in the last three
// seconds. What the radar shows is exactly what the team knows.

import { G, TEAM_NAMES, aliveOf } from './state.js';
import { WEAPONS, NADES, SHOP, currentItem, currentDef, heldNade, spreadNow } from './weapon.js';
import { boxes, SITES } from './world.js';

const $ = (id) => document.getElementById(id);
const els = {};
let buyOpen = false;
let boardOpen = false;
let bannerUntil = 0;
let hitT = 0;
let dmgDirT = 0, dmgDirAngle = 0;
let kfRendered = 0, coRendered = 0;
let radarBase = null;
let onBuy = null;

export function initHUD(buyHandler) {
  onBuy = buyHandler;
  for (const id of ['hud', 'crosshair', 'hitmarker', 'radar', 'plan', 'score-atk', 'score-def', 'name-atk', 'name-def',
    'clock', 'roundlabel', 'pips', 'killfeed', 'callouts', 'hpfill', 'hptext', 'armorfill', 'armortext', 'kitind',
    'money', 'wepname', 'ammo', 'mag', 'reserve', 'slots', 'bombind', 'banner', 'banner-main', 'banner-sub',
    'progress', 'progress-label', 'progress-fill', 'spectate', 'dmgdir', 'buymenu', 'buy-money', 'buygrid',
    'scoreboard', 'sb-cols', 'flashfx', 'hurtfx', 'scopefx']) els[id] = $(id);
  buildBuyGrid();
  buildRadarBase();
}

function buildBuyGrid() {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', ''];
  els.buygrid.innerHTML = '';
  SHOP.forEach((row, i) => {
    const d = document.createElement('div');
    d.className = 'buyitem';
    d.dataset.key = row.key;
    d.innerHTML = `<span><span class="k">${keys[i] || '•'}</span>${row.label}</span><span class="p">$${row.price}</span>`;
    d.addEventListener('click', () => { if (onBuy) onBuy(row.key); });
    els.buygrid.appendChild(d);
  });
}

function buildRadarBase() {
  radarBase = document.createElement('canvas');
  radarBase.width = 176; radarBase.height = 138;
  const g = radarBase.getContext('2d');
  g.fillStyle = '#0d141b';
  g.fillRect(0, 0, 176, 138);
  const px = (x) => ((x + 60) / 120) * 176;
  const pz = (z) => ((z + 44) / 88) * 138;
  g.fillStyle = 'rgba(217,108,39,0.16)';
  g.fillRect(px(SITES.A.x0), pz(SITES.A.z0), px(SITES.A.x1) - px(SITES.A.x0), pz(SITES.A.z1) - pz(SITES.A.z0));
  g.fillStyle = 'rgba(63,111,159,0.2)';
  g.fillRect(px(SITES.B.x0), pz(SITES.B.z0), px(SITES.B.x1) - px(SITES.B.x0), pz(SITES.B.z1) - pz(SITES.B.z0));
  g.fillStyle = '#46525a';
  for (const b of boxes) {
    if (b.h < 1) continue;
    g.fillRect(px(b.x0), pz(b.z0), Math.max(1.5, px(b.x1) - px(b.x0)), Math.max(1.5, pz(b.z1) - pz(b.z0)));
  }
  g.fillStyle = '#e8ecee';
  g.font = 'bold 11px system-ui';
  g.fillText('A', px(40), pz(-22));
  g.fillText('B', px(42), pz(31));
}

export function showBanner(main, sub, seconds = 2.6) {
  els['banner-main'].textContent = main;
  els['banner-sub'].textContent = sub || '';
  els.banner.classList.remove('hidden');
  bannerUntil = performance.now() / 1000 + seconds;
}
export function showHitmarker(head, kill) {
  els.hitmarker.className = kill ? 'kill pop' : 'pop';
  if (head) els.hitmarker.style.filter = 'brightness(1.5)';
  hitT = 0.24;
  // restart the CSS animation
  els.hitmarker.style.animation = 'none';
  void els.hitmarker.offsetWidth;
  els.hitmarker.style.animation = '';
}
export function damageFrom(worldAngle, playerYaw) {
  dmgDirAngle = worldAngle - playerYaw;
  dmgDirT = 0.9;
}
export function setBuyOpen(open) {
  buyOpen = open;
  els.buymenu.classList.toggle('hidden', !open);
  if (open) refreshBuy();
}
export function isBuyOpen() { return buyOpen; }
export function setBoardOpen(open) {
  boardOpen = open;
  els.scoreboard.classList.toggle('hidden', !open);
  if (open) renderBoard();
}
export function isBoardOpen() { return boardOpen; }

function refreshBuy() {
  const p = G.player;
  if (!p) return;
  els['buy-money'].textContent = '$' + p.money;
  for (const d of els.buygrid.children) {
    const row = SHOP.find((r) => r.key === d.dataset.key);
    let owned = false;
    if (row.kind === 'weapon') {
      const def = WEAPONS[row.key];
      owned = !!(def.slot === 'primary' ? p.inv.primary && p.inv.primary.key === row.key
        : p.inv.secondary && p.inv.secondary.key === row.key);
    } else if (row.key === 'armor') owned = p.armor >= 100;
    else if (row.key === 'helmet') owned = p.armor >= 100 && p.helmet;
    else if (row.key === 'kit') owned = p.hasKit;
    else if (row.kind === 'nade') owned = p.inv[row.key] >= 2;
    d.classList.toggle('owned', owned);
    d.classList.toggle('cant', !owned && p.money < row.price);
  }
}

function renderBoard() {
  const rows = (team) => G.actors.filter((a) => a.team === team)
    .sort((x, y) => y.kills - x.kills)
    .map((a) => `<tr class="${a.alive ? '' : 'dead'} ${a.isPlayer ? 'me' : ''}"><td>${a.name}${a.isPlayer ? ' (you)' : ''}</td><td class="n">${a.kills}</td><td class="n">${a.deaths}</td><td class="n">${a.alive ? Math.ceil(a.hp) : '-'}</td><td class="n">$${a.money}</td></tr>`)
    .join('');
  const squadOf = (side) => ((side === 'atk') !== G.swapped ? TEAM_NAMES.atk : TEAM_NAMES.def);
  els['sb-cols'].innerHTML = `<table>
    <tr class="teamhead atk"><td>ATTACK - ${squadOf('atk')} (${G.score.atk})</td><td class="n">K</td><td class="n">D</td><td class="n">HP</td><td class="n">$</td></tr>
    ${rows('atk')}
    <tr class="teamhead def"><td>DEFENCE - ${squadOf('def')} (${G.score.def})</td><td class="n">K</td><td class="n">D</td><td class="n">HP</td><td class="n">$</td></tr>
    ${rows('def')}</table>`;
}

function fmtClock(sec) {
  sec = Math.max(0, Math.ceil(sec));
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}

function drawRadar(p) {
  const cv = els.radar;
  const g = cv.getContext('2d');
  g.drawImage(radarBase, 0, 0);
  const px = (x) => ((x + 60) / 120) * 176;
  const pz = (z) => ((z + 44) / 88) * 138;
  // fresh enemy intel shows as fading red dots: the radar knows only
  // what the team has actually seen
  g.fillStyle = 'rgba(255,90,60,0.85)';
  for (const s of G.intel[p.team].values()) {
    if (G.time - s.t < 3 && s.id > 0) { g.beginPath(); g.arc(px(s.x), pz(s.z), 2.6, 0, 7); g.fill(); }
  }
  for (const a of G.actors) {
    if (!a.alive || a.team !== p.team || a.isPlayer) continue;
    g.fillStyle = p.team === 'atk' ? '#f0a35e' : '#8ab6dd';
    g.beginPath(); g.arc(px(a.pos.x), pz(a.pos.z), 2.6, 0, 7); g.fill();
  }
  // the bomb: carried by a teammate, dropped, or planted
  const b = G.bomb;
  let bx = null, bz = null;
  if (b.planted && b.pos) { bx = b.pos.x; bz = b.pos.z; }
  else if (b.droppedAt) { bx = b.droppedAt.x; bz = b.droppedAt.z; }
  else if (b.carrier && b.carrier.team === p.team) { bx = b.carrier.pos.x; bz = b.carrier.pos.z; }
  if (bx !== null) {
    g.fillStyle = '#ffd94d';
    g.fillRect(px(bx) - 2.5, pz(bz) - 2.5, 5, 5);
  }
  // the player: a white wedge pointing the way they face
  g.save();
  g.translate(px(p.pos.x), pz(p.pos.z));
  g.rotate(Math.atan2(-Math.sin(p.yaw), -Math.cos(p.yaw)) + Math.PI / 2);
  g.fillStyle = '#ffffff';
  g.beginPath(); g.moveTo(0, -5); g.lineTo(3.4, 4); g.lineTo(-3.4, 4); g.closePath(); g.fill();
  g.restore();
}

// Called every rendered frame by main.js.
export function updateHUD(dt, view) {
  const p = G.player;
  if (!p) return;
  const now = performance.now() / 1000;
  // vitals
  els.hpfill.style.transform = `scaleX(${Math.max(0, p.hp / 100)})`;
  els.hptext.textContent = Math.ceil(p.hp) + (p.alive ? '' : ' - DOWN');
  els.armorfill.style.transform = `scaleX(${Math.max(0, p.armor / 100)})`;
  els.armortext.textContent = p.armor > 0 ? Math.ceil(p.armor) + (p.helmet ? ' + HELMET' : '') : '';
  els.kitind.textContent = p.hasKit ? 'DEFUSE KIT' : '';
  // weapon box
  const item = currentItem(p);
  const def = currentDef(p);
  const nade = heldNade(p);
  els.money.textContent = '$' + p.money;
  els.wepname.textContent = nade ? NADES[nade].name : def ? def.name : '-';
  if (def && def.mag > 0 && item) {
    els.mag.textContent = item.mag;
    els.reserve.textContent = '/ ' + item.reserve + (item.reloadEnd > G.time ? '  RELOADING' : '');
    els.ammo.classList.toggle('low', item.mag <= Math.ceil(def.mag * 0.25));
  } else if (nade) {
    els.mag.textContent = p.inv[nade];
    els.reserve.textContent = ' grenades';
    els.ammo.classList.remove('low');
  } else {
    els.mag.textContent = '-';
    els.reserve.textContent = '';
  }
  const slotBits = [];
  if (p.inv.primary) slotBits.push(`<b>1</b> ${WEAPONS[p.inv.primary.key].name}`);
  slotBits.push(`<b>2</b> ${WEAPONS[p.inv.secondary.key].name}`);
  slotBits.push(`<b>3</b> Knife`);
  if (p.inv.he) slotBits.push(`<b>4</b> HE x${p.inv.he}`);
  if (p.inv.flash) slotBits.push(`<b>5</b> Flash x${p.inv.flash}`);
  if (p.inv.smoke) slotBits.push(`<b>6</b> Smoke x${p.inv.smoke}`);
  els.slots.innerHTML = slotBits.join(' &nbsp; ');
  els.bombind.textContent = p.hasBomb ? 'YOU HAVE THE CHARGE - PLANT AT A SITE (HOLD E)' :
    G.bomb.planted ? `CHARGE PLANTED - SITE ${G.bomb.site}` :
    G.bomb.droppedAt ? 'CHARGE DROPPED' : '';
  // clock and score
  els.clock.textContent = G.phase === 'planted' ? fmtClock(G.bomb.fuse) : fmtClock(G.phaseT);
  els.clock.className = G.phase === 'planted' ? 'planted' : G.phaseT < 11 && G.phase === 'live' ? 'low' : '';
  els['score-atk'].textContent = G.squadScore.ember;
  els['score-def'].textContent = G.squadScore.harbor;
  els['name-atk'].textContent = TEAM_NAMES.atk;
  els['name-def'].textContent = TEAM_NAMES.def;
  els.roundlabel.textContent = G.over ? 'MATCH OVER' : `ROUND ${Math.min(G.round + 1, G.maxRounds)} / ${G.maxRounds}${G.phase === 'buy' ? ' - BUY' : ''}`;
  const pips = (team) => aliveOf(team).length;
  els.pips.innerHTML =
    `<span class="piprow">${'<i class="pip"></i>'.repeat(pips('atk'))}${'<i class="pip dead"></i>'.repeat(5 - pips('atk'))}</span>` +
    `<span class="piprow">${'<i class="pip def"></i>'.repeat(pips('def'))}${'<i class="pip dead"></i>'.repeat(5 - pips('def'))}</span>`;
  els.plan.textContent = p.team === 'atk' && !G.bomb.planted && G.phase !== 'over'
    ? `PLAN: ${G.planSite === 'A' ? 'HIT THE COLDSTORE (A)' : 'HIT THE CRANE DOCK (B)'}`
    : p.team === 'def' && G.bomb.planted ? 'RETAKE THE SITE - DEFUSE THE CHARGE' : '';
  // crosshair tracks the live spread cone
  if (view.playing && p.alive) {
    els.crosshair.style.setProperty('--sp', (4 + spreadNow(p) * 620) + 'px');
    els.crosshair.style.opacity = view.scoped ? '0' : '1';
  } else els.crosshair.style.opacity = '0';
  els.scopefx.classList.toggle('hidden', !view.scoped);
  // killfeed: append new entries, prune old
  while (kfRendered < G.killfeed.length) {
    const k = G.killfeed[kfRendered++];
    const d = document.createElement('div');
    d.className = 'kf';
    d.dataset.t = k.t;
    d.innerHTML = `<span class="${k.killerTeam}">${k.killer}</span><span class="wep">${k.weapon}</span>${k.head ? '<span class="hs">HEADSHOT</span> ' : ''}<span class="${k.victimTeam}">${k.victim}</span>`;
    els.killfeed.appendChild(d);
  }
  for (const d of [...els.killfeed.children]) if (G.time - Number(d.dataset.t) > 5.5) d.remove();
  // radio callouts
  while (coRendered < G.callouts.length) {
    const c = G.callouts[coRendered++];
    const d = document.createElement('div');
    d.className = 'co ' + c.team;
    d.dataset.t = c.t;
    d.textContent = c.text;
    els.callouts.appendChild(d);
  }
  for (const d of [...els.callouts.children]) if (G.time - Number(d.dataset.t) > 7) d.remove();
  while (els.callouts.children.length > 3) els.callouts.firstChild.remove();
  // banner lifetime
  if (bannerUntil && now > bannerUntil) { els.banner.classList.add('hidden'); bannerUntil = 0; }
  // hitmarker and damage direction decay
  if (hitT > 0) { hitT -= dt; if (hitT <= 0) els.hitmarker.className = ''; }
  if (dmgDirT > 0) {
    dmgDirT -= dt;
    els.dmgdir.style.opacity = Math.max(0, dmgDirT);
    els.dmgdir.style.transform = `rotate(${dmgDirAngle}rad)`;
  } else els.dmgdir.style.opacity = '0';
  // channel progress (plant / defuse by anyone)
  if (G.channel && (G.phase === 'live' || G.phase === 'planted')) {
    els.progress.classList.remove('hidden');
    els['progress-label'].textContent = G.channel.label + (G.channel.actor.isPlayer ? '' : ` - ${G.channel.actor.name}`);
    els['progress-fill'].style.width = (Math.min(1, G.channel.frac) * 100) + '%';
  } else els.progress.classList.add('hidden');
  // spectate label
  if (view.spectating) {
    els.spectate.classList.remove('hidden');
    els.spectate.textContent = `SPECTATING ${view.spectating} - CLICK TO SWITCH`;
  } else els.spectate.classList.add('hidden');
  // flash and hurt overlays
  els.flashfx.style.opacity = Math.min(0.96, p.flashT > 0 ? 0.25 + p.flashT * 0.3 : 0);
  const hurt = !p.alive ? 0.85 : p.hp < 35 ? 0.35 + 0.2 * Math.sin(now * 5) : view.hurtT > 0 ? 0.5 : 0;
  els.hurtfx.style.opacity = hurt;
  if (buyOpen) refreshBuy();
  drawRadar(p);
}
