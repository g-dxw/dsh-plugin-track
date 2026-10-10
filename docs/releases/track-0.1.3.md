# Track 0.1.3

日期：2026-10-10。

本版将 `0.1.0-beta.3` 的功能以 `0.1.3` 稳定版发行。此次调整版本号与构建发布流程，没有新增或删除插件功能；资源库、AI 图片创作、地图与 SVG 导出、OpenMontage 策划和共用镜头工作台继续保留。

## 发行调整

- 发行版本改为不带预发布后缀的 `0.1.3`，用于 npm `latest` 的稳定版安装入口。
- 新增 [CI 工作流](../../.github/workflows/ci.yml)：支持分支 push、Pull Request、手动触发和发行流程复用；使用 Node.js 24 与 Yarn 4.18.0 执行依赖安装、类型检查、构建、测试、源码快照和 npm 打包，上传 tgz 及校验文件。
- 新增 [发布工作流](../../.github/workflows/publish.yml)：在 `v*` tag 推送或手动选择已有 tag 时复用 CI，下载并复核同一个 tgz 后发布到 npm。使用 npm 12.0.2，默认通过 OIDC Trusted Publisher 授权；手动运行可显式选择仓库 `NPM_TOKEN`。稳定版使用 `latest`，预发行版使用 `beta`。
- README 与 CQAI Club Plugin Market 录入 JSON 同步为 `0.1.3`。市场配置保留已有介绍、宿主要求和实际截图，仅更新当前版本、安装命令及发行链接。
- DSH 接口包依赖范围仍为 `^0.1.5-rc.1`。本次发行没有扩大宿主接口兼容范围；采用 0.2.x 接口包的 Desktop 需要相应的兼容版本。

## 验证

- 本地 immutable 依赖安装、类型检查通过。
- 本地构建与 Client external 检查通过。
- 全量 Vitest 145 个文件、2731 项测试通过，耗时 106.03 秒，使用 `--maxWorkers=2`。
- 发行工具的 15 项 Node 测试通过，覆盖归档篡改、文件遗漏、路径安全和 npm 11 / 12 打包报告兼容。
- CI 将独立执行相同构建检查并校验完整 tgz。执行状态见 [CI 记录](https://github.com/g-dxw/dsh-plugin-track/actions/workflows/ci.yml)，发行包的校验报告与 SHA256SUMS 随 Actions artifact 提供。

此前功能变更与验证记录见 [0.1.0-beta.3 发行说明](track-0.1.0-beta.3.md)。

## 安装与来源

在支持插件、且接口版本符合要求的 e宝工坊 Desktop 插件管理中添加：

```text
cqai-dsh-plugin-track@0.1.3
```

也可以使用 DSH 命令行，随后重启应用：

```sh
dsh plugin --profile desktop add cqai-dsh-plugin-track@0.1.3
```

发行包的对应源码与构建步骤见 [BUILDING.md](../../BUILDING.md)，许可及版权说明见 [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)。本版 GitHub 发行页为 [v0.1.3](https://github.com/g-dxw/dsh-plugin-track/releases/tag/v0.1.3)。
