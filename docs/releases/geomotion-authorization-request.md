# GeoMotion 镜头引擎授权询问

> 历史记录（2026-10-07）：后续 npm beta.2 已记录发布者于 2026-10-08 确认取得分发权限。当前发行说明见 [0.1.0-beta.3](track-0.1.0-beta.3.md)。

状态：暂缓发送，继续本地验证。没有向作者发送消息，也没有发布插件安装包。

当前安排：保留新镜头编辑器继续本地验证，授权询问和对外发布暂缓。后续分发仍需确认对应权限。

## 核查结果

核查日期：2026-10-07。

- [官方仓库](https://github.com/databandar/geomotion) 默认 main 与当前引用的固定提交相同：`a911219b1f0d704aa10f1fc915df65c21f612ec1`。
- [固定提交的完整文件树](https://api.github.com/repos/databandar/geomotion/git/trees/a911219b1f0d704aa10f1fc915df65c21f612ec1?recursive=1) 共 245 个文件，没有源码许可证或授权文件；13 个 package.json 没有 license/licenses 字段。
- [仓库元数据](https://api.github.com/repos/databandar/geomotion) 的 license 为 null；README 和文档没有声明源码使用授权。
- [全部 Issues](https://api.github.com/repos/databandar/geomotion/issues?state=all&per_page=100) 当前为空，未发现既有授权讨论。
- [作者公开主页](https://github.com/databandar) 没有公开邮箱或个人网站。可通过 [GitHub Issue](https://github.com/databandar/geomotion/issues/new) 联系。

当前本地 [SOURCE.md](../../src/track/vendor/geomotion/SOURCE.md) 明确要求：

> Confirm upstream permission before redistribution or a plugin release containing this code.

当前的 AGPL-3.0-only 是 Track 插件的许可证；现有来源记录没有将其当作 GeoMotion 快照的授权。收到回复后，需记录适用文件、固定提交、源码与编译包分发范围、修改权限以及署名条件，再完成发布。

## 待发送标题

License / permission request for integrating the GeoMotion core into an AGPL-3.0-only Track plugin

## 待发送正文

Hi,

I'm preparing a release of Track (`cqai-dsh-plugin-track`), a hiking-track plugin:
https://github.com/g-dxw/dsh-plugin-track

We have integrated a 56-file snapshot from GeoMotion commit
`a911219b1f0d704aa10f1fc915df65c21f612ec1`, covering the core, document,
animation, geometry, evaluator, entities, renderer, and map packages.

For the copied upstream files, our changes are limited to rewriting
internal package imports as relative imports and normalizing LF line
endings and final newlines. We maintain a file-by-file source manifest:
https://github.com/g-dxw/dsh-plugin-track/blob/cede24428659e41e7c0632c02aa031ad0293188f/src/track/vendor/geomotion/source-manifest.json

The surrounding Track interface and storage integration are separate
plugin code.

The integration is currently on a public development branch; no plugin
package containing this snapshot has been released. We would like to
offer a free trial to friends, followed by public releases of the plugin
source and compiled packages under AGPL-3.0-only.

I could not find a source-code license in the repository or its package
manifests, so we are not assuming that the public repository grants
permission to redistribute or relicense these files.

Would you be willing to add an explicit open-source license compatible
with this use, or provide explicit permission covering this 56-file
snapshot?

In particular, we need permission to retain and adapt the snapshot,
distribute the original and modified source, and distribute compiled
plugin packages, including the downstream rights required by
AGPL-3.0-only. Please confirm whether the grant applies to the files
at the commit above and whether you require any additional notices
or conditions.

We will retain upstream copyright and attribution, link to GeoMotion,
and document the commit and modifications. We do not claim ownership
of the upstream code.

Thank you.

## 当前发布准备

- 首版候选版本：`0.1.0-beta.1`，保留新镜头编辑器。
- 已从提交 `cede24428659e41e7c0632c02aa031ad0293188f` 创建独立构建副本，未包含其他工作区改动。
- 构建及客户端外部依赖检查通过；本地 tgz 为 1,320,512 字节，具有后端、客户端、插件注册补丁与现有来源文档。
- 候选包只用于本地检查，授权明确前不上传或交付朋友。没有创建 Release 或版本标签。
- 授权明确后再补许可文本、来源声明及对应源码，验证宿主安装，发布可安装 tgz、对应源码与 SHA-256。
- 朋友通过易宝工坊的“插件管理 → 添加插件”安装 tgz；试用包仍可能需要联网安装运行依赖。
