/**
 * Sound. Named effects play pre-rendered clips from public/sfx/ (generated with
 * Stable Audio 3 - see tools/audio-gen/). Until those finish loading, each falls
 * back to the original WebAudio-synthesised version so nothing is ever silent.
 */
const SFX_NAMES = [
  'launch', 'explosion', 'jump', 'bounce', 'thud', 'splash', 'pickup', 'swing',
  'dig', 'build', 'warp', 'siren', 'turnStart', 'tick', 'death', 'hallelujah',
  'victory', 'toss', 'gunshot', 'bulletImpact',
];

export class Audio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.noiseBuffer = null;
    this.buffers = {};
    // Kick off the network fetch immediately - it doesn't need an AudioContext,
    // so clips are ready to decode as soon as resume() gets its first user gesture.
    this.rawClips = Object.fromEntries(
      SFX_NAMES.map((name) => [name, fetch(`/sfx/${name}.wav`).then((r) => r.arrayBuffer())])
    );
  }

  /** Must be called from a user gesture (browsers block audio otherwise). */
  resume() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.4;
      this.master.connect(this.ctx.destination);
      this.noiseBuffer = this.makeNoise(2);
      this.decodeClips();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  async decodeClips() {
    await Promise.all(
      Object.entries(this.rawClips).map(async ([name, pending]) => {
        try {
          const data = await pending;
          this.buffers[name] = await this.ctx.decodeAudioData(data);
        } catch (e) {
          console.warn(`sfx: failed to load "${name}"`, e);
        }
      })
    );
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.value = on ? 0.4 : 0;
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

  /** Plays a pre-rendered clip if it's loaded. Returns false (and plays nothing)
   * if it isn't, so callers can fall back to a procedural version. */
  playClip(name, { gain = 0.5, rate = 1, delay = 0 } = {}) {
    if (!this.ok) return false;
    const buf = this.buffers[name];
    if (!buf) return false;
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.master);
    src.start(t);
    return true;
  }

  launch() {
    if (this.playClip('launch', { gain: 0.5 })) return;
    this.noise({ duration: 0.35, gain: 0.4, from: 2600, to: 300 });
    this.tone({ freq: 220, to: 60, duration: 0.3, gain: 0.2, type: 'sawtooth' });
  }

  /** Underhand toss for thrown weapons (grenades, fruit bomb, melon, dynamite, mine). */
  toss() {
    if (this.playClip('toss', { gain: 0.4 })) return;
    this.noise({ duration: 0.15, gain: 0.25, type: 'bandpass', from: 700, to: 1600, q: 1.2 });
  }

  /** Firearm discharge (scattergun, uzi). */
  gunshot() {
    if (this.playClip('gunshot', { gain: 0.4 })) return;
    this.noise({ duration: 0.08, gain: 0.35, type: 'highpass', from: 1200, to: 4000, q: 0.8 });
    this.tone({ freq: 1800, to: 400, duration: 0.05, gain: 0.16, type: 'square' });
  }

  /** A bullet finding its target - sharp and small, not a full explosion. */
  bulletImpact() {
    if (this.playClip('bulletImpact', { gain: 0.35 })) return;
    this.tone({ freq: 1400, to: 300, duration: 0.06, gain: 0.15, type: 'square' });
    this.noise({ duration: 0.05, gain: 0.15, type: 'highpass', from: 2500, to: 5000 });
  }

  explosion(size = 1) {
    const rate = Math.max(0.65, 1.1 - 0.25 * size);
    const gain = Math.min(0.6, 0.33 + 0.15 * size);
    if (this.playClip('explosion', { gain, rate })) return;
    const d = 0.5 + size * 0.35;
    this.noise({ duration: d, gain: 0.75, from: 900 * size, to: 60, q: 0.7 });
    this.tone({ freq: 90, to: 28, duration: d * 0.8, gain: 0.5, type: 'sine' });
    this.noise({ duration: 0.09, gain: 0.5, type: 'highpass', from: 3000, to: 6000 });
  }

  jump() {
    if (this.playClip('jump', { gain: 0.42 })) return;
    this.tone({ freq: 320, to: 620, duration: 0.16, gain: 0.16, type: 'square' });
  }

  bounce() {
    if (this.playClip('bounce', { gain: 0.38 })) return;
    this.tone({ freq: 520, to: 300, duration: 0.09, gain: 0.12, type: 'triangle' });
  }

  thud() {
    if (this.playClip('thud', { gain: 0.45 })) return;
    this.noise({ duration: 0.22, gain: 0.4, from: 500, to: 70 });
  }

  splash() {
    if (this.playClip('splash', { gain: 0.42 })) return;
    this.noise({ duration: 0.5, gain: 0.4, type: 'bandpass', from: 900, to: 2600, q: 0.8 });
  }

  pickup() {
    if (this.playClip('pickup', { gain: 0.45 })) return;
    [660, 880, 1174].forEach((f, i) =>
      this.tone({ freq: f, duration: 0.14, gain: 0.18, type: 'triangle', delay: i * 0.07 })
    );
  }

  swing() {
    if (this.playClip('swing', { gain: 0.4 })) return;
    this.noise({ duration: 0.18, gain: 0.35, type: 'bandpass', from: 400, to: 2200, q: 1.4 });
  }

  dig() {
    if (this.playClip('dig', { gain: 0.42 })) return;
    this.noise({ duration: 0.3, gain: 0.4, type: 'lowpass', from: 700, to: 90, q: 0.9 });
    this.tone({ freq: 140, to: 80, duration: 0.22, gain: 0.15, type: 'square' });
  }

  build() {
    if (this.playClip('build', { gain: 0.45 })) return;
    this.thud();
    this.tone({ freq: 180, to: 320, duration: 0.22, gain: 0.18, type: 'triangle' });
  }

  warp() {
    if (this.playClip('warp', { gain: 0.45 })) return;
    this.tone({ freq: 180, to: 1400, duration: 0.35, gain: 0.2, type: 'sine' });
    this.tone({ freq: 1400, to: 180, duration: 0.35, gain: 0.14, type: 'sine', delay: 0.16 });
  }

  siren() {
    if (this.playClip('siren', { gain: 0.42 })) return;
    this.tone({ freq: 420, to: 700, duration: 0.5, gain: 0.16, type: 'sawtooth' });
    this.tone({ freq: 700, to: 420, duration: 0.5, gain: 0.16, type: 'sawtooth', delay: 0.5 });
  }

  turnStart() {
    if (this.playClip('turnStart', { gain: 0.45 })) return;
    this.tone({ freq: 523, duration: 0.14, gain: 0.16, type: 'triangle' });
    this.tone({ freq: 784, duration: 0.2, gain: 0.16, type: 'triangle', delay: 0.13 });
  }

  tick() {
    if (this.playClip('tick', { gain: 0.32 })) return;
    this.tone({ freq: 900, duration: 0.05, gain: 0.09, type: 'square' });
  }

  death() {
    if (this.playClip('death', { gain: 0.48 })) return;
    this.tone({ freq: 400, to: 70, duration: 0.6, gain: 0.22, type: 'sawtooth' });
  }

  /** The Sacred Melon's little fanfare - plays once as it's thrown, fuse ticking. */
  hallelujah() {
    if (this.playClip('hallelujah', { gain: 0.48 })) return;
    const notes = [392, 392, 392, 440, 523, 523, 523, 587, 659];
    notes.forEach((f, i) =>
      this.tone({ freq: f, duration: 0.22, gain: 0.22, type: 'triangle', delay: i * 0.16 })
    );
  }

  victory() {
    if (this.playClip('victory', { gain: 0.48 })) return;
    [523, 659, 784, 1046].forEach((f, i) =>
      this.tone({ freq: f, duration: 0.32, gain: 0.2, type: 'triangle', delay: i * 0.13 })
    );
  }

  /** A single footfall for a walking blob - purely procedural (a generated
   * continuous rolling loop was tried and didn't sound good; this reads as a
   * soft, punchy step instead and stays perfectly in sync with the bob animation
   * since the caller triggers it directly off that same cycle). */
  footstep() {
    if (!this.ok) return;
    this.tone({ freq: 85 + Math.random() * 20, to: 55, duration: 0.08, gain: 0.05, type: 'sine' });
    this.noise({ duration: 0.06, gain: 0.045, type: 'lowpass', from: 280, to: 90 });
  }
}
