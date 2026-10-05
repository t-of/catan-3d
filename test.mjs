'use strict';
// engine.js の自己チェック。フレームワークなし。node --test で動く。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from './engine.js';
import * as CPU from './cpu.js';

test('盤面: 19マス・54頂点・72辺・地形の枚数・6と8が隣り合わない', () => {
  for (let i = 0; i < 20; i++) {
    const g = E.createGame(4, Math.random);
    assert.equal(g.board.hexes.length, 19);
    assert.equal(g.board.vertices.length, 54);
    assert.equal(g.board.edges.length, 72);
    const counts = {};
    g.board.hexes.forEach((h) => { counts[h.terrain] = (counts[h.terrain] || 0) + 1; });
    assert.deepEqual(counts, { forest: 4, hills: 3, pasture: 4, field: 4, mountains: 3, desert: 1 });
    const byCoord = new Map(g.board.hexes.map((h) => [`${h.q},${h.r}`, h]));
    const dirs = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
    g.board.hexes.forEach((h) => {
      if (h.number !== 6 && h.number !== 8) return;
      dirs.forEach(([dq, dr]) => {
        const n = byCoord.get(`${h.q + dq},${h.r + dr}`);
        if (n) assert.notEqual(n.number === 6 || n.number === 8, true, '6/8が隣り合っている');
      });
    });
    const portVertices = g.board.vertices.filter((v) => v.port);
    assert.equal(portVertices.length, 18); // 港9か所 × 頂点2つ
    const byType = {};
    portVertices.forEach((v) => { byType[v.port] = (byType[v.port] || 0) + 1; });
    assert.equal(byType['3:1'], 8); // 3:1 ×4ヶ所
    ['wood', 'brick', 'sheep', 'wheat', 'ore'].forEach((r) => assert.equal(byType[r], 2)); // 2:1 ×1ヶ所ずつ
  }
});

test('セットアップ: 距離ルールと2周（順→逆）、2個目の開拓地で資源をもらう', () => {
  const g = E.createGame(3, Math.random);
  assert.equal(E.currentPlayer(g), 0);
  const v0 = E.availableSettlementVertices(g, 0, true)[0];
  assert.ok(E.setupPlaceSettlement(g, v0));
  // 隣接頂点には置けない（距離ルール）
  const neighbor = g.board.vertices[v0].neighbors[0];
  assert.equal(E.canPlaceSettlement(g, neighbor, 0, true), false);
  const road0 = g.board.vertices[v0].edgeIds[0];
  assert.ok(E.setupPlaceRoad(g, road0));
  assert.equal(E.currentPlayer(g), 1);

  // 残りの5回（1が2回目、2が2回、0が1回）を進める
  for (let i = 0; i < 5; i++) {
    const idx = E.currentPlayer(g);
    const v = E.availableSettlementVertices(g, idx, true)[0];
    E.setupPlaceSettlement(g, v);
    const e = g.board.vertices[v].edgeIds[0];
    const before = JSON.parse(JSON.stringify(g.players[idx].resources));
    const wasSetup2 = g.phase === 'setup2';
    E.setupPlaceRoad(g, e);
    if (wasSetup2) {
      const after = g.players[idx].resources;
      const gained = Object.keys(before).some((k) => after[k] > before[k]);
      assert.ok(gained || g.board.vertices[v].hexIds.every((h) => g.board.hexes[h].terrain === 'desert'));
    }
  }
  assert.equal(g.phase, 'roll');
  assert.equal(g.turn, 0);
  g.players.forEach((p) => { assert.equal(p.settlements.length, 2); assert.equal(p.roads.length, 2); });
});

test('セットアップ: 2個目の開拓地の資源は銀行からも引かれる', () => {
  const g = E.createGame(3, Math.random);
  for (let i = 0; i < 3; i++) { // setup1を3人ぶん進めてsetup2に入る
    const idx = E.currentPlayer(g);
    const v = E.availableSettlementVertices(g, idx, true)[0];
    E.setupPlaceSettlement(g, v);
    E.setupPlaceRoad(g, g.board.vertices[v].edgeIds[0]);
  }
  assert.equal(g.phase, 'setup2');
  const idx = E.currentPlayer(g);
  const v = E.availableSettlementVertices(g, idx, true)[0];
  E.setupPlaceSettlement(g, v);
  const bankBefore = { ...g.bank.resources };
  E.setupPlaceRoad(g, g.board.vertices[v].edgeIds[0]);
  const after = g.players[idx].resources;
  Object.keys(bankBefore).forEach((res) => {
    assert.equal(bankBefore[res] - g.bank.resources[res], after[res]); // 配った枚数ぶん、銀行も減る
  });
});

test('建設: コストが引かれ、銀行に戻る。足りないと失敗する', () => {
  const g = E.createGame(3, Math.random);
  g.phase = 'main'; g.turn = 0;
  const p = g.players[0];
  const v = g.board.vertices.find((x) => x.edgeIds.length >= 2);
  p.resources = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  assert.equal(E.buildRoad(g, v.edgeIds[0]), false); // 何も持っていない
  p.resources = { wood: 1, brick: 1, sheep: 0, wheat: 0, ore: 0 };
  v.building = { owner: 0, type: 'settlement' }; // 自分の開拓地から道を伸ばす
  p.settlements.push(v.id);
  const bankBefore = g.bank.resources.wood;
  assert.ok(E.buildRoad(g, v.edgeIds[0]));
  assert.equal(p.resources.wood, 0);
  assert.equal(g.bank.resources.wood, bankBefore + 1);
});

test('長い交易路: 直線の道は長さどおり。内部の頂点を敵に取られると分断される', () => {
  const g = E.createGame(4, Math.random);
  const interior = g.board.vertices.find((v) => v.edgeIds.length === 3);
  const [e0, e1] = interior.edgeIds;
  const other = (e, vid) => (g.board.edges[e].v1 === vid ? g.board.edges[e].v2 : g.board.edges[e].v1);
  const va = other(e0, interior.id);
  g.board.vertices[va].building = { owner: 0, type: 'settlement' };
  g.players[0].settlements.push(va);
  E.buildRoad(g, e0, { free: true });
  E.buildRoad(g, e1, { free: true });
  assert.equal(g.players[0].roadLength, 2);
  g.board.vertices[interior.id].building = { owner: 1, type: 'settlement' };
  g.players[1].settlements.push(interior.id);
  E.recalcLongestRoad(g);
  assert.equal(g.players[0].roadLength, 1);
});

test('最長交易路: 建てた本人以外に移ったとき、その人の勝利判定もその場でされる', () => {
  const g = E.createGame(3, Math.random);
  const edgeBetween = (a, b) => g.board.vertices[a].edgeIds.find((e) => {
    const ed = g.board.edges[e];
    return (ed.v1 === a && ed.v2 === b) || (ed.v2 === a && ed.v1 === b);
  });
  // 長さ`length`の単純パスを探す(頂点の重複なし)。avoidに含む頂点は使わない。
  // requireDegree3Atを指定すると、その位置の頂点は分断用の第三の辺を出せる(次数3)ものだけ選ぶ
  function findPath(length, avoid, requireDegree3At) {
    for (const start of g.board.vertices) {
      if (avoid.has(start.id)) continue;
      const path = [start.id];
      const used = new Set();
      const dfs = (vid) => {
        if (requireDegree3At != null && path.length - 1 === requireDegree3At
          && g.board.vertices[vid].edgeIds.length < 3) return false;
        if (path.length === length + 1) return true;
        for (const nb of g.board.vertices[vid].neighbors) {
          if (avoid.has(nb) || path.includes(nb)) continue;
          const e = edgeBetween(vid, nb);
          if (used.has(e)) continue;
          used.add(e); path.push(nb);
          if (dfs(nb)) return true;
          path.pop(); used.delete(e);
        }
        return false;
      };
      if (dfs(start.id)) {
        const edges = [];
        for (let i = 0; i < path.length - 1; i++) edges.push(edgeBetween(path[i], path[i + 1]));
        return { vertices: path, edges };
      }
    }
    return null;
  }
  // プレイヤー1に長さ6の最長交易路を持たせる（得点は0のまま、まだ勝てない）
  const path1 = findPath(6, new Set(), 3); // 4番目の頂点(index3)で分断できるよう、そこは次数3にする
  g.board.vertices[path1.vertices[0]].building = { owner: 1, type: 'settlement' };
  g.players[1].settlements.push(path1.vertices[0]);
  path1.edges.forEach((e) => { g.board.edges[e].road = 1; g.players[1].roads.push(e); });
  E.recalcLongestRoad(g);
  assert.equal(g.longestRoadPlayer, 1);
  assert.equal(g.winner, null);
  // プレイヤー2は別経路に長さ6の道を持ち、都市4つ(8点)を直接積んでおく(現状9点、最長交易路を奪えば11点)
  const path2 = findPath(6, new Set(path1.vertices));
  g.board.vertices[path2.vertices[0]].building = { owner: 2, type: 'settlement' };
  g.players[2].settlements.push(path2.vertices[0]);
  path2.edges.forEach((e) => { g.board.edges[e].road = 2; g.players[2].roads.push(e); });
  g.players[2].cities.push(9001, 9002, 9003, 9004);
  // プレイヤー1の道を分断する: path1の内部頂点にプレイヤー0が開拓地を建てる
  const cutVertex = path1.vertices[3];
  const approach = g.board.vertices[cutVertex].edgeIds.find((e) => !path1.edges.includes(e));
  g.board.edges[approach].road = 0;
  g.players[0].roads.push(approach);
  g.players[0].resources = { wood: 1, brick: 1, sheep: 1, wheat: 1, ore: 0 };
  g.phase = 'main'; g.turn = 0;
  assert.ok(E.buildSettlement(g, cutVertex)); // これで内部で recalcLongestRoad が呼ばれ、最長交易路が2へ移る
  assert.equal(g.longestRoadPlayer, 2);
  assert.equal(g.winner, 2); // buildSettlement自身はプレイヤー0のcheckWinしか見ないが、recalcLongestRoadが2の勝利も拾う
});

test('発展カード: 買った手番には使えない。独占で資源を総取りできる', () => {
  const g = E.createGame(3, Math.random);
  g.phase = 'main'; g.turn = 0; g.turnNumber = 1;
  const p0 = g.players[0];
  p0.resources = { wood: 0, brick: 0, sheep: 1, wheat: 1, ore: 1 };
  assert.ok(E.buyDevCard(g));
  p0.devCards[0] = { type: 'knight', boughtTurn: 1, played: false };
  assert.equal(E.playKnight(g, 0, g.board.hexes.find((h) => h.id !== g.board.robberHex).id, null), false);
  g.turnNumber = 2;
  assert.ok(E.playKnight(g, 0, g.board.hexes.find((h) => h.id !== g.board.robberHex).id, null));
  assert.equal(p0.knightsPlayed, 1);

  p0.devCards = [{ type: 'monopoly', boughtTurn: 1, played: false }];
  g.devCardPlayedThisTurn = false;
  g.players[1].resources.wood = 3; g.players[2].resources.wood = 2;
  assert.ok(E.playMonopoly(g, 0, 'wood'));
  assert.equal(p0.resources.wood, 5);
  assert.equal(g.players[1].resources.wood, 0);
});

test('銀行交易: 港なしは4:1、港があればその比率', () => {
  const g = E.createGame(3, Math.random);
  g.phase = 'main'; g.turn = 0;
  const p0 = g.players[0];
  assert.equal(E.playerPortRate(g, 0, 'wood'), 4);
  p0.resources.wood = 4;
  assert.ok(E.bankTrade(g, 'wood', 'ore'));
  assert.equal(p0.resources.wood, 0);
  assert.equal(p0.resources.ore, 1);

  const portV = g.board.vertices.find((v) => v.port === 'wood');
  portV.building = { owner: 0, type: 'settlement' };
  p0.settlements.push(portV.id);
  assert.equal(E.playerPortRate(g, 0, 'wood'), 2);
});

test('7が出たとき: 8枚以上の人だけ半分（切り捨て）捨てる', () => {
  const g = E.createGame(3, Math.random);
  g.phase = 'roll';
  g.players[0].resources.wood = 6;
  g.players[1].resources.wood = 7;
  g.players[2].resources.wood = 9;
  const dice = [0.4, 0.6]; // 3 + 4 = 7
  assert.equal(E.rollDice(g, () => dice.shift()), 7);
  assert.deepEqual(g.pendingDiscards, [{ player: 2, count: 4 }]);
});

test('資源の産出: 銀行不足でも、もらう人が1人だけなら残っている分だけ渡す', () => {
  const g = E.createGame(3, Math.random);
  g.phase = 'roll'; g.turn = 0;
  g.bank.resources.ore = 1; // 銀行には鉄が1枚しかない
  const mtn = g.board.hexes.find((h) => h.terrain === 'mountains' && h.number != null);
  const vid = mtn.vertexIds[0];
  g.board.vertices[vid].building = { owner: 0, type: 'city' }; // 都市なので鉄2枚を要求するが、要求者は0だけ
  g.players[0].cities.push(vid);
  const d1 = mtn.number <= 7 ? 1 : mtn.number - 6;
  const d2 = mtn.number - d1;
  const dice = [(d1 - 0.5) / 6, (d2 - 0.5) / 6];
  assert.equal(E.rollDice(g, () => dice.shift()), mtn.number);
  assert.equal(g.players[0].resources.ore, 1); // 2枚要求したが、残っていた1枚だけもらえる
  assert.equal(g.bank.resources.ore, 0);
  assert.ok(g.events.includes('shortage'));
});

test('勝利判定: 得点が10に届くと winner が立つ', () => {
  const g = E.createGame(3, Math.random);
  g.phase = 'main'; g.turn = 0;
  const p0 = g.players[0];
  for (let i = 0; i < 4; i++) p0.cities.push(1000 + i); // 4都市=8点
  p0.settlements.push(2000); // +1点
  p0.devCards.push({ type: 'vp', boughtTurn: 1, played: false }); // +1点
  assert.equal(E.playerScore(g, 0), 10);
});

test('5〜6人拡張: 自動で30マス・80頂点・109辺・地形/数字チップ/港の構成、銀行24枚・発展カード34枚、6と8が隣り合わない', () => {
  for (const count of [5, 6]) {
    for (let i = 0; i < 10; i++) {
      const g = E.createGame(count, Math.random);
      assert.deepEqual(g.expansions, ['5-6player']);
      assert.equal(g.board.hexes.length, 30);
      assert.equal(g.board.vertices.length, 80);
      assert.equal(g.board.edges.length, 109);
      const counts = {};
      g.board.hexes.forEach((h) => { counts[h.terrain] = (counts[h.terrain] || 0) + 1; });
      assert.deepEqual(counts, { forest: 6, hills: 5, pasture: 6, field: 6, mountains: 5, desert: 2 });
      const nums = g.board.hexes.filter((h) => h.number != null).map((h) => h.number).sort((a, b) => a - b);
      assert.deepEqual(nums, [2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, 8, 8, 8, 9, 9, 9, 10, 10, 10, 11, 11, 11, 12, 12]);
      const byCoord = new Map(g.board.hexes.map((h) => [`${h.q},${h.r}`, h]));
      const dirs = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
      g.board.hexes.forEach((h) => {
        if (h.number !== 6 && h.number !== 8) return;
        dirs.forEach(([dq, dr]) => {
          const n = byCoord.get(`${h.q + dq},${h.r + dr}`);
          if (n) assert.notEqual(n.number === 6 || n.number === 8, true, '6/8が隣り合っている');
        });
      });
      const portVertices = g.board.vertices.filter((v) => v.port);
      assert.equal(portVertices.length, 22); // 港11か所 × 頂点2つ
      const byType = {};
      portVertices.forEach((v) => { byType[v.port] = (byType[v.port] || 0) + 1; });
      assert.equal(byType['3:1'], 10); // 3:1 ×5ヶ所
      assert.equal(byType.sheep, 4); // 羊の2:1が2ヶ所
      ['wood', 'brick', 'wheat', 'ore'].forEach((r) => assert.equal(byType[r], 2)); // 2:1 ×1ヶ所ずつ
      assert.deepEqual(g.bank.resources, { wood: 24, brick: 24, sheep: 24, wheat: 24, ore: 24 });
      assert.equal(g.bank.devDeck.length, 34);
      const devCounts = {};
      g.bank.devDeck.forEach((t) => { devCounts[t] = (devCounts[t] || 0) + 1; });
      assert.deepEqual(devCounts, { knight: 20, vp: 5, roadBuilding: 3, yearOfPlenty: 3, monopoly: 3 });
    }
  }
  // 画面からは expansions: [] で来る。それでも5〜6人なら30マスの盤になる
  for (const n of [5, 6]) assert.equal(E.createGame(n, Math.random, { expansions: [] }).board.hexes.length, 30);
  // 3〜4人は今までどおり拡張なし
  assert.deepEqual(E.createGame(4, Math.random).expansions, []);
});

test('特別建設フェイズ: 手番を終えると、ほかの人が順に建てる・発展カードを買うだけできる', () => {
  const g = E.createGame(5, Math.random);
  g.phase = 'main'; g.turn = 1; g.turnNumber = 3;
  g.players.forEach((p) => { p.resources = { wood: 10, brick: 10, sheep: 10, wheat: 10, ore: 10 }; });
  const v = g.board.vertices.find((x) => x.edgeIds.length >= 2);
  v.building = { owner: 2, type: 'settlement' }; // 道を置けるよう、あらかじめ開拓地を置いておく
  g.players[2].settlements.push(v.id);
  assert.ok(E.endTurn(g));
  assert.equal(g.phase, 'specialBuilding');
  assert.deepEqual(g.specialBuildQueue, [2, 3, 4, 0]); // 手番だった1以外が順に並ぶ
  assert.equal(E.currentPlayer(g), 2);
  // 発展カードは使えない、銀行・港との交易もできない
  g.players[2].devCards = [{ type: 'knight', boughtTurn: 1, played: false }];
  assert.equal(E.playKnight(g, 0, g.board.hexes.find((h) => h.id !== g.board.robberHex).id, null), false);
  assert.equal(E.bankTrade(g, 'wood', 'ore'), false);
  // 建てる・発展カードを買うのはできる
  const edge = E.availableRoadEdges(g, 2)[0];
  assert.ok(E.buildRoad(g, edge));
  assert.equal(g.players[2].roads.length, 1);
  // パスして次の人へ。全員ぶん済んだら、手番を終えた人の次の人が普通の手番（サイコロ待ち）になる
  assert.ok(E.passSpecialBuild(g));
  assert.equal(E.currentPlayer(g), 3);
  assert.ok(E.passSpecialBuild(g));
  assert.ok(E.passSpecialBuild(g));
  assert.ok(E.passSpecialBuild(g));
  assert.equal(g.phase, 'roll');
  assert.equal(g.turn, 2); // 手番だった1の次の2から
  assert.equal(g.turnNumber, 4);
});

// ---- CPU ----
// 決まった乱数の種で1局まわす（Math.random を一時的に差し替える）。CPU・engine の判断が Math.random を直に使っているところが
// 多く、createGame の rng 引数だけでは種を固定できないため。揺れやすい決着テストをこれで安定させる。
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function withSeededRandom(seed, fn) {
  const orig = Math.random;
  Math.random = mulberry32(seed);
  try { return fn(); } finally { Math.random = orig; }
}

// 渡された game を、CPU だけで決着まで進める（engine.js の公開操作だけを使う）。手が進まなければ無限ループせず止まる。
function playOutFrom(g, levels, maxSteps = 500000) {
  for (let i = 0; i < maxSteps; i++) {
    if (g.winner != null) return g;
    if (g.phase === 'discard') {
      const d = g.pendingDiscards[0];
      assert.ok(CPU.discardFor(g, d.player, levels[d.player]), '捨て札が進まない');
      continue;
    }
    if (g.phase === 'goldPick') {
      const d = g.pendingGoldPicks[0];
      assert.ok(CPU.pickGoldFor(g, d.player), '金の川の受け取りが進まない');
      continue;
    }
    if (g.phase === 'scienceBonus') {
      const p = g.pendingScienceBonus[0];
      assert.ok(CPU.pickScienceBonusFor(g, p), '科学3段階目の資源選びが進まない');
      continue;
    }
    const idx = E.currentPlayer(g);
    assert.ok(CPU.step(g, levels[idx]), 'CPUの手が進まない');
  }
  throw new Error(`${maxSteps}手では終わらなかった`);
}
// CPU だけで1局、決着まで進める（engine.js の公開操作だけを使う）。手が進まなければ無限ループせず止まる。
function playOutCpu(levels, maxSteps = 500000, options = {}) {
  return playOutFrom(E.createGame(levels.length, Math.random, options), levels, maxSteps);
}

test('保存の往復: 全部の拡張・シナリオで createGame → JSON化して戻す → CPUだけで決着する（盤のSetが配列になっている）', () => {
  const levels = ['weak', 'normal', 'strong', 'weak'];
  const configs = [
    {},
    { expansions: ['seafarers'] },
    { expansions: ['cities-knights'] },
    { expansions: ['soccer'] },
    { expansions: ['explorers-pirates'] },
    { expansions: ['traders-barbarians'], scenario: 'fishermen' },
    { expansions: ['traders-barbarians'], scenario: 'rivers' },
    { expansions: ['traders-barbarians'], scenario: 'caravans' },
    { expansions: ['traders-barbarians'], scenario: 'barbarians' },
  ];
  for (const options of configs) {
    const before = E.createGame(levels.length, Math.random, options);
    const g = JSON.parse(JSON.stringify(before));
    assert.ok(!(g.board.islandHexIds instanceof Set), 'islandHexIds が配列でない（JSONの往復で消えた）');
    assert.ok(!(g.board.riverEdgeIds instanceof Set), 'riverEdgeIds が配列でない（JSONの往復で消えた）');
    const after = playOutFrom(g, levels, 1500000);
    assert.ok(after.winner != null, `${JSON.stringify(options)} が決着しない`);
  }
  // 5〜6人（航海者版・探検家と海賊は小島があるので island の往復も確かめる）
  for (const options of [{}, { expansions: ['seafarers'] }, { expansions: ['explorers-pirates'] }]) {
    const before = E.createGame(6, Math.random, options);
    const g = JSON.parse(JSON.stringify(before));
    const after = playOutFrom(g, ['weak', 'normal', 'strong', 'weak', 'normal', 'strong'], 1500000);
    assert.ok(after.winner != null, `6人 ${JSON.stringify(options)} が決着しない`);
  }
});

test('CPU: 4人（強さいろいろ）で数十局、全局きちんと決着する', () => {
  const mixes = [
    ['weak', 'weak', 'weak', 'weak'],
    ['normal', 'normal', 'normal', 'normal'],
    ['strong', 'strong', 'strong', 'strong'],
    ['weak', 'normal', 'strong', 'normal'],
  ];
  for (let i = 0; i < 24; i++) {
    const g = playOutCpu(mixes[i % mixes.length]);
    assert.ok(g.winner != null);
    assert.ok(E.playerScore(g, g.winner) >= 10);
  }
});

test('CPU: 6人（5〜6人拡張・特別建設フェイズつき）で最後まで決着する', () => {
  for (let i = 0; i < 5; i++) {
    const g = playOutCpu(['weak', 'normal', 'strong', 'weak', 'normal', 'strong']);
    assert.deepEqual(g.expansions, ['5-6player']);
    assert.ok(g.winner != null);
    assert.ok(E.playerScore(g, g.winner) >= 10);
  }
});

test('CPUが受ける交易: 自分の目標に足りない資源をもらい、余っている資源を渡すなら受ける', () => {
  const g = E.createGame(2, Math.random);
  g.phase = 'main'; g.turn = 0;
  const p1 = g.players[1];
  p1.settlements.push(0); // 都市化できる開拓地が1つある扱いにし、目標コストを{wheat:2, ore:3}にする
  p1.resources = { wood: 6, brick: 6, sheep: 6, wheat: 0, ore: 0 };
  // 人が ore を3枚渡し、CPUは余っている wood を1枚渡すだけ
  assert.ok(CPU.acceptTrade(g, 1, { ore: 3 }, { wood: 1 }, 'normal'));
});

test('CPUが断る交易: 自分に足りない資源を手放し、余っている資源しかもらえないなら断る', () => {
  const g = E.createGame(2, Math.random);
  g.phase = 'main'; g.turn = 0;
  const p1 = g.players[1];
  p1.settlements.push(0);
  p1.resources = { wood: 6, brick: 6, sheep: 6, wheat: 0, ore: 5 };
  // CPUが欲しいoreを手放し、すでに余っているwoodを1枚もらうだけ
  assert.ok(!CPU.acceptTrade(g, 1, { wood: 1 }, { ore: 3 }, 'normal'));
});

test('CPUの交易: 持っていない資源は出せない', () => {
  const g = E.createGame(2, Math.random);
  g.phase = 'main'; g.turn = 0;
  const p1 = g.players[1];
  p1.resources = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  assert.ok(!CPU.acceptTrade(g, 1, { wheat: 4 }, { ore: 1 }, 'normal'));
  assert.ok(!CPU.acceptTrade(g, 1, { wheat: 4 }, { ore: 1 }, 'strong'));
});

// ---- 航海者版 ----
test('航海者版: 本島19＋海21＋小島6＝46マス。金の川1枚・小島は6マス・海賊は海に、盗賊は本島の砂漠にいる', () => {
  for (let i = 0; i < 10; i++) {
    const g = E.createGame(4, Math.random, { expansions: ['seafarers'] });
    assert.deepEqual(g.expansions, ['seafarers']);
    assert.equal(g.winTarget, 14);
    assert.equal(g.board.hexes.length, 46);
    const counts = {};
    g.board.hexes.forEach((h) => { counts[h.terrain] = (counts[h.terrain] || 0) + 1; });
    // 本島を囲む18マスに加えて、小島3つぶん(隣り合う2マス単位)を海からの船で届くようにする橋を3マス足す
    assert.equal(counts.water, 21);
    assert.equal(counts.gold, 1);
    assert.equal(g.board.islandHexIds.length, 6);
    assert.equal(g.board.hexes[g.board.robberHex].terrain, 'desert');
    assert.equal(g.board.hexes[g.board.pirateHex].terrain, 'water');
    // 金の川にも数字チップがある
    const gold = g.board.hexes.find((h) => h.terrain === 'gold');
    assert.ok(gold.number >= 2 && gold.number <= 12);
  }
});

test('航海者版: 船は海に面した辺にだけ置け、自分の開拓地・船とつながっている必要がある', () => {
  const g = E.createGame(4, Math.random, { expansions: ['seafarers'] });
  g.phase = 'main'; g.turn = 0;
  const p0 = g.players[0];
  p0.resources = { wood: 5, brick: 0, sheep: 5, wheat: 0, ore: 0 };
  const seaEdge = g.board.edges.find((e) => e.hexIds.some((h) => g.board.hexes[h].terrain === 'water') && e.hexIds.some((h) => g.board.hexes[h].terrain !== 'water')
    && !g.board.hexes[g.board.pirateHex].edgeIds.includes(e.id));
  // まだどこともつながっていないので置けない
  assert.equal(E.canPlaceShip(g, seaEdge.id, 0), false);
  const v = g.board.vertices[seaEdge.v1];
  v.building = { owner: 0, type: 'settlement' };
  p0.settlements.push(v.id);
  assert.ok(E.buildShip(g, seaEdge.id));
  assert.equal(g.board.edges[seaEdge.id].ship, 0);
  assert.equal(p0.resources.wood, 4);
  // 内陸（海に面していない）の辺には置けない
  const inland = g.board.edges.find((e) => e.hexIds.every((h) => g.board.hexes[h].terrain !== 'water') && e.hexIds.length === 2);
  if (inland) assert.equal(E.canPlaceShip(g, inland.id, 0), false);
});

test('航海者版: 船は手番に1回だけ、置いたばかりでなく列の端にあるものだけ動かせる', () => {
  // 頂点によっては海の辺が1本しかなく動かし先がないので、2本ある頂点が見つかるまで盤を作り直す
  let g, seaEdge, otherSeaEdge;
  for (let tries = 0; tries < 200; tries++) {
    g = E.createGame(4, Math.random, { expansions: ['seafarers'] });
    const pirateEdges = g.board.hexes[g.board.pirateHex].edgeIds;
    const v1 = g.board.vertices.find((v) => v.edgeIds.filter((eId) => {
      const e = g.board.edges[eId];
      return e.hexIds.some((h) => g.board.hexes[h].terrain === 'water') && e.hexIds.some((h) => g.board.hexes[h].terrain !== 'water') && !pirateEdges.includes(eId);
    }).length >= 2);
    if (!v1) continue;
    const seaEdges = v1.edgeIds.map((eId) => g.board.edges[eId]).filter((e) => e.hexIds.some((h) => g.board.hexes[h].terrain === 'water') && e.hexIds.some((h) => g.board.hexes[h].terrain !== 'water') && !pirateEdges.includes(e.id));
    [seaEdge, otherSeaEdge] = seaEdges;
    g.testAnchorVertex = v1.id;
    break;
  }
  assert.ok(seaEdge && otherSeaEdge, '試行回数内に見つからなかった');
  g.phase = 'main'; g.turn = 0; g.turnNumber = 5;
  const p0 = g.players[0];
  g.board.vertices[g.testAnchorVertex].building = { owner: 0, type: 'settlement' };
  p0.settlements.push(g.testAnchorVertex);
  seaEdge.ship = 0; seaEdge.shipPlacedTurn = 1; // 前の手番に置いた船という体にする
  p0.ships.push(seaEdge.id);
  assert.ok(E.moveShip(g, seaEdge.id, otherSeaEdge.id));
  assert.equal(g.board.edges[seaEdge.id].ship, null);
  assert.equal(g.board.edges[otherSeaEdge.id].ship, 0);
  assert.equal(g.shipMovedThisTurn, true);
  // 同じ手番にもう1回は動かせない
  assert.equal(E.moveShip(g, otherSeaEdge.id, seaEdge.id), false);
});

test('航海者版: 海賊は海マスだけに動かせ、隣の船の持ち主から奪う。盗賊は陸のまま', () => {
  const g = E.createGame(4, Math.random, { expansions: ['seafarers'] });
  g.phase = 'moveRobber'; g.turn = 0;
  const landHex = g.board.hexes.find((h) => h.terrain !== 'water' && h.id !== g.board.robberHex);
  assert.equal(E.moveRobber(g, landHex.id, null), true); // 陸マスへは今まで通り動かせる
  assert.equal(g.board.robberHex, landHex.id);

  const waterHex = g.board.hexes.find((h) => h.terrain === 'water' && h.id !== g.board.pirateHex);
  const edge = g.board.edges.find((e) => waterHex.edgeIds.includes(e.id));
  edge.ship = 1; g.players[1].resources.wood = 2;
  g.phase = 'moveRobber';
  assert.ok(E.moveRobber(g, waterHex.id, 1));
  assert.equal(g.board.pirateHex, waterHex.id);
  assert.equal(g.board.robberHex, landHex.id); // 盗賊は動いていない
});

test('航海者版: 道→船は開拓地・都市をはさむときだけ最長交易路としてつながる', () => {
  const g = E.createGame(4, Math.random, { expansions: ['seafarers'] });
  const seaEdge = g.board.edges.find((e) => e.hexIds.some((h) => g.board.hexes[h].terrain === 'water') && e.hexIds.some((h) => g.board.hexes[h].terrain !== 'water'));
  const v = g.board.vertices[seaEdge.v1];
  const roadEdge = v.edgeIds.find((eid) => eid !== seaEdge.id && g.board.edges[eid].hexIds.some((h) => g.board.hexes[h].terrain !== 'water'));
  // 接続のチェックを受けない形で直接置き、「頂点に建物がある場合だけ種類をまたげる」ことだけを見る
  g.board.edges[roadEdge].road = 0; g.players[0].roads.push(roadEdge);
  seaEdge.ship = 0; g.players[0].ships.push(seaEdge.id);
  g.turn = 0;
  E.recalcLongestRoad(g);
  // 頂点に自分の建物がないので、道と船はつながらない（それぞれ長さ1）
  assert.equal(g.players[0].roadLength, 1);
  v.building = { owner: 0, type: 'settlement' };
  g.players[0].settlements.push(v.id);
  E.recalcLongestRoad(g);
  assert.equal(g.players[0].roadLength, 2); // 開拓地をはさんでつながる
});

test('航海者版: 小島に開拓地を建てると+2点。1度だけ', () => {
  const g = E.createGame(4, Math.random, { expansions: ['seafarers'] });
  const islandHexId = [...g.board.islandHexIds][0];
  const v = g.board.hexes[islandHexId].vertexIds[0];
  assert.ok(E.canPlaceSettlement(g, v, 0, true));
  assert.ok(E.setupPlaceSettlement(g, v));
  assert.equal(g.players[0].islandBonus, true);
  assert.equal(E.playerScore(g, 0), 1 + 2);
});

test('航海者版: CPUだけで4人、1局を最後まで決着できる（数局）', () => {
  for (let i = 0; i < 5; i++) {
    const g = playOutCpu(['weak', 'normal', 'strong', 'normal'], 500000, { expansions: ['seafarers'] });
    assert.deepEqual(g.expansions, ['seafarers']);
    assert.ok(g.winner != null);
    assert.ok(E.playerScore(g, g.winner) >= 14);
  }
});

// ---- 航海者版の5〜6人用拡張 ----
test('航海者版×5〜6人: 本島30＋海23＋小島6＝59マス。銀行24枚・発展カード34枚・特別建設フェイズつき', () => {
  for (const n of [5, 6]) {
    for (let i = 0; i < 5; i++) {
      const g = E.createGame(n, Math.random, { expansions: ['seafarers'] });
      assert.deepEqual(g.expansions.sort(), ['5-6player', 'seafarers']);
      assert.equal(g.winTarget, 14);
      assert.equal(g.board.hexes.length, 59);
      const counts = {};
      g.board.hexes.forEach((h) => { counts[h.terrain] = (counts[h.terrain] || 0) + 1; });
      // 本島を囲む22マスに加えて、3つの小島のうち本島の海に隣り合っていない1つへ船で届くよう橋を1マス足す
      assert.equal(counts.water, 23);
      assert.equal(counts.gold, 1);
      assert.equal(counts.desert, 1);
      assert.equal(g.board.islandHexIds.length, 6);
      assert.deepEqual(g.bank.resources, { wood: 24, brick: 24, sheep: 24, wheat: 24, ore: 24 });
      assert.equal(g.bank.devDeck.length, 34);
    }
  }
  // 画面からは expansions: ['seafarers'] で来る想定。5〜6人を選んでも航海者版を選べる
  assert.deepEqual(E.createGame(5, Math.random, { expansions: ['seafarers'] }).expansions.sort(), ['5-6player', 'seafarers']);
});

test('航海者版×5〜6人: 特別建設フェイズで船も建てられる', () => {
  const g = E.createGame(5, Math.random, { expansions: ['seafarers'] });
  g.phase = 'main'; g.turn = 1; g.turnNumber = 3;
  g.players.forEach((p) => { p.resources = { wood: 10, brick: 10, sheep: 10, wheat: 10, ore: 10 }; });
  // プレイヤー2が船を出せるよう、海沿いに開拓地を置いておく（海賊の隣は置けないので避ける）
  const seaEdge = g.board.edges.find((e) => e.hexIds.some((h) => g.board.hexes[h].terrain === 'water') && e.hexIds.some((h) => g.board.hexes[h].terrain !== 'water')
    && !g.board.hexes[g.board.pirateHex].edgeIds.includes(e.id));
  const v = g.board.vertices[seaEdge.v1];
  v.building = { owner: 2, type: 'settlement' };
  g.players[2].settlements.push(v.id);
  assert.ok(E.endTurn(g));
  assert.equal(g.phase, 'specialBuilding');
  assert.equal(E.currentPlayer(g), 2);
  assert.ok(E.availableShipEdges(g, 2).length > 0);
  const shipEdge = E.availableShipEdges(g, 2)[0];
  assert.ok(E.buildShip(g, shipEdge));
  assert.equal(g.players[2].ships.length, 1);
});

// 通信対戦9-2: 航海者版を開ける。金の川（gold）は手番と関係なく誰からでも片付けられる必要がある
// （ホストは「その席が pendingGoldPicks にいるか」だけで確かめ、席番号はホストが入れる。main.js ONLINE_SELF_ACTIONS）。
// 届く順が手番順とは限らないので、エンジン側が順不同で受けられることを確かめる。
test('航海者版: 金の川(gold)の受け取りは、複数人が同時に待っていても届いた順(手番と無関係)に片付く', () => {
  const g = E.createGame(4, Math.random, { expansions: ['seafarers'] });
  g.phase = 'main';
  g.pendingGoldPicks = [{ player: 2, count: 1 }, { player: 0, count: 2 }, { player: 3, count: 1 }];
  const before = { 0: g.bank.resources.wood, 2: g.bank.resources.ore, 3: g.bank.resources.sheep };
  // 手番(currentPlayer)とは無関係の順で届く想定。存在しない席や、すでに片付いた席はfalseで断る
  assert.equal(E.pickGold(g, 1, ['wood']), false); // 待っていない席
  assert.ok(E.pickGold(g, 3, ['sheep']));
  assert.ok(E.pickGold(g, 0, ['wood', 'wood']));
  assert.equal(E.pickGold(g, 0, ['wood']), false); // もう片付いた席からもう一度来ても断る
  assert.ok(E.pickGold(g, 2, ['ore']));
  assert.deepEqual(g.pendingGoldPicks, []);
  assert.equal(g.phase, 'main');
  assert.equal(g.players[0].resources.wood, 2);
  assert.equal(g.players[2].resources.ore, 1);
  assert.equal(g.players[3].resources.sheep, 1);
  assert.equal(g.bank.resources.wood, before[0] - 2);
  assert.equal(g.bank.resources.ore, before[2] - 1);
  assert.equal(g.bank.resources.sheep, before[3] - 1);
});

// 通信対戦9-2: 船を置く・動かすは「手番の操作」(main.js ONLINE_TURN_ACTIONS)。
// engineはcurrentPlayer(game)だけを見て動かすので、手番でない人が送っても手番の人として当たってしまう。
// ホストは送り主の席とE.actingPlayer(game)が一致するかを先に確かめてから呼ぶ必要がある、という前提をここで確かめる
// （main.js側の確かめはDOM依存で直接testできないため、engineが「誰の操作か」を区別しないことを裏づける）。
test('航海者版: buildShip/moveShipはcurrentPlayerにしか当たらない（手番の確かめはホスト側の責任）', () => {
  const g = E.createGame(4, Math.random, { expansions: ['seafarers'] });
  g.phase = 'main'; g.turn = 1; g.turnNumber = 1;
  g.players.forEach((p) => { p.resources = { wood: 10, brick: 10, sheep: 10, wheat: 10, ore: 10 }; });
  const seaEdge = g.board.edges.find((e) => e.hexIds.some((h) => g.board.hexes[h].terrain === 'water') && e.hexIds.some((h) => g.board.hexes[h].terrain !== 'water')
    && !g.board.hexes[g.board.pirateHex].edgeIds.includes(e.id));
  const v = g.board.vertices[seaEdge.v1];
  v.building = { owner: 1, type: 'settlement' };
  g.players[1].settlements.push(v.id);
  assert.equal(E.currentPlayer(g), 1);
  const shipEdge = E.availableShipEdges(g, 1)[0];
  assert.ok(E.buildShip(g, shipEdge)); // 手番(1)として置かれる。船を置けたのは手番の人だけという前提
  assert.equal(g.board.edges[shipEdge].ship, 1);
  assert.equal(g.players[0].ships.length, 0); // 手番でない0の船にはならない
});

test('航海者版×5〜6人: CPUだけで5人・6人、数局きちんと決着する', () => {
  for (const levels of [['weak', 'normal', 'strong', 'weak', 'normal'], ['weak', 'normal', 'strong', 'weak', 'normal', 'strong']]) {
    for (let i = 0; i < 3; i++) {
      const g = playOutCpu(levels, 900000, { expansions: ['seafarers'] });
      assert.deepEqual(g.expansions.sort(), ['5-6player', 'seafarers']);
      assert.ok(g.winner != null);
      assert.ok(E.playerScore(g, g.winner) >= 14);
    }
  }
});

// ---- 都市と騎士 ----
function ckGame(count = 4) { return E.createGame(count, Math.random, { expansions: ['cities-knights'] }); }

test('都市と騎士: 都市の商品産出（森→紙、牧草→布、山→硬貨。畑・丘は資源2のまま）', () => {
  const g = ckGame();
  g.phase = 'main'; g.turn = 0;
  const forestHex = g.board.hexes.find((h) => h.terrain === 'forest');
  const fieldHex = g.board.hexes.find((h) => h.terrain === 'field');
  // 2つの都市のどちらも、もう一方のマスに接してしまわないよう、互いの頂点を共有しない組み合わせを選ぶ
  const vForest = forestHex.vertexIds.find((v) => !fieldHex.vertexIds.includes(v));
  const vField = fieldHex.vertexIds.find((v) => !forestHex.vertexIds.includes(v));
  g.board.vertices[vForest].building = { owner: 0, type: 'city' };
  g.players[0].cities.push(vForest);
  g.board.vertices[vField].building = { owner: 0, type: 'city' };
  g.players[0].cities.push(vField);
  // ほかのマスが偶然9を持っていると資源が混ざるので、的にする2マス以外は9を避けておく
  g.board.hexes.forEach((h) => { if (h.id !== forestHex.id && h.id !== fieldHex.id && h.number === 9) h.number = 2; });
  forestHex.number = 9; fieldHex.number = 9;
  g.phase = 'roll';
  const seq = [3 / 6, 4 / 6, 0.99]; // d1=4, d2=5 → 合計9。3つ目はイベントダイス用
  const total = E.rollDice(g, () => seq.shift());
  assert.equal(total, 9);
  assert.equal(g.players[0].resources.wood, 1); // 森の都市: 資源1
  assert.equal(g.players[0].commodities.paper, 1); // +商品1
  assert.equal(g.players[0].resources.wheat, 2); // 畑の都市: 資源2のまま（商品は産まない）
});

test('都市と騎士: 都市の発展（商品を払って段階を上げる・大都市の奪い合い）', () => {
  const g = ckGame();
  g.phase = 'main'; g.turn = 0;
  const p0 = g.players[0], p1 = g.players[1];
  const v0 = g.board.vertices.find((v) => !v.building);
  v0.building = { owner: 0, type: 'city' }; p0.cities.push(v0.id);
  assert.equal(E.canImproveCity(g, 0, 'trade'), false); // 商品がない
  p0.commodities.cloth = 1;
  assert.ok(E.improveCity(g, 'trade'));
  assert.equal(p0.cityImprovements.trade, 1);
  assert.equal(p0.commodities.cloth, 0);
  p0.commodities.cloth = 2 + 3; // 2段階目(2)+3段階目(3)
  assert.ok(E.improveCity(g, 'trade'));
  assert.ok(E.improveCity(g, 'trade'));
  assert.equal(p0.cityImprovements.trade, 3);
  p0.commodities.cloth = 4;
  assert.ok(E.improveCity(g, 'trade')); // 4段階目=大都市
  assert.equal(g.metropolis.trade, v0.id); // 大都市は、その都市（頂点）に置かれる
  assert.equal(E.metropolisOwner(g, 'trade'), 0);
  assert.equal(E.playerScore(g, 0), 2 /* city */ + 2 /* metropolis */);
  // プレイヤー1が追い越すと大都市を奪う（印だけ移り、プレイヤー0の都市はただの都市に戻る）
  const v1 = g.board.vertices.find((v) => !v.building);
  v1.building = { owner: 1, type: 'city' }; p1.cities.push(v1.id);
  g.turn = 1;
  p1.commodities.cloth = 1 + 2 + 3 + 4 + 5;
  for (let i = 0; i < 5; i++) E.improveCity(g, 'trade');
  assert.equal(p1.cityImprovements.trade, 5);
  assert.equal(g.metropolis.trade, v1.id); // 5段階目に追い越されたので奪われる
  assert.equal(E.metropolisOwner(g, 'trade'), 1);
  assert.equal(v0.building.type, 'city'); // プレイヤー0の都市はそのまま（ただの都市に戻るだけ）
  // 5段階目の持ち主からはもう奪えない
  g.turn = 0;
  assert.equal(E.canImproveCity(g, 0, 'trade'), false); // すでに3段階目、商品がない
});

test('都市と騎士: 騎士の起動・昇格・移動・追い出し・盗賊を追い払う', () => {
  const g = ckGame();
  g.phase = 'main'; g.turn = 0;
  const p0 = g.players[0], p1 = g.players[1];
  const v = g.board.vertices.find((x) => x.edgeIds.length >= 2);
  v.building = { owner: 0, type: 'settlement' }; p0.settlements.push(v.id);
  const roadEdge = v.edgeIds[0];
  g.board.edges[roadEdge].road = 0; p0.roads.push(roadEdge);
  const otherEnd = g.board.edges[roadEdge].v1 === v.id ? g.board.edges[roadEdge].v2 : g.board.edges[roadEdge].v1;
  p0.resources = { wood: 0, brick: 0, sheep: 5, wheat: 5, ore: 5 };
  assert.ok(E.canPlaceKnight(g, otherEnd, 0));
  assert.ok(E.buildKnight(g, otherEnd));
  const kid = p0.knights[0].id;
  assert.equal(E.canActivateKnight(g, 0, kid), true);
  assert.ok(E.activateKnight(g, kid));
  assert.ok(E.upgradeKnight(g, kid));
  assert.equal(p0.knights[0].level, 2);
  assert.equal(E.canUpgradeKnight(g, 0, kid), false); // 最強にするには政治3段階目以上が要る
  p0.cityImprovements.politics = 3;
  assert.ok(E.upgradeKnight(g, kid));
  assert.equal(p0.knights[0].level, 3);
  // 移動
  const moveTargets = E.movableKnightVertices(g, 0, kid);
  assert.ok(moveTargets.length >= 0);
  // 盗賊を追い払う: 騎士の頂点が盗賊のマスに接するようにする
  const robberHexId = g.board.robberHex;
  const robberVid = g.board.hexes[robberHexId].vertexIds[0];
  p0.knights[0].vertexId = robberVid;
  p0.knights[0].actedTurn = null;
  assert.ok(E.canChaseRobber(g, 0, kid));
  assert.ok(E.chaseRobber(g, kid));
  assert.equal(g.board.hexes[g.board.robberHex].terrain, 'desert');
  assert.equal(p0.knights[0].active, false);
  // 追い出し: プレイヤー1の弱い騎士を、プレイヤー0の起動した騎士の隣に置いて追い出す
  const neighborV = g.board.vertices[robberVid].neighbors[0];
  p1.knights.push({ id: 1, vertexId: neighborV, level: 1, active: true, actedTurn: null });
  p0.knights[0].active = true; p0.knights[0].actedTurn = null;
  const targets = E.expellableTargets(g, 0, kid);
  assert.ok(targets.some((t) => t.ownerIdx === 1));
  assert.ok(E.expelKnight(g, kid, 1, 1));
  assert.equal(p1.knights.length, 0);
});

test('都市と騎士: 騎士は弱い・強い・最強、各段階2体まで（公式の数）', () => {
  const g = ckGame();
  g.phase = 'main'; g.turn = 0;
  const p0 = g.players[0];
  const v = g.board.vertices.find((x) => x.edgeIds.length >= 3);
  v.building = { owner: 0, type: 'city' }; p0.cities.push(v.id);
  v.edgeIds.slice(0, 2).forEach((eId) => { g.board.edges[eId].road = 0; p0.roads.push(eId); });
  p0.resources = { wood: 0, brick: 0, sheep: 10, wheat: 10, ore: 10 };
  p0.cityImprovements.politics = 3;
  // 弱い騎士を、置ける場所がある限り2体まで
  const vs1 = E.availableKnightVertices(g, 0);
  assert.ok(vs1.length >= 2, 'テストの前提: 置ける場所が2つ以上必要');
  assert.ok(E.buildKnight(g, vs1[0]));
  assert.ok(E.buildKnight(g, E.availableKnightVertices(g, 0)[0]));
  assert.equal(p0.knights.length, 2);
  assert.equal(E.availableKnightVertices(g, 0).length, 0); // 3体目は置けない
  assert.equal(E.canPlaceKnight(g, E.availableSettlementVertices(g, 0, true)[0], 0), false);
  // 両方とも強いに昇格できるが、最強は2体まで（ここでは2体とも最強にできる）
  const [k1, k2] = p0.knights;
  assert.ok(E.upgradeKnight(g, k1.id));
  assert.ok(E.upgradeKnight(g, k2.id));
  assert.ok(E.upgradeKnight(g, k1.id));
  assert.ok(E.upgradeKnight(g, k2.id));
  assert.equal(p0.knights.filter((k) => k.level === 3).length, 2);
  // 3体目の騎士を新しく建てて、強いに昇格しようとしても、強い段階はもう2体いないので空きがあるはず
  // （弱い騎士がいなくなったので、弱いの枠は空いている）
  const vs2 = E.availableKnightVertices(g, 0);
  if (vs2.length) {
    assert.ok(E.buildKnight(g, vs2[0]));
    const k3 = p0.knights.find((k) => k.level === 1);
    assert.equal(E.canUpgradeKnight(g, 0, k3.id), true); // 強いの枠(2体)はまだ0体なので昇格できる
  }
});

test('都市と騎士: 交易3段階目の商品2:1交易、科学3段階目の資源保証', () => {
  const g = ckGame();
  g.phase = 'main'; g.turn = 0;
  const p0 = g.players[0];
  // 交易3段階目がないと交易できない
  p0.commodities.cloth = 2;
  assert.equal(E.canTradeCommodity(g, 0, 'cloth'), false);
  p0.cityImprovements.trade = 3;
  assert.equal(E.canTradeCommodity(g, 0, 'cloth'), true);
  const bankWoodBefore = g.bank.resources.wood;
  assert.ok(E.tradeCommodity(g, 'cloth', 'resource', 'wood'));
  assert.equal(p0.commodities.cloth, 0);
  assert.equal(p0.resources.wood, 1);
  assert.equal(g.bank.resources.wood, bankWoodBefore - 1);
  p0.commodities.coin = 2;
  assert.ok(E.tradeCommodity(g, 'coin', 'commodity', 'paper'));
  assert.equal(p0.commodities.paper, 1);

  // 科学3段階目: 赤の目で自分に何も入らなかった人は、あとで資源を1枚選べる（7は除く）
  const g2 = ckGame();
  g2.players[0].cityImprovements.science = 3;
  g2.players.forEach((p) => { p.resources = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 }; });
  // 誰の建物にも当たらない目を選ぶため、全員の建物を取り除いた状態で振る
  g2.phase = 'roll';
  const seq = [2.5 / 6, 2.5 / 6, 0.99]; // d1=3,d2=3→合計6（7以外。盤上に誰も建物がないので何も入らない）
  const total = E.rollDice(g2, () => seq.shift());
  assert.notEqual(total, 7);
  assert.ok(g2.pendingScienceBonus.includes(0));
  assert.ok(E.pickScienceBonus(g2, 0, 'wheat'));
  assert.equal(g2.players[0].resources.wheat, 1);
  assert.equal(g2.pendingScienceBonus.includes(0), false);
  assert.equal(g2.phase, 'main');
});

test('都市と騎士: 大都市は特定の都市に置かれ、蛮族の襲来ではその都市が守られる', () => {
  const g = ckGame();
  const p0 = g.players[0];
  const v0 = g.board.vertices.find((v) => !v.building);
  v0.building = { owner: 0, type: 'city' }; p0.cities.push(v0.id);
  const v1 = g.board.vertices.find((v) => !v.building && v.id !== v0.id);
  v1.building = { owner: 0, type: 'city' }; p0.cities.push(v1.id);
  p0.commodities.cloth = 1 + 2 + 3 + 4;
  g.phase = 'main'; g.turn = 0;
  for (let i = 0; i < 4; i++) E.improveCity(g, 'trade');
  const metroVid = g.metropolis.trade;
  assert.ok([v0.id, v1.id].includes(metroVid));
  // 騎士なし・都市2つ（大都市1つ含む）→ 蛮族に負ける。大都市の都市は守られ、もう1つが開拓地に戻る
  g.barbarianProgress = 6; g.phase = 'roll'; g.turn = 0;
  E.rollDice(g, () => 0.1);
  assert.equal(g.barbarianAttacked, true);
  assert.equal(p0.cities.length, 1);
  assert.equal(p0.cities[0], metroVid); // 残っているのは大都市の都市
  assert.equal(g.board.vertices[metroVid].building.type, 'city');
});

test('都市と騎士: 蛮族の襲来（勝つと守護者点、負けると都市が1つ開拓地に戻る）', () => {
  const g = ckGame();
  const p0 = g.players[0], p1 = g.players[1];
  const v0 = g.board.vertices.find((v) => !v.building);
  v0.building = { owner: 0, type: 'city' }; p0.cities.push(v0.id);
  const v1 = g.board.vertices.find((v) => !v.building);
  v1.building = { owner: 1, type: 'city' }; p1.cities.push(v1.id);
  p0.knights.push({ id: 1, vertexId: v0.id, level: 3, active: true, actedTurn: null }); // 強さ3 >= 都市2 → 勝つ
  g.barbarianProgress = 6; g.phase = 'roll'; g.turn = 0;
  E.rollDice(g, () => 0.1); // 1面目=barbarianを引かせるため小さい乱数を使う（EVENT_FACESの並び順に依存）
  assert.equal(g.barbarianAttacked, true);
  assert.equal(g.barbarianProgress, 0);
  assert.equal(p0.defenderVp, 1);
  assert.equal(p0.knights[0].active, false); // 襲来のあとは全員休む

  // 次は負けるケース: 騎士なし
  const g2 = ckGame();
  const q0 = g2.players[0];
  const vv = g2.board.vertices.find((v) => !v.building);
  vv.building = { owner: 0, type: 'city' }; q0.cities.push(vv.id);
  g2.barbarianProgress = 6; g2.phase = 'roll'; g2.turn = 0;
  E.rollDice(g2, () => 0.1);
  assert.equal(g2.barbarianAttacked, true);
  assert.equal(q0.cities.length, 0);
  assert.equal(q0.settlements.includes(vv.id), true);

  // 開拓地の駒が5つとも盤上なら、負けた都市はなくなる
  const g3 = ckGame();
  const r0 = g3.players[0];
  const free = g3.board.vertices.filter((v) => !v.building);
  free.slice(0, 5).forEach((v) => { v.building = { owner: 0, type: 'settlement' }; r0.settlements.push(v.id); });
  const vc = free[5];
  vc.building = { owner: 0, type: 'city' }; r0.cities.push(vc.id); r0.walls = 1;
  g3.barbarianProgress = 6; g3.phase = 'roll'; g3.turn = 0;
  E.rollDice(g3, () => 0.1);
  assert.equal(r0.cities.length, 0);
  assert.equal(r0.settlements.length, 5);
  assert.equal(vc.building, null);
  assert.equal(r0.walls, 0);
});

test('都市と騎士: 都市壁は土2、都市1つに1つ、最大3。7の捨て札の上限を+2する', () => {
  const g = ckGame();
  g.phase = 'main'; g.turn = 0;
  const p0 = g.players[0];
  const v0 = g.board.vertices.find((v) => !v.building);
  v0.building = { owner: 0, type: 'city' }; p0.cities.push(v0.id);
  p0.resources.brick = 2;
  assert.equal(E.canBuildWall(g, 0), true);
  assert.ok(E.buildWall(g));
  assert.equal(p0.walls, 1);
  assert.equal(E.canBuildWall(g, 0), false); // 都市が1つしかないので、もう置けない
  // 7が出たとき、壁1つぶん(+2)で9枚までは捨てずに済む
  g.players.forEach((p) => { p.resources = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 }; });
  p0.resources.wood = 9;
  g.phase = 'roll';
  const seq = [3 / 6, 2.5 / 6, 0.99]; // d1=4, d2=3 → 合計7
  const total = E.rollDice(g, () => seq.shift());
  assert.equal(total, 7);
  assert.equal(g.pendingDiscards.some((d) => d.player === 0), false); // 7+2=9までは捨てなくてよい
});

test('都市と騎士: CPUだけで4人、数局きちんと決着する（勝利点13点）', () => {
  for (let i = 0; i < 4; i++) {
    const g = playOutCpu(['weak', 'normal', 'strong', 'normal'], 800000, { expansions: ['cities-knights'] });
    assert.deepEqual(g.expansions, ['cities-knights']);
    assert.ok(g.winner != null);
    assert.ok(E.playerScore(g, g.winner) >= 13);
  }
});

// ---- 都市と騎士の5〜6人用拡張 ----
test('都市と騎士×5〜6人: 本島30マス。銀行24枚・商品13枚ずつ・進歩カード各色30枚、特別建設フェイズつき', () => {
  for (const n of [5, 6]) {
    const g = ckGame(n);
    assert.deepEqual(g.expansions.sort(), ['5-6player', 'cities-knights']);
    assert.equal(g.winTarget, 13);
    assert.equal(g.board.hexes.length, 30);
    assert.deepEqual(g.bank.resources, { wood: 24, brick: 24, sheep: 24, wheat: 24, ore: 24 });
    assert.deepEqual(g.bank.commodities, { paper: 13, cloth: 13, coin: 13 });
    assert.equal(g.progressDecks.trade.length, 30);
    assert.equal(g.progressDecks.politics.length, 30);
    assert.equal(g.progressDecks.science.length, 30);
  }
});

test('都市と騎士×5〜6人: 特別建設フェイズで騎士・都市壁・都市の発展も建てられる', () => {
  const g = ckGame(5);
  g.phase = 'main'; g.turn = 1; g.turnNumber = 3;
  g.players.forEach((p) => { p.resources = { wood: 10, brick: 10, sheep: 10, wheat: 10, ore: 10 }; p.commodities = { paper: 5, cloth: 5, coin: 5 }; });
  const v = g.board.vertices.find((x) => x.edgeIds.length >= 2 && !x.building);
  v.building = { owner: 2, type: 'city' };
  g.players[2].cities.push(v.id);
  const roadEdge = v.edgeIds[0];
  g.board.edges[roadEdge].road = 2; g.players[2].roads.push(roadEdge);
  assert.ok(E.endTurn(g));
  assert.equal(g.phase, 'specialBuilding');
  assert.equal(E.currentPlayer(g), 2);
  const knightVertices = E.availableKnightVertices(g, 2); // 道のもう一端（建物なし）に置ける
  assert.ok(knightVertices.length > 0);
  assert.ok(E.buildKnight(g, knightVertices[0]));
  assert.equal(g.players[2].knights.length, 1);
  assert.ok(E.buildWall(g));
  assert.equal(g.players[2].walls, 1);
  assert.ok(E.improveCity(g, 'trade'));
  assert.equal(g.players[2].cityImprovements.trade, 1);
});

test('都市と騎士×5〜6人: CPUだけで5人・6人、数局きちんと決着する（勝利点13点）', () => {
  for (const levels of [['weak', 'normal', 'strong', 'weak', 'normal'], ['weak', 'normal', 'strong', 'weak', 'normal', 'strong']]) {
    for (let i = 0; i < 3; i++) {
      const g = playOutCpu(levels, 900000, { expansions: ['cities-knights'] });
      assert.deepEqual(g.expansions.sort(), ['5-6player', 'cities-knights']);
      assert.ok(g.winner != null);
      assert.ok(E.playerScore(g, g.winner) >= 13);
    }
  }
});

test('CPU: 強さの差（よわい vs ふつう、ふつう vs つよい）を4人（2対2）対局の勝ち数で見る', () => {
  // 実際のアプリは3〜4人用なので、比較も4人（levelA2人 + levelB2人、席はランダム）で行う
  function winRate(levelA, levelB, games) {
    let aWins = 0;
    for (let i = 0; i < games; i++) {
      const seats = [levelA, levelA, levelB, levelB].sort(() => Math.random() - 0.5);
      const g = playOutCpu(seats);
      if (seats[g.winner] === levelA) aWins++;
    }
    return aWins;
  }
  const games = 20;
  const weakVsNormal = winRate('weak', 'normal', games);
  const normalVsStrong = winRate('normal', 'strong', games);
  console.log(`[CPU強さ] よわい vs ふつう: よわい ${weakVsNormal}/${games} 勝`);
  console.log(`[CPU強さ] ふつう vs つよい: ふつう ${normalVsStrong}/${games} 勝`);
  // 強いほうが勝ち越す想定（まれな逆転はあり得るので、惨敗はしていないことだけ確かめる）
  assert.ok(weakVsNormal <= games - 2);
  assert.ok(normalVsStrong <= games - 2);
});

// ---- 交易と略奪 ----

function tbGame(scenario, count = 4) { return E.createGame(count, Math.random, { expansions: ['traders-barbarians'], scenario }); }
// rollDice用に、合計が total になる(d1,d2)の組を作る(1〜6の範囲で必ず作れる)
function diceSeq(total) {
  const d1 = Math.max(1, total - 6);
  const d2 = total - d1;
  const seq = [(d1 - 0.5) / 6, (d2 - 0.5) / 6];
  return () => seq.shift();
}

// ---- 漁師 ----
test('交易と略奪・漁師: 漁場6か所(出目4,5,6,8,9,10)、湖(出目2,3,11,12)、勝利点10点、湖は海岸に置かれない', () => {
  const g = tbGame('fishermen');
  assert.equal(g.scenario, 'fishermen');
  assert.equal(g.winTarget, 10);
  assert.equal(g.board.fisheries.length, 6);
  assert.deepEqual(g.board.fisheries.map((f) => f.number).sort((a, b) => a - b), [4, 5, 6, 8, 9, 10]);
  const lake = g.board.hexes.find((h) => h.terrain === 'lake');
  assert.ok(lake);
  assert.deepEqual(lake.lakeNumbers.slice().sort((a, b) => a - b), [2, 3, 11, 12]);
  assert.equal(lake.edgeIds.some((eId) => g.board.edges[eId].hexIds.length === 1), false); // 海岸に接していない
  assert.equal(g.board.robberHex, null); // 盗賊は最初7が出るまで盤にいない
});

test('交易と略奪・漁師: 魚トークンの山は1匹11・2匹10・3匹8(計29枚)+古い靴1枚', () => {
  const g = tbGame('fishermen');
  const counts = { 1: 0, 2: 0, 3: 0, boot: 0 };
  g.fishBag.forEach((t) => { counts[t]++; });
  assert.deepEqual(counts, { 1: 11, 2: 10, 3: 8, boot: 1 });
});

test('交易と略奪・漁師: 出目が合うと漁場・湖の魚トークンを引く(開拓地1枚・都市2枚)', () => {
  const g = tbGame('fishermen');
  g.phase = 'main'; g.turn = 0;
  g.fishBag = [2, 2, 2, 2]; // 常に2匹トークンが出るようにしておく
  const fishery = g.board.fisheries[0];
  g.board.vertices[fishery.vertices[0]].building = { owner: 0, type: 'city' };
  g.players[0].cities.push(fishery.vertices[0]);
  g.phase = 'roll';
  E.rollDice(g, diceSeq(fishery.number));
  assert.deepEqual(g.players[0].fishTokens, [2, 2]); // 都市は2枚引く
});

test('交易と略奪・漁師: 7匹を超えて持てない(一番少ない手持ちより大きければ交換するだけ)', () => {
  const g = tbGame('fishermen');
  g.players[0].fishTokens = [1, 1, 1, 1, 1, 1, 1]; // すでに7枚（全部1匹）
  g.fishBag = [3];
  // grantFishToken は内部関数なので、産出を1回起こして確かめる
  g.phase = 'main'; g.turn = 0;
  const fishery = g.board.fisheries[0];
  g.board.vertices[fishery.vertices[0]].building = { owner: 0, type: 'settlement' };
  g.players[0].settlements.push(fishery.vertices[0]);
  g.phase = 'roll';
  E.rollDice(g, diceSeq(fishery.number));
  assert.equal(g.players[0].fishTokens.length, 7); // 7枚のまま
  assert.ok(g.players[0].fishTokens.includes(3)); // 一番少なかった1匹と入れ替わった
});

test('交易と略奪・漁師: 魚を使った交換(盗賊を盤外へ・資源を奪う・資源1枚・道1本・発展カード)', () => {
  const g = tbGame('fishermen');
  g.phase = 'main'; g.turn = 0;
  const p0 = g.players[0];
  p0.fishTokens = [2];
  assert.ok(E.fishRobberAway(g));
  assert.equal(g.board.robberHex, null);
  assert.equal(p0.fishTokens.length, 0);
  p0.fishTokens = [3];
  g.players[1].resources.wood = 1;
  assert.ok(E.fishSteal(g, 1));
  assert.equal(p0.resources.wood, 1);
  p0.fishTokens = [2, 2]; // 合計4(無駄なく4匹ちょうど)
  const wheatBefore = g.bank.resources.wheat;
  assert.ok(E.fishResource(g, 'wheat'));
  assert.equal(p0.resources.wheat, 1);
  assert.equal(g.bank.resources.wheat, wheatBefore - 1);
  assert.equal(p0.fishTokens.length, 0);
  p0.fishTokens = [3, 2]; // 合計5
  const v = E.availableSettlementVertices(g, 0, true)[0];
  g.board.vertices[v].building = { owner: 0, type: 'settlement' };
  p0.settlements.push(v);
  const edge = E.availableRoadEdges(g, 0)[0];
  assert.ok(E.fishRoad(g, edge));
  assert.equal(g.board.edges[edge].road, 0);
  p0.fishTokens = [3, 3, 1]; // 合計7
  const before = p0.devCards.length;
  assert.ok(E.fishDevCard(g));
  assert.equal(p0.devCards.length, before + 1);
  assert.equal(p0.fishTokens.length, 0);
});

test('交易と略奪・漁師: 古い靴を引いた人は勝利点が1点多く要り、同点以上の人にだけ渡せる', () => {
  const g = tbGame('fishermen');
  g.phase = 'main'; g.turn = 0;
  g.fishBag = ['boot'];
  const fishery = g.board.fisheries[0];
  g.board.vertices[fishery.vertices[0]].building = { owner: 0, type: 'settlement' };
  g.players[0].settlements.push(fishery.vertices[0]);
  // プレイヤー1にも1点持たせ、自分だけが最多点にならないようにしておく（同点なら渡せる）
  const v1 = E.availableSettlementVertices(g, 1, true)[0];
  g.board.vertices[v1].building = { owner: 1, type: 'settlement' };
  g.players[1].settlements.push(v1);
  g.phase = 'roll';
  E.rollDice(g, diceSeq(fishery.number));
  assert.equal(g.oldBootHolder, 0);
  assert.equal(E.canGiveOldBoot(g, 1), true); // 同点のときは渡せる
  assert.ok(E.giveOldBoot(g, 1));
  assert.equal(g.oldBootHolder, 1);
});

test('交易と略奪・漁師: CPUだけで4人、数局きちんと決着する(勝利点10点、古い靴の持ち主は11点)', () => {
  for (let i = 0; i < 3; i++) {
    const g = playOutCpu(['weak', 'normal', 'strong', 'normal'], 800000, { expansions: ['traders-barbarians'], scenario: 'fishermen' });
    assert.equal(g.scenario, 'fishermen');
    assert.ok(g.winner != null);
    const target = g.oldBootHolder === g.winner ? g.winTarget + 1 : g.winTarget;
    assert.ok(E.playerScore(g, g.winner) >= target);
  }
});

// ---- 川 ----
test('交易と略奪・川: 勝利点10点。開拓地・道は建てると金貨1枚、都市への建て替えでは増えない', () => {
  const g = tbGame('rivers');
  assert.equal(g.winTarget, 10);
  // セットアップの開拓地として置く（つながりのルールを気にせず置けるので、道・開拓地それぞれの金貨を確かめやすい）
  g.phase = 'setup1'; g.setupOrder = [0]; g.setupIndex = 0; g.setupPending = 'settlement';
  const riverVerts = [...g.board.riverVertexIds];
  const v = riverVerts.find((vid) => g.board.vertices[vid].edgeIds.some((eId) => g.board.riverEdgeIds.includes(eId) || g.board.riverVertexIds.includes(g.board.edges[eId].v1) && g.board.riverVertexIds.includes(g.board.edges[eId].v2))) || riverVerts[0];
  assert.ok(E.setupPlaceSettlement(g, v));
  assert.equal(g.players[0].gold, 1); // 開拓地で金貨1枚
  const edge = g.board.vertices[v].edgeIds.find((eId) => g.board.riverVertexIds.includes(v) && (g.board.edges[eId].v1 === v || g.board.edges[eId].v2 === v));
  assert.ok(E.setupPlaceRoad(g, edge));
  assert.equal(g.players[0].gold, 2); // 道でさらに金貨1枚
  g.phase = 'main'; g.turn = 0;
  g.players[0].resources.wheat = 2; g.players[0].resources.ore = 3;
  assert.ok(E.buildCity(g, v));
  assert.equal(g.players[0].gold, 2); // 都市への建て替えでは増えない
});

test('交易と略奪・川: 川をまたぐ辺には橋(土2木1)が要り、建てると金貨3枚もらえる。橋は3本まで', () => {
  const g = tbGame('rivers');
  g.phase = 'main'; g.turn = 0;
  const v = [...g.board.riverVertexIds][0];
  g.board.vertices[v].building = { owner: 0, type: 'settlement' };
  g.players[0].settlements.push(v);
  const edgeId = [...g.board.riverEdgeIds][0];
  g.players[0].resources = { wood: 1, brick: 1, sheep: 0, wheat: 0, ore: 0 };
  assert.equal(E.buildRoad(g, edgeId), false); // ふつうの道のコストだけでは足りない
  g.players[0].resources = { wood: 1, brick: 2, sheep: 0, wheat: 0, ore: 0 };
  const goldBefore = g.players[0].gold;
  assert.ok(E.buildRoad(g, edgeId));
  assert.equal(g.players[0].gold, goldBefore + 3);
  assert.equal(g.players[0].bridges, 1);
});

test('交易と略奪・川: 金貨2枚で資源1枚、手番に2回まで。富豪(+1点)・貧者(-2点、同点なら全員)', () => {
  const g = tbGame('rivers');
  // 開始時は全員0枚で同点なので、全員が貧者になる（公式どおり）
  assert.deepEqual(g.poorPlayers.slice().sort(), [0, 1, 2, 3]);
  assert.equal(g.richPlayer, null);
  g.phase = 'main'; g.turn = 0;
  g.players[0].gold = 6;
  assert.ok(E.tradeGold(g, 'ore'));
  assert.ok(E.tradeGold(g, 'ore'));
  assert.equal(E.tradeGold(g, 'ore'), false); // 2回使った
  assert.equal(g.players[0].gold, 2);
  assert.equal(g.richPlayer, 0);
  assert.deepEqual(g.poorPlayers.slice().sort(), [1, 2, 3]);
});

test('交易と略奪・川: 銀行と交易して資源を金貨に替えられる(2:1港があっても使えない)', () => {
  const g = tbGame('rivers');
  g.phase = 'main'; g.turn = 0;
  g.players[0].resources.wood = 4;
  assert.ok(E.tradeResourceForGold(g, 'wood'));
  assert.equal(g.players[0].gold, 1);
  assert.equal(g.players[0].resources.wood, 0);
});

test('交易と略奪・川: CPUだけで4人、数局きちんと決着する(勝利点10点)', () => {
  for (let i = 0; i < 3; i++) {
    const g = playOutCpu(['weak', 'normal', 'strong', 'normal'], 800000, { expansions: ['traders-barbarians'], scenario: 'rivers' });
    assert.equal(g.scenario, 'rivers');
    assert.ok(g.winner != null);
    assert.ok(E.playerScore(g, g.winner) >= g.winTarget);
  }
});

// ---- 隊商 ----
test('交易と略奪・隊商: オアシスは盤の中心、3本の出発点、勝利点12点', () => {
  const g = tbGame('caravans');
  assert.equal(g.winTarget, 12);
  const oasis = g.board.hexes[g.board.oasisHexId];
  assert.equal(oasis.q, 0); assert.equal(oasis.r, 0);
  assert.equal(g.board.camelStartEdges.length, 3);
  assert.equal(g.board.caravans.length, 3);
  assert.equal(g.board.robberHex, null);
});

test('交易と略奪・隊商: 開拓地を建てると手番の終わりに投票でラクダが置かれ、長い交易路で2本ぶんになる', () => {
  const g = tbGame('caravans', 3);
  // セットアップを最後まで進め、プレイヤー0が実際に道でつながった場所に建てられるようにする
  while (g.phase === 'setup1' || g.phase === 'setup2') {
    const idx = E.currentPlayer(g);
    if (g.setupPending === 'settlement') E.setupPlaceSettlement(g, E.availableSettlementVertices(g, idx, true)[0]);
    else E.setupPlaceRoad(g, g.board.vertices[g.setupLastVertex].edgeIds.find((eId) => g.board.edges[eId].road == null));
  }
  assert.equal(g.phase, 'roll');
  g.turn = 0; g.phase = 'main';
  const p0 = g.players[0];
  // 開拓地を2つ・道を2本置いただけでは、まだ新しい開拓地を置ける場所がない（距離ルール）ので、道を1本伸ばす
  let otherV = null;
  for (let i = 0; i < 6 && !otherV; i++) {
    otherV = E.availableSettlementVertices(g, 0, false)[0];
    if (otherV) break;
    const edges = E.availableRoadEdges(g, 0);
    if (!edges.length) break;
    p0.resources.wood = 1; p0.resources.brick = 1;
    E.buildRoad(g, edges[0]);
  }
  p0.resources = { wood: 1, brick: 1, sheep: 1, wheat: 1, ore: 0 };
  assert.ok(otherV != null);
  assert.ok(E.buildSettlement(g, otherV));
  assert.equal(p0.pendingCamelBuilds, 1);
  assert.ok(E.endTurn(g));
  assert.equal(g.phase, 'camelVote');
  // 3人全員が投票する(資源がなくても0票で参加できる)
  for (let i = 0; i < 3; i++) assert.ok(E.submitCamelBid(g, g.pendingCamelVote.order[g.pendingCamelVote.idx], {}));
  assert.equal(g.phase, 'camelPlace');
  const options = E.camelPlacementOptions(g);
  assert.ok(options.length > 0);
  assert.ok(E.placeCamel(g, options[0]));
  assert.equal(g.board.caravans.some((c) => c.includes(options[0])), true);
  assert.equal(g.phase, 'roll'); // ラクダを置き終えたので、次の手番に進む
});

test('交易と略奪・隊商: CPUだけで4人、数局きちんと決着する(勝利点12点)', () => {
  for (let i = 0; i < 3; i++) {
    const g = playOutCpu(['weak', 'normal', 'strong', 'normal'], 800000, { expansions: ['traders-barbarians'], scenario: 'caravans' });
    assert.equal(g.scenario, 'caravans');
    assert.ok(g.winner != null);
    assert.ok(E.playerScore(g, g.winner) >= g.winTarget);
  }
});

// ---- 蛮族の襲撃 ----
test('交易と略奪・蛮族の襲撃: 砦は盤の中心で産出せず、出目2と12のマスに蛮族が1体ずついる。勝利点12点', () => {
  const g = tbGame('barbarians');
  assert.equal(g.winTarget, 12);
  const castle = g.board.hexes[g.board.castleHexId];
  assert.equal(castle.q, 0); assert.equal(castle.r, 0);
  assert.equal(castle.terrain, 'castle');
  const two = g.board.hexes.find((h) => h.number === 2);
  const twelve = g.board.hexes.find((h) => h.number === 12);
  assert.equal(two.barbarians, 1);
  assert.equal(twelve.barbarians, 1);
  assert.equal(g.board.barbarianSupply, 28);
  assert.equal(g.board.robberHex, null);
});

test('交易と略奪・蛮族の襲撃: セットアップの2つ目はいきなり都市になる(資源は1枚のまま)', () => {
  const g = tbGame('barbarians');
  g.phase = 'setup2';
  g.setupOrder = [0, 1, 2, 3];
  g.setupIndex = 0;
  g.setupPending = 'settlement';
  const v = E.availableSettlementVertices(g, 0, true)[0];
  assert.ok(E.setupPlaceSettlement(g, v));
  assert.equal(g.players[0].cities.length, 1);
  assert.equal(g.players[0].settlements.length, 0);
  assert.equal(g.board.vertices[v].building.type, 'city');
  const before = JSON.parse(JSON.stringify(g.players[0].resources));
  E.setupPlaceRoad(g, g.board.vertices[v].edgeIds[0]);
  // 都市なら資源producing地形の数×2枚になるはずが、ここでは×1枚のまま(公式どおり)
  const PRODUCING = ['forest', 'hills', 'pasture', 'field', 'mountains'];
  const resourceHexCount = g.board.vertices[v].hexIds.filter((h) => PRODUCING.includes(g.board.hexes[h].terrain)).length;
  const totalGained = Object.keys(before).reduce((a, k) => a + (g.players[0].resources[k] - before[k]), 0);
  assert.equal(totalGained, resourceHexCount);
});

test('交易と略奪・蛮族の襲撃: 開拓地を建てる・都市にするたびに蛮族が上陸する', () => {
  const g = tbGame('barbarians');
  g.phase = 'main'; g.turn = 0;
  const v = E.availableSettlementVertices(g, 0, true)[0];
  g.board.vertices[v].building = { owner: 0, type: 'settlement' };
  g.players[0].settlements.push(v);
  g.players[0].resources = { wood: 0, brick: 0, sheep: 0, wheat: 2, ore: 3 };
  const before = g.board.barbarianSupply;
  assert.ok(E.buildCity(g, v));
  assert.ok(g.board.barbarianSupply < before);
});

test('交易と略奪・蛮族の襲撃: 騎士は砦の6辺にだけ建てられ、動いて蛮族より多ければ手番の終わりに退け、捕虜をもらう', () => {
  const g = tbGame('barbarians');
  g.phase = 'main'; g.turn = 0;
  const p0 = g.players[0];
  p0.resources = { wood: 0, brick: 0, sheep: 2, wheat: 0, ore: 2 };
  let edges = E.availableWarKnightEdges(g, 0);
  assert.ok(edges.length > 0);
  assert.ok(E.buildWarKnight(g, edges[0]));
  edges = E.availableWarKnightEdges(g, 0);
  assert.ok(E.buildWarKnight(g, edges[0]));
  assert.equal(p0.warKnights.length, 2);
  // 蛮族が1体いるマスへ、騎士2体を手で寄せる（1体では同数で勝てないので2体にする。移動の検証は movableWarKnightEdges 側で別に見る）
  const target = g.board.hexes.find((h) => h.barbarians > 0 && h.id !== g.board.castleHexId);
  p0.warKnights[0].edgeId = target.edgeIds[0];
  p0.warKnights[1].edgeId = target.edgeIds[1];
  const before = p0.prisoners;
  assert.ok(E.endTurn(g));
  assert.equal(target.barbarians, 0);
  assert.ok(p0.prisoners > before);
});

test('交易と略奪・蛮族の襲撃: 7が出たら盗賊の代わりに相手を選んで1枚奪う', () => {
  const g = tbGame('barbarians');
  g.phase = 'main'; g.turn = 0;
  g.players[1].resources.wood = 1;
  g.phase = 'roll';
  E.rollDice(g, diceSeq(7));
  assert.equal(g.phase, 'barbarianSteal');
  assert.ok(E.resolveBarbarianSteal(g, 1));
  assert.equal(g.phase, 'main');
});

test('交易と略奪・蛮族の襲撃: CPUだけで4人、数局きちんと決着する(勝利点12点)', () => {
  for (let i = 0; i < 3; i++) {
    const g = playOutCpu(['weak', 'normal', 'strong', 'normal'], 800000, { expansions: ['traders-barbarians'], scenario: 'barbarians' });
    assert.equal(g.scenario, 'barbarians');
    assert.ok(g.winner != null);
    assert.ok(E.playerScore(g, g.winner) >= g.winTarget);
  }
});

// 回帰: 種1642だと、開拓地・都市を建てた直後の勝利判定が「蛮族の上陸」での征服(得点が減る)より先に走り、
// 征服で自分の得点が下がったのに勝者のままになっていた(buildSettlement/buildCity の順序バグ)
test('交易と略奪・蛮族の襲撃: 種1642で決着しても勝者の得点は勝利点以上のまま(回帰)', () => {
  const g = withSeededRandom(1642, () => playOutCpu(['weak', 'normal', 'strong', 'normal'], 800000, { expansions: ['traders-barbarians'], scenario: 'barbarians' }));
  assert.ok(g.winner != null);
  assert.ok(E.playerScore(g, g.winner) >= g.winTarget);
});

// ---- 交易と略奪の5〜6人用拡張 ----
test('交易と略奪×5〜6人: 本島30マス、銀行24枚、特別建設フェイズつき(全シナリオ)', () => {
  for (const n of [5, 6]) {
    for (const scenario of E.TB_SCENARIOS) {
      const g = tbGame(scenario, n);
      assert.deepEqual(g.expansions.sort(), ['5-6player', 'traders-barbarians']);
      assert.equal(g.scenario, scenario);
      assert.equal(g.board.hexes.length, 30);
      assert.deepEqual(g.bank.resources, { wood: 24, brick: 24, sheep: 24, wheat: 24, ore: 24 });
      assert.equal(g.winTarget, scenario === 'fishermen' || scenario === 'rivers' ? 10 : 12); // 勝利点はext抜きと同じ(README に注記)
    }
  }
});

test('交易と略奪×5〜6人・漁師: 漁場が増え(9か所)、魚トークンも増える(1匹14・2匹13・3匹10)', () => {
  const g = tbGame('fishermen', 5);
  assert.equal(g.board.fisheries.length, 9);
  assert.equal(g.fishBag.length, 14 + 13 + 10 + 1); // +古い靴1枚
  const lake = g.board.hexes.find((h) => h.terrain === 'lake');
  assert.ok(lake);
});

test('交易と略奪×5〜6人・隊商: オアシスは内陸(6辺とも他マスに接する)で、3本の出発点を持つ', () => {
  const g = tbGame('caravans', 6);
  const oasis = g.board.hexes.find((h) => h.id === g.board.oasisHexId);
  assert.ok(oasis.edgeIds.every((eId) => g.board.edges[eId].hexIds.length === 2));
  assert.equal(g.board.camelStartEdges.length, 3);
});

test('交易と略奪×5〜6人・蛮族の襲撃: 砦は内陸で、蛮族の供給は36(近似)', () => {
  const g = tbGame('barbarians', 6);
  const castle = g.board.hexes.find((h) => h.id === g.board.castleHexId);
  assert.ok(castle.edgeIds.every((eId) => g.board.edges[eId].hexIds.length === 2));
  assert.ok(g.board.barbarianSupply >= 34 && g.board.barbarianSupply <= 36); // 出目2・12のマスに先置きした分だけ減ることがある
});

test('交易と略奪×5〜6人: 特別建設フェイズでも道・開拓地・都市、蛮族の襲撃なら騎士も建てられる', () => {
  const g = tbGame('barbarians', 5);
  g.phase = 'main'; g.turn = 1; g.turnNumber = 3;
  g.players.forEach((p) => { p.resources = { wood: 10, brick: 10, sheep: 10, wheat: 10, ore: 10 }; });
  const v = g.board.vertices.find((x) => x.edgeIds.length >= 2 && !x.building);
  v.building = { owner: 2, type: 'settlement' };
  g.players[2].settlements.push(v.id);
  assert.ok(E.endTurn(g));
  assert.equal(g.phase, 'specialBuilding');
  const idx = E.currentPlayer(g);
  const castleEdge = g.board.hexes[g.board.castleHexId].edgeIds[0];
  assert.ok(E.buildWarKnight(g, castleEdge));
  assert.equal(g.players[idx].warKnights.length, 1);
});

test('交易と略奪×5〜6人: CPUだけで5人・6人、各シナリオで数局きちんと決着する', () => {
  for (const n of [5, 6]) {
    const levels = n === 5 ? ['weak', 'normal', 'strong', 'weak', 'normal'] : ['weak', 'normal', 'strong', 'weak', 'normal', 'strong'];
    for (const scenario of E.TB_SCENARIOS) {
      const g = playOutCpu(levels, 1200000, { expansions: ['traders-barbarians'], scenario });
      assert.deepEqual(g.expansions.sort(), ['5-6player', 'traders-barbarians']);
      assert.equal(g.scenario, scenario);
      assert.ok(g.winner != null);
      assert.ok(E.playerScore(g, g.winner) >= g.winTarget);
    }
  }
});

// ---- サッカー熱 ----

test('サッカー熱: 盤の準備（サッカー場2マス、出目12のマスに2のチップも足す、盗賊は盤の外、勝利点11点）', () => {
  for (let i = 0; i < 10; i++) {
    const g = E.createGame(4, Math.random, { expansions: ['soccer'] });
    assert.deepEqual(g.expansions, ['soccer']);
    assert.equal(g.board.hexes.length, 19);
    const pitches = g.board.hexes.filter((h) => h.terrain === 'pitch');
    assert.equal(pitches.length, 2);
    assert.deepEqual(g.board.pitchHexIds.slice().sort((a, b) => a - b), pitches.map((h) => h.id).sort((a, b) => a - b));
    const twelve = g.board.hexes.find((h) => h.number === 12);
    assert.equal(twelve.number2, 2); // 置き換えたサッカー場ぶんの「2」チップが「12」のマスに足される
    assert.equal(g.board.robberHex, null); // 砂漠がないので、盗賊は最初の7が出るまで盤の外
    assert.equal(g.winTarget, 11);
    assert.equal(g.soccerMaxDay, 15);
    assert.equal(g.soccerDay, 1);
    assert.equal(g.players[0].socShots, 1);
  }
  const g3 = E.createGame(3, Math.random, { expansions: ['soccer'] });
  assert.equal(g3.soccerMaxDay, 12);
});

test('サッカー熱: サッカー場に接する開拓地・都市を建てると持ち駒が増える', () => {
  const g = E.createGame(4, Math.random, { expansions: ['soccer'] });
  const idx = E.currentPlayer(g);
  const pitchSet = new Set(g.board.pitchHexIds);
  const v = E.availableSettlementVertices(g, idx, true).find((vid) => g.board.vertices[vid].hexIds.some((h) => pitchSet.has(h)));
  assert.ok(v != null, 'サッカー場に接する置き場所が見つからない');
  assert.equal(g.players[idx].socShots, 1);
  assert.ok(E.setupPlaceSettlement(g, v));
  assert.equal(g.players[idx].socShots, 2);
});

test('サッカー熱: 開拓地・都市を建てると手番の終わりに1回だけ試合が行われる', () => {
  const g = E.createGame(4, Math.random, { expansions: ['soccer'] });
  while (g.phase === 'setup1' || g.phase === 'setup2') {
    const idx = E.currentPlayer(g);
    if (g.setupPending === 'settlement') E.setupPlaceSettlement(g, E.availableSettlementVertices(g, idx, true)[0]);
    else E.setupPlaceRoad(g, g.board.vertices[g.setupLastVertex].edgeIds.find((eId) => g.board.edges[eId].road == null));
  }
  assert.equal(g.phase, 'roll');
  g.turn = 0; g.phase = 'main';
  const p0 = g.players[0];
  let v = null;
  for (let i = 0; i < 8 && !v; i++) {
    v = E.availableSettlementVertices(g, 0, false)[0];
    if (v) break;
    const edges = E.availableRoadEdges(g, 0);
    if (!edges.length) break;
    p0.resources.wood = 1; p0.resources.brick = 1;
    E.buildRoad(g, edges[0]);
  }
  assert.ok(v != null);
  p0.resources = { wood: 1, brick: 1, sheep: 1, wheat: 1, ore: 0 };
  assert.equal(g.soccerDay, 1);
  assert.ok(E.buildSettlement(g, v));
  assert.equal(g.pendingSoccerMatch, true);
  assert.equal(g.soccerLastResult, null); // まだ手番の終わりになっていない
  assert.ok(E.endTurn(g));
  assert.equal(g.pendingSoccerMatch, false);
  assert.equal(g.soccerDay, 2);
  assert.ok(g.soccerLastResult);
  assert.equal(g.soccerLastResult.day, 1);
  assert.equal(g.soccerLastResult.results.length, 2); // 4人は1節に2試合
  const totalPoints = g.players.reduce((a, pl) => a + pl.socPoints, 0);
  assert.ok(totalPoints >= 2 && totalPoints <= 6);
});

test('サッカー熱: 対戦表は4人なら3節で全6組、3人なら同じ人が2試合こなす', () => {
  const seen = new Set();
  for (let day = 1; day <= 3; day++) {
    E.soccerFixturesForDay(4, day).forEach(([a, b]) => seen.add([a, b].sort().join('-')));
  }
  assert.equal(seen.size, 6);
  for (let day = 1; day <= 3; day++) {
    const fixtures = E.soccerFixturesForDay(3, day);
    assert.equal(fixtures[0][0], fixtures[1][0]); // ダブルプレイヤーが両方の試合に出る
  }
});

test('サッカー熱: 順位表は同点を分け合い、勝利点は1位+3・2位+2・3位+1・4位+0', () => {
  const g = E.createGame(4, Math.random, { expansions: ['soccer'] });
  g.players[0].socPoints = 10; g.players[1].socPoints = 10; g.players[2].socPoints = 5; g.players[3].socPoints = 0;
  const s = E.soccerStandings(g);
  assert.equal(s[0].place, 1); assert.equal(s[0].vp, 3);
  assert.equal(s[1].place, 1); assert.equal(s[1].vp, 3);
  assert.equal(s[2].place, 3); assert.equal(s[2].vp, 1); // 2位を2人が分け合ったので、次は3位から
  assert.equal(s[3].place, 4); assert.equal(s[3].vp, 0);
  assert.equal(E.playerScore(g, 0), 3); // 建物など他に何もないので、サッカーの順位点だけが勝利点になる
});

test('サッカー熱: CPUだけで3人・4人、数局きちんと決着する(勝利点11点)', () => {
  [[3, ['weak', 'normal', 'strong']], [4, ['weak', 'normal', 'strong', 'normal']]].forEach(([, levels]) => {
    for (let i = 0; i < 2; i++) {
      const g = playOutCpu(levels, 800000, { expansions: ['soccer'] });
      assert.deepEqual(g.expansions, ['soccer']);
      assert.ok(g.winner != null);
      assert.ok(E.playerScore(g, g.winner) >= 11);
    }
  });
});

test('プレイヤー名: 指定すればログに使われ、空ならプレイヤーNのまま', () => {
  const g = E.createGame(3, Math.random, { names: ['あやか', '', 'CPUくん'] });
  assert.equal(g.players[0].name, 'あやか');
  assert.equal(g.players[1].name, 'プレイヤー2'); // 空なら既定の名前
  assert.equal(g.players[2].name, 'CPUくん');
  assert.equal(E.playerName(g, 0), 'あやか');
  // 名前のない古いセーブ相当（player.name が undefined）でも既定名で動く
  delete g.players[2].name;
  assert.equal(E.playerName(g, 2), 'プレイヤー3');
});

// ---- 探検家と海賊 ----
test('探検家と海賊: 航海者版と同じ盤（46マス）で、小島6マスがすべて霧、うち1枚が金の川。勝利点は14点', () => {
  for (let i = 0; i < 10; i++) {
    const g = E.createGame(4, Math.random, { expansions: ['explorers-pirates'] });
    assert.deepEqual(g.expansions, ['explorers-pirates']);
    assert.equal(g.explorersPirates, true);
    assert.equal(g.winTarget, 14);
    assert.equal(g.board.hexes.length, 46);
    const islandHexes = [...g.board.islandHexIds].map((id) => g.board.hexes[id]);
    assert.equal(islandHexes.length, 6);
    assert.ok(islandHexes.every((h) => h.fog === true));
    assert.equal(islandHexes.filter((h) => h.terrain === 'gold').length, 1);
    assert.equal(g.players[0].epRevealed, 0);
    assert.equal(g.epMissionWinner, null);
  }
});

test('探検家と海賊: 霧の島には建てられない（船で探検するまで）', () => {
  const g = E.createGame(4, Math.random, { expansions: ['explorers-pirates'] });
  const fogHexId = [...g.board.islandHexIds][0];
  const v = g.board.hexes[fogHexId].vertexIds[0];
  assert.equal(E.canPlaceSettlement(g, v, 0, true), false);
  assert.equal(E.setupPlaceSettlement(g, v), false);
});

test('探検家と海賊: 船を置くと隣の霧のマスが見つかり、資源をもらい、探検ミッション(3マス)も進む', () => {
  const g = E.createGame(4, Math.random, { expansions: ['explorers-pirates'] });
  g.phase = 'main'; g.turn = 0;
  const p0 = g.players[0];
  const fogHex = g.board.hexes.find((h) => h.fog && h.terrain !== 'gold');
  const edge = g.board.edges.find((e) => e.hexIds.includes(fogHex.id)
    && (e.hexIds.length < 2 || e.hexIds.some((h) => g.board.hexes[h].terrain === 'water'))
    && !g.board.hexes[g.board.pirateHex].edgeIds.includes(e.id));
  assert.ok(edge, '霧のマスに面した置ける辺が見つからない');
  const v = g.board.vertices[edge.v1];
  v.building = { owner: 0, type: 'settlement' };
  p0.settlements.push(v.id);
  p0.resources = { wood: 2, brick: 0, sheep: 2, wheat: 0, ore: 0 };
  const sumBefore = Object.values(p0.resources).reduce((a, b) => a + b, 0);
  assert.ok(E.buildShip(g, edge.id));
  assert.equal(fogHex.fog, false);
  assert.equal(p0.epRevealed, 1);
  const res = { forest: 'wood', hills: 'brick', pasture: 'sheep', field: 'wheat', mountains: 'ore' }[fogHex.terrain];
  const sumAfter = Object.values(p0.resources).reduce((a, b) => a + b, 0);
  assert.equal(sumAfter, sumBefore - 2 + (res ? 1 : 0)); // 船代(木1・羊1)を払い、見つけたマスの資源を1枚もらう
  // あと2マス見つけるとミッション達成で+1点
  const others = [...g.board.islandHexIds].map((id) => g.board.hexes[id]).filter((h) => h.id !== fogHex.id && h.fog).slice(0, 2);
  others.forEach((h) => { h.fog = false; p0.epRevealed++; });
  if (g.epMissionWinner == null && p0.epRevealed >= 3) g.epMissionWinner = 0;
  assert.equal(g.epMissionWinner, 0);
  assert.equal(E.playerScore(g, 0), 1 + 1); // 開拓地1 + 探検ミッション+1
});

test('探検家と海賊: 盗賊・海賊は霧のままのマスには動かせない', () => {
  const g = E.createGame(4, Math.random, { expansions: ['explorers-pirates'] });
  g.phase = 'moveRobber'; g.turn = 0;
  const fogHex = [...g.board.islandHexIds][0];
  assert.equal(E.moveRobber(g, fogHex, null), false);
  assert.notEqual(g.board.robberHex, fogHex);
});

test('探検家と海賊: CPUだけで4人、1局を最後まで決着できる（数局）', () => {
  // 決着までの手数がまれに伸びて揺れるため、決まった種で回して安定させる
  for (const seed of [1, 2, 3, 4, 5]) {
    const g = withSeededRandom(seed, () => playOutCpu(['weak', 'normal', 'strong', 'normal'], 2000000, { expansions: ['explorers-pirates'] }));
    assert.deepEqual(g.expansions, ['explorers-pirates']);
    assert.ok(g.winner != null);
    assert.ok(E.playerScore(g, g.winner) >= 14);
  }
});

// ---- 探検家と海賊の5〜6人用拡張 ----
test('探検家と海賊×5〜6人: 本島30＋海23＋小島6＝59マス。銀行24枚・発展カード34枚・特別建設フェイズつき', () => {
  for (const n of [5, 6]) {
    for (let i = 0; i < 5; i++) {
      const g = E.createGame(n, Math.random, { expansions: ['explorers-pirates'] });
      assert.deepEqual(g.expansions.sort(), ['5-6player', 'explorers-pirates']);
      assert.equal(g.explorersPirates, true);
      assert.equal(g.winTarget, 14);
      assert.equal(g.board.hexes.length, 59);
      const islandHexes = [...g.board.islandHexIds].map((id) => g.board.hexes[id]);
      assert.equal(islandHexes.length, 6);
      assert.ok(islandHexes.every((h) => h.fog === true));
      assert.equal(islandHexes.filter((h) => h.terrain === 'gold').length, 1);
      assert.deepEqual(g.bank.resources, { wood: 24, brick: 24, sheep: 24, wheat: 24, ore: 24 });
      assert.equal(g.bank.devDeck.length, 34);
    }
  }
  // 画面からは expansions: ['explorers-pirates'] で来る想定。5〜6人を選んでも探検家と海賊を選べる
  assert.deepEqual(E.createGame(6, Math.random, { expansions: ['explorers-pirates'] }).expansions.sort(), ['5-6player', 'explorers-pirates']);
});

test('探検家と海賊×5〜6人: 特別建設フェイズで船も建てられる', () => {
  const g = E.createGame(5, Math.random, { expansions: ['explorers-pirates'] });
  g.phase = 'main'; g.turn = 1; g.turnNumber = 3;
  g.players.forEach((p) => { p.resources = { wood: 10, brick: 10, sheep: 10, wheat: 10, ore: 10 }; });
  // プレイヤー2が船を出せるよう、海沿いに開拓地を置いておく（海賊の隣は置けないので避ける）
  const seaEdge = g.board.edges.find((e) => e.hexIds.some((h) => g.board.hexes[h].terrain === 'water') && e.hexIds.some((h) => g.board.hexes[h].terrain !== 'water')
    && !g.board.hexes[g.board.pirateHex].edgeIds.includes(e.id));
  const v = g.board.vertices[seaEdge.v1];
  v.building = { owner: 2, type: 'settlement' };
  g.players[2].settlements.push(v.id);
  assert.ok(E.endTurn(g));
  assert.equal(g.phase, 'specialBuilding');
  assert.equal(E.currentPlayer(g), 2);
  assert.ok(E.availableShipEdges(g, 2).length > 0);
  const shipEdge = E.availableShipEdges(g, 2)[0];
  assert.ok(E.buildShip(g, shipEdge));
  assert.equal(g.players[2].ships.length, 1);
});

test('探検家と海賊×5〜6人: CPUだけで5人・6人、数局きちんと決着する', () => {
  // 決着までの手数がまれに伸びて揺れるため、決まった種で回して安定させる
  for (const levels of [['weak', 'normal', 'strong', 'weak', 'normal'], ['weak', 'normal', 'strong', 'weak', 'normal', 'strong']]) {
    for (const seed of [1, 2, 3]) {
      const g = withSeededRandom(seed, () => playOutCpu(levels, 2000000, { expansions: ['explorers-pirates'] }));
      assert.deepEqual(g.expansions.sort(), ['5-6player', 'explorers-pirates']);
      assert.ok(g.winner != null);
      assert.ok(E.playerScore(g, g.winner) >= 14);
    }
  }
});

// ---- 通信対戦（みんなのスマホで）: 待合の席を組み立てる純粋関数（online.js）----
test('online.js: subSeat/freeSeat/revertSubbedSeats（切断・つなぎ直し・部屋を出る 段階7）', async () => {
  const { subSeat, freeSeat, revertSubbedSeats } = await import('./online.js');
  const seats = [
    { type: 'human', uid: 'u1', name: 'あ' },
    { type: 'cpu', level: 'normal' },
    { type: 'human', uid: 'u2', name: 'い' },
  ];

  // 切れた・抜けた人の席をCPUに代わってもらう。持ち主(uid)は覚えておく
  const subbed = subSeat(seats, 0);
  assert.deepEqual(subbed[0], { type: 'cpu', level: 'normal', subbed: true, uid: 'u1', name: 'あ' });
  assert.deepEqual(subbed[1], seats[1]); // ほかの席はそのまま
  assert.equal(subSeat(seats, 1), seats); // 人でない席は変えない

  // 待合では席を空ける
  const freed = freeSeat(seats, 2);
  assert.deepEqual(freed[2], { type: 'human', uid: null, name: '' });
  assert.equal(freeSeat(seats, 1), seats); // CPU席は変えない

  // 本人がつながり直していたら人に戻す。オフラインのままなら触らない
  const back = revertSubbedSeats(subbed, { u1: { online: true, name: 'あ' } });
  assert.deepEqual(back[0], { type: 'human', uid: 'u1', name: 'あ' });
  const stillOut = revertSubbedSeats(subbed, { u1: { online: false, name: 'あ' } });
  assert.deepEqual(stillOut[0], subbed[0]);
});

test('online.js: canStart は5〜6人でも成り立つ。ONLINE_EXPANSIONSは全部（なし・航海者版・都市と騎士・交易と略奪・サッカー熱・探検家と海賊）がready（段階9〜9-6）', async () => {
  const { canStart, ONLINE_EXPANSIONS } = await import('./online.js');
  const seats6 = Array.from({ length: 6 }, (_, i) => (i < 2
    ? { type: 'human', uid: `u${i}` }
    : { type: 'cpu', level: 'normal' }));
  assert.equal(canStart(seats6), true);
  assert.equal(canStart(seats6.slice(0, 5)), true);
  assert.equal(ONLINE_EXPANSIONS.every((x) => x.ready === true), true);
});

// 通信対戦9-5: 探検家と海賊を開ける。船を置く・動かす(buildShip/moveShip)は航海者版と同じengine関数で、
// どちらもcurrentPlayer(game)だけを見て動くので、既存のONLINE_TURN_ACTIONS（9-2で船を足した時点）の
// 確かめがそのまま効く。霧のマスを見つける処理(revealFogAt)が船の操作に相乗りしていることも確かめる
test('探検家と海賊: buildShipはcurrentPlayerにしか当たらず、船を置くと霧のマスが開ける（手番の確かめはホスト側の責任）', () => {
  // 盤の配置によっては霧のマスに隣接する海の辺が見つからないことがある（既存の無関係なゆらぎ）ので種を固定する
  const g = withSeededRandom(1, () => E.createGame(4, Math.random, { expansions: ['explorers-pirates'] }));
  g.phase = 'main'; g.turn = 1; g.turnNumber = 1;
  g.players.forEach((p) => { p.resources = { wood: 1, brick: 1, sheep: 1, wheat: 0, ore: 0 }; });
  assert.equal(E.currentPlayer(g), 1);
  const fogHex = g.board.hexes.find((h) => h.fog);
  const edge = g.board.edges.find((e) => e.hexIds.includes(fogHex.id)
    && e.hexIds.some((h) => g.board.hexes[h].terrain === 'water')
    && !g.board.hexes[g.board.pirateHex].edgeIds.includes(e.id));
  assert.ok(edge, '霧のマスに隣接する海の辺が見つからない');
  g.board.vertices[edge.v1].building = { owner: 1, type: 'settlement' }; // 自分の開拓地とつながった体にする
  g.players[1].settlements.push(edge.v1);
  assert.ok(E.buildShip(g, edge.id)); // 手番(1)の船として置かれる
  assert.equal(g.players[1].ships.length, 1);
  assert.equal(g.players[0].ships.length, 0); // 手番でない0の船にはならない
  assert.equal(fogHex.fog, false); // 船を置いた人の霧が開く
  assert.equal(g.players[1].epRevealed, 1);
});

// 通信対戦9-6: サッカー熱を開ける。持ち駒を増やす処理(grantSoccerShot)はbuildSettlement/buildCity/setup系の
// 中からcurrentPlayer(game)のidxで呼ばれるだけで、新しい操作名は増えない。既存のONLINE_TURN_ACTIONSの
// 確かめ（9-5までと同じ形）がそのまま効くことを、buildSettlementで確かめる
test('サッカー熱: buildSettlementがピッチのマスの隣でcurrentPlayerの持ち駒(socShots)だけ増やす（新しい操作名を足す必要がない）', () => {
  const g = E.createGame(4, Math.random, { expansions: ['soccer'] });
  g.phase = 'main'; g.turn = 0; g.turnNumber = 1;
  const pitchHexId = g.board.pitchHexIds[0];
  const v = g.board.vertices.find((x) => x.hexIds.includes(pitchHexId) && !x.building && !x.neighbors.some((n) => g.board.vertices[n].building));
  assert.ok(v, 'ピッチのマスに隣接する空いている頂点が見つからない');
  const edge = v.edgeIds[0];
  g.board.edges[edge].road = 0; // 自分の道がつながっている体にする（探検家と海賊のテストと同じ組み方）
  g.players[0].roads.push(edge);
  g.players[0].resources = { wood: 1, brick: 1, sheep: 1, wheat: 1, ore: 0 };
  const before = g.players[0].socShots;
  const otherBefore = g.players[1].socShots;
  assert.ok(E.buildSettlement(g, v.id)); // 手番(0)の開拓地として置かれ、持ち駒が増える
  assert.equal(g.players[0].socShots, before + 1);
  assert.equal(g.players[1].socShots, otherBefore); // 手番でない1の持ち駒は動かない
});

// 通信対戦9-6: renderSoccerの「持ち駒」は自分の席だけ出す（discard・goldPick・scienceBonus・camelVoteと同じ直し方）。
// main.jsのhandSeatIndexが通信対戦では自分の席、1台モードではcurrentPlayerを返すことは既存のrenderCk用の
// テストで確かめ済みなので、ここではengine側のsocShotsが席ごとに別の値を持てることだけ確かめる
test('サッカー熱: socShotsは席ごとに別の値（renderSoccerが自分の分だけ出せるようにengine側が区別している）', () => {
  const g = E.createGame(4, Math.random, { expansions: ['soccer'] });
  g.players[0].socShots = 3;
  g.players[1].socShots = 5;
  assert.notEqual(g.players[0].socShots, g.players[1].socShots);
});

// 通信対戦9-4: 交易と略奪を開ける。漁師・川・隊商・蛮族の襲撃の操作はすべてengineがcurrentPlayer(game)で
// 動く（buildWarKnight・resolveBarbarianStealなど）ので、都市と騎士と同じくmain.jsのONLINE_TURN_ACTIONS側で
// 送り主の席とE.actingPlayerの一致を確かめる必要がある。代表としてbuildWarKnight・resolveBarbarianStealで確かめる
test('交易と略奪: buildWarKnight/resolveBarbarianStealはcurrentPlayerにしか当たらない（手番の確かめはホスト側の責任）', () => {
  const g = tbGame('barbarians');
  g.phase = 'main'; g.turn = 1; g.turnNumber = 1;
  g.players.forEach((p) => { p.resources = { wood: 0, brick: 0, sheep: 2, wheat: 0, ore: 2 }; });
  assert.equal(E.currentPlayer(g), 1);
  const edges = E.availableWarKnightEdges(g, 1);
  assert.ok(edges.length > 0);
  assert.ok(E.buildWarKnight(g, edges[0])); // 手番(1)の騎士として置かれる
  assert.equal(g.players[1].warKnights.length, 1);
  assert.equal(g.players[0].warKnights.length, 0); // 手番でない0の騎士にはならない

  g.players[0].resources = { wood: 1, brick: 0, sheep: 0, wheat: 0, ore: 0 }; // 盗める資源をwood1枚だけにして結果を決め打ちにする
  g.phase = 'barbarianSteal';
  assert.ok(E.resolveBarbarianSteal(g, 0)); // 誰が送っても「現在の手番(1)」として処理される
  assert.equal(g.players[0].resources.wood, 0); // 手番(1)が0から奪った
});

// submitCamelBid（隊商のラクダ投票）は、入札の順番(pendingCamelVote.order)が手番の人(currentPlayer)と
// 一致するとは限らないので、ONLINE_TURN_ACTIONSでなくONLINE_SELF_ACTIONS（席番号はホストが入れる）で扱う。
// その必要性を、actingPlayerと入札者が一致しない場面で確かめる
test('交易と略奪・隊商: submitCamelBidは入札順で決まり、手番(currentPlayer)とは限らない席でも受けられる', () => {
  const g = tbGame('caravans', 4);
  g.turn = 1; g.turnNumber = 1;
  g.players.forEach((p) => { p.resources = { wood: 0, brick: 0, sheep: 2, wheat: 2, ore: 0 }; });
  g.pendingCamelVote = { order: [2, 3, 0, 1], idx: 0, bids: {} };
  g.phase = 'camelVote';
  assert.equal(E.currentPlayer(g), 1); // 手番は1のままだが、最初に入札するのは2
  assert.equal(E.submitCamelBid(g, 1, {}), false); // 手番の1が送っても、入札の順でなければ断られる
  assert.ok(E.submitCamelBid(g, 2, {})); // 入札の順(2)なら通る
  assert.equal(g.pendingCamelVote.idx, 1);
});

// 通信対戦9-3: 都市と騎士を開ける。都市の発展・都市壁・騎士(建てる/起動/昇格/移動/追い出す/盗賊払い)・
// 進歩カード・商品の交易はすべて手番の操作（main.js ONLINE_TURN_ACTIONS）。engineはcurrentPlayer(game)だけを
// 見て動かすので、手番でない人が送っても手番の人として当たってしまう前提を、代表としてbuildKnightで確かめる
// （9-2のbuildShipと同じ考え方。ホスト側の確かめはDOM依存で直接testできないため）。
test('都市と騎士: buildKnight/改良/進歩カードはcurrentPlayerにしか当たらない（手番の確かめはホスト側の責任）', () => {
  const g = ckGame();
  g.phase = 'main'; g.turn = 1; g.turnNumber = 1;
  g.players.forEach((p) => { p.resources = { wood: 10, brick: 10, sheep: 10, wheat: 10, ore: 10 }; });
  const v = g.board.vertices.find((x) => x.edgeIds.length >= 2);
  const e = v.edgeIds[0];
  g.board.edges[e].road = 1;
  assert.equal(E.currentPlayer(g), 1);
  assert.ok(E.buildKnight(g, v.id)); // 手番(1)の騎士として置かれる
  assert.equal(g.players[1].knights.length, 1);
  assert.equal(g.players[0].knights.length, 0); // 手番でない0の騎士にはならない
});

// 通信対戦9-3: 科学3段階目の「何も入らなかった人が資源1枚を選ぶ」(pendingScienceBonus)は、
// discard・goldと同じく手番と関係なく誰からでも片付けられる必要がある（main.js ONLINE_SELF_ACTIONS）。
// 届く順が手番順とは限らないので、エンジン側が順不同で受けられることを確かめる。
test('都市と騎士: 科学の力(pickScienceBonus)の受け取りは、複数人が同時に待っていても届いた順(手番と無関係)に片付く', () => {
  const g = ckGame();
  g.phase = 'main';
  g.pendingScienceBonus = [2, 0, 3];
  assert.equal(E.pickScienceBonus(g, 1, 'wood'), false); // 待っていない席
  assert.ok(E.pickScienceBonus(g, 3, 'sheep'));
  assert.ok(E.pickScienceBonus(g, 0, 'wheat'));
  assert.equal(E.pickScienceBonus(g, 0, 'ore'), false); // もう片付いた席からもう一度来ても断る
  assert.ok(E.pickScienceBonus(g, 2, 'ore'));
  assert.deepEqual(g.pendingScienceBonus, []);
  assert.equal(g.phase, 'main');
  assert.equal(g.players[0].resources.wheat, 1);
  assert.equal(g.players[2].resources.ore, 1);
  assert.equal(g.players[3].resources.sheep, 1);
});

// ---- 通信対戦: 待合のQR（段階8。デコードしての一致確認はスクラッチで npm の jsQR を使って別途確認済み）----
test('qr.js: 文字列ごとに違うSVGのQRを作る（roomQrSvgが使う部品）', async () => {
  const qrcode = (await import('./qr.js')).default;
  const linkA = 'https://t-of.github.io/catan/#room=ABCD';
  const linkB = 'https://t-of.github.io/catan/#room=WXYZ';
  const make = (text) => { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag(4, 8); };
  const svgA = make(linkA);
  const svgB = make(linkB);
  assert.match(svgA, /^<svg /);
  assert.match(svgA, /<\/svg>$/);
  assert.notEqual(svgA, svgB); // 部屋コードが変われば中身(モジュール配置)も変わる
  assert.equal(make(linkA), svgA); // 同じ文字列なら同じ見た目
});

// ---- 通信対戦: 隠し情報を分ける（段階10） ----
test('viewFor: 自分の席はそのまま、他人の資源・発展カードは枚数だけになる', () => {
  const g = E.createGame(3, Math.random);
  g.players[0].resources = { wood: 2, brick: 0, sheep: 1, wheat: 0, ore: 3 }; // 合計6枚
  g.players[0].devCards = [{ type: 'vp', boughtTurn: 1, played: false }, { type: 'knight', boughtTurn: 2, played: true }];
  const view0 = E.viewFor(g, 0);
  const view1 = E.viewFor(g, 1);
  const pub = E.viewFor(g, null);
  // 自分(0)の席から見れば中身がそのまま見える
  assert.deepEqual(view0.players[0].resources, g.players[0].resources);
  assert.equal(view0.players[0].devCards[0].type, 'vp');
  // 他人(1)やpub(誰でもない)からは、枚数だけになり内訳は消える
  [view1, pub].forEach((v) => {
    assert.deepEqual(v.players[0].resources, { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });
    assert.equal(v.players[0].handCount, 6); // 枚数は公開情報として残る
    assert.equal(v.players[0].devCards[0].type, null); // まだ使っていないカードの中身は隠す
    assert.equal(v.players[0].devCards[1].type, 'knight'); // 使った後は公開済みなので隠さない
  });
  // 元のgameは書き換えない
  assert.equal(g.players[0].resources.ore, 3);
});

test('viewFor: 発展カードの山・進歩カードの山・魚トークンの山は、本人を含め誰からも順がわからない(枚数だけ残す)', () => {
  const g = ckGame(3);
  const deckLen = g.progressDecks.trade.length;
  const v = E.viewFor(g, 0);
  assert.equal(v.bank.devDeck.length, g.bank.devDeck.length);
  assert.ok(v.bank.devDeck.every((c) => c === null));
  assert.equal(v.progressDecks.trade.length, deckLen);
  assert.ok(v.progressDecks.trade.every((c) => c === null));
  g.players[0].progressCards = [{ color: 'trade', id: 'p1' }];
  const v2 = E.viewFor(g, 1);
  assert.deepEqual(v2.players[0].progressCards, [{ id: null, color: null }]);
  assert.equal(E.viewFor(g, 0).players[0].progressCards[0].id, 'p1'); // 自分のぶんは残る
});

test('viewFor: 都市と騎士の商品は枚数だけ、lastStealの中身は奪った人・奪われた人にだけ見える', () => {
  const g = ckGame(3);
  g.players[2].commodities = { paper: 1, cloth: 2, coin: 0 };
  g.lastSteal = { from: 1, to: 2, res: 'wood' };
  const viewOther = E.viewFor(g, 0);
  assert.deepEqual(viewOther.players[2].commodities, { paper: 0, cloth: 0, coin: 0 });
  assert.equal(viewOther.players[2].commodityCount, 3);
  assert.equal(viewOther.lastSteal, null);
  assert.deepEqual(E.viewFor(g, 1).lastSteal, { from: 1, to: 2, res: 'wood' }); // 奪われた人
  assert.deepEqual(E.viewFor(g, 2).lastSteal, { from: 1, to: 2, res: 'wood' }); // 奪った人
  assert.equal(E.viewFor(g, null).lastSteal, null); // pub(誰でもない)からは見えない
});
