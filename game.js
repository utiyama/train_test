'use strict';

// ============================================================
//  CONFIG
// ============================================================
const CFG = {
  canvas: { w: 800, h: 440 },

  proj: {
    horizonY: 185,
    focal:    320,
    camH:     2.2,
    trackHW:  1.55,
  },

  physics: {
    powerAccel: [0, 0.9, 1.7, 2.5, 3.2, 4.0],  // P0〜P5 (km/h/s)
    brakeDecel: [0, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 9.0], // B0〜B8
    maxSpeed: 80,
    coastDecel: 0.18,
    maxPower: 5,
    maxBrake: 8,
  },

  scoring: { perfect: 2, great: 5, good: 10, ok: 20 },

  joint: {
    spacing: 25,
    axleOffsets: [2.05, 4.15, 15.85, 17.95],
  },

  stations: [
    { name: 'さくらえき',          dist: 800  },
    { name: 'はなみずきえき',      dist: 1400 },
    { name: 'もみじだいえき',      dist: 1100 },
    { name: 'あおぞらこうえんえき',dist: 1600 },
    { name: 'おわりのえき',        dist: 900  },
  ],

  // stationIdx = 次に向かっている駅のインデックス
  // offsetFromPrev = その駅の直前の駅(worldPos)からの距離
  signals: [
    { stationIdx: 1, offsetFromPrev:  700, initialState: 'yellow', yellowLimit: 45, changeToGreen: false },
    { stationIdx: 2, offsetFromPrev:  500, initialState: 'red',    yellowLimit: null, changeToGreen: true  },
    { stationIdx: 2, offsetFromPrev:  700, initialState: 'green',  yellowLimit: null, changeToGreen: false },
    { stationIdx: 3, offsetFromPrev:  600, initialState: 'yellow', yellowLimit: 45,   changeToGreen: false },
    { stationIdx: 3, offsetFromPrev: 1100, initialState: 'red',    yellowLimit: null, changeToGreen: true  },
    { stationIdx: 3, offsetFromPrev: 1300, initialState: 'green',  yellowLimit: null, changeToGreen: false },
    { stationIdx: 4, offsetFromPrev:  400, initialState: 'red',    yellowLimit: null, changeToGreen: true  },
    { stationIdx: 4, offsetFromPrev:  600, initialState: 'green',  yellowLimit: null, changeToGreen: false },
  ],

  timing: {
    stopEval: 350,
    doorOpen: 2800,
    departureGrace: 1500,
    signalGreenDelay: 3000,
    signalWarnDuration: 2200,
    stallHintDelay: 5000,
  },
};

// ============================================================
//  WORLD POSITION BUILD
// ============================================================
function buildWorld() {
  // 駅の絶対世界座標
  let acc = 0;
  CFG.stations.forEach(s => { acc += s.dist; s.worldPos = acc; });

  // stationAccum[i] = 区間iの開始座標 (i=0は0m, i=1はstation[0].worldPos, ...)
  const stationAccum = [0, ...CFG.stations.map(s => s.worldPos)];

  // 信号の絶対座標: 区間[stationIdx]の開始 + offset
  // 区間[stationIdx]はstation[stationIdx-1]からstation[stationIdx]へ向かう区間
  // 開始位置 = stationAccum[stationIdx]  (= station[stationIdx-1].worldPos)
  CFG.signals.forEach(sig => {
    sig.worldPos = stationAccum[sig.stationIdx] + sig.offsetFromPrev;
  });
}
buildWorld();

// ============================================================
//  STATE
// ============================================================
const state = {
  phase: 'title',

  speed: 0,
  position: 0,
  prevPosition: 0,

  powerNotch: 0,
  brakeNotch: 0,

  stationIdx: 0,
  totalScore: 0,
  results: [],

  signals: [],

  departureGraceTimer: 0,
  stallTimer: 0,
  signalWarnTimer: 0,
  redSignalGreenScheduled: false,

  confetti: [],
  lastTs: null,
};

// ============================================================
//  AUDIO
// ============================================================
let audioCtx = null;
function getAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}
function playTone(freq, dur, gainVal = 0.28, type = 'sine') {
  try {
    const a = getAudio();
    const osc = a.createOscillator(), g = a.createGain();
    osc.connect(g); g.connect(a.destination);
    osc.type = type; osc.frequency.value = freq;
    g.gain.setValueAtTime(gainVal, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
    osc.start(); osc.stop(a.currentTime + dur);
  } catch (_) {}
}
function playJointThump() {
  try {
    const a = getAudio();
    const dur = 0.12, sr = a.sampleRate;
    const buf = a.createBuffer(1, sr * dur, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      d[i] = (Math.random() * 2 - 1) * Math.exp(-t * 45) * 0.45
            + Math.sin(2 * Math.PI * 82 * t) * Math.exp(-t * 28) * 0.55;
    }
    const src = a.createBufferSource(), g = a.createGain();
    g.gain.value = 0.5; src.buffer = buf;
    src.connect(g); g.connect(a.destination); src.start();
  } catch (_) {}
}
function playBell() {
  playTone(880, 0.25, 0.32);
  setTimeout(() => playTone(1109, 0.4, 0.28), 280);
}
function playArpeggio() {
  [523, 659, 784, 1047].forEach((f, i) =>
    setTimeout(() => playTone(f, 0.28, 0.28), i * 120));
}
function playNotchUp()   { playTone(440, 0.07, 0.13, 'square'); }
function playNotchDown() { playTone(280, 0.07, 0.13, 'square'); }
function playEmergency() { playTone(200, 0.18, 0.38, 'sawtooth'); }

// ============================================================
//  INPUT
// ============================================================
const keys = {};

function notchUp() {
  if (state.phase !== 'running' || state.departureGraceTimer > 0) return;
  if (state.brakeNotch > 0) state.brakeNotch = Math.max(0, state.brakeNotch - 1);
  else                       state.powerNotch = Math.min(CFG.physics.maxPower, state.powerNotch + 1);
  playNotchUp();
}
function notchDown() {
  if (state.phase !== 'running') return;
  if (state.powerNotch > 0) state.powerNotch = Math.max(0, state.powerNotch - 1);
  else                       state.brakeNotch = Math.min(CFG.physics.maxBrake, state.brakeNotch + 1);
  playNotchDown();
}
function emergencyBrake() {
  if (state.phase !== 'running') return;
  state.powerNotch = 0; state.brakeNotch = CFG.physics.maxBrake;
  playEmergency();
}

document.addEventListener('keydown', e => {
  if (keys[e.code]) return; keys[e.code] = true;
  if (e.code === 'ArrowRight' || e.code === 'KeyD') notchUp();
  if (e.code === 'ArrowLeft'  || e.code === 'KeyA') notchDown();
  if (e.code === 'KeyZ') emergencyBrake();
});
document.addEventListener('keyup', e => { keys[e.code] = false; });

const btnIntervals = {};
function setupBtn(id, fn) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('pointerdown', e => {
    e.preventDefault(); fn();
    btnIntervals[id] = setInterval(fn, 200);
  });
  const stop = () => clearInterval(btnIntervals[id]);
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointercancel', stop);
  el.addEventListener('pointerleave', stop);
}
setupBtn('btn-power', notchUp);
setupBtn('btn-brake', notchDown);
setupBtn('btn-emergency', emergencyBrake);

// ============================================================
//  PHYSICS
// ============================================================
function updatePhysics(dt) {
  if (state.departureGraceTimer > 0) state.departureGraceTimer -= dt * 1000;

  const p = CFG.physics;
  let accel = 0;
  if (state.brakeNotch > 0) {
    accel = -p.brakeDecel[state.brakeNotch];
  } else if (state.powerNotch > 0 && state.departureGraceTimer <= 0) {
    accel = p.powerAccel[state.powerNotch];
    const ratio = state.speed / p.maxSpeed;
    if (ratio > 0.8) accel *= (1 - (ratio - 0.8) / 0.2);
  } else {
    accel = -p.coastDecel;
  }

  state.speed = Math.max(0, Math.min(p.maxSpeed, state.speed + accel * dt));
  state.prevPosition = state.position;
  const dm = state.speed * (1 / 3.6) * dt;
  state.position += dm;

  if (state.speed > 0.5) checkJoints(state.prevPosition, state.position);
}

function checkJoints(prev, cur) {
  CFG.joint.axleOffsets.forEach(off => {
    const a = (prev + off) % CFG.joint.spacing;
    const b = (cur  + off) % CFG.joint.spacing;
    if (b < a) playJointThump();
  });
}

// ============================================================
//  SIGNALS
// ============================================================
function initSignals() {
  state.signals = CFG.signals.map(s => ({
    worldPos: s.worldPos,
    state: s.initialState,
    yellowLimit: s.yellowLimit,
    changeToGreen: s.changeToGreen,
    passed: false,
  }));
}

function updateSignals() {
  state.signals.forEach(sig => {
    if (sig.passed) return;
    if (sig.worldPos - state.position > 0) return; // まだ到達していない

    sig.passed = true;
    if (sig.state === 'red') {
      state.totalScore = Math.max(0, state.totalScore - 50);
      showSignalWarning();
      updateScoreHUD();
    } else if (sig.state === 'yellow') {
      if (state.speed > (sig.yellowLimit || 45)) {
        state.totalScore = Math.max(0, state.totalScore - 20);
        showOverlayMsg('⚠ 速度超過！ -20てん', 1800);
        updateScoreHUD();
      } else {
        state.totalScore += 10;
        showOverlayMsg('✅ 注意信号 OK！ +10てん', 1500);
        updateScoreHUD();
      }
    }
  });
}

// 停車時: 近くの赤信号を数秒後に青へ変える
function tryActivateNearbyRedSignal() {
  state.signals.forEach(sig => {
    if (!sig.changeToGreen || sig.passed || sig.state !== 'red') return;
    const dist = sig.worldPos - state.position;
    if (dist > 0 && dist < 12) {
      if (!state.redSignalGreenScheduled) {
        state.redSignalGreenScheduled = true;
        setTimeout(() => {
          sig.state = 'green';
          state.redSignalGreenScheduled = false;
          showOverlayMsg('🟢 信号が変わった！', 2000);
        }, CFG.timing.signalGreenDelay);
      }
    }
  });
}

// ============================================================
//  STOP EVALUATION
// ============================================================
function evaluateStop() {
  const station = CFG.stations[state.stationIdx];
  const offset = Math.abs(state.position - station.worldPos);
  const sc = CFG.scoring;
  let pts, stars, label;

  if (offset <= sc.perfect) { pts = 100; stars = '★★★'; label = 'ぴったり！'; }
  else if (offset <= sc.great) { pts = 70;  stars = '★★';  label = 'すごい！'; }
  else if (offset <= sc.good)  { pts = 40;  stars = '★';   label = 'いいね！'; }
  else if (offset <= sc.ok)    { pts = 10;  stars = '';    label = 'まあまあ'; }
  else                          { pts = 0;   stars = '';    label = 'はしりすぎ！'; }

  state.results.push({ name: station.name, offset: Math.round(offset * 10) / 10, pts, stars });
  state.totalScore += pts;
  updateScoreHUD();
  return { pts, stars, label };
}

// ============================================================
//  CONFETTI
// ============================================================
function spawnConfetti() {
  const colors = ['#ff4444','#ff8800','#ffdd00','#44ff88','#44aaff','#cc44ff','#ff44cc'];
  state.confetti = Array.from({ length: 60 }, () => ({
    x: Math.random() * CFG.canvas.w,
    y: -20 - Math.random() * 40,
    vx: (Math.random() - 0.5) * 120,
    vy: Math.random() * 80 + 50,
    angle: Math.random() * Math.PI * 2,
    spin: (Math.random() - 0.5) * 6,
    color: colors[Math.floor(Math.random() * colors.length)],
    w: 8 + Math.random() * 8, h: 5 + Math.random() * 5,
  }));
}
function updateConfetti(dt) {
  state.confetti.forEach(c => {
    c.x += c.vx * dt; c.y += c.vy * dt; c.vy += 60 * dt; c.angle += c.spin * dt;
  });
  state.confetti = state.confetti.filter(c => c.y < CFG.canvas.h + 30);
}

// ============================================================
//  GAME STATE MACHINE
// ============================================================
function initGame() {
  state.phase = 'running';
  state.speed = 0; state.position = 0; state.prevPosition = 0;
  state.powerNotch = 0; state.brakeNotch = 0;
  state.stationIdx = 0; state.totalScore = 0; state.results = [];
  state.departureGraceTimer = 0; state.stallTimer = 0;
  state.signalWarnTimer = 0; state.redSignalGreenScheduled = false;
  state.confetti = []; state.lastTs = null;
  initSignals();
  hideStopResult(); hideSignalWarning(); hideOverlayMsg();
  updateScoreHUD();
}

function triggerStationStop() {
  state.phase = 'stopped';
  state.speed = 0; state.powerNotch = 0; state.brakeNotch = 0;
  setTimeout(() => {
    const res = evaluateStop();
    showStopResult(res);
    if (res.pts >= 100) playArpeggio(); else playBell();
    state.phase = 'door_open';
    setTimeout(() => {
      hideStopResult();
      state.stationIdx++;
      if (state.stationIdx >= CFG.stations.length) {
        onGameClear();
      } else {
        state.phase = 'running';
        state.departureGraceTimer = CFG.timing.departureGrace;
        state.stallTimer = 0;
        hideOverlayMsg();
      }
    }, CFG.timing.doorOpen);
  }, CFG.timing.stopEval);
}

function onGameClear() {
  state.phase = 'cleared';
  spawnConfetti();
  showClearScreen();
}

// ============================================================
//  GAME LOOP
// ============================================================
function gameLoop(ts) {
  requestAnimationFrame(gameLoop);
  const dt = state.lastTs ? Math.min((ts - state.lastTs) / 1000, 0.1) : 0.016;
  state.lastTs = ts;

  const canvas = document.getElementById('game-canvas');
  const ctx = canvas.getContext('2d');

  if (state.phase === 'running') {
    updatePhysics(dt);
    updateSignals();

    const station = CFG.stations[state.stationIdx];
    const distToStation = station.worldPos - state.position;

    if (distToStation < -20) {
      // 駅を20m以上通過
      triggerStationStop();
    } else if (state.speed === 0) {
      if (Math.abs(distToStation) <= 20) {
        // 駅付近で停止 → 評価
        triggerStationStop();
      } else if (distToStation > 0) {
        // 駅前で停止 (信号待ちなど)
        state.stallTimer += dt * 1000;
        tryActivateNearbyRedSignal();
        if (state.stallTimer > CFG.timing.stallHintDelay) {
          const nearRed = state.signals.some(
            s => !s.passed && s.state === 'red' && s.worldPos - state.position > 0 && s.worldPos - state.position < 15
          );
          showOverlayMsg(nearRed ? '🔴 信号が変わるのを 待って！' : 'パワーをあげよう！ →キー', 0);
        }
      }
    } else {
      // 走行中
      if (state.stallTimer > 0) { state.stallTimer = 0; hideOverlayMsg(); }
      if (distToStation < 100 && distToStation > 0 && state.speed > 40) {
        showOverlayMsg('⚠ ブレーキ！', 0);
      } else if (distToStation > 150 || state.speed < 20) {
        if (document.getElementById('overlay-msg').textContent === '⚠ ブレーキ！')
          hideOverlayMsg();
      }
    }
  }

  if (state.phase === 'cleared') updateConfetti(dt);

  render(ctx);
  updateHUD();

  if (state.signalWarnTimer > 0) {
    state.signalWarnTimer -= dt * 1000;
    if (state.signalWarnTimer <= 0) hideSignalWarning();
  }
}

// ============================================================
//  PERSPECTIVE PROJECTION
// ============================================================
function project(worldX, z) {
  const p = CFG.proj;
  return {
    sx: CFG.canvas.w / 2 + (worldX * p.focal) / z,
    sy: p.horizonY + (p.camH * p.focal) / z,
  };
}

// ============================================================
//  RENDER
// ============================================================
const clouds = Array.from({ length: 7 }, (_, i) => ({
  x: i * 140 + 30 + Math.random() * 60,
  y: 15 + Math.random() * 70,
  r: 28 + Math.random() * 32,
}));

const sceneryItems = [
  { x:   0, w: 58, h:  92 }, { x:  70, w: 44, h: 68 },
  { x: 130, w: 78, h: 112 }, { x: 225, w: 50, h: 80 },
  { x: 300, w: 64, h: 60  }, { x: 385, w: 55, h: 96 },
  { x: 460, w: 70, h: 74  }, { x: 550, w: 88, h: 108 },
  { x: 655, w: 52, h: 66  }, { x: 725, w: 62, h: 88 },
];
const SCENERY_REPEAT = 850;

function render(ctx) {
  const W = CFG.canvas.w, H = CFG.canvas.h, hz = CFG.proj.horizonY;

  // 空
  const skyG = ctx.createLinearGradient(0, 0, 0, hz);
  skyG.addColorStop(0,   '#1a3a6e');
  skyG.addColorStop(0.55,'#3a78c9');
  skyG.addColorStop(1,   '#87ceeb');
  ctx.fillStyle = skyG; ctx.fillRect(0, 0, W, hz);

  // 雲
  const scrollX = state.position * 0.03;
  clouds.forEach(c => {
    const cx = ((c.x - scrollX % (W + 300) + W * 3) % (W + 300)) - 80;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath(); ctx.ellipse(cx, c.y, c.r, c.r * 0.55, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx + c.r * 0.5, c.y + 5, c.r * 0.65, c.r * 0.42, 0, 0, Math.PI * 2); ctx.fill();
  });

  // 遠景ビル
  const scX = state.position * 0.25;
  sceneryItems.forEach(s => {
    [-SCENERY_REPEAT, 0, SCENERY_REPEAT].forEach(off => {
      const dx = ((s.x - scX % SCENERY_REPEAT + SCENERY_REPEAT * 2) % SCENERY_REPEAT) + off - 20;
      if (dx > W + 10 || dx + s.w < -10) return;
      ctx.fillStyle = `hsl(215,${30 + (s.h % 4) * 5}%,${18 + (s.w % 5) * 3}%)`;
      ctx.fillRect(dx, hz - s.h, s.w, s.h);
      ctx.fillStyle = 'rgba(255,240,100,0.35)';
      for (let wy = hz - s.h + 8; wy < hz - 8; wy += 18)
        for (let wx = dx + 6; wx < dx + s.w - 8; wx += 14)
          ctx.fillRect(wx, wy, 7, 10);
    });
  });

  // 地面
  const gndG = ctx.createLinearGradient(0, hz, 0, H);
  gndG.addColorStop(0, '#2d5a1b'); gndG.addColorStop(1, '#1a3a0e');
  ctx.fillStyle = gndG;
  ctx.beginPath(); ctx.moveTo(0, hz); ctx.lineTo(W, hz); ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.fill();

  // バラスト
  const blL = project(-CFG.proj.trackHW - 0.85, 2.5);
  const blR = project( CFG.proj.trackHW + 0.85, 2.5);
  const ballG = ctx.createLinearGradient(0, hz, 0, H);
  ballG.addColorStop(0, '#777'); ballG.addColorStop(1, '#555');
  ctx.fillStyle = ballG;
  ctx.beginPath();
  ctx.moveTo(W / 2 - 1, hz + 1); ctx.lineTo(W / 2 + 1, hz + 1);
  ctx.lineTo(blR.sx, H); ctx.lineTo(blL.sx, H); ctx.fill();

  // 枕木
  const SLEEPER = 0.6, HW = CFG.proj.trackHW + 0.85;
  ctx.strokeStyle = '#5a3a1a';
  for (let z = 2.5; z < 200; z += SLEEPER) {
    const sy = project(0, z).sy;
    if (sy > H + 2) break; if (sy < hz) continue;
    const lx = project(-HW, z).sx, rx = project(HW, z).sx;
    ctx.lineWidth = Math.max(1, CFG.proj.focal / z / 18);
    ctx.beginPath(); ctx.moveTo(lx, sy); ctx.lineTo(rx, sy); ctx.stroke();
  }

  // レール
  [-CFG.proj.trackHW, CFG.proj.trackHW].forEach(wx => {
    const far = project(wx, 500), near = project(wx, 2.5);
    const rG = ctx.createLinearGradient(0, hz, 0, H);
    rG.addColorStop(0, '#888'); rG.addColorStop(1, '#ccc');
    ctx.strokeStyle = rG; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(far.sx, far.sy); ctx.lineTo(near.sx, near.sy); ctx.stroke();
  });

  // プラットフォーム & 停車目標
  if (state.stationIdx < CFG.stations.length) {
    const station = CFG.stations[state.stationIdx];
    const dist = station.worldPos - state.position;
    if (dist < 250 && dist > -30) drawPlatform(ctx, dist, station.name);
    if (dist < 250 && dist > -5)  drawStopMark(ctx, dist);
    if (dist < 350 && dist > 0)   drawApproachArrow(ctx, dist, station.name);
  }

  // 信号機
  drawSignals(ctx);

  // 速度ライン
  if (state.speed > 30) drawSpeedLines(ctx);

  // 紙吹雪
  if (state.phase === 'cleared') drawConfetti(ctx);
}

function drawPlatform(ctx, dist, name) {
  const z1 = Math.max(2.5, dist - 10);
  const z2 = Math.min(250, dist + 60);
  if (z1 >= z2) return;

  const PX = CFG.proj.trackHW + 0.1, PW = 5.5;
  const corners = [project(PX, z1), project(PX + PW, z1), project(PX + PW, z2), project(PX, z2)];

  ctx.fillStyle = '#d4c080';
  ctx.beginPath();
  ctx.moveTo(corners[0].sx, corners[0].sy);
  corners.slice(1).forEach(c => ctx.lineTo(c.sx, c.sy));
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#b8a050'; ctx.lineWidth = 1; ctx.stroke();

  if (z1 < 80) {
    const sz = Math.min(20, Math.max(8, CFG.proj.focal / z1 * 0.22));
    ctx.font = `bold ${sz}px 'Kosugi Maru', sans-serif`;
    ctx.fillStyle = '#333'; ctx.textAlign = 'center';
    const midX = (corners[0].sx + corners[1].sx) / 2;
    ctx.fillText(name, midX, corners[0].sy - 4);
  }
}

function drawStopMark(ctx, dist) {
  const z = Math.max(2.5, dist);
  if (z > 250) return;
  const left = project(-CFG.proj.trackHW - 0.05, z);
  const right = project( CFG.proj.trackHW + 0.05, z);
  ctx.lineWidth = Math.max(1.5, CFG.proj.focal / z / 10);
  ctx.strokeStyle = dist < 15 ? '#ff4444' : '#ffffff';
  ctx.beginPath(); ctx.moveTo(left.sx, left.sy); ctx.lineTo(right.sx, right.sy); ctx.stroke();

  if (z < 130) {
    const mid = (left.sx + right.sx) / 2;
    const sz = Math.max(4, CFG.proj.focal / z / 8);
    ctx.fillStyle = dist < 15 ? '#ff4444' : '#ffffff';
    ctx.beginPath();
    ctx.moveTo(mid - sz, left.sy - sz * 2);
    ctx.lineTo(mid + sz, left.sy - sz * 2);
    ctx.lineTo(mid, left.sy);
    ctx.closePath(); ctx.fill();
  }
}

function drawApproachArrow(ctx, dist, name) {
  const blink = (Math.floor(Date.now() / 400) % 2 === 0);
  const alpha = dist < 50 ? (blink ? 1 : 0.25) : 0.9;
  ctx.save(); ctx.globalAlpha = alpha;
  ctx.font = "bold 18px 'Kosugi Maru', sans-serif";
  ctx.fillStyle = dist < 50 ? '#ff6666' : '#ffdd44';
  ctx.textAlign = 'center';
  ctx.fillText(`▶▶ まもなく「${name}」  あと ${Math.max(0, Math.round(dist))} m ◀◀`, CFG.canvas.w / 2, 24);
  ctx.restore();
}

function drawSignals(ctx) {
  state.signals.forEach(sig => {
    const dist = sig.worldPos - state.position;
    if (dist < 0 || dist > 300) return;
    const z = Math.max(2.5, dist);
    const base = project(CFG.proj.trackHW + 0.6, z);
    const scale = Math.min(1, CFG.proj.focal / z / 12);
    const r = Math.max(2, scale * 10);
    const pillarH = Math.max(3, scale * 30);
    const pillarW = Math.max(1, scale * 4);
    const boxW = r * 2.6, boxH = r * 7;

    ctx.fillStyle = '#666';
    ctx.fillRect(base.sx - pillarW / 2, base.sy - pillarH, pillarW, pillarH);
    ctx.fillStyle = '#222';
    ctx.beginPath();
    // roundRect polyfill: draw as rect if unavailable
    if (ctx.roundRect) {
      ctx.roundRect(base.sx - boxW / 2, base.sy - pillarH - boxH, boxW, boxH, r * 0.3);
    } else {
      ctx.rect(base.sx - boxW / 2, base.sy - pillarH - boxH, boxW, boxH);
    }
    ctx.fill();

    const lights = [
      { color: '#ff2200', on: sig.state === 'red'    },
      { color: '#ffcc00', on: sig.state === 'yellow' },
      { color: '#00ee44', on: sig.state === 'green'  },
    ];
    lights.forEach((l, i) => {
      const ly = base.sy - pillarH - boxH + r + i * r * 2.4;
      ctx.beginPath(); ctx.arc(base.sx, ly, r, 0, Math.PI * 2);
      ctx.fillStyle = l.on ? l.color : '#1a1a1a';
      ctx.fill();
      if (l.on && r > 3) {
        ctx.save(); ctx.shadowColor = l.color; ctx.shadowBlur = r * 3;
        ctx.fill(); ctx.restore();
      }
    });
  });
}

function drawSpeedLines(ctx) {
  const cx = CFG.canvas.w / 2, cy = CFG.proj.horizonY;
  const alpha = Math.min(0.32, (state.speed - 30) / 50 * 0.32);
  ctx.save(); ctx.globalAlpha = alpha; ctx.strokeStyle = '#fff';
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    const len = 50 + Math.random() * 70;
    const ex = cx + Math.cos(a) * CFG.canvas.w * 0.52;
    const ey = cy + Math.sin(a) * CFG.canvas.h * 0.42;
    ctx.lineWidth = 0.4 + Math.random() * 0.8;
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(cx + Math.cos(a) * (CFG.canvas.w * 0.52 - len),
               cy + Math.sin(a) * (CFG.canvas.h * 0.42 - len));
    ctx.stroke();
  }
  ctx.restore();
}

function drawConfetti(ctx) {
  state.confetti.forEach(c => {
    ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(c.angle);
    ctx.fillStyle = c.color; ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
    ctx.restore();
  });
}

// ============================================================
//  HUD
// ============================================================
function updateHUD() {
  document.getElementById('speed-value').textContent = Math.round(state.speed);
  document.getElementById('speed-bar').style.width = (state.speed / CFG.physics.maxSpeed * 100) + '%';

  const pdots = document.getElementById('power-dots');
  pdots.innerHTML = '';
  for (let i = 1; i <= CFG.physics.maxPower; i++) {
    const d = document.createElement('div');
    d.className = 'dot' + (i <= state.powerNotch ? ' power-on' : '');
    pdots.appendChild(d);
  }
  const bdots = document.getElementById('brake-dots');
  bdots.innerHTML = '';
  for (let i = 1; i <= CFG.physics.maxBrake; i++) {
    const d = document.createElement('div');
    d.className = 'dot' + (i <= state.brakeNotch ? ' brake-on' : '');
    bdots.appendChild(d);
  }

  if (state.stationIdx < CFG.stations.length) {
    const station = CFG.stations[state.stationIdx];
    document.getElementById('next-station').textContent = station.name;
    const dist = Math.max(0, Math.round(station.worldPos - state.position));
    const distEl = document.getElementById('dist-value');
    distEl.textContent = dist + ' m';
    distEl.style.color = dist < 50 ? '#ff6666' : dist < 150 ? '#ffcc00' : '#ffd700';
  } else {
    document.getElementById('next-station').textContent = 'ゴール！';
    document.getElementById('dist-value').textContent = '';
  }
}

function updateScoreHUD() {
  document.getElementById('score-value').textContent = state.totalScore;
}

// ============================================================
//  UI HELPERS
// ============================================================
function showStopResult({ pts, stars, label }) {
  document.getElementById('stop-label').textContent = label;
  document.getElementById('stop-stars').textContent = stars;
  document.getElementById('stop-pts').textContent   = '+' + pts + ' てん';
  document.getElementById('stop-result').hidden = false;
}
function hideStopResult()    { document.getElementById('stop-result').hidden = true; }

function showOverlayMsg(msg, dur) {
  const el = document.getElementById('overlay-msg');
  el.textContent = msg; el.hidden = false;
  if (dur > 0) setTimeout(() => { if (el.textContent === msg) el.hidden = true; }, dur);
}
function hideOverlayMsg() { document.getElementById('overlay-msg').hidden = true; }

function showSignalWarning() {
  document.getElementById('signal-warning').hidden = false;
  state.signalWarnTimer = CFG.timing.signalWarnDuration;
}
function hideSignalWarning() { document.getElementById('signal-warning').hidden = true; }

function showClearScreen() {
  const tbody = document.getElementById('score-tbody');
  tbody.innerHTML = '';
  state.results.forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.name}</td><td>${r.offset}m ずれ</td><td>${r.pts}てん</td>`;
    tbody.appendChild(tr);
  });
  document.getElementById('score-total').textContent = state.totalScore + ' てん';
  document.getElementById('final-score-area').hidden = false;
  document.getElementById('title-sub').textContent = 'スコアをみてみよう！';
  document.getElementById('btn-start').hidden = true;
  document.getElementById('title-screen').style.display = 'flex';
}

// ============================================================
//  TITLE / RETRY BUTTONS
// ============================================================
document.getElementById('btn-start').addEventListener('click', () => {
  document.getElementById('title-screen').style.display = 'none';
  initGame();
  requestAnimationFrame(gameLoop);
});
document.getElementById('btn-retry').addEventListener('click', () => {
  document.getElementById('final-score-area').hidden = true;
  document.getElementById('btn-start').hidden = false;
  document.getElementById('title-sub').textContent = 'まちの でんしゃを うんてんしよう！';
  document.getElementById('title-screen').style.display = 'flex';
});

// ============================================================
//  IDLE TITLE CANVAS DRAW
// ============================================================
(function drawIdleCanvas() {
  const canvas = document.getElementById('game-canvas');
  const ctx = canvas.getContext('2d');
  const W = CFG.canvas.w, H = CFG.canvas.h, hz = CFG.proj.horizonY;

  const skyG = ctx.createLinearGradient(0, 0, 0, hz);
  skyG.addColorStop(0, '#1a3a6e'); skyG.addColorStop(1, '#87ceeb');
  ctx.fillStyle = skyG; ctx.fillRect(0, 0, W, hz);

  ctx.fillStyle = '#2d5a1b'; ctx.fillRect(0, hz, W, H - hz);

  const bL = project(-CFG.proj.trackHW - 0.85, 2.5);
  const bR = project( CFG.proj.trackHW + 0.85, 2.5);
  ctx.fillStyle = '#666';
  ctx.beginPath();
  ctx.moveTo(W / 2, hz); ctx.lineTo(W / 2, hz);
  ctx.lineTo(bR.sx, H); ctx.lineTo(bL.sx, H); ctx.fill();

  [-CFG.proj.trackHW, CFG.proj.trackHW].forEach(wx => {
    const far = project(wx, 500), near = project(wx, 2.5);
    ctx.strokeStyle = '#ccc'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(far.sx, far.sy); ctx.lineTo(near.sx, near.sy); ctx.stroke();
  });

  // 停車中プラットフォーム
  state.stationIdx = 0;
  state.position = CFG.stations[0].worldPos - 4;
  drawPlatform(ctx, 4, 'さくらえき');
  drawStopMark(ctx, 4);
  state.position = 0;
})();
