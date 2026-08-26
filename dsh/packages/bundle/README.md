# MomentQ DSH Bundle

MomentQ（刻问）的 DeepSeek Harness Host Bundle。它为每个 B 站视频分 P 或单场直播创建一个持久内容目录和一个持久 DSH Session，并提供固定 Agent Preset、Session 自定义指令、视频元信息上下文、字幕专用 `grep`/`read` 工具，以及 loopback-only API 和浏览器安全 SDK。

## 要求

- Node.js `^22.19.0` 或 `>=24.0.0`
- DeepSeek Harness `0.1.1-rc.2`
- `MOMENTQ_DATA_ROOT` 指向唯一数据总目录
- `DSH_HOME` 必须等于 `<MOMENTQ_DATA_ROOT>/dsh-home`

默认模型路由为：

```text
deepseek-official / deepseek-v4-flash-vision-exp
```

模型凭据继续通过 DSH 原生设置或 `$DSH_HOME` 凭据文件管理，Bundle 不保存密钥。

本 Bundle 不包含 ASR 凭据，也不提供浏览器 UI。字幕导入、实时 ASR、浏览器扩展和 Docker 镜像属于后续独立模块。

## 数据目录

```text
<MOMENTQ_DATA_ROOT>/
├─ content/
│  └─ bilibili/
│     ├─ vod/{bvid}/{cid}/
│     │  ├─ state.json
│     │  └─ transcript.jsonl
│     └─ live/{canonicalRoomId}/{liveStartEpochMs}/
│        ├─ state.json
│        └─ transcript.jsonl
└─ dsh-home/
   └─ ...DSH 原生 Session、设置、凭据与附件...
```

`state.json` 由 MomentQ Host 单独写入。后续浏览器扩展、字幕导入器和 ASR 模块必须通过 Host API 提交状态更新，避免多个写入者覆盖状态。DSH Agent 对内容文件始终只读。

## 开发者安装和启动

这是 Bundle 的开发验证流程。最终用户不需要预先安装和配置 DSH；计划中的 `dsh/packages/runtime` 将固定 DSH 原生框架和插件版本并提供统一启动命令，`dsh/docker` 将提供等价的容器发行方式。

```powershell
pnpm install
pnpm build
dsh plugin --profile web add .\dsh\packages\bundle

$momentqRoot = 'D:\MomentQData'
$env:MOMENTQ_DATA_ROOT = $momentqRoot
$env:DSH_HOME = Join-Path $momentqRoot 'dsh-home'
dsh --profile web --no-open
```

服务默认只监听 `127.0.0.1`。MomentQ API 没有公网认证或 TLS，禁止把 DSH WebServer 绑定到全部网络接口。

## SDK

```ts
import { MomentQClient } from 'momentq-dsh-bundle/sdk'

const momentq = new MomentQClient({ baseUrl: 'http://127.0.0.1:3080' })

const route = await momentq.ensureContent({
  identity: { kind: 'vod', bvid: 'BV1xx', cid: '42' },
  metadata: {
    title: '视频标题',
    creator: { id: '123', name: 'UP 主' },
  },
  sessionInstructions: '直接回答；涉及公式时说明符号含义。',
})
```

管理接口：

- `ensureContent`：创建或恢复内容及活动 Session。
- `getContent`：读取 Host 校验后的内容状态。
- `archiveSession`：归档当前对话，不创建替代 Session。
- `resetSession`：归档当前对话并创建新的空白 Session。
- `deleteSession`：物理删除当前 DSH 对话日志，保留字幕与元信息，并创建新的空白 Session。
- `deleteContent`：物理删除该内容记录的全部 DSH 对话日志和整个内容目录。

删除接口只接受内容身份，不接受文件路径或 Session id。Host 根据已验证的 `state.json` 和 DSH 持久化位置计算删除目标，并拒绝总目录外的路径。

## Agent 能力

固定 Preset id 为 `momentq`。每个 Session 可以在第一次创建时冻结一段自定义指令；为空时使用 Host 配置的默认值。

模型只看到两个工具：

- `grep`：搜索当前 `transcript.jsonl`；
- `read`：读取当前 `transcript.jsonl` 的行窗口。

两个工具的文件参数均从模型 Schema 中移除。Bundle 复用 DSH 原生工具实现，只在 Agent Scope 中强制注入当前 Session 的字幕路径。

## Docker 持久化

Docker 不是 MVP 前置条件。未来容器必须 bind mount 整个数据根：

```powershell
docker run --rm `
  --mount 'type=bind,source=D:\MomentQData,target=/var/lib/momentq' `
  --env MOMENTQ_DATA_ROOT=/var/lib/momentq `
  --env DSH_HOME=/var/lib/momentq/dsh-home `
  momentq:local
```

仅保存在容器可写层中的数据不受支持。
