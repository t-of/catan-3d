'use strict';
// 盤の3D表示。main.js・engine.jsを知らない（渡されたプレーンなデータだけを読む）小さなモジュール。
//
// 使い方:
//   initBoard3D(container, onTap)  … 起動時に1回。onTap('vertex'|'edge'|'hex', id) はタップで呼ばれる
//   renderBoard3D(game, uiState, overlay) … 盤を描き直すたびに呼ぶ（main.jsのrenderBoardIntoと同じ頻度でよい）
//     overlay は renderBoardInto が返す配列（置ける頂点・辺・マスの当たり判定の素）をそのまま渡す。
//
// SVG版（main.jsのrenderBoardInto）と同じく、呼ばれるたびに小物（木・羊・建物・盗賊など）は作り直す。
// 地形（島）と海は盤の形が変わったとき（拡張など、hexの並びが変わったとき）だけ作り直す重いメッシュなので、
// 作り直さず使い回す（sceneGroupとは別に地形用のグループを持つ）。
//
// 画質: URLの?q=highで細かい地形メッシュ(QUALITY参照)。無指定/他の値は中品質。⑤までにUIの設定を足す。
import * as THREE from './vendor/three.module.min.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { RoomEnvironment } from './vendor/RoomEnvironment.js';
import { RGBELoader } from './vendor/RGBELoader.js';
import { EffectComposer } from './vendor/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/postprocessing/RenderPass.js';
import { GTAOPass } from './vendor/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from './vendor/postprocessing/UnrealBloomPass.js';
import { LUTPass } from './vendor/postprocessing/LUTPass.js';
import { OutputPass } from './vendor/postprocessing/OutputPass.js';

const SCALE = 66; // main.jsのSCALEと同じ値（頂点のx,yをこの倍率でワールド座標にする）
const PREFERS_REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
// 「動き オフ」ボタン(main.js)はhtmlにmotion-offクラスを付ける。風の揺れ・波・雲の影もそれに合わせて止める。
function motionOff() { return PREFERS_REDUCED || document.documentElement.classList.contains('motion-off'); }
const QUALITY = (() => { try { return new URLSearchParams(location.search).get('q') === 'high' ? 'high' : 'mid'; } catch { return 'mid'; } })();
// ponytail: 品質はこの定数だけで決める。⑤でUIのトグルを足すときはここを書き換える処理を足すだけでよい。
const Q = {
  mid: { cell: 4, maxGrid: 240, shadowMap: 2048, gtaoSamples: 10, bloom: false, dprCap: 2 },
  high: { cell: 1.3, maxGrid: 520, shadowMap: 4096, gtaoSamples: 16, bloom: true, dprCap: 2.5 }, // 盤全体で512x512以上(ブリーフの要求)
}[QUALITY];
// 太陽の向き(午後の低い角度)。方位はカメラが見やすい斜め後ろから、高度25-35°
const SUN_AZIMUTH = Math.PI * 0.64;
const SUN_ELEVATION = Math.PI / 180 * 29;
// マス中心の座標+地形idをシェーダへ渡す上限(5-6人拡張込みの最大枚数30に余裕を見た数)
const MAX_LAND_HEXES = 36;

// ---- 地形の寸法(engine.jsのhexCorner/hexCenterと同じ単位。circumradius=1をSCALE倍) ----
const HEX_R = SCALE; // 中心→頂点(円周半径)
const HEX_A = SCALE * Math.sqrt(3) / 2; // 中心→辺の中点(アポセム)
const LAND_BASE = 14; // 陸の基準の高さ(マス中心の平らな部分)
const SEA_LEVEL = 0; // 海面(港・船・浮く物の基準)
const SHELF = -3; // 渚のすぐ沖(浅瀬の棚)。海のシェーダはここを「浅い」側の基準にするので海面(0)に近づける
const SEABED = -26; // 沖の海底
const RES_COLOR3D = { wood: 0x3f8a4a, brick: 0xc0643a, sheep: 0x8cc063, wheat: 0xe0b440, ore: 0x8a92a3 };

// 地形ごとのCC0 PBR一式(出典はtextures/CREDITS.md)。gold/castle/pitch/lake/fogは拡張用の特殊地形で、
// 見た目は代用(pasture寄り)にする。water/lakeは地面でなく海(terrainSample内で別扱い)。
// 配列の並びがそのままシェーダのterrain id(0〜5)。ROCK_ID/SAND_IDは斜面・渚のブレンド先として使う。
const TERRAIN_NAMES = ['forest', 'pasture', 'field', 'hills', 'mountains', 'desert'];
const ROCK_ID = TERRAIN_NAMES.indexOf('mountains');
const SAND_ID = TERRAIN_NAMES.indexOf('desert');
const WATER_LIKE = new Set(['water', 'lake']);

// ---- 島の形まわりの定数 ----
// マス同士(陸×陸)の材質・起伏を混ぜる幅。真の渚(海岸線)からの距離とは別物で、どの地形でも常に効く。
const HEX_BLEND = 20;
// 渚から陸側に戻る帯(この中でLAND_BASEへ、またはLAND_BASEから渚の高さへなだらかに移る)
const COAST_BAND = 40;
// 渚から沖に向かって浅瀬→海底まで落ちきる距離
const DEEP_BAND = HEX_A * 1.9;
// 海岸線の形をいびつにするノイズの振れ幅(渚からの距離そのものを揺らす)
const COAST_JITTER = 22;
// 斜面を岩肌に切り替える、法線の傾き(1-normal.y)のしきい値。この間でsmoothstep
const SLOPE_LO = 0.14, SLOPE_HI = 0.34;

let scene, camera, renderer, controls, raycaster, pointer, clock, sun;
let sceneGroup; // 毎回まるごと作り直す小物(木・建物・盗賊・overlayなど)
let terrainGroup = null; // 地形(島)のメッシュ。盤の形が変わったときだけ作り直す
let oceanMesh = null; // 海。盤の形が変わったときだけ作り直す
let boardSignature = null; // 地形メッシュ・海を作り直すべきかの目印(hex数+地形の並び)
let hexHeight = new Map(); // hex.id -> マス中心の高さ(小物を置く基準の高さ)
let onTapCb = null;
let hitTargets = []; // [{ mesh, kind, id }]（レイキャストで拾う的）
let pulseMeshes = []; // 明滅させる的（置ける場所・盗賊など）
let framedForHexCount = null;
let hasDebugCam = false; // ?camが指定されていたら、frameCamera()でカメラ位置を奪い返さない
let oceanUniforms = null;
let landUniforms = null;
let vegUniforms = { uTime: { value: 0 } }; // 木・麦・羊など小物の風の揺れ共通(全部の材質で使い回す)
let terrainField = null; // 地形の高さ・地形idを任意の(x,z)で引けるもの(盤の形が変わるたびに作り直す)
let composer = null; // EffectComposer(GTAO/ブルーム/LUT/SMAA/OutputPass)。renderer.render直接呼びはしない
let gtaoPass = null, bloomPass = null;

// ---- 共通ジオメトリ（使い回す。インスタンスごとに作らない） ----
// ③: 単純図形(円錐1個の木・球1個の羊)はやめ、どれも2〜3パーツの組み合わせにした。
// 縮尺は1マス数百m相当なので、個々のパーツは小さくInstancedMeshで数百〜数千個並べる前提の大きさ。
const GEO = {
  conTrunk: new THREE.CylinderGeometry(0.5, 0.7, 3.4, 6), // 針葉樹の幹(細い)
  conCanopy: new THREE.ConeGeometry(2.5, 6, 8), // 針葉樹の樹冠
  broadTrunk: new THREE.CylinderGeometry(0.6, 0.9, 2.2, 6), // 広葉樹の幹(短く太い)
  broadCanopy: smoothGeo(new THREE.IcosahedronGeometry(2.5, 1)), // 広葉樹の樹冠(丸い塊。低ポリ球よりいびつ)
  sheepBody: smoothGeo(new THREE.IcosahedronGeometry(1.3, 1)).scale(1, 0.78, 1.15),
  sheepHead: new THREE.SphereGeometry(0.55, 6, 5),
  fencePost: new THREE.CylinderGeometry(0.22, 0.25, 1.8, 5),
  fenceRail: new THREE.BoxGeometry(1, 0.16, 0.14),
  fieldRock: new THREE.DodecahedronGeometry(0.55, 0),
  wheat: new THREE.ConeGeometry(0.75, 2.8, 6), // 麦の束(短冊の畝の上に並べる)
  brick: new THREE.BoxGeometry(1.1, 0.6, 0.6),
  kilnBody: new THREE.CylinderGeometry(2.4, 2.8, 3.6, 8),
  kilnRoof: new THREE.ConeGeometry(2.9, 1.8, 8),
  smoke: smoothGeo(new THREE.IcosahedronGeometry(1, 1)),
  peak: new THREE.ConeGeometry(9, 22, 6),
  snowCap: new THREE.ConeGeometry(3.4, 7, 6),
  scree: new THREE.DodecahedronGeometry(0.9, 0),
  mineFrame: new THREE.BoxGeometry(3.6, 4, 1.4),
  mineHole: new THREE.BoxGeometry(2.2, 2.6, 0.4),
  rail: new THREE.BoxGeometry(1, 0.14, 0.16),
  tie: new THREE.BoxGeometry(1.4, 0.14, 0.5),
  dune: new THREE.ConeGeometry(10, 3.4, 12),
  dryGrass: new THREE.ConeGeometry(0.3, 1.5, 5),
  desertRock: new THREE.DodecahedronGeometry(0.8, 0),
  nugget: new THREE.OctahedronGeometry(3.4, 0),
  road: new THREE.CylinderGeometry(3.4, 3.4, 1, 8), // 角を落とした木の棒(断面が八角形の丸太)。長さはmeshのscale.yで伸ばす
  dockPlank: new THREE.BoxGeometry(2.2, 0.4, 1.3),
  boatHull: new THREE.BoxGeometry(7, 2, 2.6),
  boatSail: new THREE.ConeGeometry(1.6, 3.6, 3),
  signPost: new THREE.CylinderGeometry(0.22, 0.26, 3.4, 6),
  signBoard: new THREE.BoxGeometry(3.2, 1.8, 0.2),
  hedge: new THREE.BoxGeometry(1, 1.1, 0.9),
  wallStone: new THREE.BoxGeometry(1, 0.95, 0.85),
  pathTile: new THREE.BoxGeometry(1, 0.08, 1.1),
  streamTile: new THREE.BoxGeometry(1, 0.05, 1.3),
};
function smoothGeo(g) { g.computeVertexNormals(); return g; }
const MAT = {
  conBark: new THREE.MeshStandardMaterial({ color: 0x4a3420, roughness: 0.95 }),
  conLeaf: new THREE.MeshStandardMaterial({ color: 0x386b46, roughness: 0.9 }),
  broadBark: new THREE.MeshStandardMaterial({ color: 0x5b3a22, roughness: 0.95 }),
  broadLeaf: new THREE.MeshStandardMaterial({ color: 0x4f8a44, roughness: 0.9 }),
  sheep: new THREE.MeshStandardMaterial({ color: 0xf4f1e6, roughness: 0.85 }),
  sheepHead: new THREE.MeshStandardMaterial({ color: 0x7a6a56, roughness: 0.8 }),
  fence: new THREE.MeshStandardMaterial({ color: 0x8a6d46, roughness: 0.9 }),
  fieldRock: new THREE.MeshStandardMaterial({ color: 0x9a9183, roughness: 0.95 }),
  wheat: new THREE.MeshStandardMaterial({ color: 0xe4b63e, roughness: 0.8 }),
  brick: new THREE.MeshStandardMaterial({ color: 0xa6502f, roughness: 0.92 }),
  kiln: new THREE.MeshStandardMaterial({ color: 0x8a6a54, roughness: 0.95 }),
  smoke: new THREE.MeshStandardMaterial({ color: 0xd8d6d0, roughness: 1, transparent: true, opacity: 0.4 }),
  peak: new THREE.MeshStandardMaterial({ color: 0x9aa0ac, roughness: 0.9 }),
  snow: new THREE.MeshStandardMaterial({ color: 0xf4f8ff, roughness: 0.7 }),
  scree: new THREE.MeshStandardMaterial({ color: 0x81868f, roughness: 0.95 }),
  mineFrame: new THREE.MeshStandardMaterial({ color: 0x5b4226, roughness: 0.9 }),
  mineHole: new THREE.MeshStandardMaterial({ color: 0x100d0a, roughness: 1 }),
  rail: new THREE.MeshStandardMaterial({ color: 0x5a5a5a, roughness: 0.6, metalness: 0.4 }),
  tie: new THREE.MeshStandardMaterial({ color: 0x4a3420, roughness: 0.9 }),
  sand: new THREE.MeshStandardMaterial({ color: 0xdfc688, roughness: 1 }),
  dryGrass: new THREE.MeshStandardMaterial({ color: 0xb8a157, roughness: 0.9 }),
  desertRock: new THREE.MeshStandardMaterial({ color: 0xaa9877, roughness: 0.95 }),
  gold: new THREE.MeshStandardMaterial({ color: 0xf0c83c, roughness: 0.4, metalness: 0.6, emissive: 0x4a3a00 }),
  dock: new THREE.MeshStandardMaterial({ color: 0x7a5c38, roughness: 0.9 }),
  boatHull: new THREE.MeshStandardMaterial({ color: 0x4a3420, roughness: 0.85 }),
  signPost: new THREE.MeshStandardMaterial({ color: 0x6e5436, roughness: 0.9 }),
  hedge: new THREE.MeshStandardMaterial({ color: 0x3f6b3a, roughness: 0.9 }),
  wallStone: new THREE.MeshStandardMaterial({ color: 0x8d897e, roughness: 0.95 }),
  path: new THREE.MeshStandardMaterial({ color: 0x7a6a4d, roughness: 1 }),
  stream: new THREE.MeshStandardMaterial({ color: 0x3a90a8, roughness: 0.3, transparent: true, opacity: 0.85 }),
};
// 密度・サイズは本物の縮尺(1マス=数百m)に合わせて小さく大量に置く。画質(中/高)で数だけ変える。
const DENSITY = { mid: 1, high: 3.4 }[QUALITY];

// 風の揺れ(頂点シェーダ)。InstancedMeshの各個体ごとに位相をずらし(instanceMatrixの位置から)、
// ジオメトリの上のほう(position.yが大きいところ)ほど大きく揺らす。「動き オフ」ではuTimeの更新を
// 止める(animate()参照)ので、自然に止まる(このシェーダ自体に有効フラグは持たせない)。
function applyWindSway(mat, heightRef, amp, freq) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, vegUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          float windPhase = instanceMatrix[3].x * 0.07 + instanceMatrix[3].z * 0.05;
        #else
          float windPhase = 0.0;
        #endif
        float windLift = clamp(position.y / ${heightRef.toFixed(2)}, 0.0, 1.0);
        windLift *= windLift;
        transformed.x += sin(uTime * ${freq.toFixed(2)} + windPhase) * ${amp.toFixed(2)} * windLift;
        transformed.z += cos(uTime * ${(freq * 0.82).toFixed(2)} + windPhase) * ${(amp * 0.6).toFixed(2)} * windLift;`);
  };
}
applyWindSway(MAT.conLeaf, 3.0, 0.22, 1.1);
applyWindSway(MAT.broadLeaf, 2.5, 0.26, 1.0);
applyWindSway(MAT.wheat, 1.4, 0.16, 2.2);
applyWindSway(MAT.dryGrass, 0.75, 0.1, 1.6);
const TERRAIN_MAT = {}; // 地形ごとのタイル材質(一度作ったら使い回す)。terrainTextures()の結果と対応

function clampUnit(v) { return Math.min(1, Math.max(0, v)); }
function smoothstep(lo, hi, v) { const t = clampUnit((v - lo) / (hi - lo)); return t * t * (3 - 2 * t); }
function lerp(a, b, t) { return a + (b - a) * t; }

// 色調整のLUT(3D Data Texture)をコードで作る(.cubeファイルを持たないぶん軽い)。
// 「彩度を少し落とし、影をわずかに青く、ハイライトを暖かく」。恒等変換からのズレは小さく抑える。
function buildColorLUT(size) {
  const data = new Uint8Array(size * size * size * 4);
  const SAT = 0.88; // 1よりわずかに落とす
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        let R = r / (size - 1), G = g / (size - 1), B = b / (size - 1);
        const luma = R * 0.299 + G * 0.587 + B * 0.114;
        R = luma + (R - luma) * SAT; G = luma + (G - luma) * SAT; B = luma + (B - luma) * SAT;
        const shadowW = 1 - smoothstep(0.12, 0.5, luma); // 暗部ほど強く青みを足す
        const highW = smoothstep(0.5, 0.92, luma); // 明部ほど強く暖色を足す
        R += highW * 0.045 - shadowW * 0.025;
        G += highW * 0.015 - shadowW * 0.01;
        B += highW * -0.035 + shadowW * 0.06;
        // 全体に軽いS字(中間調を少し締める)でコントラストを足す。霞んで見える対策
        R = R + (R - 0.5) * 0.08; G = G + (G - 0.5) * 0.08; B = B + (B - 0.5) * 0.08;
        const idx = (b * size * size + g * size + r) * 4;
        data[idx] = Math.round(clampUnit(R) * 255);
        data[idx + 1] = Math.round(clampUnit(G) * 255);
        data[idx + 2] = Math.round(clampUnit(B) * 255);
        data[idx + 3] = 255;
      }
    }
  }
  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

// 地形・海のシェーダ両方で使う「ゆっくり流れる雲の影」のGLSL(薄く乗算するだけ)。
// 値ノイズ(双線形補間つき)をuTimeでずらして動かす。
const CLOUD_GLSL = `
  float cloudHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float cloudNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    float a = cloudHash(i), b = cloudHash(i + vec2(1.0, 0.0));
    float c = cloudHash(i + vec2(0.0, 1.0)), d = cloudHash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
  }
  float cloudShadow(vec2 worldXZ, float t) {
    vec2 p = worldXZ * 0.0022 + vec2(t * 0.010, t * 0.006);
    float n = cloudNoise(p) * 0.6 + cloudNoise(p * 2.1 + 19.0) * 0.4;
    return mix(0.9, 1.0, smoothstep(0.32, 0.72, n));
  }
`;

export function initBoard3D(container, onTap) {
  onTapCb = onTap;
  scene = new THREE.Scene();
  scene.background = skyTexture();
  // ③の見え直し: 高画質がフォグで白っぽく霞みすぎていたので、効き始めと濃さを後ろへ(手前はくっきり、遠くだけ霞む)
  scene.fog = new THREE.Fog(0xaed4e8, 1300, 2600);

  camera = new THREE.PerspectiveCamera(42, 1, 1, 4000);
  // AAはEffectComposerのMSAA描画先(buildComposer)が引き受けるので、WebGLRenderer自体では二重にしない
  renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
  // 細い指での操作が多い環境(タッチ)は解像度を少し落として重さを抑える。高品質はデスクトップ前提で上げる
  const dprCap = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ? 1.5 : Q.dprCap;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.88; // 0.95だと白飛び気味でコントラストが低かったので少し絞る
  container.appendChild(renderer.domElement);

  // 環境光(映り込み)。まずRoomEnvironmentですぐ出し、CC0の屋外HDRI(textures/CREDITS.md)が
  // 読み込めたら差し替える(読み込みに失敗・時間がかかっても画面は止めない)。
  // 背景もこのHDRI(午後の晴天)にして、海の向こうに霞んだ空と地平線が見えるようにする。
  // 読み込みが終わるまで/失敗時はこれまで通りCanvasのグラデーション(skyTexture)。
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  new RGBELoader().load('./textures/sky.hdr', (hdr) => {
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    const envMap = pmrem.fromEquirectangular(hdr).texture;
    scene.environment = envMap;
    scene.background = hdr;
    scene.backgroundIntensity = 1;
    pmrem.dispose();
  }, undefined, () => { pmrem.dispose(); });

  scene.add(new THREE.HemisphereLight(0xdceeff, 0x24321e, 0.55));
  // 午後の低い太陽。暖色だが地形の色そのものを赤く染めないよう、彩度は控えめな暖白にする
  sun = new THREE.DirectionalLight(0xfff0d6, 1.7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(Q.shadowMap, Q.shadowMap);
  sun.shadow.bias = -0.00018;
  sun.shadow.normalBias = 1.4; // シーンのスケールが大きい(1単位≒数m)ぶん大きめの値にしてアクネを消す
  sun.shadow.camera.near = 10; sun.shadow.camera.far = 1600; // 盤の大きさが分かり次第updateSunForBoard()で詰め直す
  scene.add(sun);
  // 太陽を仮置き(盤の大きさが分かる最初のframeCamera()でupdateSunForBoard()が向き直す)
  updateSunForBoard(HEX_R * 3);

  // 木・羊・麦・岩などに使う材質は、個体ごとに色をわずかにずらす(InstancedMeshの頂点カラー)
  [MAT.conLeaf, MAT.broadLeaf, MAT.sheep, MAT.wheat, MAT.brick, MAT.peak, MAT.scree, MAT.fieldRock, MAT.desertRock, MAT.dryGrass]
    .forEach((m) => { m.vertexColors = true; });

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

  buildComposer(container);

  attachInput(renderer.domElement);
  new ResizeObserver(() => resize(container)).observe(container);
  resize(container);
  applyDebugCamera(); // ?camのデバッグ用カメラ固定(なければ何もしない)
  renderer.setAnimationLoop(animate);
}

// 後処理一式: RenderPass -> GTAO -> (高品質のみ)Bloom -> LUT(色調整) -> SMAA -> OutputPass。
// GTAOPassはシーンのスケール(1単位≒数m)に合わせて半径などを調整している。
function buildComposer(container) {
  const w = Math.max(1, container.clientWidth || 1), h = Math.max(1, container.clientHeight || 1);
  // ③の見え直し: SMAAPass(モルフォロジー型)は、小さくたくさん置いた木・羊など細かい形を
  // 「ノイズ」と誤認してまるごと塗り消してしまう(植生が見えなくなる不具合の原因だった)。
  // 代わりにMSAA(マルチサンプリングの描画先)でジオメトリの縁だけ滑らかにする。
  const pr = renderer.getPixelRatio();
  const msaaTarget = new THREE.WebGLRenderTarget(w * pr, h * pr, { type: THREE.HalfFloatType, samples: 4 });
  composer = new EffectComposer(renderer, msaaTarget);
  composer.addPass(new RenderPass(scene, camera));

  gtaoPass = new GTAOPass(scene, camera, w, h,
    {},
    { radius: 7, distanceExponent: 1.5, thickness: 1.6, scale: 1, samples: Q.gtaoSamples, distanceFallOff: 0.6, screenSpaceRadius: false },
    {});
  gtaoPass.output = GTAOPass.OUTPUT.Default;
  gtaoPass.blendIntensity = 0.6; // 薄く(ハローが目立たない程度)
  composer.addPass(gtaoPass);

  if (Q.bloom) {
    bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.06, 0.35, 0.96); // 弱め・白飛びしない程度(③で霞み対策にさらに絞った)
    composer.addPass(bloomPass);
  }

  composer.addPass(new LUTPass({ lut: buildColorLUT(16), intensity: 1 }));

  composer.addPass(new OutputPass());
}

function resize(container) {
  const w = container.clientWidth || 1, h = container.clientHeight || 1;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  if (composer) composer.setSize(w, h);
}

// 太陽を盤の大きさ(maxR)に合わせて配置し直し、影カメラの範囲もきっちり覆う。
// 盤の形が変わる・初回の計測が終わるたびにframeCamera()から呼ばれる。
function updateSunForBoard(maxR) {
  const dist = Math.max(500, maxR * 2.4);
  const horiz = Math.cos(SUN_ELEVATION) * dist;
  sun.position.set(Math.cos(SUN_AZIMUTH) * horiz, Math.sin(SUN_ELEVATION) * dist, Math.sin(SUN_AZIMUTH) * horiz);
  sun.target.position.set(0, 0, 0);
  sun.target.updateMatrixWorld();
  sun.shadow.camera.near = Math.max(1, dist - maxR * 3);
  sun.shadow.camera.far = dist + maxR * 3;
  const sd = maxR * 1.15;
  sun.shadow.camera.left = -sd; sun.shadow.camera.right = sd;
  sun.shadow.camera.top = sd; sun.shadow.camera.bottom = -sd;
  sun.shadow.camera.updateProjectionMatrix();
}

// 比較用スクリーンショットのための一時的なデバッグ口。
// ?cam=x,y,z,tx,ty,tz を付けたときだけカメラを固定する(なければ何もしない)。本番の操作には使わない。
function applyDebugCamera() {
  let raw;
  try { raw = new URLSearchParams(location.search).get('cam'); } catch { raw = null; }
  if (!raw) return;
  const n = raw.split(',').map(Number);
  if (n.length < 6 || n.some((v) => !Number.isFinite(v))) return;
  camera.position.set(n[0], n[1], n[2]);
  controls.target.set(n[3], n[4], n[5]);
  controls.enabled = false;
  // デバッグ用途なので、比較スクリーンショットのために普段のズーム・角度の制限を外す
  controls.minDistance = 0; controls.maxDistance = Infinity;
  controls.minPolarAngle = 0; controls.maxPolarAngle = Math.PI;
  controls.update();
  hasDebugCam = true;
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

// 空のグラデーション(濃い青→水平線の淡い水色)。1回だけ作って使い回す
function skyTexture() {
  const c = document.createElement('canvas');
  c.width = 2; c.height = 256;
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#2d6ca0');
  grad.addColorStop(1, '#bfe3f2');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 2, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function animate() {
  const t = clock.getElapsedTime();
  if (!motionOff()) {
    if (oceanUniforms) oceanUniforms.uTime.value = t;
    if (landUniforms) landUniforms.uTime.value = t;
    if (vegUniforms) vegUniforms.uTime.value = t;
  }
  pulseMeshes.forEach((m, i) => {
    const k = 0.55 + Math.sin(t * 3 + i * 0.6) * 0.45;
    if (m.material.emissiveIntensity != null) m.material.emissiveIntensity = 0.4 + k * 1.1;
    if (m.userData.baseScale) { const s = m.userData.baseScale * (1 + k * 0.08); m.scale.setScalar(s); }
  });
  controls.update();
  if (composer) composer.render(); else renderer.render(scene, camera);
}

// ---- 小さな組み立てヘルパー ----
function hexCenterOf(g, hex) {
  const vs = hex.vertexIds.map((id) => g.vertices[id]);
  return [vs.reduce((a, v) => a + v.x, 0) / vs.length * SCALE, vs.reduce((a, v) => a + v.y, 0) / vs.length * SCALE];
}
function hexPointsOf(g, hex) {
  return hex.vertexIds.map((id) => { const v = g.vertices[id]; return [v.x * SCALE, v.y * SCALE]; });
}
// overlayの的(置ける場所の光る六角形)専用の薄い板。地形メッシュとは別物(厚みも面取りもない簡素な形でよい)
function flatHexGeometry(pts, y) {
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const cz = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const pos = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    pos.push(cx, y, cz, a[0], y, a[1], b[0], y, b[1]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}
function instancedFrom(geo, mat, items, variance) {
  if (!items.length) return null;
  const mesh = new THREE.InstancedMesh(geo, mat, items.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const hsl = variance ? mat.color.getHSL({}) : null;
  items.forEach((it, i) => {
    e.set(it.rx || 0, it.ry || 0, it.rz || 0);
    q.setFromEuler(e);
    m4.compose(new THREE.Vector3(it.x, it.y, it.z), q, new THREE.Vector3(it.s ?? 1, it.s ?? 1, it.s ?? 1));
    mesh.setMatrixAt(i, m4);
    if (variance) {
      const r = it.seed != null ? hexRng(it.seed) : rand;
      mesh.setColorAt(i, new THREE.Color().setHSL(
        hsl.h + r(-variance, variance), clampUnit(hsl.s + r(-0.06, 0.06)), clampUnit(hsl.l + r(-0.1, 0.1))));
    }
  });
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.instanceMatrix.needsUpdate = true;
  if (variance) mesh.instanceColor.needsUpdate = true;
  return mesh;
}
function rand(a, b) { return a + Math.random() * (b - a); }
// マスごとに固定の乱数(同じマスは再描画のたびに木・岩の並びが変わらない)。種はhex.id。
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hexRng(seed) {
  const next = mulberry32(seed);
  return (a, b) => a + next() * (b - a);
}

// ================================================================
// ノイズ(値ノイズ+fbm)。外部ライブラリを足さず、島の起伏・海岸線のゆらぎに使う分だけの小さな実装。
// ================================================================
function hash2(ix, iz, seed) {
  let h = (ix * 374761393 + iz * 668265263 + seed * 982451653) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) / 4294967295) * 2 - 1;
}
function valueNoise2(x, z, seed) {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const v00 = hash2(xi, zi, seed), v10 = hash2(xi + 1, zi, seed);
  const v01 = hash2(xi, zi + 1, seed), v11 = hash2(xi + 1, zi + 1, seed);
  const sx = xf * xf * (3 - 2 * xf), sz = zf * zf * (3 - 2 * zf);
  const a = v00 + (v10 - v00) * sx, b = v01 + (v11 - v01) * sx;
  return a + (b - a) * sz;
}
function fbm(x, z, seed, freq, oct, lac, gain) {
  lac = lac ?? 2; gain = gain ?? 0.5;
  let amp = 1, f = freq, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += valueNoise2(x * f, z * f, seed + i * 101) * amp;
    norm += amp;
    amp *= gain; f *= lac;
  }
  return norm ? sum / norm : 0;
}
// 尾根状(山の険しい岩肌)。0(谷)〜1(鋭い尾根)
function ridged(x, z, seed, freq, oct) {
  let amp = 1, f = freq, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += (1 - Math.abs(valueNoise2(x * f, z * f, seed + i * 131))) * amp;
    norm += amp;
    amp *= 0.5; f *= 2;
  }
  return norm ? sum / norm : 0;
}
// 海岸線をゆらす共通のノイズ場(波長は数マス分)。渚からの距離そのものに足して、線を不規則にする
function coastNoise(x, z) { return fbm(x, z, 0.0055, 999, 2); }

// 地形ごとの起伏の形(マス中心からの高さの上積み)。境目(マス間)での減衰はここではせず、
// 隣り合う2マスの値をbuildTerrainField側で数mかけて混ぜる(なじませても陸でなくなることはない)。
// 振幅と周波数の積(≒傾き)を抑えめにして、地形ごとに狙った傾斜になるようにする。
// 山だけ故意に急(尾根・崖)にし、ほかは「斜面の角度で岩肌に切り替える」判定にあまり掛からない程度にする。
function terrainBump(terrain, x, z, seed) {
  const island = fbm(x, z, 0.0035, 42, 2) * 3; // 島全体を通る緩いうねり(マスをまたぐ大きな起伏)
  switch (terrain) {
    case 'forest': return island + fbm(x, z, 0.012, seed, 3) * 2.6 + fbm(x, z, 0.045, seed + 50, 2) * 0.9; // 林冠のでこぼこ
    case 'pasture': return island + fbm(x, z, 0.011, seed, 2) * 1.8; // 草地のゆるい起伏
    case 'field': return island + fbm(x, z, 0.009, seed, 2) * 0.8; // 畑はなだらか
    case 'hills': { // 採掘場の段々(掘削跡): なだらかな起伏に、1段4mの階段を重ねる
      const slope = fbm(x, z, 0.013, seed, 3) * 3.6;
      const terrace = Math.floor(slope / 1.3) * 1.3;
      return island + terrace * 0.6 + slope * 0.4;
    }
    case 'mountains': return island + ridged(x, z, seed, 0.016, 4) * 34 + 22; // 山だけ急(尾根・崖)
    case 'desert': {
      const a = 0.4, rx = x * Math.cos(a) - z * Math.sin(a);
      return island + Math.sin(rx * 0.02 + seed) * 1.6 + fbm(x, z, 0.035, seed + 7, 2) * 0.7; // 風紋
    }
    default: return island + fbm(x, z, 0.015, seed, 2) * 1.6; // gold/castle/pitch/lake/fogなど拡張の特殊地形
  }
}
function terrainIdOf(terrain) { const i = TERRAIN_NAMES.indexOf(terrain); return i >= 0 ? i : 1; } // 不明な地形はpasture代用

function closestOnSeg(px, pz, seg) {
  const dx = seg.x2 - seg.x1, dz = seg.z2 - seg.z1;
  const len2 = dx * dx + dz * dz || 1;
  let t = ((px - seg.x1) * dx + (pz - seg.z1) * dz) / len2;
  t = clampUnit(t);
  return { x: seg.x1 + dx * t, z: seg.z1 + dz * t };
}
// 最寄りの海岸線分までの「海側への」符号つき距離(+:海側 / -:陸側)とその海岸のスタイル
function shoreSigned(field, x, z) {
  let best = Infinity, bestSeg = null, bestPt = null;
  for (const seg of field.shoreSegs) {
    const pt = closestOnSeg(x, z, seg);
    const d = Math.hypot(x - pt.x, z - pt.z);
    if (d < best) { best = d; bestSeg = seg; bestPt = pt; }
  }
  if (!bestSeg) return { seaward: -9999, style: 'beach' };
  const seaward = (x - bestPt.x) * bestSeg.nx + (z - bestPt.z) * bestSeg.nz;
  return { seaward, style: bestSeg.style };
}

// ================================================================
// 地形フィールド: hex配置から、任意の(x,z)の高さ・地形・材質ブレンド係数を求める準備をする。
// 「陸どうしの境目」と「本物の海岸線」を別の仕組みで扱うのが肝:
//   - 陸どうしの境目は、最寄り2マスの起伏をHEX_BLEND(数m)だけ混ぜるだけ。高さの基準(LAND_BASE)は
//     常に同じなので、内陸はどこまでも地続き(浮き島にならない)。
//   - 海岸線は、本当に海に面した辺(盤の外周、または水マスに接する辺)だけを集めた線分群までの
//     符号つき距離で決める。マスごとの円形の渚ではなく、島の輪郭そのものに沿う。
// ================================================================
function buildTerrainField(g) {
  const hexes = g.hexes;
  const centers = hexes.map((h) => { const [cx, cz] = hexCenterOf(g, h); return { cx, cz }; });
  const isWater = hexes.map((h) => WATER_LIKE.has(h.terrain));
  const seed = hexes.map((h) => h.id * 2654435761 % 100000);
  const coastStyleOf = hexes.map((h) => (hexRng(h.id * 131 + 7)(0, 1) < 0.72 ? 'beach' : 'cliff'));
  const shoreSegs = [];
  hexes.forEach((h, i) => {
    if (isWater[i]) return;
    (h.edgeIds || []).forEach((eId) => {
      const e = g.edges[eId];
      const isShore = e.hexIds.length < 2 || e.hexIds.some((hid) => WATER_LIKE.has(g.hexes[hid].terrain));
      if (!isShore) return;
      const v1 = g.vertices[e.v1], v2 = g.vertices[e.v2];
      const x1 = v1.x * SCALE, z1 = v1.y * SCALE, x2 = v2.x * SCALE, z2 = v2.y * SCALE;
      const mx = (x1 + x2) / 2, mz = (z1 + z2) / 2;
      let nx = mx - centers[i].cx, nz = mz - centers[i].cz;
      const len = Math.hypot(nx, nz) || 1;
      shoreSegs.push({ x1, z1, x2, z2, nx: nx / len, nz: nz / len, style: coastStyleOf[i] });
    });
  });
  return { hexes, centers, isWater, seed, shoreSegs };
}

// 任意の(x,z)の高さ・材質ブレンド係数を返す。
function sampleTerrain(field, x, z) {
  const { hexes, centers } = field;
  // 最寄りと2番目に近いマス(陸どうしの境目の材質・起伏ブレンドに使う)
  let i1 = -1, d1 = Infinity, i2 = -1, d2 = Infinity;
  for (let i = 0; i < hexes.length; i++) {
    const c = centers[i];
    const dd = Math.hypot(x - c.cx, z - c.cz);
    if (dd < d1) { d2 = d1; i2 = i1; d1 = dd; i1 = i; } else if (dd < d2) { d2 = dd; i2 = i; }
  }
  if (i2 < 0) i2 = i1;
  const hex1 = hexes[i1], hex2 = hexes[i2];
  const bump1 = field.isWater[i1] ? 0 : terrainBump(hex1.terrain, x, z, field.seed[i1]);
  const bump2 = field.isWater[i2] ? 0 : terrainBump(hex2.terrain, x, z, field.seed[i2]);
  const mixT = smoothstep(-HEX_BLEND, HEX_BLEND, d2 - d1); // 1: hex1が優勢
  const bump = lerp(bump2, bump1, mixT);
  const landH = LAND_BASE + bump;

  const shore = shoreSigned(field, x, z);
  const inward = -shore.seaward + coastNoise(x, z) * COAST_JITTER; // +:陸側 -:海側
  const coastTarget = shore.style === 'cliff' ? -8 : SHELF;

  let height, isWaterPt;
  if (inward >= COAST_BAND) {
    height = landH; isWaterPt = false;
  } else if (inward >= 0) {
    height = lerp(coastTarget, landH, smoothstep(0, COAST_BAND, inward));
    isWaterPt = false;
  } else {
    height = lerp(coastTarget, SEABED, smoothstep(0, DEEP_BAND, -inward)) + fbm(x, z, 0.02, 500, 2) * 2.2;
    isWaterPt = true;
  }
  return {
    height, isWater: isWaterPt,
    terrainIdA: terrainIdOf(hex1.terrain), terrainIdB: terrainIdOf(hex2.terrain), mixT,
    coastStyle: shore.style, coastT: clampUnit(1 - inward / COAST_BAND), // 0:内陸 1:渚(砂/岩のブレンドの強さ)
  };
}

// マス中心の高さ(小物を置く基準の高さ)。地形メッシュを作るたびに作り直す
function computeHexHeights(g, field) {
  const map = new Map();
  g.hexes.forEach((hex) => {
    const [cx, cz] = hexCenterOf(g, hex);
    if (WATER_LIKE.has(hex.terrain)) { map.set(hex.id, SEA_LEVEL); return; }
    map.set(hex.id, sampleTerrain(field, cx, cz).height);
  });
  return map;
}

// ================================================================
// 地形テクスチャの読み込み(CC0のPBR一式。色・法線・ARM=AO/粗さ/金属度をまとめた1枚)
// ================================================================
const texLoader = new THREE.TextureLoader();
const terrainTexCache = new Map();
function loadTerrainTex(path, isColor) {
  const tex = texLoader.load(path);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  if (isColor) tex.colorSpace = THREE.SRGBColorSpace;
  if (renderer) tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}
function terrainTextures(name) {
  if (terrainTexCache.has(name)) return terrainTexCache.get(name);
  const out = {
    map: loadTerrainTex(`./textures/${name}_diff.jpg`, true),
    normalMap: loadTerrainTex(`./textures/${name}_nor.jpg`, false),
    arm: loadTerrainTex(`./textures/${name}_arm.jpg`, false), // R=AO, G=粗さ, B=金属度(Poly Havenの標準パック)
  };
  terrainTexCache.set(name, out);
  return out;
}
// ================================================================
// 陸地材質(1枚のシェーダで全地形をまかなう): 頂点ごとに持つ terrainA/terrainB/mixT(隣り合う2マスの
// 地形とその混ざり具合)・slope(頂点法線の傾き。0=平ら〜1=垂直)・coastW(渚の砂への寄せ具合)を
// フラグメントシェーダへ渡し、6種の地形テクスチャから選んで混ぜる。
// スケール違いの2層(そのまま/少し拡大+オフセット)をUV由来のハッシュノイズで混ぜ、繰り返しを消す。
// 斜面の岩肌への切り替え(slope)は、ここでだけ smoothstep(SLOPE_LO, SLOPE_HI, ...) にして
// 三角形単位のカクつきが出ないようにする(ブリーフの要求そのもの)。
// ponytail: 法線マップ・ARM(AO/粗さ)は地形ごとのブレンドまではせず、共有の1枚(pasture)を使い回す。
// 質感の違いがもっと欲しくなったら、ここに同じ6分岐のブレンドを足す(diffuseと同じやり方でできる)。
// ================================================================
function buildLandMaterial() {
  const sets = TERRAIN_NAMES.map((n) => terrainTextures(n));
  sets.forEach((tx) => { tx.map.repeat.set(1, 1); });
  const sharedNormal = sets[1].normalMap; // pastureの法線を共有(リピートは細かめ)
  sharedNormal.repeat.set(5, 5);
  const mat = new THREE.MeshStandardMaterial({ normalMap: sharedNormal, roughness: 0.95, metalness: 0.02 });
  // マスの境目(地形id・ブレンド具合)は、頂点グリッドの粗さに縛られないよう頂点属性でなく
  // フラグメントシェーダ側でマス中心までの距離から毎ピクセル求める(①の残課題: 境目のギザギザ対策)。
  // マス中心の座標・地形idはupdateLandHexUniforms()が盤の形が変わるたびに書き込む。
  landUniforms = {
    uHexXZ: { value: Array.from({ length: MAX_LAND_HEXES }, () => new THREE.Vector2(1e6, 1e6)) },
    uHexTid: { value: new Array(MAX_LAND_HEXES).fill(1) },
    uHexN: { value: 0 },
    uTime: { value: 0 },
  };
  mat.onBeforeCompile = (shader) => {
    TERRAIN_NAMES.forEach((_, i) => { shader.uniforms['uTex' + i] = { value: sets[i].map }; });
    Object.assign(shader.uniforms, landUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float slope; attribute float coastW;
        varying float vSlope; varying float vCoastW;
        varying vec2 vTerrainUv; varying vec2 vWorldXZ;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vSlope = slope; vCoastW = coastW; vTerrainUv = uv;
        vWorldXZ = (modelMatrix * vec4(transformed, 1.0)).xz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vSlope; varying float vCoastW;
        varying vec2 vTerrainUv; varying vec2 vWorldXZ;
        uniform vec2 uHexXZ[${MAX_LAND_HEXES}]; uniform float uHexTid[${MAX_LAND_HEXES}]; uniform int uHexN; uniform float uTime;
        ${TERRAIN_NAMES.map((_, i) => `uniform sampler2D uTex${i};`).join('\n        ')}
        ${CLOUD_GLSL}
        float detailHash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
        // 地形ごとの狙った色味へ寄せる(元のCC0テクスチャの素の色だけでは地形が読み分けにくいため)。
        // テクスチャの濃淡(ディテール)は保ちつつ、色相だけtintへ引っ張る軽いmix。
        vec3 terrainTint(int id) {
          if (id == 0) return vec3(0.145, 0.235, 0.130); // forest: 濃い緑
          if (id == 1) return vec3(0.420, 0.560, 0.260); // pasture: 牧草の緑
          if (id == 2) return vec3(0.760, 0.610, 0.220); // field: 麦の金色
          if (id == 3) return vec3(0.620, 0.330, 0.190); // hills: 赤茶の粘土
          if (id == ${ROCK_ID}) return vec3(0.520, 0.510, 0.520); // mountains: 灰色の岩
          return vec3(0.820, 0.735, 0.520); // desert: 明るい砂
        }
        vec4 sampleTerrainTex(int id, vec2 uv, vec2 worldXZ) {
          vec2 uvB = uv * 2.63 + vec2(17.0, 31.0);
          float n = detailHash(floor(uv * 6.0));
          float w = smoothstep(0.35, 0.65, n);
          vec4 tex = texture2D(uTex1, uv);
          ${TERRAIN_NAMES.map((_, i) => `if (id == ${i}) tex = mix(texture2D(uTex${i}, uv), texture2D(uTex${i}, uvB), w);`).join('\n          ')}
          float luma = dot(tex.rgb, vec3(0.299, 0.587, 0.114));
          vec3 toned = mix(vec3(luma), tex.rgb, 0.35) * terrainTint(id) * 1.9;
          if (id == 2) { // 麦畑: 畝の筋+短冊(畑)ごとの色違い+風でそよぐ明滅
            float furrow = smoothstep(0.0, 1.0, abs(fract(worldXZ.x * 0.085 + worldXZ.y * 0.02) - 0.5) * 2.0);
            toned *= mix(0.85, 1.07, furrow);
            float patchN = detailHash(floor(worldXZ * 0.012));
            toned *= mix(0.92, 1.08, patchN);
            toned *= 1.0 + sin(uTime * 1.3 + worldXZ.x * 0.05 + worldXZ.y * 0.05) * 0.035;
          }
          if (id == ${SAND_ID}) { // 砂漠: 風紋(砂丘の筋)
            float ridge = sin(worldXZ.x * 0.07 + sin(worldXZ.y * 0.02) * 2.2) * 0.5 + 0.5;
            toned *= mix(0.88, 1.07, ridge);
          }
          return vec4(toned, tex.a);
        }
        // 最寄り2マスの地形idとブレンド具合を、マス中心までの距離からその場(毎ピクセル)で求める。
        // 頂点グリッドの解像度に縛られないので、境目が階段状にならない。
        void nearestTwoHex(vec2 p, out float id1, out float id2, out float mixT) {
          float d1 = 1e9, d2 = 1e9; float i1 = 1.0, i2 = 1.0;
          for (int i = 0; i < ${MAX_LAND_HEXES}; i++) {
            if (i >= uHexN) break;
            float dd = distance(p, uHexXZ[i]);
            if (dd < d1) { d2 = d1; i2 = i1; d1 = dd; i1 = uHexTid[i]; }
            else if (dd < d2) { d2 = dd; i2 = uHexTid[i]; }
          }
          id1 = i1; id2 = i2;
          mixT = smoothstep(-${HEX_BLEND.toFixed(1)}, ${HEX_BLEND.toFixed(1)}, d2 - d1);
        }`)
      .replace('#include <map_fragment>', `
        {
          vec2 uv = vTerrainUv;
          float hId1, hId2, hMixT;
          nearestTwoHex(vWorldXZ, hId1, hId2, hMixT);
          vec4 base = mix(sampleTerrainTex(int(hId2 + 0.5), uv, vWorldXZ), sampleTerrainTex(int(hId1 + 0.5), uv, vWorldXZ), hMixT);
          base = mix(base, sampleTerrainTex(${SAND_ID}, uv, vWorldXZ), vCoastW);
          float slopeW = smoothstep(${SLOPE_LO.toFixed(2)}, ${SLOPE_HI.toFixed(2)}, vSlope);
          base = mix(base, sampleTerrainTex(${ROCK_ID}, uv, vWorldXZ), slopeW);
          #ifdef DECODE_VIDEO_TEXTURE
            base = sRGBTransferEOTF(base);
          #endif
          base.rgb *= cloudShadow(vWorldXZ, uTime);
          diffuseColor *= base;
        }`);
  };
  return mat;
}
// 海底(水マスの地形。ほとんど海に隠れるが、渚の近くは海越しにうっすら見える)
function getSeabedMaterial() {
  if (TERRAIN_MAT.seabed) return TERRAIN_MAT.seabed;
  const tx = terrainTextures('desert'); // 砂の法線だけ借りる(色は塗りつぶしで海底らしい暗さにする)
  const mat = new THREE.MeshStandardMaterial({ color: 0x1f4650, normalMap: tx.normalMap, roughness: 0.95 });
  mat.normalMap.repeat.set(3, 3);
  TERRAIN_MAT.seabed = mat;
  return mat;
}
let landMaterial = null;
function getLandMaterial() { if (!landMaterial) landMaterial = buildLandMaterial(); return landMaterial; }

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
// 地形メッシュ本体: 盤を覆う矩形の細かいグリッド(1枚の連続した面)を作り、各頂点の高さと
// 材質ブレンド係数(terrainA/terrainB/mixT/coastW)を決める。陸と海底だけ描画グループを分け(境は
// 本物の海岸線)、陸はすべて1つのシェーダ(buildLandMaterial)で描く。斜面の岩肌への切り替えは
// 三角形単位ではなく、法線から求めたslopeをフラグメントシェーダでsmoothstepするので滑らか。
// ================================================================
function buildTerrainMesh(g, field) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  field.centers.forEach(({ cx, cz }) => {
    minX = Math.min(minX, cx - HEX_R * 1.15); maxX = Math.max(maxX, cx + HEX_R * 1.15);
    minZ = Math.min(minZ, cz - HEX_R * 1.15); maxZ = Math.max(maxZ, cz + HEX_R * 1.15);
  });
  let cell = Q.cell;
  let nx = Math.min(Q.maxGrid, Math.ceil((maxX - minX) / cell)) + 1;
  let nz = Math.min(Q.maxGrid, Math.ceil((maxZ - minZ) / cell)) + 1;
  cell = Math.max((maxX - minX) / (nx - 1), (maxZ - minZ) / (nz - 1)); // 矩形がmaxGridを超えるときは格子を粗くする

  const count = nx * nz;
  const pos = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const coastW = new Float32Array(count);
  const slope = new Float32Array(count); // computeVertexNormals後に埋める
  const isWaterAt = new Uint8Array(count);
  const UV_SCALE = 1 / 26; // ③の見え直し: 1/14だと繰り返しが細かすぎてじゅうたん状に見えたので、粗く(タイル1枚が大きく)した

  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = minX + i * cell, z = minZ + j * cell;
      const s = sampleTerrain(field, x, z);
      const k = j * nx + i;
      pos[k * 3] = x; pos[k * 3 + 1] = s.height; pos[k * 3 + 2] = z;
      uv[k * 2] = x * UV_SCALE; uv[k * 2 + 1] = z * UV_SCALE;
      // 地形id・ブレンド(terrainA/B/mixT)はここでは持たず、land材質のフラグメントシェーダが
      // 毎ピクセル、マス中心までの距離から直接求める(頂点グリッドの粗さで境目が階段状になるのを防ぐ)。
      coastW[k] = (!s.isWater && s.coastStyle === 'beach') ? s.coastT : 0;
      isWaterAt[k] = s.isWater ? 1 : 0;
    }
  }
  const index = [];
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('coastW', new THREE.BufferAttribute(coastW, 1));
  geo.setAttribute('slope', new THREE.BufferAttribute(slope, 1));

  // 陸(1グループ=自前シェーダ)と海底(渚の近くでうっすら見えるだけの簡素な材質)の2グループに分ける。
  // 境目は頂点ごとのisWater(本物の海岸線で決まる)で、陸マスどうしの境目はどこにも生まれない。
  const landIdx = [], seaIdx = [];
  for (let t = 0; t < index.length; t += 3) {
    const ia = index[t];
    (isWaterAt[ia] ? seaIdx : landIdx).push(index[t], index[t + 1], index[t + 2]);
  }
  const newIndex = [...landIdx, ...seaIdx];
  geo.addGroup(0, landIdx.length, 0);
  geo.addGroup(landIdx.length, seaIdx.length, 1);
  geo.setIndex(newIndex);
  geo.computeVertexNormals();

  // 法線のy成分(上向き具合)から斜面の急さを求め、頂点属性に書き戻す(フラグメントシェーダでsmoothstep)
  const normalAttr = geo.attributes.normal;
  for (let k = 0; k < count; k++) slope[k] = clampUnit(1 - normalAttr.getY(k));
  geo.attributes.slope.needsUpdate = true;

  const mesh = new THREE.Mesh(geo, [getLandMaterial(), getSeabedMaterial()]);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  return mesh;
}

// ================================================================
// 海: 地形メッシュの外側まで広がる1枚の板。深さ(渚との距離)で浅瀬エメラルド→沖の濃紺に変え、
// 岸の近くに白い泡、ごく浅いところは地形メッシュ(海底)がうっすら透ける。
// three.jsのWater.js(ミラー反射)は毎フレームの2回描画が重く、深さの色分けにも向かないため、
// 自前のShaderMaterialにする(ブリーフにある代替案のとおり)。
// ================================================================
// 地形メッシュの高さをDataTexture(1チャンネル)に焼く。海のシェーダはこれを読んで「本当の渚からの深さ」で
// 色を変える(原点からの距離の代用はやめた)。範囲外(テクスチャの外)はClampToEdgeで端の値(=深い海)を使う。
const HBAKE_RES = 192;
const HBAKE_MIN = -34, HBAKE_MAX = 40; // この範囲に高さを正規化してR8に詰める(陸の奥は飽和してよい)
function buildHeightTexture(field) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  field.centers.forEach(({ cx, cz }) => {
    minX = Math.min(minX, cx); maxX = Math.max(maxX, cx); minZ = Math.min(minZ, cz); maxZ = Math.max(maxZ, cz);
  });
  const pad = HEX_R + DEEP_BAND * 1.3;
  minX -= pad; maxX += pad; minZ -= pad; maxZ += pad;
  const data = new Uint8Array(HBAKE_RES * HBAKE_RES);
  for (let j = 0; j < HBAKE_RES; j++) {
    for (let i = 0; i < HBAKE_RES; i++) {
      const x = minX + (i + 0.5) / HBAKE_RES * (maxX - minX);
      const z = minZ + (j + 0.5) / HBAKE_RES * (maxZ - minZ);
      const h = sampleTerrain(field, x, z).height;
      const t = clampUnit((h - HBAKE_MIN) / (HBAKE_MAX - HBAKE_MIN));
      data[j * HBAKE_RES + i] = Math.round(t * 255);
    }
  }
  const tex = new THREE.DataTexture(data, HBAKE_RES, HBAKE_RES, THREE.RedFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return { tex, origin: new THREE.Vector2(minX, minZ), size: new THREE.Vector2(maxX - minX, maxZ - minZ) };
}

function buildOcean(g, field) {
  let maxR = 0;
  field.centers.forEach(({ cx, cz }) => { maxR = Math.max(maxR, Math.hypot(cx, cz) + HEX_R); });
  const size = maxR * 8; // 地平線まで続くように、盤よりずっと大きい板にする
  const seg = 180;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);

  const heightBake = buildHeightTexture(field);
  const uniforms = {
    uTime: { value: 0 },
    uShallow: { value: new THREE.Color(0x2fb896) }, // 浅瀬エメラルド
    uDeep: { value: new THREE.Color(0x0a2f52) }, // 沖の濃紺
    uFoam: { value: new THREE.Color(0xf3fbff) },
    uHeightTex: { value: heightBake.tex },
    uHOrigin: { value: heightBake.origin },
    uHSize: { value: heightBake.size },
  };
  oceanUniforms = uniforms;
  const mat = new THREE.MeshStandardMaterial({ color: 0x1a4a66, roughness: 0.25, metalness: 0.05, dithering: true });
  mat.userData.heightTex = heightBake.tex; // rebuild時に破棄するため覚えておく
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying vec3 vWorldPosOcean;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float wA = sin((position.x + position.z) * 0.012 + uTime * 0.7) * 1.6;
        float wB = sin((position.x * 0.9 - position.z * 1.3) * 0.02 - uTime * 1.1) * 0.9;
        transformed.y += wA + wB;
        vWorldPosOcean = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uShallow; uniform vec3 uDeep; uniform vec3 uFoam; uniform float uTime;
        uniform sampler2D uHeightTex; uniform vec2 uHOrigin; uniform vec2 uHSize;
        varying vec3 vWorldPosOcean;
        ${CLOUD_GLSL}`)
      .replace('#include <map_fragment>', `
        {
          vec2 huv = (vWorldPosOcean.xz - uHOrigin) / uHSize;
          float raw = texture2D(uHeightTex, clamp(huv, 0.0, 1.0)).r;
          float h = mix(${HBAKE_MIN.toFixed(1)}, ${HBAKE_MAX.toFixed(1)}, raw);
          float depth = max(0.0, -h); // 海面(0)より下の深さ
          float depthT = smoothstep(0.0, 24.0, depth);
          vec3 base = mix(uShallow, uDeep, depthT);
          // 渚のすぐそば(depthがほぼ0)に白い泡の線。硬いノイズは使わず、なめらかに揺らす
          float foam = 1.0 - smoothstep(0.0, 2.2, depth);
          float shimmer = 0.75 + 0.25 * sin(vWorldPosOcean.x * 0.05 + vWorldPosOcean.z * 0.07 + uTime * 1.2);
          base = mix(base, uFoam, foam * shimmer);
          base *= cloudShadow(vWorldPosOcean.xz, uTime);
          diffuseColor.rgb *= base;
        }`);
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = false; // 平らな板に浅い角度の太陽光があたるとシャドウマップのちらつき(アクネ)が出るため。影の質は②で詰める
  mesh.position.y = SEA_LEVEL;
  return mesh;
}

function disposeDeep(obj) {
  if (!obj) return;
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
  });
}
function boardSig(g) { return g.hexes.length + ':' + g.hexes.map((h) => h.terrain[0] + h.q + ',' + h.r).join('|'); }

function rebuildTerrainAndOcean(g) {
  if (terrainGroup) { scene.remove(terrainGroup); disposeDeep(terrainGroup); }
  if (oceanMesh) {
    scene.remove(oceanMesh); disposeDeep(oceanMesh);
    if (oceanMesh.material.userData.heightTex) oceanMesh.material.userData.heightTex.dispose();
    oceanMesh.material.dispose();
  }
  const field = buildTerrainField(g);
  terrainField = field; // 小物・境目の高さ合わせ(sampleTerrain)に使い回す
  hexHeight = computeHexHeights(g, field);
  terrainGroup = buildTerrainMesh(g, field); // getLandMaterial()を呼ぶのでlandUniformsはここまでに必ずできている
  scene.add(terrainGroup);
  updateLandHexUniforms(field);
  oceanMesh = buildOcean(g, field);
  scene.add(oceanMesh);
}

// マス中心の座標+地形id(land材質のnearestTwoHex()用)を書き込む。拡張で枚数が変わっても
// シェーダの再コンパイルは要らない(配列サイズはMAX_LAND_HEXES固定、余りはuHexNで無視される)。
function updateLandHexUniforms(field) {
  if (!landUniforms) return;
  const n = Math.min(field.hexes.length, MAX_LAND_HEXES);
  for (let i = 0; i < n; i++) {
    landUniforms.uHexXZ.value[i].set(field.centers[i].cx, field.centers[i].cz);
    landUniforms.uHexTid.value[i] = terrainIdOf(field.hexes[i].terrain);
  }
  landUniforms.uHexN.value = n;
}

// hexの基準の高さ(ships/portsはいつも海面、陸は地形メッシュのマス中心の高さ)
function baseYOfHex(hex) {
  if (!hex) return LAND_BASE;
  if (WATER_LIKE.has(hex.terrain)) return SEA_LEVEL;
  return hexHeight.get(hex.id) ?? LAND_BASE;
}
function firstHexAt(g, ids) { return ids.map((id) => g.hexes[id]).find(Boolean); }
// 小物を置く実際の地面の高さ(地形メッシュと同じうねりに乗せる)。terrainFieldがまだなければマス中心の高さで代える。
function groundY(x, z, fallback) { return terrainField ? sampleTerrain(terrainField, x, z).height : fallback; }

// ================================================================
// 本体: 盤を1枚まるごと作り直す(地形と海は形が変わったときだけ)
// ================================================================
export function renderBoard3D(game, uiState, overlay) {
  if (!scene) return;
  const g = game.board;
  const sig = boardSig(g);
  if (sig !== boardSignature) { boardSignature = sig; rebuildTerrainAndOcean(g); }

  disposeGroup(sceneGroup);
  hitTargets = []; pulseMeshes = [];

  frameCamera(g);

  const conTrunkItems = [], conCanopyItems = [], broadTrunkItems = [], broadCanopyItems = [],
    sheepBodyItems = [], sheepHeadItems = [], fencePostItems = [], pastureRockItems = [],
    wheatItems = [], brickItems = [],
    peakItems = [], snowItems = [], screeItems = [],
    duneItems = [], dryGrassItems = [], desertRockItems = [], nuggetItems = [];
  // マス中心(数字チップ)・頂点(置ける場所)の周りは空ける(どの地形の散布もこの半径より内側には置かない)
  const CLEAR_R = 18;

  g.hexes.forEach((hex) => {
    const [cx, cz] = hexCenterOf(g, hex);
    const height = baseYOfHex(hex);
    const R = SCALE * 0.6;
    // 同じマスは再描画のたびに木・岩の並びが変わらないよう、hex.idを種にした専用の乱数を使う
    const rr = hexRng(hex.id * 7919 + 13);
    const terrain = hex.fog ? 'fog' : hex.terrain;
    if (terrain === 'forest') {
      // 針葉樹(密生)と広葉樹が混ざった森。地形スケール(1マス数百m)に合わせ、小さい木をたくさん置く。
      const n = Math.round(rr(26, 34) * DENSITY);
      for (let i = 0; i < n; i++) {
        const a = rr(0, Math.PI * 2), r = rr(CLEAR_R, R * 0.94);
        const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
        const y = groundY(x, z, height), s = rr(0.75, 1.3);
        const seed = hex.id * 9973 + i;
        if (rr(0, 1) < 0.62) {
          conTrunkItems.push({ x, y: y + 1.7 * s, z, s, ry: rr(0, Math.PI * 2), seed });
          conCanopyItems.push({ x, y: y + 5.9 * s, z, s, ry: rr(0, Math.PI * 2), seed: seed + 1 });
        } else {
          broadTrunkItems.push({ x, y: y + 1.1 * s, z, s, ry: rr(0, Math.PI * 2), seed });
          broadCanopyItems.push({ x, y: y + 3.8 * s, z, s, ry: rr(0, Math.PI * 2), seed: seed + 1 });
        }
      }
    } else if (terrain === 'pasture') {
      // 起伏のある草地+羊の群れ(かたまりで数頭ずつ)+木の柵+ところどころ石
      const clusters = Math.round(rr(2, 3) * Math.max(1, DENSITY * 0.6));
      for (let c = 0; c < clusters; c++) {
        const ca = rr(0, Math.PI * 2), cr = rr(CLEAR_R, R * 0.6);
        const ccx = cx + Math.cos(ca) * cr, ccz = cz + Math.sin(ca) * cr;
        const flock = Math.round(rr(5, 9) * DENSITY);
        for (let i = 0; i < flock; i++) {
          const x = ccx + rr(-9, 9), z = ccz + rr(-9, 9);
          if (Math.hypot(x - cx, z - cz) < CLEAR_R) continue;
          const y = groundY(x, z, height), s = rr(0.8, 1.05), ry = rr(0, Math.PI * 2);
          const seed = hex.id * 6151 + c * 100 + i;
          sheepBodyItems.push({ x, y: y + 0.55 * s, z, s, ry, seed });
          sheepHeadItems.push({ x: x + Math.cos(ry) * 0.6 * s, y: y + 0.55 * s, z: z + Math.sin(ry) * 0.6 * s, s, ry, seed: seed + 1 });
        }
      }
      addFence(cx, cz, height, R, hex.id);
      const rocks = Math.round(rr(1, 3) * DENSITY);
      for (let i = 0; i < rocks; i++) {
        const a = rr(0, Math.PI * 2), r = rr(CLEAR_R, R * 0.85);
        const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
        pastureRockItems.push({ x, y: groundY(x, z, height), z, s: rr(0.8, 1.4), ry: rr(0, 6), seed: hex.id * 311 + i });
      }
    } else if (terrain === 'field') {
      // 短冊形の畑を数枚(畝・色違い・そよぎは地面シェーダ側で)。麦の束は畑の筋に沿って並べる。
      const strips = 3;
      let i = 0;
      for (let s2 = 0; s2 < strips; s2++) {
        const ang = (s2 / strips) * Math.PI + rr(-0.15, 0.15);
        const nx = Math.cos(ang), nz = Math.sin(ang);
        const rows = Math.round(rr(5, 7) * DENSITY);
        for (let row = 0; row < rows; row++) {
          const t = (row / (rows - 1) - 0.5) * R * 1.3;
          for (const off of [-10, 0, 10]) {
            const x = cx + nx * t + -nz * off + rr(-2, 2), z = cz + nz * t + nx * off + rr(-2, 2);
            if (Math.hypot(x - cx, z - cz) > R * 0.92 || Math.hypot(x - cx, z - cz) < CLEAR_R) continue;
            wheatItems.push({ x, y: groundY(x, z, height) + 1.2, z, ry: ang + rr(-0.1, 0.1), s: rr(0.8, 1.1), seed: hex.id * 97 + i++ });
          }
        }
      }
    } else if (terrain === 'hills') {
      // 赤茶の粘土の採掘場: 段々の掘削跡(地形の高さ側で表現)+レンガの山+窯と煙
      const piles = Math.round(rr(2, 3) * Math.max(1, DENSITY * 0.7));
      for (let p = 0; p < piles; p++) {
        const a = rr(0, Math.PI * 2), r = rr(CLEAR_R, R * 0.65);
        const pcx = cx + Math.cos(a) * r, pcz = cz + Math.sin(a) * r, py = groundY(pcx, pcz, height);
        const rows = 3;
        for (let row = 0; row < rows; row++) {
          const perRow = 4 - row;
          for (let k = 0; k < perRow; k++) {
            const bx = pcx + (k - (perRow - 1) / 2) * 1.3, bz = pcz + rr(-0.3, 0.3);
            brickItems.push({ x: bx, y: py + 0.3 + row * 0.62, z: bz, ry: rr(-0.1, 0.1), seed: hex.id * 71 + p * 10 + row * 4 + k });
          }
        }
      }
      addKiln(cx + rr(-R * 0.3, R * 0.3), cz + rr(-R * 0.3, R * 0.3), height, rr);
      const rocks = Math.round(rr(2, 4) * DENSITY);
      for (let i = 0; i < rocks; i++) {
        const a = rr(0, Math.PI * 2), r = rr(CLEAR_R, R * 0.9);
        const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
        screeItems.push({ x, y: groundY(x, z, height), z, s: rr(0.7, 1.3), ry: rr(0, 6), seed: hex.id * 211 + i });
      }
    } else if (terrain === 'mountains') {
      // 高い岩山(尾根・崖は地形の高さ側)+頂上の雪+中腹の鉱山入口とトロッコ線路+がれ場
      [[-0.35, -0.1], [0.3, -0.2], [0, 0.3]].forEach(([dx, dz], i) => {
        const x = cx + dx * SCALE, z = cz + dz * SCALE, y = groundY(x, z, height), s = rr(0.9, 1.3);
        peakItems.push({ x, y: y + 10 * s, z, s, ry: rr(0, Math.PI * 2), seed: hex.id * 97 + i });
        if (rr(0, 1) < 0.7) snowItems.push({ x, y: y + 19 * s, z, s });
        const scree = Math.round(rr(8, 14) * DENSITY);
        for (let k = 0; k < scree; k++) {
          const a = rr(0, Math.PI * 2), r = rr(5, 13) * s;
          const rx = x + Math.cos(a) * r, rz = z + Math.sin(a) * r;
          screeItems.push({ x: rx, y: groundY(rx, rz, height), z: rz, s: rr(0.6, 1.2), ry: rr(0, 6), seed: hex.id * 401 + i * 20 + k });
        }
      });
      addMineAndRail(cx, cz, height, R, rr);
    } else if (terrain === 'desert') {
      // 風紋の砂丘(模様は地面シェーダ)+乾いた岩+まばらな枯れ草。サボテンは置かない。
      duneItems.push({ x: cx - 20, y: groundY(cx - 20, cz + 10, height) + 1, z: cz + 10, s: rr(0.9, 1.2) });
      duneItems.push({ x: cx + 24, y: groundY(cx + 24, cz - 14, height) + 1, z: cz - 14, s: rr(0.8, 1) });
      const rocks = Math.round(rr(1, 3) * DENSITY), tufts = Math.round(rr(3, 6) * DENSITY);
      for (let i = 0; i < rocks; i++) {
        const a = rr(0, Math.PI * 2), r = rr(CLEAR_R, R * 0.85);
        const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
        desertRockItems.push({ x, y: groundY(x, z, height), z, s: rr(0.7, 1.3), ry: rr(0, 6), seed: hex.id * 131 + i });
      }
      for (let i = 0; i < tufts; i++) {
        const a = rr(0, Math.PI * 2), r = rr(CLEAR_R, R * 0.9);
        const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
        dryGrassItems.push({ x, y: groundY(x, z, height), z, s: rr(0.6, 1.1), ry: rr(0, 6), seed: hex.id * 151 + i });
      }
    } else if (terrain === 'gold') {
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + rr(-0.2, 0.2), r = rr(R * 0.3, R * 0.65);
        nuggetItems.push({ x: cx + Math.cos(a) * r, y: height + 2.5, z: cz + Math.sin(a) * r, s: rr(0.8, 1.2), ry: rr(0, 6) });
      }
    } else if (terrain === 'castle') {
      addCastle(cx, cz, height);
    } else if (terrain === 'pitch') {
      addPitch(cx, cz, height);
    } else if (terrain === 'fog') {
      const dome = new THREE.Mesh(new THREE.SphereGeometry(R * 0.95, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2),
        new THREE.MeshStandardMaterial({ color: 0xdfe8e2, transparent: true, opacity: 0.55 }));
      dome.position.set(cx, height, cz);
      sceneGroup.add(dome);
    }
    // 数字チップ
    if (hex.number != null && !hex.fog) {
      addNumberChip(cx, cz, height, hex.number, hex.number === 6 || hex.number === 8, 1);
    }
    if (hex.number2 != null) addNumberChip(cx + 24, cz - 16, height, hex.number2, false, 0.6);
  });

  [
    instancedFrom(GEO.conTrunk, MAT.conBark, conTrunkItems, 0.015),
    instancedFrom(GEO.conCanopy, MAT.conLeaf, conCanopyItems, 0.04),
    instancedFrom(GEO.broadTrunk, MAT.broadBark, broadTrunkItems, 0.015),
    instancedFrom(GEO.broadCanopy, MAT.broadLeaf, broadCanopyItems, 0.05),
    instancedFrom(GEO.sheepBody, MAT.sheep, sheepBodyItems, 0.015),
    instancedFrom(GEO.sheepHead, MAT.sheepHead, sheepHeadItems),
    instancedFrom(GEO.fieldRock, MAT.fieldRock, pastureRockItems, 0.02),
    instancedFrom(GEO.wheat, MAT.wheat, wheatItems, 0.04),
    instancedFrom(GEO.brick, MAT.brick, brickItems, 0.03),
    instancedFrom(GEO.peak, MAT.peak, peakItems, 0.02),
    instancedFrom(GEO.snowCap, MAT.snow, snowItems),
    instancedFrom(GEO.scree, MAT.scree, screeItems, 0.03),
    instancedFrom(GEO.dune, MAT.sand, duneItems),
    instancedFrom(GEO.dryGrass, MAT.dryGrass, dryGrassItems, 0.04),
    instancedFrom(GEO.desertRock, MAT.desertRock, desertRockItems, 0.03),
    instancedFrom(GEO.nugget, MAT.gold, nuggetItems),
  ].forEach((m) => { if (m) sceneGroup.add(m); });

  // マスの境目(六角の辺)に、隣り合う地形に合った縁取りを描く
  if (terrainField) buildHexBoundaries(g, terrainField);

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
      band.position.set((v1.x + v2.x) / 2 * SCALE, SEA_LEVEL + 1, (v1.y + v2.y) / 2 * SCALE);
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
    const baseY = baseYOfHex(firstHexAt(g, edge.hexIds));
    if (edge.ship != null) {
      addShip(mx, mz, ang, game.players[edge.ship].color);
    } else if (edge.road != null) {
      const color = new THREE.Color(game.players[edge.road].color);
      const len = Math.hypot(x2 - x1, z2 - z1) * 0.82;
      // 角を落とした木の棒(断面が八角形の丸太)。GEO.roadは長さ1なので、scale.yで伸ばしてから横向きに倒す
      const road = new THREE.Mesh(GEO.road, new THREE.MeshStandardMaterial({ color, roughness: 0.85 }));
      road.scale.set(1, len, 1);
      const qLay = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
      const qTurn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ang);
      road.quaternion.multiplyQuaternions(qTurn, qLay);
      road.position.set(mx, baseY + 3.4, mz);
      road.castShadow = true;
      sceneGroup.add(road);
    }
  });

  // 頂点: 建物
  g.vertices.forEach((v) => {
    if (!v.building) return;
    const x = v.x * SCALE, z = v.y * SCALE;
    const baseY = baseYOfHex(firstHexAt(g, v.hexIds));
    const color = new THREE.Color(game.players[v.building.owner].color);
    if (v.building.type === 'city') addCity(x, baseY, z, color); else addHouse(x, baseY, z, color);
  });

  // 騎士（都市と騎士）・蛮族の騎士（交易と略奪）: 簡素な色付きの駒
  if (game.players[0] && game.players[0].knights) {
    game.players.forEach((pl) => (pl.knights || []).forEach((k) => {
      const v = g.vertices[k.vertexId];
      const baseY = baseYOfHex(firstHexAt(g, v.hexIds));
      addKnight(v.x * SCALE, baseY, v.y * SCALE, pl.color, k.active);
    }));
  }
  if (g.castleHexId != null) {
    game.players.forEach((pl) => (pl.warKnights || []).forEach((k) => {
      const e = g.edges[k.edgeId];
      const v1 = g.vertices[e.v1], v2 = g.vertices[e.v2];
      addKnight((v1.x + v2.x) / 2 * SCALE, LAND_BASE, (v1.y + v2.y) / 2 * SCALE, pl.color, true);
    }));
  }

  // 盗賊・海賊
  if (g.robberHex != null) {
    const [cx, cz] = hexCenterOf(g, g.hexes[g.robberHex]);
    addRobber(cx, baseYOfHex(g.hexes[g.robberHex]), cz, uiState && (uiState.mode === 'moveRobber' || uiState.mode === 'devKnightHex'));
  }
  if (g.pirateHex != null) {
    const [cx, cz] = hexCenterOf(g, g.hexes[g.pirateHex]);
    addPirate(cx, SEA_LEVEL, cz, uiState && (uiState.mode === 'moveRobber' || uiState.mode === 'devKnightHex'));
  }

  // ---- 置ける場所など、overlay に入っている当たり判定をそのまま光る的にする ----
  (overlay || []).forEach((o) => addOverlayTarget(g, o));

  renderer.shadowMap.needsUpdate = true;
}

function disposeGroup(group) {
  group.traverse((o) => {
    if (o.geometry && !Object.values(GEO).includes(o.geometry)) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    mats.forEach((m) => { if (!Object.values(MAT).includes(m) && !Object.values(TERRAIN_MAT).includes(m)) m.dispose(); });
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
  if (!hasDebugCam) { // ?camで固定しているときは、ここでカメラを奪い返さない(比較スクリーンショット用)
    const dist = maxR * 1.9;
    camera.position.set(0, dist * 0.78, dist * 0.68);
    controls.target.set(0, 0, 0);
    controls.minDistance = maxR * 0.5;
    controls.maxDistance = maxR * 3.2;
    controls.update();
  }
  // 奥行き(遠近の深度バッファ)の精度をGTAO/SMAAのために盤の大きさへ詰める
  camera.far = Math.max(1200, maxR * 6);
  camera.updateProjectionMatrix();
  // 太陽の向き・影カメラの範囲を盤の大きさに合わせ直す(広すぎると影がぼやける)
  updateSunForBoard(maxR);
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

// 交換レートの控えめな看板テクスチャ(木の板に焼き印ふうの文字)。港の種類ごとにキャッシュ。
const portSignCache = new Map();
function portSignTexture(type) {
  if (portSignCache.has(type)) return portSignCache.get(type);
  const c = document.createElement('canvas');
  c.width = 128; c.height = 72;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#8a6a44'; ctx.fillRect(0, 0, 128, 72);
  ctx.strokeStyle = '#4a3420'; ctx.lineWidth = 4; ctx.strokeRect(2, 2, 124, 68);
  ctx.fillStyle = '#2a1d10';
  ctx.font = 'bold 30px Georgia, serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(type === '3:1' ? '3:1' : `${type[0].toUpperCase()} 2:1`, 64, 38);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  portSignCache.set(type, tex);
  return tex;
}
// 港: 木の桟橋(渚から海へ板を渡す)+小さな船+桟橋脇の木の看板(交換レート)。
function addPort(g, eId) {
  const e = g.edges[eId];
  const v1 = g.vertices[e.v1], v2 = g.vertices[e.v2];
  const mx = (v1.x + v2.x) / 2 * SCALE, mz = (v1.y + v2.y) / 2 * SCALE;
  const [hx, hz] = hexCenterOf(g, g.hexes[e.hexIds[0]]);
  const nx = (mx - hx) / (Math.hypot(mx - hx, mz - hz) || 1), nz = (mz - hz) / (Math.hypot(mx - hx, mz - hz) || 1);
  const tx = -nz, tz = nx; // 桟橋の幅方向(辺に沿う向き)
  const px = mx + nx * (SCALE * Math.sqrt(3) / 2), pz = mz + nz * (SCALE * Math.sqrt(3) / 2);
  const type = v1.port;
  const isAny = type === '3:1';
  const color = isAny ? 0xf0e4bc : (RES_COLOR3D[type] ?? 0xcccccc);
  // 桟橋板: 渚(辺の中点)から沖の係留点まで、木の板を並べて渡す
  const planks = 6;
  const plankItems = [];
  for (let i = 0; i < planks; i++) {
    const t = (i + 0.5) / planks;
    plankItems.push({ x: mx + nx * (SCALE * Math.sqrt(3) / 2) * t, y: SEA_LEVEL + 1.2, z: mz + nz * (SCALE * Math.sqrt(3) / 2) * t,
      ry: Math.atan2(nz, nx) + Math.PI / 2, s: 1 });
  }
  const dock = instancedFrom(GEO.dockPlank, MAT.dock, plankItems);
  if (dock) sceneGroup.add(dock);
  // 係留の杭(渚側2本)
  [v1, v2].forEach((v) => {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.6, 3.6, 6), MAT.signPost);
    pole.position.set(v.x * SCALE, SEA_LEVEL + 1.4, v.y * SCALE);
    pole.castShadow = true;
    sceneGroup.add(pole);
  });
  // 小さな船(交換できる資源の色の帆)。桟橋の先、少し脇に停める
  const boatX = px + tx * 5, boatZ = pz + tz * 5;
  const hull = new THREE.Mesh(GEO.boatHull, MAT.boatHull);
  hull.rotation.y = Math.atan2(nz, nx);
  hull.position.set(boatX, SEA_LEVEL + 1.3, boatZ);
  const sail = new THREE.Mesh(GEO.boatSail, new THREE.MeshStandardMaterial({ color }));
  sail.rotation.y = Math.atan2(nz, nx);
  sail.position.set(boatX, SEA_LEVEL + 3.6, boatZ);
  hull.castShadow = true; sail.castShadow = true;
  sceneGroup.add(hull, sail);
  // 交換レートの看板(桟橋の付け根、陸側に控えめに)
  const signX = mx - nx * 6 + tx * 10, signZ = mz - nz * 6 + tz * 10;
  const post = new THREE.Mesh(GEO.signPost, MAT.signPost);
  post.position.set(signX, SEA_LEVEL + 1.7, signZ);
  const board = new THREE.Mesh(GEO.signBoard, new THREE.MeshStandardMaterial({ map: portSignTexture(type) }));
  board.rotation.y = Math.atan2(nz, nx) + Math.PI / 2;
  board.position.set(signX, SEA_LEVEL + 3.2, signZ);
  post.castShadow = true; board.castShadow = true;
  sceneGroup.add(post, board);
}

// 牧草地の木の柵: マスの縁の一部(弧)にだけ杭+横木を渡す(全周だと囲いだらけになるので控えめに)
function addFence(cx, cz, height, R, seedBase) {
  const rr = hexRng(seedBase * 433 + 1);
  const start = rr(0, Math.PI * 2), span = rr(1.6, 2.6), radius = R * 0.82;
  const posts = Math.round(span / 0.28);
  const items = [];
  const pts = [];
  for (let i = 0; i <= posts; i++) {
    const a = start + (i / posts) * span;
    const x = cx + Math.cos(a) * radius, z = cz + Math.sin(a) * radius;
    pts.push({ x, z, y: groundY(x, z, height) });
    items.push({ x, y: pts[i].y + 0.8, z, s: 1 });
  }
  const postMesh = instancedFrom(GEO.fencePost, MAT.fence, items);
  if (postMesh) sceneGroup.add(postMesh);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    [0.55, 1.0].forEach((h) => {
      const rail = new THREE.Mesh(GEO.fenceRail, MAT.fence);
      rail.scale.set(len, 1, 1);
      rail.position.set((a.x + b.x) / 2, (a.y + b.y) / 2 + h, (a.z + b.z) / 2);
      rail.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x);
      sceneGroup.add(rail);
    });
  }
}
// 丘の採掘場: 窯(素焼きの筒+屋根)+ゆっくり立ちのぼる煙(静止した煙の塊。揺れはつけない簡略表現)
function addKiln(cx, cz, height, rr) {
  const y = groundY(cx, cz, height);
  const body = new THREE.Mesh(GEO.kilnBody, MAT.kiln);
  body.position.set(cx, y + 1.8, cz);
  const roof = new THREE.Mesh(GEO.kilnRoof, MAT.kiln);
  roof.position.set(cx, y + 4.5, cz);
  body.castShadow = true; roof.castShadow = true;
  sceneGroup.add(body, roof);
  for (let i = 0; i < 3; i++) {
    const puff = new THREE.Mesh(GEO.smoke, MAT.smoke.clone());
    const s = 1.4 + i * 1.1;
    puff.material.opacity = 0.32 - i * 0.08;
    puff.scale.setScalar(s);
    puff.position.set(cx + rr(-1, 1) * i, y + 6 + i * 2.6, cz + rr(-1, 1) * i);
    sceneGroup.add(puff);
  }
}
// 山の中腹: 鉱山の入口(木枠+暗い穴)とそこから延びるトロッコの線路(2本のレール+枕木)
function addMineAndRail(cx, cz, height, R, rr) {
  const a = rr(0, Math.PI * 2);
  const ex = cx + Math.cos(a) * R * 0.55, ez = cz + Math.sin(a) * R * 0.55;
  const ey = groundY(ex, ez, height);
  const facing = a + Math.PI; // 斜面の外側を向く
  const frame = new THREE.Mesh(GEO.mineFrame, MAT.mineFrame);
  frame.position.set(ex, ey + 2, ez);
  frame.rotation.y = facing;
  const hole = new THREE.Mesh(GEO.mineHole, MAT.mineHole);
  hole.position.set(ex + Math.cos(facing) * 0.75, ey + 1.8, ez + Math.sin(facing) * 0.75);
  hole.rotation.y = facing;
  frame.castShadow = true;
  sceneGroup.add(frame, hole);
  const dirx = Math.cos(a), dirz = Math.sin(a); // 線路は斜面を下る向き(入口から外へ)
  const railLen = R * 0.5;
  const tieItems = [];
  const ties = Math.round(railLen / 2.2);
  for (let i = 0; i < ties; i++) {
    const t = (i + 0.5) / ties * railLen;
    const x = ex + dirx * t, z = ez + dirz * t;
    tieItems.push({ x, y: groundY(x, z, height) + 0.1, z, ry: a + Math.PI / 2, s: 1 });
  }
  const tieMesh = instancedFrom(GEO.tie, MAT.tie, tieItems);
  if (tieMesh) sceneGroup.add(tieMesh);
  [-0.55, 0.55].forEach((off) => {
    const rail = new THREE.Mesh(GEO.rail, MAT.rail);
    rail.scale.set(railLen, 1, 1);
    const ox = -Math.sin(a) * off, oz = Math.cos(a) * off;
    rail.position.set(ex + dirx * railLen / 2 + ox, groundY(ex + dirx * railLen / 2, ez + dirz * railLen / 2, height) + 0.2, ez + dirz * railLen / 2 + oz);
    rail.rotation.y = -a;
    sceneGroup.add(rail);
  });
}
// マスの境目(六角の辺)を、隣り合う地形の組み合わせに合った縁取りで描く。海に面した辺(渚)は描かない。
// 頂点のすぐそば(置ける場所の印)は避けるよう、辺の両端から margin ぶん内側だけに描く。
function buildHexBoundaries(g, field) {
  const margin = 15;
  const seen = new Set();
  g.edges.forEach((edge) => {
    if (seen.has(edge.id)) return;
    seen.add(edge.id);
    const hexes = (edge.hexIds || []).map((id) => g.hexes[id]).filter(Boolean);
    if (hexes.length < 2) return; // 盤の外周(海)は描かない
    if (hexes.some((h) => WATER_LIKE.has(h.terrain))) return; // 本物の海岸線(渚)は描かない
    const [ta, tb] = [hexes[0].terrain, hexes[1].terrain];
    if (ta === tb) return; // 同じ地形どうしは縁取りなし(林冠のつながりに任せる)
    const pair = [ta, tb].sort().join('|');
    const style = boundaryStyle(pair, edge.id);
    if (!style) return;
    const v1 = g.vertices[edge.v1], v2 = g.vertices[edge.v2];
    const x1 = v1.x * SCALE, z1 = v1.y * SCALE, x2 = v2.x * SCALE, z2 = v2.y * SCALE;
    const full = Math.hypot(x2 - x1, z2 - z1);
    if (full <= margin * 2 + 4) return;
    const ux = (x2 - x1) / full, uz = (z2 - z1) / full;
    const ax = x1 + ux * margin, az = z1 + uz * margin, bx = x2 - ux * margin, bz = z2 - uz * margin;
    const len = Math.hypot(bx - ax, bz - az);
    const ang = -Math.atan2(bz - az, bx - ax);
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    const fallbackY = baseYOfHex(hexes[0]);
    // 地形は起伏があるので、縁取りは1本の板ではなく短い区切りを並べ、区切りごとに地面の高さを取り直す
    // (1枚の長い板にすると、途中でうねりに埋まって点線のように欠けて見えてしまう)。
    const yOffset = style === 'stream' ? 0.3 : (style === 'path' ? 0.1 : 0.5);
    const geo = style === 'wall' ? GEO.wallStone : style === 'hedge' ? GEO.hedge : style === 'stream' ? GEO.streamTile : GEO.pathTile;
    const mat = style === 'wall' ? MAT.wallStone : style === 'hedge' ? MAT.hedge : style === 'stream' ? MAT.stream : MAT.path;
    const n = Math.max(2, Math.round(len / 1.3));
    const items = [];
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      items.push({ x, y: groundY(x, z, fallbackY) + yOffset, z, ry: ang, s: 1 });
    }
    const variance = (style === 'path' || style === 'stream') ? 0 : 0.015;
    const mesh = instancedFrom(geo, mat, items, variance);
    if (mesh) sceneGroup.add(mesh);
  });
}
// 地形の組み合わせごとの縁取りの種類。辺id(ハッシュ)で一部を小川・あぜ道に振り分け、単調にしない。
function boundaryStyle(pair, edgeId) {
  const h = hexRng(edgeId * 997 + 3)(0, 1);
  if (pair === 'forest|pasture' || pair === 'forest|field') return h < 0.5 ? 'hedge' : 'wall';
  if (pair === 'pasture|field') return h < 0.35 ? 'stream' : (h < 0.7 ? 'hedge' : 'path');
  if (pair === 'field|hills' || pair === 'hills|mountains' || pair === 'field|mountains') return 'wall';
  if (pair === 'forest|hills' || pair === 'forest|mountains') return 'wall';
  if (pair === 'pasture|hills') return h < 0.5 ? 'wall' : 'path';
  if (pair.includes('desert')) return h < 0.4 ? 'path' : null;
  return h < 0.5 ? 'path' : 'hedge';
}

function addCastle(cx, cz, height) {
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(16, 20, 34, 8), new THREE.MeshStandardMaterial({ color: 0x8b8f99 }));
  tower.position.set(cx, height + 17, cz);
  tower.castShadow = true;
  const roof = new THREE.Mesh(new THREE.ConeGeometry(20, 16, 8), new THREE.MeshStandardMaterial({ color: 0x5a3a2a }));
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
  const hull = new THREE.Mesh(new THREE.BoxGeometry(18, 5, 7), new THREE.MeshStandardMaterial({ color: 0x4a3420 }));
  hull.position.set(mx, SEA_LEVEL + 2.5, mz);
  hull.rotation.y = ang;
  const sail = new THREE.Mesh(new THREE.ConeGeometry(6, 12, 3), new THREE.MeshStandardMaterial({ color: new THREE.Color(playerColor) }));
  sail.rotation.y = ang;
  sail.rotation.z = Math.PI / 2;
  sail.position.set(mx, SEA_LEVEL + 9, mz);
  hull.castShadow = true; sail.castShadow = true;
  sceneGroup.add(hull, sail);
}

// 家: 土台(石)・壁・軒(屋根の張り出し)・屋根の4段。軒は壁より少し広い板を45度回し、角を庇のように張り出す
function addHouse(x, baseY, z, color) {
  const stoneMat = new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.55), roughness: 0.95 });
  const wallMat = new THREE.MeshStandardMaterial({ color, roughness: 0.8 });
  const roofMat = new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.72), roughness: 0.75 });
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(12.5, 2, 12.5), stoneMat);
  plinth.position.set(x, baseY + 1 + 1.5, z);
  const body = new THREE.Mesh(new THREE.BoxGeometry(11, 8, 11), wallMat);
  body.position.set(x, baseY + 2 + 4 + 1.5, z);
  const eave = new THREE.Mesh(new THREE.BoxGeometry(13, 1.2, 13), roofMat);
  eave.rotation.y = Math.PI / 4;
  eave.position.set(x, baseY + 2 + 8 + 0.6 + 1.5, z);
  const roof = new THREE.Mesh(new THREE.ConeGeometry(9, 7, 4), roofMat);
  roof.rotation.y = Math.PI / 4;
  roof.position.set(x, baseY + 2 + 8 + 1.2 + 3.5 + 1.5, z);
  [plinth, body, eave, roof].forEach((m) => { m.castShadow = true; sceneGroup.add(m); });
}
// 都市: 土台・基部・塔・塔の軒・屋根。基部と塔はどちらも面取り代わりに軒(張り出し)を挟む
function addCity(x, baseY, z, color) {
  const stoneMat = new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.55), roughness: 0.95 });
  const wallMat = new THREE.MeshStandardMaterial({ color, roughness: 0.8 });
  const roofMat = new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.72), roughness: 0.75 });
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(18.5, 2, 18.5), stoneMat);
  plinth.position.set(x, baseY + 1 + 1.5, z);
  const base = new THREE.Mesh(new THREE.BoxGeometry(17, 9, 17), wallMat);
  base.position.set(x, baseY + 2 + 4.5 + 1.5, z);
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(6, 6.6, 17, 8), wallMat);
  tower.position.set(x, baseY + 2 + 9 + 8.5 + 1.5, z);
  const towerEave = new THREE.Mesh(new THREE.CylinderGeometry(8, 8, 1.4, 8), roofMat);
  towerEave.position.set(x, baseY + 2 + 9 + 17 + 0.7 + 1.5, z);
  const roof = new THREE.Mesh(new THREE.ConeGeometry(7, 9, 8), roofMat);
  roof.position.set(x, baseY + 2 + 9 + 17 + 1.4 + 4.5 + 1.5, z);
  [plinth, base, tower, towerEave, roof].forEach((m) => { m.castShadow = true; sceneGroup.add(m); });
}
function addKnight(x, baseY, z, color, active) {
  const c = new THREE.Color(color);
  if (!active) c.multiplyScalar(0.55);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 4.2, 10, 7), new THREE.MeshStandardMaterial({ color: c }));
  body.position.set(x, baseY + 5 + 1.5, z);
  const head = new THREE.Mesh(new THREE.SphereGeometry(3, 8, 6), new THREE.MeshStandardMaterial({ color: c }));
  head.position.set(x, baseY + 11 + 1.5, z);
  sceneGroup.add(body, head);
}
// 盗賊: マント(裾広がりの円錐)・肩の襟巻き(トーラス)・頭・とがり帽子のつば
function addRobber(cx, height, cz, blink) {
  const cloakMat = new THREE.MeshStandardMaterial({ color: 0x1c1b22, roughness: 0.9 });
  const body = new THREE.Mesh(new THREE.ConeGeometry(9, 22, 8), cloakMat);
  body.position.set(cx, height + 11, cz);
  const collar = new THREE.Mesh(new THREE.TorusGeometry(5, 1.6, 6, 10), cloakMat);
  collar.rotation.x = Math.PI / 2;
  collar.position.set(cx, height + 20, cz);
  const head = new THREE.Mesh(new THREE.SphereGeometry(6, 8, 6), new THREE.MeshStandardMaterial({ color: 0x2d2c36, roughness: 0.85 }));
  head.position.set(cx, height + 25, cz);
  const brim = new THREE.Mesh(new THREE.ConeGeometry(7, 3, 8), cloakMat);
  brim.position.set(cx, height + 29, cz);
  sceneGroup.add(body, collar, head, brim);
  if (blink) addPulseRing(cx, height + 1, cz, 20, 0xffd84a);
}
function addPirate(cx, height, cz, blink) {
  const hull = new THREE.Mesh(new THREE.BoxGeometry(22, 6, 14), new THREE.MeshStandardMaterial({ color: 0x2b1d10 }));
  hull.position.set(cx, height + 3, cz);
  sceneGroup.add(hull);
  addRobber(cx, height + 4, cz, blink);
}
function addPulseRing(x, y, z, r, color) {
  const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 1.6, 6, 28),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1 }));
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
    const baseY = baseYOfHex(firstHexAt(g, v.hexIds));
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
    const baseY = baseYOfHex(firstHexAt(g, e.hexIds));
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
    const height = baseYOfHex(hex);
    const pts = hexPointsOf(g, hex);
    const mesh = new THREE.Mesh(flatHexGeometry(pts.map(([x, z]) => [x - cx, z - cz]), 0),
      new THREE.MeshStandardMaterial({ color: 0xffe9a8, emissive: 0xffd84a, emissiveIntensity: 0.5, transparent: true, opacity: 0.55, side: THREE.DoubleSide }));
    mesh.position.set(cx, height + 1, cz);
    sceneGroup.add(mesh);
    hitTargets.push({ mesh, kind: 'hex', id: hex.id });
    pulseMeshes.push(mesh);
  }
}
