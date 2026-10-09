# 剪辑式多轨时间轴验收

日期：2026-10-04；分支 `codex/geomotion-integration`。按用户确认的「剪辑软件式：统一秒刻度，多条轨道，拖动关键帧和地名片段」替换原时间轴。

## 体验与操作

新版独立预览：<http://127.0.0.1:51217/>；启动命令 `node outputs/geomotion-timeline-verification/server.mjs`。它使用实际插件组件和生产工程存储模块，保存到独立的 `outputs/geomotion-timeline-verification/runtime/dsh-home`。原 51216 服务与已保存工程保留。尚未验证已安装 DSH Desktop 的实际宿主挂载。

- 相机、路线、地名、文字共用秒刻度、贯穿各轨的播放头和同一滚动坐标。左侧轨道名称与顶部刻度固定，轨道区域内部滚动。
- 钻石关键帧可拖动；路线和地名片段可整体移动、拖动两端裁剪。移动路线会平移其绘制动画关键帧，裁剪只改变显示窗口。
- 支持缩放、适应全长、按帧吸附、方向键移动一帧、Shift + 方向键移动十帧。右侧秒数输入保留。
- 显示隐藏图层可切换；锁定图层保持只读。播放和导出期间锁定工程编辑。
- 每次完整拖动只产生一条撤销记录；Escape、窗口失焦或指针取消保留原位置。指针与数值调时都防止撞到另一关键帧而删除它。
- 片段至少保留一帧；零长度或不足一帧的导入片段移动时，明确保留移动语义。片尾边界使用准确的已验证时间，避免浮点误差导致保存拒绝。

## 验证结果

- `corepack.cmd yarn typecheck` 通过。
- `corepack.cmd yarn vitest run --maxWorkers=2`：95 个文件、1826 项全部通过。默认并发首轮为 1825 通过、1 个原有 50 万点轨迹用例超过 5 秒；该文件单独重跑 30/30 通过，再以两 worker 完整复核通过。未修改超时设置或旧轨迹编辑代码。
- 新专项：时间几何/帧吸附/冲突 12 项，时间轴 UI 与实际属性联动 21 项，路线/地名动画时间窗口 6 项；原编辑器 16 项也通过。
- `corepack.cmd yarn build` 通过，客户端外部依赖检查仅为 React 与 JSX runtime。保留原 MapLibre 同时静态/动态导入的构建提示。
- 实际 Chromium/WebGL 检查：各行与刻度的左边界和宽度完全一致；关键帧拖动、帧步进、碰撞、撤销重做；路线和地名片段移动、双端裁剪；数值替代输入、显隐过滤；缩放后滚动寻时；保存刷新恢复均通过。
- 浅色、深色、390px 窄窗口通过。窄窗口 300 秒工程「适应全长」实测 clientWidth=scrollWidth=353、scrollLeft=0；起止刻度标签不溢出、不互相覆盖。
- 播放锁定、取消导出恢复、随后再次导出成功。最终 pageerror 与 error/warning console 均为空。

浏览器脚本与完整证据：`outputs/geomotion-timeline-verification/browser-validation.mjs`、`browser-evidence.json`。重跑脚本会重置该脚本自己的 51217 隔离工程到原 51216 保存文件的副本；不写原预览工程。

## 实际视频与原数据

`timeline-edited-intro.webm` 为武功山反穿真实 2191 点、两个原始分段的环境介绍。FFprobe 确认 VP9、1920×1080、24 fps、144 帧、6.000000 秒，大小 4499526 字节。

将「绝望坡」片段通过时间轴和数值输入调整为 1–5 秒后，视频解码第 4 秒显示该地名，第 5.5 秒已消失；两段路线、真实地形和来源署名正常。证据为 `ffprobe-evidence.json`、`video-at-4.png`、`video-at-5_5.png`。

`track.json`、`source.kml`、`placemark-state.json` 原件和隔离副本的 SHA-256 均未变化；51216 的原工程保存文件未变化。56 个 GeoMotion vendor 源码文件仍与来源清单哈希一致，本轮没有新增依赖或修改 vendor 快照。截图为 `timeline-light.png`、`timeline-dark.png`、`timeline-mobile.png`、`timeline-light-context.png`。

## 委派与范围

三个继承主任务配置的子代理分别完成时间几何、原生时间轴、专项 UI 测试，未指定模型或推理覆盖。主任务负责编辑器接入、路线动画平移、数值冲突保护、边界回归、真实浏览器、视频解码、全量测试与构建；核心代理随后只读审查并发现两个片段边界问题，主任务修复并纳入回归。

该验收阶段修改仅为当前分支的本地集成代码，未提交、推送或发布；原有输出和相邻参考仓库保留。整体功能与源码许可边界见 `geomotion-integration-validation.md` 和 `../PROVENANCE.md`。
## 2026-10-07 开发分支保存

本轮按用户要求单独提交地图镜头、时间轴、素材准备及相关草稿。武功山位置介绍的可复用工程见 `../examples/wugongshan-location-preview/`；本地历史视频、截图、用户原始资料和运行缓存不随源码提交。
