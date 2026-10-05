'use strict';
// カタン基本セットのルール・盤面・得点計算（画面・音・localStorage に触らない）。
// ブラウザ（main.js が import）からのみ使う。状態は 1 つのオブジェクト game に持たせ、
// 操作はすべて game を直接書き換える関数として export する（イミュータブルにはしない。1 台で交代するだけの試作のため）。
// 音を鳴らすべきこと（サイコロ・建設・盗みなど）は game.events に積む。鳴らすかどうかは main.js が決める。

export const RESOURCES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
export const RESOURCE_LABEL = { wood: '木材', brick: '土', sheep: '羊', wheat: '麦', ore: '鉄' };
export const TERRAIN_LABEL = {
  forest: '森', hills: '丘', pasture: '牧草', field: '畑', mountains: '山', desert: '砂漠', water: '海', gold: '金の川',
  lake: '湖', castle: '砦', // 交易と略奪: 漁師の湖、蛮族の襲撃の砦（どちらも産出しない）
  pitch: 'サッカー場', // サッカー熱（産出しない）
};
const TERRAIN_RESOURCE = { forest: 'wood', hills: 'brick', pasture: 'sheep', field: 'wheat', mountains: 'ore', desert: null, water: null, gold: null, lake: null, castle: null, pitch: null };
const TERRAIN_COUNTS = { forest: 4, hills: 3, pasture: 4, field: 4, mountains: 3, desert: 1 };
const NUMBER_TOKENS = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];
const PORT_TYPES = ['3:1', '3:1', '3:1', '3:1', 'wood', 'brick', 'sheep', 'wheat', 'ore'];
const BANK_START = 19; // 資源1種あたりの銀行の枚数

// ---- 5〜6人拡張（公式ルール） ----
// 盤30マス（3-4-5-6-5-4-3列）・数字チップ28枚・港11か所・銀行24枚・発展カード34枚。
// 他の拡張（航海者版など）を後で足すときも、同じ createGame の options.expansions に名前を足していく形にする。
const TERRAIN_COUNTS_56 = { forest: 6, hills: 5, pasture: 6, field: 6, mountains: 5, desert: 2 };
const NUMBER_TOKENS_56 = [2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, 8, 8, 8, 9, 9, 9, 10, 10, 10, 11, 11, 11, 12, 12];
const PORT_TYPES_56 = ['3:1', '3:1', '3:1', '3:1', '3:1', 'wood', 'brick', 'sheep', 'wheat', 'ore', 'sheep'];
const BANK_START_56 = 24;
const DEV_COUNTS_56 = { knight: 20, vp: 5, roadBuilding: 3, yearOfPlenty: 3, monopoly: 3 };
const MAX_ROADS = 15, MAX_SETTLEMENTS = 5, MAX_CITIES = 4, MAX_SHIPS = 15;

// ---- 航海者版（公式ルールの「新しい島へ」シナリオを簡略化） ----
// 本島は3〜4人用と同じ19マス。周りを海で1周し、海の向こうに2マスずつの小島を3つ置く。
// 金の川（gold）マスは、出目が合えば持ち主が好きな資源を1枚ずつ選べる（通常の資源は出さない）。
// 5〜6人は、本島を5〜6人拡張と同じ30マスにする（公式の「航海者 5〜6人用拡張」の簡略版）。
const SEAFARERS_TERRAIN_COUNTS = { forest: 3, hills: 3, pasture: 4, field: 4, mountains: 3, desert: 1, gold: 1 }; // 19マス
const SEAFARERS_TERRAIN_COUNTS_56 = { forest: 6, hills: 5, pasture: 6, field: 6, mountains: 5, desert: 1, gold: 1 }; // 30マス
const SEAFARERS_NUMBER_TOKENS_56 = [2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 8, 8, 8, 9, 9, 9, 10, 10, 10, 11, 11, 11, 12, 12]; // 砂漠1つぶん29マス
const SEAFARERS_ISLAND_TERRAIN = ['pasture', 'field', 'hills', 'mountains', 'forest', 'field']; // 小島3つ×2マス
const SEAFARERS_NUMBER_EXTRA = [3, 4, 5, 9, 10, 11]; // 小島6マスぶんの数字チップ（本島分に足す）
const SEAFARERS_ISLANDS = [
  [{ q: 5, r: -2 }, { q: 5, r: -3 }],
  [{ q: -3, r: 5 }, { q: -4, r: 5 }],
  [{ q: -2, r: -3 }, { q: -3, r: -2 }],
];

export const COSTS = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  city: { wheat: 2, ore: 3 },
  dev: { sheep: 1, wheat: 1, ore: 1 },
  ship: { wood: 1, sheep: 1 },
};
const DEV_COUNTS = { knight: 14, vp: 5, roadBuilding: 2, yearOfPlenty: 2, monopoly: 2 };
export const DEV_LABEL = { knight: '騎士', vp: '勝利点', roadBuilding: '街道建設', yearOfPlenty: '収穫', monopoly: '独占' };

// ---- 都市と騎士（公式ルールの簡略版。省いた点は README） ----
export const COMMODITIES = ['paper', 'cloth', 'coin'];
export const COMMODITY_LABEL = { paper: '紙', cloth: '布', coin: '硬貨' };
const COMMODITY_OF_TERRAIN = { forest: 'paper', pasture: 'cloth', mountains: 'coin' }; // 畑(麦)・丘(土)の都市は商品を産まず資源2
export const TRACKS = ['trade', 'politics', 'science'];
export const TRACK_LABEL = { trade: '交易', politics: '政治', science: '科学' };
export const TRACK_COMMODITY = { trade: 'cloth', politics: 'coin', science: 'paper' };
const CK_BANK_COMMODITY_START = 10; // 商品の銀行の枚数（公式の正確な枚数は資料によって差があるため、資源と対称な数で簡略化。README に注記）
const CK_BANK_COMMODITY_START_56 = 13; // 5〜6人用拡張（資源の銀行が19→24になるのと同じ比率で増やす）
export const KNIGHT_COST = { sheep: 1, ore: 1 }; // 建てる・昇格するコスト（共通）
export const KNIGHT_ACTIVATE_COST = { wheat: 1 };
export const WALL_COST = { brick: 2 };
export const MAX_KNIGHTS_PER_LEVEL = 2; // 公式ルール: 弱い・強い・最強、各段階2体まで（合計で最大6体）
const MAX_WALLS = 3;
const MAX_CITY_LEVEL = 5;
export const KNIGHT_LEVEL_LABEL = { 1: '弱い騎士', 2: '強い騎士', 3: '最強の騎士' };

export const PROGRESS_CARDS = {
  trade: ['tr_resource1', 'tr_resource2', 'tr_commodity1', 'tr_trade21', 'tr_trade21x2', 'tr_stealres', 'tr_roadfree', 'tr_vp', 'tr_cardsteal', 'tr_bankgift'],
  politics: ['po_knightfree', 'po_activateall', 'po_upgradefree', 'po_vp', 'po_deserter', 'po_intrigue', 'po_cardsteal', 'po_commodity1', 'po_wallfree', 'po_resource1'],
  science: ['sc_commodity1', 'sc_vp', 'sc_roadfree2', 'sc_inventor', 'sc_irrigation', 'sc_mining', 'sc_research', 'sc_resource1', 'sc_cardsteal', 'sc_resource2'],
};
export const PROGRESS_LABEL = {
  tr_resource1: '商人の目利き（資源を1つ）', tr_resource2: '隊商（資源を2つ）', tr_commodity1: '職人の技（商品を1つ）',
  tr_trade21: '有利な交易（2:1を1回）', tr_trade21x2: '市場の活況（2:1を2回）', tr_stealres: '徴税（全員から指定の資源）',
  tr_roadfree: '街道整備（道を1本只で）', tr_vp: '商業の達人（勝利点+1）', tr_cardsteal: '密輸（相手の進歩カードを奪う）', tr_bankgift: '大市（資源を1種類ずつ）',
  po_knightfree: '徴兵（弱い騎士を1体只で）', po_activateall: '総動員（騎士を全員起動）', po_upgradefree: '叙任（騎士を1体昇格）',
  po_vp: '政治の達人（勝利点+1）', po_deserter: '脱走の扇動（相手の騎士を1段階弱める）', po_intrigue: '陰謀（隣の相手の騎士を除く）',
  po_cardsteal: '諜報（相手の進歩カードを奪う）', po_commodity1: '献上（商品を1つ）', po_wallfree: '築城（都市壁を1つ只で）', po_resource1: '施し（資源を1つ）',
  sc_commodity1: '発明の対価（商品を1つ）', sc_vp: '科学の達人（勝利点+1）', sc_roadfree2: '道路網（道を2本只で）', sc_inventor: '発明家（数字チップを入れ替え）',
  sc_irrigation: '灌漑（畑に接する分だけ麦）', sc_mining: '採掘（山に接する分だけ鉄）', sc_research: '研究（科学の山からもう1枚只で）', sc_resource1: '実験（資源を1つ）',
  sc_cardsteal: '模倣（相手の進歩カードを奪う）', sc_resource2: '豊作（資源を2つ）',
};
const PROGRESS_COPIES = 2; // 各カード2枚ずつ（公式の54枚そのままの構成ではない簡略版。README に注記）
const PROGRESS_COPIES_56 = 3; // 5〜6人用拡張は公式どおり枚数を増やす（簡略版なので比率は厳密ではない）
const PROGRESS_VP_CARDS = new Set(['tr_vp', 'po_vp', 'sc_vp']); // 使うとすぐ公開される勝利点カード
const PROGRESS_HAND_LIMIT = 4;
const EVENT_FACES = ['barbarian', 'barbarian', 'barbarian', 'trade', 'politics', 'science']; // 事件のサイコロ（3つめ）
const BARBARIAN_ATTACK_AT = 7;

// ---- 交易と略奪（公式ルールブック Traders & Barbarians に沿わせた簡略版。3〜4人・基本盤だけに対応） ----
// ---- サッカー熱（公式シナリオ Fußballfieber を簡略化。3〜4人・基本盤だけ） ----
// 専用の盤・物理の試合台紙は使わず、2つのサッカー場マスと進み方を計算で置き換える（README に注記）。
export const SOCCER_TRACK_LENGTH = 18; // フットボールレーン（簡略化。公式は専用のボード）の長さ
export const SOCCER_CUP_POS = 18; // ここに届く（または越える）とシーズンが即終わる「ポカール」
export const SOCCER_BONUS = { 3: 'resource', 6: 'devcard', 9: 'resource', 12: 'devcard', 15: 'resource' }; // 通過でもらえるボーナス
const SOCCER_MAX_SHOTS = 6; // 1人6枚の持ち駒（攻撃回数）が上限
const SOCCER_DAYS = { 3: 12, 4: 15 }; // 公式どおりの試合日数

export const TB_SCENARIOS = ['fishermen', 'rivers', 'caravans', 'barbarians'];
export const TB_SCENARIO_LABEL = { fishermen: '漁師', rivers: '川', caravans: '隊商', barbarians: '蛮族の襲撃' };
const TB_WIN_TARGET = { fishermen: 10, rivers: 10, caravans: 12, barbarians: 12 }; // 公式どおり（漁師は古い靴を持つ人だけ+1点で11点）

// 漁師: 漁場6か所（出目4,5,6,8,9,10）と、砂漠の代わりの湖（出目2,3,11,12のどれでも反応）。
// 魚トークンは1匹11枚・2匹10枚・3匹8枚（計29枚）に古い靴1枚を混ぜ、産出のたびに引く（公式どおり）。
const FISH_GROUND_NUMBERS = [4, 5, 6, 8, 9, 10];
// 5〜6人拡張は近似（公式の正確な数は不明。銀行の資源が19→24になる比率=約1.3倍で増やした）。README に注記
const FISH_GROUND_NUMBERS_56 = [4, 5, 5, 6, 6, 8, 8, 9, 10];
const LAKE_NUMBERS = [2, 3, 11, 12];
const FISH_TOKEN_COUNTS = { 1: 11, 2: 10, 3: 8 };
const FISH_TOKEN_COUNTS_56 = { 1: 14, 2: 13, 3: 10 }; // 同じく近似（約1.3倍）
const FISH_HAND_LIMIT = 7; // 一度に7匹まで（公式どおり。超える分は、一番少ない手持ちと交換するだけ）
export const FISH_TRADE_COST = { robberAway: 2, steal: 3, resource: 4, road: 5, devcard: 7 };

// 川: 道・開拓地を川沿いに建てるたびに金貨1枚（都市への建て替えでは増えない）。橋は土2木1で、建てると金貨3枚。
export const BRIDGE_COST = { brick: 2, wood: 1 };
const BRIDGE_GOLD = 3;
export const MAX_BRIDGES = 3;
const GOLD_SPENDS_PER_TURN = 2; // 金貨2枚で資源1枚の交換は、手番に2回まで

// 隊商: オアシス（砂漠の代わり）から3本のキャラバンが伸びる。羊・麦を出し合う投票でラクダの行き先を決める。
const CARAVAN_COUNT = 3;

export const PLAYER_COLORS = ['#e0553f', '#3f7ee0', '#f0c43c', '#46a86a', '#8a5cc9', '#2bb0b0'];

const HEX_DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]]; // 隣の軸座標の差

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function round3(n) { return Math.round(n * 1000) / 1000; }
function emptyResources() { return { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 }; }
function emptyCommodities() { return { paper: 0, cloth: 0, coin: 0 }; }
function sumCommodities(o) { return o ? COMMODITIES.reduce((a, k) => a + (o[k] || 0), 0) : 0; }
function buildProgressDeck(rng, color, ext) { return shuffle(PROGRESS_CARDS[color].flatMap((id) => Array(ext ? PROGRESS_COPIES_56 : PROGRESS_COPIES).fill(id)), rng); }
function sumRes(o) { return RESOURCES.reduce((a, k) => a + (o[k] || 0), 0); }
function canAfford(res, cost) { return Object.entries(cost).every(([k, v]) => (res[k] || 0) >= v); }
function payCost(res, cost) { Object.entries(cost).forEach(([k, v]) => { res[k] -= v; }); }

// ================================================================
// 盤面の生成: 軸座標の六角形（半径2 = 19枚）。頂点・辺は六角形の角の座標を
// 丸めてキーにし、隣り合うタイルで同じ頂点・辺を共有させる（重複させない）。
// ================================================================
function hexCorner(cx, cy, i) {
  const deg = 60 * i - 30; // pointy-top（頂点が上下にくる向き）
  const rad = (Math.PI / 180) * deg;
  return [round3(cx + Math.cos(rad)), round3(cy + Math.sin(rad))];
}
function hexCenter(q, r) { return [round3(Math.sqrt(3) * (q + r / 2)), round3(1.5 * r)]; }

function buildGeometry(hexes) {
  const vKeyToId = new Map();
  const vertices = [];
  const eKeyToId = new Map();
  const edges = [];
  function vertexAt(cx, cy, i) {
    const [x, y] = hexCorner(cx, cy, i);
    const key = `${x},${y}`;
    let id = vKeyToId.get(key);
    if (id == null) {
      id = vertices.length;
      vKeyToId.set(key, id);
      vertices.push({ id, x, y, hexIds: [], edgeIds: [], neighbors: [], port: null, building: null });
    }
    return id;
  }
  function edgeBetween(va, vb, hexId) {
    const key = va < vb ? `${va}-${vb}` : `${vb}-${va}`;
    let id = eKeyToId.get(key);
    if (id == null) {
      id = edges.length;
      eKeyToId.set(key, id);
      edges.push({ id, v1: va, v2: vb, hexIds: [], road: null, ship: null, shipPlacedTurn: null });
      vertices[va].edgeIds.push(id);
      vertices[vb].edgeIds.push(id);
      vertices[va].neighbors.push(vb);
      vertices[vb].neighbors.push(va);
    }
    edges[id].hexIds.push(hexId);
    return id;
  }
  hexes.forEach((hex) => {
    const [cx, cy] = hexCenter(hex.q, hex.r);
    const corners = [0, 1, 2, 3, 4, 5].map((i) => vertexAt(cx, cy, i));
    corners.forEach((va, i) => {
      const vb = corners[(i + 1) % 6];
      const eId = edgeBetween(va, vb, hex.id);
      hex.edgeIds.push(eId);
    });
    corners.forEach((vid) => { if (!vertices[vid].hexIds.includes(hex.id)) vertices[vid].hexIds.push(hex.id); });
    hex.vertexIds = corners;
  });
  return { vertices, edges };
}

// 外周の辺を、頂点でつながる順に並べる（港をだいたい等間隔に置くため）
function orderedBoundary(edges) {
  const boundary = edges.filter((e) => e.hexIds.length === 1);
  const byVertex = new Map();
  boundary.forEach((e) => {
    [e.v1, e.v2].forEach((v) => { if (!byVertex.has(v)) byVertex.set(v, []); byVertex.get(v).push(e.id); });
  });
  const order = [];
  const seen = new Set();
  let cur = boundary[0];
  let fromVertex = cur.v1;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    order.push(cur.id);
    const nextVertex = cur.v1 === fromVertex ? cur.v2 : cur.v1;
    const candidates = byVertex.get(nextVertex).filter((id) => id !== cur.id);
    const nextId = candidates[0];
    cur = boundary.find((e) => e.id === nextId);
    fromVertex = nextVertex;
  }
  return order;
}

// 3〜4人は半径2の六角形（19マス）。5〜6人拡張は3-4-5-6-5-4-3列の縦長の盤（30マス）。
function boardCoords(ext) {
  const coords = [];
  if (!ext) {
    for (let q = -2; q <= 2; q++) for (let r = -2; r <= 2; r++) if (q + r >= -2 && q + r <= 2) coords.push({ q, r });
    return coords;
  }
  for (let r = -3; r <= 3; r++) {
    const n = 6 - Math.abs(r);
    const qStart = r <= 0 ? -3 - r : -3; // 各列を左右対称に並べる
    for (let i = 0; i < n; i++) coords.push({ q: qStart + i, r });
  }
  return coords;
}

function buildBoard(rng, ext) {
  const coords = boardCoords(ext);
  const terrainCounts = ext ? TERRAIN_COUNTS_56 : TERRAIN_COUNTS;
  const numberTokens = ext ? NUMBER_TOKENS_56 : NUMBER_TOKENS;
  const portSet = ext ? PORT_TYPES_56 : PORT_TYPES;
  const terrainPool = shuffle(Object.entries(terrainCounts).flatMap(([t, n]) => Array(n).fill(t)), rng);
  const hexes = coords.map((c, i) => ({
    id: i, q: c.q, r: c.r, terrain: terrainPool[i], number: null, edgeIds: [], vertexIds: [],
  }));
  const byCoord = new Map(hexes.map((h) => [`${h.q},${h.r}`, h]));
  const neighborsOf = (h) => HEX_DIRS.map(([dq, dr]) => byCoord.get(`${h.q + dq},${h.r + dr}`)).filter(Boolean);

  const nonDesert = hexes.filter((h) => h.terrain !== 'desert');
  let attempt = 0;
  for (;;) {
    const nums = shuffle(numberTokens, rng);
    nonDesert.forEach((h, i) => { h.number = nums[i]; });
    const bad = nonDesert.some((h) => (h.number === 6 || h.number === 8)
      && neighborsOf(h).some((n) => n.number === 6 || n.number === 8));
    if (!bad || ++attempt > 500) break; // 500回試してもだめならそのまま受け入れる（実際はまず起きない）
  }
  const desert = hexes.find((h) => h.terrain === 'desert');

  const { vertices, edges } = buildGeometry(hexes);
  const boundary = orderedBoundary(edges);
  const portTypes = shuffle(portSet, rng);
  const portEdgeIds = [];
  portTypes.forEach((type, i) => {
    const edgeId = boundary[Math.round((i * boundary.length) / portTypes.length)];
    const edge = edges[edgeId];
    vertices[edge.v1].port = type;
    vertices[edge.v2].port = type;
    portEdgeIds.push(edgeId);
  });
  return { hexes, vertices, edges, robberHex: desert.id, portEdgeIds };
}

// 蛮族の襲撃は騎士を発展カードでなく直接建てるので（README に注記）、発展カードには騎士を入れない
const DEV_COUNTS_BARBARIANS = { vp: 5, roadBuilding: 3, yearOfPlenty: 3, monopoly: 3 };
function buildDevDeck(rng, ext, scenario) {
  const counts = ext ? DEV_COUNTS_56 : (scenario === 'barbarians' ? DEV_COUNTS_BARBARIANS : DEV_COUNTS);
  return shuffle(Object.entries(counts).flatMap(([t, n]) => Array(n).fill(t)), rng);
}

// 辺が陸（道を置ける）か、海（船を置ける）かの判定。
// 陸=隣り合うマスのどれかが水以外。海=隣り合うマスのどれかが水、またはその方角にマスがない（盤の外＝外海）。
function edgeTouchesLand(edge, hexes) { return edge.hexIds.some((id) => hexes[id].terrain !== 'water'); }
function edgeTouchesSea(edge, hexes) { return edge.hexIds.length < 2 || edge.hexIds.some((id) => hexes[id].terrain === 'water'); }

// 陸マスのまわり1周ぶんの海（陸に隣り合い、まだ陸でない軸座標）。本島がどんな形でも、ちょうど1周分の海で囲める。
function adjacentWaterCoords(landCoords) {
  const landSet = new Set(landCoords.map((c) => `${c.q},${c.r}`));
  const ring = new Map();
  landCoords.forEach((c) => {
    HEX_DIRS.forEach(([dq, dr]) => {
      const q = c.q + dq, r = c.r + dr, key = `${q},${r}`;
      if (!landSet.has(key) && !ring.has(key)) ring.set(key, { q, r });
    });
  });
  return [...ring.values()];
}

// 小島(隣り合う2マスで1つ)が本島の海(岸)に1マスも隣り合っていなければ、間に浮かぶ1マスだけ海にして橋を架ける。
// 3〜4人の盤だと、SEAFARERS_ISLANDS の座標が本島の海からヘクス2つぶん離れていて、船で永遠に届かなかった
// （5〜6人の広い盤ではもともと3つのうち2つは隣り合っていたので、そこには何も足さない＝マス数は変わらない）。
function bridgeToShore(mainCoords, waterCoords, islandCoords) {
  const key = (c) => `${c.q},${c.r}`;
  const islandSet = new Set(islandCoords.map(key));
  const shore = mainCoords.concat(waterCoords);
  const touchesShore = (c) => HEX_DIRS.some(([dq, dr]) => shore.some((s) => s.q === c.q + dq && s.r === c.r + dr));
  const occupied = new Set(mainCoords.concat(waterCoords, islandCoords).map(key));
  const visited = new Set();
  const bridges = new Map();
  islandCoords.forEach((start) => {
    if (visited.has(key(start))) return;
    // 隣り合う島マスどうしは同じ小島として、代表の1マスにだけ橋を架ければ届く
    const group = [start];
    visited.add(key(start));
    for (let i = 0; i < group.length; i++) {
      HEX_DIRS.forEach(([dq, dr]) => {
        const nk = `${group[i].q + dq},${group[i].r + dr}`;
        if (islandSet.has(nk) && !visited.has(nk)) {
          visited.add(nk);
          group.push(islandCoords.find((c) => key(c) === nk));
        }
      });
    }
    if (group.some(touchesShore)) return; // どれか1マスでも海岸に隣り合っていれば橋は要らない
    for (const isl of group) {
      for (const [dq, dr] of HEX_DIRS) {
        const cand = { q: isl.q + dq, r: isl.r + dr };
        const ck = key(cand);
        if (occupied.has(ck) || bridges.has(ck)) continue;
        if (touchesShore(cand)) { bridges.set(ck, cand); return; }
      }
    }
  });
  return [...bridges.values()];
}

function buildSeafarersBoard(rng, ext) {
  const mainCoords = boardCoords(ext); // 3〜4人は本島19マス、5〜6人は5〜6人拡張と同じ30マス
  const islandCoords = SEAFARERS_ISLANDS.flat(); // 小島3つ×2マス（本島から離れた外海に浮かぶ）
  const shoreWater = adjacentWaterCoords(mainCoords); // 本島を1周する海
  const waterCoords = shoreWater.concat(bridgeToShore(mainCoords, shoreWater, islandCoords));
  let nextId = 0;
  const hexes = [];
  const terrainCounts = ext ? SEAFARERS_TERRAIN_COUNTS_56 : SEAFARERS_TERRAIN_COUNTS;
  const landPool = shuffle(Object.entries(terrainCounts).flatMap(([t, n]) => Array(n).fill(t)), rng);
  mainCoords.forEach((c, i) => hexes.push({ id: nextId++, q: c.q, r: c.r, terrain: landPool[i], number: null, edgeIds: [], vertexIds: [] }));
  waterCoords.forEach((c) => hexes.push({ id: nextId++, q: c.q, r: c.r, terrain: 'water', number: null, edgeIds: [], vertexIds: [] }));
  const islandPool = shuffle(SEAFARERS_ISLAND_TERRAIN, rng);
  const islandHexIds = [];
  islandCoords.forEach((c, i) => { const id = nextId++; hexes.push({ id, q: c.q, r: c.r, terrain: islandPool[i], number: null, edgeIds: [], vertexIds: [] }); islandHexIds.push(id); });

  const byCoord = new Map(hexes.map((h) => [`${h.q},${h.r}`, h]));
  const neighborsOf = (h) => HEX_DIRS.map(([dq, dr]) => byCoord.get(`${h.q + dq},${h.r + dr}`)).filter(Boolean);
  const nonDesert = hexes.filter((h) => h.terrain !== 'desert' && h.terrain !== 'water');
  const numberPool = (ext ? SEAFARERS_NUMBER_TOKENS_56 : NUMBER_TOKENS).concat(SEAFARERS_NUMBER_EXTRA); // 本島ぶん + 小島6
  let attempt = 0;
  for (;;) {
    const nums = shuffle(numberPool, rng);
    nonDesert.forEach((h, i) => { h.number = nums[i]; });
    const bad = nonDesert.some((h) => (h.number === 6 || h.number === 8)
      && neighborsOf(h).some((n) => n.number === 6 || n.number === 8));
    if (!bad || ++attempt > 500) break;
  }
  const desert = hexes.find((h) => h.terrain === 'desert');

  const { vertices, edges } = buildGeometry(hexes);

  // 港: 陸と海の両方に接する辺（本島の海ぎわ・小島のまわり）から、頂点が重ならないように選ぶ
  const candidates = shuffle(edges.filter((e) => edgeTouchesLand(e, hexes) && edgeTouchesSea(e, hexes)), rng);
  const portTypes = shuffle(PORT_TYPES, rng);
  const portEdgeIds = [];
  const usedVertices = new Set();
  for (const e of candidates) {
    if (portEdgeIds.length >= portTypes.length) break;
    if (usedVertices.has(e.v1) || usedVertices.has(e.v2)) continue;
    const type = portTypes[portEdgeIds.length];
    vertices[e.v1].port = type; vertices[e.v2].port = type;
    usedVertices.add(e.v1); usedVertices.add(e.v2);
    portEdgeIds.push(e.id);
  }

  const waterHexes = hexes.filter((h) => h.terrain === 'water');
  const pirateHex = waterHexes[Math.floor(rng() * waterHexes.length)].id;
  return { hexes, vertices, edges, robberHex: desert.id, pirateHex, portEdgeIds, islandHexIds };
}

// 探検家と海賊: 航海者版と同じ盤を使い、本島から離れた小島を「霧」で伏せる（船で探検するまで地形・数字が分からない）。
// 小島のうち1マスは金の川にして、探検の見返りを豪華にする（公式の金塊ヘクスの簡略版）。
// 5〜6人でも、本島が5〜6人拡張と同じ30マスになるだけで、小島3つ（各2マス）はそのまま（航海者版の5〜6人対応と同じ）。
function buildExplorersBoard(rng, ext) {
  const board = buildSeafarersBoard(rng, ext);
  const ids = [...board.islandHexIds];
  if (ids.length) board.hexes[ids[0]].terrain = 'gold';
  ids.forEach((id) => { board.hexes[id].fog = true; });
  return board;
}

// 外周の辺を頂点の並びに変換する（orderedBoundary の辺の列を、1つずつずれた頂点の列にする）
function boundaryVertexLoop(edges) {
  const order = orderedBoundary(edges);
  const verts = [];
  let prevVertex = null;
  order.forEach((eId, i) => {
    const e = edges[eId];
    if (i === 0) { verts.push(e.v1); prevVertex = e.v2; } else {
      verts.push(prevVertex);
      prevVertex = e.v1 === prevVertex ? e.v2 : e.v1;
    }
  });
  return verts;
}
function hexIsCoastal(hex, board) { return hex.edgeIds.some((eId) => board.edges[eId].hexIds.length === 1); }

// 盤の真ん中にいちばん近い「内陸」マス（全6辺が他のマスと接するマス）。隊商のオアシス・蛮族の砦に使う。
// 3〜4人の19マス盤では常に q=0,r=0 のマスと同じ結果になる（5〜6人の30マス盤にもそのまま使えるようにした）。
function boardCenterHex(board) {
  const interior = board.hexes.filter((h) => h.terrain !== 'water' && h.edgeIds.every((eId) => board.edges[eId].hexIds.length === 2));
  const avgQ = interior.reduce((a, h) => a + h.q, 0) / interior.length;
  const avgR = interior.reduce((a, h) => a + h.r, 0) / interior.length;
  const dist = (h) => (h.q - avgQ) ** 2 + (h.r - avgR) ** 2;
  return interior.reduce((best, h) => (dist(h) < dist(best) ? h : best));
}

// 漁師: 外周に漁場（出目4,5,6,8,9,10）を置く。5〜6人拡張は盤が広がるぶん数を増やす（近似。README に注記）
function applyFishingGrounds(board, rng, ext) {
  const loop = boundaryVertexLoop(board.edges);
  const n = loop.length;
  const numbers = shuffle(ext ? FISH_GROUND_NUMBERS_56 : FISH_GROUND_NUMBERS, rng);
  board.fisheries = []; // [{ vertices:[v,v,v], number }]
  numbers.forEach((num, i) => {
    const c = Math.round((i * n) / numbers.length);
    board.fisheries.push({ vertices: [loop[(c - 1 + n) % n], loop[c], loop[(c + 1) % n]], number: num });
  });
}
// 漁師: 砂漠を湖にする（公式どおり、湖は海岸に置けないので、砂漠が海岸のときは盤を作り直す）。
// 5〜6人拡張は砂漠が2つあるが、湖にするのは1つだけ（残りは普通の砂漠のまま。近似。README に注記）
function buildFishermenBoard(rng, ext) {
  let board = buildBoard(rng, ext);
  let desert = board.hexes.find((h) => h.terrain === 'desert' && !hexIsCoastal(h, board));
  let attempt = 0;
  while (!desert && attempt < 50) {
    board = buildBoard(rng, ext);
    desert = board.hexes.find((h) => h.terrain === 'desert' && !hexIsCoastal(h, board));
    attempt++;
  }
  if (!desert) desert = board.hexes.find((h) => h.terrain === 'desert'); // 50回だめなら海岸でも受け入れる
  desert.terrain = 'lake';
  desert.lakeNumbers = LAKE_NUMBERS.slice();
  board.robberHex = null; // 盗賊は盤の外にいて、最初の7で初めて盤に入る
  applyFishingGrounds(board, rng, ext);
  return board;
}
// 漁師: 魚トークンの山を混ぜて作る。5〜6人拡張は数を増やす（近似。README に注記）
function buildFishBag(rng, ext) {
  const counts = ext ? FISH_TOKEN_COUNTS_56 : FISH_TOKEN_COUNTS;
  const entries = [];
  Object.entries(counts).forEach(([v, n]) => { for (let i = 0; i < n; i++) entries.push(Number(v)); });
  entries.push('boot');
  return shuffle(entries, rng);
}

// 川: 盤を横切る真ん中の列（r=0）の間の辺をつなげ、両端を盤の外周まで延ばす（簡略化。README に注記）
// 古い保存の引き継ぎ用: 小島の座標（SEAFARERS_ISLANDS）に一致するヘクスを探して islandHexIds を作り直す（乱数を使わないので盤から復元できる）
export function recoverIslandHexIds(board) {
  const coords = new Set(SEAFARERS_ISLANDS.flat().map((c) => `${c.q},${c.r}`));
  return board.hexes.filter((h) => coords.has(`${h.q},${h.r}`)).map((h) => h.id);
}
export function applyRiver(board) {
  const row = board.hexes.filter((h) => h.r === 0).sort((a, b) => a.q - b.q);
  const riverEdgeIds = [];
  for (let i = 0; i < row.length - 1; i++) {
    const edge = board.edges.find((e) => e.hexIds.includes(row[i].id) && e.hexIds.includes(row[i + 1].id));
    if (edge) riverEdgeIds.push(edge.id);
  }
  [row[0], row[row.length - 1]].forEach((h) => {
    const outer = h.edgeIds.find((eId) => board.edges[eId].hexIds.length === 1);
    if (outer != null && !riverEdgeIds.includes(outer)) riverEdgeIds.push(outer);
  });
  board.riverEdgeIds = riverEdgeIds;
  const vIds = [];
  riverEdgeIds.forEach((eId) => { const e = board.edges[eId]; [e.v1, e.v2].forEach((v) => { if (!vIds.includes(v)) vIds.push(v); }); });
  board.riverVertexIds = vIds;
}

// 隊商: 砂漠をオアシスとして盤の中心（必ず内陸）に固定し、周りの6辺のうち3つを各キャラバンの出発点にする
function buildCaravansBoard(rng, ext) {
  const board = buildBoard(rng, ext);
  const center = boardCenterHex(board);
  const desert = board.hexes.find((h) => h.terrain === 'desert');
  if (center.id !== desert.id) {
    const ct = center.terrain, cn = center.number;
    center.terrain = desert.terrain; center.number = desert.number;
    desert.terrain = ct; desert.number = cn;
  }
  board.oasisHexId = center.id;
  board.camelStartEdges = [center.edgeIds[0], center.edgeIds[2], center.edgeIds[4]]; // 3本の矢印（物理コマの向きは任意なのでこの3辺とする）
  board.caravans = [[], [], []]; // キャラバンごとの辺IDの列（オアシス側から先頭へ）
  board.robberHex = null; // 盗賊は盤の外にいて、最初の7で初めて盤に入る（オアシスには置かない）
  return board;
}

const BARBARIAN_SUPPLY = 30;
const BARBARIAN_SUPPLY_56 = 36; // 5〜6人拡張は近似（銀行の資源が19→24になる比率に近い約1.2倍。README に注記）
// 蛮族の襲撃: 盤の中心を「砦」にする（産出せず、征服もされない。騎士は砦の6辺から出る）。
// 本来の専用盤（砂漠+砦+沿岸の輪）は作らず、基本の19マス（5〜6人は30マス）に砦を足す簡略化（README に注記）。
function applyBarbarianBoard(board, rng, ext) {
  const castle = boardCenterHex(board);
  const desert = board.hexes.find((h) => h.terrain === 'desert');
  if (castle.id !== desert.id) {
    // 砦に出目チップがあると2・12が盤から消えてしまうので、砂漠と入れ替えて数字チップを減らさない
    const dt = desert.terrain, dn = desert.number;
    desert.terrain = castle.terrain; desert.number = castle.number;
    castle.terrain = dt; castle.number = dn;
  }
  castle.terrain = 'castle';
  castle.number = null;
  board.castleHexId = castle.id;
  board.hexes.forEach((h) => { h.barbarians = 0; h.conquered = false; });
  const two = board.hexes.find((h) => h.id !== castle.id && h.number === 2);
  const twelve = board.hexes.find((h) => h.id !== castle.id && h.number === 12);
  if (two) two.barbarians = 1;
  if (twelve) twelve.barbarians = 1;
  board.barbarianSupply = (ext ? BARBARIAN_SUPPLY_56 : BARBARIAN_SUPPLY) - (two ? 1 : 0) - (twelve ? 1 : 0);
  board.robberHex = null; // このシナリオでは盗賊を使わない
}
function barbarianTargetHexes(board) { return board.hexes.filter((h) => h.id !== board.castleHexId && h.terrain !== 'desert'); }

// サッカー熱: 砂漠を盤の中心のサッカー場にし、もう1つは出目「2」のマスを置き換える。
// 置き換えたマスの「2」チップは、そのぶん出目チップの枚数が減らないよう、出目「12」のマスへ足す（2マス目のチップとして hex.number2 に持たせる）。
// 公式は専用フレームで物理のランドスケープ駒を移し替えるが、デジタル版なのでマスを直接サッカー場に変える簡略化（README に注記）。
function buildSoccerBoard(rng) {
  const board = buildBoard(rng, false);
  const center = board.hexes.find((h) => h.q === 0 && h.r === 0);
  const desert = board.hexes.find((h) => h.terrain === 'desert');
  if (center.id !== desert.id) {
    const dt = desert.terrain, dn = desert.number;
    desert.terrain = center.terrain; desert.number = center.number;
    center.terrain = dt; center.number = dn;
  }
  center.terrain = 'pitch'; center.number = null;
  const two = board.hexes.find((h) => h.id !== center.id && h.number === 2);
  const twelve = board.hexes.find((h) => h.id !== center.id && h.number === 12);
  if (two) { two.terrain = 'pitch'; two.number = null; if (twelve) twelve.number2 = 2; }
  board.pitchHexIds = [center.id, ...(two ? [two.id] : [])];
  board.robberHex = null; // 砂漠がないので、盗賊は最初の7が出るまで盤の外（公式どおり）
  return board;
}
// サッカー熱: 第 day 節（1始まり）の対戦カード。公式の「スケジュール表」を、循環式の総当たり計算に置き換える（README に注記）。
// 4人: 3節で全6組の対戦が1巡し、15節=5巡。3人: ダブルプレイヤー（2試合こなす人）が3節で一巡し、12節=4巡。
export function soccerFixturesForDay(playerCount, day) {
  if (playerCount === 4) {
    const rot = (day - 1) % 3;
    const others = [1, 2, 3];
    for (let i = 0; i < rot; i++) others.push(others.shift());
    return [[0, others[2]], [others[0], others[1]]];
  }
  const order = [0, 1, 2];
  const double = order[(day - 1) % 3];
  const others = order.filter((x) => x !== double);
  return [[double, others[0]], [double, others[1]]];
}

// ================================================================
// ゲームの作成
// options.expansions: 使う拡張の名前の配列（今は '5-6player' だけ実装。5〜6人を選ぶと自動で足される）。
// 航海者版・都市と騎士・交易と略奪を足すときも、ここに名前を増やしていく。
// ================================================================
export function createGame(playerCount, rng = Math.random, options = {}) {
  const expansions = (options.expansions || []).slice();
  if (playerCount >= 5 && !expansions.includes('5-6player')) expansions.push('5-6player');
  const ext = expansions.includes('5-6player');
  const seafarers = expansions.includes('seafarers');
  const ck = expansions.includes('cities-knights'); // 都市と騎士。5〜6人なら5〜6人拡張の盤に自動で変わる（航海者版との組み合わせは作っていない）
  // 交易と略奪。5〜6人なら5〜6人拡張の盤に自動で変わる（航海者版・都市と騎士との組み合わせは作っていない）
  const tb = expansions.includes('traders-barbarians') && !seafarers && !ck;
  // サッカー熱。同じく3〜4人・基本盤だけで使う想定（航海者版・5〜6人・都市と騎士・交易と略奪との組み合わせは作っていない）
  const soccer = expansions.includes('soccer') && !ext && !seafarers && !ck && !tb;
  // 探検家と海賊。航海者版と同じ盤だけで使う想定（他の拡張との組み合わせはありません）。5〜6人なら5〜6人拡張の盤に自動で変わる
  const ep = expansions.includes('explorers-pirates') && !seafarers && !ck && !tb && !soccer;
  const scenario = tb ? (TB_SCENARIOS.includes(options.scenario) ? options.scenario : 'fishermen') : null;
  let board;
  if (seafarers) board = buildSeafarersBoard(rng, ext);
  else if (ep) board = buildExplorersBoard(rng, ext);
  else if (scenario === 'fishermen') board = buildFishermenBoard(rng, ext);
  else if (scenario === 'caravans') board = buildCaravansBoard(rng, ext);
  else if (soccer) board = buildSoccerBoard(rng);
  else board = buildBoard(rng, ext);
  if (scenario === 'rivers') applyRiver(board);
  else if (scenario === 'barbarians') applyBarbarianBoard(board, rng, ext);
  const bankStart = ext ? BANK_START_56 : BANK_START;
  const ckCommodityStart = ext ? CK_BANK_COMMODITY_START_56 : CK_BANK_COMMODITY_START;
  const names = options.names || [];
  const players = Array.from({ length: playerCount }, (_, i) => ({
    idx: i,
    name: names[i] || `プレイヤー${i + 1}`,
    color: PLAYER_COLORS[i],
    resources: emptyResources(),
    roads: [], settlements: [], cities: [], ships: [],
    devCards: [], // { type, boughtTurn, played }
    knightsPlayed: 0,
    roadLength: 0,
    islandBonus: false, // 航海者版: 小島に初めて開拓地を建てたら true（+2点）
    // 都市と騎士（ck=trueのときだけ使う）
    commodities: ck ? emptyCommodities() : null,
    cityImprovements: ck ? { trade: 0, politics: 0, science: 0 } : null,
    knights: ck ? [] : null, // { id, vertexId, level(1=弱/2=強/3=最強), active, actedTurn }
    walls: ck ? 0 : 0,
    progressCards: ck ? [] : null, // { color, id }
    progressVp: 0,
    defenderVp: 0,
    // 交易と略奪（該当するシナリオのときだけ使う）
    fishTokens: scenario === 'fishermen' ? [] : null, // 持っている魚トークン（1〜3の配列）
    gold: (scenario === 'rivers' || scenario === 'barbarians') ? 0 : null,
    goldSpendsThisTurn: 0,
    bridges: scenario === 'rivers' ? 0 : 0,
    warKnights: scenario === 'barbarians' ? [] : null, // { id, edgeId }
    prisoners: scenario === 'barbarians' ? 0 : 0,
    pendingCamelBuilds: 0, // 隊商: この手番に建てた開拓地・都市の数（手番の終わりにラクダを置く）
    // サッカー熱（soccer=trueのときだけ使う）
    socShots: soccer ? 1 : 0, // 持ち駒（攻撃回数）。最初の組み合わせで1枚使うので1から始まる（上限6）
    socPoints: 0, // フットボールレーンの位置
    // 探検家と海賊（ep=trueのときだけ使う）
    epRevealed: ep ? 0 : null, // 船で見つけた霧のマスの数（3つで探検ミッション+1点。最初に3つに届いた人だけ）
  }));
  const setupOrder = Array.from({ length: playerCount }, (_, i) => i); // 1周目は順に。2周目は setup2 で逆順にする
  const game = {
    playerCount,
    expansions,
    players,
    board,
    bank: {
      resources: { wood: bankStart, brick: bankStart, sheep: bankStart, wheat: bankStart, ore: bankStart },
      devDeck: ck ? [] : buildDevDeck(rng, ext, scenario), // 都市と騎士では発展カードは使わない
      commodities: ck ? { paper: ckCommodityStart, cloth: ckCommodityStart, coin: ckCommodityStart } : null,
    },
    phase: 'setup1', // setup1 → setup2 → roll → main / discard / goldPick / scienceBonus / moveRobber / specialBuilding → gameOver
    setupOrder,
    setupIndex: 0,
    setupPending: 'settlement', // 'settlement' | 'road'
    setupLastVertex: null,
    turn: setupOrder[0],
    turnNumber: 1,
    diceLast: null,
    devCardPlayedThisTurn: false,
    shipMovedThisTurn: false, // 航海者版: 手番に船を動かせるのは1回だけ
    scenario,
    soccer,
    soccerDay: soccer ? 1 : 0,
    soccerMaxDay: soccer ? SOCCER_DAYS[playerCount] : 0,
    soccerSeasonOver: false,
    pendingSoccerMatch: false,
    soccerLastResult: null,
    explorersPirates: ep,
    epMissionWinner: null, // 探検ミッション（霧のマスを3つ見つける）を最初に達成した人
    winTarget: ck ? 13 : (soccer ? 11 : ((seafarers || ep) ? 14 : (scenario ? TB_WIN_TARGET[scenario] : 10))),
    richPlayer: null, // 川: 金貨が一番多い人だけ(+1点)
    poorPlayers: [], // 川: 金貨が一番少ない人たち（同点なら全員）(-2点ずつ)
    oldBootHolder: null, // 漁師: 古い靴を持つ人（勝利点が+1点多く要る）
    fishBag: scenario === 'fishermen' ? buildFishBag(rng, ext) : null, // 魚トークンの山（伏せて混ぜてある）
    fishUsed: scenario === 'fishermen' ? [] : null, // 使った魚トークン（山が尽きたら混ぜ直す）
    pendingCamelVote: null, // 隊商: 投票中の情報 { order, idx, bids, remaining }
    tbBarbarianAttacksDone: 0,
    pendingDiscards: [], // [{ player, count }]
    pendingGoldPicks: [], // 航海者版: 金の川マスで選べる資源 [{ player, count }]
    pendingScienceBonus: [], // 都市と騎士(科学3段階目): この目で何も入らなかった人の列 [playerIdx]
    specialBuildQueue: [], // 5〜6人拡張の特別建設フェイズ: 手番を終えた人以外が順に並ぶ
    specialBuildIdx: 0,
    longestRoadPlayer: null,
    largestArmyPlayer: null,
    winner: null,
    lastSteal: null, // 通信対戦: 直前に盗賊/海賊で奪った内容 { from, to, res }。main.js が奪った人・奪われた人の画面にだけ出す
    events: [], // 音・演出のきっかけ。main.js が読んで clear する
    log: [],
    // 都市と騎士
    metropolis: ck ? { trade: null, politics: null, science: null } : null,
    progressDecks: ck ? { trade: buildProgressDeck(rng, 'trade', ext), politics: buildProgressDeck(rng, 'politics', ext), science: buildProgressDeck(rng, 'science', ext) } : null,
    barbarianProgress: 0,
    barbarianAttacked: false, // まだ一度も蛮族が襲来していない間は、7が出ても盗賊は動かない
    eventDie: null,
  };
  if (scenario === 'rivers') recalcGoldRoles(game); // 金貨0枚は全員同点なので、最初から全員「貧者」になる（公式どおり）
  return game;
}

export function currentPlayer(game) {
  if (game.phase === 'setup1' || game.phase === 'setup2') return game.setupOrder[game.setupIndex];
  if (game.phase === 'specialBuilding') return game.specialBuildQueue[game.specialBuildIdx];
  return game.turn;
}
// 隊商の投票・配置フェイズは、動いている人が currentPlayer（手番の人）と違うことがあるので、こちらを使う
export function actingPlayer(game) {
  if (game.phase === 'camelVote' && game.pendingCamelVote) return game.pendingCamelVote.order[game.pendingCamelVote.idx];
  if (game.phase === 'camelPlace') return game.camelDecider;
  return currentPlayer(game);
}

function log(game, text) { game.log.push(text); if (game.log.length > 200) game.log.shift(); }
// 名前を付けていない古い保存にも対応できるよう、無ければ「プレイヤーN」を返す
export function playerName(game, idx) { return (game.players[idx] && game.players[idx].name) || `プレイヤー${idx + 1}`; }
function fire(game, evt) { game.events.push(evt); }

// ---- 得点 ----
export function devVpCount(player) { return player.devCards.filter((c) => c.type === 'vp').length; }
export function playerScore(game, idx) {
  const p = game.players[idx];
  // 蛮族の襲撃: 征服された開拓地・都市は勝利点にならない（公式どおり）
  const isConquered = (vid) => { const b = game.board.vertices[vid].building; return b && b.conquered; };
  const buildingScore = game.scenario === 'barbarians'
    ? p.settlements.filter((v) => !isConquered(v)).length + p.cities.filter((v) => !isConquered(v)).length * 2
    : p.settlements.length + p.cities.length * 2;
  let score = buildingScore
    + (game.longestRoadPlayer === idx ? 2 : 0)
    + (game.scenario !== 'barbarians' && game.largestArmyPlayer === idx ? 2 : 0) // 蛮族の襲撃では「最大騎士力」は使わない（公式どおり）
    + devVpCount(p)
    + (p.islandBonus ? 2 : 0);
  if (game.metropolis) {
    TRACKS.forEach((t) => { if (metropolisOwner(game, t) === idx) score += 2; }); // 大都市+2点（1人1系統まで）
    score += (p.progressVp || 0) + (p.defenderVp || 0);
  }
  if (game.scenario === 'rivers') {
    score += (game.richPlayer === idx ? 1 : 0) - ((game.poorPlayers || []).includes(idx) ? 2 : 0);
  }
  if (game.scenario === 'caravans') {
    score += caravanVertexBonus(game, idx);
  }
  if (game.scenario === 'barbarians') {
    score += Math.floor((p.prisoners || 0) / 2); // 捕虜2人につき勝利点1
  }
  if (game.soccer) {
    score += soccerStandings(game)[idx].vp;
  }
  if (game.explorersPirates && game.epMissionWinner === idx) score += 1; // 探検ミッション: 霧のマスを最初に3つ見つけた人+1点
  return score;
}
// サッカー熱: フットボールレーンの順位表。同点は同じ順位を分け合い、次の順位をその人数ぶん飛ばす（公式どおり）
export function soccerStandings(game) {
  const order = game.players.map((_, i) => i).sort((a, b) => game.players[b].socPoints - game.players[a].socPoints);
  const out = new Array(game.playerCount);
  let place = 1, i = 0;
  while (i < order.length) {
    let j = i;
    while (j < order.length && game.players[order[j]].socPoints === game.players[order[i]].socPoints) j++;
    const vp = Math.max(0, 4 - place);
    for (let k = i; k < j; k++) out[order[k]] = { idx: order[k], points: game.players[order[k]].socPoints, place, vp };
    place += (j - i);
    i = j;
  }
  return out;
}
// 漁師: 古い靴を持つ人は勝利点が1点多く要る（公式どおり。10点が標準、古い靴は11点）
export function winTargetFor(game, idx) {
  return (game.winTarget || 10) + (game.scenario === 'fishermen' && game.oldBootHolder === idx ? 1 : 0);
}
function checkWin(game, idx) {
  if (game.winner != null) return;
  if (playerScore(game, idx) >= winTargetFor(game, idx)) { game.winner = idx; game.phase = 'gameOver'; fire(game, 'win'); log(game, `${playerName(game, idx)}の勝ち！`); }
}
// 古い靴・富豪・貧者・ラクダの印など、自分では何も建てていない人の得点(に要る点)を変えることがあるので、
// ここで全員ぶん checkWin をかけ直す(でないと、その人が次に何か建てるまで勝利が見逃される)
function checkWinAll(game) { game.players.forEach((_, i) => checkWin(game, i)); }
// 川: 金貨が一番多い人だけ「富豪」(+1点)。一番少ない人は「貧者」(-2点)で、同点なら全員が貧者になる（公式どおり）
function recalcGoldRoles(game) {
  const gold = game.players.map((p) => p.gold || 0);
  const max = Math.max(...gold), min = Math.min(...gold);
  const rich = gold.map((g, i) => (g === max ? i : -1)).filter((i) => i >= 0);
  game.richPlayer = rich.length === 1 ? rich[0] : null;
  game.poorPlayers = gold.map((g, i) => (g === min ? i : -1)).filter((i) => i >= 0);
  checkWinAll(game);
}
// 航海者版: 小島（本島でも海でもないマス）に初めて開拓地を建てたら+2点
function markIslandBonus(game, idx, vertexId) {
  if (!game.board.islandHexIds || game.players[idx].islandBonus) return;
  const v = game.board.vertices[vertexId];
  if (!v.hexIds.some((h) => game.board.islandHexIds.includes(h))) return;
  game.players[idx].islandBonus = true;
  log(game, `${playerName(game, idx)}が新しい島に開拓地を建てた（+2点）`);
  checkWin(game, idx);
}
// サッカー熱: サッカー場に接する開拓地・都市を建てるたびに、持ち駒（攻撃回数）を1枚増やす（上限6枚、公式どおり）
function grantSoccerShot(game, idx, vertexId) {
  if (!game.soccer) return;
  const v = game.board.vertices[vertexId];
  if (!v.hexIds.some((h) => game.board.hexes[h].terrain === 'pitch')) return;
  const p = game.players[idx];
  if (p.socShots >= SOCCER_MAX_SHOTS) return;
  p.socShots++;
  log(game, `${playerName(game, idx)}のサッカーの持ち駒が${p.socShots}枚になった`);
}

// ---- 建設できる場所 ----
export function canPlaceSettlement(game, vertexId, playerIdx, isSetup) {
  const v = game.board.vertices[vertexId];
  if (v.building) return false;
  if (v.neighbors.some((n) => game.board.vertices[n].building)) return false; // 距離ルール
  if (!v.hexIds.some((h) => game.board.hexes[h].terrain !== 'water')) return false; // 海のど真ん中には置けない
  if (game.explorersPirates && !v.hexIds.some((h) => game.board.hexes[h].terrain !== 'water' && !game.board.hexes[h].fog)) return false; // 探検家と海賊: 霧のままの島にはまだ建てられない
  if (game.scenario === 'barbarians' && !isSetup && v.hexIds.some((h) => game.board.hexes[h].conquered)) return false; // 征服されたマスの隣には建てられない
  if (isSetup) return true;
  return v.edgeIds.some((eId) => { const e = game.board.edges[eId]; return e.road === playerIdx || e.ship === playerIdx; });
}
export function availableSettlementVertices(game, playerIdx, isSetup) {
  return game.board.vertices.filter((v) => canPlaceSettlement(game, v.id, playerIdx, isSetup)).map((v) => v.id);
}
export function availableCityVertices(game, playerIdx) {
  return game.players[playerIdx].settlements.slice();
}
export function canPlaceRoad(game, edgeId, playerIdx) {
  const e = game.board.edges[edgeId];
  if (e.road != null || e.ship != null) return false;
  if (!edgeTouchesLand(e, game.board.hexes)) return false;
  if (game.scenario === 'barbarians' && e.hexIds.some((h) => game.board.hexes[h].conquered)) return false; // 征服されたマスの隣には道を通せない
  return [e.v1, e.v2].some((vid) => {
    const v = game.board.vertices[vid];
    if (v.building && v.building.owner === playerIdx) return true;
    return v.edgeIds.some((other) => other !== edgeId && game.board.edges[other].road === playerIdx);
  });
}
export function availableRoadEdges(game, playerIdx) {
  return game.board.edges.filter((e) => canPlaceRoad(game, e.id, playerIdx)).map((e) => e.id);
}

// ---- 探検家と海賊: 霧のマスを探検する ----
// 辺の両どなりのマスに霧があれば、船を置いた・動かした人がそれを見つける（公式の「探検チップをめくる」の簡略版）。
function revealFogHex(game, hexId, playerIdx) {
  const hex = game.board.hexes[hexId];
  if (!hex.fog) return;
  hex.fog = false;
  const p = game.players[playerIdx];
  p.epRevealed = (p.epRevealed || 0) + 1;
  // 見つけたマスの資源を1枚もらう（金の川は、資源を選べる本来の仕組みの代わりに、簡略化してランダムな1種類にする）
  const res = hex.terrain === 'gold' ? RESOURCES[Math.floor(Math.random() * RESOURCES.length)] : TERRAIN_RESOURCE[hex.terrain];
  if (res && game.bank.resources[res] > 0) { game.bank.resources[res]--; p.resources[res]++; }
  log(game, `${playerName(game, playerIdx)}が霧の中から${TERRAIN_LABEL[hex.terrain]}の島を見つけた`);
  if (game.epMissionWinner == null && p.epRevealed >= 3) {
    game.epMissionWinner = playerIdx;
    log(game, `${playerName(game, playerIdx)}が探検ミッション達成（+1点）`);
  }
}
function revealFogAt(game, edgeId, playerIdx) {
  if (!game.explorersPirates) return;
  game.board.edges[edgeId].hexIds.forEach((hId) => revealFogHex(game, hId, playerIdx));
}

// ---- 船（航海者版）----
function pirateAdjacent(game, edgeId) {
  if (game.board.pirateHex == null) return false;
  return game.board.hexes[game.board.pirateHex].edgeIds.includes(edgeId);
}
export function canPlaceShip(game, edgeId, playerIdx) {
  if (game.board.pirateHex == null) return false; // 航海者版でなければ船は使わない
  const e = game.board.edges[edgeId];
  if (e.road != null || e.ship != null) return false;
  if (!edgeTouchesSea(e, game.board.hexes)) return false;
  if (pirateAdjacent(game, edgeId)) return false; // 海賊の隣には置けない
  return [e.v1, e.v2].some((vid) => {
    const v = game.board.vertices[vid];
    if (v.building && v.building.owner === playerIdx) return true;
    return v.edgeIds.some((other) => other !== edgeId && game.board.edges[other].ship === playerIdx);
  });
}
export function availableShipEdges(game, playerIdx) {
  if (game.board.pirateHex == null) return [];
  return game.board.edges.filter((e) => canPlaceShip(game, e.id, playerIdx)).map((e) => e.id);
}
export function buildShip(game, edgeId) {
  if (!canBuildNow(game)) return false;
  const idx = currentPlayer(game);
  const p = game.players[idx];
  if (p.ships.length >= MAX_SHIPS) return false;
  if (!canPlaceShip(game, edgeId, idx)) return false;
  if (!canAfford(p.resources, COSTS.ship)) return false;
  payCost(p.resources, COSTS.ship);
  RESOURCES.forEach((r) => { game.bank.resources[r] += COSTS.ship[r] || 0; });
  const e = game.board.edges[edgeId];
  e.ship = idx; e.shipPlacedTurn = game.turnNumber;
  p.ships.push(edgeId);
  revealFogAt(game, edgeId, idx);
  fire(game, 'build');
  recalcLongestRoad(game);
  checkWin(game, idx);
  return true;
}
// 船が交易路の端にあるか（片方の頂点に、自分の他の船がなく、どちらの持ち主の建物もない）
function isShipEnd(game, edgeId, playerIdx) {
  const e = game.board.edges[edgeId];
  return [e.v1, e.v2].some((vid) => {
    const v = game.board.vertices[vid];
    if (v.building) return false;
    return !v.edgeIds.some((eid) => eid !== edgeId && game.board.edges[eid].ship === playerIdx);
  });
}
// 今動かせる自分の船（手番に1回・置いたばかりでない・列の端・海賊の隣でない）
export function movableShipEdges(game, playerIdx) {
  if (game.board.pirateHex == null || game.shipMovedThisTurn) return [];
  return game.players[playerIdx].ships.filter((eId) => {
    const e = game.board.edges[eId];
    return e.shipPlacedTurn !== game.turnNumber && isShipEnd(game, eId, playerIdx) && !pirateAdjacent(game, eId);
  });
}
// 自分の船を1隻、まだ動かしていなければ別の海の辺へ動かす（手番に1回だけ、置いたばかりの船は不可）
export function moveShip(game, fromEdgeId, toEdgeId) {
  if (!canBuildNow(game)) return false;
  const idx = currentPlayer(game);
  if (game.shipMovedThisTurn) return false;
  const e = game.board.edges[fromEdgeId];
  if (e.ship !== idx) return false;
  if (e.shipPlacedTurn === game.turnNumber) return false;
  if (!isShipEnd(game, fromEdgeId, idx)) return false;
  if (pirateAdjacent(game, fromEdgeId)) return false;
  const to = game.board.edges[toEdgeId];
  if (to.road != null || to.ship != null) return false;
  if (!edgeTouchesSea(to, game.board.hexes)) return false;
  if (pirateAdjacent(game, toEdgeId)) return false;
  const stillConnected = [to.v1, to.v2].some((vid) => {
    const v = game.board.vertices[vid];
    if (v.building && v.building.owner === idx) return true;
    return v.edgeIds.some((other) => other !== fromEdgeId && other !== toEdgeId && game.board.edges[other].ship === idx);
  });
  if (!stillConnected) return false;
  e.ship = null; e.shipPlacedTurn = null;
  to.ship = idx; to.shipPlacedTurn = game.turnNumber;
  const i = game.players[idx].ships.indexOf(fromEdgeId);
  if (i >= 0) game.players[idx].ships[i] = toEdgeId;
  game.shipMovedThisTurn = true;
  revealFogAt(game, toEdgeId, idx);
  fire(game, 'build');
  recalcLongestRoad(game);
  checkWin(game, idx);
  return true;
}

// ---- セットアップ（最初の開拓地と道を2周） ----
export function setupPlaceSettlement(game, vertexId) {
  const idx = currentPlayer(game);
  if (game.phase !== 'setup1' && game.phase !== 'setup2') return false;
  if (game.setupPending !== 'settlement') return false;
  if (!canPlaceSettlement(game, vertexId, idx, true)) return false;
  // 蛮族の襲撃: 2つ目は最初から都市にする（公式どおり。もらう資源は都市でも1枚のまま＝setupPlaceRoad側で対応）
  const asCity = game.scenario === 'barbarians' && game.phase === 'setup2';
  game.board.vertices[vertexId].building = { owner: idx, type: asCity ? 'city' : 'settlement' };
  if (asCity) game.players[idx].cities.push(vertexId); else game.players[idx].settlements.push(vertexId);
  markIslandBonus(game, idx, vertexId);
  grantRiverGold(game, idx, vertexId, 'vertex');
  grantSoccerShot(game, idx, vertexId);
  game.setupLastVertex = vertexId;
  game.setupPending = 'road';
  fire(game, 'build');
  log(game, `${playerName(game, idx)}が開拓地を置いた`);
  return true;
}
export function setupPlaceRoad(game, edgeId) {
  const idx = currentPlayer(game);
  if (game.phase !== 'setup1' && game.phase !== 'setup2') return false;
  if (game.setupPending !== 'road') return false;
  const e = game.board.edges[edgeId];
  if (e.road != null) return false;
  if (e.v1 !== game.setupLastVertex && e.v2 !== game.setupLastVertex) return false;
  e.road = idx;
  game.players[idx].roads.push(edgeId);
  grantRiverGold(game, idx, edgeId, 'edge');
  fire(game, 'build');
  if (game.phase === 'setup2') {
    const v = game.board.vertices[game.setupLastVertex];
    v.hexIds.forEach((hId) => {
      const hex = game.board.hexes[hId];
      const res = TERRAIN_RESOURCE[hex.terrain];
      if (res) { game.players[idx].resources[res]++; game.bank.resources[res]--; } // 蛮族の襲撃で2つ目が都市でも、資源は1枚のまま（公式どおり）
    });
  }
  game.setupIndex++;
  if (game.setupIndex >= game.setupOrder.length) {
    if (game.phase === 'setup1') {
      game.phase = 'setup2';
      game.setupOrder = game.setupOrder.slice().reverse();
      game.setupIndex = 0;
    } else {
      game.phase = 'roll'; // セットアップが終わったら、最初のプレイヤー（setup1を始めた人）から通常手番
      game.turn = 0;
    }
  }
  game.setupPending = 'settlement';
  return true;
}
function advanceIdx(game, idx) { return (idx + 1) % game.playerCount; }

// ---- 資源の産出 ----
function distributeResources(game, total) {
  if (game.scenario === 'fishermen') {
    (game.board.fisheries || []).forEach((f) => {
      if (f.number !== total) return; // 漁場は盗賊の影響を受けない（盗賊は陸のマスにしか置けないため）
      f.vertices.forEach((vid) => {
        const v = game.board.vertices[vid];
        if (!v.building) return;
        grantFishToken(game, v.building.owner);
        if (v.building.type === 'city') grantFishToken(game, v.building.owner);
      });
    });
    const lake = game.board.hexes.find((h) => h.terrain === 'lake');
    if (lake && lake.lakeNumbers.includes(total)) {
      lake.vertexIds.forEach((vid) => {
        const v = game.board.vertices[vid];
        if (!v.building) return;
        grantFishToken(game, v.building.owner);
        if (v.building.type === 'city') grantFishToken(game, v.building.owner);
      });
    }
  }
  const ck = !!game.bank.commodities;
  const before = game.players.map((p) => sumRes(p.resources) + sumCommodities(p.commodities));
  const demand = emptyResources();
  const contributions = [];
  const commodityDemand = emptyCommodities();
  const commodityContribs = [];
  const goldDemand = {}; // 金の川マス: 資源は確定させず、あとで本人に選ばせる（player → 枚数）
  game.board.hexes.forEach((hex) => {
    // サッカー熱: 出目「12」のマスは hex.number2 の「2」でも産出する（置き換えたサッカー場ぶんのチップを足したもの）
    if ((hex.number !== total && hex.number2 !== total) || hex.id === game.board.robberHex || hex.conquered) return; // 蛮族の襲撃: 征服されたマスは産出しない
    if (hex.terrain === 'gold') {
      hex.vertexIds.forEach((vid) => {
        const v = game.board.vertices[vid];
        if (!v.building) return;
        const amt = v.building.type === 'city' ? 2 : 1;
        goldDemand[v.building.owner] = (goldDemand[v.building.owner] || 0) + amt;
      });
      return;
    }
    const res = TERRAIN_RESOURCE[hex.terrain];
    if (!res) return;
    const com = ck ? COMMODITY_OF_TERRAIN[hex.terrain] : null; // 都市と騎士: 森・牧草・山の都市は資源1+商品1。畑・丘の都市は資源2のまま
    hex.vertexIds.forEach((vid) => {
      const v = game.board.vertices[vid];
      if (!v.building) return;
      const isCity = v.building.type === 'city';
      if (isCity && com) {
        contributions.push({ player: v.building.owner, res, amt: 1, hex: hex.id });
        demand[res] += 1;
        commodityContribs.push({ player: v.building.owner, res: com, amt: 1, hex: hex.id });
        commodityDemand[com] += 1;
      } else {
        const amt = isCity ? 2 : 1;
        contributions.push({ player: v.building.owner, res, amt, hex: hex.id });
        demand[res] += amt;
      }
    });
  });
  RESOURCES.forEach((res) => {
    if (demand[res] === 0) return;
    const resContribs = contributions.filter((c) => c.res === res);
    if (demand[res] > game.bank.resources[res]) {
      fire(game, 'shortage');
      const players = new Set(resContribs.map((c) => c.player));
      if (players.size !== 1) return; // もらう人が2人以上なら、公式どおり誰ももらえない
      const avail = game.bank.resources[res];
      if (avail <= 0) return; // もらう人が1人だけなら、銀行に残っている分だけ渡す（公式どおり）
      const owner = resContribs[0].player;
      game.players[owner].resources[res] += avail;
      (game.gains ||= []).push({ player: owner, res, amt: avail, hex: resContribs[0].hex });
      game.bank.resources[res] = 0;
      return;
    }
    resContribs.forEach((c) => {
      game.players[c.player].resources[res] += c.amt;
      (game.gains ||= []).push(c); // 演出のきっかけ。main.js が読んで clear する
    });
    game.bank.resources[res] -= demand[res];
  });
  if (ck) {
    COMMODITIES.forEach((com) => {
      if (commodityDemand[com] === 0) return;
      if (commodityDemand[com] > game.bank.commodities[com]) { fire(game, 'shortage'); return; }
      commodityContribs.filter((c) => c.res === com).forEach((c) => {
        game.players[c.player].commodities[com] += c.amt;
        (game.gains ||= []).push(c);
      });
      game.bank.commodities[com] -= commodityDemand[com];
    });
  }
  game.pendingGoldPicks = Object.entries(goldDemand).map(([player, count]) => ({ player: Number(player), count }));
  // 科学3段階目: この目で自分に資源・商品が1枚も入らなかった人は、あとで好きな資源を1枚選べる
  // （金の川で選べる人は、あとで資源が入るので対象外）
  game.pendingScienceBonus = game.players
    .map((p, idx) => idx)
    .filter((idx) => {
      const p = game.players[idx];
      if (!p.cityImprovements || p.cityImprovements.science < 3) return false;
      if (game.pendingGoldPicks.some((d) => d.player === idx)) return false;
      return sumRes(p.resources) + sumCommodities(p.commodities) === before[idx];
    });
}

// 出目で産出するタイルの id（盤の演出用）。distributeResources の判定と合わせる
// （航海者版の金のタイルは hex.number で、交易と略奪の湖は lakeNumbers で当たる。盗賊のいるマス・征服済みマスは外す）
export function hitHexIds(game, total) {
  if (total === 7) return [];
  return game.board.hexes
    .filter((hex) => hex.id !== game.board.robberHex && !hex.conquered
      && (hex.number === total || hex.number2 === total || (hex.terrain === 'lake' && hex.lakeNumbers && hex.lakeNumbers.includes(total))))
    .map((hex) => hex.id);
}

// 金の川マスの枚数ぶん、好きな資源を選んで受け取る
export function pickGold(game, playerIdx, resources) {
  const pending = game.pendingGoldPicks.find((d) => d.player === playerIdx);
  if (!pending) return false;
  // 銀行にその資源がなければ、権利より少ない枚数しか選べない（公式ルール: 足りなければそのぶんは諦める）
  if (!Array.isArray(resources) || resources.length > pending.count) return false;
  if (resources.some((r) => !RESOURCES.includes(r))) return false;
  const need = emptyResources();
  resources.forEach((r) => { need[r]++; });
  if (!canAfford(game.bank.resources, need)) return false; // 銀行に足りなければ選び直し
  payCost(game.bank.resources, need);
  resources.forEach((r) => { game.players[playerIdx].resources[r]++; });
  game.pendingGoldPicks = game.pendingGoldPicks.filter((d) => d.player !== playerIdx);
  if (!game.pendingGoldPicks.length) game.phase = game.pendingScienceBonus.length ? 'scienceBonus' : 'main';
  fire(game, 'build');
  return true;
}

// 都市と騎士(科学3段階目): 何も入らなかった目のぶん、好きな資源を1枚もらう
export function pickScienceBonus(game, playerIdx, res) {
  if (!game.pendingScienceBonus || !game.pendingScienceBonus.includes(playerIdx)) return false;
  if (!RESOURCES.includes(res) || game.bank.resources[res] <= 0) return false;
  game.bank.resources[res]--;
  game.players[playerIdx].resources[res]++;
  game.pendingScienceBonus = game.pendingScienceBonus.filter((i) => i !== playerIdx);
  if (!game.pendingScienceBonus.length && game.phase === 'scienceBonus') game.phase = 'main';
  fire(game, 'build');
  return true;
}

// 7のときに捨てる枚数のしきい値。都市と騎士の城壁は、持っているぶん+2枚ずつゆるくなる（最大3枚=+6）。
function discardThreshold(player) { return 7 + (player.walls || 0) * 2; }

export function rollDice(game, rng = Math.random) {
  if (game.phase !== 'roll') return null;
  const d1 = 1 + Math.floor(rng() * 6);
  const d2 = 1 + Math.floor(rng() * 6);
  const total = d1 + d2;
  game.diceLast = [d1, d2];
  const ck = !!game.bank.commodities;
  if (ck) resolveEventDie(game, d1, rng);
  fire(game, 'dice');
  log(game, `サイコロ: ${d1} + ${d2} = ${total}`);
  if (total === 7) {
    game.pendingDiscards = game.players
      .filter((p) => sumRes(p.resources) > discardThreshold(p))
      .map((p) => ({ player: game.players.indexOf(p), count: Math.floor(sumRes(p.resources) / 2) }));
    if (game.pendingDiscards.length) game.phase = 'discard';
    else game.phase = phaseAfterSeven(game); // 最初の蛮族襲来までは盗賊が動かない（都市と騎士）。蛮族の襲撃では盗賊の代わりに相手を選んで奪う
  } else {
    distributeResources(game, total);
    game.phase = game.pendingGoldPicks.length ? 'goldPick' : (game.pendingScienceBonus.length ? 'scienceBonus' : 'main');
  }
  return total;
}

export function discardCards(game, playerIdx, discardObj) {
  const pending = game.pendingDiscards.find((d) => d.player === playerIdx);
  if (!pending) return false;
  const total = sumRes(discardObj);
  if (total !== pending.count) return false;
  const p = game.players[playerIdx];
  if (!canAfford(p.resources, discardObj)) return false;
  payCost(p.resources, discardObj);
  RESOURCES.forEach((r) => { game.bank.resources[r] += discardObj[r] || 0; });
  game.pendingDiscards = game.pendingDiscards.filter((d) => d.player !== playerIdx);
  if (game.pendingDiscards.length === 0) game.phase = phaseAfterSeven(game);
  return true;
}
function phaseAfterSeven(game) {
  const ck = !!game.bank.commodities;
  if (ck && !game.barbarianAttacked) return 'main';
  if (game.scenario === 'barbarians') return 'barbarianSteal'; // 蛮族の襲撃には盗賊がいないので、相手を選んで1枚奪う
  return 'moveRobber';
}
// 蛮族の襲撃: 7が出たら、盗賊の代わりに相手を選んでランダムに1枚奪う（公式どおり）
export function barbarianStealTargets(game, playerIdx) {
  return game.players.map((_, i) => i).filter((i) => i !== playerIdx && sumRes(game.players[i].resources) > 0);
}
export function resolveBarbarianSteal(game, targetIdx) {
  if (game.phase !== 'barbarianSteal') return false;
  const idx = currentPlayer(game);
  const targets = barbarianStealTargets(game, idx);
  if (targets.length && !targets.includes(targetIdx)) return false;
  if (targets.length) stealFrom(game, targetIdx, idx);
  game.phase = 'main';
  fire(game, 'rob');
  return true;
}

export function robberTargets(game, hexId, playerIdx) {
  const hex = game.board.hexes[hexId];
  const owners = new Set();
  hex.vertexIds.forEach((vid) => {
    const b = game.board.vertices[vid].building;
    if (b && b.owner !== playerIdx) owners.add(b.owner);
  });
  return [...owners].filter((o) => sumRes(game.players[o].resources) > 0);
}
// 海賊（航海者版）: 隣の辺に自分以外の船がある人が対象
export function pirateTargets(game, hexId, playerIdx) {
  const hex = game.board.hexes[hexId];
  const owners = new Set();
  hex.edgeIds.forEach((eId) => {
    const e = game.board.edges[eId];
    if (e.ship != null && e.ship !== playerIdx) owners.add(e.ship);
  });
  return [...owners].filter((o) => sumRes(game.players[o].resources) > 0);
}
// マスが海なら海賊、陸なら盗賊の対象者を返す
export function banditTargets(game, hexId, playerIdx) {
  return game.board.hexes[hexId].terrain === 'water' ? pirateTargets(game, hexId, playerIdx) : robberTargets(game, hexId, playerIdx);
}
function stealFrom(game, fromIdx, toIdx) {
  const res = game.players[fromIdx].resources;
  const pool = RESOURCES.flatMap((r) => Array(res[r]).fill(r));
  if (!pool.length) return null;
  const picked = pool[Math.floor(Math.random() * pool.length)];
  res[picked]--;
  game.players[toIdx].resources[picked]++;
  return picked;
}
export function moveRobber(game, hexId, targetPlayerIdx) {
  if (game.phase !== 'moveRobber') return false;
  const idx = currentPlayer(game);
  const hex = game.board.hexes[hexId];
  if (hex.fog) return false; // 探検家と海賊: 霧のままの島には動かせない
  const isWater = hex.terrain === 'water';
  if (isWater && game.board.pirateHex == null) return false; // 航海者版でなければ海に動かせない
  const currentPos = isWater ? game.board.pirateHex : game.board.robberHex;
  if (hexId === currentPos) return false;
  const targets = isWater ? pirateTargets(game, hexId, idx) : robberTargets(game, hexId, idx);
  if (targets.length && !targets.includes(targetPlayerIdx)) return false;
  if (isWater) game.board.pirateHex = hexId; else game.board.robberHex = hexId;
  if (targets.length) {
    const res = stealFrom(game, targetPlayerIdx, idx);
    log(game, `${playerName(game, idx)}が${playerName(game, targetPlayerIdx)}から1枚奪った`);
    // 通信対戦: 何を奪ったかは、奪った人と奪われた人の画面にだけ出す（main.js の renderBanner）
    game.lastSteal = { from: targetPlayerIdx, to: idx, res };
  } else {
    game.lastSteal = null;
  }
  fire(game, 'rob');
  game.phase = 'main';
  return true;
}

// ---- 長い交易路（道と船の両方を数える） ----
function roadLengthForPlayer(game, playerIdx) {
  const edges = game.board.edges.filter((e) => e.road === playerIdx || e.ship === playerIdx);
  if (!edges.length) return 0;
  const byId = new Map(edges.map((e) => [e.id, e]));
  const kindOf = (e) => (e.road === playerIdx ? 'road' : 'ship');
  // 隊商: ラクダと同じ辺にある道は、最長交易路の数え方で2本ぶんになる（公式どおり）
  const camelEdges = game.scenario === 'caravans' ? new Set(game.board.caravans.flat()) : null;
  const weightOf = (eId) => (camelEdges && camelEdges.has(eId) ? 2 : 1);
  const adjacency = new Map();
  edges.forEach((e) => {
    [e.v1, e.v2].forEach((v) => { if (!adjacency.has(v)) adjacency.set(v, []); adjacency.get(v).push(e.id); });
  });
  const blocked = (vid) => {
    const b = game.board.vertices[vid].building;
    return b && b.owner !== playerIdx;
  };
  const ownBuilding = (vid) => {
    const b = game.board.vertices[vid].building;
    return b && b.owner === playerIdx;
  };
  const otherVertex = (edgeId, vid) => {
    const e = byId.get(edgeId);
    return e.v1 === vid ? e.v2 : e.v1;
  };
  function extend(vid, fromId, visited) {
    if (blocked(vid)) return 0;
    let best = 0;
    for (const eId of (adjacency.get(vid) || [])) {
      if (visited.has(eId)) continue;
      // 開拓地・都市をはさまない限り、道⇔船は乗り換えられない
      if (fromId != null && !ownBuilding(vid) && kindOf(byId.get(fromId)) !== kindOf(byId.get(eId))) continue;
      visited.add(eId);
      best = Math.max(best, weightOf(eId) + extend(otherVertex(eId, vid), eId, visited));
      visited.delete(eId);
    }
    return best;
  }
  let max = 0;
  edges.forEach((e) => {
    [e.v1, e.v2].forEach((startV) => {
      const visited = new Set([e.id]);
      const len = weightOf(e.id) + extend(otherVertex(e.id, startV), e.id, visited);
      max = Math.max(max, len);
    });
  });
  return max;
}
function assignBonus(game, lens, threshold, key) {
  const max = Math.max(...lens);
  if (max < threshold) { game[key] = null; return; }
  const holders = lens.map((l, i) => (l === max ? i : -1)).filter((i) => i >= 0);
  if (holders.length === 1) game[key] = holders[0];
  else if (game[key] != null && holders.includes(game[key])) { /* 保持者そのまま */ }
  else game[key] = null;
}
export function recalcLongestRoad(game) {
  const lens = game.players.map((_, i) => roadLengthForPlayer(game, i));
  game.players.forEach((p, i) => { p.roadLength = lens[i]; });
  assignBonus(game, lens, 5, 'longestRoadPlayer');
  checkWinAll(game); // 最長交易路が本人以外に移ったときも、その人の勝利判定をする
}
function recalcLargestArmy(game) {
  const counts = game.players.map((p) => p.knightsPlayed);
  assignBonus(game, counts, 3, 'largestArmyPlayer');
}

// ---- 建設 ----
function canBuildNow(game) { return game.phase === 'main' || game.phase === 'specialBuilding'; }
// 川: 川をまたぐ辺に道を通すには、ふつうの道でなく橋（土2木1）が要る
export function roadCostFor(game, edgeId) { return (game.board.riverEdgeIds && game.board.riverEdgeIds.includes(edgeId)) ? BRIDGE_COST : COSTS.road; }

export function buildRoad(game, edgeId, { free } = {}) {
  if (!free && !canBuildNow(game)) return false; // free はテスト用の道の直置き（長い交易路の検証など）。本来のフェイズ縛りは受けない
  const idx = currentPlayer(game);
  const p = game.players[idx];
  if (p.roads.length >= MAX_ROADS) return false;
  const isBridge = game.board.riverEdgeIds && game.board.riverEdgeIds.includes(edgeId);
  if (isBridge && (p.bridges || 0) >= MAX_BRIDGES) return false; // 橋は3本まで（公式どおり）
  if (!canPlaceRoad(game, edgeId, idx)) return false;
  const cost = roadCostFor(game, edgeId);
  if (!free) { if (!canAfford(p.resources, cost)) return false; payCost(p.resources, cost); RESOURCES.forEach((r) => { game.bank.resources[r] += cost[r] || 0; }); }
  game.board.edges[edgeId].road = idx;
  p.roads.push(edgeId);
  if (isBridge) { p.bridges = (p.bridges || 0) + 1; p.gold = (p.gold || 0) + BRIDGE_GOLD; recalcGoldRoles(game); } // 橋を架けると金貨3枚
  else grantRiverGold(game, idx, edgeId, 'edge');
  fire(game, 'build');
  recalcLongestRoad(game);
  checkWin(game, idx);
  return true;
}
export function buildSettlement(game, vertexId) {
  const idx = currentPlayer(game);
  const p = game.players[idx];
  const isSetup = game.phase === 'setup1' || game.phase === 'setup2';
  if (isSetup) return setupPlaceSettlement(game, vertexId);
  if (!canBuildNow(game)) return false;
  if (p.settlements.length >= MAX_SETTLEMENTS) return false;
  if (!canPlaceSettlement(game, vertexId, idx, false)) return false;
  if (!canAfford(p.resources, COSTS.settlement)) return false;
  payCost(p.resources, COSTS.settlement);
  RESOURCES.forEach((r) => { game.bank.resources[r] += COSTS.settlement[r] || 0; });
  game.board.vertices[vertexId].building = { owner: idx, type: 'settlement' };
  p.settlements.push(vertexId);
  markIslandBonus(game, idx, vertexId);
  grantRiverGold(game, idx, vertexId, 'vertex');
  grantSoccerShot(game, idx, vertexId);
  queueCamelBuild(game);
  fire(game, 'build');
  recalcLongestRoad(game); // 相手の道を分断することがある
  // サッカー熱: この手番の終わりに試合が入り、順位の勝利点が動くことがあるので、判定は手番の終わりに回す（公式の「手番の終わりに判定」どおり）
  if (game.soccer && !game.soccerSeasonOver) game.pendingSoccerMatch = true; else checkWin(game, idx);
  if (game.scenario === 'barbarians') resolveBarbarianLanding(game, idx);
  return true;
}
export function buildCity(game, vertexId) {
  if (!canBuildNow(game)) return false;
  const idx = currentPlayer(game);
  const p = game.players[idx];
  const v = game.board.vertices[vertexId];
  if (!v.building || v.building.owner !== idx || v.building.type !== 'settlement') return false;
  if (p.cities.length >= MAX_CITIES) return false;
  if (!canAfford(p.resources, COSTS.city)) return false;
  payCost(p.resources, COSTS.city);
  RESOURCES.forEach((r) => { game.bank.resources[r] += COSTS.city[r] || 0; });
  v.building = { owner: idx, type: 'city' };
  p.settlements = p.settlements.filter((id) => id !== vertexId);
  p.cities.push(vertexId);
  grantSoccerShot(game, idx, vertexId);
  queueCamelBuild(game);
  fire(game, 'build');
  if (game.soccer && !game.soccerSeasonOver) game.pendingSoccerMatch = true; else checkWin(game, idx);
  if (game.scenario === 'barbarians') resolveBarbarianLanding(game, idx);
  return true;
}

export function buyDevCard(game) {
  if (!canBuildNow(game)) return false;
  const idx = currentPlayer(game);
  const p = game.players[idx];
  if (!game.bank.devDeck.length) return false;
  if (!canAfford(p.resources, COSTS.dev)) return false;
  payCost(p.resources, COSTS.dev);
  RESOURCES.forEach((r) => { game.bank.resources[r] += COSTS.dev[r] || 0; });
  const type = game.bank.devDeck.pop();
  p.devCards.push({ type, boughtTurn: game.turnNumber, played: false });
  fire(game, 'buy-dev');
  checkWin(game, idx); // 勝利点カードで10点に届くことがある
  return true;
}

function canPlayDev(game, playerIdx, cardIdx) {
  if (game.phase !== 'main') return false; // 特別建設フェイズでは発展カードを使えない
  if (game.devCardPlayedThisTurn) return false;
  const p = game.players[playerIdx];
  const card = p.devCards[cardIdx];
  if (!card || card.played || card.type === 'vp') return false;
  return card.boughtTurn !== game.turnNumber;
}
function consumeDev(game, playerIdx, cardIdx) {
  game.players[playerIdx].devCards[cardIdx].played = true;
  game.devCardPlayedThisTurn = true;
}

export function playKnight(game, cardIdx, hexId, targetPlayerIdx) {
  const idx = currentPlayer(game);
  if (!canPlayDev(game, idx, cardIdx)) return false;
  const hex = game.board.hexes[hexId];
  if (hex.fog) return false; // 探検家と海賊: 霧のままの島には動かせない
  const isWater = hex.terrain === 'water';
  if (isWater && game.board.pirateHex == null) return false;
  const currentPos = isWater ? game.board.pirateHex : game.board.robberHex;
  if (hexId === currentPos) return false;
  const targets = isWater ? pirateTargets(game, hexId, idx) : robberTargets(game, hexId, idx);
  if (targets.length && !targets.includes(targetPlayerIdx)) return false;
  consumeDev(game, idx, cardIdx);
  if (isWater) game.board.pirateHex = hexId; else game.board.robberHex = hexId;
  if (targets.length) stealFrom(game, targetPlayerIdx, idx);
  game.players[idx].knightsPlayed++;
  fire(game, 'rob');
  recalcLargestArmy(game);
  checkWin(game, idx);
  return true;
}
// items: 道なら辺IDのまま、船なら { id, kind: 'ship' } で渡す（航海者版: 道・船どちらでも2本）
export function playRoadBuilding(game, cardIdx, items) {
  const idx = currentPlayer(game);
  if (!canPlayDev(game, idx, cardIdx)) return false;
  consumeDev(game, idx, cardIdx);
  items.slice(0, 2).forEach((it) => {
    const id = typeof it === 'object' ? it.id : it;
    const wantShip = typeof it === 'object' && it.kind === 'ship';
    if (wantShip) {
      if (canPlaceShip(game, id, idx) && game.players[idx].ships.length < MAX_SHIPS) {
        const e = game.board.edges[id]; e.ship = idx; e.shipPlacedTurn = game.turnNumber; game.players[idx].ships.push(id);
      }
    } else if (!(game.board.riverEdgeIds && game.board.riverEdgeIds.includes(id)) // 川: 発展カード「街道建設」で橋は作れない（公式どおり）
      && canPlaceRoad(game, id, idx) && game.players[idx].roads.length < MAX_ROADS) {
      game.board.edges[id].road = idx; game.players[idx].roads.push(id);
      grantRiverGold(game, idx, id, 'edge');
    }
  });
  fire(game, 'build');
  recalcLongestRoad(game);
  checkWin(game, idx);
  return true;
}
export function playYearOfPlenty(game, cardIdx, res1, res2) {
  const idx = currentPlayer(game);
  if (!canPlayDev(game, idx, cardIdx)) return false;
  consumeDev(game, idx, cardIdx);
  [res1, res2].forEach((r) => { if (game.bank.resources[r] > 0) { game.bank.resources[r]--; game.players[idx].resources[r]++; } });
  fire(game, 'build');
  return true;
}
export function playMonopoly(game, cardIdx, res) {
  const idx = currentPlayer(game);
  if (!canPlayDev(game, idx, cardIdx)) return false;
  consumeDev(game, idx, cardIdx);
  game.players.forEach((p, i) => {
    if (i === idx) return;
    const amt = p.resources[res];
    p.resources[res] = 0;
    game.players[idx].resources[res] += amt;
  });
  fire(game, 'build');
  return true;
}

// ---- 交易 ----
export function playerPortRate(game, playerIdx, res) {
  const ports = new Set();
  const p = game.players[playerIdx];
  [...p.settlements, ...p.cities].forEach((vid) => { const port = game.board.vertices[vid].port; if (port) ports.add(port); });
  if (ports.has(res)) return 2;
  if (ports.has('3:1')) return 3;
  return 4;
}
export function bankTrade(game, giveRes, wantRes) {
  if (game.phase !== 'main') return false; // 特別建設フェイズでは交易できない
  const idx = currentPlayer(game);
  const p = game.players[idx];
  const rate = playerPortRate(game, idx, giveRes);
  if ((p.resources[giveRes] || 0) < rate) return false;
  if (game.bank.resources[wantRes] <= 0) return false;
  p.resources[giveRes] -= rate;
  game.bank.resources[giveRes] += rate;
  p.resources[wantRes]++;
  game.bank.resources[wantRes]--;
  fire(game, 'trade');
  return true;
}
// ---- 都市と騎士(交易3段階目): 商品2枚で、銀行から好きな資源か商品を1枚もらう ----
export function canTradeCommodity(game, playerIdx, giveCommodity) {
  if (game.phase !== 'main') return false;
  const p = game.players[playerIdx];
  if (!p.cityImprovements || p.cityImprovements.trade < 3) return false;
  if (!COMMODITIES.includes(giveCommodity)) return false;
  return (p.commodities[giveCommodity] || 0) >= 2;
}
export function tradeCommodity(game, giveCommodity, wantKind, wantKey) {
  const idx = currentPlayer(game);
  if (!canTradeCommodity(game, idx, giveCommodity)) return false;
  const p = game.players[idx];
  if (wantKind === 'resource') {
    if (!RESOURCES.includes(wantKey) || game.bank.resources[wantKey] <= 0) return false;
    p.commodities[giveCommodity] -= 2; game.bank.commodities[giveCommodity] += 2;
    p.resources[wantKey]++; game.bank.resources[wantKey]--;
  } else if (wantKind === 'commodity') {
    if (!COMMODITIES.includes(wantKey) || game.bank.commodities[wantKey] <= 0) return false;
    p.commodities[giveCommodity] -= 2; game.bank.commodities[giveCommodity] += 2;
    p.commodities[wantKey]++; game.bank.commodities[wantKey]--;
  } else return false;
  fire(game, 'trade');
  return true;
}
export function playerTrade(game, otherIdx, give, get) {
  if (game.phase !== 'main') return false; // 特別建設フェイズでは交易できない
  const idx = currentPlayer(game);
  if (idx === otherIdx) return false;
  const a = game.players[idx], b = game.players[otherIdx];
  if (!canAfford(a.resources, give) || !canAfford(b.resources, get)) return false;
  payCost(a.resources, give); payCost(b.resources, get);
  Object.entries(give).forEach(([r, n]) => { b.resources[r] += n; });
  Object.entries(get).forEach(([r, n]) => { a.resources[r] += n; });
  fire(game, 'trade');
  return true;
}

// ================================================================
// 交易と略奪: 漁師
// ================================================================
// 山（fishBag）から1枚引く。尽きたら使用済み（fishUsed）を混ぜ直す（公式どおり）。古い靴は山に戻らない。
function drawFishToken(game) {
  if (!game.fishBag.length) {
    if (!game.fishUsed.length) return null;
    game.fishBag = shuffle(game.fishUsed, Math.random);
    game.fishUsed = [];
  }
  return game.fishBag.pop();
}
function grantFishToken(game, idx) {
  const token = drawFishToken(game);
  if (token == null) return;
  if (token === 'boot') {
    if (game.oldBootHolder == null) { game.oldBootHolder = idx; log(game, `${playerName(game, idx)}が古い靴を引いた`); }
    checkWinAll(game);
    return;
  }
  const p = game.players[idx];
  if (p.fishTokens.length >= FISH_HAND_LIMIT) {
    // 7匹の上限: 一番少ない手持ちより多ければ入れ替える（公式どおり。それ以外はそのまま山へ戻す）
    let worst = 0;
    p.fishTokens.forEach((v, i) => { if (v < p.fishTokens[worst]) worst = i; });
    if (token > p.fishTokens[worst]) { game.fishUsed.push(p.fishTokens[worst]); p.fishTokens[worst] = token; } else game.fishUsed.push(token);
    return;
  }
  p.fishTokens.push(token);
}
// 持っている魚トークンから、合計がcost以上になる組を無駄が一番少なくなるように選ぶ（総当たり。最大7枚なので軽い）
function selectFishTokens(tokens, cost) {
  const n = tokens.length;
  let best = null;
  for (let mask = 1; mask < (1 << n); mask++) {
    let sum = 0; const idxs = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) { sum += tokens[i]; idxs.push(i); }
    if (sum >= cost && (!best || sum < best.sum)) best = { sum, idxs };
  }
  return best ? best.idxs : null;
}
function spendFish(game, idx, cost) {
  const p = game.players[idx];
  const idxs = selectFishTokens(p.fishTokens, cost);
  if (!idxs) return false;
  idxs.slice().sort((a, b) => b - a).forEach((i) => { game.fishUsed.push(p.fishTokens[i]); p.fishTokens.splice(i, 1); });
  return true;
}
export function canUseFishTrade(game, playerIdx, kind) {
  if (game.scenario !== 'fishermen' || !canBuildNow(game)) return false;
  const cost = FISH_TRADE_COST[kind];
  return cost != null && selectFishTokens(game.players[playerIdx].fishTokens, cost) != null;
}
export function fishRobberAway(game) { // 魚2匹: 盗賊を盤外へ（次に誰かが動かすまで、どのマスも塞がない）
  const idx = currentPlayer(game);
  if (!canUseFishTrade(game, idx, 'robberAway') || !spendFish(game, idx, FISH_TRADE_COST.robberAway)) return false;
  game.board.robberHex = null;
  fire(game, 'build');
  return true;
}
export function fishSteal(game, targetIdx) { // 魚3匹: 誰かから資源1枚（ランダム）
  const idx = currentPlayer(game);
  if (idx === targetIdx || !canUseFishTrade(game, idx, 'steal') || !spendFish(game, idx, FISH_TRADE_COST.steal)) return false;
  stealFrom(game, targetIdx, idx);
  fire(game, 'rob');
  return true;
}
export function fishResource(game, res) { // 魚4匹: 銀行から好きな資源1枚
  const idx = currentPlayer(game);
  if (!canUseFishTrade(game, idx, 'resource') || !RESOURCES.includes(res) || game.bank.resources[res] <= 0) return false;
  if (!spendFish(game, idx, FISH_TRADE_COST.resource)) return false;
  game.bank.resources[res]--; game.players[idx].resources[res]++;
  fire(game, 'build');
  return true;
}
export function fishRoad(game, edgeId) { // 魚5匹: 道を1本只で（置ける場所は自分で選ぶ）
  const idx = currentPlayer(game);
  const p = game.players[idx];
  if (!canUseFishTrade(game, idx, 'road') || p.roads.length >= MAX_ROADS || !canPlaceRoad(game, edgeId, idx)) return false;
  if (!spendFish(game, idx, FISH_TRADE_COST.road)) return false;
  game.board.edges[edgeId].road = idx;
  p.roads.push(edgeId);
  fire(game, 'build'); recalcLongestRoad(game); checkWin(game, idx);
  return true;
}
export function fishDevCard(game) { // 魚7匹: 発展カードを1枚只で
  const idx = currentPlayer(game);
  const p = game.players[idx];
  if (!canUseFishTrade(game, idx, 'devcard') || !game.bank.devDeck.length) return false;
  if (!spendFish(game, idx, FISH_TRADE_COST.devcard)) return false;
  const type = game.bank.devDeck.pop();
  p.devCards.push({ type, boughtTurn: game.turnNumber, played: false });
  fire(game, 'buy-dev'); checkWin(game, idx);
  return true;
}
// 古い靴は、サイコロを振った後の自分の手番に、自分と同じか自分より点が多い人へ渡せる。
// 自分だけが最多点のときは手放せない（公式どおり）。
export function canGiveOldBoot(game, targetIdx) {
  const idx = currentPlayer(game);
  if (game.scenario !== 'fishermen' || game.oldBootHolder !== idx || targetIdx === idx || game.phase !== 'main') return false;
  const scores = game.players.map((_, i) => playerScore(game, i));
  const max = Math.max(...scores);
  const aloneMax = scores[idx] === max && scores.filter((s) => s === max).length === 1;
  if (aloneMax) return false;
  return scores[targetIdx] >= scores[idx];
}
export function giveOldBoot(game, targetIdx) {
  if (!canGiveOldBoot(game, targetIdx)) return false;
  game.oldBootHolder = targetIdx;
  fire(game, 'build'); checkWinAll(game);
  return true;
}

// ================================================================
// 交易と略奪: 川
// ================================================================
// 川沿いに道・開拓地を建てるたびに金貨1枚（都市への建て替えでは増えない。橋は建てると3枚）
function grantRiverGold(game, idx, vertexOrEdge, kind) {
  if (game.scenario !== 'rivers') return;
  const board = game.board;
  let touches;
  if (kind === 'vertex') touches = board.riverVertexIds.includes(vertexOrEdge);
  else {
    const e = board.edges[vertexOrEdge];
    touches = board.riverEdgeIds.includes(vertexOrEdge) || board.riverVertexIds.includes(e.v1) || board.riverVertexIds.includes(e.v2);
  }
  if (!touches) return;
  game.players[idx].gold = (game.players[idx].gold || 0) + 1;
  recalcGoldRoles(game);
}
export function canTradeGold(game, playerIdx) { return game.scenario === 'rivers' && (game.players[playerIdx].goldSpendsThisTurn || 0) < GOLD_SPENDS_PER_TURN; }
export function tradeGold(game, res) { // 川: 金貨2枚で資源1枚。手番に2回まで
  const idx = currentPlayer(game);
  const p = game.players[idx];
  if (!canBuildNow(game) || !canTradeGold(game, idx) || (p.gold || 0) < 2 || !RESOURCES.includes(res) || game.bank.resources[res] <= 0) return false;
  p.gold -= 2; game.bank.resources[res]--; p.resources[res]++;
  p.goldSpendsThisTurn = (p.goldSpendsThisTurn || 0) + 1;
  fire(game, 'trade'); recalcGoldRoles(game);
  return true;
}
// 川: 銀行との海上交易で、資源を金貨に替える（2:1の港があっても金貨には使えない。公式どおり）
export function goldBankRate(game, playerIdx) {
  const ports = new Set([...game.players[playerIdx].settlements, ...game.players[playerIdx].cities].map((v) => game.board.vertices[v].port));
  return ports.has('3:1') ? 3 : 4;
}
export function tradeResourceForGold(game, giveRes) {
  const idx = currentPlayer(game);
  const p = game.players[idx];
  if (game.scenario !== 'rivers' || !canBuildNow(game)) return false;
  const rate = goldBankRate(game, idx);
  if ((p.resources[giveRes] || 0) < rate) return false;
  p.resources[giveRes] -= rate; game.bank.resources[giveRes] += rate;
  p.gold = (p.gold || 0) + 1;
  fire(game, 'trade'); recalcGoldRoles(game);
  return true;
}

// ================================================================
// 交易と略奪: 隊商
// ================================================================
function allCamelEdges(board) { return board.caravans.flat(); }
function caravanVertexBonus(game, idx) {
  const camelEdges = new Set(allCamelEdges(game.board));
  if (!camelEdges.size) return 0;
  const p = game.players[idx];
  let bonus = 0;
  [...p.settlements, ...p.cities].forEach((vid) => {
    const touching = game.board.vertices[vid].edgeIds.filter((eId) => camelEdges.has(eId)).length;
    if (touching >= 2) bonus += 1;
  });
  return bonus;
}
// 開拓地を建てる・都市に建て替えるたびに「手番の終わりにラクダを1つ置く」権利が積まれる（公式どおり）
function queueCamelBuild(game) { if (game.scenario === 'caravans') game.players[currentPlayer(game)].pendingCamelBuilds++; }
// ラクダを置ける辺（各キャラバンの先頭の「前」に伸ばす辺。空いている出発点があれば、そこから新しいキャラバンも始められる）
export function camelPlacementOptions(game) {
  const board = game.board;
  const options = new Set();
  board.camelStartEdges.forEach((eId, i) => { if (!board.caravans[i].length && board.edges[eId].road == null && board.edges[eId].ship == null) options.add(eId); });
  board.caravans.forEach((chain) => {
    if (!chain.length) return;
    const lastId = chain[chain.length - 1];
    const last = board.edges[lastId];
    const prevId = chain.length > 1 ? chain[chain.length - 2] : null;
    const frontVertex = prevId != null ? ([last.v1, last.v2].find((v) => v !== board.edges[prevId].v1 && v !== board.edges[prevId].v2) ?? last.v2) : last.v2;
    game.board.vertices[frontVertex].edgeIds.forEach((eId) => {
      if (eId === lastId) return;
      if (allCamelEdges(board).includes(eId)) return; // 他のラクダと重ねない
      options.add(eId);
    });
  });
  return [...options];
}
function startCamelVote(game) {
  const order = Array.from({ length: game.playerCount }, (_, i) => (game.turn + i) % game.playerCount);
  game.pendingCamelVote = { order, idx: 0, bids: {} };
  game.phase = 'camelVote';
}
export function submitCamelBid(game, playerIdx, give = {}) {
  const pv = game.pendingCamelVote;
  if (!pv || pv.order[pv.idx] !== playerIdx) return false;
  const p = game.players[playerIdx];
  const wheat = give.wheat || 0, sheep = give.sheep || 0;
  if ((p.resources.wheat || 0) < wheat || (p.resources.sheep || 0) < sheep) return false;
  p.resources.wheat -= wheat; p.resources.sheep -= sheep;
  game.bank.resources.wheat += wheat; game.bank.resources.sheep += sheep;
  pv.bids[playerIdx] = wheat + sheep;
  pv.idx++;
  if (pv.idx >= pv.order.length) {
    // 一番多く出した人が決める。同点・0票なら、直前に手番を終えた人が決める（簡略化。本来は合議もできる。README に注記）
    let decider = pv.order[0], max = -1, tie = false;
    pv.order.forEach((pid) => { const v = pv.bids[pid] || 0; if (v > max) { max = v; decider = pid; tie = false; } else if (v === max) tie = true; });
    if (tie || max <= 0) decider = pv.order[0];
    game.pendingCamelVote = null;
    game.phase = 'camelPlace';
    game.camelDecider = decider;
  }
  fire(game, 'trade');
  return true;
}
export function placeCamel(game, edgeId) {
  if (game.phase !== 'camelPlace' || !camelPlacementOptions(game).includes(edgeId)) return false;
  const board = game.board;
  let placed = false;
  board.camelStartEdges.forEach((startEId, i) => { if (!placed && !board.caravans[i].length && startEId === edgeId) { board.caravans[i].push(edgeId); placed = true; } });
  if (!placed) {
    const chain = board.caravans.find((c) => {
      if (!c.length) return false;
      const lastId = c[c.length - 1];
      const last = board.edges[lastId];
      const prevId = c.length > 1 ? c[c.length - 2] : null;
      const frontVertex = prevId != null ? ([last.v1, last.v2].find((v) => v !== board.edges[prevId].v1 && v !== board.edges[prevId].v2) ?? last.v2) : last.v2;
      return board.vertices[frontVertex].edgeIds.includes(edgeId);
    });
    if (chain) { chain.push(edgeId); placed = true; }
  }
  game.camelDecider = null;
  game.phase = 'main';
  const idx = currentPlayer(game);
  const p = game.players[idx];
  if (p.pendingCamelBuilds > 0) p.pendingCamelBuilds--;
  fire(game, 'build'); recalcLongestRoad(game); checkWinAll(game);
  resumeCamelOrTurn(game);
  return true;
}
// 手番の終わりに、建てた分だけラクダの投票→配置を済ませてから、やっと次の手番に進む
function resumeCamelOrTurn(game) {
  const idx = game.turn;
  const p = game.players[idx];
  if (p.pendingCamelBuilds > 0 && camelPlacementOptions(game).length) { startCamelVote(game); return; }
  p.pendingCamelBuilds = 0; // 置ける場所がもうなければあきらめる
  finishAdvanceTurn(game);
}

// ================================================================
// 交易と略奪: 蛮族の襲撃
// 専用盤（砂漠+砦+沿岸の輪）・新しい発展カード60枚・捕虜の取り合いなどは作らず、
// 基本の19マスに砦を足し、騎士は発展カードでなく直接建てる簡略版にしている（README に注記）。
// ================================================================
export const WAR_KNIGHT_COST = { sheep: 1, ore: 1 };
export const WAR_KNIGHT_MOVE_STEPS = 3; // 麦1枚払うと5歩まで（払うかどうかは moveWarKnight の extend 引数で決める）
const WAR_KNIGHT_MOVE_STEPS_EXTENDED = 5;

export function canBuildWarKnight(game, playerIdx, edgeId) {
  if (game.scenario !== 'barbarians' || !canBuildNow(game)) return false;
  const p = game.players[playerIdx];
  if (!canAfford(p.resources, WAR_KNIGHT_COST)) return false;
  const castle = game.board.hexes[game.board.castleHexId];
  if (!castle.edgeIds.includes(edgeId)) return false;
  return !game.players.some((pl) => (pl.warKnights || []).some((k) => k.edgeId === edgeId));
}
export function availableWarKnightEdges(game, playerIdx) {
  return game.board.hexes[game.board.castleHexId].edgeIds.filter((eId) => canBuildWarKnight(game, playerIdx, eId));
}
export function buildWarKnight(game, edgeId) {
  const idx = currentPlayer(game);
  const p = game.players[idx];
  if (!canBuildWarKnight(game, idx, edgeId)) return false;
  payCost(p.resources, WAR_KNIGHT_COST);
  RESOURCES.forEach((r) => { game.bank.resources[r] += WAR_KNIGHT_COST[r] || 0; });
  p.warKnights.push({ id: (p.warKnights.length ? Math.max(...p.warKnights.map((k) => k.id)) + 1 : 1), edgeId, movedTurn: null });
  fire(game, 'build');
  return true;
}
function edgeAdjacency(board) {
  const adj = new Map();
  board.edges.forEach((e) => { [e.v1, e.v2].forEach((v) => { if (!adj.has(v)) adj.set(v, []); adj.get(v).push(e.id); }); });
  return (eId) => {
    const e = board.edges[eId];
    const out = new Set();
    [e.v1, e.v2].forEach((v) => (adj.get(v) || []).forEach((o) => { if (o !== eId) out.add(o); }));
    return [...out];
  };
}
// 騎士は道・建物・他の騎士を無視して移動できる（公式どおり）。終点だけ、他の騎士がいない辺でなければならない。
export function movableWarKnightEdges(game, playerIdx, knightId, paidGrain) {
  const p = game.players[playerIdx];
  const k = (p.warKnights || []).find((x) => x.id === knightId);
  if (!k || game.scenario !== 'barbarians' || !canBuildNow(game) || k.movedTurn === game.turnNumber) return []; // 1手番に1回だけ（公式どおり）
  const neighborsOf = edgeAdjacency(game.board);
  const maxSteps = paidGrain ? WAR_KNIGHT_MOVE_STEPS_EXTENDED : WAR_KNIGHT_MOVE_STEPS;
  const occupied = new Set(game.players.flatMap((pl) => (pl.warKnights || []).map((x) => x.edgeId)));
  const seen = new Set([k.edgeId]);
  let frontier = [k.edgeId];
  const reach = [];
  for (let step = 0; step < maxSteps; step++) {
    const next = [];
    frontier.forEach((eId) => neighborsOf(eId).forEach((n) => {
      if (seen.has(n)) return;
      seen.add(n); next.push(n);
      if (!occupied.has(n)) reach.push(n);
    }));
    frontier = next;
  }
  return reach;
}
export function moveWarKnight(game, knightId, toEdgeId, paidGrain) {
  const idx = currentPlayer(game);
  const p = game.players[idx];
  if (paidGrain) { if ((p.resources.wheat || 0) < 1) return false; }
  if (!movableWarKnightEdges(game, idx, knightId, paidGrain).includes(toEdgeId)) return false;
  if (paidGrain) { p.resources.wheat--; game.bank.resources.wheat++; }
  const k = p.warKnights.find((x) => x.id === knightId);
  k.edgeId = toEdgeId;
  k.movedTurn = game.turnNumber;
  fire(game, 'build');
  return true;
}
// 開拓地・都市を建てるたびに「蛮族の上陸」。7でない出目を3回まで引き、重複しない出目で沿岸マスに蛮族を置く（公式どおり）
function resolveBarbarianLanding(game, playerIdx) {
  if (game.board.barbarianSupply <= 0) return; // 供給が尽きたら、もう上陸しない（公式どおり）
  const targets = barbarianTargetHexes(game.board);
  const used = new Set();
  for (let i = 0; i < 3 && game.board.barbarianSupply > 0; i++) {
    let roll;
    let guard = 0;
    do { roll = 1 + Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6); guard++; } while ((roll === 7 || used.has(roll)) && guard < 200);
    used.add(roll);
    const hex = targets.find((h) => h.number === roll && !h.conquered);
    if (!hex) continue; // 出目に合うマスがない・もう征服済みなら、その回は置かない（公式どおり）
    if (hex.barbarians >= 3) continue;
    hex.barbarians++;
    game.board.barbarianSupply--;
    if (hex.barbarians >= 3) conquerHex(game, hex);
  }
  log(game, `${playerName(game, playerIdx)}が建てたので、蛮族が上陸した`);
}
function conquerHex(game, hex) {
  hex.conquered = true;
  hex.vertexIds.forEach((vid) => {
    const v = game.board.vertices[vid];
    if (!v.building) return;
    // 隣に征服されていないマス（砦・砂漠も含む）がなければ、建物も征服される（公式どおり）
    const hasFreeHex = v.hexIds.some((h) => !game.board.hexes[h].conquered);
    if (!hasFreeHex) v.building.conquered = true;
  });
  log(game, '蛮族が沿岸のマスを征服した');
}
// 手番の終わり: 砦の6辺に接するマスごとに、騎士の数 > 蛮族の数なら勝利（蛮族を取り除き、捕虜を配る）
function resolveBarbarianExpel(game, actingIdx) {
  const board = game.board;
  const castle = board.hexes[board.castleHexId];
  barbarianTargetHexes(board).forEach((hex) => {
    if (hex.barbarians <= 0) return;
    const pathIds = hex.edgeIds;
    const involved = {}; // playerIdx -> 騎士の数
    game.players.forEach((p, pi) => (p.warKnights || []).forEach((k) => { if (pathIds.includes(k.edgeId)) involved[pi] = (involved[pi] || 0) + 1; }));
    const knightTotal = Object.values(involved).reduce((a, b) => a + b, 0);
    if (knightTotal <= hex.barbarians) return; // 勝てない
    const prisoners = hex.barbarians;
    hex.barbarians = 0;
    if (hex.conquered) {
      hex.conquered = false;
      hex.vertexIds.forEach((vid) => { const v = board.vertices[vid]; if (v.building) v.building.conquered = false; });
      log(game, '蛮族を退け、征服されたマスが元どおりになった');
    } else {
      log(game, '蛮族を退けた');
    }
    distributePrisoners(game, involved, prisoners);
    // 勝った騎士のうち1体は、公式の「向き合わせ」の代わりに無作為に1体を外へ戻す（簡略化。README に注記）
    const involvedIdxs = Object.keys(involved).map(Number);
    if (involvedIdxs.length) {
      const loserIdx = involvedIdxs[Math.floor(Math.random() * involvedIdxs.length)];
      const lp = game.players[loserIdx];
      const onHex = lp.warKnights.filter((k) => pathIds.includes(k.edgeId));
      if (onHex.length) {
        const removed = onHex[Math.floor(Math.random() * onHex.length)];
        lp.warKnights = lp.warKnights.filter((k) => k.id !== removed.id);
        lp.gold = (lp.gold || 0) + 3;
      }
    }
  });
}
function distributePrisoners(game, involved, count) {
  const idxs = Object.keys(involved).map(Number);
  if (!idxs.length) return;
  if (idxs.length === 1) { game.players[idxs[0]].prisoners += count; checkWin(game, idxs[0]); return; }
  for (let i = 0; i < count; i++) {
    // involved の知っている騎士数が多い人を優先し、同数ならランダムに1人へ（公式のサイコロ勝負の簡略化。README に注記）
    const maxKnights = Math.max(...idxs.map((pi) => involved[pi]));
    const candidates = idxs.filter((pi) => involved[pi] === maxKnights);
    const winner = candidates[Math.floor(Math.random() * candidates.length)];
    game.players[winner].prisoners++;
  }
  idxs.forEach((pi) => checkWin(game, pi));
}

// ================================================================
// 都市と騎士
// ================================================================
export const MAX_CITY_WALLS = MAX_WALLS;

function vertexHasAnyKnight(game, vertexId) {
  return game.players.some((p) => (p.knights || []).some((k) => k.vertexId === vertexId));
}
function knightActionAvailable(game, k) { return k.active && k.actedTurn !== game.turnNumber; }
function nextKnightId(p) { return p.knights.length ? Math.max(...p.knights.map((k) => k.id)) + 1 : 1; }
function knightCountAtLevel(p, level) { return p.knights.filter((k) => k.level === level).length; }

// ---- 都市の発展（交易・政治・科学の3系統×5段階） ----
// 大都市は特定の1都市に置く（どの都市かは、その系統の資源を産む地形に接する都市を優先し、なければ先頭の都市にする）
const TRACK_TERRAIN = { trade: 'pasture', politics: 'mountains', science: 'forest' };
function pickMetropolisCity(game, idx, track) {
  const p = game.players[idx];
  const terrain = TRACK_TERRAIN[track];
  const preferred = p.cities.find((vid) => game.board.vertices[vid].hexIds.some((h) => game.board.hexes[h].terrain === terrain));
  return preferred != null ? preferred : p.cities[0];
}
export function metropolisOwner(game, track) {
  const vid = game.metropolis && game.metropolis[track];
  if (vid == null) return null;
  const v = game.board.vertices[vid];
  return v.building ? v.building.owner : null;
}
export function cityImprovementCost(nextLevel) { return nextLevel; } // 段階nへ上げるコストは、その系統の商品n枚
export function canImproveCity(game, playerIdx, track) {
  if (!canBuildNow(game)) return false;
  const p = game.players[playerIdx];
  if (!p.cityImprovements || !p.cities.length) return false; // 都市が1つ以上ないと発展できない
  const level = p.cityImprovements[track];
  if (level >= MAX_CITY_LEVEL) return false;
  return (p.commodities[TRACK_COMMODITY[track]] || 0) >= cityImprovementCost(level + 1);
}
export function improveCity(game, track) {
  const idx = currentPlayer(game);
  if (!canImproveCity(game, idx, track)) return false;
  const p = game.players[idx];
  const com = TRACK_COMMODITY[track];
  const cost = cityImprovementCost(p.cityImprovements[track] + 1);
  p.commodities[com] -= cost;
  game.bank.commodities[com] += cost;
  p.cityImprovements[track]++;
  fire(game, 'build');
  log(game, `${playerName(game, idx)}が${TRACK_LABEL[track]}を${p.cityImprovements[track]}段階にした`);
  if (p.cityImprovements[track] >= 4) {
    const holderVertex = game.metropolis[track];
    const holderIdx = holderVertex != null ? game.board.vertices[holderVertex].building?.owner : null;
    if (holderVertex == null) {
      game.metropolis[track] = pickMetropolisCity(game, idx, track);
      log(game, `${playerName(game, idx)}が${TRACK_LABEL[track]}の大都市を得た`);
    } else if (holderIdx !== idx && game.players[holderIdx].cityImprovements[track] < 5 && p.cityImprovements[track] > game.players[holderIdx].cityImprovements[track]) {
      game.metropolis[track] = pickMetropolisCity(game, idx, track); // 持ち主が5段階目に届いていなければ、上回った人が奪える（5段階目なら奪われない）。印だけ移り、元の都市はただの都市に戻る
      log(game, `${playerName(game, idx)}が${TRACK_LABEL[track]}の大都市を奪った`);
    }
  }
  checkWin(game, idx);
  return true;
}

// ---- 都市壁 ----
export function canBuildWall(game, playerIdx) {
  if (!canBuildNow(game)) return false;
  const p = game.players[playerIdx];
  if (!p.cityImprovements) return false;
  if (p.walls >= MAX_WALLS || p.walls >= p.cities.length) return false;
  return canAfford(p.resources, WALL_COST);
}
export function buildWall(game) {
  const idx = currentPlayer(game);
  if (!canBuildWall(game, idx)) return false;
  const p = game.players[idx];
  payCost(p.resources, WALL_COST);
  RESOURCES.forEach((r) => { game.bank.resources[r] += WALL_COST[r] || 0; });
  p.walls++;
  fire(game, 'build');
  return true;
}

// ---- 騎士: 建てる・起動・昇格 ----
export function canPlaceKnight(game, vertexId, playerIdx) {
  const p = game.players[playerIdx];
  if (!p.knights || knightCountAtLevel(p, 1) >= MAX_KNIGHTS_PER_LEVEL) return false;
  const v = game.board.vertices[vertexId];
  if (v.building || vertexHasAnyKnight(game, vertexId)) return false;
  return v.edgeIds.some((eId) => game.board.edges[eId].road === playerIdx);
}
export function availableKnightVertices(game, playerIdx) {
  return game.board.vertices.filter((v) => canPlaceKnight(game, v.id, playerIdx)).map((v) => v.id);
}
export function buildKnight(game, vertexId) {
  if (!canBuildNow(game)) return false;
  const idx = currentPlayer(game);
  if (!canPlaceKnight(game, vertexId, idx)) return false;
  const p = game.players[idx];
  if (!canAfford(p.resources, KNIGHT_COST)) return false;
  payCost(p.resources, KNIGHT_COST);
  RESOURCES.forEach((r) => { game.bank.resources[r] += KNIGHT_COST[r] || 0; });
  p.knights.push({ id: nextKnightId(p), vertexId, level: 1, active: false, actedTurn: null });
  fire(game, 'build');
  return true;
}
export function canActivateKnight(game, playerIdx, knightId) {
  const p = game.players[playerIdx];
  const k = p.knights && p.knights.find((x) => x.id === knightId);
  if (!canBuildNow(game) || !k || k.active) return false;
  return canAfford(p.resources, KNIGHT_ACTIVATE_COST);
}
export function activateKnight(game, knightId) {
  const idx = currentPlayer(game);
  if (!canActivateKnight(game, idx, knightId)) return false;
  const p = game.players[idx];
  payCost(p.resources, KNIGHT_ACTIVATE_COST);
  RESOURCES.forEach((r) => { game.bank.resources[r] += KNIGHT_ACTIVATE_COST[r] || 0; });
  p.knights.find((k) => k.id === knightId).active = true;
  fire(game, 'build');
  return true;
}
export function canUpgradeKnight(game, playerIdx, knightId) {
  if (!canBuildNow(game)) return false;
  const p = game.players[playerIdx];
  const k = p.knights && p.knights.find((x) => x.id === knightId);
  if (!k || k.level >= 3) return false;
  if (k.level === 2 && (p.cityImprovements.politics || 0) < 3) return false; // 最強にするには政治3段階目以上
  if (knightCountAtLevel(p, k.level + 1) >= MAX_KNIGHTS_PER_LEVEL) return false; // 昇格先の段階も2体まで
  return canAfford(p.resources, KNIGHT_COST);
}
export function upgradeKnight(game, knightId) {
  const idx = currentPlayer(game);
  if (!canUpgradeKnight(game, idx, knightId)) return false;
  const p = game.players[idx];
  payCost(p.resources, KNIGHT_COST);
  RESOURCES.forEach((r) => { game.bank.resources[r] += KNIGHT_COST[r] || 0; });
  p.knights.find((k) => k.id === knightId).level++;
  fire(game, 'build');
  return true;
}

// ---- 騎士: 移動・追い出し・盗賊を追い払う（起動中で、その手番にまだ使っていないものだけ） ----
export function movableKnightVertices(game, playerIdx, knightId) {
  const p = game.players[playerIdx];
  const k = p.knights && p.knights.find((x) => x.id === knightId);
  if (!k || !knightActionAvailable(game, k)) return [];
  const v = game.board.vertices[k.vertexId];
  return v.neighbors.filter((nid) => {
    const onRoad = v.edgeIds.some((eId) => {
      const e = game.board.edges[eId];
      return (e.v1 === nid || e.v2 === nid) && e.road === playerIdx;
    });
    const nv = game.board.vertices[nid];
    return onRoad && !nv.building && !vertexHasAnyKnight(game, nid);
  });
}
export function moveKnight(game, knightId, toVertexId) {
  if (!canBuildNow(game)) return false;
  const idx = currentPlayer(game);
  if (!movableKnightVertices(game, idx, knightId).includes(toVertexId)) return false;
  const k = game.players[idx].knights.find((x) => x.id === knightId);
  k.vertexId = toVertexId;
  k.actedTurn = game.turnNumber;
  fire(game, 'build');
  return true;
}
// 隣の頂点にいる、自分と同じかそれより弱い相手の騎士を追い出す（公式の「追い出す」をレベル比較に簡略化）
export function expellableTargets(game, playerIdx, knightId) {
  const p = game.players[playerIdx];
  const k = p.knights && p.knights.find((x) => x.id === knightId);
  if (!k || !knightActionAvailable(game, k)) return [];
  const v = game.board.vertices[k.vertexId];
  const out = [];
  game.players.forEach((op, oi) => {
    if (oi === playerIdx || !op.knights) return;
    op.knights.forEach((ek) => { if (v.neighbors.includes(ek.vertexId) && ek.level <= k.level) out.push({ ownerIdx: oi, knightId: ek.id }); });
  });
  return out;
}
export function expelKnight(game, myKnightId, targetOwnerIdx, targetKnightId) {
  if (!canBuildNow(game)) return false;
  const idx = currentPlayer(game);
  const targets = expellableTargets(game, idx, myKnightId);
  if (!targets.some((t) => t.ownerIdx === targetOwnerIdx && t.knightId === targetKnightId)) return false;
  game.players[idx].knights.find((x) => x.id === myKnightId).actedTurn = game.turnNumber;
  const op = game.players[targetOwnerIdx];
  op.knights = op.knights.filter((x) => x.id !== targetKnightId);
  fire(game, 'rob');
  log(game, `${playerName(game, idx)}が${playerName(game, targetOwnerIdx)}の騎士を追い出した`);
  return true;
}
// 盗賊に接する頂点にいる、起動中の騎士で盗賊を砂漠へ追い払う（その騎士は使うと休む）
export function canChaseRobber(game, playerIdx, knightId) {
  if (!canBuildNow(game)) return false;
  const p = game.players[playerIdx];
  const k = p.knights && p.knights.find((x) => x.id === knightId);
  if (!k || !knightActionAvailable(game, k)) return false;
  if (game.board.hexes[game.board.robberHex].terrain === 'water') return false;
  return game.board.vertices[k.vertexId].hexIds.includes(game.board.robberHex);
}
export function chaseRobber(game, knightId) {
  const idx = currentPlayer(game);
  if (!canChaseRobber(game, idx, knightId)) return false;
  const desert = game.board.hexes.find((h) => h.terrain === 'desert');
  game.board.robberHex = desert.id;
  const k = game.players[idx].knights.find((x) => x.id === knightId);
  k.active = false; k.actedTurn = game.turnNumber;
  fire(game, 'rob');
  log(game, `${playerName(game, idx)}が騎士で盗賊を追い払った`);
  return true;
}

// ---- 進歩カード（山から引く・手札から使う） ----
function drawProgressCard(game, idx, color) {
  const deck = game.progressDecks[color];
  if (!deck.length) return false;
  const id = deck.pop();
  const p = game.players[idx];
  if (PROGRESS_VP_CARDS.has(id)) {
    p.progressVp = (p.progressVp || 0) + 1;
    fire(game, 'buy-dev');
    log(game, `${playerName(game, idx)}が勝利点の進歩カードを公開した（+1点）`);
    checkWin(game, idx);
    return true;
  }
  if (p.progressCards.length >= PROGRESS_HAND_LIMIT) return false; // 手札いっぱいなら引けない（簡略化。README に注記）
  p.progressCards.push({ color, id });
  fire(game, 'buy-dev');
  return true;
}
function grantResources(game, idx, list) { list.forEach((r) => { if (game.bank.resources[r] > 0) { game.bank.resources[r]--; game.players[idx].resources[r]++; } }); }
function grantCommodity(game, idx, com) { if (game.bank.commodities[com] > 0) { game.bank.commodities[com]--; game.players[idx].commodities[com]++; } }
function randomOpponentCardRef(game, idx) {
  const others = game.players.map((p, i) => i).filter((i) => i !== idx && game.players[i].progressCards && game.players[i].progressCards.length);
  if (!others.length) return null;
  const oi = others[Math.floor(Math.random() * others.length)];
  return { oi, ci: Math.floor(Math.random() * game.players[oi].progressCards.length) };
}
function applyProgressCard(game, idx, id, params) {
  const p = game.players[idx];
  switch (id) {
    case 'tr_resource1': case 'sc_resource1': case 'po_resource1':
      if (!params.res || !RESOURCES.includes(params.res)) return false;
      grantResources(game, idx, [params.res]); return true;
    case 'tr_resource2': case 'sc_resource2':
      if (!Array.isArray(params.res) || params.res.length !== 2 || params.res.some((r) => !RESOURCES.includes(r))) return false;
      grantResources(game, idx, params.res); return true;
    case 'tr_commodity1': case 'po_commodity1': case 'sc_commodity1':
      if (!params.com || !COMMODITIES.includes(params.com)) return false;
      grantCommodity(game, idx, params.com); return true;
    case 'tr_trade21': case 'tr_trade21x2': {
      const times = id === 'tr_trade21x2' ? 2 : 1;
      if (!Array.isArray(params.trades) || params.trades.length !== times) return false;
      for (const [give, want] of params.trades) { if ((p.resources[give] || 0) < 2 || game.bank.resources[want] <= 0) return false; }
      params.trades.forEach(([give, want]) => { p.resources[give] -= 2; game.bank.resources[give] += 2; p.resources[want]++; game.bank.resources[want]--; });
      return true;
    }
    case 'tr_stealres':
      if (!params.res || !RESOURCES.includes(params.res)) return false;
      game.players.forEach((op, oi) => { if (oi !== idx && op.resources[params.res] > 0) { op.resources[params.res]--; p.resources[params.res]++; } });
      return true;
    case 'tr_roadfree':
      return params.edge != null && buildRoad(game, params.edge, { free: true });
    case 'sc_roadfree2': {
      if (!Array.isArray(params.edges) || !params.edges.length) return false;
      let any = false;
      params.edges.slice(0, 2).forEach((e) => { if (buildRoad(game, e, { free: true })) any = true; });
      return any;
    }
    case 'tr_vp': case 'po_vp': case 'sc_vp':
      p.progressVp = (p.progressVp || 0) + 1; checkWin(game, idx); return true;
    case 'tr_cardsteal': case 'po_cardsteal': case 'sc_cardsteal': {
      const found = randomOpponentCardRef(game, idx);
      if (!found) return false;
      const [taken] = game.players[found.oi].progressCards.splice(found.ci, 1);
      p.progressCards.push(taken);
      return true;
    }
    case 'tr_bankgift':
      grantResources(game, idx, RESOURCES.slice()); return true;
    case 'po_knightfree':
      if (params.vertex == null || !canPlaceKnight(game, params.vertex, idx)) return false;
      p.knights.push({ id: nextKnightId(p), vertexId: params.vertex, level: 1, active: false, actedTurn: null });
      return true;
    case 'po_activateall':
      if (!p.knights.length) return false;
      p.knights.forEach((k) => { k.active = true; });
      return true;
    case 'po_upgradefree': {
      const k = params.knightId != null && p.knights.find((x) => x.id === params.knightId);
      if (!k || k.level >= 3 || (k.level === 2 && (p.cityImprovements.politics || 0) < 3)) return false;
      if (knightCountAtLevel(p, k.level + 1) >= MAX_KNIGHTS_PER_LEVEL) return false;
      k.level++; return true;
    }
    case 'po_deserter': {
      if (params.ownerIdx == null || params.ownerIdx === idx || params.knightId == null) return false;
      const op = game.players[params.ownerIdx];
      const k = op.knights && op.knights.find((x) => x.id === params.knightId);
      if (!k) return false;
      if (k.level > 1) k.level--; else op.knights = op.knights.filter((x) => x.id !== params.knightId);
      return true;
    }
    case 'po_intrigue': {
      if (params.ownerIdx == null || params.ownerIdx === idx || params.knightId == null) return false;
      const op = game.players[params.ownerIdx];
      const ek = op.knights && op.knights.find((x) => x.id === params.knightId);
      if (!ek) return false;
      const near = (p.knights || []).some((mk) => game.board.vertices[mk.vertexId].neighbors.includes(ek.vertexId));
      if (!near) return false;
      op.knights = op.knights.filter((x) => x.id !== params.knightId);
      return true;
    }
    case 'po_wallfree':
      if (p.walls >= MAX_WALLS || p.walls >= p.cities.length) return false;
      p.walls++; return true;
    case 'sc_inventor': {
      const ha = game.board.hexes[params.hexA], hb = game.board.hexes[params.hexB];
      if (!ha || !hb || ha.number == null || hb.number == null || ha.id === hb.id) return false;
      const tmp = ha.number; ha.number = hb.number; hb.number = tmp;
      return true;
    }
    case 'sc_irrigation': {
      const n = [...p.settlements, ...p.cities].filter((vid) => game.board.vertices[vid].hexIds.some((h) => game.board.hexes[h].terrain === 'field')).length;
      if (!n) return false;
      grantResources(game, idx, Array(n).fill('wheat')); return true;
    }
    case 'sc_mining': {
      const n = [...p.settlements, ...p.cities].filter((vid) => game.board.vertices[vid].hexIds.some((h) => game.board.hexes[h].terrain === 'mountains')).length;
      if (!n) return false;
      grantResources(game, idx, Array(n).fill('ore')); return true;
    }
    case 'sc_research':
      return drawProgressCard(game, idx, 'science');
    default:
      return false;
  }
}
export function playProgressCard(game, cardIdx, params = {}) {
  if (game.phase !== 'main') return false;
  const idx = currentPlayer(game);
  const p = game.players[idx];
  if (!p.progressCards) return false;
  const card = p.progressCards[cardIdx];
  if (!card) return false;
  if (!applyProgressCard(game, idx, card.id, params)) return false;
  p.progressCards.splice(cardIdx, 1);
  checkWin(game, idx);
  return true;
}

// ---- 事件のサイコロ（3つめ）と蛮族の襲来 ----
function resolveEventDie(game, redDie, rng) {
  const face = EVENT_FACES[Math.floor(rng() * EVENT_FACES.length)];
  game.eventDie = face;
  if (face === 'barbarian') {
    game.barbarianProgress++;
    if (game.barbarianProgress >= BARBARIAN_ATTACK_AT) { game.barbarianProgress = 0; resolveBarbarianAttack(game); }
    return;
  }
  // 城門: 赤サイコロ（dice1）の目以下の段階しか持たない人は引けない。目以上の人だけ、その色の進歩カードを引く
  game.players.forEach((p, idx) => { if ((p.cityImprovements[face] || 0) >= redDie) drawProgressCard(game, idx, face); });
}
function resolveBarbarianAttack(game) {
  game.barbarianAttacked = true;
  const strength = game.players.map((p) => (p.knights || []).filter((k) => k.active).reduce((a, k) => a + k.level, 0));
  const totalKnights = strength.reduce((a, b) => a + b, 0);
  const totalCities = game.players.reduce((a, p) => a + p.cities.length, 0);
  if (totalKnights >= totalCities) {
    const max = Math.max(...strength);
    const winners = strength.map((s, i) => (s === max && s > 0 ? i : -1)).filter((i) => i >= 0);
    if (winners.length === 1) {
      game.players[winners[0]].defenderVp = (game.players[winners[0]].defenderVp || 0) + 1;
      log(game, `${playerName(game, winners[0])}が蛮族を退け、守護者の点+1`);
      checkWin(game, winners[0]);
    } else if (winners.length > 1) {
      winners.forEach((i) => drawProgressCard(game, i, TRACKS[Math.floor(Math.random() * TRACKS.length)]));
      log(game, '蛮族を退けたが同点のため、進歩カードを引いた');
    } else {
      log(game, '蛮族を退けた（活動中の騎士がいなかった）');
    }
  } else {
    const min = Math.min(...strength);
    const metropolisVertices = new Set(TRACKS.map((t) => game.metropolis[t]).filter((v) => v != null));
    game.players.forEach((p, idx) => {
      if (strength[idx] !== min) return;
      const vid = p.cities.find((v) => !metropolisVertices.has(v)); // 大都市の置かれた都市は守られる
      if (vid == null) return;
      p.cities = p.cities.filter((v) => v !== vid);
      p.walls = Math.min(p.walls || 0, p.cities.length); // 都市壁も都市といっしょに失う
      if (p.settlements.length >= MAX_SETTLEMENTS) { // 開拓地の駒が残っていなければ、都市はなくなる（公式どおり）
        game.board.vertices[vid].building = null;
        log(game, `${playerName(game, idx)}の都市が1つなくなった（蛮族に敗れ、開拓地の駒も残っていなかった）`);
        return;
      }
      p.settlements.push(vid);
      game.board.vertices[vid].building = { owner: idx, type: 'settlement' };
      log(game, `${playerName(game, idx)}の都市が1つ開拓地に戻った（蛮族に敗れた）`);
    });
    fire(game, 'rob');
  }
  game.players.forEach((p) => { (p.knights || []).forEach((k) => { k.active = false; }); }); // 襲来のあと騎士は全員休む
}

// 手番を終えたあと、5〜6人拡張では「特別建設フェイズ」に入る。手番を終えた人以外が、
// 手番の順で1人ずつ、建てる・発展カードを買うことだけできる（交易・発展カードを使うのは不可）。
// 誰からも passSpecialBuild が来るまで続く。
function startSpecialBuilding(game) {
  const finished = game.turn;
  const queue = [];
  for (let i = 1; i < game.playerCount; i++) queue.push((finished + i) % game.playerCount);
  if (!queue.length) { finishAdvanceTurn(game); return; }
  game.specialBuildQueue = queue;
  game.specialBuildIdx = 0;
  game.phase = 'specialBuilding';
}
function finishAdvanceTurn(game) {
  game.turn = advanceIdx(game, game.turn);
  game.turnNumber++;
  game.phase = 'roll';
  game.diceLast = null;
  game.shipMovedThisTurn = false;
  game.players.forEach((p) => { p.goldSpendsThisTurn = 0; });
}
// サッカー熱: n回攻撃して何点入るか（両面チップを投げる代わりに、1回ごとに50%で1ゴール）
function soccerPlayShots(n) {
  let goals = 0;
  for (let i = 0; i < n; i++) if (Math.random() < 0.5) goals++;
  return goals;
}
// サッカー熱: フットボールレーンの通過マスのボーナス（資源はランダムに1種、公式は自分で選べるが簡略化。README に注記）
function grantSoccerBonus(game, idx, kind) {
  if (kind === 'devcard') {
    if (!game.bank.devDeck.length) return;
    const type = game.bank.devDeck.pop();
    game.players[idx].devCards.push({ type, boughtTurn: game.turnNumber, played: false });
    log(game, `${playerName(game, idx)}がフットボールレーンのボーナスで発展カードを引いた`);
  } else {
    const avail = RESOURCES.filter((r) => game.bank.resources[r] > 0);
    if (!avail.length) return;
    const r = avail[Math.floor(Math.random() * avail.length)];
    game.bank.resources[r]--; game.players[idx].resources[r]++;
    log(game, `${playerName(game, idx)}がフットボールレーンのボーナスで${RESOURCE_LABEL[r]}を1枚もらった`);
  }
}
function applySoccerPoints(game, idx, pts) {
  if (pts <= 0) return;
  const p = game.players[idx];
  const old = p.socPoints;
  p.socPoints = old + pts;
  Object.keys(SOCCER_BONUS).forEach((posStr) => {
    const pos = Number(posStr);
    if (pos > old && pos <= p.socPoints) grantSoccerBonus(game, idx, SOCCER_BONUS[pos]);
  });
}
// サッカー熱: 1節ぶんの対戦をまとめて行う（2試合を順番に。3人戦はダブルプレイヤーの2試合も両方そのまま数える＝公式の「数えない」選択は省く。README に注記）
function resolveSoccerMatchday(game) {
  const fixtures = soccerFixturesForDay(game.playerCount, game.soccerDay);
  const results = fixtures.map(([a, b]) => {
    const golsA = soccerPlayShots(game.players[a].socShots);
    const golsB = soccerPlayShots(game.players[b].socShots);
    let ptsA = 0, ptsB = 0;
    if (golsA > golsB) ptsA = 3; else if (golsB > golsA) ptsB = 3; else { ptsA = 1; ptsB = 1; }
    applySoccerPoints(game, a, ptsA);
    applySoccerPoints(game, b, ptsB);
    return { a, b, golsA, golsB, ptsA, ptsB };
  });
  log(game, `サッカー第${game.soccerDay}節: ${results.map((r) => `${playerName(game, r.a)} ${r.golsA}-${r.golsB} ${playerName(game, r.b)}`).join(' / ')}`);
  game.soccerLastResult = { day: game.soccerDay, results };
  game.soccerDay++;
  if (game.soccerDay > game.soccerMaxDay || game.players.some((p) => p.socPoints >= SOCCER_CUP_POS)) game.soccerSeasonOver = true;
  fire(game, 'build');
  checkWinAll(game); // 試合の結果で順位の勝利点が動き、誰かが勝利点に届くことがある
}
export function endTurn(game) {
  if (game.phase !== 'main') return false;
  game.lastSteal = null; // 通信対戦: 奪われた知らせは次の手番まで（main.js の renderBanner が見る）
  game.devCardPlayedThisTurn = false;
  if (game.scenario === 'barbarians') resolveBarbarianExpel(game, game.turn);
  if (game.soccer && game.pendingSoccerMatch && !game.soccerSeasonOver) resolveSoccerMatchday(game);
  game.pendingSoccerMatch = false;
  if (game.expansions && game.expansions.includes('5-6player')) { startSpecialBuilding(game); return true; }
  // 隊商: 手番の間に建てた分だけ、ラクダの投票→配置を済ませてから次の手番に進む
  if (game.scenario === 'caravans' && game.players[game.turn].pendingCamelBuilds > 0) { resumeCamelOrTurn(game); return true; }
  finishAdvanceTurn(game);
  return true;
}
export function passSpecialBuild(game) {
  if (game.phase !== 'specialBuilding') return false;
  game.specialBuildIdx++;
  if (game.specialBuildIdx >= game.specialBuildQueue.length) {
    game.turn = game.specialBuildQueue[0]; // 手番を終えた人の次の人から、普通の手番を始める
    game.specialBuildQueue = [];
    game.specialBuildIdx = 0;
    game.turnNumber++;
    game.phase = 'roll';
    game.diceLast = null;
    game.shipMovedThisTurn = false;
  }
  return true;
}

// ---- 通信対戦（段階10）: 隠し情報を分けた「見た目」を作る ----
// seat 本人（と手番と関係なく見てよいもの）だけ中身を残し、ほかは枚数だけにする。
// seat === null は「誰の味方でもない公開用」（全員ぶん隠す）。
// JSON を1回通すだけの浅くないコピーにして、元の game を書き換えない。
export function viewFor(game, seat) {
  const g = JSON.parse(JSON.stringify(game));
  // 発展カード・進歩カードの山の順は、ホスト以外の誰にも見せない（本人ぶんも含めて常に隠す）
  if (g.bank && Array.isArray(g.bank.devDeck)) g.bank.devDeck = Array(g.bank.devDeck.length).fill(null);
  if (g.progressDecks) {
    TRACKS.forEach((t) => { if (Array.isArray(g.progressDecks[t])) g.progressDecks[t] = Array(g.progressDecks[t].length).fill(null); });
  }
  if (Array.isArray(g.fishBag)) g.fishBag = Array(g.fishBag.length).fill(null);
  g.players.forEach((p, idx) => {
    if (idx === seat) return; // 自分の席ぶんはそのまま
    const handCount = RESOURCES.reduce((a, r) => a + (p.resources[r] || 0), 0);
    p.resources = emptyResources();
    p.handCount = handCount; // 枚数だけは公開情報（実物のカードの枚数は見える）
    p.devCards = p.devCards.map((c) => (c.played ? c : { ...c, type: null })); // 使った後は公開済み
    if (p.commodities) {
      const commodityCount = COMMODITIES.reduce((a, c) => a + (p.commodities[c] || 0), 0);
      p.commodities = emptyCommodities();
      p.commodityCount = commodityCount;
    }
    if (p.progressCards) p.progressCards = p.progressCards.map(() => ({ id: null, color: null }));
    if (Array.isArray(p.fishTokens)) p.fishTokens = p.fishTokens.map(() => null);
  });
  // 盗賊・海賊で何を奪ったかは、奪った人と奪われた人の画面にだけ
  if (g.lastSteal && g.lastSteal.from !== seat && g.lastSteal.to !== seat) g.lastSteal = null;
  return g;
}
