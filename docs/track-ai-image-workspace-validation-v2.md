# 轨迹 AI 图片创作：第二版实现与验证

日期：2026-10-05  
设计依据：[第二版 UI 布局](track-ai-image-workspace-ui-v2.md)

## 已实现的布局与交互

- 资源库保留独立页面，管理图片、视频、音频；顶部原“生成图片”入口改为“历史记录”。资源详情和多选图片进入独立 AI 创作页。
- AI 创作页采用左侧结果预览、右侧创作配置。统一“生成图片”按钮；主体与效果参考分别支持多张图片、上传、多选、排序、移动分组和主图设置。
- 有任意参考图则图生图；两组为空则文生图。仅效果图也可提交。效果图不会被当作“原图”参与对比。
- 历史卡片使用任务实际生成图，可切换多张结果作为封面；点击封面恢复完整输入及所选结果。放大按钮只预览。
- 恢复保留参考图角色和顺序、用户原提示词、模型、服务通道、模板版本和生成设置。恢复不提交，重新生成新建任务并关联来源，原快照不可改写。
- 当前修改可以先保留，再恢复历史；草稿按轨迹持久保存。历史参考文件缺失、模型不可用或参数不支持时保留原值，并阻止无效提交。
- 资源库、创作页、历史页以及视频制作往返保留当前输入与选择。生成结果先作为候选，保存后才用于点位或视频素材。
- 我的提示词模板初始为空，支持用户添加以及参考 e图宝案例；案例图不会自动成为参考图。

## 验证结果

| 检查 | 结果 |
|---|---|
| TypeScript 类型检查 | `npm.cmd run typecheck` 通过 |
| 构建及客户端外部依赖检查 | `npm.cmd run build` 通过 |
| 本功能及相邻集成测试 | 16 个文件，208 项全部通过 |
| 最终独立全量运行 | 115 个文件，2250/2254 项通过；4 项既有沙盘断言失败 |
| 浏览器主流程 | 17 项通过，无浏览器异常或 API 错误 |
| 历史缺失参考图 | 2 项通过：保留缺失输入、阻止生成；显式移除后恢复可提交状态 |
| 无关工作保留 | 本次基线中的无关文件 SHA256 未变化；MapView、沙盘和浮动点位测试文件未修改 |

全量失败集中于 `tests/sandbox-view.test.ts` 的四个 `.trk-sandbox-details` 相关检查，与第二版开始前的失败一致。对应源码与测试的基线哈希保持不变，未修改此模块。

并行执行浏览器、类型检查和测试时，浮动点位模块另有两项失败；该模块单独复核 12/12 通过，最终仅运行测试、`--maxWorkers=2` 时也全部通过。保留两轮报告供复核。

浏览器使用真实 TrackPanel、图片创作、历史、点位和资源 API；生图模型目录、宿主任务响应及输出图片是明确标记的测试夹具。实测传递了 2 张主体图和 1 张效果图、生成两张结果，并核对原提示词与实际提交提示词分别保存。验证了仅效果图、无参考图、历史恢复、再次生成、草稿重载、点位追加和视频素材往返。

## 预览和证据

隔离预览：[http://127.0.0.1:51229/](http://127.0.0.1:51229/)。从测试路线进入资源库，再选择“AI 图片创作”或“历史记录”。预览页明确显示“AI 响应为测试夹具，未调用真实生图服务”。

数据目录为仓库 `.cache/resource-image-v2-validation/dsh-home`；没有安装到正常 DSH Profile，也没有提交、推送或发布。

- [浏览器主流程证据](../outputs/resource-image-v2-validation/browser-evidence.json)
- [缺失参考图证据](../outputs/resource-image-v2-validation/missing-reference-evidence.json)
- [相关测试汇总](../outputs/resource-image-v2-validation/focused-test-results.json)
- [最终全量测试报告](../outputs/resource-image-v2-validation/full-test-results-solo.json)
- [并行全量测试报告](../outputs/resource-image-v2-validation/full-test-results.json)
- [浮动点位单独复核](../outputs/resource-image-v2-validation/floating-recheck.json)
- [文件保留检查](../outputs/resource-image-v2-validation/preservation.json)

### 创作配置

![独立创作页](../outputs/resource-image-v2-validation/creation-light.png)

### 历史任务图库

![生成图作为历史任务封面](../outputs/resource-image-v2-validation/history-results.png)

### 缺失参考图恢复

![缺失输入保留并阻止提交](../outputs/resource-image-v2-validation/history-missing-reference.png)

其他截图：深色主题、任务结果对比、手机创作配置和手机历史图库均保存在相同证据目录。

## 实际使用边界

复用现有 DSH 生图宿主。已根据当前宿主代码验证参考图的传递顺序、最多 5 张的转发上限、单图 10 MiB 和请求合计 24 MiB 限制；多图数量与设置仍按模型目录能力约束。宿主能传递多图不代表所有上游模型都接受这些图片，真实账号和模型的生成效果尚未验证。

没有调用计费 AI 服务，也没有验证真实账户登录或额度。真实环境的服务错误会保留在任务中；状态不明时不会自动重新提交。
