// audio.js — every sound in the yard is synthesized with WebAudio.
//
// No audio files ship with the game: gunfire is a shaped noise burst over a
// low thump, hits are short ticks, the bomb beeps, the explosion is a
// filtered noise swell. One SoundBank owns the context; callers pass a
// distance and the bank turns far sounds down and dulls them.

export class SoundBank {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuf = null;
  }

  // Browsers keep the context suspended until a gesture; call on Deploy.
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
    const len = this.ctx.sampleRate;
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }

  // A noise burst through a band filter: the workhorse of every gunshot.
  burst({ at = 0, dur = 0.12, freq = 1800, q = 0.7, gain = 0.5, type = "lowpass", slideTo = 0 }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + at;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.7 + Math.random() * 0.6;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (slideTo) f.frequency.exponentialRampToValueAtTime(Math.max(40, slideTo), t + dur);
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.4);
    src.stop(t + dur + 0.02);
  }

  tone({ at = 0, dur = 0.1, freq = 440, gain = 0.2, type = "sine", slideTo = 0 }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + at;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  // Volume and brightness fall with distance, roughly like the real yard.
  fall(dist) {
    const v = 1 / (1 + dist * 0.09);
    return { gain: v, dull: 1 / (1 + dist * 0.05) };
  }

  shot(kind, dist = 0) {
    const { gain, dull } = this.fall(dist);
    if (gain < 0.02) return;
    if (kind === "sniper") {
      this.burst({ dur: 0.5, freq: 3200 * dull, gain: 0.85 * gain, slideTo: 300 });
      this.tone({ dur: 0.3, freq: 130, gain: 0.5 * gain, type: "triangle", slideTo: 45 });
    } else if (kind === "smg") {
      this.burst({ dur: 0.09, freq: 2400 * dull, gain: 0.5 * gain, slideTo: 500 });
      this.tone({ dur: 0.07, freq: 190, gain: 0.3 * gain, type: "triangle", slideTo: 70 });
    } else if (kind === "pistol") {
      this.burst({ dur: 0.13, freq: 2100 * dull, gain: 0.55 * gain, slideTo: 420 });
      this.tone({ dur: 0.09, freq: 165, gain: 0.32 * gain, type: "triangle", slideTo: 60 });
    } else {
      // rifle and everything else
      this.burst({ dur: 0.17, freq: 2600 * dull, gain: 0.68 * gain, slideTo: 380 });
      this.tone({ dur: 0.12, freq: 150, gain: 0.4 * gain, type: "triangle", slideTo: 55 });
    }
  }

  dryFire() { this.tone({ dur: 0.04, freq: 1400, gain: 0.12, type: "square" }); }
  reload() {
    this.tone({ dur: 0.05, freq: 700, gain: 0.15, type: "square" });
    this.tone({ at: 0.16, dur: 0.05, freq: 480, gain: 0.18, type: "square" });
    this.tone({ at: 0.5, dur: 0.06, freq: 900, gain: 0.2, type: "square" });
  }
  boltCycle() {
    this.tone({ dur: 0.06, freq: 520, gain: 0.16, type: "square" });
    this.tone({ at: 0.14, dur: 0.06, freq: 760, gain: 0.18, type: "square" });
  }
  hit(head = false) {
    this.tone({ dur: 0.05, freq: head ? 1560 : 1050, gain: 0.22, type: "square" });
  }
  hurt() { this.tone({ dur: 0.12, freq: 210, gain: 0.25, type: "sawtooth", slideTo: 120 }); }
  kill() {
    this.tone({ dur: 0.07, freq: 880, gain: 0.2, type: "square" });
    this.tone({ at: 0.07, dur: 0.1, freq: 1320, gain: 0.2, type: "square" });
  }
  step(dist = 0, run = false) {
    const { gain } = this.fall(dist);
    if (gain < 0.03) return;
    this.burst({ dur: run ? 0.06 : 0.04, freq: 500, gain: 0.1 * gain, type: "lowpass" });
  }
  jump() { this.burst({ dur: 0.05, freq: 700, gain: 0.08 }); }
  throwIt() { this.burst({ dur: 0.08, freq: 900, gain: 0.1, type: "bandpass" }); }
  bounce(dist = 0) {
    const { gain } = this.fall(dist);
    this.tone({ dur: 0.04, freq: 340, gain: 0.14 * gain, type: "triangle" });
  }
  flashPop(dist = 0) {
    const { gain } = this.fall(dist);
    this.burst({ dur: 0.2, freq: 4000, gain: 0.4 * gain, type: "highpass" });
    this.tone({ dur: 0.5, freq: 5200, gain: 0.06 * gain });
  }
  explosion(dist = 0) {
    const { gain } = this.fall(dist);
    this.burst({ dur: 1.4, freq: 900, gain: 1.0 * gain, slideTo: 60 });
    this.tone({ dur: 1.1, freq: 90, gain: 0.7 * gain, type: "sine", slideTo: 32 });
  }
  plantBeep(last = false) {
    this.tone({ dur: last ? 0.3 : 0.07, freq: last ? 1560 : 1040, gain: 0.2, type: "square" });
  }
  plantDone() {
    this.tone({ dur: 0.09, freq: 1040, gain: 0.22, type: "square" });
    this.tone({ at: 0.1, dur: 0.16, freq: 1560, gain: 0.22, type: "square" });
  }
  uiClick() { this.tone({ dur: 0.04, freq: 1200, gain: 0.12, type: "square" }); }
  buyOk() {
    this.tone({ dur: 0.06, freq: 990, gain: 0.16, type: "square" });
    this.tone({ at: 0.06, dur: 0.08, freq: 1480, gain: 0.16, type: "square" });
  }
  buyNo() { this.tone({ dur: 0.12, freq: 220, gain: 0.16, type: "square" }); }
  roundEnd(win) {
    const base = win ? 523 : 392;
    this.tone({ dur: 0.16, freq: base, gain: 0.2, type: "triangle" });
    this.tone({ at: 0.16, dur: 0.16, freq: base * 1.25, gain: 0.2, type: "triangle" });
    this.tone({ at: 0.32, dur: 0.34, freq: base * (win ? 1.5 : 0.84), gain: 0.22, type: "triangle" });
  }
  defuseWire() { this.tone({ dur: 0.05, freq: 1750, gain: 0.1, type: "square" }); }
}
