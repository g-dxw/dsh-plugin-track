# OpenMontage 本机接入

插件不内置 OpenMontage。安装源码及所需 Python 环境后，从 Track「脚本策划」保存连接设置。Backlot 只绑定 loopback 空闲端口，退出仅终止本插件创建的进程；没有修改外部源码或宿主 iframe 安全设置。

插件启动的 Backlot 项目页及项目库使用中文显示层，覆盖阶段、状态、操作、确认提示、素材和数量信息。SSE 或弹窗重绘后仍保持中文；项目标题、脚本正文、JSON、文件名及原生阶段 key 保持原样。中文脚本随插件发布，外部 OpenMontage 安装文件无需修改。

策划工作台集中显示项目选择、三个策划阶段的确认进度和下一步提示；新建项目与连接设置按需展开。镜头清单支持按编号、画面、旁白搜索，以及待制作 / 已回填筛选；旁白、素材及历史录制详情按需查看。收起清单、专注看板与窄屏面板切换保持同一个 iframe，不重载当前看板。离开策划页仍卸载 iframe；隐藏的清单视频暂停播放。

随包的看板显示适配层提高中文可读性、深浅主题对比度与控件触控区域，保留原生阶段及分镜顺序。看板主题随宿主同步，通信只包含主题与可见状态，并核对 iframe 来源；隐藏看板时暂停其中的媒体和制作回放，再次显示时不自动播放。阶段、脚本、回放及视频控件支持键盘；弹窗限制 Tab 范围并在关闭时恢复焦点，原生重绘后也保留键盘位置。此层不改变原生批准流程或项目成果。

## 接口

接口均位于 `/api/cqai-track/`，沿用 Track 本机、同源和写请求 `x-cqai-track: 1` 保护。

| 接口 | 内容 |
| --- | --- |
| `openmontage-settings` GET/POST | 设置、Python/schema/pipeline 检测和具体问题 |
| `openmontage-projects` GET/POST | 按轨迹列项目，新建原生 hybrid 项目 |
| `openmontage-state` GET | 真实 Backlot 状态、摘要、批准、镜头和视频版本 |
| `openmontage-events` GET | 转发本项目的原生 Backlot SSE |
| `openmontage-agent-workspace` POST | 指引、素材快照、项目工作区和绑定会话 |
| `openmontage-agent-session` POST | 绑定独立宿主原生会话 |
| `openmontage-commit` / `openmontage-approve` POST | 原生阶段写入、具体摘要及对话批准依据 |
| `openmontage-shot` POST | 已批准 scene_id 关联地图或沙盘镜头 |
| `openmontage-shot-result` POST | 原始 MP4/WebM 回填、幂等 takeId、版本校验 |
| `openmontage-media` GET/HEAD | 项目不可变视频播放及 Range 请求 |

地图、沙盘工程及备份接口增加可选 `projectId`、`shotId`（必须同时提供）。省略作用域继续访问既有轨迹工程，字段和关键帧保持不变。

## 原生 Agent 与数据边界

Session cwd 固定项目目录。SDK 无 env 入参，因此项目环境声明和随包的 `scripts/openmontage_bridge.py` 加载统一的 `PYTHONPATH`、`OPENMONTAGE_PROJECTS_DIR`、`PYTHONDONTWRITEBYTECODE` 及 DSH_HOME 缩略缓存。阶段请求通过薄桥调用原生库，不依赖聊天文本推测状态。

宿主需要 workspace/session catalog、独立 cwd、session retain 和 scoped conversation.send 能力；不支持时明确提示，不退回直接模型请求。Agent 只在用户主动操作时打开或接受请求。独立网页预览能验证看板及回填，不能代替宿主会话验收。

地图录制用 `screen_recording` 和 `required_assets.source="record"`。绑定写 `scene_plan.metadata.track_shots`，不向严格场景 schema 添加字段。技术关联字段不影响叙事摘要，关联身份仍需单独核验。

输出前重新核对当前分镜及批准状态，输出冻结 project/shot/scene、分镜摘要、工程修订、editor 及 takeId。上传遵循资源库视频限制，使用本机 FFprobe 检测真实格式、尺寸、时长和帧率；FFprobe 缺失会报错，不自动安装。资源库或 manifest 写入失败保留不可变视频，重试同一 takeId。部分回填不推进整片合成。

同一视频制作工作区内切换镜头会保留未回填的视频 Blob、冻结身份和重试状态；重新进入该镜头创建新的下载 URL，退出渲染器释放旧 URL。关闭工作区后内存视频会释放，需要长期保留时先下载或回填。已写入项目的视频和历史版本不依赖浏览器内存。

## 验收

分别记录原生 Agent 调用、实际看板连接、真实地图及沙盘输出的证据。不可把 mock 接受消息或测试脚本写入当成模型运行成功。验证阶段 schema、批准失效、并发写入和中断恢复、作用域保存、版本冲突、旧稿备份、桌面及窄屏。
