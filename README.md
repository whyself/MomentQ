# MomentQ（刻问）

B 站视频上下文助手：一个 Edge/Chrome 侧边栏扩展，配合本机运行的两个轻量服务，
让 AI「看着字幕」回答你关于当前视频的问题。

- **字幕自动抽取**：打开 B 站视频自动发现官方/AI 字幕轨，跟随播放实时滚动显示；
  回答中的时间戳（如 `[03:10]`、`[11:00–15:00]`）是可点击的跳转按钮。
- **本地语音识别（默认）**：视频没有字幕轨时，一键开启转录——音频在本机浏览器内
  由 Whisper 模型（transformers.js + WebGPU）推理成字幕，不需要任何云端账号。
- **整视频预识别**：没有字幕轨时，点侧边栏标题栏「预识别」对整段音频离线转录，
  播放前拿到按真实时间轴对齐的完整字幕（同样走浏览器本地 Whisper，不走云端）。
- **图片提问**：点击输入栏「+」截取视频当前画面，或直接粘贴多张图片，AI 结合画面回答。
- **对话**：针对当前视频或直播提问，回答严格以当前视频的字幕、元信息和你提供的图片为证据。

本版本（v1.1.10）覆盖：**B 站字幕抽取全链路 + 整视频预识别 + 本地语音识别（whisper-local，offscreen 托管）**。
百度云语音识别保留为可选配置（见下文），不在默认路径上。

---

## 架构

| 组件 | 端口 | 作用 |
|---|---|---|
| 浏览器扩展（`extension/dist`） | — | 侧边栏 UI、字幕抽取、本地 Whisper 推理 |
| DSH Host（`dsh --profile web`） | 3182 | 对话、字幕/对话持久化、agent 与字幕读取工具 |
| companion（可选，`companion/dist`） | 3090 | 预识别代下 B 站音频（CDN 要求的 UA/Referer 是扩展受保护头）、百度云语音识别需要；实时本地 Whisper 用不到 |

所有服务只绑定 `127.0.0.1`，不经过任何第三方服务器（模型 API 调用与语音识别除外，见隐私一节）。

## Windows 安装（发行包）

前提：Windows 10/11，[Node.js 22 LTS 或更高](https://nodejs.org/)。无需 pnpm、无需源码构建。

1. 解压 `momentq-1.1.10.zip` 到任意**纯英文且不含空格**的目录（例如 `D:\MomentQ`）。
2. 双击 `scripts\start-local.cmd`。脚本会自动：检查/安装 pnpm 与 DSH 运行时、
   安装 MomentQ Host 组件、创建数据目录、启动两个服务窗口。
   - 再次运行是安全的：已在运行的服务会被跳过。
   - 从旧版本升级：先关闭两个服务窗口，删除 `%LOCALAPPDATA%\MomentQ\dsh-home\profiles\web\node_modules\momentq-dsh-bundle`
     （脚本检测到已安装就不会重装 Host 组件），再运行 `start-local.cmd`。
     数据都在 `%LOCALAPPDATA%\MomentQ`，与解压目录无关，换目录解压不会丢数据。
3. Edge 打开 `edge://extensions` → 开启「开发人员模式」→「加载解压缩的扩展」→
   选择 zip 内的 `extension\dist` 目录。
4. 打开任意 B 站视频，点工具栏 MomentQ 图标（或按 `Alt+Q`）打开侧边栏，
   在 设置 → 模型 API Key 填入你的 DeepSeek API Key 并保存。

之后每次使用：双击 `scripts\start-local.cmd` → 打开 B 站视频 → 侧边栏提问。

### 从源码运行（开发者）

```powershell
pnpm install
pnpm --filter momentq-browser-extension build
# 构建 companion 并打包 Host 组件
cd companion; npm run build; npm install --omit=dev; cd ../..
cd dsh/packages/bundle; npm run build; npm pack; cd ../..
scripts\start-local.cmd
```

## 使用说明

### 字幕

字幕的两种推荐获取方式：

1. **B 站自带字幕（官方/AI 字幕轨）**：有轨时优先。打开视频后扩展自动探测并
   下载，侧边栏输入框上方的字幕流跟随播放滚动，当前句高亮、已播句上移淡出；
   取得有效字幕后不会启动语音转录。
2. **Whisper 预识别**：没有字幕轨时，点侧边栏标题栏「预识别」对整段音频做离线
   转录（固定走浏览器本地 Whisper，不走云端；需 companion 运行以代下音频），
   产出按真实时间轴对齐的完整字幕——播放之前 AI 就能引用任意时间点。预识别
   会整体替换该视频现有字幕，中途可取消（已完成的窗口保留）。

回答中的方括号时间（如 `[03:10]`、`[11:00–15:00]`）可以点击跳转。视频没有字幕轨
且未预识别时，字幕区会显示探测诊断（例如「无轨道」），可用实时转录（下节）边看边记。

### 语音识别（本地 Whisper，默认）

点击标题栏的转录按钮开始/暂停。音频在浏览器内由本地 Whisper 模型推理，
**首次使用需从 HuggingFace 下载模型**（标准档约 150MB，精准档约 1.6GB，之后走浏览器缓存），
下载进度会实时显示。识别结果实时滚入字幕流，并自动持久化，
AI 回答时可以直接引用。转录会话由扩展后台的 offscreen 文档托管，关闭侧边栏
不会中断识别；offscreen 无法接管的浏览器回退为面板托管，此时关栏即停止。

可选：百度云实时识别。需要启动 companion 并在 设置 → 语音识别 中填入百度凭据
（凭据只保存在本机 companion）。百度模式下标签页音频会实时上传百度智能云做识别。

### 图片提问

点击输入栏「+」截取视频当前画面（快捷键 `Alt+Shift+C`），或直接把图片粘贴到输入框。
支持多张：重复点击「+」或粘贴多张，逐个点缩略图右上角 × 移除。图片随提问一起
保存到本机数据目录，作为回答证据发给模型。

### 快捷键

- `Alt+Q` 打开/聚焦侧边栏
- `Alt+Shift+T` 开始/暂停转录
- `Alt+Shift+C` 截取当前画面

所有快捷键都可以在 `edge://extensions/shortcuts` 里按习惯修改。

### 数据管理

- 清空当前视频对话：侧边栏标题栏「清空」按钮。
- 清空全部对话 / 清除当前视频字幕存档：设置页对应按钮，物理删除且不可恢复。

## 数据存储位置

| 数据 | 位置（默认） |
|---|---|
| 全部数据根 | `%LOCALAPPDATA%\MomentQ` |
| 字幕（transcript.jsonl）+ 视频元信息 | `%LOCALAPPDATA%\MomentQ\content\...` |
| 对话记录 | `%LOCALAPPDATA%\MomentQ\dsh-home\sessions\...` |
| 提问图片（按内容去重） | `%LOCALAPPDATA%\MomentQ\dsh-home\attachments\v1\...` |
| 百度凭据（可选） | `%USERPROFILE%\.momentq-companion.json` |
| Whisper 模型缓存 | Edge 浏览器缓存（随浏览器管理） |

## 隐私与数据流向

- 字幕、对话、图片、识别结果**只存在本机**；数据目录可整目录删除实现完全清除。
- 发往外部的内容只有两类：提问文本 + 图片 → DeepSeek API（用于生成回答）；
  本地 Whisper 首次使用从 HuggingFace 下载模型权重（只下载，不上传）。
- 百度云模式为**可选**：启用后标签页音频实时上传百度智能云做识别，本机不落盘。
- 本地 Whisper 模式下音频不出浏览器（预识别下载的音频来自 B 站自己的 CDN，
  与播放器加载的是同一路音频流，经本机 companion 中转）。

## 故障排查

- **提问无回答 / 设置页报无法连接 Host**：确认 `start-local.cmd` 的两个窗口都在运行；
  端口被其他程序占用时脚本会提示。
- **转录按钮点击无反应**：Edge 要求先在页面上"调用过"扩展——右键视频页选
  「MomentQ：开始/暂停语音转录」、按 `Alt+Shift+T`，或点侧边栏按钮后重试。
- **Whisper 一直显示下载中**：模型较大（精准档 1.6GB），受网络影响；进度条会持续走动。
- **预识别报“音频下载失败”**：预识别需要 companion 代下 B 站音频，确认
  `start-local.cmd` 的 companion 窗口在运行；Host 未运行时字幕保存会失败，
  界面会显示 Host 返回的具体原因，修复后重新预识别即可。
- **扩展显示"扩展已更新"遮罩**：关闭并重新打开侧边栏即可。

## 组件版本

- 扩展：v1.1.10；Host 组件 / companion：v1.0.0（本仓库）
- DSH 运行时：`@deepseek-ai/dsh@0.1.1-rc.2`（npm 安装，启动脚本自动处理）
