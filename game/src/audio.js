// audio.js - every sound is synthesized with WebAudio, no assets.
// One-shots are built from noise buffers and oscillators at call time
// and thrown away; the only things kept are the context, the master
// gain and a shared noise buffer. World sounds take a distance and are
// attenuated (and slightly low-passed) by it, so a bot's shot across
// the map sounds like one, which is also how the player reads fights.

let ctx = null;
let master = null;
let noiseBuf = null;

export function initAudio() {
  if (ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(ctx.destination);
  const len = ctx.sampleRate * 1.2;
  noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
}

export function resumeAudio() {
  if (ctx && ctx.state === 'suspended') ctx.resume();
}

function env(gain, t0, peak, decay) {
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
}

// A noise burst through a band filter: the body of every gunshot,
// explosion and impact. freq/q shape it, dist shrinks and dulls it.
function burst({ dur = 0.15, freq = 1800, q = 0.8, vol = 0.5, dist = 0, type = 'bandpass' }) {
  if (!ctx) return;
  const t0 = ctx.currentTime;
  const att = 1 / (1 + dist * 0.055);
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.playbackRate.value = 0.85 + Math.random() * 0.3;
  const f = ctx.createBiquadFilter();
  f.type = type; f.frequency.value = Math.max(220, freq / (1 + dist * 0.03)); f.Q.value = q;
  const g = ctx.createGain();
  env(g, t0, vol * att, dur);
  src.connect(f); f.connect(g); g.connect(master);
  src.start(t0, Math.random() * 0.4, dur + 0.05);
  src.stop(t0 + dur + 0.06);
}

// A short oscillator blip: thumps, beeps, dings, UI.
function tone({ freq = 440, dur = 0.1, vol = 0.2, type = 'sine', slide = 0, dist = 0, delay = 0 }) {
  if (!ctx) return;
  const t0 = ctx.currentTime + delay;
  const att = 1 / (1 + dist * 0.055);
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
  const g = ctx.createGain();
  env(g, t0, vol * att, dur);
  o.connect(g); g.connect(master);
  o.start(t0); o.stop(t0 + dur + 0.05);
}

// Per-weapon shot character: crack frequency, body thump, tail length.
const SHOT = {
  p9: { f: 2400, thump: 210, dur: 0.11, vol: 0.5 },
  sidekick: { f: 1900, thump: 160, dur: 0.16, vol: 0.62 },
  ripper: { f: 2600, thump: 240, dur: 0.09, vol: 0.44 },
  vk7: { f: 2100, thump: 150, dur: 0.17, vol: 0.66 },
  breacher: { f: 1200, thump: 110, dur: 0.3, vol: 0.8 },
  longshot: { f: 1500, thump: 95, dur: 0.42, vol: 0.85 },
  knife: { f: 3200, thump: 0, dur: 0.05, vol: 0.2 },
};
export function sfxShot(kind, dist = 0) {
  const s = SHOT[kind] || SHOT.vk7;
  burst({ dur: s.dur, freq: s.f, vol: s.vol, dist });
  if (s.thump) tone({ freq: s.thump, dur: s.dur * 0.8, vol: s.vol * 0.5, type: 'triangle', slide: -s.thump * 0.5, dist });
}
export function sfxDry(dist = 0) { tone({ freq: 1900, dur: 0.03, vol: 0.12, type: 'square', dist }); }
export function sfxReload(dist = 0) {
  tone({ freq: 700, dur: 0.04, vol: 0.14, type: 'square', dist });
  tone({ freq: 480, dur: 0.04, vol: 0.14, type: 'square', dist, delay: 0.16 });
  tone({ freq: 950, dur: 0.05, vol: 0.16, type: 'square', dist, delay: 0.34 });
}
export function sfxHit(head) {
  tone({ freq: head ? 1560 : 1180, dur: 0.06, vol: 0.22, type: 'sine' });
  if (head) tone({ freq: 2090, dur: 0.09, vol: 0.16, delay: 0.03 });
}
export function sfxHurt() { burst({ dur: 0.1, freq: 500, vol: 0.25, type: 'lowpass' }); }
export function sfxKill() {
  tone({ freq: 660, dur: 0.08, vol: 0.2, type: 'triangle' });
  tone({ freq: 990, dur: 0.12, vol: 0.2, type: 'triangle', delay: 0.07 });
}
export function sfxStep(dist = 0, run = false) {
  burst({ dur: 0.05, freq: 700, vol: run ? 0.10 : 0.05, dist, type: 'lowpass' });
}
export function sfxJump() { burst({ dur: 0.06, freq: 900, vol: 0.06, type: 'lowpass' }); }
export function sfxLand() { burst({ dur: 0.08, freq: 500, vol: 0.12, type: 'lowpass' }); }
export function sfxThrow() { burst({ dur: 0.08, freq: 1500, vol: 0.1 }); }
export function sfxBounce(dist = 0) { tone({ freq: 300, dur: 0.04, vol: 0.12, type: 'square', dist }); }
export function sfxExplosion(dist = 0) {
  burst({ dur: 0.7, freq: 320, vol: 0.95, dist, type: 'lowpass' });
  tone({ freq: 70, dur: 0.6, vol: 0.7, type: 'sine', slide: -30, dist });
}
export function sfxFlashPop(dist = 0) {
  burst({ dur: 0.2, freq: 3400, vol: 0.5, dist });
  tone({ freq: 4200, dur: 0.5, vol: 0.1, slide: -800 });
}
export function sfxSmokePop(dist = 0) { burst({ dur: 0.35, freq: 800, vol: 0.3, dist, type: 'lowpass' }); }
export function sfxPlantBeep(final = false) {
  tone({ freq: final ? 1560 : 1040, dur: final ? 0.3 : 0.07, vol: 0.2, type: 'square' });
}
export function sfxDefuse() { tone({ freq: 880, dur: 0.09, vol: 0.18, type: 'square' }); tone({ freq: 1320, dur: 0.14, vol: 0.18, type: 'square', delay: 0.1 }); }
export function sfxBuy() { tone({ freq: 1250, dur: 0.05, vol: 0.16, type: 'square' }); tone({ freq: 1680, dur: 0.07, vol: 0.14, type: 'square', delay: 0.05 }); }
export function sfxDeny() { tone({ freq: 220, dur: 0.12, vol: 0.18, type: 'square' }); }
export function sfxRound(win) {
  const base = win ? 523 : 392;
  tone({ freq: base, dur: 0.16, vol: 0.2, type: 'triangle' });
  tone({ freq: base * 1.25, dur: 0.16, vol: 0.2, type: 'triangle', delay: 0.13 });
  tone({ freq: base * 1.5, dur: 0.3, vol: 0.22, type: 'triangle', delay: 0.26 });
}
export function sfxMatch(win) {
  const seq = win ? [523, 659, 784, 1046] : [440, 392, 330, 262];
  seq.forEach((f, i) => tone({ freq: f, dur: 0.24, vol: 0.2, type: 'triangle', delay: i * 0.17 }));
}
export function sfxScope(on) { tone({ freq: on ? 1500 : 1100, dur: 0.04, vol: 0.1, type: 'sine' }); }
export function sfxPickup() { tone({ freq: 740, dur: 0.06, vol: 0.14, type: 'triangle' }); }
