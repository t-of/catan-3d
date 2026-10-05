'use strict';
// CPU（画面・音に触らない）。engine.js の公開関数だけを使って手を打つ。
// 使うのは step(game, level) と discardFor(game, playerIdx, level) の2つだけ。
// CPU は他の人の手札・発展カードの中身を見ない（robberTargets で見える「枚数」までは見てよい）。
import * as E from './engine.js';

export const LEVELS = [
  { id: 'weak', name: 'よわい' },
  { id: 'normal', name: 'ふつう' },
  { id: 'strong', name: 'つよい' },
];

// engine.js のタイル→資源の対応表（カードの強さを読むためだけの複製。ルールは曲げない）
const TERRAIN_RESOURCE = { forest: 'wood', hills: 'brick', pasture: 'sheep', field: 'wheat', mountains: 'ore', desert: null, water: null, gold: null };

const rnd = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[rnd(arr.length)];
function affordable(res, cost) { return Object.entries(cost).every(([k, v]) => (res[k] || 0) >= v); }
function pip(n) { return n == null ? 0 : 6 - Math.abs(7 - n); }
// 川の橋は3本まで＆道より高いので、置ける辺の中で実際に建てられる辺だけに絞る（でないと詰まる）
function affordableRoadEdge(game, idx, eId) {
  const p = game.players[idx];
  const isBridge = game.board.riverEdgeIds && game.board.riverEdgeIds.includes(eId);
  if (isBridge && (p.bridges || 0) >= E.MAX_BRIDGES) return false;
  return affordable(p.resources, E.roadCostFor(game, eId));
}

// ---- 頂点・道の値打ち ----
// idx を渡すと、その人がまだもらっていない航海者版の小島ボーナス(+2点、最初の1軒だけ)を高く見る。
// これがないと、CPUは産出の良い本島ばかり優先して道・船を15本使い切り、小島に届く前に手詰まりになることがあった。
function vertexValue(game, vid, level, idx = null) {
  const v = game.board.vertices[vid];
  let score = 0;
  const resSet = new Set();
  v.hexIds.forEach((hId) => {
    const hex = game.board.hexes[hId];
    const res = TERRAIN_RESOURCE[hex.terrain];
    if (!res) return;
    score += pip(hex.number);
    resSet.add(res);
  });
  score += resSet.size * 1.5;
  if (level === 'strong' && v.port) score += v.port === '3:1' ? 0.8 : 1.5;
  if (idx != null && game.board.islandHexIds && !game.players[idx].islandBonus
    && v.hexIds.some((h) => game.board.islandHexIds.includes(h))) score += 6;
  return score;
}
// 小島ボーナス(航海者版)・霧の探検(探検家と海賊)の狙い先まで、海の頂点をたどって何歩で着くか(届かなければ Infinity)。
// roadValue はすぐ隣の頂点しか見ないので、これがないと「あと2〜3隻で小島に着く」くらいの船を一歩も動かせず、
// 船・道を15本使い切って手詰まりになることがあった。
function waterHopsToGoal(game, startVid, idx) {
  const isGoal = (v) => v.hexIds.some((h) => {
    const hex = game.board.hexes[h];
    if (game.explorersPirates && hex.fog) return true;
    return game.board.islandHexIds && game.board.islandHexIds.includes(h) && !game.players[idx].islandBonus;
  });
  if (isGoal(game.board.vertices[startVid])) return 0;
  let frontier = [startVid];
  const seen = new Set(frontier);
  for (let hop = 1; hop <= 8; hop++) {
    const next = [];
    for (const vid of frontier) {
      for (const eId of game.board.vertices[vid].edgeIds) {
        const e = game.board.edges[eId];
        // 海に面した辺しかたどらない(船の通り道)。盤の外周の辺は隣のマスが1つしかなく、それも海として扱う(engine.js の edgeTouchesSea と同じ)
        if (e.hexIds.length >= 2 && !e.hexIds.some((h) => game.board.hexes[h].terrain === 'water')) continue;
        const nv = e.v1 === vid ? e.v2 : e.v1;
        if (seen.has(nv)) continue;
        seen.add(nv);
        if (isGoal(game.board.vertices[nv])) return hop;
        next.push(nv);
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return Infinity;
}
// 道の先に、まだ誰も建てていない（距離ルールでも塞がれていない）頂点があるときだけ値打ちを付ける。
// 常に正の値を返すと、行き場のない方角にも道を延ばし続けて15本を使い切ってしまう（2人対局で詰まる原因だった）。
function roadValue(game, edgeId, idx, level) {
  const e = game.board.edges[edgeId];
  let best = 0;
  [e.v1, e.v2].forEach((vid) => {
    const v = game.board.vertices[vid];
    if (v.building) return;
    if (v.neighbors.some((n) => game.board.vertices[n].building)) return; // 距離ルールで永久に置けない
    best = Math.max(best, vertexValue(game, vid, level, idx));
  });
  // 自分が小島ボーナスをまだ持っていない・探検家と海賊で霧が残っているなら、そこへ近づく船にも値打ちを付ける(歩数が近いほど高い)
  if (game.board.islandHexIds && (!game.players[idx].islandBonus || game.explorersPirates)) {
    [e.v1, e.v2].forEach((vid) => {
      if (game.board.vertices[vid].building) return;
      const hops = waterHopsToGoal(game, vid, idx);
      if (hops < Infinity) best = Math.max(best, 5 - hops);
    });
  }
  return best;
}

// ---- セットアップ（最初の開拓地と道を2周） ----
function cpuSetupStep(game, level) {
  const idx = E.currentPlayer(game);
  if (game.setupPending === 'settlement') {
    const options = E.availableSettlementVertices(game, idx, true);
    const v = level === 'weak' ? pick(options) : options.map((o) => ({ o, s: vertexValue(game, o, level, idx) })).sort((a, b) => b.s - a.s)[0].o;
    return E.setupPlaceSettlement(game, v);
  }
  const options = game.board.vertices[game.setupLastVertex].edgeIds.filter((eId) => game.board.edges[eId].road == null);
  if (level === 'weak') return E.setupPlaceRoad(game, pick(options));
  const e = options.map((o) => ({ o, s: roadValue(game, o, idx, level) })).sort((a, b) => b.s - a.s)[0].o;
  return E.setupPlaceRoad(game, e);
}

// ---- 金の川（航海者版: 出目が合えば好きな資源を選べる）。足りない資源から優先して選ぶ ----
export function pickGoldFor(game, playerIdx) {
  const pending = game.pendingGoldPicks.find((d) => d.player === playerIdx);
  if (!pending) return false;
  const p = game.players[playerIdx];
  const taken = Object.fromEntries(E.RESOURCES.map((r) => [r, 0]));
  const picks = [];
  for (let i = 0; i < pending.count; i++) {
    const avail = E.RESOURCES.filter((r) => game.bank.resources[r] - taken[r] > 0);
    if (!avail.length) break; // 銀行が空なら選べる分だけでよい…が、枚数は一致させる必要があるので諦める
    avail.sort((a, b) => (p.resources[a] + taken[a]) - (p.resources[b] + taken[b]));
    const r = avail[0];
    taken[r]++;
    picks.push(r);
  }
  return E.pickGold(game, playerIdx, picks); // 銀行が足りなければ picks は pending.count より少なくなる（それでよい）
}

// ---- 都市と騎士(科学3段階目): 何も入らなかった目のぶん、足りない資源を選ぶ ----
export function pickScienceBonusFor(game, playerIdx) {
  if (!game.pendingScienceBonus || !game.pendingScienceBonus.includes(playerIdx)) return false;
  const p = game.players[playerIdx];
  const avail = E.RESOURCES.filter((r) => game.bank.resources[r] > 0);
  if (!avail.length) { game.pendingScienceBonus = game.pendingScienceBonus.filter((i) => i !== playerIdx); return true; }
  const r = avail.sort((a, b) => (p.resources[a] || 0) - (p.resources[b] || 0))[0];
  return E.pickScienceBonus(game, playerIdx, r);
}

// ---- 捨て札（7が出たとき） ----
export function discardFor(game, playerIdx, level) {
  const pending = game.pendingDiscards.find((d) => d.player === playerIdx);
  if (!pending) return false;
  const p = game.players[playerIdx];
  const obj = Object.fromEntries(E.RESOURCES.map((r) => [r, 0]));
  let remaining = pending.count;
  if (level === 'weak') {
    const pool = E.RESOURCES.flatMap((r) => Array(p.resources[r]).fill(r));
    for (let i = pool.length - 1; i > 0; i--) { const j = rnd(i + 1); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    for (let i = 0; i < remaining; i++) obj[pool[i]]++;
  } else {
    // 木・土から優先して捨て、麦・鉄（都市に要る）はなるべく残す
    const order = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
    while (remaining > 0) {
      let best = null, bestScore = -1;
      E.RESOURCES.forEach((r) => {
        const left = (p.resources[r] || 0) - obj[r];
        if (left <= 0) return;
        const score = left - order.indexOf(r) * 0.01;
        if (score > bestScore) { bestScore = score; best = r; }
      });
      if (!best) break;
      obj[best]++; remaining--;
    }
  }
  return E.discardCards(game, playerIdx, obj);
}

// ---- 盗賊・海賊 ----
function chooseRobberHex(game, idx, level) {
  const hexes = game.board.hexes.filter((h) => h.id !== game.board.robberHex && h.terrain !== 'water' && !h.fog);
  if (level === 'weak') return pick(hexes).id;
  const scored = hexes.map((h) => {
    let score = 0, hasOwn = false;
    const owners = new Set();
    h.vertexIds.forEach((vid) => {
      const b = game.board.vertices[vid].building;
      if (!b) return;
      if (b.owner === idx) { hasOwn = true; return; }
      owners.add(b.owner);
      score += pip(h.number) * (b.type === 'city' ? 2 : 1);
    });
    if (level === 'strong') owners.forEach((o) => { score += E.playerScore(game, o) * 1.5; });
    if (hasOwn) score -= 5;
    return { h, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].h.id;
}
function chooseRobberTarget(game, idx, hexId, level) {
  const targets = E.robberTargets(game, hexId, idx);
  if (!targets.length) return null;
  if (level === 'strong') return targets.reduce((best, t) => (E.playerScore(game, t) > E.playerScore(game, best) ? t : best));
  return pick(targets);
}
// 海賊（航海者版）を動かす先。隣に自分以外の船がある海マスだけが対象になりうる。
function choosePirateHex(game, idx, level) {
  if (game.board.pirateHex == null) return null;
  const hexes = game.board.hexes.filter((h) => h.id !== game.board.pirateHex && h.terrain === 'water');
  const scored = hexes.map((h) => {
    const targets = E.pirateTargets(game, h.id, idx);
    if (!targets.length) return { h, score: -1 };
    const best = level === 'strong' ? targets.reduce((b, t) => (E.playerScore(game, t) > E.playerScore(game, b) ? t : b)) : targets[0];
    return { h, score: E.playerScore(game, best) };
  }).filter((s) => s.score >= 0);
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  return scored[0].h.id;
}
function choosePirateTarget(game, idx, hexId, level) {
  const targets = E.pirateTargets(game, hexId, idx);
  if (!targets.length) return null;
  if (level === 'strong') return targets.reduce((best, t) => (E.playerScore(game, t) > E.playerScore(game, best) ? t : best));
  return pick(targets);
}
// 盗賊・海賊のどちらを動かすか選ぶ（ふつう・つよいだけ。よわいは盗賊だけ動かす簡略化のまま）。
// 「得なとき」= 海賊で奪える相手のほうが、盗賊で奪える相手より得点が高いとき。
function chooseBandit(game, idx, level) {
  const landHex = chooseRobberHex(game, idx, level);
  const landTarget = chooseRobberTarget(game, idx, landHex, level);
  if (game.board.pirateHex == null || level === 'weak') return { hexId: landHex, target: landTarget, water: false };
  const seaHex = choosePirateHex(game, idx, level);
  if (seaHex == null) return { hexId: landHex, target: landTarget, water: false };
  const seaTarget = choosePirateTarget(game, idx, seaHex, level);
  const landScore = landTarget != null ? E.playerScore(game, landTarget) : -1;
  const seaScore = seaTarget != null ? E.playerScore(game, seaTarget) : -1;
  if (seaScore > landScore) return { hexId: seaHex, target: seaTarget, water: true };
  return { hexId: landHex, target: landTarget, water: false };
}

// ---- 発展カード（よわい用: ランダムに1枚使う） ----
function playableDev(game, c) { return !game.devCardPlayedThisTurn && !c.played && c.type !== 'vp' && c.boughtTurn !== game.turnNumber; }
function playRandomDev(game, idx, entries) {
  const { c, i } = pick(entries);
  if (c.type === 'knight') {
    const { hexId, target } = chooseBandit(game, idx, 'weak');
    return E.playKnight(game, i, hexId, target);
  }
  if (c.type === 'roadBuilding') return E.playRoadBuilding(game, i, pickRoadBuildingItems(game, idx, 'weak'));
  if (c.type === 'yearOfPlenty') return E.playYearOfPlenty(game, i, pick(E.RESOURCES), pick(E.RESOURCES));
  if (c.type === 'monopoly') return E.playMonopoly(game, i, pick(E.RESOURCES));
  return false;
}

// 街道建設: 道・船どちらも候補に入れ、一番値打ちのある2つを選ぶ（航海者版でなければ船は常に空）。
function pickRoadBuildingItems(game, idx, level) {
  // 川: 発展カード「街道建設」で橋は作れない（公式どおり）
  const roads = E.availableRoadEdges(game, idx)
    .filter((e) => !(game.board.riverEdgeIds && game.board.riverEdgeIds.includes(e)))
    .map((e) => ({ item: e, s: roadValue(game, e, idx, level) }));
  const ships = E.availableShipEdges(game, idx).map((e) => ({ item: { id: e, kind: 'ship' }, s: roadValue(game, e, idx, level) }));
  return roads.concat(ships).sort((a, b) => b.s - a.s).slice(0, 2).map((x) => x.item);
}

// 持っている資源で成立する銀行・港との交易（give, want の組）をすべて挙げる
function anyBankTrades(game, idx) {
  const p = game.players[idx];
  const out = [];
  E.RESOURCES.forEach((give) => {
    const rate = E.playerPortRate(game, idx, give);
    if ((p.resources[give] || 0) < rate) return;
    E.RESOURCES.forEach((want) => { if (want !== give && game.bank.resources[want] > 0) out.push([give, want]); });
  });
  return out;
}

// ---- よわい: 合法手からほぼでたらめ ----
function weakMainStep(game, idx) {
  const p = game.players[idx];
  const opts = [];
  // 川の橋は道より高いので、置ける辺の中に実際に払えるものがあるかで判断する(でないと無限ループになる)
  const affordableRoads = E.availableRoadEdges(game, idx).filter((e) => affordableRoadEdge(game, idx, e));
  if (p.roads.length < 15 && affordableRoads.length) opts.push('road');
  if (p.ships.length < 15 && affordable(p.resources, E.COSTS.ship) && E.availableShipEdges(game, idx).length) opts.push('ship');
  if (p.settlements.length < 5 && affordable(p.resources, E.COSTS.settlement) && E.availableSettlementVertices(game, idx, false).length) opts.push('settlement');
  if (p.cities.length < 4 && affordable(p.resources, E.COSTS.city) && E.availableCityVertices(game, idx).length) opts.push('city');
  if (game.bank.devDeck.length && affordable(p.resources, E.COSTS.dev)) opts.push('dev');
  const playable = p.devCards.map((c, i) => ({ c, i })).filter(({ c }) => playableDev(game, c));
  if (playable.length) opts.push('playdev');
  const trades = anyBankTrades(game, idx);
  if (trades.length) opts.push('trade');
  opts.push('end');
  const choice = pick(opts);
  if (choice === 'road') return E.buildRoad(game, pick(affordableRoads));
  if (choice === 'ship') return E.buildShip(game, pick(E.availableShipEdges(game, idx)));
  if (choice === 'settlement') return E.buildSettlement(game, pick(E.availableSettlementVertices(game, idx, false)));
  if (choice === 'city') return E.buildCity(game, pick(E.availableCityVertices(game, idx)));
  if (choice === 'dev') return E.buyDevCard(game);
  if (choice === 'playdev') return playRandomDev(game, idx, playable);
  if (choice === 'trade') { const [give, want] = pick(trades); return E.bankTrade(game, give, want); }
  return E.endTurn(game);
}

// ---- ふつう・つよい共通: 建てられる中で一番得点に近いものを建てる貪欲 ----
function greedyBuild(game, idx, level) {
  const p = game.players[idx];
  const cityVs = E.availableCityVertices(game, idx);
  if (p.cities.length < 4 && cityVs.length && affordable(p.resources, E.COSTS.city)) {
    return E.buildCity(game, cityVs.slice().sort((a, b) => vertexValue(game, b, level, idx) - vertexValue(game, a, level, idx))[0]);
  }
  // 開拓地は、建てられる中で一番ましな場所でよい（必ず1点に近づくので、しきい値では足切りしない）
  const stlVs = E.availableSettlementVertices(game, idx, false);
  if (p.settlements.length < 5 && stlVs.length && affordable(p.resources, E.COSTS.settlement)) {
    const best = stlVs.slice().sort((a, b) => vertexValue(game, b, level, idx) - vertexValue(game, a, level, idx))[0];
    return E.buildSettlement(game, best);
  }
  // 道・船は、先にまだ誰も建てていない頂点があるときだけ（行き場のない方角には延ばさない）。
  // 船は海に面した辺にしか置けないので availableShipEdges が自動で絞ってくれる（航海者版でなければ常に空）。
  // 川の橋は道より高いので、置ける辺のうち実際に払える辺だけを候補にする（でないと無限ループになる）
  const edges = E.availableRoadEdges(game, idx).filter((e) => affordableRoadEdge(game, idx, e));
  const ships = E.availableShipEdges(game, idx);
  const roadBest = edges.length ? edges.map((e) => ({ e, s: roadValue(game, e, idx, level) })).sort((a, b) => b.s - a.s)[0] : null;
  const shipBest = ships.length ? ships.map((e) => ({ e, s: roadValue(game, e, idx, level) })).sort((a, b) => b.s - a.s)[0] : null;
  if (roadBest && roadBest.s > 0 && p.roads.length < 15 && (!shipBest || roadBest.s >= shipBest.s)) {
    return E.buildRoad(game, roadBest.e);
  }
  if (shipBest && shipBest.s > 0 && p.ships.length < 15 && affordable(p.resources, E.COSTS.ship)) {
    return E.buildShip(game, shipBest.e);
  }
  if (game.bank.devDeck.length && affordable(p.resources, E.COSTS.dev)) return E.buyDevCard(game);
  // ほかに何もできないときだけ、銀行・港と交易する（ふつうも、これがないと資源の偏りで詰まることがある）
  if (tryHelpfulTrade(game, idx)) return true;
  // 盤がほぼ埋まって新しい開拓地が見込めないときの最後の手: 長い交易路を狙って道・船だけは伸ばす
  if (p.roads.length < 15 && edges.length && game.longestRoadPlayer !== idx) {
    return E.buildRoad(game, edges[0]);
  }
  if (p.ships.length < 15 && ships.length && affordable(p.resources, E.COSTS.ship) && game.longestRoadPlayer !== idx) {
    return E.buildShip(game, ships[0]);
  }
  return false;
}

// ---- つよい: 目標に向けて資源を貯める・港の交易・盗賊を首位へ ----
function pickTargetCost(game, idx) {
  if (E.availableCityVertices(game, idx).length) return E.COSTS.city;
  if (E.availableSettlementVertices(game, idx, false).length) return E.COSTS.settlement;
  if (E.availableRoadEdges(game, idx).length) return E.COSTS.road;
  if (E.availableShipEdges(game, idx).length) return E.COSTS.ship;
  return null;
}
function shouldPlayKnight(game, idx) {
  const p = game.players[idx];
  const robberHex = game.board.robberHex != null ? game.board.hexes[game.board.robberHex] : null;
  if (robberHex && robberHex.vertexIds.some((vid) => { const b = game.board.vertices[vid].building; return b && b.owner === idx; })) return true;
  if (p.knightsPlayed + 1 >= 3 && game.largestArmyPlayer !== idx) return true;
  const myScore = E.playerScore(game, idx);
  const leaderScore = Math.max(...game.players.map((_, i) => E.playerScore(game, i)));
  return leaderScore - myScore >= 3;
}
function bestMonopolyResource(game, idx) {
  let best = null, bestAmt = 0;
  E.RESOURCES.forEach((r) => {
    const mine = game.players[idx].resources[r] || 0;
    const others = game.players.reduce((a, pl, i) => (i === idx ? a : a + (pl.resources[r] || 0)), 0);
    if (others >= 4 && mine < 2 && others > bestAmt) { bestAmt = others; best = r; }
  });
  return best;
}
function tryHelpfulTrade(game, idx) {
  const p = game.players[idx];
  const cost = pickTargetCost(game, idx);
  if (!cost || affordable(p.resources, cost)) return false;
  const missing = Object.entries(cost).filter(([r, n]) => (p.resources[r] || 0) < n).map(([r]) => r);
  if (!missing.length) return false;
  const want = missing[0];
  for (const give of E.RESOURCES) {
    if (give === want) continue;
    const rate = E.playerPortRate(game, idx, give);
    const spare = (p.resources[give] || 0) - (cost[give] || 0);
    if (spare >= rate && game.bank.resources[want] > 0) return E.bankTrade(game, give, want);
  }
  return false;
}
// ---- 人からの交易を受けるかどうか ----
// 持っている資源と目標（pickTargetCost）に照らして、give（CPUがもらう）と get（CPUが出す）の値打ちを比べる。
// 人の手札の中身は見ない。首位に近い相手には厳しめに、よわいはほぼでたらめ（半々）。
function playerPips(game, idx, res) {
  let total = 0;
  game.board.hexes.forEach((h) => {
    if (TERRAIN_RESOURCE[h.terrain] !== res) return;
    h.vertexIds.forEach((vid) => {
      const b = game.board.vertices[vid].building;
      if (b && b.owner === idx) total += pip(h.number) * (b.type === 'city' ? 2 : 1);
    });
  });
  return total;
}
function resourceValue(game, idx, res) {
  const p = game.players[idx];
  let score = Math.max(0, 3 - playerPips(game, idx, res)); // 自分の産出が薄いほど欲しい
  const cost = pickTargetCost(game, idx);
  if (cost && cost[res] && (p.resources[res] || 0) < cost[res]) score += 2; // 今の目標に足りない分は価値が高い
  score -= Math.min(p.resources[res] || 0, 3) * 0.3; // すでに余っているほど手放しやすい
  return score;
}
export function acceptTrade(game, cpuIdx, give, get, level = 'normal') {
  const p = game.players[cpuIdx];
  if (!affordable(p.resources, get)) return false; // 持っていない資源は出せない
  if (level === 'weak') return Math.random() < 0.5;
  const gain = E.RESOURCES.reduce((a, r) => a + resourceValue(game, cpuIdx, r) * (give[r] || 0), 0);
  const cost = E.RESOURCES.reduce((a, r) => a + resourceValue(game, cpuIdx, r) * (get[r] || 0), 0);
  const proposer = E.currentPlayer(game);
  const leaderScore = Math.max(...game.players.map((_, i) => E.playerScore(game, i)));
  let margin = 0;
  if (E.playerScore(game, proposer) >= leaderScore) margin = 1.5; // 相手が首位（タイ含む）なら厳しめ
  else if (leaderScore - E.playerScore(game, proposer) <= 1) margin = 0.7;
  return gain - cost > margin;
}

function strongStep(game, idx) {
  const p = game.players[idx];
  const rb = p.devCards.findIndex((c) => c.type === 'roadBuilding' && playableDev(game, c));
  if (rb >= 0) {
    const picks = pickRoadBuildingItems(game, idx, 'strong');
    if (picks.length) return E.playRoadBuilding(game, rb, picks);
  }
  const yop = p.devCards.findIndex((c) => c.type === 'yearOfPlenty' && playableDev(game, c));
  if (yop >= 0) {
    const cost = pickTargetCost(game, idx);
    const need = cost ? Object.entries(cost).filter(([r, n]) => (p.resources[r] || 0) < n).map(([r]) => r) : [];
    if (need.length) return E.playYearOfPlenty(game, yop, need[0], need[1] || need[0]);
  }
  const mono = p.devCards.findIndex((c) => c.type === 'monopoly' && playableDev(game, c));
  if (mono >= 0) {
    const r = bestMonopolyResource(game, idx);
    if (r) return E.playMonopoly(game, mono, r);
  }
  const knight = p.devCards.findIndex((c) => c.type === 'knight' && playableDev(game, c));
  if (knight >= 0 && shouldPlayKnight(game, idx)) {
    const { hexId, target } = chooseBandit(game, idx, 'strong');
    return E.playKnight(game, knight, hexId, target);
  }
  if (tryHelpfulTrade(game, idx)) return true;
  return false;
}

// ---- 特別建設フェイズ（5〜6人拡張）: 建てる・発展カードを買うことだけできる。交易・発展カードを使うのは不可 ----
function specialBuildStep(game, level) {
  const idx = E.currentPlayer(game);
  const p = game.players[idx];
  if (level === 'weak') {
    const opts = [];
    const roadEdges = E.availableRoadEdges(game, idx).filter((e) => affordableRoadEdge(game, idx, e));
    if (p.roads.length < 15 && roadEdges.length) opts.push('road');
    if (p.settlements.length < 5 && affordable(p.resources, E.COSTS.settlement) && E.availableSettlementVertices(game, idx, false).length) opts.push('settlement');
    if (p.cities.length < 4 && affordable(p.resources, E.COSTS.city) && E.availableCityVertices(game, idx).length) opts.push('city');
    if (game.bank.devDeck.length && affordable(p.resources, E.COSTS.dev)) opts.push('dev');
    if (!opts.length || Math.random() < 0.4) return E.passSpecialBuild(game); // 建てられても、ときどきは様子見でパス
    const choice = pick(opts);
    if (choice === 'road') return E.buildRoad(game, pick(roadEdges));
    if (choice === 'settlement') return E.buildSettlement(game, pick(E.availableSettlementVertices(game, idx, false)));
    if (choice === 'city') return E.buildCity(game, pick(E.availableCityVertices(game, idx)));
    return E.buyDevCard(game);
  }
  // ふつう・つよい: 貪欲に建てる（greedyBuildの建設部分だけ。交易はしない）
  const cityVs = E.availableCityVertices(game, idx);
  if (p.cities.length < 4 && cityVs.length && affordable(p.resources, E.COSTS.city)) {
    return E.buildCity(game, cityVs.slice().sort((a, b) => vertexValue(game, b, level, idx) - vertexValue(game, a, level, idx))[0]);
  }
  const stlVs = E.availableSettlementVertices(game, idx, false);
  if (p.settlements.length < 5 && stlVs.length && affordable(p.resources, E.COSTS.settlement)) {
    return E.buildSettlement(game, stlVs.slice().sort((a, b) => vertexValue(game, b, level, idx) - vertexValue(game, a, level, idx))[0]);
  }
  if (game.bank.devDeck.length && affordable(p.resources, E.COSTS.dev)) return E.buyDevCard(game);
  if (level === 'strong') {
    const edges = E.availableRoadEdges(game, idx).filter((e) => affordableRoadEdge(game, idx, e));
    if (p.roads.length < 15 && edges.length) {
      const scored = edges.map((e) => ({ e, s: roadValue(game, e, idx, level) })).sort((a, b) => b.s - a.s);
      if (scored[0].s > 0) return E.buildRoad(game, scored[0].e);
    }
  }
  return E.passSpecialBuild(game);
}

// ---- 都市と騎士: 進歩カード・騎士・都市の発展・都市壁（複雑な相手選びが要るカードは自動では使わない） ----
const CK_EASY_CARDS = new Set([
  'tr_resource1', 'tr_resource2', 'sc_resource1', 'sc_resource2', 'po_resource1',
  'tr_commodity1', 'po_commodity1', 'sc_commodity1', 'tr_bankgift', 'tr_vp', 'po_vp', 'sc_vp',
  'tr_trade21', 'tr_trade21x2', 'po_activateall', 'sc_irrigation', 'sc_mining', 'sc_research',
]);
function worstResource(res) { return E.RESOURCES.slice().sort((a, b) => (res[a] || 0) - (res[b] || 0))[0]; }
function playEasyProgressCards(game, idx) {
  const p = game.players[idx];
  for (let i = p.progressCards.length - 1; i >= 0; i--) {
    const card = p.progressCards[i];
    if (!CK_EASY_CARDS.has(card.id)) continue;
    if (card.id === 'po_activateall' && !p.knights.some((k) => !k.active)) continue;
    let params = {};
    if (card.id === 'tr_resource1' || card.id === 'sc_resource1' || card.id === 'po_resource1') params = { res: worstResource(p.resources) };
    else if (card.id === 'tr_resource2' || card.id === 'sc_resource2') params = { res: [worstResource(p.resources), worstResource(p.resources)] };
    else if (card.id === 'tr_commodity1' || card.id === 'po_commodity1' || card.id === 'sc_commodity1') {
      params = { com: E.COMMODITIES.slice().sort((a, b) => (p.commodities[a] || 0) - (p.commodities[b] || 0))[0] };
    } else if (card.id === 'tr_trade21' || card.id === 'tr_trade21x2') {
      const times = card.id === 'tr_trade21x2' ? 2 : 1;
      const pool = { ...p.resources };
      const trades = [];
      for (let t = 0; t < times; t++) {
        const give = E.RESOURCES.find((r) => (pool[r] || 0) >= 2);
        if (!give) break;
        pool[give] -= 2;
        const want = worstResource(pool);
        pool[want] = (pool[want] || 0) + 1;
        trades.push([give, want]);
      }
      if (trades.length < times) continue;
      params = { trades };
    }
    if (E.playProgressCard(game, i, params)) return true;
  }
  return false;
}
// 弱い・強い・最強、各段階2体まで。よわいCPUは弱い騎士を1体持てば十分、ふつう・つよいは育てていく。
function knightsAtLevel(p, lv) { return p.knights.filter((k) => k.level === lv).length; }
function ckStep(game, idx, level) {
  const p = game.players[idx];
  if (!p.cityImprovements) return false; // 都市と騎士を使っていない対局では何もしない
  if (playEasyProgressCards(game, idx)) return true;
  const weakCap = level === 'weak' ? 1 : E.MAX_KNIGHTS_PER_LEVEL;
  if (p.cities.length && knightsAtLevel(p, 1) < weakCap && affordable(p.resources, E.KNIGHT_COST)) {
    const vs = E.availableKnightVertices(game, idx);
    if (vs.length) return E.buildKnight(game, pick(vs));
  }
  const inactive = p.knights.find((k) => !k.active);
  if (inactive && affordable(p.resources, E.KNIGHT_ACTIVATE_COST)) return E.activateKnight(game, inactive.id);
  if (level !== 'weak') {
    // 昇格: 低い段階から順に、空きがあって資源があれば昇格する（最強は政治3段階目以上が要る）
    const upgradable = p.knights.find((k) => k.level < 3
      && !(k.level === 2 && (p.cityImprovements.politics || 0) < 3)
      && knightsAtLevel(p, k.level + 1) < E.MAX_KNIGHTS_PER_LEVEL);
    if (upgradable && affordable(p.resources, E.KNIGHT_COST)) return E.upgradeKnight(game, upgradable.id);
    const tracks = E.TRACKS.filter((t) => E.canImproveCity(game, idx, t));
    if (tracks.length) return E.improveCity(game, pick(tracks));
    if (E.canBuildWall(game, idx)) return E.buildWall(game);
    // 交易3段階目: 余っている商品を2枚で、足りない資源に替える
    if (p.cityImprovements.trade >= 3) {
      const give = E.COMMODITIES.find((c) => (p.commodities[c] || 0) >= 2);
      if (give) {
        const want = worstResource(p.resources);
        if (E.tradeCommodity(game, give, 'resource', want)) return true;
      }
    }
  }
  return false;
}

// ---- 交易と略奪: 漁師（魚を貯めて得なときに使う。人の交易と違って自分だけで決められる） ----
function fishermenStep(game, idx, level) {
  if (game.scenario !== 'fishermen') return false;
  const p = game.players[idx];
  // 古い靴を渡せるなら（自分だけ最多点でないとき）、渡せる相手の中で一番点が近い人へ渡す
  if (game.oldBootHolder === idx) {
    const targets = game.players.map((_, i) => i).filter((i) => E.canGiveOldBoot(game, i)).sort((a, b) => E.playerScore(game, a) - E.playerScore(game, b));
    if (targets.length && E.giveOldBoot(game, targets[0])) return true;
  }
  // 盗賊が自分の産出をふさいでいるなら、2匹で盤外へ出す
  if (game.board.robberHex != null && E.canUseFishTrade(game, idx, 'robberAway')) {
    const hex = game.board.hexes[game.board.robberHex];
    if (hex.vertexIds.some((vid) => { const b = game.board.vertices[vid].building; return b && b.owner === idx; })) {
      if (E.fishRobberAway(game)) return true;
    }
  }
  if (level !== 'weak' && game.bank.devDeck.length && E.canUseFishTrade(game, idx, 'devcard') && E.fishDevCard(game)) return true;
  if (level === 'strong' && E.canUseFishTrade(game, idx, 'road')) {
    const edges = E.availableRoadEdges(game, idx);
    if (edges.length) {
      const best = edges.map((e) => ({ e, s: roadValue(game, e, idx, level) })).sort((a, b) => b.s - a.s)[0];
      if (best.s > 0 && E.fishRoad(game, best.e)) return true;
    }
  }
  if (E.canUseFishTrade(game, idx, 'resource')) {
    const cost = pickTargetCost(game, idx);
    const need = cost ? Object.entries(cost).filter(([r, n]) => (p.resources[r] || 0) < n).map(([r]) => r) : [];
    if (need.length && E.fishResource(game, need[0])) return true;
  }
  if (level !== 'weak' && E.canUseFishTrade(game, idx, 'steal')) {
    const others = game.players.map((_, i) => i).filter((i) => i !== idx).sort((a, b) => E.playerScore(game, b) - E.playerScore(game, a));
    if (others.length && E.fishSteal(game, others[0])) return true;
  }
  return false;
}
// ---- 交易と略奪: 川（金貨2枚が貯まったら、今欲しい資源に替える。手番に2回まで） ----
function riversStep(game, idx) {
  if (game.scenario !== 'rivers') return false;
  const p = game.players[idx];
  if ((p.gold || 0) < 2 || !E.canTradeGold(game, idx)) return false;
  const cost = pickTargetCost(game, idx);
  const need = cost ? Object.entries(cost).filter(([r, n]) => (p.resources[r] || 0) < n).map(([r]) => r) : [];
  return E.tradeGold(game, need[0] || E.RESOURCES[0]);
}
// ---- 交易と略奪: 隊商（投票は出せる範囲で少し出し、配置は自分の得になる場所を選ぶ） ----
function caravanBidFor(game, playerIdx, level) {
  const p = game.players[playerIdx];
  const wheat = level === 'weak' ? 0 : Math.min(1, p.resources.wheat || 0);
  const sheep = level === 'strong' ? Math.min(1, p.resources.sheep || 0) : 0;
  return E.submitCamelBid(game, playerIdx, { wheat, sheep });
}
// ラクダの置き場所: 自分の開拓地・都市につながる辺（長い交易路やラクダボーナスが狙える）を優先する
function caravanPlaceFor(game, level) {
  const decider = game.camelDecider;
  const options = E.camelPlacementOptions(game);
  if (!options.length) return false;
  const scored = options.map((eId) => {
    const e = game.board.edges[eId];
    let s = 0;
    [e.v1, e.v2].forEach((vid) => {
      const v = game.board.vertices[vid];
      const b = v.building;
      if (b && b.owner === decider) s += 2;
      if (level !== 'weak' && v.edgeIds.some((o) => game.board.edges[o].road === decider)) s += 1;
    });
    return { eId, s };
  }).sort((a, b) => b.s - a.s);
  return E.placeCamel(game, scored[0].eId);
}
// ---- 交易と略奪: 蛮族の襲撃（資源があれば砦の空いた辺に騎士を建て、動ける分だけ蛮族のいるマスへ寄せる） ----
function barbariansStep(game, idx, level) {
  if (game.scenario !== 'barbarians') return false;
  const p = game.players[idx];
  const castleEdges = new Set(game.board.hexes[game.board.castleHexId].edgeIds);
  // 砦の辺をふさいだままの騎士は、新しい騎士を建てられるように動かして空けておく（公式どおり。でないと詰まる）
  for (const k of p.warKnights) {
    if (!castleEdges.has(k.edgeId)) continue;
    const reach = E.movableWarKnightEdges(game, idx, k.id, false);
    const away = reach.find((eId) => !castleEdges.has(eId));
    if (away != null && E.moveWarKnight(game, k.id, away, false)) return true;
  }
  const edges = E.availableWarKnightEdges(game, idx);
  if (edges.length && affordable(p.resources, E.WAR_KNIGHT_COST)) return E.buildWarKnight(game, pick(edges));
  if (level === 'weak') return false;
  // 蛮族がいるマスの6辺のどれかへ、動かせる騎士を近づける
  const targets = game.board.hexes.filter((h) => h.id !== game.board.castleHexId && h.terrain !== 'desert' && h.barbarians > 0);
  for (const k of p.warKnights) {
    const reach = E.movableWarKnightEdges(game, idx, k.id, false);
    if (!reach.length) continue;
    const onTarget = reach.find((eId) => targets.some((h) => h.edgeIds.includes(eId)));
    if (onTarget != null && E.moveWarKnight(game, k.id, onTarget, false)) return true;
  }
  return false;
}

function mainStep(game, idx, level) {
  if (ckStep(game, idx, level)) return true;
  if (fishermenStep(game, idx, level)) return true;
  if (riversStep(game, idx)) return true;
  if (barbariansStep(game, idx, level)) return true;
  if (level === 'weak') return weakMainStep(game, idx);
  if (level === 'strong' && strongStep(game, idx)) return true;
  if (greedyBuild(game, idx, level)) return true;
  return E.endTurn(game);
}

// ---- 手番で次の1手を1つ進める。true なら何か起きた（main.js はこれを呼び続ける） ----
export function step(game, level = 'normal') {
  const phase = game.phase;
  if (phase === 'setup1' || phase === 'setup2') return cpuSetupStep(game, level);
  if (phase === 'roll') { E.rollDice(game, Math.random); return true; }
  if (phase === 'barbarianSteal') {
    const idx = E.currentPlayer(game);
    const targets = E.barbarianStealTargets(game, idx);
    return E.resolveBarbarianSteal(game, targets.length ? pick(targets) : 0);
  }
  if (phase === 'camelVote') return caravanBidFor(game, E.actingPlayer(game), level);
  if (phase === 'camelPlace') return caravanPlaceFor(game, level);
  if (phase === 'moveRobber') {
    const idx = E.currentPlayer(game);
    const { hexId, target } = chooseBandit(game, idx, level);
    return E.moveRobber(game, hexId, target);
  }
  if (phase === 'specialBuilding') return specialBuildStep(game, level);
  if (phase === 'main') return mainStep(game, E.currentPlayer(game), level);
  return false;
}
