// state.js — the match's whole state in one object, and the round rules.
//
// Nothing else in the game keeps match state of its own: the round phase
// machine, the score, the bomb, the clock and the player's money all live
// here, so the HUD, the bots and the rules can never disagree.

export const CFG = {
  buyTime: 12,
  roundTime: 100,
  fuseTime: 40,
  plantTime: 3.2,
  defuseTime: 10,
  defuseKitTime: 5,
  roundEndTime: 4.5,
  startMoney: 800,
  maxMoney: 16000,
  winsNeeded: 6,
  maxRounds: 11,
  teamSize: 4,
};

export const REWARD = {
  kill: 300,
  plant: 300,
  winElimination: 2700,
  winDetonate: 3000,
  winDefuse: 3000,
  winTimeout: 2700,
  lossBase: 1900,
  lossStep: 200,
  lossCap: 800,
};

export const G = {
  phase: "menu", // menu | buy | live | planted | over | matchover
  phaseT: 0, // seconds left in the current phase
  round: 0,
  score: { atk: 0, def: 0 },
  lossStreak: { atk: 0, def: 0 },
  money: CFG.startMoney,
  combatants: [], // the player is combatants[0]; bots follow
  player: null,
  bomb: null, // { state, carrier, x,y,z, site, fuseT, mesh }
  channel: null, // { kind: 'plant'|'defuse', who, t, dur }
  smokes: [], // live smoke spheres { x,y,z,r, until }
  time: 0, // match clock, seconds; only runs while a round is live
  shake: 0, // camera shake energy, decays in the render loop
  winner: null, // 'atk' | 'def' once the match is decided
  roundWinner: null,
  roundReason: "",
  director: false, // ?autoplay=1: a bot brain drives the player
};

export function aliveCount(team) {
  let n = 0;
  for (const c of G.combatants) if (c.team === team && c.alive) n++;
  return n;
}

export function teamAlive(team) {
  const out = [];
  for (const c of G.combatants) if (c.team === team && c.alive) out.push(c);
  return out;
}

// Round-end pay: winners get the win award, losers the loss bonus that
// grows while they keep losing. Applied to the player here; bots track
// their own purses through the same numbers in main.
export function roundPay(winnerTeam, reason) {
  const winPay = reason === "detonate" ? REWARD.winDetonate
    : reason === "defuse" ? REWARD.winDefuse
    : reason === "timeout" ? REWARD.winTimeout
    : REWARD.winElimination;
  const loser = winnerTeam === "atk" ? "def" : "atk";
  const lossPay = Math.min(REWARD.lossBase + REWARD.lossStep * G.lossStreak[loser], REWARD.lossBase + REWARD.lossCap);
  G.lossStreak[loser]++;
  G.lossStreak[winnerTeam] = 0;
  return { winPay, lossPay };
}

export function resetMatch() {
  G.phase = "buy";
  G.round = 0;
  G.score.atk = 0;
  G.score.def = 0;
  G.lossStreak.atk = 0;
  G.lossStreak.def = 0;
  G.money = CFG.startMoney;
  G.winner = null;
  G.time = 0;
}
