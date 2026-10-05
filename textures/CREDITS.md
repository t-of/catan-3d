# テクスチャの出典

すべて CC0（Poly Haven）。配布元の1K JPGをsipsで768pxに縮小・再圧縮して使っている
（タイルの繰り返しが細かいため、1Kのままだと重いだけで見た目はほぼ変わらない）。

地形ごとに3枚1組（CC0のPBR一式）を使う。

| ファイル | 内容 |
|---|---|
| `<地形>_diff.jpg` | 色(アルベド) |
| `<地形>_nor.jpg` | 法線マップ(OpenGL形式、nor_gl) |
| `<地形>_arm.jpg` | AO(赤)・粗さ(緑)・金属度(青)をまとめた1枚(Poly Havenの標準パック)。three.jsのaoMap/roughnessMap/metalnessMapは読むチャンネルが同じなので、同じ画像を3つのmapに割り当てて使う |

| 地形 | 元の名前 | 出典 |
|---|---|---|
| forest | Forest Floor | https://polyhaven.com/a/forest_floor |
| pasture | Grass Ground | https://polyhaven.com/a/grass_ground |
| field | Farm Soil | https://polyhaven.com/a/farm_soil |
| hills | Brown Mud | https://polyhaven.com/a/brown_mud |
| mountains | Rock Face | https://polyhaven.com/a/rock_face |
| desert | Sand 01 | https://polyhaven.com/a/sand_01 |
| 環境光(HDRI) | Kloofendal 43d Clear (Pure Sky) | https://polyhaven.com/a/kloofendal_43d_clear_puresky |

ライセンス: すべて [CC0](https://creativecommons.org/publicdomain/zero/1.0/)（著作権表示なしで自由に使える）。
Poly Havenは非営利の素材サイト（https://polyhaven.com/）。

地形メッシュの色は上のPBR一式の`_diff`をそのまま使う(手続き的なCanvasの模様はやめた)。
マスの境目は、頂点カラーでわずかに暗く落として縫い目をなじませている(別のテクスチャは足していない)。
海はテクスチャを使わず、自前のShaderMaterialで深さに応じた色のグラデーションを計算している
(three.jsのWater.js/vendor化は見送った。理由はboard3d.jsのbuildOcean()のコメント参照)。
