'use strict';
// 盤の3D表示。main.js・engine.jsを知らない（渡されたプレーンなデータだけを読む）小さなモジュール。
//
// 使い方:
//   initBoard3D(container, onTap)  … 起動時に1回。onTap('vertex'|'edge'|'hex', id) はタップで呼ばれる
//   renderBoard3D(game, uiState, overlay) … 盤を描き直すたびに呼ぶ（main.jsのrenderBoardIntoと同じ頻度でよい）
//     overlay は renderBoardInto が返す配列（置ける頂点・辺・マスの当たり判定の素）をそのまま渡す。
//
// SVG版（main.jsのrenderBoardInto）と同じく、呼ばれるたびに中身を全部作り直す。
// ponytail: 盤は見た目を変える操作のたびにしか作り直されない（連続アニメーションではない）ので、
// 毎回丸ごと作り直しても重くならない。木や羊などの繰り返しはInstancedMeshでまとめ、台数を抑える。
import * as THREE from './vendor/three.module.min.js';
import { OrbitControls } from './vendor/OrbitControls.js';

const SCALE = 66; // main.jsのSCALEと同じ値（頂点のx,yをこの倍率でワールド座標にする）

// ---- 地形ごとの色・高さ（illust.jsのTERRAIN_STYLEと同じ地形名） ----
const TERRAIN_COLOR = {
  forest: 0x2f6a3c, pasture: 0x9fcf5e, field: 0xe2bb3f, hills: 0xb15a2f,
  mountains: 0x8d93a0, desert: 0xe7d29a, water: 0x1f7089, gold: 0xe9c43f,
  lake: 0x1f7089, castle: 0x747c8a, pitch: 0x2f8a3f, fog: 0x8a9690,
};
const TERRAIN_HEIGHT = {
  forest: 16, pasture: 11, field: 11, hills: 15, mountains: 24, desert: 9,
  water: 3, gold: 13, lake: 3, castle: 20, pitch: 8, fog: 12,
};
const RES_COLOR3D = { wood: 0x3f8a4a, brick: 0xc0643a, sheep: 0x8cc063, wheat: 0xe0b440, ore: 0x8a92a3 };

let scene, camera, renderer, controls, raycaster, pointer, clock;
let sceneGroup; // 毎回まるごと作り直す盤の中身
let onTapCb = null;
let hitTargets = []; // [{ mesh, kind, id }]（レイキャストで拾う的）
let waterMeshes = []; // 波で揺らすタイル
let pulseMeshes = []; // 明滅させる的（置ける場所・盗賊など）
let framedForHexCount = null;

// ---- 共通ジオメトリ（使い回す。インスタンスごとに作らない） ----
const GEO = {
  trunk: new THREE.CylinderGeometry(1.6, 2, 9, 6),
  canopy: new THREE.ConeGeometry(7, 16, 7),
  sheep: new THREE.SphereGeometry(5, 8, 6),
  wheat: new THREE.ConeGeometry(2.2, 9, 5),
  mound: new THREE.SphereGeometry(10, 8, 6),
  peak: new THREE.ConeGeometry(9, 22, 5),
  snowCap: new THREE.ConeGeometry(3.4, 7, 5),
  dune: new THREE.ConeGeometry(14, 5, 10),
  cactusBody: new THREE.CylinderGeometry(2.2, 2.6, 16, 7),
  nugget: new THREE.OctahedronGeometry(3.4, 0),
};
const MAT = {
  bark: new THREE.MeshStandardMaterial({ color: 0x5b3a22, flatShading: true, roughness: 0.95 }),
  leaf: new THREE.MeshStandardMaterial({ color: 0x387a44, flatShading: true, roughness: 0.9 }),
  sheep: new THREE.MeshStandardMaterial({ color: 0xf4f1e6, flatShading: true, roughness: 0.85 }),
  wheat: new THREE.MeshStandardMaterial({ color: 0xe4b63e, flatShading: true, roughness: 0.8 }),
  mound: new THREE.MeshStandardMaterial({ color: 0xa15c34, flatShading: true, roughness: 0.95 }),
  peak: new THREE.MeshStandardMaterial({ color: 0x9aa0ac, flatShading: true, roughness: 0.9 }),
  snow: new THREE.MeshStandardMaterial({ color: 0xf4f8ff, flatShading: true, roughness: 0.7 }),
  sand: new THREE.MeshStandardMaterial({ color: 0xdfc688, flatShading: true, roughness: 1 }),
  cactus: new THREE.MeshStandardMaterial({ color: 0x4f8a43, flatShading: true, roughness: 0.9 }),
  gold: new THREE.MeshStandardMaterial({ color: 0xf0c83c, flatShading: true, roughness: 0.4, metalness: 0.6, emissive: 0x4a3a00 }),
};

export function initBoard3D(container, onTap) {
  onTapCb = onTap;
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0c2b3a);
  scene.fog = new THREE.Fog(0x0c2b3a, 900, 2200);

  camera = new THREE.PerspectiveCamera(42, 1, 1, 4000);
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xdcefff, 0x1a2a1a, 0.95));
  const sun = new THREE.DirectionalLight(0xfff2d6, 1.25);
  sun.position.set(260, 480, 180);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.near = 10; sun.shadow.camera.far = 1600;
  const d = 500;
  sun.shadow.camera.left = -d; sun.shadow.camera.right = d; sun.shadow.camera.top = d; sun.shadow.camera.bottom = -d;
  scene.add(sun);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enablePan = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.minPolarAngle = 0.2;
  controls.maxPolarAngle = Math.PI / 2 - 0.04;

  raycaster = new THREE.Raycaster();
  pointer = new THREE.Vector2();
  clock = new THREE.Clock();

  sceneGroup = new THREE.Group();
  scene.add(sceneGroup);

  attachInput(renderer.domElement);
  new ResizeObserver(() => resize(container)).observe(container);
  resize(container);
  renderer.setAnimationLoop(animate);
}

function resize(container) {
  const w = container.clientWidth || 1, h = container.clientHeight || 1;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}

// ---- タップ／ドラッグの見分け（しきい値を超えて動いたら回転操作として無視する） ----
function attachInput(dom) {
  let down = null;
  dom.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  dom.addEventListener('pointerup', (e) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const dt = performance.now() - down.t;
    down = null;
    if (moved > 8 || dt > 600) return;
    pick(dom, e.clientX, e.clientY);
  });
  dom.addEventListener('pointercancel', () => { down = null; });
}

function pick(dom, cx, cy) {
  const r = dom.getBoundingClientRect();
  pointer.x = ((cx - r.left) / r.width) * 2 - 1;
  pointer.y = -((cy - r.top) / r.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const meshes = hitTargets.map((h) => h.mesh);
  const hits = raycaster.intersectObjects(meshes, false);
  if (!hits.length) return;
  const found = hitTargets.find((h) => h.mesh === hits[0].object);
  if (found && onTapCb) onTapCb(found.kind, found.id);
}

function animate() {
  const t = clock.getElapsedTime();
  waterMeshes.forEach((m, i) => {
    m.position.y = m.userData.baseY + Math.sin(t * 1.6 + i * 1.7) * 1.6;
    m.rotation.z = Math.sin(t * 0.8 + i) * 0.015;
  });
  pulseMeshes.forEach((m, i) => {
    const k = 0.55 + Math.sin(t * 3 + i * 0.6) * 0.45;
    if (m.material.emissiveIntensity != null) m.material.emissiveIntensity = 0.4 + k * 1.1;
    if (m.userData.baseScale) { const s = m.userData.baseScale * (1 + k * 0.08); m.scale.setScalar(s); }
  });
  controls.update();
  renderer.render(scene, camera);
}

// ---- 小さな組み立てヘルパー ----
function hexCenterOf(g, hex) {
  const vs = hex.vertexIds.map((id) => g.vertices[id]);
  return [vs.reduce((a, v) => a + v.x, 0) / vs.length * SCALE, vs.reduce((a, v) => a + v.y, 0) / vs.length * SCALE];
}
function hexPointsOf(g, hex) {
  return hex.vertexIds.map((id) => { const v = g.vertices[id]; return [v.x * SCALE, v.y * SCALE]; });
}
// 六角柱（上面・側面だけ。底面は海に隠れて見えないので省く）
function hexPrismGeometry(pts, height) {
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const cz = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const pos = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    pos.push(cx, height, cz, b[0], height, b[1], a[0], height, a[1]); // 上面
    pos.push(a[0], 0, a[1], b[0], 0, b[1], b[0], height, b[1]); // 側面 x2
    pos.push(a[0], 0, a[1], b[0], height, b[1], a[0], height, a[1]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}
function instancedFrom(geo, mat, items) {
  if (!items.length) return null;
  const mesh = new THREE.InstancedMesh(geo, mat, items.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  items.forEach((it, i) => {
    e.set(it.rx || 0, it.ry || 0, it.rz || 0);
    q.setFromEuler(e);
    m4.compose(new THREE.Vector3(it.x, it.y, it.z), q, new THREE.Vector3(it.s ?? 1, it.s ?? 1, it.s ?? 1));
    mesh.setMatrixAt(i, m4);
  });
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}
function rand(a, b) { return a + Math.random() * (b - a); }

// 数字チップの文字を書いた円いテクスチャ（出目ごとにキャッシュ）
const numberTexCache = new Map();
function numberTexture(n, hot) {
  const key = `${n}:${hot}`;
  if (numberTexCache.has(key)) return numberTexCache.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f3e7c4'; ctx.beginPath(); ctx.arc(64, 64, 60, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#8a7a52'; ctx.lineWidth = 4; ctx.stroke();
  ctx.fillStyle = hot ? '#b8321f' : '#2a211b';
  ctx.font = 'bold 64px Georgia, serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(n), 64, 68);
  const dots = 6 - Math.abs(7 - n);
  ctx.fillStyle = hot ? '#b8321f' : '#2a211b';
  for (let d = 0; d < dots; d++) ctx.beginPath(), ctx.arc(64 - (dots - 1) * 7 + d * 14, 102, 3.4, 0, Math.PI * 2), ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  numberTexCache.set(key, tex);
  return tex;
}

// ================================================================
// 本体: 盤を1枚まるごと作り直す
// ================================================================
export function renderBoard3D(game, uiState, overlay) {
  if (!scene) return;
  disposeGroup(sceneGroup);
  hitTargets = []; waterMeshes = []; pulseMeshes = [];
  const g = game.board;

  frameCamera(g);

  const treeItems = [], canopyItems = [], sheepItems = [], wheatItems = [], moundItems = [], peakItems = [],
    snowItems = [], duneItems = [], cactusItems = [], nuggetItems = [];

  g.hexes.forEach((hex) => {
    const [cx, cz] = hexCenterOf(g, hex);
    const pts = hexPointsOf(g, hex);
    const terrain = hex.fog ? 'fog' : hex.terrain;
    const height = TERRAIN_HEIGHT[terrain] ?? 10;
    const mat = new THREE.MeshStandardMaterial({ color: TERRAIN_COLOR[terrain] ?? 0x446644, flatShading: true, roughness: 0.95, side: THREE.DoubleSide });
    const tile = new THREE.Mesh(hexPrismGeometry(pts, height), mat);
    tile.receiveShadow = true; tile.castShadow = false;
    sceneGroup.add(tile);
    if (terrain === 'water' || terrain === 'lake') {
      tile.userData.baseY = 0;
      waterMeshes.push(tile);
    }
    const R = SCALE * 0.6;
    if (terrain === 'forest') {
      const n = Math.floor(rand(4, 6));
      for (let i = 0; i < n; i++) {
        const a = rand(0, Math.PI * 2), r = rand(0, R * 0.8);
        const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r, s = rand(0.8, 1.2);
        treeItems.push({ x, y: height + 4.5 * s, z, s });
        canopyItems.push({ x, y: height + 13 * s, z, s });
      }
    } else if (terrain === 'pasture') {
      const n = Math.floor(rand(2, 4));
      for (let i = 0; i < n; i++) {
        const a = rand(0, Math.PI * 2), r = rand(0, R * 0.7);
        sheepItems.push({ x: cx + Math.cos(a) * r, y: height + 4, z: cz + Math.sin(a) * r, s: rand(0.8, 1.1) });
      }
    } else if (terrain === 'field') {
      for (let row = -2; row <= 2; row++) {
        for (let col = -1; col <= 1; col++) {
          const x = cx + col * 22 + rand(-3, 3), z = cz + row * 16 + rand(-3, 3);
          if (Math.hypot(x - cx, z - cz) > R * 0.85) continue;
          wheatItems.push({ x, y: height + 4.5, z, ry: rand(0, Math.PI * 2), s: rand(0.8, 1.1) });
        }
      }
    } else if (terrain === 'hills') {
      const n = Math.floor(rand(2, 3));
      for (let i = 0; i < n; i++) {
        const a = rand(0, Math.PI * 2), r = rand(0, R * 0.6);
        moundItems.push({ x: cx + Math.cos(a) * r, y: height + 1, z: cz + Math.sin(a) * r, s: rand(0.9, 1.3), rx: 0, ry: rand(0, 6) });
      }
    } else if (terrain === 'mountains') {
      [[-0.35, -0.1], [0.3, -0.2], [0, 0.3]].forEach(([dx, dz]) => {
        const x = cx + dx * SCALE, z = cz + dz * SCALE, s = rand(0.9, 1.3);
        peakItems.push({ x, y: height + 10 * s, z, s });
        if (Math.random() < 0.7) snowItems.push({ x, y: height + 19 * s, z, s });
      });
    } else if (terrain === 'desert') {
      duneItems.push({ x: cx - 20, y: height + 1, z: cz + 10, s: rand(0.9, 1.2) });
      duneItems.push({ x: cx + 24, y: height + 1, z: cz - 14, s: rand(0.8, 1) });
      if (Math.random() < 0.6) cactusItems.push({ x: cx + rand(-30, 30), y: height + 8, z: cz + rand(-20, 20), s: rand(0.8, 1) });
    } else if (terrain === 'gold') {
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + rand(-0.2, 0.2), r = rand(R * 0.3, R * 0.65);
        nuggetItems.push({ x: cx + Math.cos(a) * r, y: height + 2.5, z: cz + Math.sin(a) * r, s: rand(0.8, 1.2), ry: rand(0, 6) });
      }
    } else if (terrain === 'castle') {
      addCastle(cx, cz, height);
    } else if (terrain === 'pitch') {
      addPitch(cx, cz, height);
    } else if (terrain === 'fog') {
      const dome = new THREE.Mesh(new THREE.SphereGeometry(R * 0.95, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2),
        new THREE.MeshStandardMaterial({ color: 0xdfe8e2, transparent: true, opacity: 0.55, flatShading: true }));
      dome.position.set(cx, height, cz);
      sceneGroup.add(dome);
    }
    // 数字チップ
    if (hex.number != null && !hex.fog) {
      addNumberChip(cx, cz, height, hex.number, hex.number === 6 || hex.number === 8, 1);
    }
    if (hex.number2 != null) addNumberChip(cx + 24, cz - 16, height, hex.number2, false, 0.6);
  });
  if (g.lakeNumbers) { /* 漁師の湖は lake terrain 側で既に扱う簡略版（4隅の出目は省略） */ }

  [
    instancedFrom(GEO.trunk, MAT.bark, treeItems),
    instancedFrom(GEO.canopy, MAT.leaf, canopyItems),
    instancedFrom(GEO.sheep, MAT.sheep, sheepItems),
    instancedFrom(GEO.wheat, MAT.wheat, wheatItems),
    instancedFrom(GEO.mound, MAT.mound, moundItems),
    instancedFrom(GEO.peak, MAT.peak, peakItems),
    instancedFrom(GEO.snowCap, MAT.snow, snowItems),
    instancedFrom(GEO.dune, MAT.sand, duneItems),
    instancedFrom(GEO.cactusBody, MAT.cactus, cactusItems),
    instancedFrom(GEO.nugget, MAT.gold, nuggetItems),
  ].forEach((m) => { if (m) sceneGroup.add(m); });

  // 港
  g.portEdgeIds.forEach((eId) => addPort(g, eId));

  // 川（交易と略奪）
  if (g.riverEdgeIds) {
    g.riverEdgeIds.forEach((eId) => {
      const e = g.edges[eId];
      const v1 = g.vertices[e.v1], v2 = g.vertices[e.v2];
      const mat = new THREE.MeshStandardMaterial({ color: 0x2a93ad, transparent: true, opacity: 0.85 });
      const len = Math.hypot((v2.x - v1.x) * SCALE, (v2.y - v1.y) * SCALE);
      const band = new THREE.Mesh(new THREE.BoxGeometry(len, 1, 10), mat);
      band.position.set((v1.x + v2.x) / 2 * SCALE, 1, (v1.y + v2.y) / 2 * SCALE);
      band.rotation.y = -Math.atan2((v2.y - v1.y) * SCALE, (v2.x - v1.x) * SCALE);
      sceneGroup.add(band);
    });
  }

  // 道・船
  g.edges.forEach((edge) => {
    const v1 = g.vertices[edge.v1], v2 = g.vertices[edge.v2];
    const x1 = v1.x * SCALE, z1 = v1.y * SCALE, x2 = v2.x * SCALE, z2 = v2.y * SCALE;
    const mx = (x1 + x2) / 2, mz = (z1 + z2) / 2;
    const ang = -Math.atan2(z2 - z1, x2 - x1);
    const hexAtEdge = edge.hexIds.map((id) => g.hexes[id]).find(Boolean);
    const baseY = hexAtEdge ? (TERRAIN_HEIGHT[hexAtEdge.fog ? 'fog' : hexAtEdge.terrain] ?? 10) : 4;
    if (edge.ship != null) {
      addShip(mx, mz, ang, game.players[edge.ship].color);
    } else if (edge.road != null) {
      const color = new THREE.Color(game.players[edge.road].color);
      const len = Math.hypot(x2 - x1, z2 - z1) * 0.82;
      const road = new THREE.Mesh(new THREE.BoxGeometry(len, 4, 7), new THREE.MeshStandardMaterial({ color, flatShading: true }));
      road.position.set(mx, baseY + 2, mz);
      road.rotation.y = ang;
      road.castShadow = true;
      sceneGroup.add(road);
    }
  });

  // 頂点: 建物
  g.vertices.forEach((v) => {
    if (!v.building) return;
    const x = v.x * SCALE, z = v.y * SCALE;
    const hexAtV = v.hexIds.map((id) => g.hexes[id]).find(Boolean);
    const baseY = hexAtV ? (TERRAIN_HEIGHT[hexAtV.fog ? 'fog' : hexAtV.terrain] ?? 10) : 4;
    const color = new THREE.Color(game.players[v.building.owner].color);
    if (v.building.type === 'city') addCity(x, baseY, z, color); else addHouse(x, baseY, z, color);
  });

  // 騎士（都市と騎士）・蛮族の騎士（交易と略奪）: 簡素な色付きの駒
  if (game.players[0] && game.players[0].knights) {
    game.players.forEach((pl) => (pl.knights || []).forEach((k) => {
      const v = g.vertices[k.vertexId];
      const hexAtV = v.hexIds.map((id) => g.hexes[id]).find(Boolean);
      const baseY = hexAtV ? (TERRAIN_HEIGHT[hexAtV.fog ? 'fog' : hexAtV.terrain] ?? 10) : 4;
      addKnight(v.x * SCALE, baseY, v.y * SCALE, pl.color, k.active);
    }));
  }
  if (g.castleHexId != null) {
    game.players.forEach((pl) => (pl.warKnights || []).forEach((k) => {
      const e = g.edges[k.edgeId];
      const v1 = g.vertices[e.v1], v2 = g.vertices[e.v2];
      addKnight((v1.x + v2.x) / 2 * SCALE, 10, (v1.y + v2.y) / 2 * SCALE, pl.color, true);
    }));
  }

  // 盗賊・海賊
  if (g.robberHex != null) {
    const [cx, cz] = hexCenterOf(g, g.hexes[g.robberHex]);
    const h = TERRAIN_HEIGHT[g.hexes[g.robberHex].terrain] ?? 10;
    addRobber(cx, h, cz, uiState && (uiState.mode === 'moveRobber' || uiState.mode === 'devKnightHex'));
  }
  if (g.pirateHex != null) {
    const [cx, cz] = hexCenterOf(g, g.hexes[g.pirateHex]);
    addPirate(cx, TERRAIN_HEIGHT.water, cz, uiState && (uiState.mode === 'moveRobber' || uiState.mode === 'devKnightHex'));
  }

  // ---- 置ける場所など、overlay に入っている当たり判定をそのまま光る的にする ----
  (overlay || []).forEach((o) => addOverlayTarget(g, o));

  renderer.shadowMap.needsUpdate = true;
}

function disposeGroup(group) {
  group.traverse((o) => {
    if (o.geometry && o.geometry !== GEO.trunk && !Object.values(GEO).includes(o.geometry)) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    mats.forEach((m) => { if (!Object.values(MAT).includes(m)) m.dispose(); });
  });
  while (group.children.length) group.remove(group.children[0]);
}

// 盤の大きさに合わせてカメラを置く。拡張などで枚数が変わった(=新しい盤になった)ときだけ
// 視点をリセットする。遊んでいる間に毎回カメラを戻すと操作の邪魔になるので、それ以外は触らない。
function frameCamera(g) {
  if (framedForHexCount === g.hexes.length) return;
  framedForHexCount = g.hexes.length;
  let maxR = 0;
  g.vertices.forEach((v) => { maxR = Math.max(maxR, Math.hypot(v.x * SCALE, v.y * SCALE)); });
  const dist = maxR * 1.9;
  camera.position.set(0, dist * 0.78, dist * 0.68);
  controls.target.set(0, 0, 0);
  controls.minDistance = maxR * 0.5;
  controls.maxDistance = maxR * 3.2;
  controls.update();
}

function addNumberChip(x, z, baseY, n, hot, scale) {
  const y = baseY + 1.5;
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(15 * scale, 15 * scale, 2.4, 20),
    new THREE.MeshStandardMaterial({ map: numberTexture(n, hot), roughness: 0.6 }));
  disc.rotation.x = 0;
  disc.position.set(x, y, z);
  disc.castShadow = true;
  sceneGroup.add(disc);
}

function addPort(g, eId) {
  const e = g.edges[eId];
  const v1 = g.vertices[e.v1], v2 = g.vertices[e.v2];
  const mx = (v1.x + v2.x) / 2 * SCALE, mz = (v1.y + v2.y) / 2 * SCALE;
  const [hx, hz] = hexCenterOf(g, g.hexes[e.hexIds[0]]);
  const nx = mx - hx, nz = mz - hz, len = Math.hypot(nx, nz) || 1;
  const px = mx + (nx / len) * (SCALE * Math.sqrt(3) / 2), pz = mz + (nz / len) * (SCALE * Math.sqrt(3) / 2);
  const type = v1.port;
  const isAny = type === '3:1';
  const color = isAny ? 0xf0e4bc : (RES_COLOR3D[type] ?? 0xcccccc);
  [v1, v2].forEach((v) => {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 10, 6), new THREE.MeshStandardMaterial({ color: 0x6e5436, flatShading: true }));
    pole.position.set(v.x * SCALE, 5, v.y * SCALE);
    sceneGroup.add(pole);
  });
  const raft = new THREE.Mesh(new THREE.CylinderGeometry(16, 16, 3, 10), new THREE.MeshStandardMaterial({ color, flatShading: true }));
  raft.position.set(px, 3, pz);
  raft.castShadow = true;
  sceneGroup.add(raft);
}

function addCastle(cx, cz, height) {
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(16, 20, 34, 8), new THREE.MeshStandardMaterial({ color: 0x8b8f99, flatShading: true }));
  tower.position.set(cx, height + 17, cz);
  tower.castShadow = true;
  const roof = new THREE.Mesh(new THREE.ConeGeometry(20, 16, 8), new THREE.MeshStandardMaterial({ color: 0x5a3a2a, flatShading: true }));
  roof.position.set(cx, height + 42, cz);
  sceneGroup.add(tower, roof);
}
function addPitch(cx, cz, height) {
  const ring = new THREE.Mesh(new THREE.TorusGeometry(16, 1.2, 6, 24), new THREE.MeshStandardMaterial({ color: 0xeafbe0 }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(cx, height + 0.5, cz);
  sceneGroup.add(ring);
  [[-30, 0], [30, 0]].forEach(([dx]) => {
    const frame = new THREE.Mesh(new THREE.BoxGeometry(3, 8, 20), new THREE.MeshStandardMaterial({ color: 0xeafbe0 }));
    frame.position.set(cx + dx, height + 4, cz);
    sceneGroup.add(frame);
  });
}

function addShip(mx, mz, ang, playerColor) {
  const hull = new THREE.Mesh(new THREE.BoxGeometry(18, 5, 7), new THREE.MeshStandardMaterial({ color: 0x4a3420, flatShading: true }));
  hull.position.set(mx, TERRAIN_HEIGHT.water + 2.5, mz);
  hull.rotation.y = ang;
  const sail = new THREE.Mesh(new THREE.ConeGeometry(6, 12, 3), new THREE.MeshStandardMaterial({ color: new THREE.Color(playerColor), flatShading: true }));
  sail.rotation.y = ang;
  sail.rotation.z = Math.PI / 2;
  sail.position.set(mx, TERRAIN_HEIGHT.water + 9, mz);
  hull.castShadow = true; sail.castShadow = true;
  sceneGroup.add(hull, sail);
}

function addHouse(x, baseY, z, color) {
  const body = new THREE.Mesh(new THREE.BoxGeometry(11, 9, 11), new THREE.MeshStandardMaterial({ color, flatShading: true }));
  body.position.set(x, baseY + 4.5 + 1.5, z);
  const roof = new THREE.Mesh(new THREE.ConeGeometry(9, 8, 4), new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.75), flatShading: true }));
  roof.rotation.y = Math.PI / 4;
  roof.position.set(x, baseY + 9 + 4 + 1.5, z);
  body.castShadow = true; roof.castShadow = true;
  sceneGroup.add(body, roof);
}
function addCity(x, baseY, z, color) {
  const base = new THREE.Mesh(new THREE.BoxGeometry(17, 10, 17), new THREE.MeshStandardMaterial({ color, flatShading: true }));
  base.position.set(x, baseY + 5 + 1.5, z);
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 18, 8), new THREE.MeshStandardMaterial({ color, flatShading: true }));
  tower.position.set(x, baseY + 10 + 9 + 1.5, z);
  const roof = new THREE.Mesh(new THREE.ConeGeometry(7, 9, 8), new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.75), flatShading: true }));
  roof.position.set(x, baseY + 10 + 18 + 4.5 + 1.5, z);
  [base, tower, roof].forEach((m) => { m.castShadow = true; sceneGroup.add(m); });
}
function addKnight(x, baseY, z, color, active) {
  const c = new THREE.Color(color);
  if (!active) c.multiplyScalar(0.55);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 4.2, 10, 7), new THREE.MeshStandardMaterial({ color: c, flatShading: true }));
  body.position.set(x, baseY + 5 + 1.5, z);
  const head = new THREE.Mesh(new THREE.SphereGeometry(3, 8, 6), new THREE.MeshStandardMaterial({ color: c, flatShading: true }));
  head.position.set(x, baseY + 11 + 1.5, z);
  sceneGroup.add(body, head);
}
function addRobber(cx, height, cz, blink) {
  const body = new THREE.Mesh(new THREE.ConeGeometry(9, 22, 8), new THREE.MeshStandardMaterial({ color: 0x1c1b22, flatShading: true }));
  body.position.set(cx, height + 11, cz);
  const head = new THREE.Mesh(new THREE.SphereGeometry(6, 8, 6), new THREE.MeshStandardMaterial({ color: 0x2d2c36, flatShading: true }));
  head.position.set(cx, height + 25, cz);
  sceneGroup.add(body, head);
  if (blink) addPulseRing(cx, height + 1, cz, 20, 0xffd84a);
}
function addPirate(cx, height, cz, blink) {
  const hull = new THREE.Mesh(new THREE.BoxGeometry(22, 6, 14), new THREE.MeshStandardMaterial({ color: 0x2b1d10, flatShading: true }));
  hull.position.set(cx, height + 3, cz);
  sceneGroup.add(hull);
  addRobber(cx, height + 4, cz, blink);
}
function addPulseRing(x, y, z, r, color) {
  const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 1.6, 6, 28),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1, flatShading: true }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, y, z);
  ring.userData.baseScale = 1;
  sceneGroup.add(ring);
  pulseMeshes.push(ring);
}

// overlay の1件(頂点/辺/マスの当たり判定)を、光る的として3Dに置く
function addOverlayTarget(g, o) {
  const a = o.attrs;
  if (a['data-vertex'] != null) {
    const v = g.vertices[Number(a['data-vertex'])];
    const hexAtV = v.hexIds.map((id) => g.hexes[id]).find(Boolean);
    const baseY = hexAtV ? (TERRAIN_HEIGHT[hexAtV.fog ? 'fog' : hexAtV.terrain] ?? 10) : 4;
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 3, 16),
      new THREE.MeshStandardMaterial({ color: 0xf0cf85, emissive: 0xf0cf85, emissiveIntensity: 0.6, transparent: true, opacity: 0.9 }));
    mesh.position.set(v.x * SCALE, baseY + 2, v.y * SCALE);
    mesh.userData.baseScale = 1;
    sceneGroup.add(mesh);
    hitTargets.push({ mesh, kind: 'vertex', id: v.id });
    pulseMeshes.push(mesh);
  } else if (a['data-edge'] != null) {
    const e = g.edges[Number(a['data-edge'])];
    const v1 = g.vertices[e.v1], v2 = g.vertices[e.v2];
    const x1 = v1.x * SCALE, z1 = v1.y * SCALE, x2 = v2.x * SCALE, z2 = v2.y * SCALE;
    const hexAtE = e.hexIds.map((id) => g.hexes[id]).find(Boolean);
    const baseY = hexAtE ? (TERRAIN_HEIGHT[hexAtE.fog ? 'fog' : hexAtE.terrain] ?? 10) : 4;
    const len = Math.hypot(x2 - x1, z2 - z1);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(len * 0.8, 3, 11),
      new THREE.MeshStandardMaterial({ color: 0xf0cf85, emissive: 0xf0cf85, emissiveIntensity: 0.6, transparent: true, opacity: 0.85 }));
    mesh.position.set((x1 + x2) / 2, baseY + 2, (z1 + z2) / 2);
    mesh.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
    sceneGroup.add(mesh);
    hitTargets.push({ mesh, kind: 'edge', id: e.id });
    pulseMeshes.push(mesh);
  } else if (a['data-hex'] != null) {
    const hex = g.hexes[Number(a['data-hex'])];
    const [cx, cz] = hexCenterOf(g, hex);
    const height = TERRAIN_HEIGHT[hex.fog ? 'fog' : hex.terrain] ?? 10;
    const pts = hexPointsOf(g, hex);
    const mesh = new THREE.Mesh(hexPrismGeometry(pts.map(([x, z]) => [x, z]), 2),
      new THREE.MeshStandardMaterial({ color: 0xffe9a8, emissive: 0xffd84a, emissiveIntensity: 0.5, transparent: true, opacity: 0.55, side: THREE.DoubleSide }));
    mesh.position.y = height + 1;
    sceneGroup.add(mesh);
    hitTargets.push({ mesh, kind: 'hex', id: hex.id });
    pulseMeshes.push(mesh);
  }
}
