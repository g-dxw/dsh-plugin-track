# 轨迹 0.1.0-beta.1 本地候选包验证

> 历史记录（2026-10-07）：后续 npm beta.2 已记录发布者于 2026-10-08 确认取得分发权限。当前发行说明见 [0.1.0-beta.3](track-0.1.0-beta.3.md)。

日期：2026-10-07。

当前安排是继续本地验证，保留地图镜头编辑器；授权询问和对外发布暂缓。

## 候选包

- 版本：`cqai-dsh-plugin-track@0.1.0-beta.1`。
- 基于已提交的 `cede24428659e41e7c0632c02aa031ad0293188f` 独立构建，未加入其他工作区改动。
- tgz 共 7 个文件，大小 1,320,512 字节，包含后端、客户端、插件注册补丁、包配置、README、来源声明和许可证文本。
- SHA-256：`24732ebff5ef4840075f8b4dd86c0e459e9cd49272f93780eb8d0c2f02e1211f`。
- 本地候选包与验证证据位于 `outputs/releases/track-0.1.0-beta.1/`，由 Git 忽略；候选包未上传或交付朋友。

## 隔离安装和运行

在全新的 `isolated-install` 目录中使用 npm 安装候选 tgz 和明确版本的宿主服务依赖。禁止安装脚本，不修改应用的实际 Profile 或用户数据目录。

后端从实际安装后的 `node_modules/cqai-dsh-plugin-track/lib/index.js` 加载。已安装的前后端字节哈希与候选构建一致，所有检查使用合成轨迹与本地生成的测试图片。

已通过的后端检查包括：

- 真正 Cordis / WebServer 启动及空库读取。
- 六个轨迹点、两段路线导入，坐标和分段保留。
- 中文原文件下载名正确，源文件逐字节一致。
- 标注点编辑保存、镜头工程独立保存，以及过期修订号的冲突保护。
- 服务器重启后恢复点位编辑与镜头工程，源文件及坐标保持不变。
- 新安装的 Sharp 原生依赖可用，本地照片上传成功。
- 缺少应用写请求头时被拒绝。

## 界面验证

通过实际安装包的 lib/client.js 与 __ModuleLoader__.load，在最小模拟 slots 中挂载真正 TrackPanel，所有插件 API 连接上述真实后端。

- 从界面导入七点合成 GPX，并进入视频制作。
- 二维素材准备打开并保存成功。
- 地图镜头俯仰调整为 37°，保存后整页刷新恢复同一修订版本。
- 播放头跳到 16 秒后，原生 1280×720 Canvas 有实际绘制，已检查恢复截图。
- 编辑前后源文件、轨迹及点位文件哈希一致。
- 页面异常、控制台错误、请求失败均为 0。

本轮确认 terrain=false 的保存恢复，未验收地形关闭的视觉效果，也没有对在线地图质量作结论。

## 范围与证据

本次是安装包、真实 HTTP 服务和最小宿主界面的本地检查，不代表完整 Electron/DSH Loader、实际模型账号或朋友电脑上的安装验收。没有消耗模型调用，也没有改动现有应用 Profile。

- `package-validation.json`：包内容与校验和。
- `local-validation/installed-runtime-report.json`：实际安装入口、隔离数据路径与后端检查。
- `local-validation/browser/browser-report.json` 与截图：真实打包客户端的界面与渲染证据。
- `local-validation/browser/README.md`：本地重复验证步骤。
- `local-validation/preservation-report.json`：其他 121 个原有工作区文件哈希保持一致，暂存区为空，HEAD 未变。
- `candidate-status.json`：本地验证状态，`authorContacted: false`、`publicReleaseCreated: false`、`notForDistribution: true`。

GeoMotion 的分发权限仍未明确；没有创建 Release、发布版本标签或向作者发送 Issue。
