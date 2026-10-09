# 武功山位置介绍与路线镜头示例

复用插件的原生 GeoMotionEditor，展示 SC02—SC04A 的区域定位、山体推进、路线三段介绍和萍乡火车站到龙山村入口。横屏 1280×720、30 fps、72 秒，可编辑相机关键帧、标注和图层时间线。

在仓库根目录安装依赖并启动：

~~~powershell
corepack yarn install
node examples/wugongshan-location-preview/editor/server.mjs
~~~

打开 http://127.0.0.1:51222/ 。需要联网加载 Esri 卫星图和 Mapterhorn 地形。服务只监听本机，地形仅按当前视野请求，每次启动最多新增 256 张 DEM 瓦片；自己的缓存会继续复用。

## 编辑与保存

- 在相机面板调整时间、经纬度、缩放、俯视角度、朝向和缓动。
- 拖动地图后点击“记录当前构图（K）”，再点击“保存工程”。
- 通过图层时间线调整地名、线路、区域高亮和文字的显示时间。
- 点击“导出 JSON”或页顶“下载已保存工程”另存可导入的原生工程。
- 点击“导出 WebM 视频”获得视频；逐帧导出会等待当前地图视野加载。

保存的镜头位于本示例的 runtime/dsh-home/track/wugongshan-location-demo/geomotion-project.json，重启会恢复。runtime、媒体和缓存均被 Git 忽略。需要重新开始时，先另存用户编辑的工程，再移走 runtime 目录后重启。

## 镜头顺序

| 时间 | 画面 |
| --- | --- |
| 0—8 秒 | 江西省界与省名、武功山位置、湖南区域依次出现，区域构图停稳 |
| 8—12.6 秒 | 淡出区域标注，连续推进并压低俯视角度，进入三维山体 |
| 12.6—20 秒 | 真实线路逐渐显示，龙山村、金顶、石鼓寺依次出现 |
| 20—26 秒 | 全线和距离、爬升、下降、最高与最低海拔 |
| 26—33 秒 | 龙山村—木马坳：树林爬升 |
| 33—42 秒 | 木马坳—金顶：高山草甸山脊 |
| 42—48 秒 | 金顶—石鼓寺：台阶下山 |
| 48—58 秒 | 拉远到区域并转向萍乡火车站 |
| 58—69 秒 | 车站到龙山村入口的真实驾车道路 |
| 69—72 秒 | 入口停留 |

## 示例数据与来源

project.json 是已验证预览工程的精简版本，只保留相机和显示的图层。两条基础徒步线路保留 1121、1070 个坐标，共 2191 个点，原来的记录段间隙保留。没有原始 KML、用户图片、照片下载链接、录制时刻或原轨迹日期编号。

demo-source.mjs 从工程重建最小 gpx TrackRecord、四个无照片路线节点和 PlacemarkState。高程和时间不在示例源点中，均为 null；画面统计来自原先确认的路线资料。这份数据用于镜头复现，不能当作原始运动记录。启动时通过 createGeoMotionProject 重算来源标识。

- 江西、湖南区域：[省界 GeoJSON](data/hunan-jiangxi.geojson) 与 [来源、版本和许可](data/boundary-source.json)，geoBoundaries / www.geoboundaries.org，CC BY 4.0。
- 萍乡火车站—龙山村入口：[驾车 GeoJSON](data/pingxiang-station-to-longshan.road.geojson) 与 [道路来源](data/driving-source.json)，OpenStreetMap contributors / OSRM，2026-10-07 查询，约 51.3 km、模型估算约 52 分钟，无实时路况。
- 40 元/人拼车是用户经历参考；山脉说明没有绘制未经核实的山脉边界。

外部参考视频只用于镜头语言分析，未附带其图片或视频。大型预览成片保留在本地 outputs，不加入这个代码示例。本例是 SC02—SC04A 的局部预览，不代表完整影片脚本已经确认。

## 可选自动导出

编辑器本身不依赖 Playwright。若已安装可选的 playwright 包与 Chromium，可在预览服务运行时执行：

~~~powershell
npx playwright install chromium
node examples/wugongshan-location-preview/export-preview.mjs
~~~

脚本通过原生 UI 导出 WebM 并校验编码帧数、源数据完整性和页面错误，输出位于 Git 忽略的 media 目录。也可在编辑器手动导出。TRACK_DEMO_PORT 可调整端口；自动导出使用 TRACK_DEMO_URL 指定对应地址，TRACK_DEMO_CHROMIUM 可指定已安装的浏览器路径。
