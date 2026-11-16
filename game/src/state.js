// state.js - the one place match state lives.
// Everything else reads and writes through here: the round phase
// machine, the clock, the score, the bomb, the economy and the actor
// roster. No rendering, no input, no three.js scene objects beyond the
// plain data the simulation needs, so the state can be reasoned about
// (and reset) without touching the view.

// Phases: 'buy' -> 'live' -> 'planted' -> 'over' (round), then either
// back to 'buy' or 'matchover'. The clock only runs in buy/live/planted.
export const G = {
  phase: 'buy',
  phaseT: 0,            // seconds left in the current phase
  round: 0,
  score: { atk: 0, def: 0 },          // rounds won per side, this half's lens
  squadScore: { ember: 0, harbor: 0 }, // rounds won per squad, the match score
  winsNeeded: 7,        // first to 7, 12 rounds max
  maxRounds: 12,
  swapped: false,       // sides swap after round 6
  actors: [],           // every combatant, player included
  player: null,
  bomb: {
    carrier: null,      // actor holding it, or null
    droppedAt: null,    // Vector3-like {x,y,z} when on the ground
    planted: false,
    site: null,         // 'A' | 'B'
    pos: null,
    fuse: 0,            // seconds to detonation once planted
    planter: null,
  },
  noise: [],            // recent sounds bots can hear {x, z, r, t, team}
  intel: { atk: new Map(), def: new Map() }, // team -> enemyId -> {x, z, t}
  killfeed: [],         // {killer, victim, weapon, head, t}
  callouts: [],         // radio traffic {team, text, t}, HUD shows the last few
  contactT: { atk: -99, def: -99 }, // last first-contact callout per team
  channel: null,        // {actor, label, frac} while someone plants/defuses
  roundLog: [],         // result strings for the scoreboard
  time: 0,              // simulation clock, seconds since match start
  events: [],           // queued game events main.js drains: plant, defuse, ...
  over: false,
  winner: null,
  planSite: 'A',        // the attacking team's called site this round
  stage: null,          // screenshot staging hint from the URL, if any
};

export const TEAM_NAMES = { atk: 'EMBER', def: 'HARBOR' };
export const START_MONEY = 800;
export const MAX_MONEY = 16000;

// Economy, in the open: what each event pays. Loss pay climbs with
// consecutive losses so a beaten team can always buy back in.
export const PAY = {
  kill: 300,
  plant: 300,          // to the planter
  plantTeam: 800,      // to every attacker when the bomb goes down
  winElim: 2700,
  winObjective: 2900,  // detonation or defuse
  lossBase: 1400,
  lossStep: 500,
  lossMax: 3400,
  surviveBonus: 0,
};

let nextId = 1;

export function makeActor(team, name, isPlayer) {
  const a = {
    id: nextId++,
    team, name, isPlayer: !!isPlayer,
    alive: true,
    hp: 100,
    armor: 0,           // 0..100, absorbs a weapon-dependent share
    helmet: false,
    money: START_MONEY,
    kills: 0, deaths: 0, assists: 0,
    // body, filled by player.js createBody()
    pos: null, vel: null, yaw: 0, pitch: 0,
    crouch: false, onGround: true, groundSpeed: 0,
    // loadout, filled by weapon.js resetLoadout()
    inv: null, slot: 'secondary',
    hasBomb: false, hasKit: false,
    // combat bookkeeping
    lastHitBy: null, lastHitT: -9, tagT: 0, flashT: 0, flashFrom: 0,
    stepT: 0, shotsFired: 0, shotsHit: 0,
    brain: null, body: null,
  };
  G.actors.push(a);
  return a;
}

export function aliveOf(team) {
  return G.actors.filter((a) => a.alive && a.team === team);
}

export function enemiesOf(a) {
  return G.actors.filter((o) => o.alive && o.team !== a.team);
}

export function addNoise(x, z, radius, team) {
  G.noise.push({ x, z, r: radius, t: G.time, team });
  if (G.noise.length > 24) G.noise.shift();
}

// Shared team memory: a sighting one bot makes is information the whole
// team can act on, with a timestamp so stale intel decays.
export function reportIntel(team, enemy, x, z) {
  G.intel[team].set(enemy.id, { x, z, t: G.time, id: enemy.id });
}

export function freshIntel(team, maxAge) {
  const out = [];
  for (const s of G.intel[team].values()) {
    if (G.time - s.t <= maxAge) out.push(s);
  }
  return out;
}

export function payActor(a, amount) {
  a.money = Math.max(0, Math.min(MAX_MONEY, a.money + amount));
}

export function lossPay(consecutiveLosses) {
  return Math.min(PAY.lossMax, PAY.lossBase + PAY.lossStep * Math.max(0, consecutiveLosses - 1));
}

export const lossStreak = { atk: 0, def: 0 };

export function resetMatch() {
  G.phase = 'buy';
  G.phaseT = 0;
  G.round = 0;
  G.score.atk = 0; G.score.def = 0;
  G.squadScore.ember = 0; G.squadScore.harbor = 0;
  G.swapped = false;
  G.over = false;
  G.winner = null;
  G.killfeed.length = 0;
  G.roundLog.length = 0;
  lossStreak.atk = 0; lossStreak.def = 0;
  for (const a of G.actors) {
    a.money = START_MONEY;
    a.kills = 0; a.deaths = 0; a.assists = 0;
  }
}

export function resetBomb() {
  G.bomb.carrier = null;
  G.bomb.droppedAt = null;
  G.bomb.planted = false;
  G.bomb.site = null;
  G.bomb.pos = null;
  G.bomb.fuse = 0;
  G.bomb.planter = null;
}
