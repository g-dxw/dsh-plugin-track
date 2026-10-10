# Track 0.1.4

日期：2026-10-10。本版修复 Track 0.1.3 在 DSH 0.2.0-rc.2 中因宿主依赖范围不匹配而无法加载的问题。

## 原因与调整

Track `0.1.3` 的六项 DSH peerDependencies 均为 `^0.1.5-rc.1`，上界为 `<0.2.0-0`。DSH `0.2.0-rc.2` 的宿主检查即使开启 `includePrerelease: true`，仍会判定这六项不兼容并拒绝加载。

- 将六项宿主依赖范围改为 `^0.1.5-rc.1 || ^0.2.0-rc.2`：保留旧范围，增加从 `0.2.0-rc.2` 开始的 0.2.x 范围。
- 六项开发接口包固定为 `0.2.0-rc.2`，开发用 Cordis 固定为 `4.0.4`，与新版宿主对齐；Cordis peer 范围仍为 `^4.0.2`。
- 同步根锁文件与随包的 `build-inputs/yarn.lock`，使用新版接口进行构建和验证。
- 核对主面板、侧栏、Slots、WebServer、DSH_HOME 和 Agent 结构接口；当前使用方式仍匹配，新版兼容无需修改业务逻辑或用户数据格式。

## 验证

- 新依赖环境的 immutable 安装、TypeScript 类型检查、服务端与客户端构建通过；Client external 检查通过。
- 全量 Vitest：145 个文件、2731 项测试通过，使用 `--maxWorkers=2`，耗时 101.33 秒；包含真实新版 WebServer 的 HTTP、写入门禁、原文件导出和 Agent 工作区存储测试。
- 发行工具：15 项 Node 测试通过。
- 调用本机真实宿主的 `evaluatePluginCompatibility`，使用宿主要求的 semver `7.8.5` 和 `includePrerelease: true`，验证六项声明的完整矩阵：`0.1.5-rc.1` / `0.1.5-rc.3` / `0.2.0-rc.2` / `0.2.0` 均接受，`0.2.0-rc.1` / `0.3.0-rc.1` 均拒绝；原 `0.1.3` 在 `0.2.0-rc.2` 下确实返回六项不匹配。
- 两份锁文件字节一致；实际安装的六项接口包均为 `0.2.0-rc.2`。开发用 Cordis `4.0.4` 满足新版宿主要求及 Track peer 范围。
- npm 打包清单预览包含 484 个文件，并含编译入口、插件注册、随包锁和本次记录。正式归档由 CI 基于发行提交重新生成源码快照、打包并验证全部源码文件和 SHA-256；校验结果随 Actions artifact 提供。
- 编译入口隔离烟测：14 项检查通过。真实 Cordis `4.0.4` 与 DSH WebServer `0.2.0-rc.2` 可加载 `lib/index.js`，导入测试 GPX、原文件字节导出、插件卸载重载和全新宿主重启后的持久化均通过。
- `lib/client.js` 经实际 DSH `0.2.0-rc.2` renderer 的 SlotRegistry 注册主面板与侧栏；验证延迟声明、声明卸载重建及插件卸载清理。测试由 harness 声明 shell slots，未启动完整 layout/sidebar 或 Electron。

复现脚本与报告位于本机 `outputs/dsh-0.2-compatibility-0.1.4/`，包括 `host-compatibility-smoke.mjs` 和 `runtime-smoke.mjs`。此次使用独立 DSH_HOME 和测试 GPX，未操作真实用户 Profile；完整 Electron 界面、真实 Agent 服务和账户未在本次烟测中验证。

## 安装与来源

在支持插件的 e宝工坊 Desktop 插件管理中添加：

```text
cqai-dsh-plugin-track@0.1.4
```

或使用 DSH 命令行，随后重启宿主：

```sh
dsh plugin --profile desktop add cqai-dsh-plugin-track@0.1.4
```

源码快照由现有 CI 在干净的发行提交上生成；npm 发布使用经过完整校验的同一个 tgz。构建与打包方式见 [BUILDING.md](../../BUILDING.md)，CI 状态见 [Actions](https://github.com/g-dxw/dsh-plugin-track/actions)，发行归档见 [v0.1.4](https://github.com/g-dxw/dsh-plugin-track/releases/tag/v0.1.4)。

此前发行记录见 [Track 0.1.3](track-0.1.3.md)。
