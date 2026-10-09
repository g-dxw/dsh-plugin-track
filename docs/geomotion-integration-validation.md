# 三者集成本地验收

日期：2026-10-04；分支 `codex/geomotion-integration`。这是实际插件组件的隔离浏览器验收，工程使用真实后端存储模块；尚未验证已安装 DSH Desktop 的插件热更新与宿主实际挂载。

## 可直接体验

- 卫星与真实地形：<http://127.0.0.1:51216/>
- 无底图入口：<http://127.0.0.1:51216/?basemap=none>。已有工程会恢复自己的已保存底图，可在编辑器里切换无底图。
- 预览启动：`node outputs/geomotion-integration/server.mjs`；仅绑定本机 127.0.0.1:51216，当前 PID 见 `outputs/geomotion-integration/runtime/runtime.json`。
- 原有 Track 51215 与独立 GeoMotion 5173 服务保留。

本机服务器使用 Vite 开发依赖；工程 API 经 `ssrLoadModule` 调用 `src/geomotion-project-store.ts`。独立 DSH_HOME 为 `outputs/geomotion-integration/runtime/dsh-home`，不写实际应用数据。卫星影像使用此前已取得的真实 Esri 区域影像，DEM 使用真实 Mapterhorn 缓存及限量区域内请求；预览没有批量下载照片。

## 实际路线证据

使用“武功山反穿”快照，原 KML 中两个 LineString 分别有 1121、1070 点，共 2191 点；经纬度逐点、顺序与存储 track 全部一致。原始分段 `[0,1121]` 从有效 routeContext 恢复，没有注入断点。

`track.json`、`source.kml`、`placemark-state.json` 的原快照与隔离副本 SHA-256 在工程保存和导出后仍一致。证据为 `outputs/geomotion-integration/fixtures/source-validation.json` 及 `browser-evidence.json` 的 health。

## 自动化与浏览器结果

- TypeScript 严格类型检查通过。
- 完整测试 92 个文件、1787 项通过；新增适配 13、存储/HTTP 10、UI 16、编码/取消 21 项。
- 客户端与后端构建通过，客户端外部 require 仅为宿主 React 与 JSX runtime；Immer、Mediabunny、GeoMotion 核心都包含在插件构建中。
- 实际 Chromium/WebGL 运行：手动地图构图、K/按钮记录、拖动关键帧、数值调时、方向键、撤销/重做、四个模板、地名显隐均通过。
- 实际保存到 sidecar、导出 JSON、刷新后恢复时长/帧率/工程底图均通过。
- 深浅主题、720×1280 竖屏完整 contain、390px 窄窗口面板切换及无横向溢出通过。图层时间列表单独滚动。
- 取消导出恢复编辑与地图控制，随后可再次导出；最终浏览器 pageerror 和 error/warning console 均为空。
- 导出冻结工程、底图设置与输出尺寸；正常 finalize/cancel 由 Output 独占编码器关闭，避免二次 CanvasSource.close 的异步 flush 竞态。

完整可重现脚本为 `outputs/geomotion-integration/browser-validation.mjs`，结果为 `browser-evidence.json`。运行时需要本机 Chromium 路径，脚本内固定为本轮已验证的环境，不属于产品代码。

## 实际样片

`outputs/geomotion-integration/wugongshan-integrated-intro.webm`：武功山环境介绍，VP9、1920×1080、24 fps、144 帧、6 秒。每帧输入时间戳实测为 `i/24`，浏览器可读视频尺寸与时长，FFprobe 独立确认帧数、尺寸、帧率及 duration=6.000000。

样片明确显示起点、风车口、绝望坡、金顶、石鼓寺（终点）；两段真实路线及 Esri/Mapterhorn 来源署名都进入合成视频。为保持画面清楚，只在镜头工程中选择这些地名，原始地名和点位状态保持不变。

- `ffprobe-evidence.json`：独立编码元信息。
- `video-last-frame.png`：视频解码帧，人工检查真实地形、卫星纹理、路线、地名和署名。
- `editor-light.png` / `editor-dark.png`：两种宿主主题。
- `editor-portrait.png` / `editor-mobile.png`：竖屏与窄窗口。
- `wugongshan-camera-project.json`：镜头工程 JSON 备份；实际 sidecar 保留最终 1920×1080 工程。

## 委派与验收责任

三个实现子任务并行：GeoMotion 核心与轨迹适配、独立工程存储、原生中文界面。模型与推理强度均请求继承主任务，未独立验证运行时模型标识。核心子任务随后做只读恢复一致性审查，存储子任务补逐帧编码与取消竞态回归；主任务完成地图渲染、合成编码接入、完整测试、构建、真实浏览器运行及视频解码检查。

最终能力边界：本地基础整合已完成；无音频混音/MP4、自动标签避让或山体遮挡，未复制完整 GeoMotion Studio。GeoMotion 分发权限已由发布者于 2026-10-08 确认，日常发行沿用该确认，详见 [分发确认记录](releases/geomotion-distribution-record.md)。