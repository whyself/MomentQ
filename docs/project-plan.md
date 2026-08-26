# 刻问（MomentQ）项目规划

## 1. 项目定位

刻问是面向 B 站录播视频与直播的“视频时刻上下文 Agent”。用户在观看时通过快捷键针对当前时刻提问，系统基于当前帧和字幕回答，并提供可回跳的时间证据。

暂定名称：刻问（MomentQ）  
产品短句：看到这里没懂？就在这一刻问。

## 2. MVP 范围

- 平台：Windows，Chrome/Edge，B 站视频与直播。
- 交互形态暂不确定；仅要求浏览器侧能够捕获当前内容、时间点并提交问题，具体设计留到交互阶段讨论。
- 视觉输入：每次提问至多上传当前帧一张；与画面无关时可不上传。
- 不保存视频或音频，不做视频下载、片段缓存、多帧分析及向量数据库。
- 每个视频分 P、每场直播分别绑定一个持久 DSH Session。
- 新 Session 可以设置一次自定义回答指令；为空时使用 MomentQ Host 配置的默认指令，创建后不再覆盖。

## 3. 内容与 Session 身份

- 录播：`bilibili:vod:{bvid}:{cid}`。
- 直播间：`bilibili:live-room:{canonical_room_id}`。
- 单场直播：`bilibili:live:{canonical_room_id}:{live_start_time}`。
- 同一直播刷新、断线重连时恢复原 Session；同一直播间重新开播时创建新 Session。
- 标题仅用于展示，不参与唯一性判断。

## 4. 字幕策略

字幕优先级固定如下：

1. 进入页面后先探测并实际提取 B 站字幕。
2. 成功取得非空字幕正文时，导入字幕并禁止启动实时 ASR。
3. 无字幕或提取失败时，仅展示“可开启实时字幕”；用户主动开启后才连接 ASR。
4. 第一家实时 ASR Provider 暂定百度实时语音识别。
5. 只保存 ASR 最终结果；临时结果仅用于界面显示。
6. 不混合 B 站字幕与 ASR 字幕，不保存音视频原始数据。

百度接入由本地伴随服务完成，密钥不得放入浏览器扩展。音频统一转换为 `16kHz / 16bit / mono PCM`，通过 WebSocket 连续发送。单连接接近一小时时主动续接。

## 5. 增量实时转录

- 拖动进度：提交已确认字幕、丢弃未确认临时句，结束当前 ASR Run，并从新播放时间创建 Run。
- 暂停：短暂停保活，长暂停关闭连接；恢复后写入同一字幕文档。
- 倍速：记录播放速率及每段的媒体开始/结束时间；高倍速可能降低准确率。
- 已覆盖区间默认不重复转录，避免重复内容和计费。
- 跳过而未播放的区间保持为空，不在字幕正文中写入“未转录”伪字幕。
- 直播只能积累开启转录之后的内容；此前内容标记为未覆盖。

## 6. Agent 上下文与工具

每次提问只提供：

- 当前问题；
- 当前播放时间；
- 当前时间附近较宽范围的字幕；
- 当前帧（至多一张，可选）。

不额外生成视频摘要或对话历史摘要。同一 Session 的自然对话历史由 DSH 自身处理。

Agent 直接使用 DSH 原生只读工具：

- `grep`：按术语或时间文本搜索 `transcript.jsonl`；
- `read`：读取命中位置附近的字幕行。

不实现专用字幕检索工具，不开放 `write`、`edit`、Shell 或任意文件访问。Agent Workspace 仅指向当前内容目录。

Agent 使用固定的 `momentq` Preset，新 Session 默认模型为 `deepseek-official / deepseek-v4-flash-vision-exp`。工具 Schema 由 DSH 自动注入；MomentQ 只包装 DSH 原生工具，将 `grep` 和 `read` 都固定到当前 `cwd/transcript.jsonl`，模型不能指定文件或目录。

## 7. 本地数据

部署必须配置一个总目录 `MOMENTQ_DATA_ROOT`，并把 `DSH_HOME` 设置为其 `dsh-home` 子目录。MomentQ 内容与 DSH 原生 Session 均在该总目录内持久化：

```text
<MOMENTQ_DATA_ROOT>/
├─ content/bilibili/{vod|live}/{content-id}/
│  ├─ state.json
│  └─ transcript.jsonl
└─ dsh-home/
   └─ ...DSH 原生 Session、设置、凭据与附件...
```

`state.json` 保存内容身份、标题、简介、UP 主／主播、分 P、时长、标签、直播场次信息、字幕来源、字幕覆盖区间、当前 DSH Session 及已归档／删除的 Session 记录。标题和其他元信息只用于展示与模型背景，不参与唯一性判断。

`transcript.jsonl` 每行保存一条最终字幕段，包含开始时间、结束时间和正文，便于 DSH 原生 `grep`/`read` 使用。

`state.json` 只由 MomentQ Host 写入；后续字幕导入和 ASR 模块必须通过 Host API 更新状态。Docker 部署只能 bind mount 总目录，不能把唯一数据副本放在容器可写层。

## 8. 组件边界

- 浏览器扩展：作为 B 站连接层，识别页面、获取当前时间与播放器状态、捕获当前帧和标签页音频；具体交互形态暂不确定。
- 本地伴随服务：百度鉴权与 WebSocket、ASR Run 管理、字幕持久化、Session 路由及 DSH 接入。
- DSH Agent：根据已提供字幕直接回答；证据不足时用 `grep`/`read` 补查字幕。

MomentQ Host 在 DSH loopback WebServer 上注册 `/momentq/api`，并随 Bundle 提供浏览器安全 SDK。第一版接口覆盖内容创建／恢复、状态读取、Session 归档／重置／删除和完整内容删除；接口只接受内容身份，不接受 cwd、Session ID、Preset ID 或任意路径。

本地 MVP 不强制使用 Docker；Provider 保持抽象，后续可增加腾讯、火山、Deepgram 或本地 ASR，而不修改字幕与 Agent 层。DSH 运行层独立放在 `dsh/`，由原生 runtime 或 Docker 发行版携带固定的 DSH 框架与 MomentQ Bundle；浏览器扩展和其他应用组件放在根目录 `packages/`。

