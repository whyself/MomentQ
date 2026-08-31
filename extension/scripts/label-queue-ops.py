# -*- coding: utf-8 -*-
import io

# TabOperationQueue: label every operation; the caller-timeout message names
# the stuck op and how long it has been running. That message flows into the
# companion log via the begin-failure diagnostic.
p = 'src/background/state.ts'
s = io.open(p, encoding='utf-8').read()
old = '''export class TabOperationQueue {
  private readonly tails = new Map<number, Promise<void>>()

  run<T>(tabId: number, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(tabId) ?? Promise.resolve()
    const result = previous.then(() => operation())'''
new = '''export class TabOperationQueue {
  private readonly tails = new Map<number, Promise<void>>()
  /** The in-flight operation per tab, for timeout diagnostics. */
  private readonly running = new Map<number, { label: string; startedAt: number }>()

  run<T>(tabId: number, operation: () => Promise<T>, label = '未命名操作'): Promise<T> {
    const previous = this.tails.get(tabId) ?? Promise.resolve()
    const result = previous.then(() => {
      this.running.set(tabId, { label, startedAt: Date.now() })
      return operation()
    })'''
assert s.count(old) == 1, 'state anchor 1'
s = s.replace(old, new)

old2 = '''    const release = (): void => {
      if (timer !== undefined) { clearTimeout(timer); timer = undefined }
      if (grace !== undefined) { clearTimeout(grace); grace = undefined }
    }'''
new2 = '''    const release = (): void => {
      this.running.delete(tabId)
      if (timer !== undefined) { clearTimeout(timer); timer = undefined }
      if (grace !== undefined) { clearTimeout(grace); grace = undefined }
    }'''
assert s.count(old2) == 1, 'state anchor 2'
s = s.replace(old2, new2)

old3 = "        timer = setTimeout(() => reject(new Error('MomentQ 内部状态操作超时，请重试')), CALLER_TIMEOUT_MS)"
new3 = """        timer = setTimeout(() => {
          const current = this.running.get(tabId)
          const detail = current === undefined
            ? '（队列空闲——等待前一个未结算操作）'
            : `正在运行「${current.label}」已 ${Math.round((Date.now() - current.startedAt) / 100) / 10}s`
          reject(new Error(`MomentQ 内部状态操作超时，${detail}`))
        }, CALLER_TIMEOUT_MS)"""
assert s.count(old3) == 1, 'state anchor 3'
s = s.replace(old3, new3)
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('state.ts ok')

# Label every queue call site in the background orchestrator.
p = 'src/background/index.ts'
s = io.open(p, encoding='utf-8').read()

def repl(old, new, count=1):
    global s
    assert s.count(old) == count, 'anchor: %r count=%d' % (old[:70], s.count(old))
    s = s.replace(old, new)

repl("  await tabOperations.run(tabId, async () => {\n    const state = await readState(tabId)\n    if (state?.context.kind !== 'vod'\n      || state.context.identity.bvid !== bvid",
     "  await tabOperations.run(tabId, '字幕探测写入', async () => {\n    const state = await readState(tabId)\n    if (state?.context.kind !== 'vod'\n      || state.context.identity.bvid !== bvid")

repl("    return await tabOperations.run(tabId, async () => {\n      const current = await readState(tabId)\n      if (current === null || current.transcription !== 'inactive') return await readState(tabId)\n      const { transcriptPreview: _preview, transcriptionError: _error, ...withoutAsrUi } = current",
     "    return await tabOperations.run(tabId, '开始转录', async () => {\n      const current = await readState(tabId)\n      if (current === null || current.transcription !== 'inactive') return await readState(tabId)\n      const { transcriptPreview: _preview, transcriptionError: _error, ...withoutAsrUi } = current")

repl("      `无法开始转录（${reason}）。请重试或在 MomentQ 侧边栏再次点击。`,\n    ))",
     "      `无法开始转录（${reason}）。请重试或在 MomentQ 侧边栏再次点击。`,\n    ), '开始失败收尾')")

repl("  await tabOperations.run(tabId, async () => {\n    const state = await readState(tabId)\n    // Events from an ended session",
     "  await tabOperations.run(tabId, '语音事件', async () => {\n    const state = await readState(tabId)\n    // Events from an ended session")

repl("  if (tabId !== null) {\n    await tabOperations.run(tabId, async () => {\n      const state = await readState(tabId)\n      if (state === null || state.transcription === 'inactive') return\n      // An intentional stop is not an error: state clears without one.",
     "  if (tabId !== null) {\n    await tabOperations.run(tabId, '语音会话确认', async () => {\n      const state = await readState(tabId)\n      if (state === null || state.transcription === 'inactive') return\n      // An intentional stop is not an error: state clears without one.")

repl("        void tabOperations.run(tabId, async () => {\n          const state = await readState(tabId)\n          if (state === null || state.transcription === 'inactive') return\n          await deactivateTranscription(tabId, state, '采集会话未确认启动，请重试')\n        })",
     "        void tabOperations.run(tabId, '启动确认看门狗', async () => {\n          const state = await readState(tabId)\n          if (state === null || state.transcription === 'inactive') return\n          await deactivateTranscription(tabId, state, '采集会话未确认启动，请重试')\n        })")

repl("      await tabOperations.run(tabId, async () => {\n        const state = await readState(tabId)\n        if (state === null || state.transcription === 'inactive') return\n        await deactivateTranscription(tabId, state,\n          typeof failure.message === 'string' ? failure.message : '标签页采集启动失败')\n      })",
     "      await tabOperations.run(tabId, '采集失败处理', async () => {\n        const state = await readState(tabId)\n        if (state === null || state.transcription === 'inactive') return\n        await deactivateTranscription(tabId, state,\n          typeof failure.message === 'string' ? failure.message : '标签页采集启动失败')\n      })")

repl("      await tabOperations.run(tabId, async () => {\n        const state = await readState(tabId)\n        if (state?.context.kind !== 'vod'\n          || state.context.identity.bvid !== bvid\n          || state.context.identity.cid !== cid) return\n        if (state.subtitleSource !== 'bilibili' || state.transcription !== 'inactive') return",
     "      await tabOperations.run(tabId, '字幕同步-清理未签名', async () => {\n        const state = await readState(tabId)\n        if (state?.context.kind !== 'vod'\n          || state.context.identity.bvid !== bvid\n          || state.context.identity.cid !== cid) return\n        if (state.subtitleSource !== 'bilibili' || state.transcription !== 'inactive') return")

repl("    await tabOperations.run(tabId, async () => {\n      const state = await readState(tabId)\n      if (state?.context.kind !== 'vod'\n        || state.context.identity.bvid !== bvid\n        || state.context.identity.cid !== cid) return\n      if (segments.length > 0) {",
     "    await tabOperations.run(tabId, '字幕同步-提交', async () => {\n      const state = await readState(tabId)\n      if (state?.context.kind !== 'vod'\n        || state.context.identity.bvid !== bvid\n        || state.context.identity.cid !== cid) return\n      if (segments.length > 0) {")

repl("      await tabOperations.run(tabId, async () => {\n        const current = await readState(tabId)\n        if (current?.context.kind !== 'vod'\n          || current.context.identity.bvid !== message.payload.bvid\n          || current.context.identity.cid !== message.payload.cid) return\n        const {\n          subtitleSegments: _segments,",
     "      await tabOperations.run(tabId, '页面字幕-清理', async () => {\n        const current = await readState(tabId)\n        if (current?.context.kind !== 'vod'\n          || current.context.identity.bvid !== message.payload.bvid\n          || current.context.identity.cid !== message.payload.cid) return\n        const {\n          subtitleSegments: _segments,")

repl("    await tabOperations.run(tabId, async () => {\n      const current = await readState(tabId)\n      if (current?.context.kind !== 'vod'\n        || current.context.identity.bvid !== message.payload.bvid\n        || current.context.identity.cid !== message.payload.cid) return\n      // Another background/page request may have won",
     "    await tabOperations.run(tabId, '页面字幕-提交', async () => {\n      const current = await readState(tabId)\n      if (current?.context.kind !== 'vod'\n        || current.context.identity.bvid !== message.payload.bvid\n        || current.context.identity.cid !== message.payload.cid) return\n      // Another background/page request may have won")

repl("function toggleTranscription(tabId: number): Promise<MomentQTabState | null> {\n  return tabOperations.run(tabId, () => toggleTranscriptionUnlocked(tabId))\n}",
     "function toggleTranscription(tabId: number): Promise<MomentQTabState | null> {\n  return tabOperations.run(tabId, () => toggleTranscriptionUnlocked(tabId), '切换转录')\n}")

repl("  void tabOperations.run(tabId, () => writeState(tabId, reduceTabState(null, { type: 'REMOVE_TAB' })))",
     "  void tabOperations.run(tabId, () => writeState(tabId, reduceTabState(null, { type: 'REMOVE_TAB' })), '清理标签页')")

repl("    await tabOperations.run(tabId, async () => {\n      const current = await readState(tabId)\n      if (current === null || current.transcription === 'inactive') return\n      await deactivateTranscription(tabId, current)\n    })",
     "    await tabOperations.run(tabId, '孤儿恢复', async () => {\n      const current = await readState(tabId)\n      if (current === null || current.transcription === 'inactive') return\n      await deactivateTranscription(tabId, current)\n    })")

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('index.ts ok')
