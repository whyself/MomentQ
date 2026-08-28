# MomentQ Companion

本地伴随服务：为浏览器扩展编排百度实时语音识别（后续可插拔其他云端或本地 Provider）。本包不嵌入 DSH 框架，也不保存任何服务密钥副本。

## 音频链路

1. 扩展通过 `chrome.tabCapture` 抓取**当前标签页**的音频（其他标签页不会混入），在 offscreen 文档里降采样为 `16kHz / 16bit / mono PCM`，静音段（暂停、静音）直接丢弃。
2. PCM 帧经**本机回环 WebSocket**（默认 `ws://127.0.0.1:3090`）发送到 companion；原始音频只在扩展与 companion 之间传输，不落盘、不出本机、不经过任何远端（百度只收到识别流）。
3. companion 维持到百度 `wss://vop.baidu.com/realtime_asr` 的一路连接：OAuth 换取 access token、START 握手、心跳忽略、句级 `final_result` 断句、接近一小时主动续接。
4. companion 用扩展定期发来的 `clock`（媒体播放时间）把每个句子的音频相对时间锚定到媒体时间轴；拖动进度会被检测为 seek，丢弃进行中的句子并裁剪覆盖到新播放位置之后的段落。
5. 每句最终结果即时通过 Host 的 `syncTranscript(identity, 'asr', segments)` 全量替换写入 `transcript.jsonl`，与 B 站字幕（`source='bilibili'`）同构。

密钥（`BAIDU_ASR_APP_ID` / `BAIDU_ASR_API_KEY` / `BAIDU_ASR_SECRET_KEY`）只存在于 companion 进程环境；扩展仅持有 companion 地址与 provider 选择，不接触任何 ASR 凭据。

## 运行

```powershell
$env:BAIDU_ASR_APP_ID = "..."
$env:BAIDU_ASR_API_KEY = "..."     # 即百度智能云 API Key
$env:BAIDU_ASR_SECRET_KEY = "..."
pnpm --filter momentq-companion build
node dist/index.js
```

环境变量：`MOMENTQ_COMPANION_PORT`（默认 3090）、`MOMENTQ_HOST_BASE_URL`（默认 `http://127.0.0.1:3182`）、`BAIDU_ASR_DEV_PID`（默认 80001 中文普通话）。未配置密钥时服务照常启动，`GET /health` 返回 `configured:false`，开始转录会得到 `provider-not-configured` 错误。

## Provider 边界

Provider 是 companion 内部的可插拔接口：云端（百度先行，腾讯/火山/Deepgram 可后续增加）与本地模型（如 FunASR、sherpa-onnx 真流式引擎）实现同一接口。接入新 Provider 不需要改动扩展与字幕层；扩展与 companion 之间只交换播放时钟、provider 选择与最终字幕段。
