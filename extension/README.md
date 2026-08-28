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
视频帧，并按 DSH 输入栏的附件位置显示待发送预览；不会使用整页屏幕截图。
`Esc` 等原生输入行为不受影响。

侧边栏打开已有内容时会通过 Host 读取当前 DSH Session 的已提交用户/助手消息，
恢复历史对话；不同 BVID/CID 使用不同内容目录和 Session 身份，不会跨视频复用
字幕。切换到一个已存在但曾有旧字幕的内容时，扩展会先清空该内容的旧字幕再同步
当前页面字幕。

## 设置与 ASR 边界

原版设置面板现包含：

- 通用：DSH Host 地址（当前开发默认 `http://127.0.0.1:3182`）与模型 API Key
- 本地 companion 地址，默认 `http://127.0.0.1:3090`
- ASR 服务商预留（当前为百度智能云）
- 字幕写入方式
- 自动连接行为
- DSH 原版浅色、深色、跟随系统外观设置

模型 API Key 保存时通过回环 MomentQ API 交给 DSH 原生凭据服务，并另外写入
扩展自己的 `chrome.storage.local`，以便重新打开设置时回填；密码框显隐使用浏览器
原生符号控件。DSH
凭据服务仍不提供明文回读，因此升级前已经只存在于 Host 的密钥需要重新输入
一次。扩展不会接收或保存百度 API Key、Secret
Key、Access Token 或密码。百度鉴权、音频捕获/转码、流式 ASR 和 Native Messaging
尚未实现，后续由本地 `companion/` 负责；因此当前播放/暂停按钮只切换扩展状态，
不代表真实 ASR 已开始工作。

## 原版页面参考

`prototype/` 保留未经 MomentQ 改造的 DSH WebUI 响应，仅用于视觉对照。需要
独立预览时运行：

```powershell
python -m http.server 4175 --directory .\extension\prototype
```
