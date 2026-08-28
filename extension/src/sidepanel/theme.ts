import type { ThemePreference } from '../shared/settings'

let media: MediaQueryList | null = null
let listener: (() => void) | null = null

export function applyTheme(preference: ThemePreference): void {
  if (media !== null && listener !== null) media.removeEventListener('change', listener)
  media = window.matchMedia('(prefers-color-scheme: dark)')
  const update = () => {
    const dark = preference === 'dark' || (preference === 'system' && media?.matches === true)
    document.body.toggleAttribute('data-ds-dark-theme', dark)
  }
  listener = update
  media.addEventListener('change', update)
  update()
}
