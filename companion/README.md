# MomentQ Companion（规划中）

本地伴随服务承载全部与音频相关的职责：标签页音频捕获、转码（`16kHz / 16bit / mono PCM`）、实时 ASR 编排、ASR Run 生命周期与字幕持久化。本包不嵌入 DSH 框架，也不保存模型 API Key 以外的任何服务密钥副本。

## ASR Provider 边界

字幕抓取（浏览器扩展内完成）与语音识别（companion 内完成）是两条独立来源，产出同一种片段格式 `{ start, end, text }`，最终都通过 MomentQ Host 的 `syncTranscript(identity, source, segments)` 写入 `transcript.jsonl`：

- B 站 AI/原生字幕：`source = 'bilibili'`，由扩展导入；取得有效字幕后禁止启动 ASR。
- 语音识别转录：`source = 'asr'`，由 companion 产出；仅在无字幕或用户主动开启时运行。

Provider 是 companion 内部的可插拔接口，扩展不感知具体实现：

- Provider 以 `{ id, label }` 描述注册；云端服务商（第一家暂定百度实时语音识别，后续可加腾讯、火山、Deepgram 等）与本地模型（如 whisper 系）实现同一接口。
- 所有云服务商密钥（API Key / Secret Key / Access Token）只存在于 companion 进程；扩展与 Side Panel 设置仅持有 companion 地址和 provider id。
- 扩展与 companion 之间只交换播放状态、provider 选择与最终字幕段；不传原始音频与密钥。
- 长连接（如百度 WebSocket）在接近时限时由 companion 主动续接；只保留最终结果，临时结果仅用于界面显示。

在 provider 落地前，扩展的播放/暂停悬浮控件只切换本地转录状态，不代表 ASR 已在工作。
