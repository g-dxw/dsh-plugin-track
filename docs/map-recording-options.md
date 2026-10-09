# 地图轨迹动画录制候选与接入准备

核查日期：2026-10-02。以下版本来自上游默认分支声明，不等同于已安装或已验证的发行包。本期仅提供适配接口与调研，不安装候选依赖，不新增 MP4、GPS 采集或 3D 视频导出。

## 推荐路径

后续优先试验 **Mediabunny + 本插件自己的 TrackFrameRenderer**。轨迹进度、镜头和地图署名由本插件控制，编码器只消费已经绘制完成的 Canvas。这样同一编码流程将来可接受 MapLibre 地图或独立 Three.js 沙盘，避免将镜头、React 状态与某个地图控件绑定。

当前二维回放继续按距离时间线更新，WebM 使用既有 `canvas.captureStream(30)` 和 MediaRecorder。新增接口不改变下载格式或默认播放行为。

## 开源候选

| 项目 | 已核许可证与版本声明 | 集成判断 |
|---|---|---|
| [maplibre-gl-video-export](https://github.com/bjperson/maplibre-gl-video-export) | BSD-3-Clause；[package.json](https://github.com/bjperson/maplibre-gl-video-export/blob/master/package.json) 声明 0.2.0、MapLibre `>=5.11.0 <6`、Mediabunny `^1.24.2` | 真正的 MapLibre 导出控件，可作为第二候选；它自己的 UI 和镜头需要适配，不能直接录制独立 Three.js Canvas。 |
| [Mediabunny](https://github.com/Vanilagy/mediabunny) | MPL-2.0；[package.json](https://github.com/Vanilagy/mediabunny/blob/main/package.json) 声明 1.61.0，运行依赖为 WebCodecs/媒体流类型包 | 优先编码底层，CanvasSource 支持显式帧时间戳，适合异步逐帧画面。 |
| [Travelback](https://github.com/Open330/travelback) | MIT；[package.json](https://github.com/Open330/travelback/blob/main/package.json) 声明 0.1.0，依赖 Next.js 16、React 19、MapLibre 6 和 Mediabunny | 完整浏览器应用，参考镜头和导出流程；与本插件版本栈不同，不整体嵌入。 |
| [GPX Animator](https://github.com/gpx-animator/gpx-animator) | [Apache-2.0](https://github.com/gpx-animator/gpx-animator/blob/master/LICENSE.md)；本次未锁定可复现发行版本 | Java GUI/CLI，可生成俯视 GPX 视频；适合作为独立对比工具，引入浏览器插件需要新增 Java 运行链，不作为本期集成方案。 |

[视频控件 README](https://github.com/bjperson/maplibre-gl-video-export#readme) 提供全局 `maplibregl`/CDN 用法及 WebAssembly 编码说明，同时声明 ESM 入口；后续必须验证 npm 打包内容、是否访问 `window.maplibregl`、编码资源路径/CSP，以及 Electron 内的 WebCodecs 能力，不能据演示页面认定可直接打包。它的相机预设、地形碰撞和边界控制还需要实际轨迹验收。

[Mediabunny 官方写入文档](https://mediabunny.dev/guide/writing-media-files)说明 CanvasSource、时间戳、封装完成和取消释放。后续选择 codec 前须运行能力检测并检查地图 Canvas 跨域资源能否录制；候选库许可证和编码资源许可证应在实际锁版本时一并收录 PROVENANCE。

## 已提供的接口

`src/track/frame-renderer.ts`：

```ts
interface AnimationFrameState {
  progress: number       // 0..1，越界有限值会夹紧
  elapsedMs: number      // 非负经过时间
  shot?: AnimationShot
  shotIndex?: number
}
interface TrackFrameRenderer {
  getCaptureCanvas(): HTMLCanvasElement | null
  renderFrame(frame: AnimationFrameState, signal?: AbortSignal): Promise<void>
  getCredits?(): readonly MapCredit[]
}
```

AnimationMap 通过可选 `onFrameRenderer` 回调传出适配器；TrackAnimation 保留并向外转发该回调。原 `onCanvas`、`onCaptureFrame` 等播放/录制回调继续兼容。

- `renderFrame` 更新指定进度与镜头；所有轨迹源和对应瓦片完成、实际 render 事件绘制并烧录文字署名后才完成，逐帧请求还等待可见地图瓦片就绪。
- 每次请求带修订号；新请求拒绝前一个请求，旧 render 不能完成新帧。播放/底图切换、AbortSignal、卸载、图形上下文丢失和资源错误会结束等待；正常没有渲染确认时在 10 秒后超时。
- 录制期间快照底图和 Key，禁用底图控件；外部设置变化在本次录制结束后应用。只返回实际底图的署名，失败回退为无底图。
- MapTiler 官方 Logo 使用 CORS 匿名预加载，以原比例绘制在白色底板上，保证黑字可读；标志未就绪时不暴露可录制画面，加载失败保留播放并提示切换或重试。

Three.js 已预留 `createSandboxFrameAdapter(source, options)`：`applyFrame(frame, signal)` 应用时间线、路线、镜头及光照，调用现有同步 `source.renderFrame()` 后，必须经 `composeFrame(canvas, frame, credits, signal)` 合成真实署名和 Logo 才返回捕获 Canvas。它支持取消、超时、过期请求和 `dispose()`；调用方必须在已完成 build 的 Renderer 上使用并在销毁时清理 adapter。本期只提供内部工厂，没有编码器和沙盘导出 UI。

## 后续试验验收

1. 锁定候选包和编码资源版本，验证实际许可证、bundle/CSP 与完全离线的资源加载行为。
2. 以同一条山区轨迹对比起点、中点、终点及镜头切换，验证输出帧数、时间戳、终点画面和署名。
3. 验证网络错误、缺 Key、logo 失败、取消、上下文丢失及大尺寸 Canvas；确认取消后编码器、流轨道和地图资源释放。
4. 核实所选瓦片服务对视频导出的使用条件与访问负载；OSM 公共标准瓦片不用于沙盘离屏高清纹理预取。
5. 接通 Three.js 后再验收地形贴合、可调光影和镜头动画，随后单独决定编码格式、分辨率与导出 UI。