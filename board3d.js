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
  high: { cell: 2.6, maxGrid: 400, shadowMap: 4096, gtaoSamples: 16, bloom: true, dprCap: 2.5 }, // 盤全体で512x512以上(ブリーフの要求)
}[QUALITY];
// 太陽の向き(午後の低い角度)。方位はカメラが見やすい斜め後ろから、高度25-35°
const SUN_AZIMUTH = Math.PI * 0.9; // ③: 正面からの順光だと起伏がのっぺり見えたので、左からの斜光(影が右へ伸びる)にした
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
const COAST_JITTER = 9;
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
let vegGroup = null, vegSignature = null; // 植生と小物(盤の形・霧が変わったときだけ作り直す)
let terrainField = null;
let terrainGrid = null; // 地形メッシュの格子(groundYが描いた面の高さを引く) // 地形の高さ・地形idを任意の(x,z)で引けるもの(盤の形が変わるたびに作り直す)
let composer = null; // EffectComposer(GTAO/ブルーム/LUT/SMAA/OutputPass)。renderer.render直接呼びはしない
let gtaoPass = null, bloomPass = null;

// ---- 共通ジオメトリ（使い回す。インスタンスごとに作らない） ----
// 縮尺: 1マス(辺から辺まで約114単位)を数百m四方とみなし、1単位≒2.5m。木の林冠は直径3〜4単位(8〜10m)、
// 羊は体長1単位(2.5m弱。既定のカメラで白い点になる程度)。どれも小さく、InstancedMeshで大量に並べる。
// 単純図形(円錐1個の木・球1個の羊)の見た目を避けるため、林冠はでこぼこに歪めた球、針葉樹は2段の円錐、
// 羊は胴を引き伸ばした球にしている(どれも滑らかな法線。flatShadingは使わない)。
function lumpy(geo, amp, seed) { // 頂点を位置の関数でずらす(同じ位置の頂点は同じだけ動くので継ぎ目が割れない)
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const f = 1 + amp * (Math.sin(x * 3.1 + y * 1.7 + seed) * Math.cos(z * 2.3 - y * 1.1 + seed * 0.7) + Math.sin(x * 5.3 - z * 4.1) * 0.4);
    p.setXYZ(i, x * f, y * f, z * f);
  }
  geo.computeVertexNormals();
  return geo;
}
function conifer() { // 針葉樹: 下段の広い円錐+上段の細い円錐(1つのジオメトリにまとめる)
  const a = new THREE.ConeGeometry(1.5, 3.6, 8, 1, true).translate(0, -0.7, 0);
  const b = new THREE.ConeGeometry(1.05, 3.0, 8, 1, true).translate(0, 1.2, 0);
  const pos = [...a.attributes.position.array, ...b.attributes.position.array];
  const idx = [...a.index.array, ...b.index.array.map((v) => v + a.attributes.position.count)];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return lumpy(g, 0.06, 2);
}
const GEO = {
  conCanopy: conifer(), // 高さ約5.2(地面から立てる)
  broadCanopy: lumpy(new THREE.SphereGeometry(1.9, 10, 7), 0.16, 1).scale(1, 0.78, 1), // 広葉樹の林冠
  bush: lumpy(new THREE.SphereGeometry(0.85, 7, 5), 0.18, 5).scale(1, 0.8, 1), // 生け垣・低木
  sheepBody: new THREE.SphereGeometry(0.4, 7, 5).scale(1, 0.75, 1.35),
  fencePost: new THREE.CylinderGeometry(0.12, 0.14, 1.1, 5),
  fenceRail: new THREE.BoxGeometry(1, 0.08, 0.08),
  fieldRock: smoothGeo(lumpy(new THREE.SphereGeometry(0.5, 6, 4), 0.25, 9)).scale(1, 0.6, 1),
  brickStack: new THREE.BoxGeometry(1.3, 1.0, 1.3), // レンガを積んだパレット1つ
  kilnHall: new THREE.BoxGeometry(9, 2.4, 3.6), // 窯場の細長い建屋(輪窯)
  kilnRoof: new THREE.CylinderGeometry(1.9, 1.9, 9.2, 3, 1).rotateZ(Math.PI / 2), // 切妻屋根(三角柱)
  chimney: new THREE.CylinderGeometry(0.45, 0.65, 10, 8),
  smoke: smoothGeo(new THREE.IcosahedronGeometry(1, 2)),
  scree: smoothGeo(lumpy(new THREE.SphereGeometry(0.7, 6, 4), 0.3, 3)).scale(1, 0.65, 1),
  mineFrame: new THREE.BoxGeometry(3.0, 2.8, 1.2),
  mineHole: new THREE.BoxGeometry(1.8, 1.9, 0.4),
  rail: new THREE.BoxGeometry(1, 0.12, 0.14),
  tie: new THREE.BoxGeometry(1.3, 0.12, 0.4),
  dryGrass: lumpy(new THREE.SphereGeometry(0.4, 6, 4), 0.3, 7).scale(1, 0.5, 1),
  desertRock: smoothGeo(lumpy(new THREE.SphereGeometry(0.8, 7, 5), 0.3, 11)).scale(1, 0.55, 1),
  nugget: new THREE.OctahedronGeometry(3.4, 0),
  dockPlank: new THREE.BoxGeometry(2.2, 0.4, 1.3),
  boatHull: new THREE.BoxGeometry(7, 2, 2.6),
  boatSail: new THREE.ConeGeometry(1.6, 3.6, 3),
  signPost: new THREE.CylinderGeometry(0.22, 0.26, 3.4, 6),
  signBoard: new THREE.BoxGeometry(3.2, 1.8, 0.2),
  wallStone: new THREE.BoxGeometry(1.05, 0.75, 0.8), // 石垣の一区切り
  pathTile: new THREE.BoxGeometry(1.1, 0.1, 2.0), // 土の農道
  streamTile: new THREE.BoxGeometry(1.1, 0.06, 1.5), // 細い小川

  // ---- ④: 建物・道・持ち主の色。高さはgeometry.translate()で焼き込み、1単位≒2.5mの縮尺 ----
  // (④の直し: 既定のカメラから誰の建物・道か分かるよう、旗・標柱・道幅を実物よりはっきり大きくしている)
  housePlinth: new THREE.BoxGeometry(3.8, 0.5, 3.8).translate(0, 0.25, 0), // 石の土台
  houseWall: new THREE.BoxGeometry(3.2, 2.5, 3.3).translate(0, 0.5 + 1.25, 0), // 石灰・石積みの壁(持ち主色なし)
  houseShutters: mergeBoxes([ // 雨戸(左右の窓の脇。持ち主の色)
    [0.22, 0.95, 0.1, -0.95, 0.5 + 1.55, 1.68], [0.22, 0.95, 0.1, 0.95, 0.5 + 1.55, 1.68],
  ]),
  houseAwning: new THREE.BoxGeometry(1.7, 0.08, 0.9).translate(0, 0, 0.45).rotateX(-0.32).translate(0, 0.5 + 2.08, 1.55), // 日よけ布(持ち主の色)
  houseEave: new THREE.BoxGeometry(4.3, 0.26, 4.4).rotateY(Math.PI / 4).translate(0, 0.5 + 2.5 + 0.13, 0),
  houseRoofTile: new THREE.ConeGeometry(3.0, 2.2, 4, 1).rotateY(Math.PI / 4).translate(0, 0.5 + 2.5 + 0.26 + 1.1, 0), // 瓦
  houseRoofThatch: lumpy(new THREE.ConeGeometry(3.15, 2.0, 4, 1), 0.07, 11).rotateY(Math.PI / 4).translate(0, 0.5 + 2.5 + 0.26 + 1.0, 0), // 茅葺き
  houseChimney: new THREE.CylinderGeometry(0.17, 0.22, 1.5, 6).translate(1.1, 0.5 + 2.5 + 2.0, 1.1),
  flagPole: new THREE.CylinderGeometry(0.14, 0.2, 10.6, 6).translate(0, 5.3, 0),
  flagCloth: new THREE.BoxGeometry(4.4, 2.6, 0.07, 5, 3).translate(2.3, 9.1, 0), // 分割を入れて風シェーダでしなるように
  cityWallRing: new THREE.CylinderGeometry(15.6, 16.8, 9.5, 10, 1, true),
  cityCrenel: new THREE.BoxGeometry(1.15, 1.3, 1.15),
  cityTower: new THREE.CylinderGeometry(3.7, 4.1, 16, 8),
  cityTowerRoof: new THREE.ConeGeometry(4.5, 6.4, 8),
  towerWindow: new THREE.BoxGeometry(0.55, 1.15, 0.26), // 塔の窓(石積みにめり込ませる。暗く+わずかに灯る)
  churchBody: new THREE.BoxGeometry(6.2, 11, 7.4).translate(0, 5.5, 0),
  churchRoof: new THREE.CylinderGeometry(0.15, 4.8, 6.8, 4, 1).rotateY(Math.PI / 4).translate(0, 11 + 3.4, 0),
  churchSpire: new THREE.CylinderGeometry(1.15, 1.5, 3.3, 6).translate(0, 11 + 6.8 + 1.65, 0),
  churchSpireRoof: new THREE.ConeGeometry(1.55, 3.6, 6).translate(0, 11 + 6.8 + 3.3 + 1.8, 0),
  roadTile: new THREE.BoxGeometry(12.5, 0.2, 2.6), // 石畳/土の路面(xが道幅、zが道なりの長さ)。幅は見やすさ優先で実物よりだいぶ広い
  roadRut: new THREE.BoxGeometry(0.6, 0.05, 2.4), // 轍
  roadPost: new THREE.CylinderGeometry(0.19, 0.27, 5.6, 6).translate(0, 2.8, 0), // 道沿いの標柱(旗のポールより低いが地面からよく見える高さ)
  roadBanner: new THREE.BoxGeometry(2.7, 1.75, 0.06, 5, 3, 1).translate(1.45, 4.5, 0), // 標柱の布(旗と同じ仕組みでなびく)
  shipHull: hullGeometry(16, 4.6, 6.4), // 航海者の船(辺に置く)。舳先がとがった船体
  knightRobe: new THREE.CylinderGeometry(0.85, 1.15, 2.2, 7), // 持ち主の色の外套。上面が平らで、見下ろすカメラでも色がよく見える
  knightHead: new THREE.SphereGeometry(0.68, 7, 5),
};
function smoothGeo(g) { g.computeVertexNormals(); return g; }
// 複数のBoxGeometryを1つにまとめる(conifer()と同じ要領)。[w,h,d,x,y,z]の配列を受け取り、
// 位置が離れた箱どうし(例: 家の左右の雨戸)を1つのジオメトリ=1インスタンスとして扱えるようにする。
function mergeBoxes(specs) {
  const parts = specs.map(([w, h, d, x, y, z]) => new THREE.BoxGeometry(w, h, d).translate(x, y, z));
  const pos = [].concat(...parts.map((p) => [...p.attributes.position.array]));
  let offset = 0;
  const idx = [].concat(...parts.map((p) => { const a = [...p.index.array.map((v) => v + offset)]; offset += p.attributes.position.count; return a; }));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return smoothGeo(g);
}
// 船体: 真上から見て舳先がとがった形(四角い箱のままにしない)。幅wはx、奥行きdはz、高さh
function hullGeometry(w, h, d) {
  const shape = new THREE.Shape();
  const back = -w * 0.46, bow = w * 0.54, side = d / 2;
  shape.moveTo(back, -side); shape.lineTo(bow, 0); shape.lineTo(back, side); shape.lineTo(back, -side);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: 1 });
  geo.rotateX(Math.PI / 2); // extrudeはxy平面+z方向。倒して甲板をxz平面にする
  geo.translate(0, h / 2, 0);
  return smoothGeo(geo);
}
const MAT = {
  conLeaf: new THREE.MeshStandardMaterial({ color: 0x223a2a, roughness: 0.92 }),
  broadLeaf: new THREE.MeshStandardMaterial({ color: 0x3a5226, roughness: 0.9 }),
  bush: new THREE.MeshStandardMaterial({ color: 0x34492a, roughness: 0.92 }),
  sheep: new THREE.MeshStandardMaterial({ color: 0xf2eee2, roughness: 0.9 }),
  fence: new THREE.MeshStandardMaterial({ color: 0x7d6446, roughness: 0.9 }),
  fieldRock: new THREE.MeshStandardMaterial({ color: 0x8f8b80, roughness: 0.95 }),
  brick: new THREE.MeshStandardMaterial({ color: 0x9c4a2c, roughness: 0.92 }),
  kiln: new THREE.MeshStandardMaterial({ color: 0x8a5a40, roughness: 0.95 }),
  kilnRoof: new THREE.MeshStandardMaterial({ color: 0x5b4a40, roughness: 0.85 }),
  smoke: new THREE.MeshStandardMaterial({ color: 0xd6d4ce, roughness: 1, transparent: true, opacity: 0.4, depthWrite: false }),
  scree: new THREE.MeshStandardMaterial({ color: 0x6b675f, roughness: 0.95 }),
  mineFrame: new THREE.MeshStandardMaterial({ color: 0x5b4226, roughness: 0.9 }),
  mineHole: new THREE.MeshStandardMaterial({ color: 0x100d0a, roughness: 1 }),
  rail: new THREE.MeshStandardMaterial({ color: 0x5a5a5a, roughness: 0.6, metalness: 0.4 }),
  tie: new THREE.MeshStandardMaterial({ color: 0x4a3420, roughness: 0.9 }),
  dryGrass: new THREE.MeshStandardMaterial({ color: 0x7d6e42, roughness: 0.95 }),
  desertRock: new THREE.MeshStandardMaterial({ color: 0x6f5f4c, roughness: 0.95 }),
  gold: new THREE.MeshStandardMaterial({ color: 0xf0c83c, roughness: 0.4, metalness: 0.6, emissive: 0x4a3a00 }),
  dock: new THREE.MeshStandardMaterial({ color: 0x7a5c38, roughness: 0.9 }),
  boatHull: new THREE.MeshStandardMaterial({ color: 0x4a3420, roughness: 0.85 }),
  signPost: new THREE.MeshStandardMaterial({ color: 0x6e5436, roughness: 0.9 }),
  wallStone: new THREE.MeshStandardMaterial({ color: 0x9a968c, roughness: 0.95 }),
  path: new THREE.MeshStandardMaterial({ color: 0x8c7752, roughness: 1 }),
  stream: new THREE.MeshStandardMaterial({ color: 0x2c5056, roughness: 0.15, metalness: 0.1 }),

  // ---- ④: 建物・道・持ち主の色 ----
  housePlinth: new THREE.MeshStandardMaterial({ color: 0xb7b0a0, roughness: 0.95 }), // 石の土台(持ち主色なし)
  // ④の直し: 壁はどの家も石灰・石積み(白〜生成り〜灰)で統一し、持ち主の色は出さない。
  // instancedFromのvariance(個体ごとの色ばらつき)だけ使うので、Bに積むとき色は渡さない。
  houseWall: new THREE.MeshStandardMaterial({ color: 0xcdc3ad, roughness: 0.88 }),
  houseShutter: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75 }), // 雨戸(木。白地+instanceColorで持ち主の色)
  eaveTrim: new THREE.MeshStandardMaterial({ color: 0x6b5a46, roughness: 0.85 }), // 軒(木)
  roofTile: new THREE.MeshStandardMaterial({ color: 0x8a4a36, roughness: 0.8 }), // 瓦
  roofThatch: new THREE.MeshStandardMaterial({ color: 0xc8a862, roughness: 0.95 }), // 茅葺き
  chimney: new THREE.MeshStandardMaterial({ color: 0x8f7a68, roughness: 0.9 }),
  roadStone: new THREE.MeshStandardMaterial({ color: 0xbaa87c, roughness: 0.92 }), // 道の路面(土/石畳)。地形よりはっきり明るくして見分けやすく
  roadRut: new THREE.MeshStandardMaterial({ color: 0x4a3a26, roughness: 1 }),
  knightArmor: new THREE.MeshStandardMaterial({ color: 0x5c606a, roughness: 0.55, metalness: 0.35 }),
  cloth: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, side: THREE.DoubleSide }), // 旗・布(instanceColorで持ち主の色)
  towerWindow: new THREE.MeshStandardMaterial({ color: 0x15120d, roughness: 0.7, emissive: 0x3a2710, emissiveIntensity: 0.4 }), // 夕方の灯り
};
function buildCityStoneMaterial() { // 城壁・塔は山の岩肌テクスチャを使い回して石積みの質感・色むらを出す(新しい素材を増やさない)。
  // terrainTextures()のキャッシュ済みテクスチャをclone()すると、まだ画像を読み込み中の場合にimageが
  // 空のままになる(cloneは参照のスナップショットで、あとから届くonLoadを拾えない)ので、ここだけ
  // 独自にloadTerrainTex()で読み込み直す(リピート設定が違うので共有もできない。画像はブラウザ側でキャッシュされる)。
  const map = loadTerrainTex('./textures/mountains_diff.jpg', true);
  const nor = loadTerrainTex('./textures/mountains_nor.jpg', false);
  const arm = loadTerrainTex('./textures/mountains_arm.jpg', false);
  [map, nor, arm].forEach((t) => { t.repeat.set(2.6, 1.3); });
  const mat = new THREE.MeshStandardMaterial({ map, normalMap: nor, roughnessMap: arm, color: 0xb8b2a0, roughness: 1 });
  mat.normalScale.set(0.5, 0.5);
  return mat;
}
// 密度は画質(中/高)で数だけ変える(大きさは変えない)。森は詰めすぎても見た目が変わらないので頭打ちにする
const DENSITY = { mid: 1, high: 3.4 }[QUALITY];
const FOREST_DENSITY = Math.min(DENSITY, 2.2);

// 風の揺れ(頂点シェーダ)。InstancedMeshの各個体ごとに位相をずらし(instanceMatrixの位置から)、
// ジオメトリの上のほう(position.yが大きいところ)ほど大きく揺らす。「動き オフ」ではuTimeの更新を
// 止める(animate()参照)ので、自然に止まる(このシェーダ自体に有効フラグは持たせない)。
// aoが0より大きいと、林冠の下ほど暗くする(葉の塊の内側の陰。空撮で木の粒が立体に見えるように)。
function applyWindSway(mat, heightRef, amp, freq, ao) {
  // three.jsはonBeforeCompileの関数の文字列でシェーダを使い回すので、値が違う材質どうしを区別させる
  mat.customProgramCacheKey = () => `sway:${heightRef}:${amp}:${freq}:${ao}`;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, vegUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying float vCrown;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          float windPhase = instanceMatrix[3].x * 0.07 + instanceMatrix[3].z * 0.05;
        #else
          float windPhase = 0.0;
        #endif
        vCrown = clamp(position.y / ${heightRef.toFixed(2)} * 0.5 + 0.5, 0.0, 1.0);
        float windLift = clamp(position.y / ${heightRef.toFixed(2)} + 0.5, 0.0, 1.0);
        windLift *= windLift;
        transformed.x += sin(uTime * ${freq.toFixed(2)} + windPhase) * ${amp.toFixed(2)} * windLift;
        transformed.z += cos(uTime * ${(freq * 0.82).toFixed(2)} + windPhase) * ${(amp * 0.6).toFixed(2)} * windLift;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vCrown;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb *= mix(${(1 - ao).toFixed(2)}, 1.06, vCrown);`);
  };
}
applyWindSway(MAT.conLeaf, 2.6, 0.06, 1.1, 0.55);
applyWindSway(MAT.broadLeaf, 1.5, 0.07, 1.0, 0.5);
applyWindSway(MAT.bush, 0.7, 0.03, 1.3, 0.45);
applyWindSway(MAT.dryGrass, 0.2, 0.03, 1.6, 0.3);

// 旗・布のなびき(頂点シェーダ)。木の揺れ(position.y基準)と違い、ポールに固定した辺(ローカルx=0)から
// 遠いほど(x方向)大きく揺れる。vegUniforms.uTimeを共有するので「動き オフ」で一緒に止まる。
function applyFlagSway(mat, reach) {
  mat.customProgramCacheKey = () => `flagsway:${reach}`;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, vegUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          float flagPhase = instanceMatrix[3].x * 0.1 + instanceMatrix[3].z * 0.08;
        #else
          float flagPhase = 0.0;
        #endif
        float flutter = clamp(position.x / ${reach.toFixed(2)}, 0.0, 1.0);
        flutter *= flutter;
        transformed.y += sin(uTime * 2.6 + flutter * 3.1 + flagPhase) * 0.22 * flutter;
        transformed.z += cos(uTime * 2.1 + flutter * 3.1 + flagPhase) * 0.16 * flutter;`);
  };
}
applyFlagSway(MAT.cloth, 1.2);

// 持ち主の色を「染めた布」くらいの彩度・明るさに落とす(旗・標柱の布・帆に使う。蛍光色にしない)
function clothColor(colorHex) {
  const hsl = {};
  new THREE.Color(colorHex).getHSL(hsl);
  // ④の直し: 既定のカメラでも誰の色か分かるよう、以前より少しだけ鮮やかに・明るめに許す(蛍光色にはしない)
  return new THREE.Color().setHSL(hsl.h, Math.min(hsl.s, 0.68), Math.min(Math.max(hsl.l, 0.33), 0.58));
}
// instancedでない単体の駒(騎士・船)用に、色ごとの布材質をMATに登録して使い回す(dispose対象から外すため)。
function clothMaterial(colorHex) {
  const key = 'cloth_' + new THREE.Color(colorHex).getHexString();
  if (!MAT[key]) {
    const m = new THREE.MeshStandardMaterial({ color: clothColor(colorHex), roughness: 0.82, side: THREE.DoubleSide });
    applyFlagSway(m, 2.3);
    MAT[key] = m;
  }
  return MAT[key];
}
function angDiff(a, b) { const d = Math.abs(a - b) % (Math.PI * 2); return d > Math.PI ? Math.PI * 2 - d : d; }
// 頂点から出ている辺の向き(道がある/できる方角)。集落の家はこの方角を避けて建てる
function vertexEdgeAngles(g, v) {
  return v.edgeIds.map((eid) => {
    const e = g.edges[eid];
    const other = g.vertices[e.v1 === v.id ? e.v2 : e.v1];
    return Math.atan2(other.y - v.y, other.x - v.x);
  });
}
const TERRAIN_MAT = {}; // 地形ごとのタイル材質(一度作ったら使い回す)。terrainTextures()の結果と対応

function clampUnit(v) { return Math.min(1, Math.max(0, v)); }
function smoothstep(lo, hi, v) { const t = clampUnit((v - lo) / (hi - lo)); return t * t * (3 - 2 * t); }
function lerp(a, b, t) { return a + (b - a) * t; }

// 色調整のLUT(3D Data Texture)をコードで作る(.cubeファイルを持たないぶん軽い)。
// 「彩度を少し落とし、影をわずかに青く、ハイライトを暖かく」。恒等変換からのズレは小さく抑える。
function buildColorLUT(size) {
  const data = new Uint8Array(size * size * size * 4);
  const SAT = 0.93; // 1よりわずかに落とす
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        let R = r / (size - 1), G = g / (size - 1), B = b / (size - 1);
        const luma = R * 0.299 + G * 0.587 + B * 0.114;
        R = luma + (R - luma) * SAT; G = luma + (G - luma) * SAT; B = luma + (B - luma) * SAT;
        const shadowW = 1 - smoothstep(0.12, 0.5, luma); // 暗部ほど強く青みを足す
        const highW = smoothstep(0.5, 0.92, luma); // 明部ほど強く暖色を足す
        R += highW * 0.03 - shadowW * 0.008;
        G += highW * 0.014 - shadowW * 0.002;
        B += highW * -0.025 + shadowW * 0.024;
        // 全体に軽いS字(中間調を少し締める)でコントラストを足す。霞んで見える対策
        R = R + (R - 0.5) * 0.05; G = G + (G - 0.5) * 0.05; B = B + (B - 0.5) * 0.05;
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
  renderer.toneMappingExposure = 1.05; // 低すぎると夕方の空撮にしては暗すぎたので上げた
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

  // ③の直し: 岩・粘土が紫〜ラベンダーに見えていた原因は、青い空の光(晴天のHDRIの環境光+青い半球光)が
  // 太陽の暖色(赤寄り)と重なって緑だけが足りなくなる(赤+青=紫)ことと、LUTが影を青く・赤を引いていたこと。
  // 環境光を弱め(scene.environmentIntensity)、半球光をほぼ無彩色にし、太陽は緑を残した暖白にした。
  scene.environmentIntensity = 0.5;
  scene.add(new THREE.HemisphereLight(0xe4ecf2, 0x3c3a2a, 0.42));
  // 午後の低い太陽。暖色だが地形の色そのものを赤く染めないよう、彩度は控えめな暖白にする
  sun = new THREE.DirectionalLight(0xfff4e4, 2.1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(Q.shadowMap, Q.shadowMap);
  sun.shadow.bias = -0.00018;
  sun.shadow.normalBias = 1.4; // シーンのスケールが大きい(1単位≒数m)ぶん大きめの値にしてアクネを消す
  sun.shadow.camera.near = 10; sun.shadow.camera.far = 1600; // 盤の大きさが分かり次第updateSunForBoard()で詰め直す
  scene.add(sun);
  // 太陽を仮置き(盤の大きさが分かる最初のframeCamera()でupdateSunForBoard()が向き直す)
  updateSunForBoard(HEX_R * 3);

  // 木・羊・麦・岩などに使う材質は、個体ごとに色をわずかにずらす(InstancedMeshのinstanceColor)。
  // instanceColorはmaterial.vertexColorsを立てなくても自動で効く。ここで立てると三.jsが
  // ジオメトリ側の`color`頂点属性(存在しない)を読みに行き、既定値(0,0,0)と乗算されて真っ黒になる
  // (羊・木の葉・山頂が黒くなっていた不具合の原因)。

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
  gtaoPass.blendIntensity = 0.42; // 薄く(ハローが目立たない程度。強すぎると全体が暗く灰色がかって見えた)
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
// variance: 材質の色からの色ばらつき(木・岩など)。items[0].colorがあれば代わりにその色をそのまま使う
// (建物の壁・旗など、持ち主の色をそのまま出したいとき。材質の地色は白にしておく)。
function instancedFrom(geo, mat, items, variance) {
  if (!items.length) return null;
  const mesh = new THREE.InstancedMesh(geo, mat, items.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const exact = !!items[0].color;
  const hsl = (variance && !exact) ? mat.color.getHSL({}) : null;
  items.forEach((it, i) => {
    e.set(it.rx || 0, it.ry || 0, it.rz || 0);
    q.setFromEuler(e);
    m4.compose(new THREE.Vector3(it.x, it.y, it.z), q, new THREE.Vector3(it.s ?? 1, it.s ?? 1, it.s ?? 1));
    mesh.setMatrixAt(i, m4);
    if (exact) {
      mesh.setColorAt(i, it.color);
    } else if (variance) {
      const r = it.seed != null ? hexRng(it.seed) : rand;
      // instanceColorは材質の色に掛け算される。ずらした色そのものを入れると色が2乗されて真っ黒に近く
      // なる(木・生け垣が黒く見えた原因)ので、材質の色に対する比を入れる。
      const c = new THREE.Color().setHSL(
        hsl.h + r(-variance, variance), clampUnit(hsl.s + r(-0.06, 0.06)), clampUnit(hsl.l * r(0.8, 1.2)));
      const b = mat.color;
      mesh.setColorAt(i, c.setRGB(c.r / Math.max(b.r, 1e-4), c.g / Math.max(b.g, 1e-4), c.b / Math.max(b.b, 1e-4)));
    }
  });
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.instanceMatrix.needsUpdate = true;
  if (exact || variance) mesh.instanceColor.needsUpdate = true;
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
// 引数の順は(周波数, 種)。③の直し: 以前は宣言が(種, 周波数)で、呼び出し側は全部(周波数, 種)の順に
// 渡していたため、周波数に種(42や数万)が入って頂点ごとにでたらめな高さになっていた
// (地面が丸めた紙のようなしわ、海岸線のギザギザの原因)。
function fbm(x, z, freq, seed, oct, lac, gain) {
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
function terrainBump(terrain, x, z, seed, hcx, hcz) {
  const island = fbm(x, z, 0.0035, 42, 2) * 3; // 島全体を通る緩いうねり(マスをまたぐ大きな起伏)
  switch (terrain) {
    case 'forest': return island + fbm(x, z, 0.012, seed, 3) * 3.4 + fbm(x, z, 0.045, seed + 50, 2) * 0.9; // 林冠のでこぼこ
    case 'pasture': return island + fbm(x, z, 0.011, seed, 3) * 4.2; // 草地のゆるい起伏(なだらかな丘)
    case 'field': return island + fbm(x, z, 0.009, seed, 2) * 1.6; // 畑はなだらか
    case 'hills': { // 採掘場の段々(掘削跡): マス中心からの同心円を階段状にする(ノイズ任せだと段が
      // 細かく割れてトゲトゲに見えたり、マスによっては段差が1つも視野に入らなかったりしたため、
      // マスごとに必ず2〜3段できる同心円の階段にする。外側ほど高い(採掘で中心が掘り下がった形)
      const r = hillsRingRadius(x - hcx, z - hcz, seed);
      const ring = Math.floor(clampUnit(r / (SCALE * 0.62)) * 3.4) * 2.4;
      return island + ring + valueNoise2(x * 0.02, z * 0.02, seed) * 0.5; // 段の面にもわずかな荒れを足す
    }
    case 'mountains': { // 山だけ急(尾根・崖)。マスの縁へ向かって裾野に落とす(六角の台地に見えないように)
      // 数字の石碑を置く頂(マス中心のまわり)は平らにして、岩や雪に埋もれさせない
      const r = Math.hypot(x - hcx, z - hcz);
      const peak = (px, pz) => ridged(px, pz, seed, 0.016, 4) * 30 + 18 + ridged(px, pz, seed + 9, 0.038, 3) * 14 + ridged(px, pz, seed + 17, 0.1, 2) * 3;
      const taper = 1 - 0.8 * smoothstep(0.3, 1.0, r / HEX_R);
      // 頂から放射状に下る尾根と沢(浸食の筋)。角度の整数倍なので一周してもつながる
      const a = Math.atan2(z - hcz, x - hcx);
      const gully = (Math.abs(Math.sin(a * 7 + fbm(x, z, 0.03, seed + 5, 2) * 3)) - 0.5) * 7 * smoothstep(12, 40, r);
      return island + lerp(peak(hcx, hcz), (peak(x, z) + gully) * taper, smoothstep(14, 26, r)); // 2つ目以降は沢と小尾根
    }
    case 'desert': { // 風下側が急な砂丘の列(波長40単位ほど)。数字の石碑のまわりは平らにして埋もれさせない
      const a = 0.4, rx = x * Math.cos(a) - z * Math.sin(a) + fbm(x, z, 0.02, seed + 3, 2) * 18;
      const t = rx * 0.15 + seed;
      const dune = (Math.sin(t) + 0.35 * Math.sin(2 * t + 1.2)) * 3.2;
      const calm = smoothstep(17, 30, Math.hypot(x - hcx, z - hcz));
      return island + dune * calm + fbm(x, z, 0.035, seed + 7, 2) * 0.7;
    }
    default: return island + fbm(x, z, 0.015, seed, 2) * 1.6; // gold/castle/pitch/lake/fogなど拡張の特殊地形
  }
}
// 丘の採掘場の段の半径(同心円を少し波打たせる)。地面のシェーダ(hillsColor)にも同じ式を書いてある。
function hexSeedW(seed) { return (seed % 1000) / 1000; } // マスごとの0〜1の種(シェーダへも同じ値を渡す)
function hillsRingRadius(dx, dz, seed) {
  const w = hexSeedW(seed), a = Math.atan2(dz, dx);
  return Math.hypot(dx, dz) + Math.sin(a * 2 + w * 6.2832) * 4.5 + Math.sin(a * 3 + w * 12) * 3 + Math.sin(a * 7 + w * 20) * 1.2;
}
function terrainIdOf(terrain) { const i = TERRAIN_NAMES.indexOf(terrain); return i >= 0 ? i : 1; } // 不明な地形はpasture代用

function closestOnSeg(px, pz, seg) {
  const dx = seg.x2 - seg.x1, dz = seg.z2 - seg.z1;
  const len2 = dx * dx + dz * dz || 1;
  let t = ((px - seg.x1) * dx + (pz - seg.z1) * dz) / len2;
  t = clampUnit(t);
  return { x: seg.x1 + dx * t, z: seg.z1 + dz * t };
}
// 最寄りの海岸線分までの「海側への」符号つき距離(+:海側 / -:陸側)と、渚のスタイル(浜らしさ0〜1)。
// 岬(辺が何本も集まる角)では「一番近い1本」だけを採用すると、その1本が入れ替わる場所で符号・向きが
// 急に飛んで地面がギザギザになる(海岸がトゲトゲに見えた不具合の原因)。近い辺ほど重みを強くした
// 加重平均にして、どの辺が最寄りかが切り替わっても値が連続に変わるようにする。
function shoreSigned(field, x, z) {
  let wsum = 0, seawardSum = 0, beachWSum = 0;
  for (const seg of field.shoreSegs) {
    const pt = closestOnSeg(x, z, seg);
    const d = Math.hypot(x - pt.x, z - pt.z);
    const w = 1 / (d * d + 36); // +36: 間近の辺どうしでも重みが無限大に発散しない
    const seaward = (x - pt.x) * seg.nx + (z - pt.z) * seg.nz;
    wsum += w; seawardSum += seaward * w; beachWSum += (seg.style === 'beach' ? 1 : 0) * w;
  }
  if (!wsum) return { seaward: -9999, beachW: 1 };
  return { seaward: seawardSum / wsum, beachW: beachWSum / wsum };
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
  const bump1 = field.isWater[i1] ? 0 : terrainBump(hex1.terrain, x, z, field.seed[i1], centers[i1].cx, centers[i1].cz);
  const bump2 = field.isWater[i2] ? 0 : terrainBump(hex2.terrain, x, z, field.seed[i2], centers[i2].cx, centers[i2].cz);
  const mixT = smoothstep(-HEX_BLEND, HEX_BLEND, d2 - d1); // 1: hex1が優勢
  const bump = lerp(bump2, bump1, mixT);
  const landH = LAND_BASE + bump;

  const shore = shoreSigned(field, x, z);
  const inward = -shore.seaward + coastNoise(x, z) * COAST_JITTER; // +:陸側 -:海側
  const coastTarget = lerp(-8, SHELF, shore.beachW); // 岩(cliff)〜浜(beach)を連続に混ぜる(岬でのギザギザ対策)

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
    beachW: shore.beachW, coastT: clampUnit(1 - inward / COAST_BAND), // 0:内陸 1:渚(砂/岩のブレンドの強さ)
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
// 陸地材質(1枚のシェーダで全地形をまかなう)。③の直し: 地形の色は「CC0テクスチャの色×tint」をやめ、
// 実際の空撮写真から拾った地形ごとの色(線形空間のアルベド)を土台にし、テクスチャは平均色で割った
// 「濃淡の比」としてだけ掛ける(麦畑の元テクスチャが暗い土なので、tintを掛けても茶色にしかならなかった)。
// そのうえで、麦畑の短冊・あぜ道・畝とトラクターの轍、丘の段々の掘削跡、山のがれ場・崖・雪、
// 砂漠の風紋をマスごとの座標系で描く。マスごとの情報(中心・地形id・水か・畑の向き・種)は
// updateLandHexUniforms()が書き込む。
// 最寄り2マスの地形idとブレンド具合は、頂点グリッドの粗さに縛られないよう毎ピクセル求める。
// ================================================================
const HEX_BLEND_COLOR = 4.5; // 地形の色を混ぜる幅(起伏を混ぜる幅HEX_BLENDより狭くして区画をはっきりさせる)
function buildLandMaterial() {
  const sets = TERRAIN_NAMES.map((n) => terrainTextures(n));
  sets.forEach((tx) => { tx.map.repeat.set(1, 1); });
  const sharedNormal = sets[1].normalMap; // pastureの法線を共有(リピートは細かめ)
  sharedNormal.repeat.set(5, 5);
  const mat = new THREE.MeshStandardMaterial({ normalMap: sharedNormal, roughness: 1, metalness: 0 });
  mat.envMapIntensity = 0.6; // 浅い角度で空の青が映り込んで地面が青紫に転ぶのを抑える
  // 法線マップは細かい凹凸の手ざわりだけに弱める(強いと低い太陽で地面全体が紙を丸めたようなしわに見えた)
  mat.normalScale.set(0.3, 0.3);
  landUniforms = {
    uHexXZ: { value: Array.from({ length: MAX_LAND_HEXES }, () => new THREE.Vector2(1e6, 1e6)) },
    uHexInfo: { value: Array.from({ length: MAX_LAND_HEXES }, () => new THREE.Vector4(1, 1, 0, 0)) }, // 地形id, 水か, 畑の向き, 種
    uHexN: { value: 0 },
    uTime: { value: 0 },
  };
  const texSwitch = (body) => TERRAIN_NAMES.map((_, i) => `${i ? 'else ' : ''}if (id == ${i}) { ${body.replaceAll('TEX', 'uTex' + i)} }`).join('\n          ');
  mat.onBeforeCompile = (shader) => {
    TERRAIN_NAMES.forEach((_, i) => { shader.uniforms['uTex' + i] = { value: sets[i].map }; });
    Object.assign(shader.uniforms, landUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float slope; attribute float coastW;
        varying float vSlope; varying float vCoastW; varying float vWorldY;
        varying vec2 vTerrainUv; varying vec2 vWorldXZ;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vSlope = slope; vCoastW = coastW; vTerrainUv = uv;
        vec4 landWorld = modelMatrix * vec4(transformed, 1.0);
        vWorldXZ = landWorld.xz; vWorldY = landWorld.y;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vSlope; varying float vCoastW; varying float vWorldY;
        varying vec2 vTerrainUv; varying vec2 vWorldXZ;
        uniform vec2 uHexXZ[${MAX_LAND_HEXES}]; uniform vec4 uHexInfo[${MAX_LAND_HEXES}]; uniform int uHexN; uniform float uTime;
        ${TERRAIN_NAMES.map((_, i) => `uniform sampler2D uTex${i};`).join('\n        ')}
        ${CLOUD_GLSL}
        float h21(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        float fbm2(vec2 p) { return cloudNoise(p) * 0.55 + cloudNoise(p * 2.03 + 7.1) * 0.3 + cloudNoise(p * 4.1 + 3.3) * 0.15; }
        // 細い線(dは線の中心からの距離、wは半幅)。画面上で線が1画素より細いときは、ちらつかないよう薄めて描く
        float aaLine(float d, float w) {
          float fw = max(fwidth(d), 1e-4);
          return (1.0 - smoothstep(w - fw * 0.5, w + fw * 0.5, d)) * clamp(2.0 * w / fw, 0.0, 1.0);
        }
        // 繰り返しの模様(周期per)が画面上で細かくなりすぎたら消す係数(モアレ対策)
        float aaFade(float coord, float per) { return 1.0 - smoothstep(0.25, 0.6, fwidth(coord) / per); }
        // テクスチャは「平均色に対する濃淡の比」だけを使う(色そのものは地形ごとのアルベドで決める)。
        // スケール違いの2層をノイズで混ぜて繰り返しを消す。
        // 元の写真テクスチャには地面の陰影が焼き込まれているので、大きく引き伸ばすと「丸めた紙のしわ」に見える。
        // 細かく繰り返して(空からは細かな粒にしか見えない大きさ)、比も弱めに掛ける。
        vec3 detailRatio(int id, vec2 uv0) {
          vec2 uv = uv0 * 2.6, uvB = uv0 * 0.9 + vec2(17.0, 31.0);
          float w = smoothstep(0.3, 0.7, cloudNoise(uv0 * 0.6));
          vec3 t = vec3(0.5), m = vec3(0.5);
          ${texSwitch('t = mix(texture(TEX, uv).rgb, texture(TEX, uvB).rgb, w); m = textureLod(TEX, vec2(0.5), 12.0).rgb;')}
          return clamp(pow(t / max(m, vec3(0.02)), vec3(0.42)), 0.45, 1.8);
        }
        // 岩肌(山。ほかの地形の急斜面にも使う): 灰色〜灰褐色、緩い所はがれ場、急な所は暗い崖、低い所に高山の草、高い所に雪
        vec3 rockColor(vec2 p, vec2 uv) {
          float m = fbm2(p * 0.02);
          vec3 col = mix(vec3(0.105, 0.10, 0.088), vec3(0.14, 0.122, 0.095), smoothstep(0.35, 0.75, m));
          float gentle = 1.0 - smoothstep(0.1, 0.32, vSlope);
          vec3 scree = vec3(0.23, 0.215, 0.185) * mix(0.75, 1.15, cloudNoise(p * 1.1));
          col = mix(col, scree, gentle * smoothstep(0.3, 0.6, cloudNoise(p * 0.035 + 4.0)));
          float cliff = smoothstep(0.3, 0.55, vSlope);
          vec3 cliffC = vec3(0.065, 0.062, 0.058) * (0.7 + 0.6 * cloudNoise(p * 0.12 + vec2(0.0, vWorldY * 0.15)));
          col = mix(col, cliffC, cliff * 0.85);
          vec3 rd = detailRatio(${ROCK_ID}, uv); col *= rd * rd; // 岩は濃淡を強めに(ひび・層の手ざわり)
          float low = 1.0 - smoothstep(${(LAND_BASE + 7).toFixed(1)}, ${(LAND_BASE + 20).toFixed(1)}, vWorldY);
          col = mix(col, vec3(0.085, 0.11, 0.04) * detailRatio(1, uv), low * gentle * smoothstep(0.3, 0.55, cloudNoise(p * 0.05)));
          float snowLine = 64.0 + (cloudNoise(p * 0.04) - 0.5) * 8.0;
          float snow = smoothstep(snowLine, snowLine + 2.5, vWorldY) * (1.0 - smoothstep(0.42, 0.62, vSlope));
          col = mix(col, vec3(0.78, 0.8, 0.84) * mix(0.9, 1.05, cloudNoise(p * 0.3)), snow);
          return col;
        }
        // 麦畑: マスごとに決めた向きの短冊を4〜6枚。短冊ごと(一部は途中で区切る)に麦の色を変え、
        // 間に草のあぜ道、短冊の向きに畝の筋とトラクターの轍(2本1組の線)を引き、風で明るさがそよぐ。
        vec3 fieldColor(vec2 p, vec2 c, vec4 info, vec2 uv) {
          vec2 dir = vec2(cos(info.z), sin(info.z)), nrm = vec2(-dir.y, dir.x);
          vec2 q = p - c; float u = dot(q, dir), v = dot(q, nrm);
          const float W = 23.0;
          float sv = v / W + info.w, si = floor(sv), fv = fract(sv);
          float cut = (h21(vec2(si, info.w * 13.0)) - 0.5) * 80.0;
          float ui = u > cut ? 1.0 : 0.0;
          float fid = h21(vec2(si * 1.7 + ui * 9.3, info.w * 31.0 + 2.0));
          vec3 col;
          if (fid < 0.32) col = vec3(0.50, 0.34, 0.10);       // 熟した麦の金色
          else if (fid < 0.56) col = vec3(0.56, 0.41, 0.15);  // 明るい麦わら色
          else if (fid < 0.76) col = vec3(0.40, 0.24, 0.07);  // 黄土色
          else if (fid < 0.9) col = vec3(0.30, 0.29, 0.10);   // まだ青みの残る麦
          else col = vec3(0.20, 0.13, 0.065);                  // 刈り取って耕した畑
          float plough = step(0.9, fid);
          col *= mix(0.88, 1.08, fbm2(p * 0.045 + fid * 40.0));
          float tram = abs(fract(v / 8.0 + fid * 3.0) - 0.5) * 8.0;
          col *= 1.0 - 0.38 * aaLine(abs(tram - 0.5), 0.2) * (1.0 - plough);
          col *= 1.0 + sin(v * 6.2832 / 1.3) * mix(0.07, 0.18, plough) * aaFade(v, 1.3);
          col *= 1.0 + sin(uTime * 1.3 + dot(p, vec2(0.05, 0.035))) * 0.03 * (1.0 - plough);
          col *= mix(vec3(1.0), detailRatio(2, uv), 0.3);
          float lane = min(min(fv, 1.0 - fv) * W, abs(u - cut));
          col = mix(col, vec3(0.11, 0.135, 0.045) * detailRatio(1, uv), 1.0 - smoothstep(0.7, 1.4, lane));
          return col;
        }
        // 丘(赤茶の粘土の採掘場): 同心円の段(地形の高さと同じ式)。段の面は粘土の色を段ごとに変え、
        // 段の切り立った面は明るい橙に地層の縞、段の付け根に陰。外周の掘っていない縁は草と低木。
        vec3 hillsColor(vec2 p, vec2 c, vec4 info, vec2 uv) {
          vec2 q = p - c; float a = atan(q.y, q.x);
          float r = length(q) + sin(a * 2.0 + info.w * 6.2832) * 4.5 + sin(a * 3.0 + info.w * 12.0) * 3.0 + sin(a * 7.0 + info.w * 20.0) * 1.2;
          float rf = clamp(r / ${(SCALE * 0.62).toFixed(2)}, 0.0, 1.0) * 3.4;
          float ring = floor(rf), fr = fract(rf);
          vec3 col = ring < 0.5 ? vec3(0.40, 0.17, 0.065) : (mod(ring, 2.0) < 0.5 ? vec3(0.34, 0.125, 0.045) : vec3(0.42, 0.18, 0.06));
          col *= mix(0.85, 1.1, fbm2(p * 0.06 + 3.0));
          col *= 1.0 + sin(r * 2.4) * 0.05 * aaFade(r, 2.6); // 重機の走った跡(段に沿う筋)
          vec3 face = vec3(0.52, 0.25, 0.095) * (0.82 + 0.18 * sin(vWorldY * 5.0));
          col = mix(col, face, (1.0 - smoothstep(0.0, 0.09, fr)) * step(0.5, ring) * step(ring, 3.0));
          col *= 1.0 - 0.32 * smoothstep(0.86, 1.0, fr) * step(ring, 2.5);
          float rim = smoothstep(3.3, 3.4, rf);
          vec3 scrub = mix(vec3(0.12, 0.13, 0.05), vec3(0.30, 0.16, 0.08), smoothstep(0.35, 0.7, fbm2(p * 0.07)));
          col = mix(col, scrub * detailRatio(1, uv), rim);
          col *= detailRatio(3, uv);
          col = mix(col, face, smoothstep(${SLOPE_LO.toFixed(2)}, ${SLOPE_HI.toFixed(2)}, vSlope) * 0.6 * (1.0 - rim));
          return col;
        }
        // 砂漠: 明るい砂色。大きな砂丘の陰影は地形の起伏、細かな風紋と乾いた礫の斑はここで描く
        vec3 desertColor(vec2 p, vec2 uv) {
          vec3 col = mix(vec3(0.46, 0.29, 0.115), vec3(0.55, 0.37, 0.155), fbm2(p * 0.015));
          float rx = p.x * 0.921 - p.y * 0.389 + sin(p.y * 0.05) * 6.0 + sin(p.x * 0.031) * 4.0;
          col *= 1.0 + sin(rx * 6.2832 / 2.2) * 0.07 * aaFade(rx, 2.2);
          col *= 1.0 + sin(rx * 6.2832 / 8.0 + cloudNoise(p * 0.03) * 4.0) * 0.08;
          float grav = smoothstep(0.6, 0.72, fbm2(p * 0.028 + 5.0));
          col = mix(col, vec3(0.20, 0.155, 0.10) * (0.8 + 0.4 * cloudNoise(p * 1.5)), grav * 0.65);
          col *= mix(vec3(1.0), detailRatio(${SAND_ID}, uv), 0.6);
          return col;
        }
        vec3 terrainColor(int hi, vec2 uv, vec2 p) {
          vec4 info = uHexInfo[hi]; vec2 c = uHexXZ[hi];
          int id = int(info.x + 0.5);
          float macro = fbm2(p * 0.018), macro2 = cloudNoise(p * 0.06 + 11.0);
          vec3 col;
          if (id == 0) col = vec3(0.055, 0.075, 0.03) * detailRatio(1, uv) * mix(0.8, 1.2, macro); // 林床と林縁の草(林冠の下は陰で暗くなる)
          else if (id == 1) { // 牧草地: 青々とした所と少し乾いた所の斑
            col = mix(vec3(0.10, 0.17, 0.048), vec3(0.19, 0.21, 0.075), smoothstep(0.35, 0.8, macro));
            col *= mix(0.86, 1.1, macro2) * detailRatio(1, uv);
            // 放牧の区画ごとの違い(刈った所・伸びた所)。マスの向きにそろえた大きな四角の斑
            vec2 dq = p - c; vec2 pr = vec2(dot(dq, vec2(cos(info.z), sin(info.z))), dot(dq, vec2(-sin(info.z), cos(info.z))));
            float pad = h21(floor(pr / 34.0) + info.w * 17.0);
            col *= mix(vec3(0.9, 0.92, 0.95), vec3(1.12, 1.08, 0.92), pad);
          }
          else if (id == 2) col = fieldColor(p, c, info, uv);
          else if (id == 3) return hillsColor(p, c, info, uv);
          else if (id == ${ROCK_ID}) return rockColor(p, uv);
          else return desertColor(p, uv);
          return mix(col, rockColor(p, uv), smoothstep(${SLOPE_LO.toFixed(2)}, ${SLOPE_HI.toFixed(2)}, vSlope));
        }
        // 最寄り2マス(添字)・色のブレンド具合・2マスの境目(垂直二等分線)までの距離を毎ピクセル求める
        void nearestTwoHex(vec2 p, out int i1, out int i2, out float mixT, out float dB) {
          float d1 = 1e9, d2 = 1e9; i1 = 0; i2 = 0;
          for (int i = 0; i < ${MAX_LAND_HEXES}; i++) {
            if (i >= uHexN) break;
            float dd = distance(p, uHexXZ[i]);
            if (dd < d1) { d2 = d1; i2 = i1; d1 = dd; i1 = i; }
            else if (dd < d2) { d2 = dd; i2 = i; }
          }
          mixT = smoothstep(-${HEX_BLEND_COLOR.toFixed(1)}, ${HEX_BLEND_COLOR.toFixed(1)}, d2 - d1);
          dB = (d2 * d2 - d1 * d1) / (2.0 * max(distance(uHexXZ[i1], uHexXZ[i2]), 1.0));
        }`)
      .replace('#include <map_fragment>', `
        {
          vec2 uv = vTerrainUv;
          int i1, i2; float hMixT, dB;
          nearestTwoHex(vWorldXZ, i1, i2, hMixT, dB);
          bool w1 = uHexInfo[i1].y > 0.5, w2 = uHexInfo[i2].y > 0.5;
          if (w1 && !w2) { i1 = i2; hMixT = 1.0; } // 海のマスの側は、隣の陸の色を伸ばす(渚の色は下で砂に寄せる)
          vec3 col = terrainColor(i1, uv, vWorldXZ);
          if (hMixT < 0.999 && !w2) col = mix(terrainColor(i2, uv, vWorldXZ), col, hMixT);
          // 陸どうしの境目に沿う細い陰(生け垣・石垣の根もとの暗がり)。区画の形が遠目にも読めるように
          if (!w1 && !w2) col *= 1.0 - 0.28 * (1.0 - smoothstep(0.6, 2.2, dB));
          vec3 beach = mix(vec3(0.40, 0.32, 0.19), vec3(0.33, 0.26, 0.155), cloudNoise(vWorldXZ * 0.05)) * detailRatio(${SAND_ID}, uv);
          col = mix(col, beach, pow(vCoastW, 2.2) * (1.0 - smoothstep(0.2, 0.45, vSlope))); // 崖の海岸は砂にしない(岩肌のまま)
          col *= cloudShadow(vWorldXZ, uTime);
          diffuseColor.rgb *= col;
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
let cityStoneMaterial = null;
function getCityStoneMaterial() { if (!cityStoneMaterial) cityStoneMaterial = buildCityStoneMaterial(); return cityStoneMaterial; }

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
      coastW[k] = (!s.isWater) ? s.coastT * s.beachW : 0;
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

  terrainGrid = { minX, minZ, cell, nx, nz, pos }; // groundY()が描いた面そのものの高さを引けるように
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
    uShallow: { value: new THREE.Color(0x3fe3b0) }, // 浅瀬エメラルド(少し鮮やかに)
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
          float depthT = smoothstep(0.0, 15.0, depth);
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
    const sd = field.seed[i];
    landUniforms.uHexInfo.value[i].set(terrainIdOf(field.hexes[i].terrain), field.isWater[i] ? 1 : 0,
      ((sd * 7) % 1000) / 1000 * Math.PI, hexSeedW(sd)); // 地形id, 水か, 麦畑の短冊の向き, 種(丘の段の揺らぎ)
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
// 細かい小物(石垣・農道・羊)が面に埋もれたり浮いたりしないよう、計算上の高さではなく、実際に描いている
// 三角形(buildTerrainMeshの格子。対角線はb-c)の上の高さを返す。格子の外は計算上の高さ。
function groundY(x, z, fallback) {
  const G = terrainGrid;
  if (G) {
    const gx = (x - G.minX) / G.cell, gz = (z - G.minZ) / G.cell;
    const i = Math.floor(gx), j = Math.floor(gz);
    if (i >= 0 && j >= 0 && i < G.nx - 1 && j < G.nz - 1) {
      const fx = gx - i, fz = gz - j, hAt = (ii, jj) => G.pos[((jj * G.nx) + ii) * 3 + 1];
      const ha = hAt(i, j), hb = hAt(i + 1, j), hc = hAt(i, j + 1), hd = hAt(i + 1, j + 1);
      return fx + fz <= 1 ? ha + (hb - ha) * fx + (hc - ha) * fz : hd + (hc - hd) * (1 - fx) + (hb - hd) * (1 - fz);
    }
  }
  return terrainField ? sampleTerrain(terrainField, x, z).height : fallback;
}

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

  // 植生と小物(木・羊・石垣・窯など、数千〜数万個)は盤の形(と霧の晴れ具合)が変わったときだけ作り直す。
  // 毎回作り直すと、1本ごとに地形の高さを引くぶん再描画が重くなるため。
  // 都市(城壁)は植生をCITY_CLEARまで広く空けるので、開拓地→都市の昇格でも植生を作り直す
  const citySig = g.vertices.map((v) => (v.building && v.building.type === 'city') ? '1' : '0').join('');
  const vSig = sig + '|' + g.hexes.map((h) => (h.fog ? 1 : 0)).join('') + '|' + citySig;
  if (vSig !== vegSignature) { vegSignature = vSig; rebuildVegetation(g); }

  g.hexes.forEach((hex) => {
    const [cx, cz] = hexCenterOf(g, hex);
    const height = baseYOfHex(hex);
    const R = SCALE * 0.6;
    const terrain = hex.fog ? 'fog' : hex.terrain;
    if (terrain === 'castle') {
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

  // 道・船・建物(④)。路面・壁・旗など数が増えるもの(拡張で頂点・辺が増える)はB(バッチ)にためて
  // まとめてinstancedMeshにする(増えても描画コストがほぼ変わらない)。都市の城壁・教会など1つしかない
  // 大物だけ個別のMeshのまま(addShip/addKnight/buildCity内の壁・塔・教会)。
  const B = {
    roadTile: [], roadRut: [], roadsideBush: [], signPost: [], banner: [],
    plinth: [], wall: [], shutter: [], awning: [], eave: [], roofTile: [], roofThatch: [], chimney: [],
    flagPole: [], flagCloth: [], crenel: [], towerWindow: [],
  };
  g.edges.forEach((edge) => {
    const v1 = g.vertices[edge.v1], v2 = g.vertices[edge.v2];
    const x1 = v1.x * SCALE, z1 = v1.y * SCALE, x2 = v2.x * SCALE, z2 = v2.y * SCALE;
    const mx = (x1 + x2) / 2, mz = (z1 + z2) / 2;
    const ang = -Math.atan2(z2 - z1, x2 - x1);
    const baseY = baseYOfHex(firstHexAt(g, edge.hexIds));
    if (edge.ship != null) {
      addShip(mx, mz, ang, game.players[edge.ship].color);
    } else if (edge.road != null) {
      buildRoad(B, x1, z1, x2, z2, baseY, clothColor(game.players[edge.road].color), edge.id, ang);
    }
  });

  // 頂点: 建物(開拓地・都市)
  g.vertices.forEach((v) => {
    if (!v.building) return;
    const x = v.x * SCALE, z = v.y * SCALE;
    const baseY = baseYOfHex(firstHexAt(g, v.hexIds));
    const cloth = clothColor(game.players[v.building.owner].color);
    if (v.building.type === 'city') buildCity(B, g, v, x, z, baseY, cloth);
    else buildSettlement(B, g, v, x, z, baseY, cloth);
  });
  [
    instancedFrom(GEO.roadTile, MAT.roadStone, B.roadTile),
    instancedFrom(GEO.roadRut, MAT.roadRut, B.roadRut),
    instancedFrom(GEO.bush, MAT.bush, B.roadsideBush, 0.04),
    instancedFrom(GEO.roadPost, MAT.signPost, B.signPost),
    instancedFrom(GEO.roadBanner, MAT.cloth, B.banner),
    instancedFrom(GEO.housePlinth, MAT.housePlinth, B.plinth, 0.03),
    instancedFrom(GEO.houseWall, MAT.houseWall, B.wall, 0.05), // 持ち主色なし。seedでvariance(白〜生成り〜灰)だけ付く
    instancedFrom(GEO.houseShutters, MAT.houseShutter, B.shutter),
    instancedFrom(GEO.houseAwning, MAT.cloth, B.awning),
    instancedFrom(GEO.houseEave, MAT.eaveTrim, B.eave),
    instancedFrom(GEO.houseRoofTile, MAT.roofTile, B.roofTile, 0.02),
    instancedFrom(GEO.houseRoofThatch, MAT.roofThatch, B.roofThatch, 0.03),
    instancedFrom(GEO.houseChimney, MAT.chimney, B.chimney),
    instancedFrom(GEO.flagPole, MAT.signPost, B.flagPole),
    instancedFrom(GEO.flagCloth, MAT.cloth, B.flagCloth),
    instancedFrom(GEO.cityCrenel, getCityStoneMaterial(), B.crenel, 0.02),
    instancedFrom(GEO.towerWindow, MAT.towerWindow, B.towerWindow),
  ].forEach((m) => { if (m) sceneGroup.add(m); });

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
    if (o.isInstancedMesh) o.dispose(); // インスタンスの行列・色のバッファ(ジオメトリは共有なので残す)
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
    controls.minDistance = Math.max(45, maxR * 0.15); // ④の直し: 集落1つに寄れる近さまでズームできるようにする
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

// ================================================================
// 植生と小物(③)。縮尺は実物(1単位≒2.5m)。マス全体を地形らしく埋め、空けるのは数字の石碑のまわりの
// 小さな空き地と、頂点(建物の場所)・辺(道の場所)の細い帯だけ。どれもマスごとに固定の乱数で置く。
// ================================================================
// 点(x,z)から六角(pts=角の座標)の辺までの最短距離(内側が正)。森の縁・小物の配置で「区画の内側か」を見る。
function hexInset(x, z, pts, cx, cz) {
  let m = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[(i + 1) % pts.length];
    let nx = -(bz - az), nz = bx - ax;
    const len = Math.hypot(nx, nz) || 1; nx /= len; nz /= len;
    if ((cx - ax) * nx + (cz - az) * nz < 0) { nx = -nx; nz = -nz; }
    m = Math.min(m, (x - ax) * nx + (z - az) * nz);
  }
  return m;
}
// 地面の傾き(0=平ら)。山の木の限界などに使う(数か所だけなので差分で求める)
function groundSlope(x, z, h) {
  const e = 2;
  const hx = groundY(x + e, z, h) - groundY(x - e, z, h), hz = groundY(x, z + e, h) - groundY(x, z - e, h);
  return 1 - 1 / Math.sqrt(1 + (hx * hx + hz * hz) / (4 * e * e));
}
// 木を1本ぶん足す(針葉樹か広葉樹)。林冠は地面から生やす(幹は空からはほぼ見えないので作らない)
function pushTree(V, x, z, y, s, conif, seed) {
  if (conif) V.con.push({ x, y: y + 2.4 * s, z, s, ry: (seed % 628) / 100, seed });
  else V.broad.push({ x, y: y + 1.9 * s, z, s, ry: (seed % 628) / 100, seed });
}
// 線分(ax,az)-(bx,bz)に沿って、間隔stepで点を返す(区切りごとに地面の高さを取り直すため)
function alongSeg(ax, az, bx, bz, step) {
  const len = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(len / step)), out = [];
  for (let i = 0; i < n; i++) { const t = (i + 0.5) / n; out.push([ax + (bx - ax) * t, az + (bz - az) * t]); }
  return out;
}
const CLEAR_R = 19; // 数字の石碑(半径15)のまわりの空き地
const VERTEX_CLEAR = 15; // 頂点(開拓地・都市・置ける場所の印)のまわり。④で集落の半径を広げたぶん合わせて広げた
const EDGE_CLEAR = 7.2; // 辺(道。幅12.5)からこれだけ内側までは背の高いものを置かない。④で道幅を広げたぶん合わせて広げた
const CITY_CLEAR = 18; // 都市(城壁)は開拓地より大きいので、実際に都市が建っている頂点だけこの半径まで空ける

function rebuildVegetation(g) {
  if (vegGroup) { disposeGroup(vegGroup); scene.remove(vegGroup); }
  vegGroup = new THREE.Group();
  scene.add(vegGroup);
  // 都市(城壁)が建っている頂点は、開拓地より広く空ける(CITY_CLEARまで)。他の頂点はいつもどおりVERTEX_CLEAR。
  const cityVerts = new Set();
  g.vertices.forEach((v) => { if (v.building && v.building.type === 'city') cityVerts.add(v.id); });
  const V = { con: [], broad: [], bush: [], sheep: [], rock: [], brick: [], scree: [], dryGrass: [], desertRock: [], nugget: [], wall: [], path: [], stream: [] };
  g.hexes.forEach((hex) => {
    const terrain = hex.fog ? 'fog' : hex.terrain;
    if (WATER_LIKE.has(terrain)) return;
    const [cx, cz] = hexCenterOf(g, hex);
    const height = baseYOfHex(hex);
    const pts = hexPointsOf(g, hex);
    const vids = hex.vertexIds;
    const rr = hexRng(hex.id * 7919 + 13);
    const nearVertex = (x, z, r) => pts.some(([vx, vz], i) => Math.hypot(x - vx, z - vz) < (cityVerts.has(vids[i]) ? Math.max(r, CITY_CLEAR) : r));
    // マスの内側の、空き地・頂点・辺を避けた点をn個ほど選ぶ(足りなければそこまで)
    const scatter = (n, minR, inset, fn) => {
      for (let i = 0, tries = 0; i < n && tries < n * 6; tries++) {
        const x = cx + rr(-HEX_R, HEX_R), z = cz + rr(-HEX_R, HEX_R);
        if (hexInset(x, z, pts, cx, cz) < inset || Math.hypot(x - cx, z - cz) < minR || nearVertex(x, z, VERTEX_CLEAR)) continue;
        fn(x, z, groundY(x, z, height), i++);
      }
    };
    if (terrain === 'forest') {
      // 区画いっぱいの林冠。格子+ジッターで隙間なく敷き、縁はノイズで少し不規則に。針葉樹と広葉樹は
      // 大きなノイズで「まとまり」ごとに入れ替わる(実際の混交林のように群れで変わる)。ところどころ小さな林間の空き地。
      const step = 2.7 / Math.sqrt(FOREST_DENSITY);
      let i = 0;
      for (let gx = -HEX_R; gx <= HEX_R; gx += step) {
        for (let gz = -HEX_R; gz <= HEX_R; gz += step) {
          const x = cx + gx + rr(-0.45, 0.45) * step, z = cz + gz + rr(-0.45, 0.45) * step;
          const edgeN = valueNoise2(x * 0.09, z * 0.09, 77) * 2.2 + valueNoise2(x * 0.31, z * 0.31, 78) * 0.9;
          if (hexInset(x, z, pts, cx, cz) < EDGE_CLEAR + Math.abs(edgeN)) continue; // 置ける辺の印(幅11)より外に木を出さない
          if (Math.hypot(x - cx, z - cz) < CLEAR_R + valueNoise2(x * 0.15, z * 0.15, 79) * 2.5) continue;
          if (nearVertex(x, z, VERTEX_CLEAR + edgeN)) continue;
          if (valueNoise2(x * 0.05, z * 0.05, hex.id + 80) < -0.6) continue;
          const conif = valueNoise2(x * 0.022, z * 0.022, hex.id + 3) + rr(-0.3, 0.3) > -0.15;
          const s = rr(0.75, 1.2) * (1 + valueNoise2(x * 0.04, z * 0.04, 81) * 0.2);
          pushTree(V, x, z, groundY(x, z, height), s, conif, hex.id * 9973 + i++);
        }
      }
    } else if (terrain === 'pasture') {
      // 起伏のある草地: 羊の群れ(白い点々が固まる)+はぐれた羊、区画の中を仕切る石垣か木の柵、
      // ぽつんと立つ大きな木と低木の茂み、ところどころの石
      const flocks = Math.round(rr(3, 5));
      for (let f = 0; f < flocks; f++) {
        const a = rr(0, Math.PI * 2), r = rr(CLEAR_R + 6, HEX_A * 0.75);
        const fx = cx + Math.cos(a) * r, fz = cz + Math.sin(a) * r;
        const n = Math.round(rr(12, 26) * Math.sqrt(DENSITY));
        for (let i = 0; i < n; i++) {
          const x = fx + (rr(-1, 1) + rr(-1, 1)) * 5, z = fz + (rr(-1, 1) + rr(-1, 1)) * 5;
          if (hexInset(x, z, pts, cx, cz) < 2.5 || Math.hypot(x - cx, z - cz) < CLEAR_R - 2) continue;
          const y = groundY(x, z, height);
          V.sheep.push({ x, y: y + 0.3, z, s: rr(0.85, 1.1), ry: rr(0, Math.PI * 2), seed: hex.id * 6151 + f * 100 + i });
        }
      }
      scatter(Math.round(10 * Math.sqrt(DENSITY)), CLEAR_R - 2, 2.5, (x, z, y, i) => V.sheep.push({ x, y: y + 0.3, z, s: rr(0.85, 1.1), ry: rr(0, 6), seed: hex.id * 7 + i }));
      // 区画を仕切る1〜2本の弦(石垣)。マス中心の空き地・頂点・辺のそばは途切れさせる
      const walls = Math.round(rr(1, 2.4));
      for (let w = 0; w < walls; w++) {
        const a = rr(0, Math.PI), off = rr(CLEAR_R + 4, HEX_A * 0.7) * (rr(0, 1) < 0.5 ? -1 : 1);
        const dx = Math.cos(a), dz = Math.sin(a), ox = cx - dz * off, oz = cz + dx * off;
        const fence = rr(0, 1) < 0.35;
        alongSeg(ox - dx * HEX_R, oz - dz * HEX_R, ox + dx * HEX_R, oz + dz * HEX_R, fence ? 2.2 : 1.05).forEach(([x, z]) => {
          if (hexInset(x, z, pts, cx, cz) < 3 || nearVertex(x, z, VERTEX_CLEAR)) return;
          if (fence) addFencePost(V, x, z, groundY(x, z, height), a);
          else V.wall.push({ x, y: groundY(x, z, height) + 0.25, z, ry: -a, seed: hex.id * 31 + Math.round(x * 7) });
        });
      }
      scatter(Math.round(rr(5, 9)), CLEAR_R + 2, EDGE_CLEAR + 2, (x, z, y, i) => pushTree(V, x, z, y, rr(1.1, 1.5), false, hex.id * 401 + i));
      scatter(Math.round(rr(6, 12) * Math.sqrt(DENSITY)), CLEAR_R, 3, (x, z, y, i) => V.bush.push({ x, y: y + 0.3, z, s: rr(0.5, 0.9), ry: rr(0, 6), seed: hex.id * 13 + i }));
      scatter(Math.round(rr(6, 12) * DENSITY), CLEAR_R, 2, (x, z, y, i) => V.rock.push({ x, y: y + 0.1, z, s: rr(0.6, 1.3), ry: rr(0, 6), seed: hex.id * 311 + i }));
    } else if (terrain === 'field') {
      // 麦畑の短冊・あぜ道・畝は地面のシェーダ(fieldColor)が描く。ここでは畑の隅に低木を少しだけ
      scatter(Math.round(rr(3, 6)), CLEAR_R + 4, 2, (x, z, y, i) => V.bush.push({ x, y: y + 0.4, z, s: rr(0.8, 1.3), ry: rr(0, 6), seed: hex.id * 17 + i }));
    } else if (terrain === 'hills') {
      // 赤茶の粘土の採掘場: 段々(地形の高さ+シェーダ)、段の上のレンガ置き場(パレットの列)、
      // 外周の縁に輪窯の建屋と煙突(煙)、縁の低木
      const yards = 2;
      for (let y2 = 0; y2 < yards; y2++) {
        const a = rr(0, Math.PI * 2) + y2 * Math.PI, r = SCALE * 0.62 * (2.5 / 3.4); // 外側から2段目の段の上
        const px = cx + Math.cos(a) * r, pz = cz + Math.sin(a) * r;
        const tx = -Math.sin(a), tz = Math.cos(a), nx = Math.cos(a), nz = Math.sin(a);
        for (let row = 0; row < 3; row++) {
          for (let col = 0; col < 7; col++) {
            if (rr(0, 1) < 0.15) continue; // 運び出された跡の空き
            const ox = (col - 3) * 1.8, oz = (row - 1) * 1.8;
            const x = px + tx * ox + nx * oz, z = pz + tz * ox + nz * oz;
            if (hexInset(x, z, pts, cx, cz) < 3) continue;
            V.brick.push({ x, y: groundY(x, z, height) + 0.5, z, ry: -a, s: rr(0.85, 1.05), seed: hex.id * 71 + y2 * 40 + row * 8 + col });
          }
        }
      }
      const ka = rr(0, Math.PI * 2), kr = SCALE * 0.66;
      addKiln(cx + Math.cos(ka) * kr, cz + Math.sin(ka) * kr, height, ka, rr);
      scatter(Math.round(rr(30, 50) * Math.sqrt(DENSITY)), SCALE * 0.64, 3, (x, z, y, i) => V.bush.push({ x, y: y + 0.35, z, s: rr(0.6, 1.1), ry: rr(0, 6), seed: hex.id * 19 + i }));
      scatter(Math.round(rr(8, 14) * DENSITY), CLEAR_R, 2, (x, z, y, i) => V.scree.push({ x, y, z, s: rr(0.5, 1.0), ry: rr(0, 6), seed: hex.id * 211 + i }));
    } else if (terrain === 'mountains') {
      // 岩山: 岩肌・がれ場・崖・雪は地面のシェーダ(rockColor)。低く緩い裾にだけ針葉樹(森林限界)、
      // 斜面のところどころに岩、中腹に鉱山の入口とトロッコの線路
      const step = 3.4 / Math.sqrt(FOREST_DENSITY);
      let i = 0;
      for (let gx = -HEX_R; gx <= HEX_R; gx += step) {
        for (let gz = -HEX_R; gz <= HEX_R; gz += step) {
          const x = cx + gx + rr(-0.45, 0.45) * step, z = cz + gz + rr(-0.45, 0.45) * step;
          if (hexInset(x, z, pts, cx, cz) < EDGE_CLEAR + 1 || nearVertex(x, z, VERTEX_CLEAR)) continue;
          const y = groundY(x, z, height);
          if (y > LAND_BASE + 13 + valueNoise2(x * 0.06, z * 0.06, 90) * 5) continue;
          if (valueNoise2(x * 0.07, z * 0.07, hex.id + 91) < -0.1 || groundSlope(x, z, height) > 0.3) continue;
          pushTree(V, x, z, y, rr(0.7, 1.05), true, hex.id * 3301 + i++);
        }
      }
      scatter(Math.round(rr(25, 45) * DENSITY), CLEAR_R, 2, (x, z, y, k) => V.scree.push({ x, y, z, s: rr(0.5, 1.3), ry: rr(0, 6), seed: hex.id * 401 + k }));
      addMineAndRail(cx, cz, height, SCALE * 0.6, rr);
    } else if (terrain === 'desert') {
      // 風紋の砂丘(地形の起伏+シェーダ)、乾いた岩のかたまり、まばらな枯れ草。サボテンは置かない。
      const clusters = Math.round(rr(3, 6));
      for (let c = 0; c < clusters; c++) {
        const a = rr(0, Math.PI * 2), r = rr(CLEAR_R + 4, HEX_A * 0.8);
        const ox = cx + Math.cos(a) * r, oz = cz + Math.sin(a) * r;
        const n = Math.round(rr(3, 9));
        for (let i = 0; i < n; i++) {
          const x = ox + rr(-4, 4), z = oz + rr(-4, 4);
          if (hexInset(x, z, pts, cx, cz) < 2 || nearVertex(x, z, VERTEX_CLEAR)) continue;
          V.desertRock.push({ x, y: groundY(x, z, height), z, s: rr(0.6, 2.0) * (i === 0 ? 1.4 : 1), ry: rr(0, 6), seed: hex.id * 131 + c * 20 + i });
        }
      }
      scatter(Math.round(rr(140, 220) * Math.sqrt(DENSITY)), CLEAR_R - 2, 1.5, (x, z, y, i) => V.dryGrass.push({ x, y: y + 0.08, z, s: rr(0.6, 1.3), ry: rr(0, 6), seed: hex.id * 151 + i }));
    } else if (terrain === 'gold') {
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + rr(-0.2, 0.2), r = rr(SCALE * 0.18, SCALE * 0.4);
        V.nugget.push({ x: cx + Math.cos(a) * r, y: height + 2.5, z: cz + Math.sin(a) * r, s: rr(0.8, 1.2), ry: rr(0, 6) });
      }
    }
  });
  buildHexBoundaries(g, V, cityVerts);
  [
    instancedFrom(GEO.conCanopy, MAT.conLeaf, V.con, 0.035),
    instancedFrom(GEO.broadCanopy, MAT.broadLeaf, V.broad, 0.05),
    instancedFrom(GEO.bush, MAT.bush, V.bush, 0.04),
    instancedFrom(GEO.sheepBody, MAT.sheep, V.sheep, 0.01),
    instancedFrom(GEO.fieldRock, MAT.fieldRock, V.rock, 0.02),
    instancedFrom(GEO.brickStack, MAT.brick, V.brick, 0.02),
    instancedFrom(GEO.scree, MAT.scree, V.scree, 0.03),
    instancedFrom(GEO.dryGrass, MAT.dryGrass, V.dryGrass, 0.04),
    instancedFrom(GEO.desertRock, MAT.desertRock, V.desertRock, 0.03),
    instancedFrom(GEO.nugget, MAT.gold, V.nugget),
    instancedFrom(GEO.wallStone, MAT.wallStone, V.wall, 0.02),
    instancedFrom(GEO.pathTile, MAT.path, V.path, 0.01),
    instancedFrom(GEO.streamTile, MAT.stream, V.stream),
  ].forEach((m) => { if (m) vegGroup.add(m); });
  if (V.fencePosts && V.fencePosts.length) {
    vegGroup.add(instancedFrom(GEO.fencePost, MAT.fence, V.fencePosts));
    vegGroup.add(instancedFrom(GEO.fenceRail, MAT.fence, V.fenceRails));
  }
}
// 木の柵: 杭1本+横木2本(次の杭まで)。間隔2.2単位
function addFencePost(V, x, z, y, a) {
  (V.fencePosts ||= []).push({ x, y: y + 0.55, z, s: 1 });
  V.fenceRails ||= [];
  [0.45, 0.85].forEach((h) => V.fenceRails.push({ x, y: y + h, z, ry: -a, s: 2.2 }));
}

// 丘の採掘場の窯場: 細長い輪窯の建屋+切妻屋根+背の高い煙突、煙突の先から風下へ流れる薄い煙
function addKiln(x, z, height, ang, rr) {
  const y = groundY(x, z, height);
  const ry = -ang + Math.PI / 2; // 建屋の長い辺を段の円周に沿わせる
  const hall = new THREE.Mesh(GEO.kilnHall, MAT.kiln);
  hall.position.set(x, y + 1.1, z); hall.rotation.y = ry;
  const roof = new THREE.Mesh(GEO.kilnRoof, MAT.kilnRoof);
  roof.position.set(x, y + 2.75, z); roof.rotation.y = ry;
  const chimney = new THREE.Mesh(GEO.chimney, MAT.kiln);
  const chx = x + Math.cos(ang) * 3.2, chz = z + Math.sin(ang) * 3.2;
  chimney.position.set(chx, y + 5, chz);
  [hall, roof, chimney].forEach((m) => { m.castShadow = true; m.receiveShadow = true; vegGroup.add(m); });
  for (let i = 0; i < 6; i++) {
    const puff = new THREE.Mesh(GEO.smoke, MAT.smoke.clone());
    puff.material.opacity = 0.34 - i * 0.045;
    puff.scale.setScalar(0.9 + i * 0.7);
    puff.position.set(chx + i * 1.6 + rr(-0.4, 0.4), y + 10.5 + i * 1.1, chz - i * 0.9 + rr(-0.4, 0.4));
    vegGroup.add(puff);
  }
}
// 山の中腹: 鉱山の入口(木枠+暗い穴)とそこから延びるトロッコの線路(2本のレール+枕木)
function addMineAndRail(cx, cz, height, R, rr) {
  const a = rr(0, Math.PI * 2);
  const ex = cx + Math.cos(a) * R * 0.55, ez = cz + Math.sin(a) * R * 0.55;
  const ey = groundY(ex, ez, height);
  const facing = a + Math.PI; // 斜面の外側を向く
  const frame = new THREE.Mesh(GEO.mineFrame, MAT.mineFrame);
  frame.position.set(ex, ey + 1.2, ez);
  frame.rotation.y = facing;
  const hole = new THREE.Mesh(GEO.mineHole, MAT.mineHole);
  hole.position.set(ex + Math.cos(facing) * 0.65, ey + 1.0, ez + Math.sin(facing) * 0.65);
  hole.rotation.y = facing;
  frame.castShadow = true;
  vegGroup.add(frame, hole);
  const dirx = Math.cos(a), dirz = Math.sin(a); // 線路は斜面を下る向き(入口から外へ)
  const railLen = R * 0.5;
  const ties = Math.round(railLen / 1.6);
  const tieItems = [], railItems = [];
  for (let i = 0; i < ties; i++) {
    const t = (i + 0.5) / ties * railLen;
    const x = ex + dirx * t, z = ez + dirz * t, y = groundY(x, z, height);
    tieItems.push({ x, y: y + 0.1, z, ry: -a + Math.PI / 2, s: 1 });
    [-0.45, 0.45].forEach((off) => railItems.push({ x: x - dirz * off, y: y + 0.2, z: z + dirx * off, ry: -a, s: 1.6 }));
  }
  [instancedFrom(GEO.tie, MAT.tie, tieItems), instancedFrom(GEO.rail, MAT.rail, railItems)].forEach((m) => { if (m) vegGroup.add(m); });
}
// マスの境目(陸どうしの辺)を、隣り合う地形の組み合わせに合った縁取りで描く。海に面した辺(渚)は描かない。
// 生け垣(低木の列。辺の上に背の高い木は置かない)・石垣・土の農道・細い小川。森の縁は林冠そのものが縁なので、
// 林の外に農道を沿わせる。頂点のすぐそば(建物・置ける場所の印)はVERTEX_CLEARぶん空ける(都市ならCITY_CLEAR)。
// 'path'(農道)は、実際に道(持ち主の石畳)が敷かれている辺では描かない(buildRoadの路面と二重になるため)。
function buildHexBoundaries(g, V, cityVerts) {
  g.edges.forEach((edge) => {
    const hexes = (edge.hexIds || []).map((id) => g.hexes[id]).filter(Boolean);
    if (hexes.length < 2) return; // 盤の外周(海)は描かない
    if (hexes.some((h) => WATER_LIKE.has(h.terrain) || h.fog)) return; // 本物の海岸線(渚)は描かない
    const style = boundaryStyle(hexes[0].terrain, hexes[1].terrain, edge.id);
    if (!style) return;
    if (style === 'path' && edge.road != null) return; // 実際の道(石畳)がそこの路面を描くので譲る
    const v1 = g.vertices[edge.v1], v2 = g.vertices[edge.v2];
    const x1 = v1.x * SCALE, z1 = v1.y * SCALE, x2 = v2.x * SCALE, z2 = v2.y * SCALE;
    const full = Math.hypot(x2 - x1, z2 - z1);
    const ux = (x2 - x1) / full, uz = (z2 - z1) / full;
    const m1 = cityVerts.has(v1.id) ? CITY_CLEAR : VERTEX_CLEAR - 2;
    const m2 = cityVerts.has(v2.id) ? CITY_CLEAR : VERTEX_CLEAR - 2;
    const ax = x1 + ux * m1, az = z1 + uz * m1, bx = x2 - ux * m2, bz = z2 - uz * m2;
    const ang = Math.atan2(uz, ux);
    const fy = baseYOfHex(hexes[0]);
    const rr = hexRng(edge.id * 613 + 1);
    if (style === 'hedge') {
      alongSeg(ax, az, bx, bz, 0.95).forEach(([x, z], i) => {
        const y = groundY(x, z, fy);
        V.bush.push({ x, y: y + 0.45, z, s: rr(0.8, 1.25), ry: rr(0, 6), seed: edge.id * 97 + i });
      });
    } else if (style === 'wall') {
      alongSeg(ax, az, bx, bz, 1.05).forEach(([x, z], i) => V.wall.push({ x, y: groundY(x, z, fy) + 0.3, z, ry: -ang, seed: edge.id * 53 + i }));
    } else if (style === 'path') {
      alongSeg(ax, az, bx, bz, 1.1).forEach(([x, z]) => V.path.push({ x, y: groundY(x, z, fy) + 0.06, z, ry: -ang }));
    } else if (style === 'stream') {
      alongSeg(ax, az, bx, bz, 1.1).forEach(([x, z], i) => {
        const w = Math.sin(i * 0.5 + edge.id) * 0.5; // わずかに蛇行
        const sx = x - uz * w, sz = z + ux * w;
        V.stream.push({ x: sx, y: groundY(sx, sz, fy) + 0.12, z: sz, ry: -ang });
        if (rr(0, 1) < 0.3) { const side = rr(0, 1) < 0.5 ? -1.6 : 1.6; V.bush.push({ x: sx - uz * side, y: groundY(sx, sz, fy) + 0.4, z: sz + ux * side, s: rr(0.7, 1.2), ry: rr(0, 6), seed: edge.id * 7 + i }); }
      });
    }
  });
}
// 地形の組み合わせごとの縁取りの種類。辺idで一部を振り分けて単調にしない。nullは描かない。
function boundaryStyle(ta, tb, edgeId) {
  const h = hexRng(edgeId * 997 + 3)(0, 1);
  const has = (t) => ta === t || tb === t;
  if (ta === 'mountains' && tb === 'mountains') return null; // 尾根続き
  if (has('forest')) return has('mountains') ? null : 'path'; // 林の縁に沿う農道
  if (has('mountains')) return 'wall'; // 山裾の石垣
  if (has('desert')) return h < 0.5 ? 'wall' : 'path';
  if (ta === 'pasture' && tb === 'pasture') return 'wall';
  if (has('pasture') && has('field')) return h < 0.3 ? 'stream' : 'hedge';
  if (ta === 'field' && tb === 'field') return h < 0.5 ? 'hedge' : 'path';
  if (has('hills')) return h < 0.5 ? 'hedge' : 'wall';
  return 'hedge';
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

// 航海者の船(拡張)。舳先がとがったGEO.shipHull+マスト+帆(持ち主の色、布の彩度)
function addShip(mx, mz, ang, playerColor) {
  const hull = new THREE.Mesh(GEO.shipHull, MAT.boatHull);
  hull.position.set(mx, SEA_LEVEL + 2.2, mz);
  hull.rotation.y = ang;
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 7, 6), MAT.signPost);
  mast.position.set(mx, SEA_LEVEL + 5.7, mz);
  const sail = new THREE.Mesh(GEO.boatSail, clothMaterial(playerColor));
  sail.scale.set(2.5, 2.8, 2.5);
  sail.rotation.y = ang;
  sail.position.set(mx, SEA_LEVEL + 9.5, mz);
  [hull, mast, sail].forEach((m) => { m.castShadow = true; sceneGroup.add(m); });
}

// 頂点から出ている道を避けた方角に、家を数棟リング状に置く(開拓地=農家の集落)。
// 壁・土台・軒・屋根は持ち主色なし(石灰・石積み・瓦/茅葺き)。持ち主の色は雨戸・日よけ布・旗だけに出す。
// ④の直し: 頂点の空き(VERTEX_CLEAR)いっぱいに広がる集落のかたまりに見えるよう、家の数と半径を増やした。
function buildSettlement(B, g, v, x, z, baseY, cloth) {
  const used = vertexEdgeAngles(g, v);
  const rr = hexRng(v.id * 7919 + 101);
  const slots = 9;
  const free = [];
  for (let i = 0; i < slots; i++) {
    const a = (i / slots) * Math.PI * 2 + rr(-0.1, 0.1);
    if (used.some((u) => angDiff(a, u) < 0.5)) continue;
    free.push(a);
  }
  for (let i = free.length - 1; i > 0; i--) { const j = Math.floor(rr(0, i + 1)); [free[i], free[j]] = [free[j], free[i]]; } // 決定的シャッフル
  const n = Math.min(Math.round(rr(5, 8.999)), Math.max(free.length, 1));
  let smoked = false, flagY = -Infinity; // ④の直し: 旗は頂点そのものの高さ(海岸のすぐきわだと渚の低さを拾うことがある)ではなく、
  // まわりの家の高さの最大値に合わせる(どの家よりも低く沈んで見えなくなるのを防ぐ)
  for (let i = 0; i < n; i++) {
    const a = free.length ? free[i % free.length] : rr(0, Math.PI * 2);
    const r = rr(6.0, 11.0);
    const hx = x + Math.cos(a) * r, hz = z + Math.sin(a) * r;
    const hy = groundY(hx, hz, baseY);
    flagY = Math.max(flagY, hy);
    const ry = a + Math.PI + rr(-0.25, 0.25); // 中心のほうを向かせる
    const s = rr(1.0, 1.4);
    const thatch = rr(0, 1) < 0.45;
    pushHouse(B, hx, hy, hz, ry, s, thatch, v.id * 13 + i, cloth);
    if (!smoked) { B.chimney.push({ x: hx, y: hy, z: hz, ry, s }); addSmokePuffs(hx, hz, hy + 5.1 * s, 3, v.id * 97 + 1); smoked = true; }
  }
  // ponytail: 渚ぎりぎりの頂点だと地形が海面付近まで下がることがあるので、旗だけは最低でも海面より少し上に留める
  const fy = Math.max(groundY(x, z, baseY), flagY, SEA_LEVEL + 1.5), fa = rr(0, Math.PI * 2);
  B.flagPole.push({ x, y: fy, z, ry: fa, s: 1.3 });
  B.flagCloth.push({ x, y: fy, z, ry: fa, s: 1.3, color: cloth });
}
function pushHouse(B, hx, hy, hz, ry, s, thatch, seed, cloth) {
  B.plinth.push({ x: hx, y: hy, z: hz, ry, s });
  B.wall.push({ x: hx, y: hy, z: hz, ry, s, seed }); // 持ち主色なし(石灰・石積み)。seedはvarianceの色むらに使う
  B.shutter.push({ x: hx, y: hy, z: hz, ry, s, color: cloth });
  B.awning.push({ x: hx, y: hy, z: hz, ry, s, color: cloth });
  B.eave.push({ x: hx, y: hy, z: hz, ry, s });
  (thatch ? B.roofThatch : B.roofTile).push({ x: hx, y: hy, z: hz, ry, s, seed });
}
function addSmokePuffs(x, z, y, count, seed) {
  const rr = hexRng(seed);
  for (let i = 0; i < count; i++) {
    const puff = new THREE.Mesh(GEO.smoke, MAT.smoke.clone());
    puff.material.opacity = 0.3 - i * 0.06;
    puff.scale.setScalar(0.6 + i * 0.5);
    puff.position.set(x + i * 0.9 + rr(-0.25, 0.25), y + i * 0.85, z - i * 0.5 + rr(-0.25, 0.25));
    sceneGroup.add(puff);
  }
}
const CHURCH_TIP = 24.7; // churchSpireRoofの先端の高さ(ground基準。都市の旗の根元に使う)
// 都市: 石の城壁(円)+控え塔2本+凹凸+教会(身廊・屋根・尖塔)+中に密集した小さい家。開拓地よりはっきり大きい。
function buildCity(B, g, v, x, z, baseY, cloth) {
  const rr = hexRng(v.id * 6151 + 211);
  const y = groundY(x, z, baseY);
  const wallRot = rr(0, Math.PI * 2); // ponytail: 門は見た目の切れ目を作らず、塔の向きだけで示す(通行判定はもとから無い)
  const stone = getCityStoneMaterial(); // ④の直し: のっぺり灰色の円筒をやめ、山の岩肌テクスチャで石積みの質感・色むらを出す
  const wall = new THREE.Mesh(GEO.cityWallRing, stone);
  wall.position.set(x, y + 4.75, z); wall.rotation.y = wallRot;
  wall.castShadow = true; wall.receiveShadow = true;
  sceneGroup.add(wall);
  [-0.55, 0.55].forEach((side) => { // 門の両脇の塔(屋根と、持ち主の色の小旗。窓は明暗を付けて石積みらしく)
    const a = wallRot + side;
    const tx = x + Math.cos(a) * 16.2, tz = z + Math.sin(a) * 16.2;
    const tower = new THREE.Mesh(GEO.cityTower, stone);
    tower.position.set(tx, y + 8, tz);
    const roof = new THREE.Mesh(GEO.cityTowerRoof, MAT.roofTile);
    roof.position.set(tx, y + 16 + 3.2, tz);
    tower.castShadow = roof.castShadow = true;
    sceneGroup.add(tower, roof);
    [0, Math.PI / 2, Math.PI, Math.PI * 1.5].forEach((wa) => { // 窓(2段x4方向)
      [5.2, 11.2].forEach((wy) => {
        B.towerWindow.push({ x: tx + Math.cos(wa) * 3.95, y: y + wy, z: tz + Math.sin(wa) * 3.95, ry: -wa });
      });
    });
    const fa = a + Math.PI; // 塔の旗は外向きに
    B.flagPole.push({ x: tx, y: y + 16 + 6.4, z: tz, ry: fa, s: 0.75 });
    B.flagCloth.push({ x: tx, y: y + 16 + 6.4, z: tz, ry: fa, s: 0.75, color: cloth });
  });
  for (let i = 0; i < 20; i++) { // 城壁の上の凹凸(まとめてバッチ)
    const a = (i / 20) * Math.PI * 2;
    B.crenel.push({ x: x + Math.cos(a) * 16.2, y: y + 9.6, z: z + Math.sin(a) * 16.2, ry: a, seed: v.id * 31 + i });
  }
  const body = new THREE.Mesh(GEO.churchBody, MAT.housePlinth);
  const roof = new THREE.Mesh(GEO.churchRoof, MAT.roofTile);
  const spire = new THREE.Mesh(GEO.churchSpire, stone);
  const spireRoof = new THREE.Mesh(GEO.churchSpireRoof, MAT.roofTile);
  [body, roof, spire, spireRoof].forEach((m) => { m.position.set(x, y, z); m.rotation.y = wallRot; m.castShadow = true; sceneGroup.add(m); });
  const usedA = vertexEdgeAngles(g, v);
  for (let i = 0; i < 10; i++) { // 城壁の中に密集した小さい家(開拓地より小さく、多い)
    const a = (i / 10) * Math.PI * 2 + rr(-0.1, 0.1);
    if (usedA.some((u) => angDiff(a, u) < 0.45)) continue;
    if (angDiff(a, wallRot - 0.55) < 0.5 || angDiff(a, wallRot + 0.55) < 0.5) continue; // 塔のそば
    const r = rr(9.5, 13.3);
    const hx = x + Math.cos(a) * r, hz = z + Math.sin(a) * r;
    pushHouse(B, hx, groundY(hx, hz, baseY), hz, a + Math.PI + rr(-0.2, 0.2), rr(0.55, 0.8), rr(0, 1) < 0.3, v.id * 17 + i, cloth);
  }
  const fa = rr(0, Math.PI * 2); // 旗は教会の尖塔の先に、塔の旗より大きく(開拓地よりはっきり目立つ)
  B.flagPole.push({ x, y: y + CHURCH_TIP, z, ry: fa, s: 1.05 });
  B.flagCloth.push({ x, y: y + CHURCH_TIP, z, ry: fa, s: 1.05, color: cloth });
}
// 小さな兵の一団(三角の隊形)+持ち主の旗。「都市と騎士」の騎士・蛮族の騎士の両方で使う
// ④の直し: 外套は旗・標柱と同じ「染めた布」の色調(clothColor)にそろえ、既定のカメラでも持ち主がわかるよう一回り大きくした。
function addKnight(x, baseY, z, color, active) {
  const y = groundY(x, z, baseY);
  const headMat = active ? MAT.knightArmor : new THREE.MeshStandardMaterial({ color: 0x3a3d44, roughness: 0.6, metalness: 0.3 });
  const robeColor = clothColor(color);
  if (!active) robeColor.multiplyScalar(0.75); // 非アクティブは少し沈ませるだけ(色味は残す)
  const robeMat = new THREE.MeshStandardMaterial({ color: robeColor, roughness: 0.78 });
  // 外套(持ち主の色。上面が平らな筒で、見下ろすカメラでも色がはっきり見える)+頭(灰色)
  [[0, 0], [-1.9, 1.1], [1.9, 1.1]].forEach(([dx, dz]) => {
    const robe = new THREE.Mesh(GEO.knightRobe, robeMat);
    robe.position.set(x + dx, y + 1.3, z + dz);
    robe.scale.setScalar(1.35);
    const head = new THREE.Mesh(GEO.knightHead, headMat);
    head.position.set(x + dx, y + 3.0, z + dz);
    head.scale.setScalar(1.3);
    robe.castShadow = head.castShadow = true;
    sceneGroup.add(robe, head);
  });
  const pole = new THREE.Mesh(GEO.flagPole, MAT.signPost);
  pole.scale.setScalar(0.42); pole.position.set(x, y, z);
  const flag = new THREE.Mesh(GEO.flagCloth, clothMaterial(color));
  flag.scale.setScalar(0.42); flag.position.set(x, y, z);
  pole.castShadow = flag.castShadow = true;
  sceneGroup.add(pole, flag);
}
// 道(石畳/土の路面+轍+ところどころの標柱の布)。実際の路面はB(instancedFromでまとめてバッチ)に積む
// ④の直し: 道幅を広げたぶん轍・生け垣・標柱も外側へ出し、標柱の布は1本の道に3〜4本に絞って大きくした。
function buildRoad(B, x1, z1, x2, z2, baseY, cloth, edgeSeed, ang) {
  const full = Math.hypot(x2 - x1, z2 - z1);
  const ux = (x2 - x1) / full, uz = (z2 - z1) / full, px = -uz, pz = ux;
  const trim = 2; // 頂点の建物のすぐきわまで敷く
  const ax = x1 + ux * trim, az = z1 + uz * trim, bx = x2 - ux * trim, bz = z2 - uz * trim;
  const rr = hexRng(edgeSeed * 911 + 5);
  const pts = alongSeg(ax, az, bx, bz, 2.0);
  const bannerEvery = Math.max(6, Math.round(pts.length / 4)); // 道1本に3〜4本になるよう間隔を決める
  pts.forEach(([x, z], i) => {
    const y = groundY(x, z, baseY);
    B.roadTile.push({ x, y: y + 0.08, z, ry: ang, seed: edgeSeed * 37 + i });
    [-1, 1].forEach((side) => B.roadRut.push({ x: x + px * 4.0 * side, y: y + 0.12, z: z + pz * 4.0 * side, ry: ang }));
    if (rr(0, 1) < 0.3) {
      const side = rr(0, 1) < 0.5 ? 1 : -1;
      B.roadsideBush.push({ x: x + px * 6.8 * side, y: y + 0.4, z: z + pz * 6.8 * side, s: rr(0.6, 1.0), ry: rr(0, 6), seed: edgeSeed * 53 + i });
    }
    if (i % bannerEvery === 0) { // 標柱(持ち主の色の布)
      const sx = x + px * 7.2, sz = z + pz * 7.2;
      const sy = groundY(sx, sz, baseY);
      B.signPost.push({ x: sx, y: sy, z: sz, ry: ang });
      B.banner.push({ x: sx, y: sy, z: sz, ry: ang + Math.PI / 2, color: cloth });
    }
  });
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
  const hull = new THREE.Mesh(GEO.shipHull, new THREE.MeshStandardMaterial({ color: 0x2b1d10, roughness: 0.85 }));
  hull.scale.set(22 / 16, 6 / 4.6, 14 / 6.4); // 航海者の船と同じ形(舳先がとがった船体)を蛮族の船の大きさに拡大
  hull.position.set(cx, height + 3, cz);
  hull.castShadow = true;
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
