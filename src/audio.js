/**
 * Procedural sound. Everything is synthesised with the WebAudio API so the game
 * ships with zero audio assets.
 */
export class Audio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.noiseBuffer = null;
  }

  /** Must be called from a user gesture (browsers block audio otherwise). */
  resume() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.55;
      this.master.connect(this.ctx.destination);
      this.noiseBuffer = this.makeNoise(2);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.value = on ? 0.55 : 0;
  }

  get ok() {
    return this.enabled && this.ctx && this.ctx.state === 'running';
  }

  makeNoise(seconds) {
    const len = this.ctx.sampleRate * seconds;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  noise({ duration = 0.4, gain = 0.5, type = 'lowpass', from = 1800, to = 120, q = 1 } = {}) {
    if (!this.ok) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(from, t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, to), t + duration);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + duration + 0.05);
  }

  tone({ freq = 440, to = null, duration = 0.2, gain = 0.25, type = 'sine', delay = 0 } = {}) {
    if (!this.ok) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + duration);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.05);
  }

  launch() {
    this.noise({ duration: 0.35, gain: 0.4, from: 2600, to: 300 });
    this.tone({ freq: 220, to: 60, duration: 0.3, gain: 0.2, type: 'sawtooth' });
  }

  explosion(size = 1) {
    const d = 0.5 + size * 0.35;
    this.noise({ duration: d, gain: 0.75, from: 900 * size, to: 60, q: 0.7 });
    this.tone({ freq: 90, to: 28, duration: d * 0.8, gain: 0.5, type: 'sine' });
    this.noise({ duration: 0.09, gain: 0.5, type: 'highpass', from: 3000, to: 6000 });
  }

  jump() {
    this.tone({ freq: 320, to: 620, duration: 0.16, gain: 0.16, type: 'square' });
  }

  bounce() {
    this.tone({ freq: 520, to: 300, duration: 0.09, gain: 0.12, type: 'triangle' });
  }

  thud() {
    this.noise({ duration: 0.22, gain: 0.4, from: 500, to: 70 });
  }

  splash() {
    this.noise({ duration: 0.5, gain: 0.4, type: 'bandpass', from: 900, to: 2600, q: 0.8 });
  }

  pickup() {
    [660, 880, 1174].forEach((f, i) =>
      this.tone({ freq: f, duration: 0.14, gain: 0.18, type: 'triangle', delay: i * 0.07 })
    );
  }

  swing() {
    this.noise({ duration: 0.18, gain: 0.35, type: 'bandpass', from: 400, to: 2200, q: 1.4 });
  }

  warp() {
    this.tone({ freq: 180, to: 1400, duration: 0.35, gain: 0.2, type: 'sine' });
    this.tone({ freq: 1400, to: 180, duration: 0.35, gain: 0.14, type: 'sine', delay: 0.16 });
  }

  siren() {
    this.tone({ freq: 420, to: 700, duration: 0.5, gain: 0.16, type: 'sawtooth' });
    this.tone({ freq: 700, to: 420, duration: 0.5, gain: 0.16, type: 'sawtooth', delay: 0.5 });
  }

  turnStart() {
    this.tone({ freq: 523, duration: 0.14, gain: 0.16, type: 'triangle' });
    this.tone({ freq: 784, duration: 0.2, gain: 0.16, type: 'triangle', delay: 0.13 });
  }

  tick() {
    this.tone({ freq: 900, duration: 0.05, gain: 0.09, type: 'square' });
  }

  death() {
    this.tone({ freq: 400, to: 70, duration: 0.6, gain: 0.22, type: 'sawtooth' });
  }

  victory() {
    [523, 659, 784, 1046].forEach((f, i) =>
      this.tone({ freq: f, duration: 0.32, gain: 0.2, type: 'triangle', delay: i * 0.13 })
    );
  }
}
