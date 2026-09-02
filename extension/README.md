# MomentQ Browser Extension

`extension/` 是 MomentQ 独立的 Chrome/Edge 浏览器前端，不是 DSH 插件。
它识别当前 B 站视频、分 P 或直播上下文，并提供独立 Side Panel。

可见界面直接复用锁定的 DeepSeek Harness WebUI 源码、CSS Modules、设计
tokens 和图标。锁定版本及不可变更规则见 `UPSTREAM.md`。扩展不会注册 DSH
client slots，也不会修改 vendored DSH 文件。

## 构建与加载

在仓库根目录运行：

```powershell
pnpm --filter momentq-browser-extension test
pnpm --filter momentq-browser-extension typecheck
pnpm --filter momentq-browser-extension build
```

然后打开 `chrome://extensions` 或 `edge://extensions`：

1. 开启“开发者模式”。
2. 选择“加载已解压的扩展程序”。
3. 选择 `D:\Projects\MomentQ\extension\dist`。

点击 MomentQ 工具栏图标或按 `Alt+Q` 会在任何标签页打开侧边栏；不在支持
的 B 站页面时显示引导空状态。在支持的 B 站视频或直播页中，页面侧边的 DSH
播放/暂停按钮只负责切换当前标签页的转录状态，不会打开侧边栏。单 P 视频不
显示虚构的“第 1 集”。

新版 B 站视频页不再保证提供 `window.__INITIAL_STATE__`。扩展从页面 URL 取得
BV 号，再由后台调用 B 站公开 `x/web-interface/view` 接口读取并校验 `cid`、
标题、UP 主和分 P 列表，避免依赖易变的页面 DOM 类名。

视频进入或切换分 P 后，扩展优先在页面登录态下调用新版 `x/player/wbi/v2`（兼容回退
`x/player/v2`），一次性发现完整 AI/原生字幕轨道，再由扩展后台下载字幕 JSON 并规范化为当前 Host 的
`transcript.jsonl`。不从视频像素或隐藏 DOM 猜字幕，避免字幕按钮关闭时把菜单残留文本写入会话；取得
有效字幕后不会启动语音转录。侧边栏输入框上方的字幕滚动流根据视频当前时间定位
完整字幕，当前句清晰显示，已经滚过的句子向上移动并逐渐淡出。

侧边栏支持 `Alt+Shift+C`（或点击输入栏左侧的加号）从当前 `<video>` 元素抓取
视频帧，也支持直接粘贴图片；**支持多张**——重复截取/粘贴会依次追加为附件，
逐个点缩略图右上角 × 移除。提交后图片经 Host 附件服务按内容寻址存入数据目录
（`dsh-home/attachments/v1`），并作为回答证据发给视觉模型。不会使用整页屏幕截图。
`Esc` 等原生输入行为不受影响。AI 回答完成后，回答下方出现复制按钮（图标变
对勾表示已复制），复制原始 Markdown 文本。

侧边栏打开已有内容时会通过 Host 读取当前 DSH Session 的已提交用户/助手消息，
恢复历史对话；不同 BVID/CID 使用不同内容目录和 Session 身份，不会跨视频复用
字幕。切换到一个已存在但曾有旧字幕的内容时，扩展会先清空该内容的旧字幕再同步
当前页面字幕。

## 设置与 ASR 边界

设置面板包含：

- 通用：DSH Host 地址（默认 `http://127.0.0.1:3182`）、模型 API Key、
  数据存储路径展示（灰色小字，位于"清空所有会话"旁）与清空入口
- 语音识别：ASR 服务商（**本地 Whisper 为默认**；百度云为可选，经本地
  companion 接入）、本地 Whisper 模型档位、百度凭据三件套
- DSH 原版浅色、深色、跟随系统外观设置

语音识别默认走**本地 Whisper**（浏览器内推理，无需 companion、无需任何账号）；
仅当显式切换到百度云时才需要 companion 与凭据。

模型 API Key 保存时通过回环 MomentQ API 交给 DSH 原生凭据服务，并另外写入
扩展自己的 `chrome.storage.local`，以便重新打开设置时回填；密码框显隐使用浏览器
原生符号控件。DSH
凭据服务仍不提供明文回读，因此升级前已经只存在于 Host 的密钥需要重新输入
一次。扩展不会接收或保存任何 ASR 服务商的 API Key、Secret Key、Access
Token 或密码：语音识别 Provider（云端或本地模型）在本地 `companion/`
内以可插拔接口实现，扩展只传递 companion 地址与 provider 选择。

## 字幕获取：两种推荐方式

1. **B 站自带字幕（官方/AI 字幕轨）**：有轨时优先。进入视频或切换分 P 后自动
   发现并下载（见上文），规范化为 Host 的 `transcript.jsonl`；取得有效字幕后不
   会启动语音转录。
2. **Whisper 预识别**：视频没有字幕轨道时，点侧边栏标题栏「预识别」对整段音频
   做离线转录，产出按真实时间轴对齐的完整字幕，播放前 AI 即可引用任意时间点
   （详见下节）。

实时语音转录是第三选项：只覆盖已播放部分，适合边看边记。

## 预识别（整视频离线 Whisper 转录）

引擎固定为**浏览器本地 Whisper**（transformers.js 推理，不上云），与设置里
“语音识别 → ASR 服务商”的选择**无关**——那个选择只影响实时捕获的引擎；
预识别的模型档位跟随“本地 Whisper 模型档位”（默认标准档 base，约 150MB）。
依赖：

- **companion**：仅用于代下音频。B 站 CDN 要求浏览器 UA + `bilibili.com`
  Referer，二者都是扩展上下文中的受保护请求头，由 Node companion 的
  `/proxy/audio` 代发（与播放器加载的是同一路 CDN 音频流）。
- **DSH Host**：字幕经后台 SW 走 `syncTranscript` 落盘；Host 未运行时每窗口
  保存重试最多 5 次，完成后报告具体原因（Host 的校验错误会原样透出到面板）。

流程：`/proxy/audio` 下载 DASH 音频 → 浏览器内解码为 16 kHz mono（解码时长与
页面时长大偏差 >20% 直接报错，防时间轴漂移）→ 顺序切 30 s 窗口逐窗转录 →
每窗产出若干带 `[start, end]` 的句子行，随完成即批量落盘（`syncTranscript`
是整体替换语义，flush 始终发送累计全量；取消后已落盘窗口保留）→ 字幕流
即时可见。识别结果为空/乱码的窗口跳过并在完成信息中计数。

### 为什么是 30 s 窗口：会不会把字幕切成一大块？

不会。字幕行长短与窗口大小**无关**：每窗送入 whisper 后，按模型自己输出的
句末标点（。！？!?…；;）断行（`buildSegments` 刻意不用时长/间隔阈值——base
模型在 0.3–0.9 s 的短语停顿都会打时间戳，按停顿断行会把讲座音频切成几字
一行），一个窗口通常产出 4–10 行完整句子。30 s 只是推理批次大小，不参与断行。

把窗口改小（如 10 s）不会让字幕行变短，反而：

- 窗口边界变密，句子被切在边界上的频率更高（30 s 窗每分钟 2 个边界，10 s 窗
  6 个）——跨边界句子拆成两行，字符完整但断行难看；且每个窗口都是模型冷
  启动，从半句话起步更容易出别扭的首块；
- 推理调用次数成倍增加（每次调用有固定开销）。

30 s 窗真正的质量风险是 whisper 提前输出 EOS、静默丢掉窗口后半段（实测 30 s
连续讲座只出 19 字）。已由密度重试兜住：识别结果低于 2 字/s 的窗口自动拆成
两个 15 s 半窗重试，且仅在重试结果严格更多字时采用。30 s 同时是 whisper 的
原生窗口长度（位置编码精度上限），是边界切分频率与丢尾风险的综合最优。

若实际看到某行特别长，原因是模型在该窗内没写出句末标点（长句无“。”，行会一直
长到下一个句末标点），与窗口大小无关；解法是换更高档位模型（small /
large-turbo 的中文断句明显更好），或放宽 `buildSegments` 的断行策略（默认
不按逗号断行，理由见上）。

## 实时语音识别（默认本地 Whisper）

字幕无法取得时（视频无 AI/原生轨道，或直播间），点击侧边栏标题栏的转录按钮
开启流式语音识别。默认引擎为**本地 Whisper**（transformers.js，浏览器内推理，
不经任何云端，也无需 companion）：

1. 首次使用会从 HuggingFace 下载模型权重（标准档约 150MB，精准档约 1.6GB，
   之后走浏览器缓存），每个加载阶段都有进度与超时提示。
2. 扩展用 `chrome.tabCapture` 抓取当前标签页音频，降采样为
   `16kHz / 16bit / mono PCM`，按 5 秒块送入本地模型推理（推理跟不上时有界
   缓冲，最多回溯 60 秒，丢最旧并显示跳过计数）。
3. 识别句子实时滚入字幕流，并按 8 秒节流持久化到 Host 的
   `transcript.jsonl`，AI 回答可以直接引用。

可选引擎：百度云实时识别（需启动 companion 并配置密钥，见 `companion/README.md`）。
百度模式下标签页音频经本机 companion 实时上传百度智能云识别（本机不落盘）；
凭据只存在于 companion 进程。拖动进度或暂停期间不产生转写内容；识别中再次
点击为暂停/继续。本地 Whisper 会话与百度云会话一样由 offscreen 文档托管，
关闭侧边栏不会中断识别；offscreen 无法接管的浏览器回退为面板托管（关栏即结束）。

Native Messaging 路径仍未使用。

## 原版页面参考

`prototype/` 保留未经 MomentQ 改造的 DSH WebUI 响应，仅用于视觉对照。需要
独立预览时运行：

```powershell
python -m http.server 4175 --directory .\extension\prototype
```
