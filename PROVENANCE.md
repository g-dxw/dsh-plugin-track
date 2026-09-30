# 来源与许可证（PROVENANCE）

本插件的地图渲染与解析核心**不是原创**，是从一个 AGPL-3.0 项目移植过来的。这份文档
记录移植了哪些文件、来自哪个版本、改了什么，以及由此产生的许可义务。

## 上游

| 项 | 值 |
| --- | --- |
| 项目 | wanderer（户外轨迹社区，Go + PocketBase + SvelteKit） |
| 上游仓库 | https://github.com/open-wanderer/wanderer |
| 提取自 | https://github.com/g-dxw/VoyageTrack （wanderer 的 fork，分支 `dev_0.0.1`） |
| 提取时的 commit | `4a4d8f49711868d7b96917322cb05bdd6333428c`（2026-09-09） |
| 许可证 | **AGPL-3.0**（原文见 `LICENSE` 与 `src/track/LICENSE`） |

提取用的是一份本地 checkout，其 HEAD 只存在于该 fork 上，不在 `open-wanderer/wanderer`
的远端历史里。上表两行都要看：**项目归属是 open-wanderer/wanderer，字节来自那个 fork
的 commit**。要复核某一行的具体写法，用那个 commit 去对，而不是用上游 master。

## 逐文件对照

### 直接移植（AGPL-3.0，逐字或近逐字）

| 上游路径 | 本插件路径 | 上游行数 | 说明 |
| --- | --- | --- | --- |
| `web/src/lib/models/gpx/gpx.ts` | `src/track/model/gpx.ts` | 303 | 改动见下 |
| `web/src/lib/models/gpx/track.ts` | `src/track/model/track.ts` | 56 | |
| `web/src/lib/models/gpx/track-segment.ts` | `src/track/model/track-segment.ts` | 49 | |
| `web/src/lib/models/gpx/waypoint.ts` | `src/track/model/waypoint.ts` | 98 | |
| `web/src/lib/models/gpx/route.ts` | `src/track/model/route.ts` | 65 | |
| `web/src/lib/models/gpx/metadata.ts` | `src/track/model/metadata.ts` | 47 | |
| `web/src/lib/models/gpx/bounds.ts` | `src/track/model/bounds.ts` | 12 | |
| `web/src/lib/models/gpx/link.ts` | `src/track/model/link.ts` | 12 | |
| `web/src/lib/models/gpx/copyright.ts` | `src/track/model/copyright.ts` | 9 | |
| `web/src/lib/models/gpx/person.ts` | `src/track/model/person.ts` | 13 | |
| `web/src/lib/models/gpx/utils.ts` | `src/track/model/utils.ts` | 45 | `haversineDistance` 等 |
| `web/src/lib/models/gpx/gpx-metrics-computation.ts` | `src/track/model/gpx-metrics-computation.ts` | 86 | 距离/爬升平滑算法 |
| `web/src/lib/vendor/maplibre-elevation-profile/elevationprofile.ts` | `src/track/vendor/elevation-profile/elevationprofile.ts` | 1076 | 改了 4 处 import，见下 |
| `web/src/lib/vendor/maplibre-elevation-profile/elevationprofile-control.ts` | `src/track/vendor/elevation-profile/elevationprofile-control.ts` | 247 | 同样只改 import |
| `web/src/lib/vendor/maplibre-elevation-profile/tools.ts` | `src/track/vendor/elevation-profile/tools.ts` | 49 | |
| `web/src/lib/vendor/maplibre-layer-manager/trail-layer.ts` | `src/track/trail-layer.ts` | 38 | 见下 |
| `web/static/styles/ofm.json` | `src/track/basemap/openfreemap.json` | — | 见下 |

### ISC（不是 AGPL）

| 上游路径 | 本插件路径 | 上游行数 | 许可证 |
| --- | --- | --- | --- |
| `web/src/lib/vendor/toGeoJSON/toGeoJSON.js` | `src/track/vendor/toGeoJSON.ts` | 1173 | ISC（`@tmcw/togeojson` 的裁剪版，见下） |

### 新写的第一方代码（**不是移植**，不受上游许可证约束）

这些文件是照上游的**行为**重写的，不含上游代码：

| 文件 | 为什么是新写的 |
| --- | --- |
| `src/track/model/gpx-xml.ts` | 上游用 `isomorphic-xml2js`；这里用手写 `DOMParser` 读取器替掉那个依赖 |
| `src/track/model/bbox.ts` | 上游从 `$lib/util/geojson_util` 取（拖进整个 turf）；这里直接走坐标 |
| `src/track/metrics.ts` | 上游 `getTotals()` 跑在模型对象上；这里跑在扁平的 `TrackPoint[]` 上，算法逐行对齐 |
| `src/track/geometry.ts`、`export.ts`、`format.ts`、`title.ts`、`import.ts` | wanderer 里没有对应物 |
| `src/track/vendor/elevation-profile/waypoint.ts` | 上游那个类型挂在 trail 页面上，这里只留剖面用到的三个字段 |
| `src/protocol.ts`、`src/artifacts.ts`、`src/index.ts`、`src/client/**` | 本插件自己的存储与界面 |

## 改了哪些地方

**`src/track/model/*`、`src/track/vendor/elevation-profile/*`**：删掉对 wanderer 服务端与
app 层的耦合。逐条：

- 删 `GPX.correctElevation()` 与 `from '../valhalla'` 的 `ValhallaHeightResponse` —— 那是
  wanderer 服务端的高程纠偏 API，本地没有这个服务，**也不会凭空造海拔**；
- 删 `$lib/util/api_util` 的 `APIError`、`$lib/util/polyline_util` 的 `encodePolyline`
  （Google encoded polyline 是 wanderer 的存储格式，本地不需要）；
- 删 `crypto-random-string`、`ngeohash` 与 `generateMinHash` —— 社区去重用不上；
- `elevationprofile*.ts` 的四处 `$lib/...` import 改指本插件内的路径（`../../model/utils`
  的 `haversineDistance`、`../../model/waypoint` 的**仅类型**、本地五行 `formatTimeHHMM`）；
- `import * as xml2js from 'isomorphic-xml2js'` → `./gpx-xml` 的 `parseGpxXml`。

**`src/track/trail-layer.ts`**：上游把图层表达成一整个独立 style；本插件要在换底图
（`setStyle` 会清空自定义 source/layer）之后把轨迹**重新挂回去**，所以改写成
`addTrack` / `removeTrack` 这种幂等的形式。

**`src/track/basemap/openfreemap.json`**：取上游 `ofm.json`，**删掉 `sprite` 字段** —— 那份
style 的 sprite 指向 MapTiler，没有 key 会 401；OpenFreeMap 不提供 sprite，本插件的图层
也不需要图标精灵。

**`src/track/vendor/toGeoJSON.ts`**：只改了扩展名（`.js` → `.ts`）并加 `// @ts-nocheck` ——
它是从未标注过的 JS，在本仓的 `strict` 下每个参数都会读成隐式 `any`，而逐行加类型等于
开始修改移植代码、以后没法对账。`gpx` / `gpxGen` 两个导出保留（本地 GPX 走原生模型，用
不到，但删掉就要动文件内容）。

## 没移植的部分

- `web/src/lib/vendor/fit-parser/`（约 10.4k 行）—— **FIT 格式不在支持范围内**。
- `web/src/lib/vendor/maplibre-layer-manager/` 除 `trail-layer.ts` 之外的 10 个文件
  （cluster / overpass / terrain / debug 等）—— 都是 wanderer 社区功能，这里没有对应物。
- 服务端与社区部分：PocketBase、Meilisearch、Valhalla、Overpass、ActivityPub。

## 许可证

本插件整体按 **AGPL-3.0** 分发，因为上面「直接移植」的那些文件是 AGPL-3.0，而
AGPL-3.0 的传染性不区分「这是上游文件」还是「这是包含了它们的程序」。`package.json`
的 `license` 字段是 `AGPL-3.0-only`。

`src/track/vendor/toGeoJSON.ts` 那一个文件来自 ISC 许可的 `@tmcw/togeojson`，比 AGPL 更
宽松，放在 AGPL 的程序里没有冲突。

第三方 npm 依赖（`maplibre-gl` BSD-3-Clause、`chart.js` / `chartjs-plugin-zoom` /
`chartjs-plugin-crosshair` MIT）与移植代码无关，各自保留原许可证。
