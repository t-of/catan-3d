'use strict';
// ルール・盤面・得点計算は engine.js（画面・音を持たない）。イラストの絵の部品は illust.js。
// ここは見た目の組み立てと入力だけ。
import * as E from './engine.js';
import * as I from './illust.js';
import * as CPU from './cpu.js';
import { initBoard3D, renderBoard3D } from './board3d.js';
import {
  createRoom, joinRoom, isValidCode, roomSanitizeName, roomLinkFor, roomCodeFromHash, roomQrSvg,
  GAME, emptySeats, parseSeats, parseSettings, seatMembers, canStart, subSeat, freeSeat, revertSubbedSeats,
  ONLINE_EXPANSIONS,
} from './online.js';

// localStorage はほかのアプリと共有される（同じ t-of.github.io のため）。キーは必ず 'catan-3d.' で始める。
const STORE = 'catan-3d.';
function load(key, fallback) {
  try {
    const v = localStorage.getItem(STORE + key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(STORE + key, JSON.stringify(value)); } catch { /* 保存できなくても遊べる */ }
}

// 盤の動き（波・木・羊など）のオン・オフ。動きを減らす設定の端末では、はじめはオフ。
const motionBtn = document.getElementById('motionBtn');
function setMotion(on) {
  document.documentElement.classList.toggle('motion-off', !on);
  motionBtn.setAttribute('aria-pressed', String(on));
  motionBtn.textContent = on ? '動き オン' : '動き オフ';
  save('motion', on);
}
setMotion(load('motion', !matchMedia('(prefers-reduced-motion: reduce)').matches));
motionBtn.addEventListener('click', () => setMotion(motionBtn.getAttribute('aria-pressed') !== 'true'));

WebAppKit.init({ title: 'catan-3d', text: '六角タイルの盤を three.js の立体で描いた、資源を集めて道・開拓地・都市を建てる交代プレイの試作。' });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

// 音を使うときは、鳴らす前と音の設定を切り替えたときにこれを呼ぶ（RULES.md §5「音」）。
function setAudioSession(soundOn) {
  try { if (navigator.audioSession) navigator.audioSession.type = soundOn ? 'playback' : 'auto'; } catch { /* 対応していない */ }
}
// 音のオン・オフ。既定はオン。els（ゲーム画面）はこのあとで定義されるため、
// 読み込み時はボタンの見た目だけ合わせ、環境音の起動はクリック時と showGame() 側に任せる。
const soundBtn = document.getElementById('soundBtn');
let soundOn = load('sound', true);
soundBtn.setAttribute('aria-pressed', String(soundOn));
soundBtn.textContent = soundOn ? '音 オン' : '音 オフ';
setAudioSession(soundOn);
function setSound(on) {
  soundOn = on;
  soundBtn.setAttribute('aria-pressed', String(on));
  soundBtn.textContent = on ? '音 オン' : '音 オフ';
  save('sound', on);
  setAudioSession(on);
  if (!on) ambientStop(); else if (!els.gamePanel.hidden) ambientStart();
  applyBgm();
}
soundBtn.addEventListener('click', () => setSound(soundBtn.getAttribute('aria-pressed') !== 'true'));
// BGM だけのオン・オフ（音が全体オフのときは、こちらがオンでも鳴らさない）。既定はオン。
const bgmBtn = document.getElementById('bgmBtn');
let bgmOn = load('bgm', true);
bgmBtn.setAttribute('aria-pressed', String(bgmOn));
bgmBtn.textContent = bgmOn ? 'BGM オン' : 'BGM オフ';
function setBgm(on) {
  bgmOn = on;
  bgmBtn.setAttribute('aria-pressed', String(on));
  bgmBtn.textContent = on ? 'BGM オン' : 'BGM オフ';
  save('bgm', on);
  applyBgm();
}
bgmBtn.addEventListener('click', () => setBgm(bgmBtn.getAttribute('aria-pressed') !== 'true'));
let audioCtx = null;
function ctx() {
  if (!audioCtx) { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); setAudioSession(true); }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
// 白色雑音（2秒分）を使い回す。木・石・紙・波・風は、この雑音をフィルタとエンベロープで加工して作る。
let noiseBuf = null;
function noiseBuffer(c) {
  if (noiseBuf && noiseBuf.sampleRate === c.sampleRate) return noiseBuf;
  const len = c.sampleRate * 2;
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  noiseBuf = buf;
  return buf;
}
// 雑音をフィルタに通し、短い音量の山（アタック→減衰）にして鳴らす。
function noiseBurst(c, { filter = 'lowpass', freq = 800, Q = 1, peak = 0.2, attack = 0.002, decay = 0.1, delay = 0 } = {}) {
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c);
  const f = c.createBiquadFilter();
  f.type = filter; f.frequency.value = freq; f.Q.value = Q;
  const g = c.createGain();
  const t0 = c.currentTime + delay;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  src.connect(f).connect(g).connect(c.destination);
  src.start(t0, Math.random() * 1.5);
  src.stop(t0 + attack + decay + 0.05);
}
// 単音（オシレーター）を短い音量の山にして鳴らす。slideTo を渡すと途中で音程を滑らせる。
function tone(c, { freq = 440, type = 'sine', peak = 0.12, attack = 0.005, decay = 0.12, delay = 0, slideTo = null } = {}) {
  const osc = c.createOscillator();
  osc.type = type; osc.frequency.value = freq;
  const g = c.createGain();
  const t0 = c.currentTime + delay;
  if (slideTo != null) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + attack + decay);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  osc.connect(g).connect(c.destination);
  osc.start(t0); osc.stop(t0 + attack + decay + 0.05);
}
// サイコロが板の上で数回転がって止まるカラカラ音（間がだんだん空いて、最後にコトッと収まる）。
function diceRattle() {
  const c = ctx();
  const n = 5 + Math.floor(Math.random() * 2);
  let t = 0;
  for (let i = 0; i < n; i++) {
    noiseBurst(c, { filter: 'bandpass', freq: 1800 + Math.random() * 1200, Q: 2.5, peak: 0.22 * (1 - i / (n + 2)), attack: 0.001, decay: 0.03, delay: t });
    t += 0.045 + i * 0.012;
  }
  noiseBurst(c, { filter: 'lowpass', freq: 300, Q: 0.7, peak: 0.15, attack: 0.002, decay: 0.09, delay: t + 0.02 });
}
// ルーレット中の1コマごとの軽いクリック（diceRattle の一粒だけの版）。
function diceClick() {
  if (!soundOn) return;
  try { noiseBurst(ctx(), { filter: 'bandpass', freq: 1600 + Math.random() * 1000, Q: 3, peak: 0.12, attack: 0.001, decay: 0.025 }); } catch { /* 音が出せなくても遊べる */ }
}
const SOUND = {
  dice: diceRattle,
  build: () => { // 木づち・石を積むコトン（低い芯＋こもった質感）
    const c = ctx();
    tone(c, { freq: 120, type: 'sine', peak: 0.3, attack: 0.001, decay: 0.09 });
    noiseBurst(c, { filter: 'lowpass', freq: 500, Q: 0.8, peak: 0.25, attack: 0.001, decay: 0.07 });
  },
  'buy-dev': () => { // カードをめくるシュッ（ハイパスの周波数を素早く上げる）
    const c = ctx();
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c);
    const f = c.createBiquadFilter();
    f.type = 'highpass';
    const t0 = c.currentTime;
    f.frequency.setValueAtTime(1200, t0);
    f.frequency.exponentialRampToValueAtTime(5000, t0 + 0.09);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.18, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.11);
    src.connect(f).connect(g).connect(c.destination);
    src.start(t0, Math.random()); src.stop(t0 + 0.12);
  },
  trade: () => { // 硬貨のチャリン（金属っぽい高い音を2〜3回ずらして重ねる）
    const c = ctx();
    const notes = [2200, 2800, 2500];
    let t = 0;
    notes.slice(0, 2 + Math.floor(Math.random() * 2)).forEach((f) => {
      tone(c, { freq: f * (0.95 + Math.random() * 0.1), type: 'triangle', peak: 0.1, attack: 0.001, decay: 0.09, delay: t });
      t += 0.06 + Math.random() * 0.03;
    });
  },
  win: () => { // 短いファンファーレ（上がる4音）
    const c = ctx();
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      tone(c, { freq: f, type: 'square', peak: 0.14, attack: 0.003, decay: i === 3 ? 0.3 : 0.12, delay: i * 0.1 });
    });
  },
  shortage: () => { // 鈍いブッ（低い音＋こもった雑音）
    const c = ctx();
    tone(c, { freq: 90, type: 'sine', peak: 0.2, attack: 0.001, decay: 0.08 });
    noiseBurst(c, { filter: 'lowpass', freq: 220, Q: 0.6, peak: 0.15, attack: 0.001, decay: 0.06 });
  },
  myTurn: () => { // 通信対戦: 自分の番になった（やわらかい2音のチャイム）
    const c = ctx();
    tone(c, { freq: 660, type: 'sine', peak: 0.12, attack: 0.005, decay: 0.12 });
    tone(c, { freq: 880, type: 'sine', peak: 0.1, attack: 0.005, decay: 0.16, delay: 0.09 });
  },
  tradeOffered: () => { // 通信対戦: 交換を申し込まれた（コン・コンと軽いノック2回）
    const c = ctx();
    [0, 0.14].forEach((d) => noiseBurst(c, { filter: 'lowpass', freq: 350, Q: 0.7, peak: 0.2, attack: 0.001, decay: 0.05, delay: d }));
  },
  tradeDeclined: () => tone(ctx(), { freq: 180, type: 'sawtooth', peak: 0.14, attack: 0.001, decay: 0.1, slideTo: 120 }), // 通信対戦: 交換がことわられた（低い短いブザー）
  disconnected: () => tone(ctx(), { freq: 220, type: 'sine', peak: 0.12, attack: 0.02, decay: 0.3, slideTo: 140 }), // 通信対戦: だれかが切れた（低くやわらかく消える）
  cutin: () => { // 大きな出来事の帯（最長交易路・騎士団・あと1点・蛮族の襲来など）: 短いファンファーレ
    const c = ctx();
    [700, 880, 1047].forEach((f, i) => tone(c, { freq: f, type: 'triangle', peak: 0.14, attack: 0.003, decay: i === 2 ? 0.22 : 0.1, delay: i * 0.07 }));
  },
};
// 一部の効果音は音源ファイル（sounds/）に差し替え。初めて鳴らすときに読み込みを始め、
// 読み込み前・失敗時はその場面だけ元の合成音（SOUND[name]）で鳴らす。
const SOUND_FILES = {
  win: 'win.mp3', build: 'build.mp3', trade: 'trade.mp3',
  myTurn: 'myTurn.mp3', tradeOffered: 'tradeOffered.mp3', cutin: 'cutin.mp3',
};
const sfxBuffers = {}; // name -> AudioBuffer | null（null は読み込み失敗。未読込は未定義）
let sfxLoadStarted = false;
function loadSfx(c) {
  if (sfxLoadStarted) return;
  sfxLoadStarted = true;
  Object.entries(SOUND_FILES).forEach(([name, file]) => {
    fetch(`./sounds/${file}`).then((r) => r.arrayBuffer()).then((b) => c.decodeAudioData(b))
      .then((buf) => { sfxBuffers[name] = buf; })
      .catch(() => { sfxBuffers[name] = null; });
  });
}
function playBuffer(c, buffer, gain) {
  const src = c.createBufferSource();
  src.buffer = buffer;
  const g = c.createGain(); g.gain.value = gain;
  src.connect(g).connect(c.destination);
  src.start();
}
// SOUND.xxx() は音が出せない環境でも落ちないように、必ずこれ経由で呼ぶ。
function playSound(name) {
  if (!soundOn) return;
  try {
    const c = ctx();
    if (SOUND_FILES[name]) {
      loadSfx(c);
      const buf = sfxBuffers[name];
      if (buf) { playBuffer(c, buf, 0.6); return; }
    }
    if (SOUND[name]) SOUND[name]();
  } catch { /* 音が出せなくても遊べる */ }
}

// 波の環境音（ゲーム画面にいる間だけ、小さい音量でループ）。タブが隠れたら止める。
// 音源ファイル（60秒ループ）を使い、読み込み前・失敗時は鳴らさない（合成音には戻さない）。
let waveBuffer; // AudioBuffer | null（未読込は undefined）
let waveLoadStarted = false;
let ambient = null; // 再生中のノード
let waveWanted = false; // いま鳴らしたい状態かどうか（読み込み待ちの間も覚えておく）
function loadWave(c) {
  if (waveLoadStarted) return;
  waveLoadStarted = true;
  fetch('./sounds/wave.mp3').then((r) => r.arrayBuffer()).then((b) => c.decodeAudioData(b))
    .then((buf) => { waveBuffer = buf; if (waveWanted) ambientStart(); })
    .catch(() => { waveBuffer = null; });
}
function ambientStart() {
  waveWanted = true;
  if (ambient || document.hidden || !soundOn) return;
  try {
    const c = ctx();
    loadWave(c);
    if (!waveBuffer) return; // 読み込み中。届いたら loadWave が呼び直す
    const src = c.createBufferSource();
    src.buffer = waveBuffer; src.loop = true;
    const g = c.createGain(); g.gain.value = 0.05;
    src.connect(g).connect(c.destination);
    src.start();
    ambient = { src, gain: g };
  } catch { /* 音が出せなくても遊べる */ }
}
function ambientStop() {
  waveWanted = false;
  if (!ambient) return;
  try { ambient.src.stop(); } catch { /* 既に止まっている */ }
  ambient = null;
}

// BGM（タイトル・待合室／ゲーム画面）。画面が変わったらクロスフェードで切り替え、
// タブが隠れたら止めて戻ったら再開する。「音」がオフなら鳴らさない。初回のユーザー操作まで待つ
// （ブラウザの自動再生制限のため）。
const BGM_FILES = { title: 'bgm-title.mp3', game: 'bgm-game.mp3' };
const BGM_VOLUME = 0.045; // 効果音より小さめ
const bgmBuffers = {}; // name -> AudioBuffer | null
let bgmLoadStarted = false;
let bgmScreen = 'title'; // いまの画面に合う曲（'title' | 'game'）
let bgmCurrent = null; // { name, src, gain }
let bgmArmed = false; // 初回のユーザー操作が済んだか
function loadBgm(c) {
  if (bgmLoadStarted) return;
  bgmLoadStarted = true;
  Object.entries(BGM_FILES).forEach(([name, file]) => {
    fetch(`./sounds/${file}`).then((r) => r.arrayBuffer()).then((b) => c.decodeAudioData(b))
      .then((buf) => { bgmBuffers[name] = buf; applyBgm(); })
      .catch(() => { bgmBuffers[name] = null; });
  });
}
function bgmFadeOutCurrent(c) {
  if (!bgmCurrent) return;
  const old = bgmCurrent; bgmCurrent = null;
  const g = old.gain.gain;
  g.cancelScheduledValues(c.currentTime); g.setValueAtTime(g.value, c.currentTime);
  g.linearRampToValueAtTime(0, c.currentTime + 0.8);
  try { old.src.stop(c.currentTime + 0.9); } catch { /* 既に止まっている */ }
}
// いまの条件（音・BGMのオン・オフ、タブの表示、画面）に合わせて BGM を合わせ直す。
function applyBgm() {
  if (!bgmArmed) return;
  try {
    const c = ctx();
    const want = (soundOn && bgmOn && !document.hidden) ? bgmScreen : null;
    if (bgmCurrent && bgmCurrent.name === want) return;
    if (!want) { bgmFadeOutCurrent(c); return; }
    loadBgm(c);
    const buf = bgmBuffers[want];
    if (!buf) { bgmFadeOutCurrent(c); return; } // 読み込み中。届いたら loadBgm が呼び直す
    const src = c.createBufferSource();
    src.buffer = buf; src.loop = true;
    const g = c.createGain();
    g.gain.setValueAtTime(0, c.currentTime);
    g.gain.linearRampToValueAtTime(BGM_VOLUME, c.currentTime + 0.8);
    src.connect(g).connect(c.destination);
    src.start();
    bgmFadeOutCurrent(c);
    bgmCurrent = { name: want, src, gain: g };
  } catch { /* 音が出せなくても遊べる */ }
}
function setBgmScreen(name) { bgmScreen = name; applyBgm(); }
function armBgm() {
  if (bgmArmed) return;
  bgmArmed = true;
  applyBgm();
}
document.addEventListener('pointerdown', armBgm, { once: true });
document.addEventListener('keydown', armBgm, { once: true });

document.addEventListener('visibilitychange', () => {
  if (document.hidden) ambientStop(); else if (!els.gamePanel.hidden) ambientStart();
  applyBgm();
});

// ---- DOM ----
const els = {
  setupPanel: document.getElementById('setupPanel'),
  gamePanel: document.getElementById('gamePanel'),
  titleBoard: document.getElementById('titleBoard'),
  playerCountPicker: document.getElementById('playerCountPicker'),
  expansionRow: document.getElementById('expansionRow'),
  expansionPicker: document.getElementById('expansionPicker'),
  expansionNote: document.getElementById('expansionNote'),
  scenarioRow: document.getElementById('scenarioRow'),
  scenarioPicker: document.getElementById('scenarioPicker'),
  seatsPanel: document.getElementById('seatsPanel'),
  startBtn: document.getElementById('startBtn'),
  continueBtn: document.getElementById('continueBtn'),
  mainSetupView: document.getElementById('mainSetupView'),
  onlineBtn: document.getElementById('onlineBtn'),
  onlineResumeBtn: document.getElementById('onlineResumeBtn'),
  onlineNameView: document.getElementById('onlineNameView'),
  onlineNameInput: document.getElementById('onlineNameInput'),
  onlineNameNextBtn: document.getElementById('onlineNameNextBtn'),
  onlineNameBackBtn: document.getElementById('onlineNameBackBtn'),
  onlineChoiceView: document.getElementById('onlineChoiceView'),
  onlineCreateBtn: document.getElementById('onlineCreateBtn'),
  onlineJoinCode: document.getElementById('onlineJoinCode'),
  onlineJoinBtn: document.getElementById('onlineJoinBtn'),
  onlineChoiceError: document.getElementById('onlineChoiceError'),
  onlineChoiceBackBtn: document.getElementById('onlineChoiceBackBtn'),
  onlineLobbyView: document.getElementById('onlineLobbyView'),
  lobbyCode: document.getElementById('lobbyCode'),
  lobbyInviteBtn: document.getElementById('lobbyInviteBtn'),
  lobbyQr: document.getElementById('lobbyQr'),
  lobbyCountRow: document.getElementById('lobbyCountRow'),
  lobbyCountPicker: document.getElementById('lobbyCountPicker'),
  lobbyExpansionRow: document.getElementById('lobbyExpansionRow'),
  lobbyExpansionPicker: document.getElementById('lobbyExpansionPicker'),
  lobbyScenarioRow: document.getElementById('lobbyScenarioRow'),
  lobbyScenarioPicker: document.getElementById('lobbyScenarioPicker'),
  lobbySeats: document.getElementById('lobbySeats'),
  lobbyStartBtn: document.getElementById('lobbyStartBtn'),
  lobbyWaitText: document.getElementById('lobbyWaitText'),
  lobbyLeaveBtn: document.getElementById('lobbyLeaveBtn'),
  hostGoneBar: document.getElementById('hostGoneBar'),
  hostGoneBtn: document.getElementById('hostGoneBtn'),
  turnNum: document.getElementById('turnNum'),
  board: document.getElementById('board'),
  stage: document.getElementById('stage'),
  diceBox: document.getElementById('diceBox'),
  hint: document.getElementById('hint'),
  banner: document.getElementById('banner'),
  playersBar: document.getElementById('playersBar'),
  bankPanel: document.getElementById('bankPanel'),
  ckPanel: document.getElementById('ckPanel'),
  soccerPanel: document.getElementById('soccerPanel'),
  handBar: document.getElementById('handBar'),
  handCount: document.getElementById('handCount'),
  buildGrid: document.getElementById('buildGrid'),
  panelOverlay: document.getElementById('panelOverlay'),
  panel: document.getElementById('panel'),
  actionBar: document.getElementById('actionBar'),
  diceBtn: document.getElementById('diceBtn'),
  tradeBtn: document.getElementById('tradeBtn'),
  devBtn: document.getElementById('devBtn'),
  endTurnBtn: document.getElementById('endTurnBtn'),
  cutinLayer: document.getElementById('cutinLayer'),
  board3dHost: document.getElementById('board3d'),
};
initBoard3D(els.board3dHost, boardTap3D);

const SCALE = 66; // 1マス単位(外接円半径1) → SVG座標のピクセル。illust.js の地形の絵は R=66 に合わせて置いてある。
const RES_LABEL = { wood: '木', brick: '土', sheep: '羊', wheat: '麦', ore: '鉄' };
// 資源の内訳を「木1・麦1」のような短い文にする（通信対戦の交換の申し込みの表示用）
function resSummary(obj) {
  const s = Object.entries(obj).filter(([, n]) => n > 0).map(([r, n]) => `${RES_LABEL[r]}${n}`).join('・');
  return s || 'なし';
}
// 手札の総枚数（実物のカードの枚数なので公開情報。通信対戦でE.viewForが他人の内訳を隠した後は
// p.handCount に入っているので、そちらを使う。自分の席・1台モードでは内訳からそのまま数える）
function handTotal(p) { return p.handCount ?? E.RESOURCES.reduce((a, r) => a + p.resources[r], 0); }
const RES_COLOR = { wood: '#3f8a4a', brick: '#c0643a', sheep: '#8cc063', wheat: '#e0b440', ore: '#8a92a3' };
const PORT_TERRAIN = { wood: 'forest', brick: 'hills', sheep: 'pasture', wheat: 'field', ore: 'mountains' };

// 資源・建物などの小さなアイコン（40x40 の viewBox。svg は CSS の幅・高さで好きな大きさに拡大できる）
function resIcon(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 40 40');
  svg.setAttribute('class', 'res-icon');
  const shapes = [];
  I.resourceIcon(shapes, kind);
  shapes.forEach((s) => svg.appendChild(pathEl(s)));
  return svg;
}
function pathEl(s) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  n.setAttribute('d', s.d);
  n.setAttribute('fill', s.f);
  let st = `opacity:${s.o};stroke:${s.sk};stroke-width:${s.sw}px;stroke-linejoin:round;stroke-linecap:round`;
  if (s.c) {
    n.setAttribute('class', s.c);
    // 盤は操作のたびに描き直すので、ページを開いた時刻からの経過ぶん遅らせて、動きが毎回頭から始まらないようにする
    st += `;transform-origin:${s.ox}px ${s.oy}px;animation-delay:${(s.dl - performance.now() / 1000).toFixed(2)}s`;
  }
  n.setAttribute('style', st);
  return n;
}
function buildIcon(key, color) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 28 28');
  svg.setAttribute('class', 'build-btn__icon');
  const shapes = [];
  const dark = I.tint(color, -0.4), light = I.tint(color, 0.35);
  if (key === 'road') { I.add(shapes, I.line(5, 21, 23, 7), 'none', 1, '#1b1612', 8); I.add(shapes, I.line(5, 21, 23, 7), 'none', 1, color, 4.5); }
  else if (key === 'settlement') I.house(shapes, 14, 17, color, dark, light);
  else if (key === 'city') I.city(shapes, 14, 17, color, dark, light);
  else if (key === 'ship' || key === 'moveShip') I.ship(shapes, 14, 18, key === 'moveShip' ? -20 : 0, color);
  else if (key === 'dev') { I.add(shapes, I.rect(6, 3, 16, 22), '#f6eedb', 1, '#1b1612', 1.5); I.add(shapes, I.rect(9, 6, 10, 10), '#7a5bb8', 0.85); }
  else if (key === 'knight' || key === 'warKnight') I.robber(shapes, 14, 18, 1);
  else if (key === 'wall') { I.add(shapes, I.rect(3, 15, 22, 7), color, 1, '#1b1612', 1.5); I.add(shapes, I.rect(5, 10, 6, 6), color, 1, '#1b1612', 1.2); I.add(shapes, I.rect(13, 10, 6, 6), color, 1, '#1b1612', 1.2); }
  else if (key === 'improve') { I.add(shapes, I.poly([[14, 2], [25, 9], [25, 19], [14, 26], [3, 19], [3, 9]]), I.tint(color, 0.1), 1, '#1b1612', 1.5); }
  shapes.forEach((s) => svg.appendChild(pathEl(s)));
  return svg;
}
function dieEl(value, rotateDeg) {
  const wrap = document.createElement('div');
  wrap.className = 'die';
  wrap.style.setProperty('--r', `${rotateDeg}deg`); // CSSの弾むアニメがこの回転を保ったまま拡大縮小できるように
  wrap.style.transform = `rotate(${rotateDeg}deg)`;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', 40); svg.setAttribute('height', 40); svg.setAttribute('viewBox', '0 0 46 46');
  const PIPS = {
    1: [[23, 23]], 2: [[14, 14], [32, 32]], 3: [[13, 13], [23, 23], [33, 33]],
    4: [[14, 14], [32, 14], [14, 32], [32, 32]], 5: [[13, 13], [33, 13], [23, 23], [13, 33], [33, 33]],
    6: [[14, 12], [32, 12], [14, 23], [32, 23], [14, 34], [32, 34]],
  }[value] || [];
  PIPS.forEach(([x, y]) => {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', 4.2); c.setAttribute('fill', '#2a211b');
    svg.appendChild(c);
  });
  wrap.appendChild(svg);
  return wrap;
}

let game = null;
let robberMovedAt = 0, lastRobberHex = null; // 盗賊が動いた時刻（動いた直後に点滅させる）
let pirateMovedAt = 0, lastPirateHex = null; // 海賊版（航海者版のみ使う）
let diceHitAt = 0, diceHitHexes = []; // サイコロで当たったタイル（振った直後だけ光らせて暗くする）

// ================================================================
// 大きな出来事の帯（カットイン）。最長交易路・最大騎士力・あと1点・蛮族の襲来の勝ち負け。
// playEvents() が呼ばれるたびに、前回の状態（cutinBase）と比べて見つける。engine.js は読むだけ。
// 1台・CPU対局・通信対戦（ホスト・ゲストどちら）でも、持ち回っている game の中身で判断するので同じに動く。
// ================================================================
let cutinBase = null;
let cutinQueue = [];
let cutinShowing = false;
function cutinSnapshot(g) {
  return {
    longestRoad: g.longestRoadPlayer,
    largestArmy: g.largestArmyPlayer,
    nearWin: new Set(g.players.map((_, i) => i).filter((i) => E.playerScore(g, i) >= E.winTargetFor(g, i) - 1)),
    lastLog: g.log[g.log.length - 1],
  };
}
// 「つづきから」読み込み直後・通信の入り直し直後に、前からある状態を取り違えて帯を出さないよう、
// その場の値で基準を作り直す（黙って揃えるだけで、ここでは何も出さない）。
function resetCutinBaseline() {
  cutinBase = game ? cutinSnapshot(game) : null;
  cutinQueue = [];
  cutinShowing = false;
  els.cutinLayer.innerHTML = '';
}
function queueCutin(playerIdx, text) {
  const color = playerIdx == null ? null : game.players[playerIdx].color;
  cutinQueue.push({ text, color });
  playSound('cutin');
  showNextCutin();
}
function showNextCutin() {
  if (cutinShowing || !cutinQueue.length) return;
  cutinShowing = true;
  const item = cutinQueue.shift();
  const bar = document.createElement('div');
  bar.className = 'cutin';
  if (item.color) {
    bar.style.setProperty('--cutin-edge', item.color);
    bar.style.setProperty('--cutin-bg', I.tint(item.color, -0.55));
  }
  const text = document.createElement('div');
  text.className = 'cutin__text';
  text.textContent = item.text;
  bar.appendChild(text);
  els.cutinLayer.appendChild(bar);
  const dismiss = () => {
    if (!bar.isConnected) return;
    bar.classList.remove('is-in'); bar.classList.add('is-out');
    setTimeout(() => { bar.remove(); cutinShowing = false; showNextCutin(); }, 320);
  };
  bar.addEventListener('click', dismiss);
  requestAnimationFrame(() => bar.classList.add('is-in'));
  setTimeout(dismiss, 1800);
}
// 前回との差から、大きな出来事を見つけて帯に積む。cutinBase が無ければ（基準を作る前）何もしない
function detectCutins() {
  if (!cutinBase || !game) return;
  const prev = cutinBase;
  if (game.longestRoadPlayer !== prev.longestRoad && game.longestRoadPlayer != null) {
    queueCutin(game.longestRoadPlayer, `${E.playerName(game, game.longestRoadPlayer)} が最長交易路を${prev.longestRoad != null ? '奪った' : '取った'}！`);
  }
  if (game.largestArmyPlayer !== prev.largestArmy && game.largestArmyPlayer != null) {
    queueCutin(game.largestArmyPlayer, `${E.playerName(game, game.largestArmyPlayer)} が最大騎士力を${prev.largestArmy != null ? '奪った' : '取った'}！`);
  }
  game.players.forEach((p, i) => {
    if (prev.nearWin.has(i) || game.winner === i) return;
    if (E.playerScore(game, i) >= E.winTargetFor(game, i) - 1) {
      prev.nearWin.add(i);
      queueCutin(i, `${E.playerName(game, i)} が勝利まであと1点！`);
    }
  });
  // 都市と騎士の蛮族の襲来は毎回ログに残るので、その差で見る（barbarianAttacked は1回目で true のままになる）。
  // 交易と略奪の「蛮族を退けた」と混ざらないよう、都市と騎士（商品の銀行がある）に限る。
  const seen = game.log.lastIndexOf(prev.lastLog); // 見つからなければ（取り違えを避けて）見ない
  if (game.bank && game.bank.commodities && seen >= 0) {
    // ログは200件で先頭が消えるので、件数でなく「前に見た最後の1行」より後を新しい分とする
    const added = game.log.slice(seen + 1);
    if (added.some((l) => l.includes('蛮族を退け'))) queueCutin(null, '蛮族の襲来！ 守りきった');
    else if (added.some((l) => l.includes('蛮族に敗れ') || l.includes('都市が1つなくなった'))) queueCutin(null, '蛮族の襲来！ 都市が1つ奪われた');
  }
  prev.longestRoad = game.longestRoadPlayer;
  prev.largestArmy = game.largestArmyPlayer;
  prev.lastLog = game.log[game.log.length - 1];
}

// サイコロの合計に応じた盛り上げ（6・8はよく当たる目、7は盗賊、2・12は珍しい目）。
// 「動き オフ」では揺れ・点滅はせず、色の変化だけに留める（音はそのまま鳴らす。7 は音なし）。spinDiceOnce の最後と、
// アニメを出さずに結果だけ反映する経路（通信対戦の自分の番・動き オフ）の両方から呼ぶ。
function applyDiceSumEffects(sum) {
  if (sum == null) return;
  const quiet = document.documentElement.classList.contains('motion-off');
  if (sum === 7) {
    els.stage.classList.add('stage--seven');
    setTimeout(() => els.stage.classList.remove('stage--seven'), quiet ? 500 : 1100);
  } else if (sum === 6 || sum === 8) {
    playSound('myTurn');
    els.diceBox.classList.add('dice--hot');
    setTimeout(() => els.diceBox.classList.remove('dice--hot'), 900);
  } else if ((sum === 2 || sum === 12) && !quiet) {
    els.diceBox.classList.add('dice--rare');
    setTimeout(() => els.diceBox.classList.remove('dice--rare'), 650);
  }
}
let rolling = false; // サイコロを振るアニメの途中。この間は目の表示をアニメに任せる
let playerCount = load('playerCount', 3);
if (![3, 4, 5, 6].includes(playerCount)) playerCount = 3;
let ui = { mode: 'idle', data: {} };
let logOpen = false; // 「出来事の流れ」の一覧を広げているか

// ---- 通信対戦（みんなのスマホで） ----
let onlineRoom = null;          // room.js の Room。1台モードでは null
let onlineMeta = null;          // 部屋の meta（settings・seats は JSON 文字列のまま持つ）
let onlineMembers = {};         // { [uid]: { name, online, joinedAt } }
let onlinePlayerCount = 4;      // 待合で選ぶ人数（3〜6）
let onlineExpansion = 'none';   // 待合で選ぶ拡張（今は「なし」だけ選べる。ONLINE_EXPANSIONS）
let onlineName = load('onlineName', '');
let onlinePendingCode = null;   // リンク（#room=）から開いたときの、まだ入っていないコード
let onlineSeatUids = [];        // meta.seats の uid だけを抜いた列（人の席はuid、CPUの席はnull）。自分の席を引くのに使う
let selfRolledPending = false;  // 通信: 自分がサイコロを振った直後、戻ってきた状態でもう一度回転させないための印
let prevOnlineStatus = null;    // 直前の meta.status（'lobby'→'playing' に変わった瞬間だけ自動で対局画面に進むため）
// 通信対戦: 切断の見張り。uid → 切れたと分かった時刻（オンラインに戻ったら消す）
const OFFLINE_WAIT_MS = 20000;
let offlineSince = {};
function isLongOffline(uid) { return !!uid && offlineSince[uid] != null && Date.now() - offlineSince[uid] >= OFFLINE_WAIT_MS; }
function isOnlineGuest() { return !!(onlineRoom && !onlineRoom.isHost); }
// 20秒の判定は顔ぶれが変わらなくても経つので、時間だけでも見直す（2-5）
setInterval(() => {
  if (!onlineRoom) return;
  renderHostGoneBar();
  if (onlineRoom.isHost) { renderLobby(); if (!els.gamePanel.hidden) renderPlayers(); }
}, 3000);
// 自分（このブラウザのuid）がどの席か。CPU席・座っていない席・1台モードではnull
function mySeatIndex() {
  if (!onlineRoom) return null;
  const i = onlineSeatUids.indexOf(onlineRoom.uid);
  return i === -1 ? null : i;
}

// 通信対戦（段階10）: ホストがgameを配るときは、隠し情報を抜いたものに分ける（E.viewForは仕様2-3）。
// pub=誰の味方でもない公開用、priv=座っている人それぞれの自分の席から見た状態、hostState=ホストが引き継ぐ用の全部入り
function publishGame() {
  const priv = {};
  onlineSeatUids.forEach((uid, seat) => { if (uid) priv[uid] = JSON.stringify(E.viewFor(game, seat)); });
  onlineRoom.publish({
    pub: JSON.stringify(E.viewFor(game, null)),
    priv,
    host: JSON.stringify(game),
  });
}

// ---- 人数選び ----
els.playerCountPicker.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-count]');
  if (!btn) return;
  playerCount = Number(btn.dataset.count);
  save('playerCount', playerCount);
  syncCountPicker();
  renderSeatsPanel();
  syncExpansionPicker();
});
function syncCountPicker() {
  [...els.playerCountPicker.children].forEach((b) => b.classList.toggle('is-selected', Number(b.dataset.count) === playerCount));
}
syncCountPicker();

// ---- 拡張選び（サッカー熱は3〜4人だけ。航海者版・都市と騎士・交易と略奪・探検家と海賊は5〜6人でも選べる） ----
// 他の拡張も、ここに data-expansion の選択肢を足していくだけで並べられる形にする。
const EXPANSIONS_34_ONLY = ['soccer'];
let expansion = load('expansion', 'none');
if (!['none', 'seafarers', 'cities-knights', 'traders-barbarians', 'soccer', 'explorers-pirates'].includes(expansion)) expansion = 'none';
let scenario = load('scenario', 'fishermen');
if (!E.TB_SCENARIOS.includes(scenario)) scenario = 'fishermen';
els.expansionPicker.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-expansion]');
  if (!btn) return;
  expansion = btn.dataset.expansion;
  save('expansion', expansion);
  syncExpansionPicker();
});
els.scenarioPicker.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-scenario]');
  if (!btn) return;
  scenario = btn.dataset.scenario;
  save('scenario', scenario);
  syncExpansionPicker();
});
function syncExpansionPicker() {
  const limited = playerCount >= 5; // 5〜6人は航海者版・都市と騎士だけ選べる
  els.expansionNote.hidden = !limited;
  [...els.expansionPicker.children].forEach((b) => {
    b.hidden = limited && EXPANSIONS_34_ONLY.includes(b.dataset.expansion);
    b.classList.toggle('is-selected', b.dataset.expansion === expansion);
  });
  if (limited && EXPANSIONS_34_ONLY.includes(expansion)) { expansion = 'none'; save('expansion', expansion); }
  els.scenarioRow.hidden = expansion !== 'traders-barbarians';
  [...els.scenarioPicker.children].forEach((b) => b.classList.toggle('is-selected', b.dataset.scenario === scenario));
}
syncExpansionPicker();

// ---- 席ごとの人／CPU選び ----
// uiSeats: タイトル画面で編集中の下書き（4席ぶん持っておき、人数に合わせて先頭から使う）。
// seats: 今プレイ中（続きから、を含む）の対局で実際に使っている席の設定。古い保存（席の情報がない）は全員「人」として引き継ぐ。
function defaultSeat(i) { return { type: i === 0 ? 'human' : 'cpu', level: 'normal', name: '' }; }
// 記号を抜いて10文字までに切る（表示にそのまま出すので、タグになりうる文字は使わせない）
function sanitizeName(s) { return String(s || '').replace(/[<>&"']/g, '').trim().slice(0, 10); }
const SEAT_SLOTS = [0, 1, 2, 3, 4, 5];
let uiSeats = load('seats', null) || SEAT_SLOTS.map(defaultSeat);
if (!Array.isArray(uiSeats) || uiSeats.length < 6) uiSeats = SEAT_SLOTS.map((i) => uiSeats[i] || defaultSeat(i));
let seats = uiSeats.slice(0, playerCount).map((s) => ({ ...s }));

function isCpuSeat(i) { return !!(seats[i] && seats[i].type === 'cpu'); }
function seatLevel(i) { return (seats[i] && seats[i].level) || 'normal'; }

function renderSeatsPanel() {
  els.seatsPanel.innerHTML = '';
  for (let i = 0; i < playerCount; i++) {
    const seat = uiSeats[i];
    const row = document.createElement('div');
    row.className = 'seat-row';
    row.innerHTML = `<input class="seat-row__name" data-i="${i}" maxlength="10" inputmode="text">
      <div class="segmented seat-row__type">
        <button class="btn" data-i="${i}" data-type="human">人</button>
        <button class="btn" data-i="${i}" data-type="cpu">CPU</button>
      </div>
      <div class="segmented seat-row__level"${seat.type === 'cpu' ? '' : ' hidden'}>
        ${CPU.LEVELS.map((l) => `<button class="btn" data-i="${i}" data-level="${l.id}">${l.name}</button>`).join('')}
      </div>`;
    const nameInput = row.querySelector('.seat-row__name');
    nameInput.placeholder = `プレイヤー${i + 1}`;
    nameInput.value = seat.name || '';
    row.querySelector('[data-type="human"]').classList.toggle('is-selected', seat.type === 'human');
    row.querySelector('[data-type="cpu"]').classList.toggle('is-selected', seat.type === 'cpu');
    row.querySelectorAll('[data-level]').forEach((b) => b.classList.toggle('is-selected', b.dataset.level === seat.level));
    els.seatsPanel.appendChild(row);
  }
}
els.seatsPanel.addEventListener('click', (e) => {
  const typeBtn = e.target.closest('[data-type]');
  const levelBtn = e.target.closest('[data-level]');
  if (typeBtn) uiSeats[Number(typeBtn.dataset.i)].type = typeBtn.dataset.type;
  else if (levelBtn) uiSeats[Number(levelBtn.dataset.i)].level = levelBtn.dataset.level;
  else return;
  save('seats', uiSeats);
  renderSeatsPanel();
});
// 名前欄だけは打つたびに作り直すと消えるので、キー入力では再描画せず保存だけする
els.seatsPanel.addEventListener('change', (e) => {
  const input = e.target.closest('.seat-row__name');
  if (!input) return;
  const name = sanitizeName(input.value);
  uiSeats[Number(input.dataset.i)].name = name;
  input.value = name;
  save('seats', uiSeats);
});
renderSeatsPanel();

els.startBtn.addEventListener('click', () => {
  seats = uiSeats.slice(0, playerCount).map((s) => ({ ...s }));
  const allowedForCount = playerCount <= 4 || expansion === 'seafarers' || expansion === 'cities-knights' || expansion === 'traders-barbarians' || expansion === 'explorers-pirates';
  const expansions = allowedForCount && expansion !== 'none' ? [expansion] : [];
  const names = seats.map((s) => s.name);
  game = E.createGame(playerCount, Math.random, { expansions, scenario, names });
  resetCutinBaseline();
  ui = { mode: modeForPhase(), data: {} };
  showGame();
  save('game', game);
  save('gameSeats', seats);
  renderAll();
});
// 古い保存（航海者版より前）には ships・pendingGoldPicks などがないので、引き継ぎで補う
function migrateGame(g) {
  g.winTarget = g.winTarget || 10;
  g.pendingGoldPicks = g.pendingGoldPicks || [];
  g.pendingScienceBonus = g.pendingScienceBonus || [];
  g.shipMovedThisTurn = !!g.shipMovedThisTurn;
  g.players.forEach((p, i) => { p.ships = p.ships || []; p.islandBonus = !!p.islandBonus; p.name = p.name || `プレイヤー${i + 1}`; });
  // 古い保存（交易と略奪より前）には scenario などがないので、「なし」として引き継ぐ
  g.scenario = g.scenario || null;
  g.richPlayer = g.richPlayer ?? null;
  g.oldBootHolder = g.oldBootHolder ?? null;
  // 古い保存の poorPlayer（1人だけ）・fish（数）は、今の形（poorPlayers配列・fishTokens配列）に合わせ直す
  if (g.poorPlayer !== undefined) { g.poorPlayers = g.poorPlayer == null ? [] : [g.poorPlayer]; delete g.poorPlayer; }
  g.poorPlayers = g.poorPlayers || [];
  g.players.forEach((p) => {
    if (typeof p.fish === 'number') { p.fishTokens = []; delete p.fish; }
    if (p.fishTokens === undefined) p.fishTokens = g.scenario === 'fishermen' ? [] : null;
    if (p.gold == null) p.gold = (g.scenario === 'rivers' || g.scenario === 'barbarians') ? 0 : null;
    if (p.goldSpendsThisTurn == null) p.goldSpendsThisTurn = 0;
    if (p.bridges == null) p.bridges = 0;
    if (p.warKnights === undefined) p.warKnights = g.scenario === 'barbarians' ? [] : null;
    if (p.prisoners == null) p.prisoners = 0;
    if (p.pendingCamelBuilds == null) p.pendingCamelBuilds = 0;
    if (p.socShots == null) p.socShots = 0;
    if (p.socPoints == null) p.socPoints = 0;
    if (p.epRevealed === undefined) p.epRevealed = g.explorersPirates ? 0 : null;
  });
  // 古い保存（サッカー熱より前）には soccer がないので、「なし」として引き継ぐ
  g.soccer = !!g.soccer;
  // 古い保存（探検家と海賊より前）には explorersPirates がないので、「なし」として引き継ぐ
  g.explorersPirates = !!g.explorersPirates;
  if (g.epMissionWinner === undefined) g.epMissionWinner = null;
  if (g.soccer) {
    g.soccerDay = g.soccerDay || 1;
    g.soccerMaxDay = g.soccerMaxDay || (g.playerCount === 3 ? 12 : 15);
    g.soccerSeasonOver = !!g.soccerSeasonOver;
    g.pendingSoccerMatch = !!g.pendingSoccerMatch;
    g.soccerLastResult = g.soccerLastResult || null;
  }
  if (g.scenario === 'fishermen') { g.fishBag = g.fishBag || []; g.fishUsed = g.fishUsed || []; }
  // 古い保存は盤の islandHexIds・riverEdgeIds・riverVertexIds が Set のまま JSON を通って {} になっているので、盤から作り直す
  if (g.board.islandHexIds && !Array.isArray(g.board.islandHexIds)) g.board.islandHexIds = E.recoverIslandHexIds(g.board);
  if (g.board.riverEdgeIds && !Array.isArray(g.board.riverEdgeIds)) E.applyRiver(g.board);
  if (g.scenario === 'caravans' && g.board.camelEdgeA !== undefined) {
    // 古い（投票より前の）隊商の保存は、盤の形が変わっているので続きからは諦めて空のキャラバンとして引き継ぐ
    g.board.caravans = g.board.caravans || [[], [], []];
    g.board.oasisHexId = g.board.oasisHexId ?? g.board.camelHexId ?? 0;
    g.board.camelStartEdges = g.board.camelStartEdges || g.board.hexes[g.board.oasisHexId].edgeIds.filter((_, i) => i % 2 === 0);
  }
  return g;
}
els.continueBtn.addEventListener('click', () => {
  const saved = load('game', null);
  if (!saved || saved.winner != null) return;
  game = migrateGame(saved);
  resetCutinBaseline();
  const savedSeats = load('gameSeats', null);
  seats = (savedSeats && savedSeats.length === game.playerCount) ? savedSeats : Array.from({ length: game.playerCount }, () => ({ type: 'human', level: 'normal' }));
  ui = { mode: modeForPhase(), data: {} };
  showGame();
  renderAll();
});
const homeBtn = document.getElementById('homeBtn');
function showGame() { els.setupPanel.hidden = true; els.gamePanel.hidden = false; homeBtn.hidden = false; ambientStart(); setBgmScreen('game'); }

// 続きがあれば「つづきから」を出す（自動では始めない。まずタイトルを見せる）
function showContinue() {
  const saved = load('game', null);
  els.continueBtn.hidden = !(saved && saved.winner == null);
  if (!els.continueBtn.hidden) els.continueBtn.textContent = `つづきから（ターン${saved.turnNumber}）`;
}
showContinue();

// ================================================================
// 通信対戦（みんなのスマホで）。段階4: 待合から「はじめる」で全員に同じ盤が出るところまで。
// 対局中の同期（捨て札・交換など）は段階5。ここではゲストは見るだけ（humansTurn/act で止める）。
// ================================================================
function showSetupView(id) {
  ['mainSetupView', 'onlineNameView', 'onlineChoiceView', 'onlineLobbyView'].forEach((v) => { els[v].hidden = v !== id; });
  // 待合は縦360×640でスクロールなしに収めたいので、タイトルの背景イラスト・ロゴ文字を隠す
  els.setupPanel.classList.toggle('setup--compact', id === 'onlineLobbyView');
}
function refreshOnlineResume() {
  const saved = load('onlineRoom', null);
  els.onlineResumeBtn.hidden = !saved;
  if (saved) els.onlineResumeBtn.textContent = `部屋に戻る（${saved.code}）`;
}
refreshOnlineResume();

async function enterRoom(fn, { isResume = false } = {}) {
  els.onlineChoiceError.textContent = '';
  try {
    const room = await fn();
    onlineRoom = room;
    save('onlineRoom', { v: 1, code: room.code, at: Date.now() });
    wireOnlineRoom();
    showSetupView('onlineLobbyView');
  } catch (err) {
    if (isResume) {
      // 部屋に戻ろうとして失敗＝もう部屋がない。前回の部屋のキーを消す（4「保存するデータ」）
      try { localStorage.removeItem(STORE + 'onlineRoom'); } catch { /* 無視 */ }
      refreshOnlineResume();
      showSetupView('mainSetupView');
      return;
    }
    els.onlineChoiceError.textContent = (err && err.message) || '部屋に入れませんでした';
    showSetupView('onlineChoiceView');
  }
}

async function leaveOnlineRoom() {
  if (!onlineRoom) return;
  // ゲスト自身が抜けるときは、席を片付けてもらうようホストにお願いしてから抜ける（2-5「自分から抜けた」）
  if (!onlineRoom.isHost) { try { await onlineRoom.send('leaveSeat', {}); } catch { /* 無視 */ } }
  try { await onlineRoom.leave(); } catch { /* 無視 */ }
  onlineRoom = null; onlineMeta = null; onlineMembers = {}; offlineSince = {}; prevOnlineStatus = null;
  els.hostGoneBar.hidden = true;
  try { localStorage.removeItem(STORE + 'onlineRoom'); } catch { /* 無視 */ }
  refreshOnlineResume();
}

// ホストだけ: 新しく入ってきた人を空いている人の席に座らせ、CPUに代わってもらっていた人が
// つながり直していたら人の席に戻す（2-5「つなぎ直した」）
function hostSyncSeats() {
  if (!onlineRoom || !onlineRoom.isHost || !onlineMeta) return;
  const count = parseSettings(onlineMeta.settings).playerCount || onlinePlayerCount;
  const before = parseSeats(onlineMeta.seats, count);
  const after = revertSubbedSeats(seatMembers(before, onlineMembers), onlineMembers);
  if (JSON.stringify(after) !== JSON.stringify(before)) onlineRoom.setMeta({ seats: JSON.stringify(after) });
}

// ホストだけ: 届いた「部屋を出る」をあてる。対局中ならその席をCPUに、待合なら席を空ける（2-5）
function hostLeaveSeat(uid) {
  if (!onlineRoom || !onlineRoom.isHost || !onlineMeta) return;
  const count = parseSettings(onlineMeta.settings).playerCount || onlinePlayerCount;
  const arr = parseSeats(onlineMeta.seats, count);
  const i = arr.findIndex((s) => s.type === 'human' && s.uid === uid);
  if (i === -1) return;
  const duringGame = !!(game && game.winner == null && onlineMeta.status === 'playing');
  onlineRoom.setMeta({ seats: JSON.stringify(duringGame ? subSeat(arr, i) : freeSeat(arr, i)) });
}

// ホストだけ: 「CPUに代わってもらう」ボタン（切れて20秒たった席。2-5「ゲストが落ちた」）
function hostSubForDisconnected(uid) {
  if (!onlineRoom || !onlineRoom.isHost || !onlineMeta) return;
  const count = parseSettings(onlineMeta.settings).playerCount || onlinePlayerCount;
  const arr = parseSeats(onlineMeta.seats, count);
  const i = arr.findIndex((s) => s.type === 'human' && s.uid === uid);
  if (i === -1) return;
  onlineRoom.setMeta({ seats: JSON.stringify(subSeat(arr, i)) });
}

// meta.seats（席の持ち主・CPUの強さ）を、画面の isCpuSeat/seatLevel が読む形の `seats` に置きかえる。
// game の中身（JSON）は onState で揃うが、「誰が CPU か」は meta 側にしかないので、ホスト・ゲストとも
// onMeta が来るたびにここで合わせる（でないとゲストの画面だけ CPU 表示がずれる）。
function applySeatsFromMeta(meta) {
  if (!meta) return;
  const count = parseSettings(meta.settings).playerCount || onlinePlayerCount;
  const parsed = parseSeats(meta.seats, count);
  onlineSeatUids = parsed.map((s) => (s.type === 'human' ? (s.uid || null) : null));
  seats = parsed.map((s) => (s.type === 'cpu'
    ? { type: 'cpu', level: s.level || 'normal', name: '', subbed: !!s.subbed, uid: s.uid || null }
    : { type: 'human', level: 'normal', name: s.name || '' }));
}

// つながりの見張り（2-5）。offlineSinceを更新し、切れた瞬間だけ音を鳴らす。host向けの表示・ホストが
// 切れたときの帯も、顔ぶれが変わるたびここで引き直す
function noteMembersOnline(members, prevMembers) {
  const now = Date.now();
  Object.keys(members).forEach((uid) => {
    if (members[uid].online === false) {
      if (!(uid in offlineSince)) {
        offlineSince[uid] = now;
        if (!prevMembers[uid] || prevMembers[uid].online !== false) playSound('disconnected');
      }
    } else {
      delete offlineSince[uid];
    }
  });
}
function renderHostGoneBar() {
  els.hostGoneBar.hidden = !(onlineRoom && !onlineRoom.isHost && onlineMeta && isLongOffline(onlineMeta.hostUid));
}

function wireOnlineRoom() {
  onlineRoom.onMeta((meta) => {
    onlineMeta = meta;
    applySeatsFromMeta(meta);
    // 'lobby'→'playing' に変わった瞬間（新しい対局が始まった・途中から入った）だけ対局画面に進む。
    // 「もう一度」のあと status はずっと 'playing' のままではなく一度 'lobby' を経由するので、
    // 終了後にゲストが自分で待合へ戻っても（gamePanel.hiddenがtrueでも）ここで押し戻されない
    const prevStatus = prevOnlineStatus;
    prevOnlineStatus = meta && meta.status;
    if (meta && meta.status === 'playing' && prevStatus !== 'playing') showGame();
    renderLobby();
    renderHostGoneBar();
  });
  onlineRoom.onMembers((members) => {
    const prevMembers = onlineMembers;
    onlineMembers = members || {};
    noteMembersOnline(onlineMembers, prevMembers);
    hostSyncSeats();
    renderLobby();
    renderHostGoneBar();
    if (!els.gamePanel.hidden) renderPlayers();
  });
  onlineRoom.onPriv((json) => {
    // ホストは自分の手元のgameが正本なので、自分が配った状態のこだまは読み直さない（二重に音を鳴らさないため）。
    // 届くのは自分の席から見た状態（E.viewFor。自分の手札はそのまま、他人は枚数だけ）
    if (onlineRoom.isHost) return;
    const firstState = game == null; // 入ってすぐ・入り直し直後の最初の1通だけ、基準を黙って作り直す
    try { game = JSON.parse(json); } catch { return; }
    if (firstState) resetCutinBaseline();
    ui = { mode: modeForPhase(), data: {} };
    const skipSpin = selfRolledPending;
    selfRolledPending = false;
    const dicedEvt = game.events.includes('dice');
    const hadDice = !skipSpin && dicedEvt && !document.documentElement.classList.contains('motion-off');
    if (hadDice) spinDiceOnce(() => { playEvents(); renderAll(); }, game.diceLast);
    else {
      playEvents(); renderAll();
      // アニメなしで結果だけ届いた分（動き オフ・自分で振った分の折り返し）も、合計の演出は出す
      if (dicedEvt && game.diceLast) applyDiceSumEffects(game.diceLast[0] + game.diceLast[1]);
    }
  });
  if (onlineRoom.isHost) onlineRoom.onAction(({ uid, name, args }) => hostApplyAction(uid, name, args));
}

// ---- 通信対戦: ホストが届いた操作を当てる（2-2の表どおり確かめてからengineを呼ぶ） ----
// 手番の人だけができる操作（送り主の席がE.actingPlayerと一致するか確かめる）
const ONLINE_TURN_ACTIONS = new Set([
  'rollDice', 'buildRoad', 'buildSettlement', 'buildCity', 'buyDevCard',
  'bankTrade', 'moveRobber', 'endTurn', 'passSpecialBuild',
  'setupPlaceSettlement', 'setupPlaceRoad',
  'playYearOfPlenty', 'playMonopoly', 'playRoadBuilding',
  'buildShip', 'moveShip', // 航海者版・探検家と海賊（同じengine関数を使う）
  'improveCity', 'buildWall', 'buildKnight', 'activateKnight', 'upgradeKnight',
  'moveKnight', 'expelKnight', 'chaseRobber', 'playProgressCard', 'tradeCommodity', // 都市と騎士
  'fishRobberAway', 'fishSteal', 'fishResource', 'fishRoad', 'fishDevCard', 'giveOldBoot', // 交易と略奪・漁師
  'tradeGold', 'tradeResourceForGold', // 交易と略奪・川
  'placeCamel', 'buildWarKnight', 'moveWarKnight', 'resolveBarbarianSteal', // 交易と略奪・隊商/蛮族の襲撃
]);
// 手番と関係なく、自分の分を片付ける操作（席番号は信用せず、ホストが送り主から引いた席で上書きする）
const ONLINE_SELF_ACTIONS = new Set(['discardCards', 'pickGold', 'pickScienceBonus', 'submitCamelBid']);
// 交換の申し込み・返事・とりさげ（段階6）。送り主の確かめ方が上の2つと違うので別扱い（2-2の表の「交換の返事」）
const ONLINE_TRADE_ACTIONS = new Set(['offerTrade', 'answerTrade', 'withdrawTrade']);
function hostApplyAction(uid, name, rawArgs) {
  if (name === 'leaveSeat') { hostLeaveSeat(uid); return; } // 待合・対局中どちらでも受ける（2-5）
  if (!game || game.winner != null) return;
  const seat = onlineSeatUids.indexOf(uid);
  if (seat === -1) return; // 席の持ち主でない（表の「どれでもない」）
  const args = Array.isArray(rawArgs) ? rawArgs.slice() : [];
  if (ONLINE_TRADE_ACTIONS.has(name)) {
    applyTradeAction(seat, name, args);
  } else {
    if (ONLINE_TURN_ACTIONS.has(name)) {
      if (seat !== E.actingPlayer(game)) return; // 自分の番でないのに押した／なりすまし
    } else if (ONLINE_SELF_ACTIONS.has(name)) {
      args[0] = seat; // 自分の席番号は送らせない。ホストが入れる
    } else {
      return; // 表にない操作は捨てる
    }
    if (typeof E[name] !== 'function') return;
    const ok = E[name](game, ...args);
    if (ok === false || ok == null) return; // engine 自身が断った（資源が足りない、置けない場所など）
    if (game.tradeOffer) game.tradeOffer = null; // 手番の人がほかの操作をしたら、申し込みは自動で消える
  }
  ui = { mode: modeForPhase(), data: {} };
  playEvents();
  persistAndRender();
}

// 交換の申し込み・受ける・ことわる・とりさげ。tradeOfferはengineの外、catan側の追加項目（ホストだけが書き換える）
function applyTradeAction(seat, name, args) {
  if (name === 'offerTrade') {
    if (seat !== E.actingPlayer(game) || game.phase !== 'main' || game.tradeOffer) return; // 1度に1件・手番の人だけ
    const [to, give, get] = args;
    if (typeof to !== 'number' || to === seat || !game.players[to] || !give || !get) return;
    game.tradeOffer = { id: Date.now(), from: seat, to, give, get };
    game.log.push(`${game.players[seat].name}が${game.players[to].name}に交易を申し込みました`);
    game.events.push('tradeOffered');
    if (isCpuSeat(to)) resolveTradeOffer(CPU.acceptTrade(game, to, give, get, seatLevel(to)));
  } else if (name === 'withdrawTrade') {
    if (game.tradeOffer && seat === game.tradeOffer.from) game.tradeOffer = null;
  } else if (name === 'answerTrade') {
    if (game.tradeOffer && seat === game.tradeOffer.to) resolveTradeOffer(!!args[0]);
  }
}
// 申し込みの返事を当てる。受けるときは、その時点でも手番・資源が足りるかengineが確かめる
function resolveTradeOffer(accept) {
  const offer = game.tradeOffer;
  if (!offer) return;
  if (accept && E.currentPlayer(game) === offer.from && E.playerTrade(game, offer.to, offer.give, offer.get)) {
    game.log.push(`${game.players[offer.to].name}が交易を受けました`);
    game.events.push('trade');
  } else if (accept) {
    game.log.push(`${game.players[offer.to].name}との交易は成立しませんでした`); // 受けた時点で資源が足りなかった等
    game.events.push('tradeDeclined');
  } else {
    game.log.push(`${game.players[offer.to].name}は交易を断りました`);
    game.events.push('tradeDeclined');
  }
  game.tradeOffer = null;
}

function renderLobby() {
  if (!onlineRoom) return;
  els.lobbyCode.textContent = onlineRoom.code;
  if (els.lobbyQr.dataset.code !== onlineRoom.code) {
    els.lobbyQr.innerHTML = roomQrSvg(onlineRoom.code);
    els.lobbyQr.dataset.code = onlineRoom.code;
  }
  if (!onlineMeta) return;
  const settings = parseSettings(onlineMeta.settings);
  const count = settings.playerCount || onlinePlayerCount;
  const expansion = settings.expansion || 'none';
  const scenario = E.TB_SCENARIOS.includes(settings.scenario) ? settings.scenario : 'fishermen';
  const lobbySeatsArr = parseSeats(onlineMeta.seats, count);
  els.lobbyCountRow.hidden = !onlineRoom.isHost;
  [...els.lobbyCountPicker.children].forEach((b) => b.classList.toggle('is-selected', Number(b.dataset.count) === count));
  els.lobbyExpansionRow.hidden = !onlineRoom.isHost;
  els.lobbyExpansionPicker.innerHTML = '';
  ONLINE_EXPANSIONS.forEach((x) => {
    const b = document.createElement('button');
    b.className = 'btn' + (x.id === expansion ? ' is-selected' : '');
    b.textContent = x.ready ? x.name : `${x.name}・準備中`;
    b.dataset.expansion = x.id;
    b.disabled = !x.ready;
    els.lobbyExpansionPicker.appendChild(b);
  });
  els.lobbyScenarioRow.hidden = !onlineRoom.isHost || expansion !== 'traders-barbarians';
  [...els.lobbyScenarioPicker.children].forEach((b) => b.classList.toggle('is-selected', b.dataset.scenario === scenario));
  els.lobbySeats.innerHTML = '';
  lobbySeatsArr.forEach((seat, i) => {
    const row = document.createElement('div');
    row.className = 'seat-row';
    const label = document.createElement('span');
    label.className = 'seat-row__name';
    if (seat.type === 'cpu') label.textContent = `CPU・${CPU.LEVELS.find((l) => l.id === seat.level)?.name || 'ふつう'}`;
    else if (seat.uid) {
      const member = onlineMembers[seat.uid];
      const suffix = (seat.uid === onlineRoom.uid) ? '（自分）' : (member && member.online === false ? '・切断中' : '');
      label.textContent = (seat.name || '名無し') + suffix;
    } else label.textContent = '待っています…';
    row.appendChild(label);
    if (onlineRoom.isHost) {
      if (seat.type === 'human' && !seat.uid) {
        const cpuBtn = document.createElement('button');
        cpuBtn.className = 'btn btn--small'; cpuBtn.textContent = 'CPUにする';
        cpuBtn.dataset.i = i; cpuBtn.dataset.act = 'toCpu';
        row.appendChild(cpuBtn);
      } else if (seat.type === 'cpu') {
        const humanBtn = document.createElement('button');
        humanBtn.className = 'btn btn--small'; humanBtn.textContent = '人にする';
        humanBtn.dataset.i = i; humanBtn.dataset.act = 'toHuman';
        row.appendChild(humanBtn);
        const levels = document.createElement('div');
        levels.className = 'segmented seat-row__level';
        CPU.LEVELS.forEach((l) => {
          const b = document.createElement('button');
          b.className = 'btn' + (l.id === seat.level ? ' is-selected' : '');
          b.textContent = l.name; b.dataset.i = i; b.dataset.act = 'level'; b.dataset.level = l.id;
          levels.appendChild(b);
        });
        row.appendChild(levels);
      } else if (seat.type === 'human' && seat.uid && isLongOffline(seat.uid)) {
        const subBtn = document.createElement('button');
        subBtn.className = 'btn btn--small'; subBtn.textContent = 'CPUに代わってもらう';
        subBtn.dataset.i = i; subBtn.dataset.act = 'subCpu';
        row.appendChild(subBtn);
      }
    }
    els.lobbySeats.appendChild(row);
  });
  const ready = canStart(lobbySeatsArr);
  els.lobbyStartBtn.hidden = !onlineRoom.isHost;
  els.lobbyStartBtn.disabled = !ready;
  els.lobbyWaitText.hidden = onlineRoom.isHost;
}

els.onlineBtn.addEventListener('click', () => {
  els.onlineNameInput.value = onlineName;
  showSetupView('onlineNameView');
});
els.onlineResumeBtn.addEventListener('click', () => {
  const saved = load('onlineRoom', null);
  if (!saved) return;
  onlineName = load('onlineName', '') || onlineName;
  enterRoom(() => joinRoom(saved.code, { game: GAME, name: onlineName || '名無し' }), { isResume: true });
});
els.onlineNameBackBtn.addEventListener('click', () => { onlinePendingCode = null; showSetupView('mainSetupView'); });
els.onlineNameNextBtn.addEventListener('click', () => {
  onlineName = roomSanitizeName(els.onlineNameInput.value) || '名無し';
  save('onlineName', onlineName);
  if (onlinePendingCode) {
    const code = onlinePendingCode; onlinePendingCode = null;
    enterRoom(() => joinRoom(code, { game: GAME, name: onlineName }));
  } else {
    showSetupView('onlineChoiceView');
  }
});
els.onlineCreateBtn.addEventListener('click', () => {
  enterRoom(() => createRoom({
    game: GAME, name: onlineName,
    settings: { playerCount: onlinePlayerCount, expansion: onlineExpansion },
    seats: emptySeats(onlinePlayerCount),
  }));
});
els.onlineJoinBtn.addEventListener('click', () => {
  const code = els.onlineJoinCode.value.trim().toUpperCase();
  if (!isValidCode(code)) { els.onlineChoiceError.textContent = '部屋コードが違います'; return; }
  enterRoom(() => joinRoom(code, { game: GAME, name: onlineName }));
});
els.onlineChoiceBackBtn.addEventListener('click', () => showSetupView('mainSetupView'));

els.lobbyCountPicker.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-count]');
  if (!btn || !onlineRoom || !onlineRoom.isHost || !onlineMeta) return;
  const count = Number(btn.dataset.count);
  onlinePlayerCount = count;
  const prevSettings = parseSettings(onlineMeta.settings);
  const before = parseSeats(onlineMeta.seats, prevSettings.playerCount || 4);
  const resized = Array.from({ length: count }, (_, i) => before[i] || { type: 'human', uid: null, name: '' });
  onlineRoom.setMeta({
    settings: JSON.stringify({ playerCount: count, expansion: prevSettings.expansion || 'none', scenario: prevSettings.scenario }),
    seats: JSON.stringify(resized),
  });
});
els.lobbyExpansionPicker.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-expansion]');
  if (!btn || btn.disabled || !onlineRoom || !onlineRoom.isHost || !onlineMeta) return;
  const prevSettings = parseSettings(onlineMeta.settings);
  onlineExpansion = btn.dataset.expansion;
  onlineRoom.setMeta({ settings: JSON.stringify({ playerCount: prevSettings.playerCount || onlinePlayerCount, expansion: onlineExpansion, scenario: prevSettings.scenario }) });
});
els.lobbyScenarioPicker.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-scenario]');
  if (!btn || !onlineRoom || !onlineRoom.isHost || !onlineMeta) return;
  const prevSettings = parseSettings(onlineMeta.settings);
  onlineRoom.setMeta({ settings: JSON.stringify({ playerCount: prevSettings.playerCount || onlinePlayerCount, expansion: prevSettings.expansion || 'none', scenario: btn.dataset.scenario }) });
});
els.lobbySeats.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn || !onlineRoom || !onlineRoom.isHost || !onlineMeta) return;
  const count = parseSettings(onlineMeta.settings).playerCount || onlinePlayerCount;
  const lobbySeatsArr = parseSeats(onlineMeta.seats, count);
  const i = Number(btn.dataset.i);
  if (btn.dataset.act === 'toCpu') lobbySeatsArr[i] = { type: 'cpu', level: 'normal' };
  else if (btn.dataset.act === 'toHuman') lobbySeatsArr[i] = { type: 'human', uid: null, name: '' };
  else if (btn.dataset.act === 'level') lobbySeatsArr[i].level = btn.dataset.level;
  else if (btn.dataset.act === 'subCpu') { onlineRoom.setMeta({ seats: JSON.stringify(subSeat(lobbySeatsArr, i)) }); return; }
  onlineRoom.setMeta({ seats: JSON.stringify(lobbySeatsArr) });
});
els.lobbyStartBtn.addEventListener('click', () => {
  if (!onlineRoom || !onlineRoom.isHost || !onlineMeta) return;
  const startSettings = parseSettings(onlineMeta.settings);
  const count = startSettings.playerCount || onlinePlayerCount;
  const lobbySeatsArr = parseSeats(onlineMeta.seats, count);
  if (!canStart(lobbySeatsArr)) return;
  seats = lobbySeatsArr.map((s) => (s.type === 'cpu'
    ? { type: 'cpu', level: s.level || 'normal', name: '' }
    : { type: 'human', level: 'normal', name: s.name || '' }));
  const names = seats.map((s) => s.name);
  // readyな拡張だけ使う（準備中のボタンはクリックできない）。交易と略奪はシナリオも送る（それ以外はnullのままでよい）
  const exp = startSettings.expansion;
  const expansions = (exp && exp !== 'none' && ONLINE_EXPANSIONS.find((x) => x.id === exp && x.ready)) ? [exp] : [];
  const scenario = exp === 'traders-barbarians' && E.TB_SCENARIOS.includes(startSettings.scenario) ? startSettings.scenario : null;
  game = E.createGame(count, Math.random, { expansions, scenario, names });
  resetCutinBaseline();
  ui = { mode: modeForPhase(), data: {} };
  onlineRoom.setMeta({ status: 'playing' });
  publishGame();
  showGame();
  renderAll();
});
els.lobbyInviteBtn.addEventListener('click', () => {
  if (!onlineRoom) return;
  const link = roomLinkFor(onlineRoom.code);
  WebAppKit.share({ text: `カタンの部屋 ${onlineRoom.code} に来てね`, url: link });
});
els.lobbyLeaveBtn.addEventListener('click', async () => {
  await leaveOnlineRoom();
  showSetupView('mainSetupView');
});
// ホストが切れて20秒たつと出す帯。最初に押した人が新しいホストになる（2-5「ホストが落ちた」）
els.hostGoneBtn.addEventListener('click', async () => {
  if (!onlineRoom || onlineRoom.isHost) return;
  try { await onlineRoom.takeOver(); } catch { return; } // rules がだめなら何もせず終わる（もう誰かが引き継いだ等）
  els.hostGoneBar.hidden = true;
  // それまでの自分の画面は自分の席から見た状態（他人の手札は枚数だけ）だったので、続きを動かす前に
  // 全部入り（hostState。前のホストが最後に書いたもの）に入れ替える
  if (game) {
    try { const full = await onlineRoom.fetchHostState(); if (full) { game = JSON.parse(full); resetCutinBaseline(); } } catch { /* 読めなければ今の画面のまま続ける */ }
  }
  onlineRoom.onAction(({ uid, name, args }) => hostApplyAction(uid, name, args));
  renderLobby();
  if (game) { ui = { mode: modeForPhase(), data: {} }; renderAll(); } // CPUと操作の箱を回し始める
});

// リンク（#room=ABCD）で開いたら、名前を聞いてからその部屋に直接入る
const hashRoomCode = roomCodeFromHash(location.hash);
if (hashRoomCode) {
  onlinePendingCode = hashRoomCode;
  history.replaceState(null, '', location.pathname + location.search);
  els.onlineNameInput.value = onlineName;
  showSetupView('onlineNameView');
}

// タイトルへ戻る。盤は操作のたびに保存済みなので「つづきから」で戻れる（通信対戦では部屋を出る）
homeBtn.addEventListener('click', () => {
  if (rolling) return;
  clearTimeout(cpuTimer); cpuTimer = null;
  closePanel();
  game = null;
  resetCutinBaseline();
  els.gamePanel.hidden = true; els.setupPanel.hidden = false; homeBtn.hidden = true;
  ambientStop(); setBgmScreen('title');
  if (onlineRoom) { leaveOnlineRoom(); showSetupView('mainSetupView'); }
  else showContinue();
});

function modeForPhase() {
  if (!game) return 'idle';
  if (game.phase === 'setup1' || game.phase === 'setup2') return game.setupPending === 'road' ? 'setupRoad' : 'setupSettlement';
  if (game.phase === 'discard') return 'discard';
  if (game.phase === 'goldPick') return 'goldPick';
  if (game.phase === 'scienceBonus') return 'scienceBonus';
  if (game.phase === 'moveRobber') return 'moveRobber';
  return 'idle';
}

// ルールを書き換える操作は、必ずここを通す（通信対戦の送り口をここ1つにまとめるため）。
// 1台モード・通信のホストは engine の同じ名前の関数をその場で呼ぶ（ホストは自分の分もここで直接呼んでよい。
// humansTurn が自分の席の番かを先に確かめているので、ここでは二重に確かめない）。
// 通信のゲストは room.send でホストにお願いし、戻ってくる状態（onState）を待つ。
function act(name, args) {
  if (isOnlineGuest()) { onlineRoom.send(name, args || []); return true; }
  if (onlineRoom && ONLINE_TRADE_ACTIONS.has(name)) { applyTradeAction(mySeatIndex(), name, args || []); return true; }
  return E[name](game, ...(args || []));
}

// 通信対戦では catan.game に保存しない（1台モードの「つづきから」を消さないため）。
// ホストは操作のたびに部屋へ配る。events/gains はゲスト側で鳴らすため、配り終えるまで空にしない
// （playEvents がホストでは splice せず残す。ここで配り終えてから空にする）。ゲストは onPriv 側で処理する。
function persistAndRender() {
  if (onlineRoom) {
    if (onlineRoom.isHost) {
      publishGame();
      game.events.length = 0;
      game.gains = [];
    }
  } else save('game', game);
  renderAll();
}

function playEvents() {
  if (!game) return;
  detectCutins();
  // ホストは配り終える（persistAndRender）までevents/gainsを残す。ゲストと1台モードはここで使い切る
  const hostHold = onlineRoom && onlineRoom.isHost;
  const evts = hostHold ? game.events.slice() : game.events.splice(0, game.events.length);
  evts.forEach((e) => playSound(e));
  if (lastRobberHex != null && game.board.robberHex !== lastRobberHex) {
    robberMovedAt = Date.now();
    setTimeout(() => { if (game) renderAll(); }, 3100); // 点滅を止める
  }
  lastRobberHex = game.board.robberHex;
  if (game.board.pirateHex != null && lastPirateHex != null && game.board.pirateHex !== lastPirateHex) {
    pirateMovedAt = Date.now();
    setTimeout(() => { if (game) renderAll(); }, 3100);
  }
  lastPirateHex = game.board.pirateHex;
  if (evts.includes('dice') && game.diceLast) {
    const hits = E.hitHexIds(game, game.diceLast[0] + game.diceLast[1]);
    if (hits.length) {
      diceHitHexes = hits; diceHitAt = performance.now();
      setTimeout(() => { if (game) renderAll(); }, 1600); // 点滅・暗転を止める
    }
  }
  flyGains(hostHold ? (game.gains || []).slice() : (game.gains || []).splice(0));
}

// もらった資源を、マスから手札（手番の人）かプレイヤー欄（ほかの人）へ飛ばす。
// 手番の人には、もらった資源に「+N」も手札の上に出す
function flyGains(gains) {
  if (!gains.length || document.documentElement.classList.contains('motion-off')) return;
  const ctm = els.board.getScreenCTM();
  if (!ctm) return;
  const cur = handSeatIndex();
  const gainTotals = {};
  gains.forEach((gn) => { if (gn.player === cur) gainTotals[gn.res] = (gainTotals[gn.res] || 0) + gn.amt; });
  Object.entries(gainTotals).forEach(([res, amt]) => {
    const cell = els.handBar.children[E.RESOURCES.indexOf(res)];
    if (!cell) return;
    const badge = document.createElement('span');
    badge.className = 'gain-badge';
    badge.textContent = `+${amt}`;
    cell.appendChild(badge);
    badge.addEventListener('animationend', () => badge.remove());
  });
  gains.forEach((gn, k) => {
    const [hx, hy] = hexCenterPx(game, game.board.hexes[gn.hex]);
    const from = new DOMPoint(hx, hy).matrixTransform(ctm);
    const target = gn.player === cur ? els.handBar.children[E.RESOURCES.indexOf(gn.res)] : els.playersBar.children[gn.player];
    if (!target) return;
    const r = target.getBoundingClientRect();
    for (let n = 0; n < gn.amt; n++) {
      const icon = resIcon(gn.res);
      icon.classList.add('fly-res');
      icon.style.left = `${from.x - 16}px`; icon.style.top = `${from.y - 16}px`;
      document.body.appendChild(icon);
      const dx = r.left + r.width / 2 - from.x, dy = r.top + r.height / 2 - from.y;
      icon.animate([
        { transform: 'translate(0, 0) scale(0.4)', opacity: 0 },
        { transform: 'translate(0, -24px) scale(1.3)', opacity: 1, offset: 0.25 },
        { transform: `translate(${dx}px, ${dy}px) scale(0.8)`, opacity: 0.9 },
      ], { duration: 900, delay: (k + n) * 120, easing: 'cubic-bezier(.5,0,.4,1)', fill: 'backwards' }).finished
        .then(() => icon.remove(), () => icon.remove());
    }
  });
}

// ================================================================
// CPU の自動進行。人が追えるよう、手ごとに少し間をあけて1手ずつ進める（cpu.js の公開関数だけを呼ぶ）。
// ================================================================
// CPU の速さ。テストプレイ用に速くできる（ヘッダーのボタンで順に切り替え）。
const CPU_SPEEDS = [['ふつう', 650], ['はやい', 150], ['最速', 0]];
const cpuSpeedBtn = document.getElementById('cpuSpeedBtn');
let cpuSpeed = load('cpuSpeed', 0);
if (!CPU_SPEEDS[cpuSpeed]) cpuSpeed = 0;
function showCpuSpeed() { cpuSpeedBtn.textContent = 'CPU ' + CPU_SPEEDS[cpuSpeed][0]; }
showCpuSpeed();
cpuSpeedBtn.addEventListener('click', () => {
  cpuSpeed = (cpuSpeed + 1) % CPU_SPEEDS.length;
  save('cpuSpeed', cpuSpeed);
  showCpuSpeed();
});
let cpuTimer = null;
// 次にCPUがすべきこと（捨て札はcurrentPlayerと無関係に、席がCPUの人から片付ける）を1つ返す。無ければ人の番。
function nextCpuJob() {
  if (!game || game.winner != null) return null;
  if (game.phase === 'discard') {
    const d = game.pendingDiscards.find((x) => isCpuSeat(x.player));
    return d ? { kind: 'discard', player: d.player } : null;
  }
  if (game.phase === 'goldPick') {
    const d = game.pendingGoldPicks.find((x) => isCpuSeat(x.player));
    return d ? { kind: 'goldPick', player: d.player } : null;
  }
  if (game.phase === 'scienceBonus') {
    const p = game.pendingScienceBonus.find((x) => isCpuSeat(x));
    return p != null ? { kind: 'scienceBonus', player: p } : null;
  }
  return isCpuSeat(E.actingPlayer(game)) ? { kind: 'step' } : null;
}
function scheduleCpu() {
  if (isOnlineGuest()) return; // CPU はホストの端末だけが回す
  if (cpuTimer || !game) return;
  const job = nextCpuJob();
  if (!job) return;
  cpuTimer = setTimeout(() => {
    cpuTimer = null;
    if (job.kind === 'discard') CPU.discardFor(game, job.player, seatLevel(job.player));
    else if (job.kind === 'goldPick') CPU.pickGoldFor(game, job.player);
    else if (job.kind === 'scienceBonus') CPU.pickScienceBonusFor(game, job.player);
    else CPU.step(game, seatLevel(E.actingPlayer(game)));
    ui = { mode: modeForPhase(), data: {} };
    playEvents();
    persistAndRender();
    scheduleCpu();
  }, CPU_SPEEDS[cpuSpeed][1]);
}

// ================================================================
// 盤面の描画（タイトルの飾りと、ゲーム中の盤の両方をこの関数で描く）
// illust.js の図形（パス文字列と塗り色）をゲームの状態（タイル・道・建物・盗賊・置ける場所）に
// 合わせて並べ、<path>・<text> として SVG に足す。<defs>（タイルのグラデーション）だけは
// 毎回の再描画で消さずに使い回す。
// ================================================================
const svgNS = 'http://www.w3.org/2000/svg';
function el(tag, attrs, parent) {
  const n = document.createElementNS(svgNS, tag);
  Object.entries(attrs || {}).forEach(([k, v]) => n.setAttribute(k, v));
  if (parent) parent.appendChild(n);
  return n;
}
function ensureDefs(svg) {
  let defs = svg.querySelector('defs');
  if (!defs) { defs = el('defs', {}); defs.innerHTML = I.defsMarkup(svg.id); svg.appendChild(defs); }
  return defs;
}

function hexCenterPx(g, hex) {
  const vs = hex.vertexIds.map((id) => g.board.vertices[id]);
  const cx = vs.reduce((a, v) => a + v.x, 0) / vs.length;
  const cy = vs.reduce((a, v) => a + v.y, 0) / vs.length;
  return [cx * SCALE, cy * SCALE];
}
function hexPointsPx(g, hex) {
  return hex.vertexIds.map((id) => { const v = g.board.vertices[id]; return [v.x * SCALE, v.y * SCALE]; });
}
function viewBoxOf(g) {
  const xs = g.board.vertices.map((v) => v.x * SCALE);
  const ys = g.board.vertices.map((v) => v.y * SCALE);
  const margin = SCALE * 1.15;
  const minX = Math.min(...xs) - margin, maxX = Math.max(...xs) + margin;
  const minY = Math.min(...ys) - margin, maxY = Math.max(...ys) + margin;
  return { minX, minY, w: maxX - minX, h: maxY - minY };
}

function renderBoardInto(svg, g, uiState) {
  const defs = ensureDefs(svg);
  [...svg.children].forEach((c) => { if (c !== defs) c.remove(); });
  const idx = E.currentPlayer(g);
  const vb = viewBoxOf(g);
  svg.setAttribute('viewBox', `${vb.minX} ${vb.minY} ${vb.w} ${vb.h}`);

  const S = []; // 塗りの図形（順に描く）
  const labels = []; // 文字
  const overlay = []; // タップ判定・盤ハイライトの実要素（色の図形より後に乗せる）
  const queue = (tag, attrs) => overlay.push({ tag, attrs });

  // 波（飾り。毎回同じ並びでよい）
  for (let k = 0; k < 26; k++) {
    const x = vb.minX + ((k * 137 + 40) % Math.max(1, vb.w));
    const y = vb.minY + ((k * 71 + 20) % Math.max(1, vb.h));
    I.add(S, `M${x},${y} q7,-5 14,0 t14,0`, 'none', 0.18, '#bfe6ee', 1.5);
    I.tag(S, S.length - 1, 'a-wave', x, y, -k * 0.6);
  }

  // 浅瀬と砂浜のふち
  const allHexPath = g.board.hexes.map((h) => I.poly(hexPointsPx(g, h))).join(' ');
  I.add(S, allHexPath, '#5fb7b5', 0.25, '#5fb7b5', 66);
  I.tag(S, S.length - 1, 'a-surf', 0, 0, 0);
  I.add(S, allHexPath, '#e7d3a1', 1, '#e7d3a1', 30);
  I.add(S, allHexPath, '#cdb683', 1, '#cdb683', 12);

  // タイル本体
  g.board.hexes.forEach((hex) => {
    const [cx, cy] = hexCenterPx(g, hex);
    const pts = hexPointsPx(g, hex);
    const shownTerrain = hex.fog ? 'fog' : hex.terrain;
    const style = I.TERRAIN_STYLE[shownTerrain];
    const shrink = (p, k) => p.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]);
    I.add(S, I.poly(shrink(pts, 0.98)), style.edge);
    I.add(S, I.poly(shrink(pts, 0.94)), `url(#${svg.id}-g-${style.grad})`);
    I.add(S, I.poly(shrink(pts, 0.88)), 'none', 0.22, '#ffffff', 1.5);
    I.terrainDecor(S, shownTerrain, cx, cy);
    if (hex.number != null && !hex.fog) {
      const hot = hex.number === 6 || hex.number === 8;
      I.add(S, I.ell(cx + 1, cy + 3, 19, 19), '#000', 0.28);
      I.add(S, I.ell(cx, cy, 18, 18), `url(#${svg.id}-g-token)`, 1, '#c7b58b', 1.2);
      labels.push({ x: cx, y: cy - 3, t: String(hex.number), f: hot ? '#b8321f' : '#2a211b', s: hot ? 21 : 19, w: 700 });
      const dots = 6 - Math.abs(7 - hex.number);
      for (let d = 0; d < dots; d++) I.add(S, I.ell(cx - (dots - 1) * 2.4 + d * 4.8, cy + 10, 1.3, 1.3), hot ? '#b8321f' : '#2a211b');
    }
    // サッカー熱: 置き換えたサッカー場ぶんのチップを足した2枚目の数字チップ
    if (hex.number2 != null) {
      const nx = cx + 24, ny = cy - 16;
      I.add(S, I.ell(nx + 1, ny + 2, 12, 12), '#000', 0.28);
      I.add(S, I.ell(nx, ny, 11, 11), `url(#${svg.id}-g-token)`, 1, '#c7b58b', 1);
      labels.push({ x: nx, y: ny + 3, t: String(hex.number2), f: '#2a211b', s: 12, w: 700 });
    }
  });

  // 港（銀行との交換レートの札）
  g.board.portEdgeIds.forEach((eId) => {
    const e = g.board.edges[eId];
    const v1 = g.board.vertices[e.v1], v2 = g.board.vertices[e.v2];
    const mx = (v1.x + v2.x) / 2 * SCALE, my = (v1.y + v2.y) / 2 * SCALE;
    // 札は、マスの両どなりの辺を海へ延ばした線が交わる所（辺を底にした正三角形の頂点）に置く
    const [hx, hy] = hexCenterPx(g, g.board.hexes[e.hexIds[0]]);
    const nx = mx - hx, ny = my - hy, len = Math.hypot(nx, ny) || 1;
    const px = mx + (nx / len) * (SCALE * Math.sqrt(3) / 2), py = my + (ny / len) * (SCALE * Math.sqrt(3) / 2);
    const type = v1.port;
    const isAny = type === '3:1';
    const bg = isAny ? '#f6eedb' : RES_COLOR[type];
    // 実物と同じく、使える2つの角それぞれから桟橋を出す
    [v1, v2].forEach((v) => {
      I.add(S, I.line(v.x * SCALE, v.y * SCALE, px, py), 'none', 1, '#6e5436', 7);
      I.add(S, I.line(v.x * SCALE, v.y * SCALE, px, py), 'none', 1, '#9a7a52', 3);
    });
    I.add(S, I.ell(px, py + 2, 18, 18), '#000', 0.25);
    I.add(S, I.ell(px, py, 18, 18), '#f6eedb', 1, isAny ? '#b9a980' : bg, 3);
    labels.push({ x: px, y: isAny ? py : py - 4, t: isAny ? '3:1' : '2:1', f: '#2a211b', s: 13, w: 700 });
    if (!isAny) labels.push({ x: px, y: py + 8, t: RES_LABEL[type], f: bg, s: 10, w: 700 });
  });

  // 交易と略奪: 漁場（外周の3つの頂点のまん中あたりに出目の札）。湖の出目は盤の中の湖タイルに4つ出す
  if (g.board.fisheries) {
    g.board.fisheries.forEach((fsh) => {
      const vs = fsh.vertices.map((vid) => g.board.vertices[vid]);
      const mx = vs.reduce((a, v) => a + v.x, 0) / vs.length * SCALE;
      const my = vs.reduce((a, v) => a + v.y, 0) / vs.length * SCALE;
      const [hx, hy] = hexCenterPx(g, g.board.hexes[0]);
      const nx = mx - hx, ny = my - hy, len = Math.hypot(nx, ny) || 1;
      const px = mx + (nx / len) * (SCALE * 0.55), py = my + (ny / len) * (SCALE * 0.55);
      I.add(S, I.ell(px, py + 2, 15, 15), '#000', 0.25);
      I.add(S, I.ell(px, py, 15, 15), '#dff3f4', 1, '#2a8aa0', 2.5);
      labels.push({ x: px, y: py, t: String(fsh.number), f: '#114f62', s: 13, w: 700 });
    });
  }
  const lakeHex = g.board.hexes.find((h) => h.terrain === 'lake');
  if (lakeHex) {
    const [cx, cy] = hexCenterPx(g, lakeHex);
    [[-20, -18], [20, -18], [-20, 18], [20, 18]].forEach(([dx, dy], i) => {
      I.add(S, I.ell(cx + dx, cy + dy, 13, 13), '#dff3f4', 1, '#2a8aa0', 2);
      labels.push({ x: cx + dx, y: cy + dy, t: String(lakeHex.lakeNumbers[i]), f: '#114f62', s: 11, w: 700 });
    });
  }
  // 交易と略奪: 川（真ん中の列を横切る水色の帯。橋を架けないと道を通せない）
  if (g.board.riverEdgeIds) {
    g.board.riverEdgeIds.forEach((eId) => {
      const e = g.board.edges[eId];
      const v1 = g.board.vertices[e.v1], v2 = g.board.vertices[e.v2];
      const x1 = v1.x * SCALE, y1 = v1.y * SCALE, x2 = v2.x * SCALE, y2 = v2.y * SCALE;
      I.add(S, I.line(x1, y1, x2, y2), 'none', 0.9, '#1d6e86', 11);
      I.add(S, I.line(x1, y1, x2, y2), 'none', 0.6, '#bfe6ee', 4);
    });
  }
  // サイコロの当たり演出: 当たったタイルの縁を光らせて点滅させ、当たっていないタイルを暗くする。
  // 道・建物より下に描き、描き直しても点滅が頭から始まらないよう振った時刻で遅らせる
  if (svg === els.board && diceHitHexes.length && performance.now() < diceHitAt + 1500) {
    g.board.hexes.forEach((hex) => {
      if (!diceHitHexes.includes(hex.id)) I.add(S, I.poly(hexPointsPx(g, hex)), '#000', 0.35);
    });
    const n = S.length;
    diceHitHexes.forEach((id) => I.add(S, I.poly(hexPointsPx(g, g.board.hexes[id])), 'none', 1, '#fff6c8', 6));
    I.tag(S, n, 'tile-hit-blink', 0, 0, diceHitAt / 1000);
  }
  // 交易と略奪: 隊商のラクダ（オアシスから伸びる3本のキャラバンを黄土色の帯で表す）
  if (g.board.caravans) {
    g.board.caravans.forEach((chain) => {
      chain.forEach((eId) => {
        const e = g.board.edges[eId];
        const v1 = g.board.vertices[e.v1], v2 = g.board.vertices[e.v2];
        I.add(S, I.line(v1.x * SCALE, v1.y * SCALE, v2.x * SCALE, v2.y * SCALE), 'none', 0.9, '#caa34a', 9);
      });
    });
  }
  // 交易と略奪: 蛮族の襲撃の騎士（辺の上に小さな駒として置く）
  if (g.board.castleHexId != null) {
    g.players.forEach((pl) => {
      (pl.warKnights || []).forEach((k) => {
        const e = g.board.edges[k.edgeId];
        const v1 = g.board.vertices[e.v1], v2 = g.board.vertices[e.v2];
        const x = (v1.x + v2.x) / 2 * SCALE, y = (v1.y + v2.y) / 2 * SCALE;
        I.add(S, I.ell(x, y, 9, 9), pl.color, 1, '#1b1612', 1.6);
      });
    });
  }
  // 交易と略奪: 蛮族の襲撃（砦・沿岸マスの蛮族の数。征服されたマスは暗く表示）
  if (g.board.castleHexId != null) {
    g.board.hexes.forEach((hex) => {
      if (hex.id === g.board.castleHexId) return;
      if (hex.conquered) {
        const pts = hexPointsPx(g, hex);
        I.add(S, I.poly(pts), '#1a1410', 0.45);
      }
      if (hex.barbarians > 0) {
        const [cx, cy] = hexCenterPx(g, hex);
        I.add(S, I.ell(cx, cy - 26, 11, 11), '#2b1d10', 1, '#120c06', 1.2);
        labels.push({ x: cx, y: cy - 26, t: String(hex.barbarians), f: '#f0cf85', s: 12, w: 700 });
      }
    });
  }

  // 道・船（既存＋置ける/動かせる場所）
  const buildableEdges = uiState && (uiState.mode === 'setupRoad' || uiState.mode === 'buildRoad' || uiState.mode === 'buildShip' || uiState.mode === 'devRoad1' || uiState.mode === 'devRoad2'
    || uiState.mode === 'progressEdge1' || uiState.mode === 'progressEdge2' || uiState.mode === 'buildWarKnight' || uiState.mode === 'fishRoadPick')
    ? new Set(edgeChoices()) : new Set();
  const pickableShips = uiState && uiState.mode === 'moveShip1' ? new Set(E.movableShipEdges(g, idx)) : new Set();
  const shipTargets = uiState && uiState.mode === 'moveShip2' ? new Set(E.availableShipEdges(g, idx)) : new Set();
  const pickableKnights = uiState && uiState.mode === 'moveWarKnight1'
    ? new Set(g.players[idx].warKnights.filter((k) => E.movableWarKnightEdges(g, idx, k.id, false).length).map((k) => k.edgeId)) : new Set();
  const knightTargets = uiState && uiState.mode === 'moveWarKnight2'
    ? new Set(E.movableWarKnightEdges(g, idx, uiState.data.knightId, false)) : new Set();
  g.board.edges.forEach((edge) => {
    const v1 = g.board.vertices[edge.v1], v2 = g.board.vertices[edge.v2];
    const x1 = v1.x * SCALE, y1 = v1.y * SCALE, x2 = v2.x * SCALE, y2 = v2.y * SCALE;
    const tx1 = x1 + (x2 - x1) * 0.1, ty1 = y1 + (y2 - y1) * 0.1;
    const tx2 = x1 + (x2 - x1) * 0.9, ty2 = y1 + (y2 - y1) * 0.9;
    if (edge.ship != null) {
      const color = g.players[edge.ship].color;
      const mx = (tx1 + tx2) / 2, my = (ty1 + ty2) / 2;
      const ang = Math.atan2(ty2 - ty1, tx2 - tx1) * 180 / Math.PI;
      I.ship(S, mx, my, ang, color);
      if (pickableShips.has(edge.id)) queue('line', { x1, y1, x2, y2, class: 'road-hit', 'data-edge': edge.id });
    } else if (edge.road != null) {
      const color = g.players[edge.road].color;
      I.add(S, I.line(tx1 + 1, ty1 + 3, tx2 + 1, ty2 + 3), 'none', 0.3, '#000', 10);
      I.add(S, I.line(tx1, ty1, tx2, ty2), 'none', 1, '#1b1612', 10);
      I.add(S, I.line(tx1, ty1, tx2, ty2), 'none', 1, color, 6);
      I.add(S, I.line(tx1, ty1 - 1, tx2, ty2 - 1), 'none', 0.35, '#ffffff', 1.5);
    } else if (buildableEdges.has(edge.id) || shipTargets.has(edge.id) || knightTargets.has(edge.id)) {
      I.add(S, I.line(tx1, ty1, tx2, ty2), 'none', 1, '#1b1612', 9);
      I.add(S, I.line(tx1, ty1, tx2, ty2), 'none', 0.85, 'var(--accent)', 5);
      queue('line', { x1, y1, x2, y2, class: 'road-hit', 'data-edge': edge.id });
    } else {
      if (pickableKnights.has(edge.id)) queue('line', { x1, y1, x2, y2, class: 'road-hit', 'data-edge': edge.id });
      queue('line', { x1, y1, x2, y2, stroke: 'rgba(255,255,255,0.14)', 'stroke-width': 2.5 });
    }
  });

  // 頂点（開拓地・都市・置ける場所）
  const buildableVerts = uiState && (uiState.mode === 'setupSettlement' || uiState.mode === 'buildSettlement')
    ? new Set(vertexChoices())
    : uiState && uiState.mode === 'buildCity' ? new Set(E.availableCityVertices(g, idx))
    : uiState && uiState.mode === 'buildKnight' ? new Set(E.availableKnightVertices(g, idx))
    : uiState && uiState.mode === 'progressVertex' ? new Set(E.availableKnightVertices(g, idx))
    : uiState && uiState.mode === 'moveKnightTo' ? new Set(E.movableKnightVertices(g, idx, uiState.data.knightId))
    : new Set();
  g.board.vertices.forEach((v) => {
    const x = v.x * SCALE, y = v.y * SCALE;
    if (v.building) {
      const color = g.players[v.building.owner].color;
      const dark = I.tint(color, -0.4), light = I.tint(color, 0.35);
      if (v.building.type === 'city') I.city(S, x, y, color, dark, light);
      else I.house(S, x, y, color, dark, light);
      if (g.metropolis && E.TRACKS.some((t) => g.metropolis[t] === v.id)) labels.push({ x, y: y - 20, t: '★', f: '#f6dc9c', s: 16, w: 700 });
    } else if (buildableVerts.has(v.id)) {
      I.add(S, I.ell(x, y, 15, 15), '#f0cf85', 0.3);
      I.add(S, I.ell(x, y, 9, 9), '#f0cf85', 0.6, '#fff3cf', 2.5);
      queue('circle', { cx: x, cy: y, r: 12, class: 'vertex-hit', 'data-vertex': v.id });
    }
  });
  // 騎士（都市と騎士。頂点に小さな駒として置く。起動中は明るい色、休み中は暗い色）
  if (g.players[0].knights) {
    g.players.forEach((pl) => {
      pl.knights.forEach((k) => {
        const v = g.board.vertices[k.vertexId];
        const x = v.x * SCALE, y = v.y * SCALE;
        const color = k.active ? pl.color : I.tint(pl.color, -0.35);
        I.add(S, I.ell(x, y, 10, 10), color, 1, '#1b1612', 1.6);
        labels.push({ x, y: y + 1, t: String(k.level), f: '#fffaf0', s: 11, w: 700 });
      });
    });
  }

  // 盗賊・海賊（点滅させるので、ほかの絵とは別の <g> に入れる）
  const robberShapes = [];
  let robberBlink = false;
  // 漁師: 魚2匹で盗賊を盤外へ出せる間は robberHex が null になり、盗賊は描かない
  if (g.board.robberHex != null) {
    const [cx, cy] = hexCenterPx(g, g.board.hexes[g.board.robberHex]);
    I.robber(robberShapes, cx + 2, cy + 14, 1.15);
    // 7が出て動かすとき・動いた直後は、光る輪を付けて点滅させる
    robberBlink = svg === els.board && (g.phase === 'moveRobber' || (uiState && uiState.mode === 'devKnightHex')
      || Date.now() < robberMovedAt + 3000);
    if (robberBlink) I.add(robberShapes, I.ell(cx + 2, cy + 2, 26, 26), 'none', 1, '#ffd84a', 4);
  }
  const pirateShapes = [];
  let pirateBlink = false;
  if (g.board.pirateHex != null) {
    const [cx, cy] = hexCenterPx(g, g.board.hexes[g.board.pirateHex]);
    I.pirate(pirateShapes, cx, cy, 1.15);
    pirateBlink = svg === els.board && (g.phase === 'moveRobber' || (uiState && uiState.mode === 'devKnightHex')
      || Date.now() < pirateMovedAt + 3000);
    if (pirateBlink) I.add(pirateShapes, I.ell(cx, cy + 4, 26, 18), 'none', 1, '#ffd84a', 4);
  }

  // 隊商: ラクダを置ける場所（投票で決まった人の番のときだけ。手番の人でなく camelDecider が決める）
  if (g.phase === 'camelPlace' && !isCpuSeat(g.camelDecider)) {
    E.camelPlacementOptions(g).forEach((eId) => {
      const e = g.board.edges[eId];
      const v1 = g.board.vertices[e.v1], v2 = g.board.vertices[e.v2];
      queue('line', { x1: v1.x * SCALE, y1: v1.y * SCALE, x2: v2.x * SCALE, y2: v2.y * SCALE, class: 'road-hit', 'data-edge': eId });
    });
  }
  // 盗賊・海賊を置ける場所（タイル自体をタップできるようにする）
  if (uiState && (uiState.mode === 'moveRobber' || uiState.mode === 'devKnightHex')) {
    g.board.hexes.forEach((hex) => {
      if (hex.fog) return; // 探検家と海賊: 霧のままのマスには置けない
      const isWater = hex.terrain === 'water';
      if (isWater ? hex.id === g.board.pirateHex || g.board.pirateHex == null : hex.id === g.board.robberHex) return;
      const pts = hexPointsPx(g, hex).map(([x, y]) => `${x},${y}`).join(' ');
      queue('polygon', { points: pts, class: 'hex-target', 'data-hex': hex.id });
    });
  }
  // 発明家（進歩カード）: 数字チップのあるマスをどれでも2つ選べる
  if (uiState && (uiState.mode === 'progressHexA' || uiState.mode === 'progressHexB')) {
    g.board.hexes.forEach((hex) => {
      if (hex.number == null || hex.id === uiState.data.hexA) return;
      const pts = hexPointsPx(g, hex).map(([x, y]) => `${x},${y}`).join(' ');
      queue('polygon', { points: pts, class: 'hex-target', 'data-hex': hex.id });
    });
  }

  S.forEach((s) => svg.appendChild(pathEl(s)));
  const robberG = el('g', { class: robberBlink ? 'robber-blink' : '' });
  robberShapes.forEach((s) => robberG.appendChild(pathEl(s)));
  svg.appendChild(robberG);
  if (pirateShapes.length) {
    const pirateG = el('g', { class: pirateBlink ? 'robber-blink' : '' });
    pirateShapes.forEach((s) => pirateG.appendChild(pathEl(s)));
    svg.appendChild(pirateG);
  }
  labels.forEach((l) => {
    const n = el('text', {
      x: l.x, y: l.y, fill: l.f, class: 'hex-number',
      style: `font-family:'Fraunces',serif;font-size:${l.s}px;font-weight:${l.w};text-anchor:middle;dominant-baseline:central`,
    }, svg);
    n.textContent = l.t;
  });
  overlay.forEach((o) => el(o.tag, o.attrs, svg));
  return overlay; // board3d.js が置ける頂点・辺・マスの当たり判定をそのまま3Dの的にするのに使う
}

// 数字チップ・港の文字の位置は port-label と同じ Fraunces を使う

function vertexChoices() {
  const idx = E.currentPlayer(game);
  const isSetup = game.phase === 'setup1' || game.phase === 'setup2';
  return E.availableSettlementVertices(game, idx, isSetup);
}
function edgeChoices() {
  const idx = E.currentPlayer(game);
  const isSetup = game.phase === 'setup1' || game.phase === 'setup2';
  // セットアップ中は、直前に置いた開拓地につながる道しか置けない（engine.js の setupPlaceRoad と同じ条件）。
  // それ以外の道は E.availableRoadEdges だと「前から持っている開拓地」にもつながってしまい、選べるのに置けなくなる。
  if (isSetup) return game.board.vertices[game.setupLastVertex].edgeIds.filter((eId) => game.board.edges[eId].road == null);
  if (ui.mode === 'buildShip') return E.availableShipEdges(game, idx);
  if ((ui.mode === 'devRoad1' || ui.mode === 'devRoad2') && game.board.pirateHex != null) {
    return [...new Set([...E.availableRoadEdges(game, idx), ...E.availableShipEdges(game, idx)])];
  }
  return E.availableRoadEdges(game, idx);
}

// ================================================================
// プレイヤー一覧・銀行
// ================================================================
function renderPlayers() {
  const idx = E.currentPlayer(game);
  els.playersBar.innerHTML = '';
  game.players.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = `player-card${i === idx ? ' is-turn' : ''}`;
    const light = I.tint(p.color, 0.45), dark = I.tint(p.color, -0.35);
    const dot = document.createElement('div');
    dot.className = 'player-card__dot';
    dot.style.background = `radial-gradient(circle at 35% 30%, ${light}, ${p.color} 60%, ${dark})`;
    dot.textContent = String(i + 1);
    const body = document.createElement('div');
    body.className = 'player-card__body';
    const bonus = [];
    if (game.longestRoadPlayer === i) bonus.push('最長路');
    if (game.largestArmyPlayer === i) bonus.push('騎士団');
    const cpuTag = isCpuSeat(i) ? `CPU・${CPU.LEVELS.find((l) => l.id === seatLevel(i))?.name || ''}${seats[i].subbed ? '（代打）' : ''}` : '人';
    // 通信対戦: 本来は人の席なのに切れている（2-5「つながりの見張り」）
    const offlineUid = onlineRoom && seats[i].type === 'human' ? onlineSeatUids[i] : null;
    const statusTag = offlineUid && onlineMembers[offlineUid] && onlineMembers[offlineUid].online === false ? '・切断中' : '';
    body.innerHTML = `<div class="player-card__name"><span class="player-card__nametext">${p.name}</span>${i === idx ? '<span class="player-card__cur">手番</span>' : ''}</div>`
      + `<div class="player-card__sub">${cpuTag}${statusTag}・手札 ${handTotal(p)}・騎士 ${p.knightsPlayed}</div>`
      + `<div class="player-card__extra">${bonus.join(' ')}</div>`;
    if (onlineRoom && onlineRoom.isHost && offlineUid && isLongOffline(offlineUid)) {
      const subBtn = document.createElement('button');
      subBtn.className = 'btn btn--small'; subBtn.textContent = 'CPUに代わってもらう';
      subBtn.dataset.uid = offlineUid; subBtn.dataset.act = 'subCpu';
      body.appendChild(subBtn);
    }
    const vp = document.createElement('div');
    vp.className = 'player-card__vp';
    vp.innerHTML = `<b>${E.playerScore(game, i)}</b><span>点</span>`;
    card.append(dot, body, vp);
    els.playersBar.appendChild(card);
  });
}

els.playersBar.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act="subCpu"]');
  if (!btn || !onlineRoom || !onlineRoom.isHost) return;
  hostSubForDisconnected(btn.dataset.uid);
});

function renderBank() {
  const ck = !!game.bank.commodities;
  const deckLabel = ck
    ? `進歩カード 残り ${E.TRACKS.map((t) => game.progressDecks[t].length).reduce((a, b) => a + b, 0)}`
    : `発展カード 残り ${game.bank.devDeck.length}`;
  els.bankPanel.innerHTML = `<div class="bank__head"><span>銀行</span><span>${deckLabel}</span></div>`;
  const grid = document.createElement('div');
  grid.className = 'bank__grid';
  E.RESOURCES.forEach((r) => {
    const cell = document.createElement('div');
    cell.className = 'bank__res';
    cell.appendChild(resIcon(r));
    const b = document.createElement('b');
    b.textContent = game.bank.resources[r];
    cell.appendChild(b);
    grid.appendChild(cell);
  });
  if (ck) {
    E.COMMODITIES.forEach((c) => {
      const cell = document.createElement('div');
      cell.className = 'bank__res';
      cell.appendChild(resIcon(c));
      const b = document.createElement('b');
      b.textContent = game.bank.commodities[c];
      cell.appendChild(b);
      grid.appendChild(cell);
    });
  }
  els.bankPanel.appendChild(grid);
}

// 手札の欄に出す席。通信対戦では「自分の席」（相手の手札は見せない）。1台モードは今までどおり手番の人
function handSeatIndex() {
  if (onlineRoom) { const s = mySeatIndex(); return s == null ? E.currentPlayer(game) : s; }
  return E.currentPlayer(game);
}
function renderHand() {
  const idx = handSeatIndex();
  const p = game.players[idx];
  els.handBar.innerHTML = '';
  E.RESOURCES.forEach((r) => {
    const cell = document.createElement('div');
    cell.className = 'hand__res';
    cell.appendChild(resIcon(r));
    const b = document.createElement('b');
    b.textContent = `×${p.resources[r]}`;
    cell.appendChild(b);
    els.handBar.appendChild(cell);
  });
  if (!p.progressCards) { // 都市と騎士では発展カードを使わないので、この行は出さない
    const extra = document.createElement('div');
    extra.className = 'hand__extra';
    extra.textContent = `発展カード ${p.devCards.filter((c) => !c.played).length}枚`;
    els.handBar.appendChild(extra);
  }
  els.handCount.textContent = `${E.RESOURCES.reduce((a, r) => a + p.resources[r], 0)} 枚`;
}

// ================================================================
// 都市と騎士: サイドの要約（商品・都市の発展段階・騎士・蛮族の進み・事件のサイコロ）
// ================================================================
const EVENT_FACE_LABEL = { barbarian: '蛮族の船', trade: '交易の城門', politics: '政治の城門', science: '科学の城門' };
function renderCk() {
  // 通信対戦では「自分の席」の商品・発展段階・騎士を出す（手番の人のものを全員の画面に出さない。renderHandと同じ考え方）
  const myIdx = handSeatIndex();
  if (!game.players[myIdx].cityImprovements) { els.ckPanel.hidden = true; return; }
  els.ckPanel.hidden = false;
  const idx = myIdx;
  const p = game.players[idx];
  els.ckPanel.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'panel__head';
  head.innerHTML = `<span>都市と騎士</span><span>蛮族 ${game.barbarianProgress}/7${game.eventDie ? '・前回 ' + EVENT_FACE_LABEL[game.eventDie] : ''}</span>`;
  els.ckPanel.appendChild(head);
  const comRow = document.createElement('div');
  comRow.className = 'ck-row';
  E.COMMODITIES.forEach((c) => {
    const cell = document.createElement('span');
    cell.className = 'ck-chip';
    cell.appendChild(resIcon(c));
    const b = document.createElement('b'); b.textContent = `×${p.commodities[c]}`;
    cell.appendChild(b);
    comRow.appendChild(cell);
  });
  els.ckPanel.appendChild(comRow);
  const trackRow = document.createElement('div');
  trackRow.className = 'ck-row';
  E.TRACKS.forEach((t) => {
    const cell = document.createElement('span');
    cell.className = 'ck-chip';
    const star = E.metropolisOwner(game, t) === idx ? '★' : '';
    cell.textContent = `${E.TRACK_LABEL[t]} ${p.cityImprovements[t]}/5${star}`;
    trackRow.appendChild(cell);
  });
  els.ckPanel.appendChild(trackRow);
  const knightLine = document.createElement('div');
  knightLine.className = 'ck-row';
  if (p.knights.length) {
    p.knights.forEach((k) => {
      const cell = document.createElement('span');
      cell.className = `ck-chip${k.active ? ' is-active' : ''}`;
      cell.textContent = `${E.KNIGHT_LEVEL_LABEL[k.level]}${k.active ? '(起動)' : '(休み)'}`;
      knightLine.appendChild(cell);
    });
  } else {
    const cell = document.createElement('span');
    cell.className = 'ck-chip';
    cell.textContent = '騎士: まだいない';
    knightLine.appendChild(cell);
  }
  els.ckPanel.appendChild(knightLine);
  const manage = document.createElement('button');
  manage.className = 'btn btn--small';
  manage.textContent = '騎士を操作';
  manage.disabled = !humansTurn() || !(game.phase === 'main' || game.phase === 'specialBuilding') || !p.knights.length;
  manage.addEventListener('click', () => { ui = { mode: 'knightMenu', data: {} }; renderAll(); });
  els.ckPanel.appendChild(manage);
  if (p.cityImprovements.trade >= 3) {
    const tradeBtn = document.createElement('button');
    tradeBtn.className = 'btn btn--small';
    tradeBtn.textContent = '商品を交易（2:1）';
    tradeBtn.disabled = !humansTurn() || game.phase !== 'main' || !E.COMMODITIES.some((c) => (p.commodities[c] || 0) >= 2);
    tradeBtn.addEventListener('click', () => { ui = { mode: 'tradeCommodity', data: {} }; renderAll(); });
    els.ckPanel.appendChild(tradeBtn);
  }
}

// ================================================================
// サッカー熱: サイドの要約（自分の持ち駒・順位表・直前の試合結果）
// ================================================================
function renderSoccer() {
  if (!game.soccer) { els.soccerPanel.hidden = true; return; }
  els.soccerPanel.hidden = false;
  // 持ち駒は自分の分だけ出す（通信対戦では相手の持ち駒を自分の画面に出さない。renderCkと同じ考え方）
  const idx = handSeatIndex();
  const p = game.players[idx];
  els.soccerPanel.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'panel__head';
  head.innerHTML = `<span>サッカー熱</span><span>${game.soccerSeasonOver ? 'シーズン終了' : `第${game.soccerDay}/${game.soccerMaxDay}節`}</span>`;
  els.soccerPanel.appendChild(head);
  const shotRow = document.createElement('div');
  shotRow.className = 'ck-row';
  const shotCell = document.createElement('span');
  shotCell.className = 'ck-chip';
  shotCell.textContent = `持ち駒 ${p.socShots}/6`;
  shotRow.appendChild(shotCell);
  els.soccerPanel.appendChild(shotRow);
  const standings = E.soccerStandings(game);
  const table = document.createElement('div');
  table.className = 'ck-row';
  game.players.forEach((pl, i) => {
    const s = standings[i];
    const cell = document.createElement('span');
    cell.className = `ck-chip${i === idx ? ' is-active' : ''}`;
    cell.textContent = `${s.place}位 ${pl.name} ${s.points}点(+${s.vp})`;
    table.appendChild(cell);
  });
  els.soccerPanel.appendChild(table);
  if (game.soccerLastResult) {
    const last = document.createElement('div');
    last.className = 'ck-row';
    last.textContent = `第${game.soccerLastResult.day}節: ${game.soccerLastResult.results.map((r) => `${game.players[r.a].name} ${r.golsA}-${r.golsB} ${game.players[r.b].name}`).join(' / ')}`;
    els.soccerPanel.appendChild(last);
  }
}

function renderDice() {
  if (rolling) return;
  els.diceBox.innerHTML = '';
  if (!game.diceLast) return;
  els.diceBox.appendChild(dieEl(game.diceLast[0], -8));
  els.diceBox.appendChild(dieEl(game.diceLast[1], 7));
}

// 出来事の流れ（game.log）の表示用。プレイヤー名が入るのでHTMLに入れる前に必ずエスケープする
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
// 文中のプレイヤー名を、そのプレイヤーの色で塗る（名前が長い順に置換し、他の名前の部分一致を避ける）
function colorizeLog(text) {
  let html = esc(text);
  (game.players || [])
    .map((p) => ({ name: esc(p.name), color: p.color }))
    .filter((n) => n.name)
    .sort((a, b) => b.name.length - a.name.length)
    .forEach(({ name, color }) => { html = html.split(name).join(`<span style="color:${color}">${name}</span>`); });
  return html;
}
// 文言から分かる範囲で種類のアイコンを付ける（分からない行はアイコンなし）
const LOG_ICONS = [
  [/の勝ち/, '🏆'], [/^サイコロ:/, '🎲'], [/大都市|段階にした/, '🏛️'],
  [/蛮族/, '⚔️'], [/騎士/, '🛡️'], [/進歩カードを公開/, '🎴'],
  [/から1枚奪った/, '🗡️'], [/交易/, '🤝'], [/開拓地/, '🏠'],
  [/サッカー|フットボール/, '⚽'], [/探検|霧の中|新しい島/, '🧭'], [/古い靴/, '👞'],
];
function logIcon(text) {
  const hit = LOG_ICONS.find(([re]) => re.test(text));
  return hit ? `<span class="log-item__icon">${hit[1]}</span>` : '';
}
// 新しい順に並べた一覧。サイコロの行の上に区切り線を引いて、手番の区切りが分かるようにする
function renderLogList() {
  const rows = game.log.slice().reverse().map((text) => {
    const turnCls = text.startsWith('サイコロ:') ? ' log-item--turn' : '';
    return `<div class="log-item${turnCls}">${logIcon(text)}<span>${colorizeLog(text)}</span></div>`;
  }).join('');
  return `<div class="log-list">${rows}</div>`;
}

function renderBanner() {
  const idx = E.currentPlayer(game);
  let main = '', hint = '';
  if (game.winner != null) main = `${game.players[game.winner].name}の勝ち！`;
  else if (game.phase === 'setup1' || game.phase === 'setup2') {
    main = `${game.players[idx].name}の番。`;
    hint = game.setupPending === 'road' ? '道を置く場所をタップ。' : '開拓地を置く場所をタップ。';
  } else if (game.phase === 'roll') { main = `${game.players[idx].name}の手番。`; hint = 'サイコロを振ってください。'; }
  else if (game.phase === 'discard') { main = `${game.players[game.pendingDiscards[0].player].name}は${game.pendingDiscards[0].count}枚捨てます。`; hint = '窓で捨てる資源を選んでください。'; }
  else if (game.phase === 'goldPick') { main = `${game.players[game.pendingGoldPicks[0].player].name}は金の川で${game.pendingGoldPicks[0].count}枚選びます。`; hint = '窓で好きな資源を選んでください。'; }
  else if (game.phase === 'scienceBonus') { main = `${game.players[game.pendingScienceBonus[0]].name}は科学の力で資源を1枚選びます。`; hint = '窓で好きな資源を選んでください。'; }
  else if (game.phase === 'moveRobber') { main = `${game.players[idx].name}の番。`; hint = '盗賊か海賊を動かすタイルをタップ。'; }
  else if (game.phase === 'specialBuilding') { main = `特別建設フェイズ: ${game.players[idx].name}の番。`; hint = '建てるか、パスしてください（交易・発展カードは使えません）。'; }
  else if (game.diceLast) main = `サイコロ ${game.diceLast[0]}＋${game.diceLast[1]}＝${game.diceLast[0] + game.diceLast[1]}。`;
  if (game.winner == null && game.phase !== 'discard' && isCpuSeat(idx)) hint = `CPU（${CPU.LEVELS.find((l) => l.id === seatLevel(idx))?.name || ''}）が考えています…`;
  if (onlineRoom && game.winner == null) {
    const mySeat = mySeatIndex();
    if (game.phase !== 'discard' && mySeat === idx) main += ' あなたの番です。';
    if (game.lastSteal) {
      const { from, to, res } = game.lastSteal;
      if (mySeat === to) main += ` ${game.players[from].name}から${RES_LABEL[res]}を1枚奪った。`;
      else if (mySeat === from) main += ` ${game.players[to].name}に${RES_LABEL[res]}を1枚取られた。`;
    }
    if (game.tradeOffer && mySeat !== game.tradeOffer.from && mySeat !== game.tradeOffer.to) {
      main += ` ${game.players[game.tradeOffer.from].name}が${game.players[game.tradeOffer.to].name}に交換を申し込み中。`;
    }
  }
  if (ui.mode === 'buildRoad') hint = '道を置く場所をタップ。';
  else if (ui.mode === 'buildSettlement') hint = '開拓地を置く場所をタップ。';
  else if (ui.mode === 'buildCity') hint = '都市にする開拓地をタップ。';
  else if (ui.mode === 'buildShip') hint = '船を置く場所をタップ。';
  else if (ui.mode === 'moveShip1') hint = '動かす自分の船をタップ（端にあるものだけ）。';
  else if (ui.mode === 'moveShip2') hint = '移す先の海の辺をタップ。';
  else if (ui.mode === 'devKnightHex' || ui.mode === 'robberTargetForDev') hint = '盗賊か海賊を動かすタイルをタップ。';
  else if (ui.mode === 'devRoad1') hint = '街道建設: 1本目の道を置く場所をタップ。';
  else if (ui.mode === 'devRoad2') hint = '街道建設: 2本目の道を置く場所をタップ（終わってもよい）。';
  else if (ui.mode === 'buildKnight') hint = '騎士を置く場所（自分の道が届く所）をタップ。';
  else if (ui.mode === 'moveKnightTo') hint = '騎士を移す先の頂点をタップ。';
  else if (ui.mode === 'progressVertex') hint = '騎士を置く場所をタップ。';
  else if (ui.mode === 'progressEdge1') hint = '道を置く場所をタップ。';
  else if (ui.mode === 'progressEdge2') hint = `道を置く場所をタップ（${(ui.data.edges || []).length}/2）。`;
  else if (ui.mode === 'progressHexA') hint = '発明家: 1つめのマスをタップ。';
  else if (ui.mode === 'progressHexB') hint = '発明家: 2つめのマスをタップ（数字チップを入れ替えます）。';
  els.hint.textContent = hint;
  const lastLog = game.log[game.log.length - 1];
  const toggle = lastLog
    ? `<div class="message__log" id="logToggle">ひとつ前: ${colorizeLog(lastLog)}<span class="message__log-arrow">${logOpen ? '▲' : '▼'}</span></div>`
    : '';
  els.banner.innerHTML = `<div>${main}</div>` + toggle + (logOpen && lastLog ? renderLogList() : '');
  els.turnNum.textContent = String(game.turnNumber);
}
// 「ひとつ前」の行をタップすると、出来事の流れ（game.log の一覧）を開け閉めする
els.banner.addEventListener('click', (e) => {
  if (e.target.closest('#logToggle')) { logOpen = !logOpen; renderBanner(); }
});

// ================================================================
// 建てるもの（常に4つ並べ、押したらその場で置く・買う）
// ================================================================
function costRow(cost) {
  const wrap = document.createElement('span');
  wrap.className = 'build-btn__cost';
  Object.entries(cost).forEach(([r, n]) => {
    const pair = document.createElement('span');
    pair.className = 'cost-pair';
    pair.appendChild(resIcon(r));
    const s = document.createElement('span');
    s.textContent = `×${n}`;
    pair.appendChild(s);
    wrap.appendChild(pair);
  });
  return wrap;
}
function canAfford(res, cost) { return Object.entries(cost).every(([k, v]) => (res[k] || 0) >= v); }

const BUILD_MODE = { road: 'buildRoad', settlement: 'buildSettlement', city: 'buildCity', ship: 'buildShip', knight: 'buildKnight', warKnight: 'buildWarKnight' };
function renderBuildGrid() {
  const idx = E.currentPlayer(game);
  const p = game.players[idx];
  const inMain = (game.phase === 'main' || game.phase === 'specialBuilding') && humansTurn();
  const seafarers = game.board.pirateHex != null;
  const ck = !!p.cityImprovements;
  const defs = [
    { key: 'road', label: '道', cost: E.COSTS.road, ok: inMain && p.roads.length < 15 && canAfford(p.resources, E.COSTS.road) && E.availableRoadEdges(game, idx).length },
  ];
  if (seafarers) defs.push({ key: 'ship', label: '船', cost: E.COSTS.ship, ok: inMain && p.ships.length < 15 && canAfford(p.resources, E.COSTS.ship) && E.availableShipEdges(game, idx).length });
  defs.push(
    { key: 'settlement', label: '開拓地', cost: E.COSTS.settlement, ok: inMain && p.settlements.length < 5 && canAfford(p.resources, E.COSTS.settlement) && E.availableSettlementVertices(game, idx, false).length },
    { key: 'city', label: '都市', cost: E.COSTS.city, ok: inMain && p.cities.length < 4 && canAfford(p.resources, E.COSTS.city) && E.availableCityVertices(game, idx).length },
  );
  if (ck) {
    defs.push(
      { key: 'knight', label: '騎士', cost: E.KNIGHT_COST, ok: inMain && canAfford(p.resources, E.KNIGHT_COST) && E.availableKnightVertices(game, idx).length },
      { key: 'wall', label: '都市壁', cost: E.WALL_COST, ok: false }, // クリックで即建てる（下のハンドラで特別扱い）
      { key: 'improve', label: '都市の発展', cost: {}, ok: inMain && E.TRACKS.some((t) => E.canImproveCity(game, idx, t)) },
    );
  } else {
    defs.push({ key: 'dev', label: '発展カード', cost: E.COSTS.dev, ok: inMain && game.bank.devDeck.length > 0 && canAfford(p.resources, E.COSTS.dev) });
  }
  if (game.scenario === 'barbarians') {
    defs.push({ key: 'warKnight', label: '騎士', cost: E.WAR_KNIGHT_COST, ok: inMain && canAfford(p.resources, E.WAR_KNIGHT_COST) && E.availableWarKnightEdges(game, idx).length });
  }
  els.buildGrid.innerHTML = '';
  defs.forEach((d) => {
    if (d.key === 'wall') d.ok = E.canBuildWall(game, idx);
    const btn = document.createElement('button');
    const active = ui.mode === BUILD_MODE[d.key];
    btn.className = `build-btn${active ? ' is-selected' : ''}`;
    btn.disabled = !d.ok;
    btn.appendChild(buildIcon(d.key, p.color));
    const label = document.createElement('span');
    label.className = 'build-btn__label';
    label.textContent = d.label;
    btn.appendChild(label);
    if (d.key !== 'improve') btn.appendChild(costRow(d.cost));
    btn.addEventListener('click', () => {
      if (d.key === 'dev') { act('buyDevCard', []); playEvents(); persistAndRender(); return; }
      if (d.key === 'wall') { act('buildWall', []); playEvents(); persistAndRender(); return; }
      if (d.key === 'improve') { ui = { mode: 'cityImprove', data: {} }; renderAll(); return; }
      if (active) { ui = { mode: 'idle', data: {} }; renderAll(); return; }
      ui = { mode: BUILD_MODE[d.key], data: {} };
      renderAll();
    });
    els.buildGrid.appendChild(btn);
  });
  // 船を動かす（航海者版・手番に1回だけ）
  if (seafarers) {
    const movable = E.movableShipEdges(game, idx);
    const btn = document.createElement('button');
    const active = ui.mode === 'moveShip1' || ui.mode === 'moveShip2';
    btn.className = `build-btn${active ? ' is-selected' : ''}`;
    btn.disabled = !(inMain && movable.length);
    btn.appendChild(buildIcon('moveShip', p.color));
    const label = document.createElement('span');
    label.className = 'build-btn__label';
    label.textContent = '船を動かす';
    btn.appendChild(label);
    btn.addEventListener('click', () => {
      if (active) { ui = { mode: 'idle', data: {} }; renderAll(); return; }
      ui = { mode: 'moveShip1', data: {} };
      renderAll();
    });
    els.buildGrid.appendChild(btn);
  }
  // 騎士を動かす（蛮族の襲撃・手番に1回ずつ）
  if (game.scenario === 'barbarians') {
    const movable = p.warKnights.filter((k) => E.movableWarKnightEdges(game, idx, k.id, false).length);
    const btn = document.createElement('button');
    const active = ui.mode === 'moveWarKnight1' || ui.mode === 'moveWarKnight2';
    btn.className = `build-btn${active ? ' is-selected' : ''}`;
    btn.disabled = !(inMain && movable.length);
    btn.appendChild(buildIcon('warKnight', p.color));
    const label = document.createElement('span');
    label.className = 'build-btn__label';
    label.textContent = '騎士を動かす';
    btn.appendChild(label);
    btn.addEventListener('click', () => {
      if (active) { ui = { mode: 'idle', data: {} }; renderAll(); return; }
      ui = { mode: 'moveWarKnight1', data: {} };
      renderAll();
    });
    els.buildGrid.appendChild(btn);
  }
}

// ================================================================
// 操作パネル（画面中央の窓。交易・捨てる・盗む相手選び・発展カードなど）
// ================================================================
function openPanel() { els.panelOverlay.hidden = false; }
function closePanel() { els.panelOverlay.hidden = true; els.panel.innerHTML = ''; }

function renderPanel() {
  // 通信対戦: 自分あてに交換が申し込まれていたら、ほかの窓より先にこれを出す（自分の番でなくても出る）
  if (onlineRoom && game.tradeOffer && mySeatIndex() === game.tradeOffer.to) {
    openPanel(); renderTradeAnswerPanel(game.tradeOffer); return;
  }
  // 捨て札はCPUの分を先に片付けてよいので、人が窓で捨てるのは「人の席でまだ残っている分」だけ。
  // 通信対戦では「自分の席の分」だけを出す（ほかの人は各自の端末で同時に捨てる）
  if (ui.mode === 'discard' && game.phase === 'discard') {
    const d = onlineRoom
      ? game.pendingDiscards.find((x) => x.player === mySeatIndex())
      : game.pendingDiscards.find((x) => !isCpuSeat(x.player));
    if (d) { openPanel(); renderDiscardPanel(d); }
    else closePanel();
    return;
  }
  if (ui.mode === 'goldPick' && game.phase === 'goldPick') {
    const d = onlineRoom
      ? game.pendingGoldPicks.find((x) => x.player === mySeatIndex())
      : game.pendingGoldPicks.find((x) => !isCpuSeat(x.player));
    if (d) { openPanel(); renderGoldPickPanel(d); }
    else closePanel();
    return;
  }
  if (ui.mode === 'scienceBonus' && game.phase === 'scienceBonus') {
    const p = onlineRoom
      ? game.pendingScienceBonus.find((x) => x === mySeatIndex())
      : game.pendingScienceBonus.find((x) => !isCpuSeat(x));
    if (p != null) { openPanel(); renderScienceBonusPanel(p); }
    else closePanel();
    return;
  }
  if (game.phase === 'camelVote' && game.pendingCamelVote) {
    // 通信対戦では「今入札する人」の画面だけに出す（手札欄と同じ考え方。isCpuSeatだけだと人である全員の画面に出てしまう）
    const acting = game.pendingCamelVote.order[game.pendingCamelVote.idx];
    if (onlineRoom ? acting !== mySeatIndex() : isCpuSeat(acting)) { closePanel(); return; }
    openPanel(); renderCamelVotePanel(acting); return;
  }
  if (game.phase === 'barbarianSteal') {
    const idx = E.currentPlayer(game);
    if (onlineRoom ? idx !== mySeatIndex() : isCpuSeat(idx)) { closePanel(); return; }
    openPanel(); renderBarbarianStealPanel(idx); return;
  }
  if (ui.data.pendingHex != null) { openPanel(); renderRobberTargetPanel(ui.data.pendingHex, ui.data.forDev); return; }
  if (ui.data.pendingEdge != null) { openPanel(); renderDevRoadKindPanel(ui.data.pendingEdge); return; }
  if (ui.mode === 'tradeMenu') { openPanel(); renderTradeMenu(); return; }
  if (ui.mode === 'devMenu') { openPanel(); renderDevMenu(); return; }
  if (ui.mode === 'devYearOfPlenty') { openPanel(); renderYearOfPlentyPanel(); return; }
  if (ui.mode === 'devMonopoly') { openPanel(); renderMonopolyPanel(); return; }
  if (ui.mode === 'devRoad2') { openPanel(); renderDevRoadFinish(); return; }
  if (ui.mode === 'knightMenu') { openPanel(); renderKnightMenu(); return; }
  if (ui.mode === 'tradeCommodity') { openPanel(); renderCommodityTradePanel(); return; }
  if (ui.mode === 'knightExpelTarget') { openPanel(); renderKnightExpelPanel(); return; }
  if (ui.mode === 'cityImprove') { openPanel(); renderCityImprovePanel(); return; }
  if (ui.mode === 'progressMenu') { openPanel(); renderProgressMenu(); return; }
  if (ui.mode === 'progressRes1') { openPanel(); renderProgressRes1Panel(); return; }
  if (ui.mode === 'progressRes2') { openPanel(); renderProgressRes2Panel(); return; }
  if (ui.mode === 'progressCom1') { openPanel(); renderProgressCom1Panel(); return; }
  if (ui.mode === 'progressTrade1' || ui.mode === 'progressTrade2') { openPanel(); renderProgressTradePanel(); return; }
  if (ui.mode === 'progressKnightOwn') { openPanel(); renderProgressKnightOwnPanel(); return; }
  if (ui.mode === 'progressKnightTarget') { openPanel(); renderProgressKnightTargetPanel(); return; }
  if (game.winner != null) { openPanel(); renderWinPanel(); return; }
  closePanel();
}

function renderWinPanel() {
  // 通信対戦: ホストは「もう一度」で部屋を消さず待合へ戻せる。「部屋を片付けてタイトルへ」も残す。
  // ゲストは「待合に戻る」（ホストがはじめるのを待てる）か「部屋を出る」（2-5「部屋の後片付け」）
  const onlineBtnHtml = !onlineRoom ? '<button class="btn btn--accent" data-act="close">とじる</button>'
    : onlineRoom.isHost
      ? '<div class="sheet__row"><button class="btn btn--accent" data-act="rematch">もう一度（同じ顔ぶれ）</button><button class="ghost-btn" data-act="closeRoom">部屋を片付けてタイトルへ</button></div>'
      : '<div class="sheet__row"><button class="btn btn--accent" data-act="backToLobby">待合に戻る</button><button class="ghost-btn" data-act="leaveRoom">部屋を出る</button></div>';
  els.panel.innerHTML = `<h2>${game.players[game.winner].name}の勝ち！</h2><p>${E.winTargetFor(game, game.winner)}点に到達しました。</p>${onlineBtnHtml}`;
  const backToTitle = () => { closePanel(); els.gamePanel.hidden = true; els.setupPanel.hidden = false; homeBtn.hidden = true; ambientStop(); setBgmScreen('title'); showSetupView('mainSetupView'); };
  const backToLobby = () => { closePanel(); els.gamePanel.hidden = true; els.setupPanel.hidden = false; homeBtn.hidden = true; ambientStop(); setBgmScreen('title'); showSetupView('onlineLobbyView'); renderLobby(); };
  bindPanel({
    close: () => { closePanel(); },
    closeRoom: async () => { await onlineRoom.close(); onlineRoom = null; onlineMeta = null; onlineMembers = {}; offlineSince = {}; prevOnlineStatus = null; try { localStorage.removeItem(STORE + 'onlineRoom'); } catch { /* 無視 */ } refreshOnlineResume(); backToTitle(); },
    leaveRoom: async () => { await leaveOnlineRoom(); backToTitle(); },
    // 席はそのまま（同じ顔ぶれ）。つながっていない人・代打CPUは待合の見張り（hostSyncSeats）が自然に扱う
    rematch: () => { game = null; resetCutinBaseline(); onlineRoom.setMeta({ status: 'lobby' }); backToLobby(); },
    backToLobby,
  });
}

// 通信対戦: 自分あてに来た交換の申し込みに答える窓（受ける／ことわる）
function renderTradeAnswerPanel(offer) {
  els.panel.innerHTML = `<h2>交換の申し込み</h2>
    <p>${game.players[offer.from].name}から: ${resSummary(offer.give)} → ${resSummary(offer.get)}。受ける？</p>
    <div class="sheet__row">
      <button class="btn btn--accent" data-act="accept">受ける</button>
      <button class="ghost-btn" data-act="decline">ことわる</button>
    </div>`;
  bindPanel({
    accept: () => { act('answerTrade', [true]); playEvents(); persistAndRender(); },
    decline: () => { act('answerTrade', [false]); playEvents(); persistAndRender(); },
  });
}

function bindPanel(actions) {
  els.panel.onclick = (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const fn = actions[btn.dataset.act];
    if (fn) fn(btn);
  };
}

function renderDiscardPanel(d) {
  const p = game.players[d.player];
  const picked = ui.data.discardPicked || (ui.data.discardPicked = E.RESOURCES.reduce((o, r) => ({ ...o, [r]: 0 }), {}));
  const total = Object.values(picked).reduce((a, b) => a + b, 0);
  els.panel.innerHTML = `<h2>${game.players[d.player].name}: ${d.count}枚捨てる（あと${d.count - total}枚）</h2>`
    + E.RESOURCES.map((r) => `<div class="sheet__row"><span class="res-pick__label" data-row="${r}">持ち${p.resources[r]}</span>
        <span class="stepper">
          <button data-act="dec" data-res="${r}">−</button><b>${picked[r]}</b>
          <button data-act="inc" data-res="${r}">＋</button>
        </span></div>`).join('')
    + `<button class="btn btn--accent" data-act="confirm" ${total === d.count ? '' : 'disabled'}>捨てる</button>`;
  // 資源のアイコンを差し込む
  E.RESOURCES.forEach((r) => {
    const span = els.panel.querySelector(`[data-row="${r}"]`);
    span.prepend(resIcon(r));
  });
  bindPanel({
    inc: (b) => { const r = b.dataset.res; if (picked[r] < p.resources[r] && total < d.count) { picked[r]++; renderPanel(); } },
    dec: (b) => { const r = b.dataset.res; if (picked[r] > 0) { picked[r]--; renderPanel(); } },
    confirm: () => {
      act('discardCards', [d.player, picked]);
      ui.data.discardPicked = null;
      if (game.phase !== 'discard') ui = { mode: 'moveRobber', data: {} };
      persistAndRender(); // 捨て札が残っていればCPUの分を自動で進め、人の分が残っていれば窓を出し直す
    },
  });
}

function renderGoldPickPanel(d) {
  const picked = ui.data.goldPicked || (ui.data.goldPicked = []);
  els.panel.innerHTML = `<h2>${game.players[d.player].name}: 金の川で好きな資源を${d.count}枚選ぶ（あと${d.count - picked.length}枚）</h2>
    <div class="res-pick" data-row="pick"></div>
    <p>選んだ: ${picked.length ? '' : 'なし'}</p>
    <button class="btn btn--accent" data-act="confirm" ${picked.length === d.count ? '' : 'disabled'}>受け取る</button>`;
  fillResPick(els.panel.querySelector('[data-row="pick"]'), E.RESOURCES, () => false, (r, b) => {
    b.appendChild(resIcon(r));
    const s = document.createElement('span'); s.textContent = `残り${game.bank.resources[r]}`; b.appendChild(s);
    if (game.bank.resources[r] - picked.filter((x) => x === r).length <= 0) b.disabled = true;
  }, 'pick');
  const p = els.panel.querySelector('p');
  picked.forEach((r) => p.appendChild(resIcon(r)));
  bindPanel({
    pick: (b) => { if (picked.length < d.count) { picked.push(b.dataset.res); renderPanel(); } },
    confirm: () => {
      act('pickGold', [d.player, picked]);
      ui.data.goldPicked = null;
      if (game.phase !== 'goldPick') ui = { mode: 'idle', data: {} };
      persistAndRender();
    },
  });
}

// 都市と騎士(科学3段階目): この目で何も入らなかった人が、好きな資源を1枚選ぶ
function renderScienceBonusPanel(playerIdx) {
  els.panel.innerHTML = `<h2>${game.players[playerIdx].name}: 科学の力で好きな資源を1枚選ぶ</h2>
    <div class="res-pick" data-row="pick"></div>`;
  fillResPick(els.panel.querySelector('[data-row="pick"]'), E.RESOURCES, () => false, (r, b) => {
    b.appendChild(resIcon(r));
    const s = document.createElement('span'); s.textContent = `残り${game.bank.resources[r]}`; b.appendChild(s);
    if (game.bank.resources[r] <= 0) b.disabled = true;
  }, 'pick');
  bindPanel({
    pick: (b) => {
      act('pickScienceBonus', [playerIdx, b.dataset.res]);
      if (game.phase !== 'scienceBonus') ui = { mode: 'idle', data: {} };
      persistAndRender();
    },
  });
}

// 隊商: 羊・麦を出してラクダの投票に参加する
function renderCamelVotePanel(playerIdx) {
  const p = game.players[playerIdx];
  const bid = ui.data.camelBid || (ui.data.camelBid = { wheat: 0, sheep: 0 });
  els.panel.innerHTML = `<h2>${game.players[playerIdx].name}の投票（ラクダの置き場所）</h2>
    <p style="opacity:.8">羊・麦を出すほど、その人の意見が通りやすくなります。出さなくても参加できます。</p>
    <div class="sheet__row"><span>麦</span><div class="stepper">
      <button class="ghost-btn" data-act="wdec">−</button><b>${bid.wheat}</b><button class="ghost-btn" data-act="winc" ${bid.wheat < p.resources.wheat ? '' : 'disabled'}>＋</button>
    </div></div>
    <div class="sheet__row"><span>羊</span><div class="stepper">
      <button class="ghost-btn" data-act="sdec">−</button><b>${bid.sheep}</b><button class="ghost-btn" data-act="sinc" ${bid.sheep < p.resources.sheep ? '' : 'disabled'}>＋</button>
    </div></div>
    <button class="btn btn--accent" data-act="bid">この内容で投票する</button>`;
  bindPanel({
    winc: () => { bid.wheat++; renderPanel(); },
    wdec: () => { if (bid.wheat > 0) { bid.wheat--; renderPanel(); } },
    sinc: () => { bid.sheep++; renderPanel(); },
    sdec: () => { if (bid.sheep > 0) { bid.sheep--; renderPanel(); } },
    bid: () => {
      act('submitCamelBid', [playerIdx, bid]);
      ui.data.camelBid = null;
      playEvents(); persistAndRender(); renderPanel();
    },
  });
}
// 蛮族の襲撃: 7が出たら、盗賊の代わりに相手を選んで1枚奪う
function renderBarbarianStealPanel(idx) {
  const targets = E.barbarianStealTargets(game, idx);
  els.panel.innerHTML = `<h2>誰から奪う？</h2>`
    + (targets.length ? targets.map((t) => `<button class="card-btn" data-act="pick" data-target="${t}">${game.players[t].name}（手札${handTotal(game.players[t])}枚）</button>`).join('')
      : `<button class="card-btn" data-act="pick" data-target="">誰も奪えない</button>`);
  bindPanel({
    pick: (b) => {
      const target = b.dataset.target === '' ? null : Number(b.dataset.target);
      act('resolveBarbarianSteal', [target]);
      playEvents(); persistAndRender();
    },
  });
}

function renderRobberTargetPanel(hexId, forDev) {
  const idx = E.currentPlayer(game);
  const targets = E.banditTargets(game, hexId, idx);
  els.panel.innerHTML = `<h2>誰から奪う？</h2>`
    + (targets.length ? targets.map((t) => `<button class="card-btn" data-act="pick" data-target="${t}">${game.players[t].name}（手札${handTotal(game.players[t])}枚）</button>`).join('')
      : `<button class="card-btn" data-act="pick" data-target="">誰も奪えない</button>`);
  bindPanel({
    pick: (b) => {
      const target = b.dataset.target === '' ? null : Number(b.dataset.target);
      if (forDev != null) act('playKnight', [forDev, hexId, target]);
      else act('moveRobber', [hexId, target]);
      ui = { mode: 'idle', data: {} };
      playEvents();
      persistAndRender();
    },
  });
}

function renderTradeMenu() {
  const idx = E.currentPlayer(game);
  const p = game.players[idx];
  const give = ui.data.tradeGive || (ui.data.tradeGive = E.RESOURCES[0]);
  const want = ui.data.tradeWant || (ui.data.tradeWant = E.RESOURCES[1]);
  const rate = E.playerPortRate(game, idx, give);
  const other = ui.data.tradeOther == null ? (idx + 1) % game.playerCount : ui.data.tradeOther;
  const pGive = ui.data.pGive || (ui.data.pGive = E.RESOURCES.reduce((o, r) => ({ ...o, [r]: 0 }), {}));
  const pGet = ui.data.pGet || (ui.data.pGet = E.RESOURCES.reduce((o, r) => ({ ...o, [r]: 0 }), {}));
  const fishOther = ui.data.fishOther == null ? (idx + 1) % game.playerCount : ui.data.fishOther;
  const fishRes = ui.data.fishRes || (ui.data.fishRes = E.RESOURCES[0]);
  const goldRes = ui.data.goldRes || (ui.data.goldRes = E.RESOURCES[0]);
  const gold2Res = ui.data.gold2Res || (ui.data.gold2Res = E.RESOURCES[0]);
  let scenarioHtml = '';
  if (game.scenario === 'fishermen') {
    const fishTotal = (p.fishTokens || []).reduce((a, b) => a + b, 0);
    const canGive = game.oldBootHolder === idx && game.players.some((_, i) => i !== idx && E.canGiveOldBoot(game, i));
    scenarioHtml = `<hr style="border-color:rgba(255,255,255,0.15)">
      <h2>漁師（魚 ${(p.fishTokens || []).join('・') || 'なし'}＝合計${fishTotal}匹${game.oldBootHolder === idx ? '・古い靴あり（勝利点+1点多く要る）' : ''}）</h2>
      <div class="sheet__row"><button class="ghost-btn" data-act="fishRobber" ${E.canUseFishTrade(game, idx, 'robberAway') ? '' : 'disabled'}>魚2匹: 盗賊を盤外へ</button></div>
      <div class="sheet__row"><span>相手</span><div class="res-pick" data-row="fishOther"></div>
        <button class="ghost-btn" data-act="fishSteal" ${E.canUseFishTrade(game, idx, 'steal') ? '' : 'disabled'}>魚3匹: 資源を奪う</button></div>
      <div class="sheet__row"><span>資源</span><div class="res-pick" data-row="fishRes"></div>
        <button class="ghost-btn" data-act="fishResource" ${E.canUseFishTrade(game, idx, 'resource') ? '' : 'disabled'}>魚4匹: 資源1枚</button></div>
      <div class="sheet__row"><button class="ghost-btn" data-act="fishRoadStart" ${E.canUseFishTrade(game, idx, 'road') && E.availableRoadEdges(game, idx).length ? '' : 'disabled'}>魚5匹: 道を1本（置く場所を選ぶ）</button></div>
      <div class="sheet__row"><button class="ghost-btn" data-act="fishDev" ${E.canUseFishTrade(game, idx, 'devcard') && game.bank.devDeck.length ? '' : 'disabled'}>魚7匹: 発展カード1枚</button></div>
      ${canGive ? `<div class="sheet__row"><span>古い靴を渡す相手</span><div class="res-pick" data-row="bootOther"></div>
        <button class="ghost-btn" data-act="giveBoot">渡す</button></div>` : ''}`;
  } else if (game.scenario === 'rivers') {
    scenarioHtml = `<hr style="border-color:rgba(255,255,255,0.15)">
      <h2>川（金貨 ${p.gold || 0}枚${game.richPlayer === idx ? '・富豪+1点' : ''}${(game.poorPlayers || []).includes(idx) ? '・貧者-2点' : ''}・橋${p.bridges || 0}/3）</h2>
      <div class="sheet__row"><span>資源</span><div class="res-pick" data-row="goldRes"></div>
        <button class="ghost-btn" data-act="goldTrade" ${E.canTradeGold(game, idx) && (p.gold || 0) >= 2 ? '' : 'disabled'}>金貨2枚: 資源1枚（手番に${p.goldSpendsThisTurn || 0}/2回使用）</button></div>
      <div class="sheet__row"><span>資源</span><div class="res-pick" data-row="gold2Res"></div>
        <button class="ghost-btn" data-act="resForGold">資源→金貨1枚（港なしは4枚、3:1港は3枚）</button></div>`;
  } else if (game.explorersPirates) {
    scenarioHtml = `<hr style="border-color:rgba(255,255,255,0.15)">
      <h2>探検家と海賊（霧のマスを見つけた数 ${p.epRevealed || 0}/3${game.epMissionWinner === idx ? '・探検ミッション達成+1点' : ''}）</h2>`;
  }

  // 通信対戦: 申し込み中はその内容ととりさげるボタンだけ出す。なければ相手・渡す・もらうを選んで申し込む窓
  const myOffer = onlineRoom && game.tradeOffer && game.tradeOffer.from === idx ? game.tradeOffer : null;
  const pTradeHtml = onlineRoom
    ? (myOffer
      ? `<hr style="border-color:rgba(255,255,255,0.15)">
        <h2>相手と交易</h2>
        <p>${game.players[myOffer.to].name}に申し込み中: ${resSummary(myOffer.give)} → ${resSummary(myOffer.get)}。返事を待っています。</p>
        <button class="ghost-btn" data-act="withdrawTrade">申し込みをとりさげる</button>`
      : `<hr style="border-color:rgba(255,255,255,0.15)">
    <h2>相手と交易</h2>
    <div class="sheet__row"><span>相手</span><div class="res-pick" data-row="other"></div></div>
    <div class="sheet__row"><span>渡す</span><div class="res-pick" data-row="pgive"></div></div>
    <div class="sheet__row"><span>もらう</span><div class="res-pick" data-row="pget"></div></div>
    <button class="btn btn--accent" data-act="offerTrade">この内容で申し込む</button>`)
    : `<hr style="border-color:rgba(255,255,255,0.15)">
    <h2>相手と交易</h2>
    <div class="sheet__row"><span>相手</span><div class="res-pick" data-row="other"></div></div>
    <div class="sheet__row"><span>渡す</span><div class="res-pick" data-row="pgive"></div></div>
    <div class="sheet__row"><span>もらう</span><div class="res-pick" data-row="pget"></div></div>
    <button class="btn btn--accent" data-act="playerTrade">この内容で成立させる</button>`;
  els.panel.innerHTML = `<h2>銀行・港と交易</h2>
    <div class="sheet__row"><span>出す（${rate}枚で1枚）</span><div class="res-pick" data-row="give"></div></div>
    <div class="sheet__row"><span>もらう</span><div class="res-pick" data-row="want"></div></div>
    <button class="btn btn--accent" data-act="bank" ${p.resources[give] >= rate && give !== want ? '' : 'disabled'}>${rate}:1で交易する</button>
    ${pTradeHtml}
    ${scenarioHtml}
    <button class="ghost-btn" data-act="cancel">やめる</button>`;

  fillResPick(els.panel.querySelector('[data-row="give"]'), E.RESOURCES, (r) => r === give, (r, b) => {
    b.appendChild(resIcon(r)); const s = document.createElement('span'); s.textContent = `×${p.resources[r]}`; b.appendChild(s);
  }, 'give');
  fillResPick(els.panel.querySelector('[data-row="want"]'), E.RESOURCES, (r) => r === want, (r, b) => b.appendChild(resIcon(r)), 'want');
  if (!myOffer) {
    fillOtherPick(els.panel.querySelector('[data-row="other"]'), other);
    fillStepperRow(els.panel.querySelector('[data-row="pgive"]'), pGive, (r) => p.resources[r], 'pg');
    // 通信対戦: 相手の手札の内訳は見えないので、上限は実数ではなく0〜9にする（成り立つかはengineが確かめる。仕様2-3）
    fillStepperRow(els.panel.querySelector('[data-row="pget"]'), pGet, (r) => (onlineRoom ? 9 : game.players[other].resources[r]), 'pw');
  }
  if (game.scenario === 'fishermen') {
    fillOtherPick(els.panel.querySelector('[data-row="fishOther"]'), fishOther, 'fishOther');
    fillResPick(els.panel.querySelector('[data-row="fishRes"]'), E.RESOURCES, (r) => r === fishRes, (r, b) => b.appendChild(resIcon(r)), 'fishRes');
    if (els.panel.querySelector('[data-row="bootOther"]')) {
      const bootOther = ui.data.bootOther == null ? (idx + 1) % game.playerCount : ui.data.bootOther;
      fillOtherPick(els.panel.querySelector('[data-row="bootOther"]'), bootOther, 'bootOther');
    }
  } else if (game.scenario === 'rivers') {
    fillResPick(els.panel.querySelector('[data-row="goldRes"]'), E.RESOURCES, (r) => r === goldRes, (r, b) => b.appendChild(resIcon(r)), 'goldRes');
    fillResPick(els.panel.querySelector('[data-row="gold2Res"]'), E.RESOURCES, (r) => r === gold2Res, (r, b) => b.appendChild(resIcon(r)), 'gold2Res');
  }

  bindPanel({
    give: (b) => { ui.data.tradeGive = b.dataset.res; renderPanel(); },
    want: (b) => { ui.data.tradeWant = b.dataset.res; renderPanel(); },
    other: (b) => { ui.data.tradeOther = Number(b.dataset.p); renderPanel(); },
    pginc: (b) => { const r = b.dataset.res; if (pGive[r] < p.resources[r]) { pGive[r]++; renderPanel(); } },
    pgdec: (b) => { const r = b.dataset.res; if (pGive[r] > 0) { pGive[r]--; renderPanel(); } },
    pwinc: (b) => { const r = b.dataset.res; if (pGet[r] < (onlineRoom ? 9 : game.players[other].resources[r])) { pGet[r]++; renderPanel(); } },
    pwdec: (b) => { const r = b.dataset.res; if (pGet[r] > 0) { pGet[r]--; renderPanel(); } },
    bank: () => { act('bankTrade', [give, want]); ui.data.tradeGive = null; ui.data.tradeWant = null; playEvents(); persistAndRender(); renderPanel(); },
    playerTrade: () => {
      if (isCpuSeat(other)) {
        // CPUが相手のときは、成立させる前に受けるか断るかを決める（人の手札は見ず、今回の内容だけで判断）
        if (CPU.acceptTrade(game, other, pGive, pGet, seatLevel(other))) {
          act('playerTrade', [other, pGive, pGet]);
          game.log.push(`${game.players[other].name}が交易を受けました`);
        } else {
          game.log.push(`${game.players[other].name}は交易を断りました`);
        }
      } else {
        act('playerTrade', [other, pGive, pGet]);
      }
      ui.data.pGive = null; ui.data.pGet = null;
      playEvents(); persistAndRender(); renderPanel();
    },
    offerTrade: () => {
      act('offerTrade', [other, pGive, pGet]);
      ui.data.pGive = null; ui.data.pGet = null;
      playEvents(); persistAndRender(); renderPanel();
    },
    withdrawTrade: () => { act('withdrawTrade', []); playEvents(); persistAndRender(); renderPanel(); },
    fishOther: (b) => { ui.data.fishOther = Number(b.dataset.p); renderPanel(); },
    bootOther: (b) => { ui.data.bootOther = Number(b.dataset.p); renderPanel(); },
    fishRes: (b) => { ui.data.fishRes = b.dataset.res; renderPanel(); },
    goldRes: (b) => { ui.data.goldRes = b.dataset.res; renderPanel(); },
    gold2Res: (b) => { ui.data.gold2Res = b.dataset.res; renderPanel(); },
    fishRobber: () => { act('fishRobberAway', []); playEvents(); persistAndRender(); renderPanel(); },
    fishSteal: () => { act('fishSteal', [fishOther]); playEvents(); persistAndRender(); renderPanel(); },
    fishResource: () => { act('fishResource', [fishRes]); playEvents(); persistAndRender(); renderPanel(); },
    fishRoadStart: () => { ui = { mode: 'fishRoadPick', data: {} }; renderAll(); },
    fishDev: () => { act('fishDevCard', []); playEvents(); persistAndRender(); renderPanel(); },
    giveBoot: () => { act('giveOldBoot', [ui.data.bootOther == null ? (idx + 1) % game.playerCount : ui.data.bootOther]); playEvents(); persistAndRender(); renderPanel(); },
    goldTrade: () => { act('tradeGold', [goldRes]); playEvents(); persistAndRender(); renderPanel(); },
    resForGold: () => { act('tradeResourceForGold', [gold2Res]); playEvents(); persistAndRender(); renderPanel(); },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}
function fillResPick(container, list, isSelected, build, act) {
  list.forEach((r) => {
    const b = document.createElement('button');
    b.dataset.act = act; b.dataset.res = r;
    if (isSelected(r)) b.classList.add('is-selected');
    build(r, b);
    container.appendChild(b);
  });
}
function fillOtherPick(container, other, act) {
  const idx = E.currentPlayer(game);
  game.players.forEach((_, i) => {
    if (i === idx) return;
    const b = document.createElement('button');
    b.dataset.act = act || 'other'; b.dataset.p = i;
    if (i === other) b.classList.add('is-selected');
    b.textContent = `${game.players[i].name}` + (isCpuSeat(i) ? '（CPU）' : '');
    container.appendChild(b);
  });
}
function fillStepperRow(container, obj, max, prefix) {
  E.RESOURCES.forEach((r) => {
    const span = document.createElement('span');
    span.className = 'stepper';
    span.appendChild(resIcon(r));
    const dec = document.createElement('button'); dec.dataset.act = `${prefix}dec`; dec.dataset.res = r; dec.textContent = '−';
    const b = document.createElement('b'); b.textContent = obj[r];
    const inc = document.createElement('button'); inc.dataset.act = `${prefix}inc`; inc.dataset.res = r; inc.textContent = '＋';
    span.append(dec, b, inc);
    container.appendChild(span);
  });
}

function renderDevMenu() {
  const idx = E.currentPlayer(game);
  const p = game.players[idx];
  const playable = (c) => !game.devCardPlayedThisTurn && !c.played && c.type !== 'vp' && c.boughtTurn !== game.turnNumber;
  const rows = p.devCards.map((c, i) => {
    if (c.played) return '';
    const label = E.DEV_LABEL[c.type];
    if (c.type === 'vp') return `<div class="sheet__row"><span>${label}</span><span>（そのまま得点）</span></div>`;
    return `<div class="sheet__row"><span>${label}</span><button class="ghost-btn" data-act="play" data-i="${i}" ${playable(c) ? '' : 'disabled'}>使う</button></div>`;
  }).join('') || '<p>持っていません</p>';
  els.panel.innerHTML = `<h2>発展カード</h2>${rows}<button class="ghost-btn" data-act="cancel">戻る</button>`;
  bindPanel({
    play: (b) => {
      const i = Number(b.dataset.i);
      const type = p.devCards[i].type;
      if (type === 'knight') ui = { mode: 'devKnightHex', data: { cardIdx: i } };
      else if (type === 'roadBuilding') ui = { mode: 'devRoad1', data: { cardIdx: i, edges: [] } };
      else if (type === 'yearOfPlenty') ui = { mode: 'devYearOfPlenty', data: { cardIdx: i, picked: [] } };
      else if (type === 'monopoly') ui = { mode: 'devMonopoly', data: { cardIdx: i } };
      renderAll();
    },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}

function renderYearOfPlentyPanel() {
  const picked = ui.data.picked;
  els.panel.innerHTML = `<h2>収穫: 好きな資源を2つ選ぶ（${picked.length}/2）</h2>
    <div class="res-pick" data-row="pick"></div>
    <p>選んだ: ${picked.length ? '' : 'なし'}</p>
    <button class="btn btn--accent" data-act="confirm" ${picked.length === 2 ? '' : 'disabled'}>受け取る</button>
    <button class="ghost-btn" data-act="cancel">やめる</button>`;
  fillResPick(els.panel.querySelector('[data-row="pick"]'), E.RESOURCES, () => false, (r, b) => b.appendChild(resIcon(r)), 'pick');
  const p = els.panel.querySelector('p');
  picked.forEach((r) => p.appendChild(resIcon(r)));
  bindPanel({
    pick: (b) => { if (picked.length < 2) { picked.push(b.dataset.res); renderPanel(); } },
    confirm: () => {
      act('playYearOfPlenty', [ui.data.cardIdx, picked[0], picked[1]]);
      ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender();
    },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}
function renderMonopolyPanel() {
  els.panel.innerHTML = `<h2>独占: 総取りする資源を選ぶ</h2>
    <div class="res-pick" data-row="pick"></div>
    <button class="ghost-btn" data-act="cancel">やめる</button>`;
  fillResPick(els.panel.querySelector('[data-row="pick"]'), E.RESOURCES, () => false, (r, b) => b.appendChild(resIcon(r)), 'pick');
  bindPanel({
    pick: (b) => { act('playMonopoly', [ui.data.cardIdx, b.dataset.res]); ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}

// 街道建設: 道・船どちらにも置ける辺をタップしたとき、どちらにするか選ばせる窓
function renderDevRoadKindPanel(eid) {
  els.panel.innerHTML = `<h2>街道建設</h2><p class="sheet__row">道にしますか、船にしますか。</p>
    <button class="btn btn--accent" data-act="road">道にする</button>
    <button class="btn btn--accent" data-act="ship">船にする</button>
    <button class="ghost-btn" data-act="cancel">やめる</button>`;
  bindPanel({
    road: () => resolveDevRoadPick(eid, 'road'),
    ship: () => resolveDevRoadPick(eid, 'ship'),
    cancel: () => { ui.data.pendingEdge = null; renderAll(); },
  });
}

// devRoad2 で「終わってもよい」を押せるように
function renderDevRoadFinish() {
  els.panel.innerHTML = `<h2>街道建設</h2><p class="sheet__row">2本目の道を置くか、ここで終わってください。</p>
    <button class="btn btn--accent" data-act="finish">1本だけで終わる</button>
    <button class="ghost-btn" data-act="cancel">やめる</button>`;
  bindPanel({
    finish: () => { act('playRoadBuilding', [ui.data.cardIdx, ui.data.edges]); ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}

// ================================================================
// 都市と騎士の窓（騎士を操作・都市の発展・進歩カード）
// ================================================================
// 都市と騎士(交易3段階目): 商品2枚で、銀行から好きな資源か商品を1枚もらう
function renderCommodityTradePanel() {
  const idx = E.currentPlayer(game);
  const p = game.players[idx];
  const giving = ui.data.give;
  if (!giving) {
    const rows = E.COMMODITIES.filter((c) => (p.commodities[c] || 0) >= 2)
      .map((c) => `<button class="card-btn" data-act="give" data-c="${c}">${E.COMMODITY_LABEL[c]}を2枚渡す（持っている ${p.commodities[c]}枚）</button>`).join('')
      || '<p>2枚ある商品がありません</p>';
    els.panel.innerHTML = `<h2>商品を交易（2:1）</h2>${rows}<button class="ghost-btn" data-act="cancel">やめる</button>`;
    bindPanel({
      give: (b) => { ui.data.give = b.dataset.c; renderPanel(); },
      cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
    });
    return;
  }
  els.panel.innerHTML = `<h2>もらうものを選ぶ</h2>
    <div class="res-pick" data-row="res"></div>
    <div class="res-pick" data-row="com"></div>
    <button class="ghost-btn" data-act="cancel">やめる</button>`;
  fillResPick(els.panel.querySelector('[data-row="res"]'), E.RESOURCES, () => false, (r, b) => b.appendChild(resIcon(r)), 'res');
  fillResPick(els.panel.querySelector('[data-row="com"]'), E.COMMODITIES, () => false, (c, b) => b.appendChild(resIcon(c)), 'com');
  bindPanel({
    res: (b) => { if (act('tradeCommodity', [giving, 'resource', b.dataset.res])) { ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); } },
    com: (b) => { if (act('tradeCommodity', [giving, 'commodity', b.dataset.res])) { ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); } },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}
function renderKnightMenu() {
  const idx = E.currentPlayer(game);
  const p = game.players[idx];
  const rows = p.knights.map((k) => `<div class="sheet__row">
      <span>${E.KNIGHT_LEVEL_LABEL[k.level]}${k.active ? '（起動中）' : '（休み）'}</span>
      <span>
        <button class="ghost-btn" data-act="activate" data-k="${k.id}" ${E.canActivateKnight(game, idx, k.id) ? '' : 'disabled'}>起動</button>
        <button class="ghost-btn" data-act="upgrade" data-k="${k.id}" ${E.canUpgradeKnight(game, idx, k.id) ? '' : 'disabled'}>昇格</button>
        <button class="ghost-btn" data-act="move" data-k="${k.id}" ${E.movableKnightVertices(game, idx, k.id).length ? '' : 'disabled'}>移動</button>
        <button class="ghost-btn" data-act="expel" data-k="${k.id}" ${E.expellableTargets(game, idx, k.id).length ? '' : 'disabled'}>追い出す</button>
        <button class="ghost-btn" data-act="chase" data-k="${k.id}" ${E.canChaseRobber(game, idx, k.id) ? '' : 'disabled'}>盗賊払い</button>
      </span>
    </div>`).join('') || '<p>騎士はいません</p>';
  els.panel.innerHTML = `<h2>騎士を操作</h2>${rows}<button class="ghost-btn" data-act="cancel">戻る</button>`;
  bindPanel({
    activate: (b) => { act('activateKnight', [Number(b.dataset.k)]); playEvents(); persistAndRender(); },
    upgrade: (b) => { act('upgradeKnight', [Number(b.dataset.k)]); playEvents(); persistAndRender(); },
    move: (b) => { ui = { mode: 'moveKnightTo', data: { knightId: Number(b.dataset.k) } }; renderAll(); },
    expel: (b) => { ui = { mode: 'knightExpelTarget', data: { knightId: Number(b.dataset.k) } }; renderAll(); },
    chase: (b) => { act('chaseRobber', [Number(b.dataset.k)]); playEvents(); persistAndRender(); },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}
function renderKnightExpelPanel() {
  const idx = E.currentPlayer(game);
  const targets = E.expellableTargets(game, idx, ui.data.knightId);
  const rows = targets.map((t, i) => {
    const k = game.players[t.ownerIdx].knights.find((x) => x.id === t.knightId);
    return `<button class="card-btn" data-act="pick" data-i="${i}">${game.players[t.ownerIdx].name}の${E.KNIGHT_LEVEL_LABEL[k.level]}</button>`;
  }).join('') || '<p>追い出せる騎士がいません</p>';
  els.panel.innerHTML = `<h2>騎士を追い出す</h2>${rows}<button class="ghost-btn" data-act="cancel">戻る</button>`;
  bindPanel({
    pick: (b) => {
      const t = targets[Number(b.dataset.i)];
      act('expelKnight', [ui.data.knightId, t.ownerIdx, t.knightId]);
      ui = { mode: 'knightMenu', data: {} };
      playEvents(); persistAndRender();
    },
    cancel: () => { ui = { mode: 'knightMenu', data: {} }; renderAll(); },
  });
}

function renderCityImprovePanel() {
  const idx = E.currentPlayer(game);
  const p = game.players[idx];
  const rows = E.TRACKS.map((t) => {
    const lv = p.cityImprovements[t];
    const costText = lv < 5 ? `商品${E.cityImprovementCost(lv + 1)}枚（${E.COMMODITY_LABEL[E.TRACK_COMMODITY[t]]}）` : '最大';
    const star = E.metropolisOwner(game, t) === idx ? '★大都市' : '';
    return `<div class="sheet__row"><span>${E.TRACK_LABEL[t]} ${lv}/5 ${star}</span><span>${costText}</span>
      <button class="ghost-btn" data-act="up" data-t="${t}" ${E.canImproveCity(game, idx, t) ? '' : 'disabled'}>上げる</button></div>`;
  }).join('');
  els.panel.innerHTML = `<h2>都市の発展</h2>${rows}<button class="ghost-btn" data-act="cancel">戻る</button>`;
  bindPanel({
    up: (b) => { act('improveCity', [b.dataset.t]); playEvents(); persistAndRender(); },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}

// 使うと即座に終わる進歩カード（相手の選び・置き場所などが要らないもの）
const PROGRESS_NO_PARAM = new Set(['tr_vp', 'po_vp', 'sc_vp', 'tr_bankgift', 'tr_cardsteal', 'po_cardsteal', 'sc_cardsteal', 'po_activateall', 'po_wallfree', 'sc_irrigation', 'sc_mining', 'sc_research']);
const PROGRESS_PARAM_MODE = {
  tr_resource1: 'progressRes1', sc_resource1: 'progressRes1', po_resource1: 'progressRes1',
  tr_resource2: 'progressRes2', sc_resource2: 'progressRes2',
  tr_commodity1: 'progressCom1', po_commodity1: 'progressCom1', sc_commodity1: 'progressCom1',
  tr_stealres: 'progressRes1',
  tr_trade21: 'progressTrade1', tr_trade21x2: 'progressTrade2',
  tr_roadfree: 'progressEdge1', sc_roadfree2: 'progressEdge2',
  po_knightfree: 'progressVertex',
  po_upgradefree: 'progressKnightOwn',
  po_deserter: 'progressKnightTarget', po_intrigue: 'progressKnightTarget',
  sc_inventor: 'progressHexA',
};
function renderProgressMenu() {
  const idx = E.currentPlayer(game);
  const p = game.players[idx];
  const rows = p.progressCards.map((c, i) => `<div class="sheet__row"><span>${E.PROGRESS_LABEL[c.id]}</span>
    <button class="ghost-btn" data-act="use" data-i="${i}">使う</button></div>`).join('') || '<p>持っていません</p>';
  els.panel.innerHTML = `<h2>進歩カード（手札上限4）</h2>${rows}<button class="ghost-btn" data-act="cancel">戻る</button>`;
  bindPanel({
    use: (b) => {
      const i = Number(b.dataset.i);
      const card = p.progressCards[i];
      if (PROGRESS_NO_PARAM.has(card.id)) { act('playProgressCard', [i, {}]); playEvents(); persistAndRender(); return; }
      const mode = PROGRESS_PARAM_MODE[card.id];
      if (!mode) return;
      ui = { mode, data: { cardIdx: i, picked: [], edges: [], trades: [], pendingGive: null } };
      renderAll();
    },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}
function renderProgressRes1Panel() {
  els.panel.innerHTML = '<h2>資源を1つ選ぶ</h2><div class="res-pick" data-row="pick"></div><button class="ghost-btn" data-act="cancel">やめる</button>';
  fillResPick(els.panel.querySelector('[data-row="pick"]'), E.RESOURCES, () => false, (r, b) => b.appendChild(resIcon(r)), 'pick');
  bindPanel({
    pick: (b) => { act('playProgressCard', [ui.data.cardIdx, { res: b.dataset.res }]); ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}
function renderProgressRes2Panel() {
  const picked = ui.data.picked;
  els.panel.innerHTML = `<h2>資源を2つ選ぶ（${picked.length}/2）</h2><div class="res-pick" data-row="pick"></div>
    <p>選んだ: ${picked.length ? '' : 'なし'}</p>
    <button class="btn btn--accent" data-act="confirm" ${picked.length === 2 ? '' : 'disabled'}>受け取る</button>
    <button class="ghost-btn" data-act="cancel">やめる</button>`;
  fillResPick(els.panel.querySelector('[data-row="pick"]'), E.RESOURCES, () => false, (r, b) => b.appendChild(resIcon(r)), 'pick');
  const p = els.panel.querySelector('p');
  picked.forEach((r) => p.appendChild(resIcon(r)));
  bindPanel({
    pick: (b) => { if (picked.length < 2) { picked.push(b.dataset.res); renderPanel(); } },
    confirm: () => { act('playProgressCard', [ui.data.cardIdx, { res: picked }]); ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}
function renderProgressCom1Panel() {
  els.panel.innerHTML = '<h2>商品を1つ選ぶ</h2><div class="res-pick" data-row="pick"></div><button class="ghost-btn" data-act="cancel">やめる</button>';
  fillResPick(els.panel.querySelector('[data-row="pick"]'), E.COMMODITIES, () => false, (c, b) => b.appendChild(resIcon(c)), 'pick');
  bindPanel({
    pick: (b) => { act('playProgressCard', [ui.data.cardIdx, { com: b.dataset.res }]); ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}
function renderProgressTradePanel() {
  const times = ui.mode === 'progressTrade2' ? 2 : 1;
  const trades = ui.data.trades;
  const giving = ui.data.pendingGive;
  els.panel.innerHTML = giving == null
    ? `<h2>2:1で渡す資源を選ぶ（${trades.length + 1}/${times}）</h2><div class="res-pick" data-row="give"></div><button class="ghost-btn" data-act="cancel">やめる</button>`
    : '<h2>もらう資源を選ぶ</h2><div class="res-pick" data-row="want"></div><button class="ghost-btn" data-act="cancel">やめる</button>';
  if (giving == null) {
    fillResPick(els.panel.querySelector('[data-row="give"]'), E.RESOURCES, () => false, (r, b) => b.appendChild(resIcon(r)), 'give');
  } else {
    fillResPick(els.panel.querySelector('[data-row="want"]'), E.RESOURCES.filter((r) => r !== giving), () => false, (r, b) => b.appendChild(resIcon(r)), 'want');
  }
  bindPanel({
    give: (b) => { ui.data.pendingGive = b.dataset.res; renderPanel(); },
    want: (b) => {
      trades.push([ui.data.pendingGive, b.dataset.res]);
      ui.data.pendingGive = null;
      if (trades.length >= times) { act('playProgressCard', [ui.data.cardIdx, { trades }]); ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); } else renderPanel();
    },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}
function renderProgressKnightOwnPanel() {
  const idx = E.currentPlayer(game);
  const p = game.players[idx];
  const list = p.knights.filter((k) => k.level < 3 && !(k.level === 2 && (p.cityImprovements.politics || 0) < 3)
    && p.knights.filter((x) => x.level === k.level + 1).length < E.MAX_KNIGHTS_PER_LEVEL);
  const rows = list.map((k) => `<button class="card-btn" data-act="pick" data-k="${k.id}">${E.KNIGHT_LEVEL_LABEL[k.level]} → ${E.KNIGHT_LEVEL_LABEL[k.level + 1]}</button>`).join('') || '<p>昇格できる騎士がいません</p>';
  els.panel.innerHTML = `<h2>騎士を1体、只で昇格</h2>${rows}<button class="ghost-btn" data-act="cancel">やめる</button>`;
  bindPanel({
    pick: (b) => { act('playProgressCard', [ui.data.cardIdx, { knightId: Number(b.dataset.k) }]); ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}
function renderProgressKnightTargetPanel() {
  const idx = E.currentPlayer(game);
  const card = game.players[idx].progressCards[ui.data.cardIdx];
  const isIntrigue = card.id === 'po_intrigue';
  const list = [];
  game.players.forEach((op, oi) => {
    if (oi === idx) return;
    op.knights.forEach((k) => {
      if (isIntrigue) {
        const near = game.players[idx].knights.some((mk) => game.board.vertices[mk.vertexId].neighbors.includes(k.vertexId));
        if (!near) return;
      }
      list.push({ ownerIdx: oi, knightId: k.id, level: k.level });
    });
  });
  const rows = list.map((t, i) => `<button class="card-btn" data-act="pick" data-i="${i}">${game.players[t.ownerIdx].name}の${E.KNIGHT_LEVEL_LABEL[t.level]}</button>`).join('') || '<p>対象がいません</p>';
  els.panel.innerHTML = `<h2>${E.PROGRESS_LABEL[card.id]}</h2>${rows}<button class="ghost-btn" data-act="cancel">やめる</button>`;
  bindPanel({
    pick: (b) => {
      const t = list[Number(b.dataset.i)];
      act('playProgressCard', [ui.data.cardIdx, { ownerIdx: t.ownerIdx, knightId: t.knightId }]);
      ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender();
    },
    cancel: () => { ui = { mode: 'idle', data: {} }; renderAll(); },
  });
}

// ================================================================
// 操作ボタン
// ================================================================
// CPU の手番・捨て札の最中は、盤やボタンを人が触っても動かない（CPUの手として誤って進んでしまうのを防ぐ）。
// 通信対戦では「自分の席が今動いてよいか」に読み替える（ほかの人の番には押せない）
function humansTurn() {
  if (!game) return false;
  if (onlineRoom) {
    const mySeat = mySeatIndex();
    if (mySeat == null) return false; // 席に座っていない（ありえないが念のため）
    if (game.phase === 'discard') return game.pendingDiscards.some((d) => d.player === mySeat);
    if (game.phase === 'goldPick') return game.pendingGoldPicks.some((d) => d.player === mySeat);
    if (game.phase === 'scienceBonus') return game.pendingScienceBonus.some((p) => p === mySeat);
    if (game.phase === 'camelPlace') return game.camelDecider === mySeat;
    return E.actingPlayer(game) === mySeat;
  }
  if (game.phase === 'discard') return game.pendingDiscards.some((d) => !isCpuSeat(d.player));
  if (game.phase === 'goldPick') return game.pendingGoldPicks.some((d) => !isCpuSeat(d.player));
  if (game.phase === 'scienceBonus') return game.pendingScienceBonus.some((p) => !isCpuSeat(p));
  if (game.phase === 'camelPlace') return !isCpuSeat(game.camelDecider);
  return !isCpuSeat(E.currentPlayer(game));
}
function renderActionBar() {
  const rollable = game.phase === 'roll' && humansTurn();
  const inSBP = game.phase === 'specialBuilding'; // 特別建設フェイズ: 建てる・発展カードを買うだけできる（交易・発展カードを使うのは不可）
  const buildable = (game.phase === 'main' || inSBP) && humansTurn();
  els.diceBtn.disabled = !rollable || rolling;
  els.tradeBtn.disabled = !buildable || inSBP;
  els.devBtn.disabled = !buildable || inSBP;
  const ckPlayer = game.players[E.currentPlayer(game)];
  if (ckPlayer.progressCards) {
    const n = ckPlayer.progressCards.length;
    els.devBtn.textContent = `進歩カード${n ? ` ${n}` : ''}`;
  } else {
    const n = ckPlayer.devCards.filter((c) => !c.played).length;
    els.devBtn.textContent = `発展カード${n ? ` ${n}` : ''}`;
  }
  els.endTurnBtn.disabled = !buildable;
  els.endTurnBtn.textContent = inSBP ? 'パス' : '手番を終える';
}
// ルーレットのように目を入れ替え、だんだん遅くして止めてから onDone を呼ぶ（振った本人・通信で見ている側の両方で使う）。
// 1つめを先に止め、2つめは少し（0.4〜0.6秒ほど）遅らせて止めて「溜め」を作る。
// final（本当の出目 [d1, d2]）が分かっているときはその目に収束させ、合計に応じた演出も出す
// （通信対戦で自分がまだ振った覚え（selfRolledPending）だけで本当の目を知らないときは final なしで渡ってくる）。
function spinDiceOnce(onDone, final) {
  rolling = true;
  els.diceBtn.disabled = true;
  const face = () => 1 + Math.floor(Math.random() * 6);
  const sum = final ? final[0] + final[1] : null;
  const rotA = Math.random() * 60 - 30, rotB = Math.random() * 60 - 30;
  let vA = face(), vB = face(), aDone = false, bDone = false, delay = 40;
  const paint = (lockA, lockB) => {
    els.diceBox.innerHTML = '';
    const dA = dieEl(vA, aDone ? -8 : rotA); if (lockA) dA.classList.add('die--lock');
    const dB = dieEl(vB, bDone ? 7 : rotB); if (lockB) dB.classList.add('die--lock');
    els.diceBox.appendChild(dA); els.diceBox.appendChild(dB);
  };
  paint();
  const stopB = () => {
    if (bDone) return;
    bDone = true;
    vB = final ? final[1] : vB;
    applyDiceSumEffects(sum); // 箱に当たり演出の色クラスを足してから、弾む目を描く（同じ瞬間なのでCSSに間に合う）
    paint(true, true);
    diceClick();
    rolling = false;
    onDone();
  };
  const tick = () => {
    if (!aDone) vA = face();
    if (!bDone) vB = face();
    paint();
    diceClick();
    delay *= 1.25;
    if (!aDone && delay >= 260) {
      aDone = true;
      vA = final ? final[0] : vA;
      paint(true);
      const until = performance.now() + 400 + Math.random() * 200;
      const keepB = () => { // 1つめが止まったあとも、2つめだけ少しの間回り続ける
        if (bDone) return;
        if (performance.now() >= until) { stopB(); return; }
        vB = face(); paint(true); diceClick();
        setTimeout(keepB, 70);
      };
      keepB();
      return;
    }
    if (!bDone) setTimeout(tick, delay);
  };
  tick();
}
els.diceBtn.addEventListener('click', () => {
  if (rolling || game.phase !== 'roll' || !humansTurn()) return;
  const guest = isOnlineGuest();
  // ホスト・1台モードは engine をその場で呼ぶだけなので、先に出目を決めて演出をそれに合わせられる
  // （rollDice の rng に決めた目を渡す。resolveEventDie 等その先の抽選は通常どおり Math.random に任せる）。
  // 通信対戦のゲストは結果がホスト次第なので決め打ちできず、今までどおりただ回すだけになる。
  const preset = guest ? null : [1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)];
  const presetRng = preset && (() => {
    const queue = [(preset[0] - 0.5) / 6, (preset[1] - 0.5) / 6];
    return () => (queue.length ? queue.shift() : Math.random());
  })();
  const finish = () => {
    if (guest) selfRolledPending = true; // 戻ってきた状態でもう一度回転させない
    act('rollDice', presetRng ? [presetRng] : []);
    ui = { mode: modeForPhase(), data: {} };
    playEvents();
    persistAndRender();
  };
  if (document.documentElement.classList.contains('motion-off')) {
    finish();
    if (preset) applyDiceSumEffects(preset[0] + preset[1]);
    return;
  }
  spinDiceOnce(finish, preset);
});
els.tradeBtn.addEventListener('click', () => { if (!humansTurn()) return; ui = { mode: 'tradeMenu', data: {} }; renderAll(); });
els.devBtn.addEventListener('click', () => {
  if (!humansTurn()) return;
  const p = game.players[E.currentPlayer(game)];
  ui = { mode: p.progressCards ? 'progressMenu' : 'devMenu', data: {} };
  renderAll();
});
els.endTurnBtn.addEventListener('click', () => {
  if (!humansTurn()) return;
  if (game.phase === 'specialBuilding') act('passSpecialBuild', []); else act('endTurn', []);
  ui = { mode: 'idle', data: {} };
  persistAndRender();
});

// ================================================================
// 盤面のタップ
// ================================================================
els.board.addEventListener('click', (e) => {
  if (!humansTurn()) return;
  const vEl = e.target.closest('[data-vertex]');
  const eEl = e.target.closest('[data-edge]');
  const hEl = e.target.closest('[data-hex]');
  if (vEl) return onVertexTap(Number(vEl.dataset.vertex));
  if (eEl) return onEdgeTap(Number(eEl.dataset.edge));
  if (hEl) return onHexTap(Number(hEl.dataset.hex));
});

function onVertexTap(vid) {
  if (ui.mode === 'setupSettlement') { act('setupPlaceSettlement', [vid]); ui = { mode: modeForPhase(), data: {} }; playEvents(); persistAndRender(); return; }
  if (ui.mode === 'buildSettlement') { if (act('buildSettlement', [vid])) { ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); } return; }
  if (ui.mode === 'buildCity') { if (act('buildCity', [vid])) { ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); } return; }
  if (ui.mode === 'buildKnight') { if (act('buildKnight', [vid])) { ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); } return; }
  if (ui.mode === 'moveKnightTo') {
    if (act('moveKnight', [ui.data.knightId, vid])) { ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); }
    return;
  }
  if (ui.mode === 'progressVertex') {
    if (act('playProgressCard', [ui.data.cardIdx, { vertex: vid }])) { ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); }
    return;
  }
}
function onEdgeTap(eid) {
  if (game.phase === 'camelPlace') { if (act('placeCamel', [eid])) { playEvents(); persistAndRender(); } return; }
  if (ui.mode === 'setupRoad') { act('setupPlaceRoad', [eid]); ui = { mode: modeForPhase(), data: {} }; playEvents(); persistAndRender(); return; }
  if (ui.mode === 'buildRoad') { if (act('buildRoad', [eid])) { ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); } return; }
  if (ui.mode === 'buildShip') { if (act('buildShip', [eid])) { ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); } return; }
  if (ui.mode === 'moveShip1') {
    const idx = E.currentPlayer(game);
    if (E.movableShipEdges(game, idx).includes(eid)) { ui = { mode: 'moveShip2', data: { from: eid } }; renderAll(); }
    return;
  }
  if (ui.mode === 'moveShip2') { if (act('moveShip', [ui.data.from, eid])) { ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); } return; }
  if (ui.mode === 'buildWarKnight') { if (act('buildWarKnight', [eid])) { ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); } return; }
  if (ui.mode === 'fishRoadPick') { if (act('fishRoad', [eid])) { ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); } return; }
  if (ui.mode === 'moveWarKnight1') {
    const idx = E.currentPlayer(game);
    const k = game.players[idx].warKnights.find((x) => x.edgeId === eid && E.movableWarKnightEdges(game, idx, x.id, false).length);
    if (k) { ui = { mode: 'moveWarKnight2', data: { knightId: k.id } }; renderAll(); }
    return;
  }
  if (ui.mode === 'moveWarKnight2') { if (act('moveWarKnight', [ui.data.knightId, eid, false])) { ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); } return; }
  if (ui.mode === 'devRoad1' || ui.mode === 'devRoad2') { onDevRoadEdgeTap(eid); return; }
  if (ui.mode === 'progressEdge1') {
    if (!E.canPlaceRoad(game, eid, E.currentPlayer(game))) return;
    if (act('playProgressCard', [ui.data.cardIdx, { edge: eid }])) { ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); }
    return;
  }
  if (ui.mode === 'progressEdge2') {
    if (!E.canPlaceRoad(game, eid, E.currentPlayer(game)) || ui.data.edges.includes(eid)) return;
    ui.data.edges.push(eid);
    if (ui.data.edges.length >= 2) {
      if (act('playProgressCard', [ui.data.cardIdx, { edges: ui.data.edges }])) { ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); }
    } else renderAll();
  }
}
// 街道建設: 道だけに置ける／船だけに置けるならそのまま進む。どちらも置ける辺（海沿い）なら窓で選ばせる。
function onDevRoadEdgeTap(eid) {
  const idx = E.currentPlayer(game);
  const canRoad = E.canPlaceRoad(game, eid, idx);
  const canShip = game.board.pirateHex != null && E.canPlaceShip(game, eid, idx);
  if (!canRoad && !canShip) return;
  if (canRoad && canShip) { ui.data.pendingEdge = eid; renderAll(); return; }
  resolveDevRoadPick(eid, canShip ? 'ship' : 'road');
}
function resolveDevRoadPick(eid, kind) {
  const item = kind === 'ship' ? { id: eid, kind: 'ship' } : eid;
  if (ui.mode === 'devRoad1') {
    ui.data.edges = [item];
    ui.mode = 'devRoad2';
    ui.data.pendingEdge = null;
    renderAll();
  } else {
    const picked = [...ui.data.edges, item];
    act('playRoadBuilding', [ui.data.cardIdx, picked]);
    ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender();
  }
}
function hexCurrentPos(hid) { return game.board.hexes[hid].terrain === 'water' ? game.board.pirateHex : game.board.robberHex; }
function onHexTap(hid) {
  if (ui.mode === 'moveRobber') {
    if (hid === hexCurrentPos(hid)) return;
    const idx = E.currentPlayer(game);
    const targets = E.banditTargets(game, hid, idx);
    if (targets.length > 1) { ui.data.pendingHex = hid; ui.data.forDev = null; renderAll(); }
    else { act('moveRobber', [hid, targets[0] ?? null]); ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); }
    return;
  }
  if (ui.mode === 'devKnightHex') {
    if (hid === hexCurrentPos(hid)) return;
    const idx = E.currentPlayer(game);
    const targets = E.banditTargets(game, hid, idx);
    if (targets.length > 1) { ui.data.pendingHex = hid; ui.data.forDev = ui.data.cardIdx; renderAll(); }
    else { act('playKnight', [ui.data.cardIdx, hid, targets[0] ?? null]); ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); }
    return;
  }
  if (ui.mode === 'progressHexA') {
    if (game.board.hexes[hid].number == null) return;
    ui.data.hexA = hid; ui.mode = 'progressHexB'; renderAll();
    return;
  }
  if (ui.mode === 'progressHexB') {
    if (game.board.hexes[hid].number == null || hid === ui.data.hexA) return;
    if (act('playProgressCard', [ui.data.cardIdx, { hexA: ui.data.hexA, hexB: hid }])) { ui = { mode: 'idle', data: {} }; playEvents(); persistAndRender(); }
  }
}
// 3Dの盤(board3d.js)からのタップ。els.board の click ハンドラ(SVG用、画面には出ない)と同じ入口を通す
export function boardTap3D(kind, id) {
  if (!humansTurn()) return;
  if (kind === 'vertex') onVertexTap(id);
  else if (kind === 'edge') onEdgeTap(id);
  else if (kind === 'hex') onHexTap(id);
}

// ================================================================
// まとめて描画
// ================================================================
// ---- タイトルの飾りの盤（操作できない、見た目だけ） ----
renderBoardInto(els.titleBoard, E.createGame(4, Math.random), null);

function renderAll() {
  if (!game) return;
  if (game.phase === 'moveRobber' && ui.mode !== 'moveRobber' && ui.mode !== 'robberTarget') ui = { mode: 'moveRobber', data: {} };
  if (game.phase === 'discard' && ui.mode !== 'discard') ui = { mode: 'discard', data: {} };
  if (game.phase === 'goldPick' && ui.mode !== 'goldPick') ui = { mode: 'goldPick', data: {} };
  if (game.phase === 'scienceBonus' && ui.mode !== 'scienceBonus') ui = { mode: 'scienceBonus', data: {} };
  renderBoard3D(game, ui, renderBoardInto(els.board, game, ui));
  renderDice();
  renderPlayers();
  renderBank();
  renderHand();
  renderCk();
  renderSoccer();
  renderBuildGrid();
  renderBanner();
  renderActionBar();
  renderPanel();
  announceMyTurn();
  scheduleCpu(); // CPUの番なら、ここで自動進行の予約をする（renderAllはすべての操作の後に呼ばれる）
}

// 通信対戦: 自分の番になった瞬間に1回だけ短い音を鳴らす（同じ番の間に何度renderAllが呼ばれても鳴らし直さない）
let announcedTurnKey = null;
function announceMyTurn() {
  if (!onlineRoom || !game) { announcedTurnKey = null; return; }
  const key = `${game.turnNumber}:${game.phase}:${E.actingPlayer(game)}`;
  if (!humansTurn() || game.phase === 'discard') { announcedTurnKey = key; return; }
  if (announcedTurnKey === key) return;
  announcedTurnKey = key;
  if (!document.hidden) playSound('myTurn');
}
