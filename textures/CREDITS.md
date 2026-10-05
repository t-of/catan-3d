# テクスチャの出典

すべて CC0（Poly Haven）。配布元の 1K JPG / HDR を sips で 512px に縮小して使っている
（タイルの UV が小さいため、1K のままだと重いだけで見た目は変わらない）。`*_nor.jpg` は法線マップ（OpenGL 形式、nor_gl）。

| ファイル | 元の名前 | 使う地形 | 出典 |
|---|---|---|---|
| `forest.jpg` / `forest_nor.jpg` | Forest Floor | 森 | https://polyhaven.com/a/forest_floor |
| `pasture.jpg` / `pasture_nor.jpg` | Grass Ground | 牧草地 | https://polyhaven.com/a/grass_ground |
| `field.jpg` / `field_nor.jpg` | Farm Soil | 麦畑 | https://polyhaven.com/a/farm_soil |
| `hills.jpg` / `hills_nor.jpg` | Brown Mud | 丘 | https://polyhaven.com/a/brown_mud |
| `mountains.jpg` / `mountains_nor.jpg` | Rock Face | 山 | https://polyhaven.com/a/rock_face |
| `desert.jpg` / `desert_nor.jpg` | Sand 01 | 砂漠 | https://polyhaven.com/a/sand_01 |
| `sky.hdr` | Kloofendal 43d Clear (Pure Sky) | 環境光（HDRI） | https://polyhaven.com/a/kloofendal_43d_clear_puresky |

ライセンス: すべて [CC0](https://creativecommons.org/publicdomain/zero/1.0/)（著作権表示なしで自由に使える）。
Poly Haven は非営利の素材サイト（https://polyhaven.com/）。

水・金・城・ピッチは地形が小さく模様が目立たないため、手続き的な Canvas の模様のまま
（`terrainTexture()`、読み込みに失敗したときの代わりにもなる）。
