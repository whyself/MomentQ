import { useEffect, useState } from 'react'
import type { ComponentType, ReactNode } from 'react'
import {
  Button, IconChevronDownOutline14, IconDarkOutline16, IconFollowsystemOutline16,
  IconLightOutline16, IconPlayOutline16, Input, Menu,
} from '../dsh/primitives'
import type { MenuEntry } from '../dsh/primitives'
import { sanitizeSettings } from '../shared/settings'
import type { ExtensionSettings, ThemePreference } from '../shared/settings'
import { MomentQClient } from '../shared/host-client'
import { loadModelApiKey, saveModelApiKey, saveSettings } from '../shared/settings-store'
import { SettingsRoot as UpstreamSettingsRoot } from '../vendor/deepseek-harness/packages/client/ui-settings-general/src/client/SettingsRoot.tsx'
import { TriggerContent, HeaderContent, CloseLabel } from '../vendor/deepseek-harness/packages/client/ui-settings-general/src/client/chrome.tsx'
import { GeneralSection } from '../vendor/deepseek-harness/packages/client/ui-settings-general/src/client/GeneralSection.tsx'
import appearanceCss from '../vendor/deepseek-harness/packages/client/ui-theme/src/client/AppearanceRow.module.css'
import rowCss from '../vendor/deepseek-harness/packages/client/ui-conversation/src/client/settings/EnterBehaviorRow.module.css'
import { applyTheme } from './theme'

type RenderSlot = (slot: string, props: Record<string, unknown>, options?: { only: string }) => ReactNode
type SettingsRootProps = {
  wide: boolean
  useSections: (selector: (rows: readonly { id: string; order: number; label: ReactNode }[]) => unknown) => unknown
  useOnboardingSteps: (selector: (steps: readonly never[]) => unknown) => unknown
  useSessions: (selector: (state: { phase: 'ready'; current: string; byId: Record<string, never> }) => unknown) => unknown
  renderSlot: RenderSlot
}

const SettingsRoot = UpstreamSettingsRoot as unknown as ComponentType<SettingsRootProps>
const themeChoices = [
  { id: 'light', label: '浅色', Icon: IconLightOutline16 },
  { id: 'dark', label: '深色', Icon: IconDarkOutline16 },
  { id: 'system', label: '跟随系统', Icon: IconFollowsystemOutline16 },
] as const

function AppearanceRow({ preference, setTheme }: {
  preference: ThemePreference
  setTheme: (theme: ThemePreference) => void
}) {
  return (
    <div className={appearanceCss.group}>
      <div className={appearanceCss.title}>外观</div>
      <div className={appearanceCss.cubeRow}>
        {themeChoices.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            className={`${appearanceCss.themeCube}${preference === id ? ` ${appearanceCss.selected}` : ''}`}
            aria-pressed={preference === id}
            onClick={() => { setTheme(id) }}
          >
            <Icon />
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}

function Row({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return (
    <div className={`${rowCss.row} momentq-settings-row`}>
      <div className={rowCss.rowText}>
        <div className={rowCss.title}>{title}</div>
        <div className={rowCss.desc}>{description}</div>
      </div>
      {children}
    </div>
  )
}

function SelectRow({ title, description, value, items, onSelect }: {
  title: string
  description: string
  value: string
  items: readonly MenuEntry[]
  onSelect: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const label = items.find(item => !('type' in item) && item.id === value && typeof item.label === 'string')
  return (
    <Row title={title} description={description}>
      <Menu
        open={open}
        items={items}
        selectedId={value}
        onSelect={(id) => { onSelect(id); setOpen(false) }}
        onClose={() => { setOpen(false) }}
        align="end"
        anchor={(
          <button type="button" className={rowCss.selector} onClick={() => { setOpen(value => !value) }}>
            {label === undefined || 'type' in label ? value : label.label}
            <IconChevronDownOutline14 className={rowCss.chevron} size={12} />
          </button>
        )}
      />
    </Row>
  )
}

function SaveArea({ saving, error, onSave }: {
  saving: boolean
  error: string | null
  onSave: () => void
}) {
  return (
    <>
      {error !== null && <div className={rowCss.desc} role="alert">{error}</div>}
      <div className={`${rowCss.row} momentq-settings-save`}>
        <Button variant="primary" disabled={saving} onClick={onSave}>
          {saving ? '保存中…' : '保存'}
        </Button>
      </div>
    </>
  )
}

function saveErrorMessage(error: unknown, hostBaseUrl: string): string {
  if (error instanceof TypeError && /fetch/i.test(error.message)) {
    return `无法连接 DSH Host（${hostBaseUrl}），请确认上方地址与正在运行的端口。`
  }
  return error instanceof Error ? error.message : '保存失败'
}

function GeneralSettingsSection({
  draft, setDraft, setTheme, modelApiKey, setModelApiKey,
  saving, saveError, onSave,
}: {
  draft: ExtensionSettings
  setDraft: (settings: ExtensionSettings) => void
  setTheme: (theme: ThemePreference) => void
  modelApiKey: string
  setModelApiKey: (value: string) => void
  saving: boolean
  saveError: string | null
  onSave: () => void
}) {
  return (
    <div>
      <AppearanceRow preference={draft.theme} setTheme={setTheme} />
      <Row title="DSH Host 地址" description="浏览器前端连接本机 DSH Host。">
        <Input value={draft.hostBaseUrl} onChange={event => { setDraft({ ...draft, hostBaseUrl: event.target.value }) }} />
      </Row>
      <Row title="模型 API Key" description="由扩展在本机保存并同步到 DSH Host；清空只移除扩展副本。">
        <Input
          type="password"
          name="modelApiKey"
          autoComplete="off"
          aria-label="模型 API Key"
          value={modelApiKey}
          placeholder="输入模型 API Key"
          onChange={event => { setModelApiKey(event.target.value) }}
        />
      </Row>
      <SaveArea saving={saving} error={saveError} onSave={onSave} />
    </div>
  )
}

function AsrSection({ draft, setDraft, saving, saveError, onSave }: {
  draft: ExtensionSettings
  setDraft: (settings: ExtensionSettings) => void
  saving: boolean
  saveError: string | null
  onSave: () => void
}) {
  return (
    <div>
      <Row title="伴随服务地址" description="音频捕获与 ASR 由本地 companion 提供。">
        <Input value={draft.companionBaseUrl} onChange={event => { setDraft({ ...draft, companionBaseUrl: event.target.value }) }} />
      </Row>
      <SelectRow
        title="ASR 服务商"
        description="当前预留百度智能云；扩展不保存 API Key 或 Secret Key。"
        value={draft.asrProvider}
        items={[{ id: 'baidu', label: '百度智能云' }]}
        onSelect={() => { setDraft({ ...draft, asrProvider: 'baidu' }) }}
      />
      <SelectRow
        title="字幕写入方式"
        description="控制识别结果追加或替换当前临时字幕。"
        value={draft.subtitleMode}
        items={[{ id: 'append', label: '追加' }, { id: 'replace', label: '替换' }]}
        onSelect={id => { setDraft({ ...draft, subtitleMode: id === 'replace' ? 'replace' : 'append' }) }}
      />
      <SelectRow
        title="自动连接"
        description="打开支持页面后是否自动连接本地 companion。"
        value={draft.autoConnect ? 'on' : 'off'}
        items={[{ id: 'on', label: '开启' }, { id: 'off', label: '关闭' }]}
        onSelect={id => { setDraft({ ...draft, autoConnect: id === 'on' }) }}
      />
      <Row title="连接状态" description="DSH Host 与 ASR companion 分别使用上方地址连接。" />
      <SaveArea saving={saving} error={saveError} onSave={onSave} />
    </div>
  )
}

export function SettingsView({ settings, onSettingsChange }: {
  settings: ExtensionSettings
  onSettingsChange: (settings: ExtensionSettings) => void
}) {
  const [draft, setDraft] = useState(settings)
  const [modelApiKey, setModelApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const rows = [
    { id: 'general', order: 10, label: '通用' },
    {
      id: 'asr',
      order: 20,
      label: (
        <>
          <IconPlayOutline16 className="momentq-settings-nav-icon" size={16} />
          <span>语音识别</span>
        </>
      ),
    },
  ] as const

  useEffect(() => {
    let active = true
    void loadModelApiKey().then((stored) => {
      if (active) setModelApiKey(current => current === '' ? stored : current)
    }).catch((error: unknown) => {
      if (active) setSaveError(error instanceof Error ? error.message : '无法读取本地模型 API Key')
    })
    return () => { active = false }
  }, [])

  const setTheme = (theme: ThemePreference) => {
    const next = { ...draft, theme }
    setDraft(next)
    applyTheme(theme)
    void saveSettings(next).then(onSettingsChange)
  }

  const saveAndClose = async (close: () => void) => {
    setSaving(true)
    setSaveError(null)
    try {
      const normalized = sanitizeSettings(draft)
      if (modelApiKey !== '') {
        await new MomentQClient({ baseUrl: normalized.hostBaseUrl }).setModelApiKey(modelApiKey)
      }
      await saveModelApiKey(modelApiKey)
      const saved = await saveSettings(normalized)
      setDraft(saved)
      onSettingsChange(saved)
      close()
    } catch (error) {
      setSaveError(saveErrorMessage(error, sanitizeSettings(draft).hostBaseUrl))
    } finally {
      setSaving(false)
    }
  }

  const renderSlot: RenderSlot = (slot, props, options) => {
    if (slot === 'settings.trigger') return <TriggerContent wide={Boolean(props.wide)} t={key => key === 'trigger' ? '设置' : key} />
    if (slot === 'settings.header') return <HeaderContent t={() => '设置'} />
    if (slot === 'settings.close') return <CloseLabel t={() => '关闭'} />
    if (slot === 'settings.action' || slot === 'settings.onboarding') return null
    if (slot === 'settings.section' && options?.only === 'general') {
      const close = typeof props.close === 'function' ? props.close as () => void : () => undefined
      return (
        <GeneralSection
          renderSlot={() => (
            <div data-slot="settings.general.item">
              <GeneralSettingsSection
                draft={draft}
                setDraft={setDraft}
                setTheme={setTheme}
                modelApiKey={modelApiKey}
                setModelApiKey={setModelApiKey}
                saving={saving}
                saveError={saveError}
                onSave={() => { void saveAndClose(close) }}
              />
            </div>
          )}
        />
      )
    }
    if (slot === 'settings.section' && options?.only === 'asr') {
      return (
        <AsrSection
          draft={draft}
          setDraft={setDraft}
          saving={saving}
          saveError={saveError}
          onSave={() => {
            if (typeof props.close === 'function') void saveAndClose(props.close as () => void)
          }}
        />
      )
    }
    return null
  }

  return (
    <div className="momentq-settings">
      <SettingsRoot
        wide={false}
        useSections={selector => selector(rows)}
        useOnboardingSteps={selector => selector([])}
        useSessions={selector => selector({ phase: 'ready', current: 'default', byId: {} })}
        renderSlot={renderSlot}
      />
    </div>
  )
}
