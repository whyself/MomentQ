import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const extensionRoot = join(import.meta.dirname, '..')
const source = (...parts: string[]) => readFile(join(extensionRoot, 'src', ...parts), 'utf8')

describe('DSH UI reuse contract', () => {
  it('keeps authored side-panel CSS geometry-only', async () => {
    const css = await source('sidepanel', 'composition.css')
    expect(css).not.toMatch(/color|background|border|shadow|radius|font|padding|gap/)
  })

  it('uses DSH theme tokens and motion for the subtitle ticker', async () => {
    const css = await source('sidepanel', 'subtitle.css')
    expect(css).toContain('var(--dsw-alias-label-primary)')
    expect(css).toContain('var(--dsw-alias-label-secondary)')
    expect(css).toContain('momentq-subtitle-current-in')
    expect(css).toContain('prefers-reduced-motion')
  })

  it('uses vendored DSH conversation, hero and input CSS modules', async () => {
    const view = await source('sidepanel', 'ConversationView.tsx')
    expect(view).toContain('ConversationRoot.module.css')
    expect(view).toContain('HeroShell.module.css')
    expect(view).toContain('InputBar.module.css')
    expect(view).toContain('inputCss.backdrop')
    expect(view).toContain('inputCss.add')
    expect(view).toContain('IconPlusOutline16 size={14}')
    expect(view).toContain('partText !== undefined')
    expect(view).toContain('MarkdownText')
    expect(view).toContain('streaming={streaming}')
    expect(view).not.toContain("split(/\\n{2,}/)")
  })

  it('adapts the upstream settings shell to one narrow-column flow', async () => {
    const settings = await source('sidepanel', 'SettingsView.tsx')
    const css = await source('sidepanel', 'composition.css')
    expect(settings).toContain('momentq-settings-row')
    expect(settings).toContain('momentq-settings-save')
    expect(settings).toContain('name="modelApiKey"')
    expect(settings).toContain('type="password"')
    expect(settings).not.toContain("'隐藏' : '显示'")
    expect(css).not.toContain('momentq-model-api-key-control')
    expect(settings).toContain('saveAndClose(close)')
    expect(settings).toContain('IconPlayOutline16')
    expect(settings).toContain('`${rowCss.row} momentq-settings-save`')
    expect(settings).toContain('无法连接 DSH Host')
    expect(css).toContain(".momentq-settings [role='dialog']")
    expect(css).toContain('grid-template-rows: auto minmax(0, 1fr)')
    expect(css).toContain('flex-direction: column')
    expect(css).toContain('flex: 1 1 0')
    expect(css).toContain('justify-content: center')
    expect(css).toContain('flex: 0 1 auto')
    expect(css).toContain('button:nth-child(2) > svg:first-child')
  })

  it('uses the upstream settings shell and keeps credentials out of extension settings', async () => {
    const settings = await source('sidepanel', 'SettingsView.tsx')
    const storedSettings = await source('shared', 'settings.ts')
    expect(settings).toContain('SettingsRoot.tsx')
    expect(settings).toContain('AppearanceRow.module.css')
    expect(settings).toContain('EnterBehaviorRow.module.css')
    expect(settings).toContain('.setModelApiKey(modelApiKey)')
    expect(storedSettings).not.toMatch(/^\s+(?:apiKey|secretKey|accessToken|password):/m)
  })

  it('keeps the page control separate from side-panel opening', async () => {
    const control = await source('content', 'transcription-control.tsx')
    const content = await source('content', 'index.tsx')
    expect(control).toContain('Button')
    expect(control).toContain('IconPlayOutline16')
    expect(control).toContain('IconPauseOutline16')
    expect(content).toContain('MOMENTQ_TOGGLE_CURRENT_TRANSCRIPTION')
    expect(`${control}\n${content}`).not.toContain('sidePanel.open')
  })

  it('latches the unconfigured-ASR warning so a loading video never flashes it', async () => {
    const view = await source('sidepanel', 'ConversationView.tsx')
    expect(view).toContain('asrWarningLatched')
    expect(view).toContain('setAsrWarningLatched(true)')
    expect(view).toContain('3_000')
  })
})
