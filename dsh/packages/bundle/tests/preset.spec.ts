import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const preset = await readFile(`${packageRoot}/presets/momentq/preset.yml`, 'utf8')
const composition = await readFile(`${packageRoot}/presets/momentq/agent.cordis.yml`, 'utf8')
const patch = (await readFile(`${packageRoot}/cordis.patch.yml`, 'utf8')).replace(/\r\n/g, '\n')
const manifest = JSON.parse(await readFile(`${packageRoot}/package.json`, 'utf8')) as Record<string, any>

describe('MomentQ Bundle composition', () => {
  it('ships one fixed MomentQ Preset with the minimal general-assistant persona', () => {
    expect(preset).toContain('name: MomentQ')
    expect(composition).toContain('一个能够使用当前视频或直播上下文的通用助手')
    expect(composition).toContain('正常完成用户的请求')
    expect(composition).toContain('momentq-dsh-bundle/tool-policy')
    expect(composition).toContain('momentq-dsh-bundle/session-context')
    expect(composition).toContain('内容总结中每个要点都要带对应的时间点')
    expect(composition).toContain('时间点必须直接取自字幕行给出的 start/end')
    expect(composition).toContain('紧邻 ** 的字符必须是汉字、字母或数字')
  })

  it('contains no forbidden Agent rows', () => {
    for (const forbidden of [
      'tool-bash', 'tool-pwsh', 'tool-str-replace-editor', 'tool-web', 'tool-workflow',
      'tool-skill', 'tool-subagent', 'tool-todo', 'tool-goal', 'plan-mode', 'glob',
    ]) {
      expect(composition).not.toContain(`name: '@deepseek-ai/dsh-${forbidden}`)
      expect(composition).not.toContain(`id: ${forbidden}`)
    }
  })

  it('fixes the data root, vision model, native tool providers and Preset roster', () => {
    expect(patch).toContain('root: !!js process.env.MOMENTQ_DATA_ROOT')
    expect(patch).toContain('provider: deepseek-official')
    expect(patch).toContain('model: deepseek-v4-flash-vision-exp')
    expect(patch).toContain('id: tool-fs\n  disabled: false')
    expect(patch).toContain('id: tool-fs-search\n  disabled: false')
    expect(patch).toContain('default: momentq')
    expect(patch).toContain('path: !!js ctx.momentq.presetRoot')
    expect(patch).toContain('includeUserRoot: false')
  })

  it('publishes every runtime entry and Bundle asset', () => {
    expect(manifest.exports).toHaveProperty('.')
    expect(manifest.exports).toHaveProperty('./session-context')
    expect(manifest.exports).toHaveProperty('./tool-policy')
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.files).toEqual(expect.arrayContaining(['dist/', 'cordis.patch.yml', 'presets/']))
  })
})

