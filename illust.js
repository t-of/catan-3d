'use strict';
// イラスト版の絵の素材。SVG の <path> に渡す d 文字列と塗り色だけを作る小さな関数の集まり。
// 図形は「もう配置してある絵」（.audit/catan-design/Illust.dc.html の lib() をそのまま移した）。
// 盤の組み立て（タイルの並び・道・建物など、ゲームの状態を読む部分）は main.js が行う。

function f(n) { return Math.round(n * 10) / 10; }

// shapes 配列に1枚追加する。d=パス、fill=塗り、o=不透明度、sk=ふち色、sw=ふちの太さ。
export function add(arr, d, fill, o, sk, sw) { arr.push({ d, f: fill, o: o ?? 1, sk: sk || 'none', sw: sw || 0 }); }
// 動きの印。start 以降に足した図形に、CSS アニメーションのクラス c と回転・反転の中心 (ox,oy)、ずらす秒 dl を付ける。
// 同じ印の図形は同じ動きをするので、木や羊が 1 つの絵としてまとまって動く（style.css の .a-*）。
export function tag(arr, start, c, ox, oy, dl) { for (let i = start; i < arr.length; i++) Object.assign(arr[i], { c, ox, oy, dl }); }

export function ell(x, y, rx, ry) { return 'M' + f(x - rx) + ',' + f(y) + ' a' + f(rx) + ',' + f(ry) + ' 0 1,0 ' + f(2 * rx) + ',0 a' + f(rx) + ',' + f(ry) + ' 0 1,0 ' + f(-2 * rx) + ',0 Z'; }
export function rect(x, y, w, h) { return 'M' + f(x) + ',' + f(y) + ' h' + f(w) + ' v' + f(h) + ' h' + f(-w) + ' Z'; }
export function poly(pts) { return 'M' + pts.map((p) => f(p[0]) + ',' + f(p[1])).join(' L') + ' Z'; }
export function line(x1, y1, x2, y2) { return 'M' + f(x1) + ',' + f(y1) + ' L' + f(x2) + ',' + f(y2); }

// 色を明るく（k>0）・暗く（k<0）する
export function tint(hex, k) {
  return '#' + [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16);
    const n = k < 0 ? v * (1 + k) : v + (255 - v) * k;
    return Math.round(n).toString(16).padStart(2, '0');
  }).join('');
}

// ---- 地形の飾り（木・羊・麦の束・レンガ・山・サボテン） ----
export function tree(a, x, y, s) {
  add(a, ell(x + 3 * s, y + 1 * s, 10 * s, 3 * s), '#0b2a14', 0.3);
  add(a, rect(x - 1.5 * s, y - 5 * s, 3 * s, 6 * s), '#6b4a2b');
  add(a, poly([[x - 10 * s, y - 4 * s], [x, y - 22 * s], [x, y - 4 * s]]), '#4c9c57');
  add(a, poly([[x, y - 22 * s], [x + 10 * s, y - 4 * s], [x, y - 4 * s]]), '#2b6a39');
  add(a, poly([[x - 7 * s, y - 13 * s], [x, y - 29 * s], [x, y - 13 * s]]), '#62b46a');
  add(a, poly([[x, y - 29 * s], [x + 7 * s, y - 13 * s], [x, y - 13 * s]]), '#367c44');
}
export function sheep(a, x, y, s) {
  add(a, ell(x, y + 2 * s, 11 * s, 3 * s), '#2f4a1c', 0.28);
  [-6, -1, 4].forEach((dx) => add(a, rect(x + dx * s, y - 4 * s, 2 * s, 6 * s), '#3a3330'));
  add(a, ell(x - 4 * s, y - 8 * s, 5 * s, 4.5 * s) + ell(x + 1 * s, y - 10 * s, 5.5 * s, 5 * s) + ell(x + 5 * s, y - 7 * s, 4.5 * s, 4 * s) + ell(x, y - 6 * s, 7 * s, 4 * s), '#f7f2e7');
  add(a, ell(x, y - 4.5 * s, 6 * s, 1.8 * s), '#d8cfbb', 0.7);
  add(a, ell(x + 9 * s, y - 9 * s, 3 * s, 3.6 * s), '#3a3330');
  add(a, ell(x + 7.5 * s, y - 12 * s, 1.8 * s, 1 * s), '#3a3330');
}
export function sheaf(a, x, y, s) {
  add(a, ell(x, y + 1 * s, 8 * s, 2.5 * s), '#6b4a14', 0.3);
  for (let i = -3; i <= 3; i++) {
    add(a, line(x + i * 1.2 * s, y, x + i * 2.6 * s, y - 19 * s), 'none', 1, '#c08a2a', 1.4 * s);
    add(a, ell(x + i * 2.6 * s, y - 21 * s, 1.7 * s, 3.4 * s), '#f4cf62');
  }
  add(a, rect(x - 4.5 * s, y - 9 * s, 9 * s, 2.2 * s), '#8f611d');
}
export function bricks(a, x, y, s) {
  add(a, ell(x, y + 1 * s, 15 * s, 3 * s), '#4a1f0e', 0.3);
  [[-13.5, 0], [-4.5, 0], [4.5, 0], [-9, -5], [0, -5], [-4.5, -10]].forEach(([dx, dy]) => {
    add(a, rect(x + dx * s, y + (dy - 4) * s, 8.4 * s, 4.4 * s), '#b24e2e');
    add(a, rect(x + dx * s, y + (dy - 4) * s, 8.4 * s, 1.2 * s), '#e08256');
  });
}
export function peak(a, x, y, h) {
  const w = h * 0.85;
  add(a, poly([[x - w, y], [x, y - h], [x, y]]), '#b3bac7');
  add(a, poly([[x, y - h], [x + w, y], [x, y]]), '#717a8c');
  add(a, poly([[x, y - h], [x + 0.28 * w, y - 0.68 * h], [x + 0.1 * w, y - 0.72 * h], [x, y - 0.64 * h], [x - 0.12 * w, y - 0.74 * h], [x - 0.3 * w, y - 0.67 * h]]), '#f4f6fb');
}
export function cactus(a, x, y, s) {
  add(a, ell(x + 2 * s, y + 1 * s, 9 * s, 2.5 * s), '#6b5a2a', 0.3);
  add(a, rect(x - 3 * s, y - 20 * s, 6 * s, 20 * s) + ell(x, y - 20 * s, 3 * s, 3 * s), '#5d8f43');
  add(a, rect(x - 10 * s, y - 12 * s, 7 * s, 3 * s) + rect(x - 10 * s, y - 18 * s, 3 * s, 8 * s) + ell(x - 8.5 * s, y - 18 * s, 1.5 * s, 1.5 * s), '#5d8f43');
  add(a, rect(x + 3 * s, y - 9 * s, 7 * s, 3 * s) + rect(x + 7 * s, y - 15 * s, 3 * s, 8 * s) + ell(x + 8.5 * s, y - 15 * s, 1.5 * s, 1.5 * s), '#4a7a35');
  add(a, rect(x + 1 * s, y - 20 * s, 2 * s, 20 * s), '#40702f');
}
// 船（航海者版）。胴体を色分けし、帆は少し傾けて止まっているようすに見せる
export function ship(a, x, y, angleDeg, color) {
  const rad = (Math.PI / 180) * angleDeg;
  const dx = Math.cos(rad), dy = Math.sin(rad);
  const nx = -dy, ny = dx;
  const hull = [[-11, 3], [-7, 6], [7, 6], [11, 3], [8, -1], [-8, -1]].map(([fx, fy]) => [x + dx * fx + nx * fy, y + dy * fx + ny * fy]);
  add(a, poly(hull), '#4a3420', 1, '#1b1612', 1.2);
  add(a, line(x, y - 1, x, y - 13), 'none', 1, '#6b4a2b', 1.6);
  add(a, poly([[x, y - 12], [x + 7, y - 7], [x, y - 2]]), color, 0.92, '#1b1612', 1);
}
// 海賊（航海者版の盗賊役）。小舟に乗せた robber() をそのまま流用する
export function pirate(a, x, y, s) {
  add(a, ell(x + 2, y + 10 * s, 15 * s, 4 * s), '#000', 0.3);
  add(a, poly([[x - 14 * s, y + 8 * s], [x - 9 * s, y + 13 * s], [x + 9 * s, y + 13 * s], [x + 14 * s, y + 8 * s], [x + 10 * s, y + 2 * s], [x - 10 * s, y + 2 * s]]), '#2b1d10', 1, '#120c06', 1.2);
  robber(a, x, y - 2 * s, s * 0.85);
}
export function robber(a, x, y, s) {
  add(a, ell(x + 2 * s, y + 2 * s, 13 * s, 4 * s), '#3b2f14', 0.35);
  add(a, ell(x, y, 10 * s, 3.2 * s), '#1c1b22');
  add(a, 'M' + f(x - 8 * s) + ',' + f(y) + ' Q' + f(x - 8 * s) + ',' + f(y - 14 * s) + ' ' + f(x - 4 * s) + ',' + f(y - 18 * s) + ' L' + f(x + 4 * s) + ',' + f(y - 18 * s) + ' Q' + f(x + 8 * s) + ',' + f(y - 14 * s) + ' ' + f(x + 8 * s) + ',' + f(y) + ' Z', '#2d2c36');
  add(a, ell(x, y - 23 * s, 6 * s, 6 * s), '#2d2c36');
  add(a, ell(x - 2.2 * s, y - 25 * s, 1.8 * s, 1.8 * s), '#77748a', 0.8);
  add(a, ell(x - 4 * s, y - 10 * s, 1.4 * s, 5 * s), '#4a4858', 0.6);
}
export function house(a, x, y, col, dark, light) {
  add(a, ell(x + 2, y + 6, 13, 3.5), '#000', 0.3);
  add(a, poly([[x - 11, y + 5], [x - 11, y - 5], [x, y - 15], [x + 11, y - 5], [x + 11, y + 5]]), col, 1, '#1b1612', 1.6);
  add(a, poly([[x - 11, y - 5], [x, y - 15], [x, y - 11], [x - 8, y - 4]]), light, 0.9);
  add(a, rect(x + 3, y - 3, 8, 8), dark, 0.55);
}
export function city(a, x, y, col, dark, light) {
  add(a, ell(x + 2, y + 8, 18, 4), '#000', 0.3);
  add(a, 'M' + (x - 16) + ',' + (y + 7) + ' V' + (y - 12) + ' L' + (x - 8) + ',' + (y - 20) + ' L' + x + ',' + (y - 12) + ' V' + (y - 5) + ' L' + (x + 8) + ',' + (y - 12) + ' L' + (x + 16) + ',' + (y - 5) + ' V' + (y + 7) + ' Z', col, 1, '#1b1612', 1.6);
  add(a, poly([[x - 16, y - 12], [x - 8, y - 20], [x - 8, y - 16], [x - 13, y - 11]]), light, 0.9);
  add(a, rect(x - 11, y - 8, 5, 6), '#fff2c2', 0.9);
  add(a, rect(x + 4, y - 1, 12, 8), dark, 0.5);
}

// engine.js の terrain 名 → タイルの縁の色・グラデーションの種類（id は svg ごとに prefix を付けて作る）
export const TERRAIN_STYLE = {
  forest: { edge: '#1d4a27', grad: 'forest' },
  pasture: { edge: '#5c8a3a', grad: 'pasture' },
  field: { edge: '#a47d24', grad: 'field' },
  hills: { edge: '#86401f', grad: 'hill' },
  mountains: { edge: '#596070', grad: 'mountain' },
  desert: { edge: '#b39c62', grad: 'desert' },
  water: { edge: '#0e5265', grad: 'water' },
  gold: { edge: '#c79a2c', grad: 'gold' },
  lake: { edge: '#0e5265', grad: 'water' }, // 漁師: 砂漠の代わりの湖（水のグラデーションを流用）
  castle: { edge: '#596070', grad: 'mountain' }, // 蛮族の襲撃: 砦（山のグラデーションを流用）
  pitch: { edge: '#1d6b2c', grad: 'pasture' }, // サッカー熱: サッカー場（牧草のグラデーションを流用）
  fog: { edge: '#5a6a63', grad: 'fog' }, // 探検家と海賊: 船で見つけるまで地形を伏せる霧のマス
};

// タイルの上に乗る地形ごとの絵（中心 x,y。R=66 の六角形を前提にした配置）
export function terrainDecor(a, terrain, x, y) {
  if (terrain === 'forest') {
    [[-30, -20], [0, -34], [30, -20], [-44, 6], [44, 8], [-28, 36], [28, 36], [-6, 50]]
      .sort((p, q) => p[1] - q[1])
      .forEach(([dx, dy], i) => { const n = a.length; tree(a, x + dx, y + dy, 0.9); tag(a, n, 'a-sway', x + dx, y + dy, -(x + i * 0.7)); });
  } else if (terrain === 'pasture') {
    add(a, ell(x - 18, y + 30, 34, 12), '#d3ef9c', 0.55);
    add(a, ell(x + 22, y - 30, 30, 10), '#d3ef9c', 0.55);
    [[-40, -2], [36, -6], [-10, -44], [14, 46], [42, 24]].forEach(([dx, dy], i) => add(a, ell(x + dx, y + dy, 1.8, 1.8), i % 2 ? '#fff6c8' : '#ffffff', 0.9));
    [[-28, -14, 0.9], [26, -26, 0.8], [28, 34, 0.9], [-26, 38, 0.8]].forEach(([dx, dy, k], i) => {
      const n = a.length; sheep(a, x + dx, y + dy, k); tag(a, n, 'a-walk', x + dx, y + dy, -(y + i * 4.3));
    });
  } else if (terrain === 'field') {
    for (let yy = -46; yy <= 50; yy += 12) {
      const m = Math.abs(yy);
      const hw = m <= 28 ? 46 : 46 * (56 - m) / 28;
      if (hw > 6) add(a, line(x - hw + 4, y + yy, x + hw - 4, y + yy - 6), 'none', 0.55, '#c9962f', 3);
    }
    [[-32, -4, 0.95], [34, -2, 0.95], [0, -34, 0.9]].forEach(([dx, dy, k], i) => {
      const n = a.length; sheaf(a, x + dx, y + dy, k); tag(a, n, 'a-sway', x + dx, y + dy, -(x + i * 0.9));
    });
  } else if (terrain === 'hills') {
    add(a, ell(x - 20, y + 26, 30, 13), '#b9603a');
    add(a, ell(x - 24, y + 22, 18, 6), '#d98a5c', 0.6);
    add(a, ell(x + 24, y - 20, 26, 11), '#c26a41');
    add(a, ell(x + 20, y - 23, 14, 5), '#e39a6c', 0.6);
    bricks(a, x - 30, y - 10, 0.9); bricks(a, x + 32, y + 28, 0.9); bricks(a, x, y - 36, 0.8);
  } else if (terrain === 'mountains') {
    // 六角形（R=66）の辺からはみ出さない大きさ・位置
    peak(a, x - 25, y + 4, 34); peak(a, x + 24, y + 6, 36); peak(a, x, y - 16, 44);
    peak(a, x - 12, y + 44, 20); peak(a, x + 14, y + 46, 18);
    const n = a.length; // 山にかかる雲
    add(a, ell(x - 10, y - 30, 14, 5) + ell(x, y - 34, 10, 6) + ell(x + 9, y - 30, 11, 4.5), '#ffffff', 0.75);
    tag(a, n, 'a-cloud', x, y, -(x + y) / 7);
  } else if (terrain === 'desert') {
    const n = a.length; // 砂の照り返し（かげろう）
    add(a, 'M' + (x - 50) + ',' + (y + 10) + ' q25,-18 50,-4 t48,2', 'none', 0.8, '#fbf0cf', 5);
    add(a, 'M' + (x - 44) + ',' + (y + 34) + ' q22,-14 44,-2 t40,0', 'none', 0.6, '#c7ad72', 4);
    tag(a, n, 'a-haze', x, y, 0);
    cactus(a, x - 32, y - 12, 0.95); cactus(a, x + 36, y + 26, 0.8);
  } else if (terrain === 'water') {
    const n = a.length; // 波紋だけの何もないマス
    add(a, 'M' + (x - 36) + ',' + (y - 6) + ' q18,-10 36,0 t34,0', 'none', 0.3, '#bfe6ee', 2);
    add(a, 'M' + (x - 30) + ',' + (y + 22) + ' q15,-9 30,0 t28,0', 'none', 0.22, '#bfe6ee', 2);
    tag(a, n, 'a-wave', x, y, 0);
  } else if (terrain === 'pitch') {
    add(a, 'M' + (x - 54) + ',' + y + ' L' + (x + 54) + ',' + y, 'none', 0.8, '#eafbe0', 3);
    add(a, ell(x, y, 16, 16), 'none', 0.8, '#eafbe0', 3);
    add(a, ell(x, y, 2.4, 2.4), '#eafbe0', 0.9);
    [[-30, 0], [30, 0]].forEach(([dx]) => add(a, rect(x + dx - 1.5, y - 10, 3, 20), '#eafbe0', 0.6));
    add(a, ell(x - 2, y + 2, 7, 7), '#fdfdfd', 1, '#2a211b', 1.4);
    [[0, -3], [-3, 2], [3, 2]].forEach(([dx, dy]) => add(a, ell(x - 2 + dx, y + 2 + dy, 1.8, 1.8), '#2a211b', 0.85));
  } else if (terrain === 'gold') {
    [[-20, -14], [18, -22], [26, 18], [-24, 22], [0, 2]].forEach(([dx, dy], i) => {
      const n = a.length;
      add(a, ell(x + dx, y + dy, 7, 7), '#f6cf4a', 1, '#8a6a1e', 1.2);
      add(a, ell(x + dx - 1.5, y + dy - 1.5, 2.4, 2.4), '#fff0b0', 0.8);
      tag(a, n, 'a-sway', x + dx, y + dy, -(x + i * 0.8));
    });
  } else if (terrain === 'fog') {
    const n = a.length; // 地形を伏せた霧（船で近づくまで中身が分からない）
    add(a, ell(x - 18, y - 8, 26, 13) + ell(x + 14, y - 14, 20, 11) + ell(x, y + 14, 30, 14), '#eef3f0', 0.6);
    tag(a, n, 'a-cloud', x, y, 0);
  }
}

// 丸太を3本積む（下2本・上1本）。切り口は左下の手前、胴は右上の奥へのびる。
// 胴を全部描いてから切り口を描くので、重なっても切り口が隠れない
function logPile(a) {
  const r = 6, ox = 9, oy = -6; // 半径と、手前の切り口から奥の端までのずれ
  const ends = [[12, 21], [8, 32], [21, 32]];
  const px = 0.55 * r, py = 0.83 * r; // 胴のふち（のびる向きに直交）
  ends.forEach(([x, y]) => {
    const bx = x + ox, by = y + oy;
    add(a, ell(bx, by, 0.8 * r, r), '#6b4424', 1, '#4a2e17', 1.2);
    add(a, poly([[x - px, y - py], [bx - px, by - py], [bx + px, by + py], [x + px, y + py]]), '#8a5a32');
    add(a, line(x - px, y - py, bx - px, by - py), 'none', 1, '#4a2e17', 1.2);
    add(a, line(x + px, y + py, bx + px, by + py), 'none', 1, '#4a2e17', 1.2);
    add(a, line(x - 0.2 * r, y - 0.45 * r, bx - 0.2 * r, by - 0.45 * r), 'none', 1, '#b07a44', 1.4);
  });
  ends.forEach(([x, y]) => {
    add(a, ell(x, y, 0.8 * r, r), '#e8c48a', 1, '#4a2e17', 1.2);
    add(a, ell(x, y, 0.42 * r, 0.52 * r), 'none', 1, '#b9834a', 0.9);
  });
}
// 岩のかたまり（左が明るく右が暗いごつごつした形）。x,y は底の中心
function rock(a, x, y, s) {
  const p = (pts) => poly(pts.map(([dx, dy]) => [x + dx * s, y + dy * s]));
  add(a, p([[-14, 0], [-15, -9], [-9, -19], [1, -23], [9, -17], [14, -8], [13, 0]]), '#717a8c');
  add(a, p([[-14, 0], [-15, -9], [-9, -19], [1, -23], [-1, -12], [-5, 0]]), '#a3abba');
  add(a, p([[-9, -19], [1, -23], [-1, -12], [-6, -14]]), '#c9cfda');
}

// 手札・コスト表示などの小さなアイコン（40x40 の中）
export function resourceIcon(a, kind) {
  if (kind === 'wood') { add(a, ell(21, 37, 16, 2.2), '#3a2410', 0.3); logPile(a); }
  if (kind === 'brick') bricks(a, 20, 32, 1.2);
  if (kind === 'sheep') sheep(a, 18, 30, 1.3);
  if (kind === 'wheat') sheaf(a, 20, 36, 1.3);
  if (kind === 'ore') { add(a, ell(20, 34, 16, 2.5), '#1e222b', 0.3); rock(a, 17, 34, 0.95); rock(a, 30, 34, 0.42); }
  // 都市と騎士の商品（紙・布・硬貨）: 細かな絵でなく、色付きの札・円で見分けられればよい簡略アイコン
  if (kind === 'paper') { add(a, rect(8, 10, 24, 22), '#eee6c8', 1, '#8a7a4a', 1.5); add(a, line(12, 17, 28, 17), 'none', 0.6, '#8a7a4a', 1.5); add(a, line(12, 23, 28, 23), 'none', 0.6, '#8a7a4a', 1.5); }
  if (kind === 'cloth') { add(a, poly([[20, 6], [34, 14], [28, 34], [12, 34], [6, 14]]), '#d66a9a', 1, '#8a3a60', 1.5); }
  if (kind === 'coin') { add(a, ell(20, 20, 13, 13), '#f0c84a', 1, '#8a6a1e', 2); add(a, ell(20, 20, 7, 7), 'none', 1, '#8a6a1e', 1.2); }
}

// SVG の <defs> に入れるグラデーション（地形のタイル・数字チップに使う）。
// id は同じ HTML に何枚も盤がある（タイトルの飾り・実際の盤）ので、svg ごとに違う prefix を付けて作る。
// 付けないと、隠れている（display:none の）盤の <defs> と id がぶつかり、
// 見えているはずの盤のグラデーションが（隠れている方が優先されて）効かなくなることがある。
export function defsMarkup(prefix) {
  const g = (name) => `${prefix}-g-${name}`;
  return `
<linearGradient id="${g('forest')}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#56a35f"/><stop offset="1" stop-color="#2a6837"/></linearGradient>
<linearGradient id="${g('pasture')}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c2e58a"/><stop offset="1" stop-color="#7fb454"/></linearGradient>
<linearGradient id="${g('field')}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f6d872"/><stop offset="1" stop-color="#d3a43a"/></linearGradient>
<linearGradient id="${g('hill')}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e4935f"/><stop offset="1" stop-color="#ae5631"/></linearGradient>
<linearGradient id="${g('mountain')}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#bcc2ce"/><stop offset="1" stop-color="#767e90"/></linearGradient>
<linearGradient id="${g('desert')}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f4e6bb"/><stop offset="1" stop-color="#d5bc80"/></linearGradient>
<linearGradient id="${g('water')}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2a8aa0"/><stop offset="1" stop-color="#114f62"/></linearGradient>
<linearGradient id="${g('gold')}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f6df8a"/><stop offset="1" stop-color="#cf9f2e"/></linearGradient>
<linearGradient id="${g('fog')}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9fb3ac"/><stop offset="1" stop-color="#5a6a63"/></linearGradient>
<radialGradient id="${g('token')}" cx="0.4" cy="0.35" r="0.75"><stop offset="0" stop-color="#fffcf4"/><stop offset="1" stop-color="#e6d8b8"/></radialGradient>
`;
}
