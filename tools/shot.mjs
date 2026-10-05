#!/usr/bin/env node
'use strict';
// 盤を同じ配置・同じカメラで撮り、前後を比べるための道具。sw.js のキャッシュ一覧には入れない(撮影専用)。
//
// 使い方:
//   node tools/shot.mjs capture --ref <commit|''> --quality mid|high --out <出力先ディレクトリ> --tag <名前>
//     → 既定の3カメラ(default/close/low45)で1280x800のPNGを撮る(<out>/<tag>-<カメラ>.png)
//   node tools/shot.mjs terrain --quality mid|high --out <出力先ディレクトリ> --tag <名前> [--ref <commit>]
//     → 地形ごとに最初のマスへ寄った1枚(<out>/<地形>-<tag>.png。森・牧草地・麦畑・丘・山・砂漠)
//   node tools/shot.mjs frame [--ref <commit>] [--gpu 1] → 中・高のフレーム時間(参考値)
//   (capture/terrainに --query "&x=1" を付けると撮影URLに足す。調べもの用)
//   node tools/shot.mjs compare --out <png> --set "ラベル:ref=<commit>,q=<mid|high>" --set "ラベル2:..." ...
//     → 複数の組をまとめて撮り、ラベル付きで並べた1枚を作る(行=組、列=カメラ)
//
// --ref を省くと今の作業ツリー(このファイルのあるリポジトリ)をそのまま使う。
// --ref にコミットを指定すると git worktree で一時フォルダに取り出し、そこを配る。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import * as E from '../engine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..'); // apps/catan-3d
const HUB = path.resolve(REPO, '../../t-of.github.io'); // 本部(playwright-coreを借りる)
const PW_ENTRY = path.join(HUB, 'node_modules/playwright-core/index.mjs');

const SCALE = 66; // board3d.jsのSCALEと同じ(頂点x,yをワールド座標にする倍率)

// ---- 決まった盤(常に同じ盤になる。3人・基本盤・固定シード) ----
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// セットアップ(開拓地+道を2回ずつ)を、頂点配列の先頭から試せる場所に機械的に置いていく。
// 距離の決まり(隣接禁止)はengine.js側が守るので、ここでは「置けたら次へ」でよい。
function autoSetup(game) {
  let guard = 0;
  while (game.phase === 'setup1' || game.phase === 'setup2') {
    if (guard++ > 1000) throw new Error('セットアップが収束しない');
    if (game.setupPending === 'settlement') {
      const placed = game.board.vertices.some((v) => E.setupPlaceSettlement(game, v.id));
      if (!placed) throw new Error('置ける頂点がない');
    } else {
      const lastV = game.board.vertices[game.setupLastVertex];
      const placed = lastV.edgeIds.some((eId) => game.board.edges[eId].road == null && E.setupPlaceRoad(game, eId));
      if (!placed) throw new Error('置ける辺がない');
    }
  }
}
export function buildFixedGame() {
  const rng = mulberry32(20261005);
  const game = E.createGame(3, rng, { names: ['プレイヤー1', 'プレイヤー2', 'プレイヤー3'] });
  autoSetup(game); // ここまでで開拓地2つ+道2本 x 3人、phaseは'roll'になる
  // 1人目は1つ目の開拓地を都市に昇格(建物の見比べができるように)。コストは撮影用なので無視する。
  const p0 = game.players[0];
  const cityV = game.board.vertices[p0.settlements[0]];
  cityV.building.type = 'city';
  p0.settlements = p0.settlements.filter((id) => id !== cityV.id);
  p0.cities.push(cityV.id);
  game.phase = 'main';
  game.turn = 0;
  game.turnNumber = 5;
  game.diceLast = [4, 4]; // engine.jsの形([d1, d2])に合わせる(数のままだと「サイコロ undefined+undefined=NaN」になる)
  // 盗賊を砂漠以外のどこかへ(陸のマスで、今の位置と違うもの)
  const desertId = game.board.robberHex;
  const other = game.board.hexes.find((h) => h.terrain !== 'desert' && h.terrain !== 'water' && h.id !== desertId);
  if (other) game.board.robberHex = other.id;
  const seats = Array.from({ length: 3 }, () => ({ type: 'human', level: 'normal' }));
  return { game, seats, cityVertex: cityV };
}

// ---- カメラの決まった3地点。盤の大きさ(頂点の最大半径)から決める。既定/寄り/低め斜め45度。 ----
function cameraPresets(game, cityVertex) {
  let maxR = 0;
  game.board.vertices.forEach((v) => { maxR = Math.max(maxR, Math.hypot(v.x * SCALE, v.y * SCALE)); });
  const cx = cityVertex.x * SCALE, cz = cityVertex.y * SCALE;
  const dist = maxR * 1.9;
  return {
    default: { pos: [0, dist * 0.78, dist * 0.68], tgt: [0, 0, 0] },
    close: { pos: [cx + 50, 90, cz + 50], tgt: [cx, 8, cz] }, // 斜め上約50°から集落を見下ろす寄り
    low45: { pos: [dist * 0.74, dist * 0.30, dist * 0.74], tgt: [0, 0, 0] }, // 低め斜め45度
  };
}
function camParam(p) { return `${p.pos.join(',')},${p.tgt.join(',')}`; }

// ---- 静的配信(そのディレクトリをそのまま返すだけ。撮影専用なので凝らない) ----
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.hdr': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
};
function serveDir(dir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/') p = '/index.html';
      const file = path.join(dir, p);
      if (!file.startsWith(dir)) { res.writeHead(403); res.end(); return; }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
// --ref が指定されていれば、そのコミットを git worktree で一時フォルダに取り出して返す(片付け関数つき)。
// 指定なしなら今の作業ツリーをそのまま返す。
function resolveTreeDir(ref) {
  if (!ref) return { dir: REPO, cleanup: () => {} };
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'catan3d-shot-'));
  fs.rmdirSync(dir);
  execSync(`git worktree add --detach "${dir}" ${ref}`, { cwd: REPO, stdio: 'pipe' });
  return { dir, cleanup: () => { try { execSync(`git worktree remove --force "${dir}"`, { cwd: REPO, stdio: 'pipe' }); } catch {} } };
}

async function withBrowser(fn) {
  const { chromium } = await import(PW_ENTRY);
  // --gpu: 実機のGPU(macOSならMetal)で描かせる。付けないと既定の(遅い)描画になり、フレーム時間は参考にならない
  const browser = await chromium.launch(args.gpu ? { args: ['--use-angle=metal', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'] } : {});
  try { return await fn(browser); } finally { await browser.close(); }
}

// 1カメラぶんを撮る: localStorageに決まった盤を仕込んでから開き、「つづきから」を押して盤面に入る。
async function shootOne(browser, base, quality, cam) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  // コンソールのエラー・警告(シェーダのコンパイル失敗など)はそのまま端末に出す
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text().slice(0, 2000)); });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  const { game, seats } = buildFixedGame();
  await page.addInitScript(([g, s]) => {
    localStorage.setItem('catan-3d.game', JSON.stringify(g));
    localStorage.setItem('catan-3d.gameSeats', JSON.stringify(s));
    localStorage.setItem('catan-3d.motion', 'false'); // 比較画像がちらつかないよう、撮影中は動き(波・風)を止める
  }, [game, seats]);
  const url = `${base}/?q=${quality}&cam=${encodeURIComponent(camParam(cam))}${EXTRA_QUERY}`;
  await page.goto(url, { waitUntil: 'load' });
  const continueBtn = page.locator('#continueBtn');
  await continueBtn.waitFor({ state: 'visible', timeout: 5000 });
  await continueBtn.click();
  await page.waitForTimeout(1200); // テクスチャ・環境マップの読み込み・初回描画を待つ
  const shot = await page.screenshot();
  await page.close();
  return shot;
}

async function captureSet(browser, dir, quality) {
  const server = await serveDir(dir);
  const base = `http://127.0.0.1:${server.address().port}`;
  const { game, cityVertex } = buildFixedGame();
  const cams = cameraPresets(game, cityVertex);
  const shots = {};
  for (const [name, cam] of Object.entries(cams)) shots[name] = await shootOne(browser, base, quality, cam);
  server.close();
  return shots;
}

function parseArgs(argv) {
  const out = { _: [], sets: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--set') { out.sets.push(argv[++i]); continue; }
    if (a.startsWith('--')) { out[a.slice(2)] = argv[++i]; continue; }
    out._.push(a);
  }
  return out;
}
function parseSetSpec(spec) {
  // "ラベル:ref=0df6c13,q=high" / "ラベル:q=mid" (refを省くと作業ツリー)
  const [label, rest = ''] = spec.split(/:(.*)/s);
  const opts = { ref: '', q: 'mid' };
  rest.split(',').filter(Boolean).forEach((kv) => {
    const [k, v] = kv.split('=');
    if (k === 'ref') opts.ref = v; else if (k === 'q') opts.q = v;
  });
  return { label, ...opts };
}

const CAM_LABELS = { default: '既定', close: '寄り', low45: '低め斜め45°' };

async function cmdCapture(args) {
  const outDir = args.out || path.join(HUB, '.audit');
  fs.mkdirSync(outDir, { recursive: true });
  const { dir, cleanup } = resolveTreeDir(args.ref || '');
  try {
    await withBrowser(async (browser) => {
      const shots = await captureSet(browser, dir, args.quality || 'mid');
      for (const [name, buf] of Object.entries(shots)) {
        const file = path.join(outDir, `${args.tag || 'shot'}-${name}.png`);
        fs.writeFileSync(file, buf);
        console.log('書いた:', file);
      }
    });
  } finally { cleanup(); }
}

// ラベル付きで並べた1枚を作る(行=組、列=カメラ)。audit.mjsのmakeSheetと同じ、
// 1枚のHTMLにdata URLで並べてスクリーンショットする方法(追加の画像ライブラリを増やさない)。
async function cmdCompare(args) {
  const specs = args.sets.map(parseSetSpec);
  if (!specs.length) { console.error('--set が要る(例: --set "前:ref=0df6c13,q=mid")'); process.exit(1); }
  const camNames = ['default', 'close', 'low45'];
  const rows = [];
  await withBrowser(async (browser) => {
    for (const spec of specs) {
      const { dir, cleanup } = resolveTreeDir(spec.ref);
      try {
        const shots = await captureSet(browser, dir, spec.q);
        rows.push({ label: spec.label, q: spec.q, shots });
      } finally { cleanup(); }
    }
  });
  const cellW = 400, gap = 10, labelH = 26;
  const cols = camNames.length;
  const totalW = cellW * cols + gap * (cols + 1);
  const cellH = Math.round(cellW * 800 / 1280);
  const rowH = cellH + labelH + gap;
  const totalH = rowH * rows.length + gap;
  let body = '';
  rows.forEach((row, ri) => {
    camNames.forEach((cam, ci) => {
      const x = gap + ci * (cellW + gap), y = gap + ri * rowH;
      const b64 = row.shots[cam].toString('base64');
      body += `<div style="position:absolute;left:${x}px;top:${y}px;width:${cellW}px;font:14px sans-serif;color:#222">${row.label}(${row.q}) ${CAM_LABELS[cam]}</div>`;
      body += `<img src="data:image/png;base64,${b64}" style="position:absolute;left:${x}px;top:${y + labelH}px;width:${cellW}px;height:${cellH}px;object-fit:cover">`;
    });
  });
  await withBrowser(async (browser) => {
    const page = await browser.newPage({ viewport: { width: totalW, height: totalH } });
    await page.setContent(`<body style="margin:0;background:#fff;position:relative;width:${totalW}px;height:${totalH}px">${body}</body>`);
    const out = args.out || path.join(HUB, '.audit', 'catan3d-compare.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await page.screenshot({ path: out });
    await page.close();
    console.log('書いた:', out);
  });
}

// 地形ごとの寄り: そのマスの中心を斜め上(約45°)から、マスが画面いっぱいになる距離で見る
async function cmdTerrain(args) {
  const outDir = args.out || path.join(HUB, '.audit');
  fs.mkdirSync(outDir, { recursive: true });
  const { game } = buildFixedGame();
  const { dir, cleanup } = resolveTreeDir(args.ref || '');
  try {
    await withBrowser(async (browser) => {
      const server = await serveDir(dir);
      const base = `http://127.0.0.1:${server.address().port}`;
      for (const terrain of ['forest', 'pasture', 'field', 'hills', 'mountains', 'desert']) {
        const hex = game.board.hexes.find((h) => h.terrain === terrain);
        if (!hex) continue;
        const vs = hex.vertexIds.map((id) => game.board.vertices[id]);
        const cx = vs.reduce((a, v) => a + v.x, 0) / vs.length * SCALE, cz = vs.reduce((a, v) => a + v.y, 0) / vs.length * SCALE;
        const cam = { pos: [cx, 125, cz + 105], tgt: [cx, 14, cz] };
        const buf = await shootOne(browser, base, args.quality || 'mid', cam);
        const file = path.join(outDir, `${terrain}-${args.tag || 'shot'}.png`);
        fs.writeFileSync(file, buf);
        console.log('書いた:', file);
      }
      server.close();
    });
  } finally { cleanup(); }
}

async function cmdFrame(args) {
  // 参考値: 中/高のフレーム時間を数秒測る(フレームを連続ではかるだけの簡易測定)
  const { dir, cleanup } = resolveTreeDir(args.ref || '');
  try {
    await withBrowser(async (browser) => {
      const server = await serveDir(dir);
      const base = `http://127.0.0.1:${server.address().port}`;
      for (const quality of ['mid', 'high']) {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        const { game, seats } = buildFixedGame();
        await page.addInitScript(([g, s]) => {
          localStorage.setItem('catan-3d.game', JSON.stringify(g));
          localStorage.setItem('catan-3d.gameSeats', JSON.stringify(s));
        }, [game, seats]);
        await page.goto(`${base}/?q=${quality}`, { waitUntil: 'load' });
        if (quality === 'mid') console.log('GPU:', await page.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl2'); const d = gl && gl.getExtension('WEBGL_debug_renderer_info'); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : '?'; }));
        await page.locator('#continueBtn').click();
        await page.waitForTimeout(1500);
        const ms = await page.evaluate(() => new Promise((resolve) => {
          let n = 0, t0 = performance.now();
          function tick() { n++; if (n < 90) requestAnimationFrame(tick); else resolve((performance.now() - t0) / n); }
          requestAnimationFrame(tick);
        }));
        console.log(`${quality}: ${ms.toFixed(2)}ms/フレーム`);
        await page.close();
      }
      server.close();
    });
  } finally { cleanup(); }
}

const [, , cmd, ...rest] = process.argv;
const args = parseArgs(rest);
// --query "&foo=1" で撮影URLに任意のクエリを足せる(調べもの用)
var EXTRA_QUERY = args.query || '';
if (cmd === 'capture') await cmdCapture(args);
else if (cmd === 'compare') await cmdCompare(args);
else if (cmd === 'frame') await cmdFrame(args);
else if (cmd === 'terrain') await cmdTerrain(args);
else { console.error('使い方: shot.mjs capture|compare|frame|terrain ...'); process.exit(1); }
