declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css' {}

declare module '*?inline' {
  const source: string
  export default source
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  export type HostObservable<T> = (selector: (state: T) => unknown) => unknown
  export type InjectFace<T> = T & {
    useSections: <R>(selector: (state: readonly { id: string; order: number; label: string }[]) => R) => R
    useOnboardingSteps: <R>(selector: (state: readonly { id: string; order: number }[]) => R) => R
  }
  export type PropsLocale<T extends string> = { t: (key: string) => string }
  export type PropsRenderSlots<T extends string> = {
    renderSlot: (slot: string, props: Record<string, unknown>, options?: { only: string }) => React.ReactNode
  }
  export type PropsRuntime<T extends string> =
    T extends 'sidebar.settings'
      ? { wide: boolean; useSessions: <R>(selector: (state: { phase: string; current?: string; byId: Record<string, { blank?: boolean }> }) => R) => R }
      : T extends 'settings.trigger'
        ? { wide: boolean }
        : Record<string, unknown>
  export type PropsStore<T> = { useStore: (selector: (state: any) => unknown) => unknown }
}

declare module '@deepseek-ai/dsh-client-ui-sidebar/*' {}
declare module '@deepseek-ai/dsh-client-ui-settings/client' {}
declare module '@deepseek-ai/dsh-client-runtime/client' {
  export type EngineStoreHandle<S, A> = unknown
  export function defineStore<T>(options: T): unknown
}
