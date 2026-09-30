# 轨迹

易宝工坊 / DeepSeek Harness 的轨迹插件。导入 **GPX / KML / TCX**，在地图上画线，给出海拔剖面和统计量（距离、累计爬升/下降、时长、最高/最低点）。

侧栏 **易宝工坊 → 轨迹**。通过官方 `sidebar.panellist` 和 `main` 插槽挂载，保留原有对话界面。

## 使用

1. **导入**：把 `.gpx` / `.kml` / `.tcx` 拖进面板，或点「选择文件」。可以一次选多个；单个文件上限 8 MB，解析出的轨迹点上限 50 万。
2. **看**：列表按导入时间倒序。点一条进入详情，地图自动缩放到轨迹范围，下面是海拔剖面与统计卡片。
3. **导出**：
   - **导出原文件** —— 拿回你当初导入的那个文件，**逐字节一致**（面板保留了一份 `source.<ext>`，不是重新序列化出来的）。
   - **导出 GeoJSON** —— 标准 `FeatureCollection`，`LineString` + 起终点 `Point`，可以丢进 geojson.io / mapshaper / QGIS。
4. **删除**：详情页右上角，需要点两次确认。

## 离线行为

**轨迹线、海拔剖面、统计量都不联网。** 解析在导入时完成并随轨迹一起存盘，打开一条已有轨迹不发任何请求。

只有**底图瓦片**需要联网，这是设计上明确的取舍：

| 底图 | 来源 | 离线 |
| --- | --- | --- |
| 矢量（默认） | OpenFreeMap `tiles.openfreemap.org` | 需要联网 |
| 地形 | OpenTopoMap `tile.opentopomap.org` | 需要联网 |
| 无底图 | 无 | 纯色底 + 轨迹线 |

底图拉不到时，面板会显示「底图需要联网，当前只显示轨迹线」并自动退回纯色底 —— 失败的只是底图，轨迹线和剖面不受影响。断网时可以手动切到「无底图」，避免在控制台里刷一屏失败请求。

底图选择记在 `localStorage`（`cqai-track.basemap`）。

WebGL 拿不到时（某些虚拟机、远程桌面），地图降级为把轨迹投影成 SVG 折线画出来：没有底图也不能拖动，但轨迹的形状还在，海拔剖面照常。

**所有底图地址都是 https** —— 应用本身跑在 `http://127.0.0.1`，明文 http 的瓦片会被混合内容策略拦掉。

## 支持范围

- **格式**：GPX、KML、TCX。
- **不支持的**：FIT（`fit-parser` 有约 10.4k 行，不在范围内）。
- **不做高程纠偏**：上游 wanderer 有一套服务端补高 API（Valhalla），本地没有这个服务，所以 **GPX 里没带 `<ele>` 的轨迹就是没有剖面**，不会凭空造一段出来。面板会直接说「这条轨迹没有海拔数据」。
- KML 里的 `<LineString>` / `<MultiLineString>` / `<Polygon>` / `<MultiPolygon>` 都会读；`Point` 不画。
- TCX 里少于两个 Trackpoint 的 Lap 会被跳过（上游 `@tmcw/togeojson` 的行为）。

## 数据存放在哪

```
<DSH home>/track/<id>/
├── track.json    解析后的坐标 + 列表要用的元数据
└── source.gpx    导入时的原文件，逐字节保留
```

`<DSH home>` 的解析顺序：显式配置 → `$DSH_HOME` → `~/.dsh`。

解析结果和原文件都存，是因为两者用途不同：断网时要立刻能画（不能等重新解析一个几 MB 的 GPX），而「导出原文件」要的是当初那个文件本身。半写入或手工塞进去的目录在列表里会被跳过，坏一条不会带垮整个列表。

本地服务只监听回环地址，且变更请求（`POST` / `DELETE`）必须带 `x-cqai-track: 1` 头，浏览器里其他页面无法驱动它。轨迹 id 在读写前都要过一遍格式校验，`?id=../../..` 这类越界读取会被当成「轨迹不存在」。

## 安装

**本插件不预装**，以第三方包形式装进 profile：

```sh
dsh plugin --profile desktop add <本插件路径>
```

本地独立项目目录为 `E:\workspace\project\dsh-plugin-track`，可在构建后安装：

```powershell
dsh plugin --profile desktop add E:\workspace\project\dsh-plugin-track
```

之后**重启应用**，侧栏出现「轨迹」入口。

## 构建与测试

在本插件的独立项目目录执行（Node.js `^22.19.0` 或 `>=24.0.0`，Yarn `4.18.0`）：

```powershell
cd E:\workspace\project\dsh-plugin-track
corepack yarn install --immutable
corepack yarn build
corepack yarn typecheck
corepack yarn test
```

`tests/` 下六个测试文件、78 个用例，都不需要真浏览器（`fixtures.ts` 是被它们共用的固定样本，不是测试）：

| 文件 | 用例 | 覆盖 |
| --- | --- | --- |
| `parse.test.ts` | 31 | GPX / KML / TCX 解析、上传校验、点数与体积上限（jsdom 环境，走真 `DOMParser`） |
| `metrics.test.ts` | 12 | 距离 / 爬升平滑 / 时长 / bbox，并与移植过来的上游累加器对账 |
| `geojson.test.ts` | 12 | 导出 GeoJSON 的形状（含 `[lon, lat, ele]` 顺序、残缺点的处理）、文件名清洗 |
| `artifacts.test.ts` | 16 | 存储读写、半成品目录容错、越界 id 拒绝（真临时文件系统） |
| `routes.test.ts` | 4 | 真起 `dsh-host-webserver`，打全端点，含回环门禁的正反用例 |
| `client-import.test.ts` | 3 | 真实 React 导入 GPX / KML / TCX 到本地服务，验证中文文件名与原文件逐字节导出 |


`lib/client.js` 约 2.7 MB —— 主要是 MapLibre GL 与 chart.js，它们不在客户端的运行时模块白名单里，只能打进 bundle。

## 许可证

**本插件整体按 AGPL-3.0 分发**，`package.json` 的 `license` 是 `AGPL-3.0-only`。

原因：地图渲染与解析核心是从一个 AGPL-3.0 项目**直接移植**的，而 AGPL-3.0 的传染性不区分「这是上游文件」还是「这是包含了它们的程序」。移植了哪些文件、来自哪个 commit、改了什么，逐条记在 `PROVENANCE.md` 里。

第三方 npm 依赖（`maplibre-gl` BSD-3-Clause、`chart.js` / `chartjs-plugin-zoom` / `chartjs-plugin-crosshair` MIT）与移植代码无关，各自保留原许可证。
