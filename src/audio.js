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

const safe = (fn) => (...args) => {
  try { fn(...args); } catch { /* audio is best-effort */ }
};

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
    const f = 523 * Math.pow(2, PENTA[wakaStep] / 12);
    const pan = wakaSide ? 0.22 : -0.22;
    tone({ type: "sine", from: f * 1.35, to: f, dur: 0.07, vol: 0.075, pan, send: 0.12 });
    tone({ type: "triangle", from: f * 2, to: f * 1.9, dur: 0.05, vol: 0.028, pan, send: 0.1 });
    tone({ type: "sine", from: 130, to: 95, dur: 0.06, vol: 0.05, pan: pan * 0.4, send: 0 });
    hiss({ dur: 0.02, vol: 0.014, from: 5200, to: 2800, q: 1.4, pan, send: 0 });
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

  // level clear: rising pentatonic sparkle over a warm swell
  win: safe(() => {
    [523, 659, 784, 1047, 1319].forEach((f, i) =>
      tone({ type: "sine", from: f, dur: 0.22, vol: 0.045, delay: i * 0.09, send: 0.5 }));
    tone({ type: "triangle", from: 262, to: 523, dur: 0.5, vol: 0.03, send: 0.4 });
  }),

  // game start: inviting major-arpeggio bell + soft low root
  start: safe(() => {
    [392, 523, 659, 784].forEach((f, i) =>
      tone({ type: "sine", from: f, dur: 0.2, vol: 0.04, delay: i * 0.11, send: 0.45 }));
    tone({ type: "sine", from: 98, dur: 0.5, vol: 0.04, send: 0.1 });
  }),
};
