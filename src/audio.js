// Tiny WebAudio synth for arcade blips — no assets needed.
let ctx = null;

function ensureCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

function blip(freqStart, freqEnd, duration, type = "square", volume = 0.06) {
  try {
    const ac = ensureCtx();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freqStart, ac.currentTime);
    osc.frequency.exponentialRampToValueAtTime(Math.max(freqEnd, 1), ac.currentTime + duration);
    gain.gain.setValueAtTime(volume, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + duration);
    osc.connect(gain).connect(ac.destination);
    osc.start();
    osc.stop(ac.currentTime + duration);
  } catch {
    // audio is best-effort
  }
}

let wakaToggle = false;

export const sfx = {
  unlock() { ensureCtx(); },
  waka() {
    wakaToggle = !wakaToggle;
    blip(wakaToggle ? 440 : 330, wakaToggle ? 330 : 440, 0.08, "square", 0.045);
  },
  power() { blip(200, 800, 0.35, "sawtooth", 0.06); },
  eatGhost() { blip(300, 1200, 0.4, "square", 0.07); },
  death() { blip(600, 60, 1.0, "sawtooth", 0.08); },
  layerShift() { blip(500, 900, 0.15, "triangle", 0.05); },
  win() { blip(400, 1600, 0.8, "triangle", 0.07); },
  start() { blip(220, 880, 0.5, "triangle", 0.06); },
};
