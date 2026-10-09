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
| `web/src/lib/vendor/maplibre-elevation-profile/elevationprofile.ts` | `src/track/vendor/elevation-profile/elevationprofile.ts` | 1076 | import 与独立面板适配，见下 |
| `web/src/lib/vendor/maplibre-elevation-profile/elevationprofile-control.ts` | `src/track/vendor/elevation-profile/elevationprofile-control.ts` | 247 | 同样只改 import |
| `web/src/lib/vendor/maplibre-elevation-profile/tools.ts` | `src/track/vendor/elevation-profile/tools.ts` | 49 | |
| `web/src/lib/vendor/maplibre-layer-manager/trail-layer.ts` | `src/track/trail-layer.ts` | 38 | 见下 |
| `web/static/styles/ofm.json` | `src/track/basemap/openfreemap.json` | — | 见下 |
| `web/src/lib/components/trail/sandbox_terrain_three.svelte` | `src/track/sandbox/renderer.ts`、`geometry.ts`、`sampling.ts` | — | Three.js 沙盘流程、网格与贴图适配，见下 |
| `web/src/lib/util/sandbox_util.ts` | `src/track/sandbox/coordinates.ts` | — | 范围留白与客户端投影适配 |

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

**`src/track/vendor/elevation-profile/elevationprofile.ts`**：显式使用
`chartjs-plugin-crosshair` 的 ESM 入口，避免 CommonJS 入口没有导出插件对象而在初始化时
抛错；复制十字线插件后再包装绘制钩子，避免重复打开详情时修改共享对象。独立面板没有
上游页面的 `waypoint-container`，因此缺少该容器时跳过航点刻度覆盖层。
新增 `destroy()` 清理窗口与 canvas 的自有事件监听，防止退出详情后旧图表仍响应鼠标事件。

**`src/track/trail-layer.ts`**：上游把图层表达成一整个独立 style；本插件要在换底图
（`setStyle` 会清空自定义 source/layer）之后把轨迹**重新挂回去**，所以改写成
`addTrack` / `removeTrack` 这种幂等的形式。
样式初始化后一次挂齐数据源与图层，避免把数据源仍在加载误判成样式未就绪；已有图层保留。

**`src/track/basemap/openfreemap.json`**：取上游 `ofm.json`，**删掉 `sprite` 字段** —— 那份
style 的 sprite 指向 MapTiler，没有 key 会 401；OpenFreeMap 不提供 sprite，本插件的图层
也不需要图标精灵。

**`src/track/basemaps.ts`**：增加 Esri World Imagery 在线卫星/航空影像底图，直接接入官方 HTTPS raster 瓦片（256 像素，ArcGIS `{z}/{y}/{x}` 顺序，请求最高层级 19，更高层级本地放大）。二维地图和 3D 沙盘显示相同影像来源署名，选择保存在现有浏览器设置中。

- 来源：[World Imagery 官方项目](https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9)及其 [MapServer 元数据](https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer?f=pjson)。
- 2026-10-01 核对的服务署名为 `Esri, Vantor, Earthstar Geographics, and the GIS User Community`，按 [Esri 署名要求](https://doc.arcgis.com/en/arcgis-online/reference/display-copyrights.htm)在地图/影像旁显示。
- 在线影像不随本插件代码分发，其使用受来源条款约束；未增加原始影像瓦片的批量导出或离线缓存；动画录像包含当前地图画面，保留来源署名。

**`src/track/vendor/toGeoJSON.ts`**：只改了扩展名（`.js` → `.ts`）并加 `// @ts-nocheck` ——
它是从未标注过的 JS，在本仓的 `strict` 下每个参数都会读成隐式 `any`，而逐行加类型等于
开始修改移植代码、以后没法对账。`gpx` / `gpxGen` 两个导出保留（本地 GPX 走原生模型，用
不到，但删掉就要动文件内容）。

**`src/track/sandbox/*`**：参考本地 Wanderer 的 Three.js 沙盘实现，将 Svelte 生命周期改为 React 调用的独立渲染器；保留实体地形、地图贴图和贴地轨迹，使用已有 `TrackPoint[]`，不接入社区或航点管理。

- 区域 DEM 使用 [Mapterhorn](https://mapterhorn.com/data-access/) 的公共 Terrarium 瓦片，最大层级 12，并在沙盘中显示高程及底图署名。
- 高程采样前确认已解码瓦片与网格覆盖，采样倍率为 1，Three.js 显示倍率为 1.25，避免重复放大。
- 网格与贴图统一采用 Mercator 投影；轨迹按网格三角面分段贴地，避免长线段穿过山脊。
- 地图借用过程保存并恢复二维相机、terrain 和轨迹图层；10 秒超时或取消立即恢复。
- 渲染器按资源集合释放共享材质、纹理、几何体和监听器，并处理 GPU 上下文丢失。


## 新增的编辑与 AI 工作流

`src/track/edit.ts`、`gpx-export.ts`、`analysis.ts`、`annotations.ts`、`playback.ts`、`route-context.ts`、`src/annotations-store.ts`、`src/ai.ts` 及对应 React 界面均为本插件新写代码，使用现有 TrackPoint 协议，没有复制其他编辑器代码。

- 对比了 [gpx.studio](https://github.com/gpxstudio/gpx.studio) 的手绘、分段与合并交互，以及 [Terra Draw](https://github.com/JamesLMilner/terra-draw) 的 MapLibre 编辑能力。实现选择复用当前 MapLibre：每个编辑点保留原元组索引，拖动一次仅提交一次草稿操作，避免引入第二套地图与存储结构。
- 新 GPX 使用 GPX 1.1，缺失海拔/时间省略，名称作 XML 转义，坐标输出 xs:decimal；用户导入原文件保持原字节。
- SVG 交互镜头使用 [Panzoom](https://github.com/timmywil/panzoom)（`@panzoom/panzoom@4.6.2`，MIT），通过外层 CSS 变换提供自由平移、缩放与触控手势；镜头位置不写入标注数据或导出的 SVG。
- SVG 是自包含的本地示意画布；点位标签转义，图片仅接收本地 PNG/JPEG 数据，不使用外部图片 URL 或可执行 SVG。用户上传照片经 Canvas 处理后保存为 JPEG。
- 路线分析和镜头脚本通过可选宿主 `dsnAccount` 服务的 `fetchAi('/v1/chat/completions', ...)` 调用所选模型，限定输入大小和结构化输出，60 秒超时，可取消；插件不存储账号密钥。镜头脚本只接受全景、跟随、点位聚焦，索引和总时长均校验。
- 图片美化通过现有 `cqai-dsh-plugin-imagegen` 的同源目录和任务 API，仅允许当前所选带照片轨迹标注点；直接使用该点本地照片作为参考图，任务保存提交时的点位名称，不绕过宿主账号与任务管理。
- 录像使用浏览器 Canvas captureStream 与 MediaRecorder，烧入来源署名；播放路径采用累积测地距离插值，二分定位，不修改原始坐标，也不请求实时定位。
- 上游海拔剖面适配增加缺失海拔断线和有限时间检查，避免编辑点的空海拔被当作海平面或将空时间解析为 1970 年。
- 界面直接消费 DSH 的 `--dsw-alias-*`、字号与圆角变量；`src/client/theme.ts` 解析 Canvas 所需颜色并观察宿主主题更新。海拔图在同一实例内更新色彩和字体，保留缩放与数据，并隔离上游构造器对 Chart.js 全局字号的修改。
## 地图源与录制接口扩展

- 新增版本化浏览器设置与参数化高程提供方，保留 OpenFreeMap / OpenTopoMap / Esri，接入 OpenStreetMap 标准瓦片、MapTiler v4 样式与 Terrain RGB；真实来源署名及 MapTiler Logo 随地图、沙盘与 WebM 显示。OSM 公共瓦片只用于可见交互地图，不用于沙盘的离屏纹理采样。
- 沙盘改为独立采样、质量预算与真实米制网格；轨迹按三角面贴地并保留分段与急弯。光影采用可调 Three.js 灯光与模型边界适配的阴影范围，静止后停止持续渲染。
- `src/track/map-terrain.ts`、`map-settings.ts` 和 `frame-renderer.ts` 为新增第一方模块。录制候选的仓库、许可证、适配范围及推荐见 [地图录制调研](docs/map-recording-options.md)；本期只准备帧接口，没有引入这些候选的源码或依赖。

## 没移植的部分

- `web/src/lib/vendor/fit-parser/`（约 10.4k 行）—— **FIT 格式不在支持范围内**。
- `web/src/lib/vendor/maplibre-layer-manager/` 除 `trail-layer.ts` 之外的 10 个文件
  （cluster / overpass / terrain / debug 等）—— 都是 wanderer 社区功能，这里没有对应物。
- 服务端与社区部分：PocketBase、Meilisearch、Valhalla、Overpass、ActivityPub。

## 许可证

本插件整体按 **AGPL-3.0** 分发，因为上面「直接移植」的那些文件是 AGPL-3.0，而
AGPL-3.0 的传染性不区分「这是上游文件」还是「这是包含了它们的程序」。`package.json`
的 `license` 字段是 `AGPL-3.0-only`。

`src/track/vendor/toGeoJSON.ts` 的固定分叉来源为上表的 VoyageTrack commit。移除 Track
注释头并将 CRLF 规范为 LF 后，JavaScript 正文与该分叉文件逐字一致。原先的 ISC
标注错误：`@tmcw/togeojson` 官方上游许可为 **BSD-2-Clause**。完整版权声明与许可
原文保留在 [许可证文件](licenses/togeojson-upstream-BSD-2-Clause-LICENSE.txt)，
来源、哈希及比对结果见 [证据记录](licenses/togeojson-evidence.json)。

以官方 [5.8.1 源码](https://github.com/placemark/togeojson/tree/71b38c6ffaf016b2040225004b3a7ab122d2ed2a)
及其 npm 发布包为比对基线，62 个顶层函数中 57 个语法结构一致，3 个仅有可选链
编译形式差异。分叉保留另外 2 个函数的改动：TCX `coordPair` 在坐标中追加无效
海拔占位与时间；KML `gxCoords` 追加时间、过滤少于两个分量的坐标，并将两点
轨迹输出为 LineString。Track 没有改写这些分叉逻辑。此处确认 BSD 上游代码的
来源与许可，不把带改动的分叉认定为某个逐字相同的 npm 版本，也不以 BSD 声明
替代 VoyageTrack/Track 项目改动的许可。

第三方 npm 依赖（`maplibre-gl` BSD-3-Clause、`three` MIT、`chart.js` / `chartjs-plugin-zoom` /
`chartjs-plugin-crosshair` / `@panzoom/panzoom` MIT）与移植代码无关，各自保留原许可证。


## Panzoom MIT 许可声明

以下声明随包含 Panzoom 的插件分发：

```text
Copyright 2016-2019 Timmy Willison

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
## 地图镜头编辑集成本地原型（2026-10-04）

- GeoMotion 的工程、动画求值、路线同步与文字合成核心固定于 `databandar/geomotion` 的 `a911219b1f0d704aa10f1fc915df65c21f612ec1`，保存在 `src/track/vendor/geomotion/`。只调整内部导入为相对路径；源文件与调整后 SHA-256 见该目录的 `source-manifest.json`，来源说明见 `SOURCE.md`。
- 2026-10-04 本地原型集成时，上游没有声明许可证；当时仅用于用户已授权的本地验证，未发布软件包。该 GeoMotion 快照不属于本插件 AGPL 归属声明。
- 2026-10-08 npm 发布时，发布者确认已取得 GeoMotion 分发权限，并明确要求发布。这是发布者的确认记录，未随快照附上书面授权条款。上游公开许可证仍未声明，本次发行继续保留原始版权和这份确认，不为 GeoMotion 新增或推断公开许可证。具体声明见 `src/track/vendor/geomotion/SOURCE.md` 与 `THIRD_PARTY_NOTICES.md`。
- `bjperson/maplibre-gl-video-export` 的 `cc358e34221ce95c6f7381d8d2a5c9fd0ac0a9ad`（BSD-3-Clause）提供镜头预设与逐帧输出的实现参考。未复制其完整控件、交通路线生成或全局 MapLibre 时钟控制；本插件模板直接生成 GeoMotion 相机关键帧，视频导出消费带地名、字幕及地图来源署名的合成 Canvas。
- 实际依赖 `immer@10.1.1`（MIT）和 `mediabunny@1.24.2`（MPL-2.0）。编码器直接使用 Mediabunny `CanvasSource`、精确帧时间戳和背压；外部依赖的许可证依其随包文本，宿主 React 继续外置共享。
