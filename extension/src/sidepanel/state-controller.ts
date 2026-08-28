import type {
  GetTabStateMessage,
  MomentQTabState,
  TabStateChangedMessage,
  ToggleTranscriptionMessage,
} from '../shared/protocol'

type ControllerRequest = GetTabStateMessage | ToggleTranscriptionMessage

export type SidePanelControllerDependencies = {
  queryActiveTabId: () => Promise<number | null>
  sendMessage: (message: ControllerRequest) => Promise<MomentQTabState | null>
  publishState: (state: MomentQTabState | null) => void
}

export class SidePanelStateController {
  private activeTabId: number | null = null
  private generation = 0
  private readonly latestRevision = new Map<number, number>()

  constructor(private readonly dependencies: SidePanelControllerDependencies) {}

  private async publishIfCurrent(
    tabId: number,
    generation: number,
    state: MomentQTabState | null,
  ): Promise<void> {
    if (generation !== this.generation) return
    const activeTabId = await this.dependencies.queryActiveTabId()
    if (generation !== this.generation || activeTabId !== tabId) return
    this.activeTabId = tabId
    this.dependencies.publishState(state)
  }

  private async loadTab(tabId: number, generation: number): Promise<MomentQTabState | null> {
    const state = await this.dependencies.sendMessage({
      type: 'MOMENTQ_GET_TAB_STATE',
      tabId,
    })
    await this.publishIfCurrent(tabId, generation, state)
    return state
  }

  async loadActiveTabState(): Promise<MomentQTabState | null> {
    const generation = ++this.generation
    const tabId = await this.dependencies.queryActiveTabId()
    if (generation !== this.generation) return null
    this.activeTabId = tabId
    if (tabId === null) {
      this.dependencies.publishState(null)
      return null
    }
    return this.loadTab(tabId, generation)
  }

  activateTab(tabId: number): Promise<MomentQTabState | null> {
    const generation = ++this.generation
    this.activeTabId = tabId
    return this.loadTab(tabId, generation)
  }

  async toggleTranscription(): Promise<MomentQTabState | null> {
    const generation = ++this.generation
    const tabId = await this.dependencies.queryActiveTabId()
    if (generation !== this.generation || tabId === null) return null
    this.activeTabId = tabId
    const state = await this.dependencies.sendMessage({
      type: 'MOMENTQ_TOGGLE_TRANSCRIPTION',
      tabId,
    })
    await this.publishIfCurrent(tabId, generation, state)
    return state
  }

  handleStateChanged(message: TabStateChangedMessage): void {
    if (message.tabId !== this.activeTabId) return
    if (message.revision !== undefined) {
      const previous = this.latestRevision.get(message.tabId) ?? 0
      if (message.revision <= previous) return
      this.latestRevision.set(message.tabId, message.revision)
    }
    this.generation += 1
    this.dependencies.publishState(message.state)
  }
}
