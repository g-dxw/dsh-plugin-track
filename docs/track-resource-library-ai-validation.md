# 轨迹资源库与 AI 图片功能验收

日期：2026-10-05。源码实现和独立浏览器验证完成；未进行真实 DSH Profile 安装或运行验收，未调用真实计费 AI。

## 已实现的操作

1. 轨迹详情的 **资源库** 按钮打开独立页面。详情仍保留在后台，返回时保留已选点位和页面滚动位置。点位已有照片也提供 AI 美化入口，直接选中该照片。
2. 图片、视频、音频支持多文件导入、逐项进度与失败重试。可搜索、筛选、排序、切换网格/列表，修改名称和标签，批量追加标签。
3. 聚合当前轨迹已保存的点位、分组封面、SVG 和二维视频素材中的图片引用。原有图片不需要重新上传。
4. 照片美化发送用户明确选中的原图；文字生图不发送图片。提示词默认空白，模型来自 DSH 已有生图服务。没有可用服务时，素材管理仍可使用。
5. AI 结果先保存为候选，支持原图、结果和左右对照。用户可以保存、丢弃、下载，或追加到现有点位。追加不会替换原照片、点位名称或坐标。
6. 个人提示词模板默认空白，支持新建、编辑、复制、删除与保存当前提示词。参考 e图宝 时按选定来源读取案例，可修改后另存并保留来源。案例图片只供浏览，不作为生成输入；填入提示词不切换生成模式。
7. 视频和音频使用浏览器原生播放器；读取元数据后登记时长和视频尺寸。不能播放的编码会提示，仍可整理和下载。
8. 图片、视频、音频可登记视频用途。视频制作入口展示可预览、可导出的资源清单；二维素材准备可直接选用资源库的已采用图片并保存。
9. AI 任务绑定当前轨迹、来源、提示词、模型和宿主任务编号。页面重开后核对原任务；网络中断或提交状态不明时不会自动再次生成。局部结果保存失败可重试原结果，丢弃结果不会重新出现。

## 存储和服务约定

- 轨迹资源索引：当前 Profile 的 `track/<trackId>/resources.json`。
- 图片沿用原有 `placemark-photos/` 与插件照片 URL、缩略图机制，保留点位/SVG/视频素材的兼容性。
- 视频、音频保存于轨迹目录的 `media/`；读取支持 GET、HEAD 和 HTTP Range。
- 个人模板：当前 Profile 的 `track-resource-templates/templates.json`，初始不存在或为空。
- 文件限制：图片 20 MiB、视频 2 GiB、音频 512 MiB。文件格式依据实际字节验证；不会把 AAC 当 MP3 或把 MKV 当 WebM。
- 已被点位、SVG 或视频素材引用的资源受删除保护。移除资源库图片条目时，原有照片文件仍保留供历史编辑/撤销使用。
- AI 复用 `/api/dsh-imagegen/` 的模型、提交、查询和取消接口。当前宿主任务列表返回摘要，完整结果通过 `tasks/get` 读取。单次生成一张图，尺寸和质量沿用宿主自动设置。

## 本次验证

| 验证 | 结果 |
|---|---|
| `npm.cmd run typecheck` | 通过 |
| `npm.cmd run build` | 通过，客户端 bundle 外部依赖验证通过 |
| 资源库、任务、模板、点位和视频素材相关回归 | 14 文件、153 项通过 |
| 全仓 `npm.cmd test -- --maxWorkers=4` | 113 文件：112 通过、1 失败；2195 项通过、4 项失败 |
| 真实浏览器功能检查 | 14 项通过，0 页面异常、0 API 错误 |

全仓剩余的 4 项失败均在 `tests/sandbox-view.test.ts`，围绕既有 `.trk-sandbox-details` 节点断言。该测试文件和 `src/client/MapView.tsx` 与本次开始时记录的哈希一致；本次没有修改对应沙盘行为。第一次全并发执行还出现过浮动标记超时，限定 4 个 worker 后该文件通过，单独复跑也通过。

浏览器测试运行 **真实 TrackPanel、ResourceLibrary、二维素材准备组件和生产 API/存储**，仅将 DSH_HOME 指向本项目独立 `.cache/resource-library-validation/dsh-home`。图片、视频、音频文件实际上传、保存和播放。

AI 和 e图宝案例响应是明确标注的测试夹具，验证提交参数、宿主任务摘要/完整结果协议、候选保存和使用流程。测试图片不代表真实 AI 美化质量，也不证明真实账户、安装实例或模型能力已验收。

验证材料：

- [浏览器证据](../outputs/resource-library-validation/browser-evidence.json)
- [原工作区文件保留检查](../outputs/resource-library-validation/preservation-evidence.json)
- [资源库桌面截图](../outputs/resource-library-validation/resource-light.png)
- [资源库深色截图](../outputs/resource-library-validation/resource-dark.png)
- [空白模板库](../outputs/resource-library-validation/templates-empty.png)
- [参考模板库](../outputs/resource-library-validation/template-reference.png)
- [AI 原图/结果对比](../outputs/resource-library-validation/ai-comparison.png)
- [窄屏资源列表](../outputs/resource-library-validation/resource-mobile-grid.png)
- [窄屏视频预览](../outputs/resource-library-validation/resource-mobile-video.png)

## 预览与复现

隔离预览地址：`http://127.0.0.1:51228/`。页面顶部明确标注测试夹具，不读写正常 DSH/Beta Profile。

准备测试媒体并在终端一启动预览：

```powershell
New-Item -ItemType Directory -Force .cache/resource-library-validation | Out-Null
ffmpeg -hide_banner -loglevel error -f lavfi -i color=c=0x496876:s=320x180:d=3 -c:v libx264 -pix_fmt yuv420p -an -y .cache/resource-library-validation/travel-test.mp4
ffmpeg -hide_banner -loglevel error -f lavfi -i sine=frequency=440:duration=3 -c:a pcm_s16le -y .cache/resource-library-validation/ambient-test.wav
node outputs/resource-library-validation/server.mjs
```

在终端二运行检查；脚本使用本机 Codex 捆绑的 Playwright 和浏览器路径：

```powershell
node outputs/resource-library-validation/browser-validation.mjs
```

浏览器检查脚本仅重置该预览的资源索引、点位编辑和测试模板；不会重置正常 Profile。所用 JPEG、MP4、WAV 测试文件保存在 `.cache/resource-library-validation/`；MP4/WAV 来自本机 FFmpeg 测试输入。截图、脚本和证据保留为交付材料，探索用临时探针与失败截图已清理。

## 尚未实现或未验证

- 外部视频片段、音频的合成时间轴、混剪、混音与导出，仍需后续接入。目前提供素材清单和原生预览。
- 未实现批量 AI、多图输入或画幅/质量选项；本期明确采用宿主单图接口。
- 未进行真实 DSH 已安装运行验证、账户/模型的实际计费调用，也未发布或提交代码。
- 工作区原有未提交工作保留。本次有意改动的既有文件为 TrackPanel、TrackOverview、TrackVideoScript、VideoMaterialPrep、imagegen、index、track-agent-context 和相关测试；其余新增资源功能文件详见源码目录。
