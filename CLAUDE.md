# catan-3d

T.OF... のアプリ（試作）。https://t-of.github.io/catan-3d/

catan（https://t-of.github.io/catan/）を丸ごと写し、盤の表示だけを three.js のリアルな 3D にした版。
ゲームのロジック（engine.js・cpu.js）は catan と共通。盤の見た目は board3d.js が担当し、main.js の renderBoardInto
（SVG。判定とデータ取得にだけ使い、画面には出さない）が作る overlay（置ける頂点・辺・マスの一覧）をそのまま使う。

- ルールは本部の `~/GitHub/tof/t-of.github.io/RULES.md` に従う（全アプリ共通）。ブランドは `docs/BRAND.md`。
- 直したら本部で `npm run audit -- catan-3d`（試作なので browser 版はまだ不要）を通す。
- 公開は本部の `docs/RELEASE.md` の手順。大きな作業は本部で Claude を起動すると、役割を分けて進められる。
- localStorage のキーは `catan-3d.` で始める。SW のキャッシュ名は `catan-3d-` で始める。
- three.js は `vendor/`（three.module.min.js・OrbitControls.js）に固定版を置く。CDN は読まない。
