/*
 * audio.js — toàn bộ âm thanh được tổng hợp bằng WebAudio, không dùng file âm thanh nào
 * (không dính bản quyền, repo nhẹ). Phải gọi unlock() từ một cử chỉ của người dùng.
 */
(function (root) {
  'use strict';
  let ctx = null, master = null, noiseBuf = null;
  let muted = false, musicOn = true;
  let musicTimer = null, nextBeat = 0, beatIdx = 0, drone = null;

  function unlock() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.8;
      master.connect(ctx.destination);
      const len = ctx.sampleRate * 1.5;
      noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') ctx.resume();
    if (musicOn) startMusic();
    return true;
  }

  // ----- khối dựng sẵn -----
  function env(gainNode, t, a, peak, dur) {
    gainNode.gain.setValueAtTime(0.0001, t);
    gainNode.gain.exponentialRampToValueAtTime(peak, t + a);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }
  function tone(type, f0, f1, dur, vol, t0, dest) {
    if (!ctx) return;
    const t = t0 != null ? t0 : ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    env(g, t, 0.005, vol, dur);
    o.connect(g); g.connect(dest || master);
    o.start(t); o.stop(t + dur + 0.05);
  }
  function noise(dur, vol, filterType, f0, f1, t0, q) {
    if (!ctx) return;
    const t = t0 != null ? t0 : ctx.currentTime;
    const s = ctx.createBufferSource(); s.buffer = noiseBuf;
    s.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter(); f.type = filterType;
    f.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    if (q) f.Q.value = q;
    const g = ctx.createGain(); env(g, t, 0.004, vol, dur);
    s.connect(f); f.connect(g); g.connect(master);
    s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.05);
  }

  // ----- hiệu ứng -----
  const SFX = {
    live() {
      noise(0.6, 1.0, 'lowpass', 5000, 160, 0, 0.7);
      tone('sine', 150, 38, 0.5, 1.0);
      noise(0.12, 0.8, 'highpass', 1500, 1500);
    },
    blank() {
      noise(0.05, 0.5, 'highpass', 3500, 3500);
      tone('square', 1700, 900, 0.04, 0.18);
      noise(0.25, 0.12, 'lowpass', 900, 300, ctx ? ctx.currentTime + 0.02 : 0);
    },
    pump() {
      const t = ctx.currentTime;
      noise(0.07, 0.5, 'bandpass', 1400, 900, t, 3);
      tone('square', 180, 90, 0.06, 0.25, t);
      noise(0.08, 0.55, 'bandpass', 1900, 1100, t + 0.2, 3);
      tone('square', 240, 110, 0.07, 0.25, t + 0.2);
    },
    shell() { tone('triangle', 2600, 1900, 0.09, 0.22); tone('sine', 5200, 4300, 0.05, 0.08); },
    select() { tone('square', 700, 700, 0.03, 0.08); },
    cancel() { tone('square', 420, 300, 0.05, 0.08); },
    deal() { noise(0.06, 0.25, 'bandpass', 800, 500, 0, 2); tone('sine', 220, 160, 0.08, 0.15); },
    whoosh() { noise(0.5, 0.25, 'bandpass', 300, 1800, 0, 1.2); },
    peek() { const t = ctx.currentTime; tone('sine', 880, 880, 0.18, 0.2, t); tone('sine', 1320, 1320, 0.3, 0.15, t + 0.08); },
    cig() { noise(0.5, 0.35, 'bandpass', 3500, 2500, 0, 1.5); tone('sine', 90, 70, 0.25, 0.2); },
    beer() { tone('sine', 300, 120, 0.12, 0.5); noise(0.8, 0.3, 'highpass', 4000, 2500); },
    cuff() { const t = ctx.currentTime; for (let i = 0; i < 3; i++) { tone('triangle', 3000 - i * 300, 2200, 0.05, 0.25, t + i * 0.09); noise(0.04, 0.3, 'highpass', 4000, 4000, t + i * 0.09); } },
    saw() { const t = ctx.currentTime; for (let i = 0; i < 6; i++) { noise(0.1, 0.35, 'bandpass', 1800 + (i % 2) * 500, 1500, t + i * 0.1, 2); tone('sawtooth', 160 + (i % 2) * 40, 150, 0.1, 0.08, t + i * 0.1); } },
    phone() { const t = ctx.currentTime; tone('square', 1400, 1400, 0.08, 0.12, t); tone('square', 1100, 1100, 0.08, 0.12, t + 0.12); tone('square', 1700, 1700, 0.12, 0.12, t + 0.24); },
    invert() { tone('sawtooth', 200, 1200, 0.25, 0.14); tone('sawtooth', 1200, 200, 0.25, 0.14, ctx.currentTime + 0.25); },
    adren() { const t = ctx.currentTime; for (let i = 0; i < 3; i++) { tone('sine', 70, 40, 0.18, 0.8, t + i * 0.28); tone('sine', 60, 35, 0.16, 0.6, t + i * 0.28 + 0.11); } },
    pill() { const t = ctx.currentTime; for (let i = 0; i < 7; i++) noise(0.04, 0.3, 'bandpass', 2500 + Math.random() * 2500, 2500, t + i * 0.055, 4); },
    heal() { const t = ctx.currentTime; [523, 659, 784, 1047].forEach((f, i) => tone('triangle', f, f, 0.2, 0.14, t + i * 0.07)); },
    hurt() { const t = ctx.currentTime; [440, 370, 294, 220].forEach((f, i) => tone('sawtooth', f, f * 0.97, 0.18, 0.1, t + i * 0.09)); },
    win() { const t = ctx.currentTime; [392, 523, 659, 784, 1047].forEach((f, i) => tone('square', f, f, 0.22, 0.1, t + i * 0.11)); },
    lose() { const t = ctx.currentTime; [330, 262, 196, 131].forEach((f, i) => tone('sawtooth', f, f * 0.95, 0.4, 0.1, t + i * 0.2)); },
    turn() { tone('sine', 110, 80, 0.4, 0.35); },
  };

  function play(name) {
    if (!ctx || muted || !SFX[name]) return;
    try { SFX[name](); } catch (e) { /* âm thanh lỗi không được làm hỏng game */ }
  }

  // ----- nhạc nền: tiếng ù + nhịp trầm, rất nhỏ -----
  function startMusic() {
    if (!ctx || musicTimer) return;
    const g = ctx.createGain(); g.gain.value = 0.0001;
    g.gain.exponentialRampToValueAtTime(0.06, ctx.currentTime + 2);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 220;
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
    o1.type = o2.type = 'sawtooth'; o1.frequency.value = 55; o2.frequency.value = 55.4;
    const lfo = ctx.createOscillator(), lg = ctx.createGain();
    lfo.frequency.value = 0.12; lg.gain.value = 60; lfo.connect(lg); lg.connect(lp.frequency);
    o1.connect(lp); o2.connect(lp); lp.connect(g); g.connect(master);
    o1.start(); o2.start(); lfo.start();
    drone = { g, o1, o2, lfo };
    nextBeat = ctx.currentTime + 0.2; beatIdx = 0;
    musicTimer = setInterval(() => {
      while (nextBeat < ctx.currentTime + 0.3) {
        const step = beatIdx % 8, t = nextBeat;
        if (step % 2 === 0) { tone('sine', 120, 42, 0.28, 0.16, t); }
        if (step % 2 === 1) noise(0.05, 0.04, 'highpass', 7000, 7000, t);
        if (step === 6) tone('square', 55, 55, 0.2, 0.035, t);
        beatIdx++; nextBeat += 0.25; // ~120 bpm, nốt 1/8
      }
    }, 80);
  }
  function stopMusic() {
    if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
    if (drone) {
      const d = drone; drone = null;
      try { d.g.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.2); setTimeout(() => { d.o1.stop(); d.o2.stop(); d.lfo.stop(); }, 800); } catch (e) { /* bỏ qua */ }
    }
  }

  function setMuted(m) {
    muted = !!m;
    if (master) master.gain.setTargetAtTime(muted ? 0 : 0.8, ctx.currentTime, 0.05);
  }
  function setMusic(on) {
    musicOn = !!on;
    if (!ctx) return;
    if (musicOn) startMusic(); else stopMusic();
  }

  root.SRAudio = { unlock, play, setMuted, setMusic, isMuted: () => muted, isMusic: () => musicOn };
})(window);
