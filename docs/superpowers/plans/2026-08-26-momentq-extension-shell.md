# MomentQ Browser Extension Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a loadable Chrome/Edge Manifest V3 extension shell that detects the active Bilibili video or live occurrence, opens an independent side panel, and maintains per-tab transcription state without implementing or restyling the DSH-derived conversation UI.

**Architecture:** The extension is a standalone Vite application under `extension/`. A MAIN-world page bridge reads Bilibili page state and posts a strictly validated snapshot to an isolated content script; the background service worker owns per-tab state and side-panel opening; the side-panel controller consumes that state. DSH UI source remains byte-locked in `extension/src/vendor/deepseek-harness` and is not registered as a DSH plugin.

**Tech Stack:** TypeScript 6, Vite 6, Vitest 4, Chrome/Edge Manifest V3, `chrome.sidePanel`, browser `postMessage` and runtime messaging.

---

## File map

```text
extension/
├─ public/manifest.json              # MV3 permissions, entries and command
├─ sidepanel.html                    # independent side-panel document
├─ vite.config.ts                    # fixed multi-entry build names
├─ src/
│  ├─ shared/protocol.ts             # validated message and tab-state types
│  ├─ shared/bilibili.ts             # pure URL/page-state normalization
│  ├─ background/state.ts            # pure per-tab reducer
│  ├─ background/index.ts            # sidePanel and message wiring
│  ├─ content/page-bridge.ts         # MAIN-world Bilibili snapshot publisher
│  ├─ content/index.ts               # isolated relay and validation boundary
│  └─ sidepanel/index.ts             # state controller for the later DSH UI adapter
└─ tests/
   ├─ bilibili.spec.ts
   ├─ state.spec.ts
   └─ manifest.spec.ts
```

### Task 1: Scaffold the loadable MV3 build

**Files:**
- Modify: `extension/package.json`
- Modify: `extension/tsconfig.json`
- Create: `extension/vite.config.ts`
- Create: `extension/public/manifest.json`
- Create: `extension/sidepanel.html`
- Test: `extension/tests/manifest.spec.ts`

- [x] **Step 1: Write the failing manifest test**

Read `public/manifest.json` and assert `manifest_version === 3`, the background worker is `assets/background.js`, the side panel is `sidepanel.html`, MAIN and ISOLATED content scripts are both present on Bilibili matches, and `open-side-panel` has an `Alt+Q` suggested shortcut.

- [x] **Step 2: Run the test to verify failure**

Run: `pnpm --filter momentq-browser-extension exec vitest run tests/manifest.spec.ts`

Expected: FAIL because `public/manifest.json` does not exist.

- [x] **Step 3: Add the Vite multi-entry build and manifest**

Use fixed Rollup entry names `background`, `content`, and `page-bridge`; keep chunks and CSS under `assets/`. The manifest must request only `sidePanel`, `storage`, and `tabs`, match `https://www.bilibili.com/*` and `https://live.bilibili.com/*`, and allow the loopback Host through `http://127.0.0.1/*`.

- [x] **Step 4: Run the focused test and production build**

Run: `pnpm --filter momentq-browser-extension exec vitest run tests/manifest.spec.ts`

Expected: PASS.

Run: `pnpm --filter momentq-browser-extension build`

Expected: `extension/dist/manifest.json`, `sidepanel.html`, and all three fixed JavaScript entries exist.

### Task 2: Normalize Bilibili content identity and conditional part metadata

**Files:**
- Create: `extension/src/shared/protocol.ts`
- Create: `extension/src/shared/bilibili.ts`
- Test: `extension/tests/bilibili.spec.ts`

- [x] **Step 1: Write failing normalization tests**

Cover VOD URLs with and without `p`, live room URLs, malformed ids, a VOD snapshot with `cid`, and the rule that `part` is absent unless the snapshot proves the content has multiple pages and identifies the current page.

- [x] **Step 2: Run the test to verify failure**

Run: `pnpm --filter momentq-browser-extension exec vitest run tests/bilibili.spec.ts`

Expected: FAIL because the normalizer is missing.

- [x] **Step 3: Implement strict types and pure normalization**

Export `BilibiliPageSnapshot`, `BilibiliContext`, `parseBilibiliLocation()` and `normalizeBilibiliContext()`. VOD identity must contain `bvid` and decimal `cid`; live identity must contain the canonical decimal room id and a valid ISO live start time. Never synthesize `第 1 集` or another part label.

- [x] **Step 4: Run focused tests**

Run: `pnpm --filter momentq-browser-extension exec vitest run tests/bilibili.spec.ts`

Expected: all identity and conditional-part cases pass.

### Task 3: Add the Bilibili MAIN-world bridge and isolated relay

**Files:**
- Create: `extension/src/content/page-bridge.ts`
- Create: `extension/src/content/index.ts`
- Modify: `extension/src/shared/protocol.ts`

- [x] **Step 1: Define the page-to-extension message envelope**

Use `{ source: 'momentq-page', version: 1, type: 'PAGE_SNAPSHOT', payload }`. Validation must reject inherited properties, wrong origins, unknown types and invalid snapshot field types.

- [x] **Step 2: Implement the MAIN-world publisher**

Read `window.__INITIAL_STATE__`, `window.__playinfo__`, the canonical URL and document metadata without modifying the page. Publish once on load and again after `popstate`, `hashchange`, patched history navigation, and debounced DOM mutations.

- [x] **Step 3: Implement the isolated relay**

Accept messages only when `event.source === window`, `event.origin === location.origin`, and the envelope validates. Normalize the snapshot and send `{ type: 'MOMENTQ_PAGE_CONTEXT', context }` to the background worker.

- [x] **Step 4: Run typecheck and build**

Run: `pnpm --filter momentq-browser-extension typecheck`

Expected: PASS.

Run: `pnpm --filter momentq-browser-extension build`

Expected: both content script files build as fixed MV3 entries.

### Task 4: Own per-tab context and transcription state in the service worker

**Files:**
- Create: `extension/src/background/state.ts`
- Create: `extension/src/background/index.ts`
- Test: `extension/tests/state.spec.ts`

- [x] **Step 1: Write failing reducer tests**

Assert a new context starts with `transcription: 'inactive'`, the same identity preserves its state, a different identity resets it, only `inactive → active → paused → active` transitions are accepted, and closing a tab removes its state.

- [x] **Step 2: Run the test to verify failure**

Run: `pnpm --filter momentq-browser-extension exec vitest run tests/state.spec.ts`

Expected: FAIL because the reducer is missing.

- [x] **Step 3: Implement the pure reducer and worker wiring**

Store the serializable state in `chrome.storage.session` under `tab:<id>`. Enable the side panel only for detected Bilibili tabs. Configure action-click opening, open it from the `open-side-panel` command under the command user gesture, answer `MOMENTQ_GET_TAB_STATE`, and apply `MOMENTQ_TOGGLE_TRANSCRIPTION`.

- [x] **Step 4: Run reducer tests, typecheck and build**

Run: `pnpm --filter momentq-browser-extension exec vitest run tests/state.spec.ts`

Expected: PASS.

Run: `pnpm --filter momentq-browser-extension typecheck && pnpm --filter momentq-browser-extension build`

Expected: PASS.

### Task 5: Add the independent side-panel state controller

**Files:**
- Create: `extension/src/sidepanel/index.ts`
- Modify: `extension/sidepanel.html`
- Modify: `extension/README.md`

- [x] **Step 1: Implement active-tab state loading**

The side panel queries the active tab, asks the worker for `MOMENTQ_GET_TAB_STATE`, subscribes to `MOMENTQ_TAB_STATE_CHANGED`, and exposes the current state through one `momentq:state` `CustomEvent` on `document` for the upcoming DSH-source UI adapter.

- [x] **Step 2: Expose the transcription command without drawing UI**

Export `toggleTranscription()` from the controller. It sends `MOMENTQ_TOGGLE_TRANSCRIPTION` and returns the authoritative worker state. Do not add HTML controls or CSS in this task.

- [x] **Step 3: Document loading and invocation**

Document `pnpm --filter momentq-browser-extension build`, loading `extension/dist` as an unpacked extension, action-click opening, and `Alt+Q`. State explicitly that the visual side-panel adapter is the next plan and must consume the pinned DSH source.

- [x] **Step 4: Run all extension checks**

Run: `pnpm --filter momentq-browser-extension test && pnpm --filter momentq-browser-extension typecheck && pnpm --filter momentq-browser-extension build`

Expected: all tests pass and the unpacked extension payload is produced.
