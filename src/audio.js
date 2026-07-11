// Layered WebAudio synth — modern, juicy arcade sounds, zero assets.
// Everything runs through a master bus: gentle compressor (no clipping, no
// harshness) plus a short damped feedback-delay "air" send, so sounds sit in
// a shared space instead of landing as dry beeps.

let ctx = null;
let master = null;
let sendBus = null; // echo send input
let noiseBuf = null;

function ensureCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.knee.value = 18;
    comp.ratio.value = 5;
    comp.attack.value = 0.002;
    comp.release.value = 0.12;
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(comp);
    comp.connect(ctx.destination);

    // airy echo: delay -> lowpass damp -> feedback, wet into master
    const delay = ctx.createDelay(0.5);
    delay.delayTime.value = 0.16;
    const damp = ctx.createBiquadFilter();
    damp.type = "lowpass";
    damp.frequency.value = 2400;
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    const wet = ctx.createGain();
    wet.gain.value = 0.16;
    sendBus = ctx.createGain();
    sendBus.connect(delay);
    delay.connect(damp);
    damp.connect(fb);
    fb.connect(delay);
    damp.connect(wet);
    wet.connect(master);

    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

// route a voice's tail: dry to master, a slice to the echo send, optional pan
function route(ac, node, pan, send) {
  let out = node;
  if (pan && ac.createStereoPanner) {
    const p = ac.createStereoPanner();
    p.pan.value = pan;
    node.connect(p);
    out = p;
  }
  out.connect(master);
  if (send > 0) {
    const s = ac.createGain();
    s.gain.value = send;
    out.connect(s);
    s.connect(sendBus);
  }
}

// one enveloped oscillator voice
function tone({ type = "sine", from = 440, to = from, dur = 0.15, vol = 0.05,
  attack = 0.004, pan = 0, send = 0.3, delay = 0 }) {
  const ac = ensureCtx();
  const t0 = ac.currentTime + delay;
  const osc = ac.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(Math.max(from, 1), t0);
  if (to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(to, 1), t0 + dur);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(vol, 0.0002), t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g);
  route(ac, g, pan, send);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

// filtered-noise voice (transients, whooshes)
function hiss({ dur = 0.1, vol = 0.03, from = 800, to = 4000, q = 1,
  pan = 0, send = 0.2, delay = 0 }) {
  const ac = ensureCtx();
  const t0 = ac.currentTime + delay;
  const src = ac.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const f = ac.createBiquadFilter();
  f.type = "bandpass";
  f.Q.value = q;
  f.frequency.setValueAtTime(Math.max(from, 1), t0);
  f.frequency.exponentialRampToValueAtTime(Math.max(to, 1), t0 + dur);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(vol, 0.0002), t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f);
  f.connect(g);
  route(ac, g, pan, send);
  src.start(t0);
  src.stop(t0 + dur + 0.05);
}

// bell instrument: inharmonic partials with independent decays — this is what
// makes chimes sound like an instrument instead of a sine beep
function bell(f, dur = 0.6, vol = 0.04, delay = 0, send = 0.5, pan = 0) {
  const partials = [[1, 1], [2, 0.35], [2.76, 0.18], [4.5, 0.07]];
  for (const [m, g] of partials) {
    tone({ type: "sine", from: f * m, dur: dur * (m === 1 ? 1 : 0.55),
      vol: vol * g, delay, send, pan, attack: 0.002 });
  }
}

const safe = (fn) => (...args) => {
  try { fn(...args); } catch { /* audio is best-effort */ }
};

// ------------------------------------------------------------ generative bed
// A quiet, ever-changing music layer on top of the drone: soft pentatonic
// bells wandering while you play, an urgent minor pulse while the wraiths
// are frightened. Scheduled with a small lookahead so timing stays tight.
let moodName = "off";
let musicTimer = null;
let nextNote = 0;
let beat = 0;
const CALM_SCALE = [220, 246.9, 293.7, 329.6, 392, 440, 587.3];
let melIdx = 3;

function scheduleNote(t, step) {
  const rel = Math.max(t - ctx.currentTime, 0);
  beat++;
  if (moodName === "calm") {
    if (Math.random() < 0.4) {
      melIdx = Math.min(CALM_SCALE.length - 1,
        Math.max(0, melIdx + (Math.random() < 0.5 ? -1 : 1)));
      bell(CALM_SCALE[melIdx], 0.55, 0.014, rel, 0.75);
      if (Math.random() < 0.16) {
        bell(CALM_SCALE[melIdx] * 2, 0.4, 0.007, rel + step / 2, 0.9);
      }
    }
    if (beat % 16 === 0) bell(110, 1.2, 0.02, rel, 0.3);
  } else if (moodName === "fright") {
    tone({ type: "triangle", from: beat % 4 < 2 ? 110 : 130.8,
      dur: 0.09, vol: 0.024, delay: rel, send: 0.15 });
    if (beat % 4 === 0) hiss({ dur: 0.03, vol: 0.01, from: 6000, to: 5000, delay: rel });
  }
}

function startMusic() {
  if (musicTimer) return;
  musicTimer = setInterval(() => {
    if (moodName === "off" || !ctx || ctx.state !== "running") return;
    const step = moodName === "fright" ? 0.21 : 0.34;
    const ahead = ctx.currentTime + 0.4;
    if (nextNote < ctx.currentTime - 0.5) nextNote = ctx.currentTime + 0.05;
    while (nextNote < ahead) {
      try { scheduleNote(nextNote, step); } catch { /* best-effort */ }
      nextNote += step;
    }
  }, 120);
}

// Dot-eating is THE sound of the game, so it earns the most design:
// a plucky pop (bright pitch-drop sine + soft octave sparkle + sub thump +
// tiny noise click), alternating gently left/right like waka-waka, and each
// quick successive dot climbs a pentatonic ladder — clearing a corridor
// literally plays a melody. Pause for a beat and the ladder resets.
const PENTA = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24];
let wakaStep = 0;
let lastWaka = 0;
let wakaSide = false;

export const sfx = {
  unlock: safe(() => { ensureCtx(); }),

  waka: safe(() => {
    const ac = ensureCtx();
    const now = ac.currentTime;
    wakaStep = now - lastWaka > 0.45 ? 0 : Math.min(wakaStep + 1, PENTA.length - 1);
    lastWaka = now;
    wakaSide = !wakaSide;
    const drift = 1 + (Math.random() - 0.5) * 0.02; // human micro-variation
    const f = 523 * Math.pow(2, PENTA[wakaStep] / 12) * drift;
    const pan = wakaSide ? 0.24 : -0.24;
    // the pop gets brighter as the combo ladder climbs
    const shine = wakaStep / (PENTA.length - 1);
    tone({ type: "sine", from: f * 1.4, to: f, dur: 0.06, vol: 0.095, pan, send: 0.12 + shine * 0.15 });
    tone({ type: "triangle", from: f * 2, to: f * 1.85, dur: 0.045, vol: 0.032 + shine * 0.02, pan, send: 0.1 });
    tone({ type: "sine", from: 140, to: 88, dur: 0.055, vol: 0.07, pan: pan * 0.4, send: 0 });
    hiss({ dur: 0.018, vol: 0.02 + shine * 0.012, from: 6000, to: 3000, q: 1.4, pan, send: 0 });
    // topping out the ladder earns a tiny victory chime
    if (wakaStep === PENTA.length - 1) bell(2093, 0.3, 0.02, 0, 0.8, pan);
  }),

  // bonus life: rising bell fanfare over a warm root
  extraLife: safe(() => {
    [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => bell(f, 0.4, 0.034, i * 0.07, 0.6));
    tone({ type: "sine", from: 131, dur: 0.7, vol: 0.05, send: 0.15 });
  }),

  // fruit spawn: a heraldic two-note bell so the announcement has a voice
  fruit: safe(() => {
    bell(880, 0.4, 0.04, 0, 0.55);
    bell(1175, 0.5, 0.035, 0.12, 0.6);
  }),

  // fruit collect: rich coin ding + sub reward thump
  fruitCollect: safe(() => {
    bell(1319, 0.35, 0.045, 0, 0.5);
    bell(1760, 0.45, 0.035, 0.08, 0.6);
    tone({ type: "sine", from: 160, to: 70, dur: 0.16, vol: 0.06, send: 0 });
  }),

  // power pellet: warm detuned riser + sub swell + a three-note shimmer
  power: safe(() => {
    tone({ type: "sawtooth", from: 160, to: 340, dur: 0.4, vol: 0.032, send: 0.4 });
    tone({ type: "sawtooth", from: 161.5, to: 344, dur: 0.4, vol: 0.028, send: 0.4 });
    tone({ type: "sine", from: 70, to: 110, dur: 0.45, vol: 0.05, send: 0.1 });
    [523, 659, 784].forEach((f, i) =>
      tone({ type: "sine", from: f, dur: 0.18, vol: 0.03, delay: 0.06 + i * 0.07, send: 0.5 }));
  }),

  // eat ghost: juicy rising zap, sparkle ping on top, sub kick underneath
  eatGhost: safe(() => {
    tone({ type: "square", from: 240, to: 1150, dur: 0.22, vol: 0.035, send: 0.35 });
    tone({ type: "sine", from: 240, to: 1150, dur: 0.22, vol: 0.05, send: 0.3 });
    tone({ type: "sine", from: 1568, dur: 0.14, vol: 0.035, delay: 0.2, send: 0.55 });
    tone({ type: "sine", from: 150, to: 60, dur: 0.18, vol: 0.06, send: 0 });
  }),

  // death: cinematic falling cry + low boom + airy tail
  death: safe(() => {
    tone({ type: "sine", from: 520, to: 110, dur: 1.0, vol: 0.06, send: 0.45 });
    tone({ type: "triangle", from: 524, to: 111, dur: 1.0, vol: 0.035, send: 0.45 });
    tone({ type: "sine", from: 90, to: 40, dur: 0.9, vol: 0.07, delay: 0.15, send: 0.1 });
    hiss({ dur: 0.8, vol: 0.02, from: 2000, to: 300, delay: 0.1, send: 0.4 });
  }),

  // shaft ride: filtered whoosh with a gentle rising chime
  layerShift: safe(() => {
    hiss({ dur: 0.28, vol: 0.035, from: 500, to: 3200, q: 1.1, send: 0.35 });
    tone({ type: "sine", from: 392, to: 660, dur: 0.22, vol: 0.03, send: 0.4 });
  }),

  // level clear: rising bell cascade over a warm swell
  win: safe(() => {
    [523, 659, 784, 1047, 1319].forEach((f, i) => bell(f, 0.45, 0.04, i * 0.09, 0.55));
    tone({ type: "triangle", from: 262, to: 523, dur: 0.5, vol: 0.028, send: 0.4 });
  }),

  // game start: inviting bell arpeggio + soft low root
  start: safe(() => {
    [392, 523, 659, 784].forEach((f, i) => bell(f, 0.45, 0.036, i * 0.11, 0.5));
    tone({ type: "sine", from: 98, dur: 0.6, vol: 0.04, send: 0.1 });
  }),

  // ambient mood bed — "calm" is a barely-there castle drone that breathes,
  // "fright" adds a wobbling tension voice. Crossfaded, never abrupt.
  mood: safe((name) => {
    ensureMood();
    moodName = name;
    startMusic();
    const t = ctx.currentTime;
    moodCalmGain.gain.setTargetAtTime(name === "calm" ? 0.016 : 0, t, 0.5);
    moodFrightGain.gain.setTargetAtTime(name === "fright" ? 0.03 : 0, t, 0.3);
  }),
};

let moodCalmGain = null;
let moodFrightGain = null;

function ensureMood() {
  if (moodCalmGain) return;
  const ac = ensureCtx();

  // calm: detuned sub pair + a faint fifth, breathing on a slow LFO
  moodCalmGain = ctx.createGain();
  moodCalmGain.gain.value = 0;
  const breath = ac.createGain();
  breath.gain.value = 0.75;
  const lfo = ac.createOscillator();
  lfo.frequency.value = 0.12;
  const lfoAmt = ac.createGain();
  lfoAmt.gain.value = 0.22;
  lfo.connect(lfoAmt);
  lfoAmt.connect(breath.gain);
  lfo.start();
  for (const [f, v] of [[55, 1], [55.6, 0.8], [82.4, 0.35]]) {
    const o = ac.createOscillator();
    o.type = "sine";
    o.frequency.value = f;
    const g = ac.createGain();
    g.gain.value = v;
    o.connect(g);
    g.connect(breath);
    o.start();
  }
  breath.connect(moodCalmGain);
  moodCalmGain.connect(master);

  // fright: low square through a slowly wobbling lowpass
  moodFrightGain = ctx.createGain();
  moodFrightGain.gain.value = 0;
  const wob = ac.createOscillator();
  wob.type = "square";
  wob.frequency.value = 98;
  const lp = ac.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 320;
  lp.Q.value = 4;
  const wobLfo = ac.createOscillator();
  wobLfo.frequency.value = 3.1;
  const wobAmt = ac.createGain();
  wobAmt.gain.value = 180;
  wobLfo.connect(wobAmt);
  wobAmt.connect(lp.frequency);
  wobLfo.start();
  wob.connect(lp);
  lp.connect(moodFrightGain);
  moodFrightGain.connect(master);
  wob.start();
}
