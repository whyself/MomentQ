# MomentQ Browser Extension UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the visible MomentQ Chrome/Edge side-panel UI and Bilibili transcription control as a loadable MV3 extension while preserving the pinned DSH WebUI visual system exactly and adding non-secret ASR/companion settings placeholders.

**Architecture:** The extension remains a standalone browser frontend, not a DSH plugin. React composes byte-identical vendored DSH components, CSS Modules, theme tokens, and icons through small MomentQ adapters; browser state and settings stay in extension-owned modules. Sensitive ASR credentials and actual audio/ASR transport remain exclusively in the future local `companion/` service.

**Tech Stack:** React 18, TypeScript, Vite, Vitest, Chrome MV3 Side Panel API, `chrome.storage.local`, pinned deepseek-harness UI sources at `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`.

---

## File Structure

- `extension/scripts/vendor-dsh-frontend.mjs`: expand the reproducible byte-identical vendor selection to DSH general settings.
- `extension/src/vendor/deepseek-harness/**`: generated upstream-only sources and checksums; never hand edit.
- `extension/src/dsh/primitives.ts`: narrow runtime face for only the upstream primitives/icons required by the extension.
- `extension/src/shared/settings.ts`: validated non-secret extension settings schema and defaults.
- `extension/src/shared/settings-store.ts`: `chrome.storage.local` persistence adapter.
- `extension/src/sidepanel/App.tsx`: side-panel state composition and switching between conversation and settings.
- `extension/src/sidepanel/ConversationView.tsx`: Bilibili-context conversation shell assembled from upstream DSH CSS/components.
- `extension/src/sidepanel/SettingsView.tsx`: upstream `SettingsRoot` adapter plus General and ASR sections.
- `extension/src/sidepanel/theme.ts`: light/dark/system preference bridge using DSH theme attributes.
- `extension/src/sidepanel/index.tsx`: React entry and existing tab-state controller wiring.
- `extension/src/sidepanel/composition.css`: geometry-only full-height side-panel composition; no visual tokens.
- `extension/src/content/transcription-control.tsx`: Shadow DOM page control using upstream DSH Button and play/pause icons.
- `extension/src/content/index.tsx`: existing page relay plus transcription-control mount/state sync.
- `extension/tests/settings.test.ts`: schema, sanitization, defaults, and no-secret tests.
- `extension/tests/ui-contract.test.ts`: upstream reuse and forbidden custom styling checks.
- `extension/tests/build.test.ts`: MV3 output and self-contained entry checks.
- `extension/README.md`: build, load-unpacked, current UI, and ASR boundary documentation.

### Task 1: Expand pinned DSH vendor surface

**Files:**
- Modify: `extension/scripts/vendor-dsh-frontend.mjs`
- Regenerate: `extension/src/vendor/deepseek-harness/manifest.json`
- Regenerate: `extension/src/vendor/deepseek-harness/packages/client/ui-settings-general/src/**`
- Test: `extension/tests/vendor-integrity.test.ts`

- [x] **Step 1: Add an integrity assertion for `ui-settings-general`**

Assert that the generated vendor manifest includes `packages/client/ui-settings-general/src` and that every vendored file hashes to the manifest value.

- [x] **Step 2: Run the focused test and verify it fails**

Run: `pnpm --filter momentq-browser-extension test -- vendor-integrity.test.ts`

Expected: FAIL because the new selection is absent.

- [x] **Step 3: Add the pinned selection and regenerate mechanically**

Add exactly `packages/client/ui-settings-general/src` to `selections`, then run:

`pnpm --filter momentq-browser-extension vendor:dsh -- C:\Users\11588\AppData\Local\Temp\momentq-deepseek-harness-b150a551`

Expected: generated sources and SHA-256 manifest from commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`.

- [x] **Step 4: Re-run integrity tests**

Expected: PASS with byte-identical upstream files.

### Task 2: Add React/Vite adapter layer

**Files:**
- Modify: `extension/package.json`
- Modify: `extension/tsconfig.json`
- Modify: `extension/vite.config.ts`
- Create: `extension/src/dsh/primitives.ts`
- Test: `extension/tests/ui-contract.test.ts`

- [x] **Step 1: Write a UI contract test**

Check that React entries import vendored DSH files, that `@deepseek-ai/dsh-client-ui-primitives` resolves only to the narrow adapter, and that extension-authored CSS contains no colors, shadows, fonts, border radii, or copied SVG data.

- [x] **Step 2: Run the focused test and verify it fails**

Run: `pnpm --filter momentq-browser-extension test -- ui-contract.test.ts`

Expected: FAIL because the adapter and UI files do not exist.

- [x] **Step 3: Add React dependencies and JSX compilation**

Install exact React 18 runtime/types plus `clsx`, enable `react-jsx`, include `.tsx`, and alias the DSH primitive package name to `src/dsh/primitives.ts` without importing the upstream primitive barrel.

- [x] **Step 4: Implement the narrow adapter**

Re-export only upstream `Button`, `Input`, `Menu`, `FishLogo`, and the exact icons needed by `SettingsRoot`, `AppearanceRow`, side panel, and transcription control. Do not copy SVG markup.

- [x] **Step 5: Run typecheck and the UI contract test**

Expected: PASS.

### Task 3: Persist non-sensitive ASR and host settings

**Files:**
- Create: `extension/src/shared/settings.ts`
- Create: `extension/src/shared/settings-store.ts`
- Create: `extension/tests/settings.test.ts`

- [ ] **Step 1: Write settings schema tests**

Cover defaults, malformed storage fallback, URL normalization, `baidu` provider validation, subtitle behavior values, automatic-connect boolean, and rejection/stripping of keys named `apiKey`, `secretKey`, `accessToken`, or `password`.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm --filter momentq-browser-extension test -- settings.test.ts`

Expected: FAIL because the settings module does not exist.

- [ ] **Step 3: Implement the minimal validated settings model**

Use defaults `hostBaseUrl: http://127.0.0.1:3080`, `companionBaseUrl: http://127.0.0.1:3090`, `asrProvider: baidu`, `subtitleMode: append`, and `autoConnect: true`. Export only non-secret fields.

- [ ] **Step 4: Implement `chrome.storage.local` load/save**

Store one versioned `momentq.settings` object and pass every read through validation before returning it to UI code.

- [ ] **Step 5: Run settings tests**

Expected: PASS and no credential field exists in the exported type or stored object.

### Task 4: Assemble the DSH side-panel UI

**Files:**
- Modify: `extension/sidepanel.html`
- Rename/Modify: `extension/src/sidepanel/index.ts` to `extension/src/sidepanel/index.tsx`
- Create: `extension/src/sidepanel/App.tsx`
- Create: `extension/src/sidepanel/ConversationView.tsx`
- Create: `extension/src/sidepanel/composition.css`
- Test: `extension/tests/ui-contract.test.ts`

- [ ] **Step 1: Add structural tests for side-panel behavior**

Assert a single default session, no workspace/session browser, Bilibili title display, part label only when the page has multiple parts, and use of upstream conversation/header/input/hero classes.

- [ ] **Step 2: Run the focused test and verify it fails**

Expected: FAIL because the React view does not exist.

- [ ] **Step 3: Build the stateful React entry**

Keep `SidePanelStateController`; expose its state through React state rather than document-only events and retain active-tab switching and background messages.

- [ ] **Step 4: Compose the conversation shell from pinned sources**

Import DSH theme CSS and upstream `ConversationRoot.module.css`, `HeroShell.module.css`, and `InputBar.module.css`. Bind Bilibili title/creator/part data, omit “第 1 集” for single-part videos, and keep input behavior visibly disabled until the SDK transport exists.

- [ ] **Step 5: Limit authored CSS to geometry**

Allow only document reset/full-height layout and fixed side-panel composition. Every visible color, type, spacing, radius, border, shadow, and icon must come from upstream DSH classes/tokens.

- [ ] **Step 6: Run typecheck and focused tests**

Expected: PASS.

### Task 5: Add settings through upstream SettingsRoot

**Files:**
- Create: `extension/src/sidepanel/SettingsView.tsx`
- Create: `extension/src/sidepanel/theme.ts`
- Modify: `extension/src/sidepanel/App.tsx`
- Test: `extension/tests/settings-view.test.tsx`

- [ ] **Step 1: Write adapter and settings-view tests**

Test two sections (`general`, `asr`), upstream trigger/header/close chrome, persisted field changes, DSH theme preference, and absence of credential inputs.

- [ ] **Step 2: Run the focused test and verify it fails**

Expected: FAIL because `SettingsView` does not exist.

- [ ] **Step 3: Adapt upstream `SettingsRoot` without DSH runtime registration**

Provide local stable hooks for section rows/onboarding/sessions and a typed `renderSlot` router. Do not call `ctx.slots.register()` and do not instantiate the DSH plugin system.

- [ ] **Step 4: Reuse upstream General and appearance styling**

Render the pinned `AppearanceRow` with a small local preference store and update `document.documentElement.dataset.theme` while honoring system preference.

- [ ] **Step 5: Render ASR placeholders in upstream row controls**

Use upstream General/EnterBehavior row CSS plus DSH `Input`, `Menu`, and `Button` for host address, companion address, provider, subtitle behavior, auto-connect, save action, and connection-state copy. State explicitly that credentials are managed by the local companion; include no secret field.

- [ ] **Step 6: Run settings and UI contract tests**

Expected: PASS.

### Task 6: Add the Bilibili transcription control

**Files:**
- Rename/Modify: `extension/src/content/index.ts` to `extension/src/content/index.tsx`
- Create: `extension/src/content/transcription-control.tsx`
- Modify: `extension/src/shared/protocol.ts`
- Modify: `extension/vite.config.ts`
- Test: `extension/tests/transcription-control.test.tsx`

- [ ] **Step 1: Write control state tests**

Verify no control outside supported Bilibili context, paused/inactive shows the upstream play icon, active shows upstream pause, click sends only `MOMENTQ_TOGGLE_TRANSCRIPTION`, and clicking never opens the side panel.

- [ ] **Step 2: Run the focused test and verify it fails**

Expected: FAIL because the visible control does not exist.

- [ ] **Step 3: Mount an isolated Shadow DOM React control**

Use upstream DSH Button CSS/tokens and `IconPlayOutline16`/`IconPauseOutline16`; inject only geometry required to anchor it at the Bilibili page side.

- [ ] **Step 4: Synchronize per-tab transcription state**

Relay background state updates to the isolated control and send toggle messages from its click handler without coupling it to side-panel opening.

- [ ] **Step 5: Run focused tests and build**

Expected: PASS and the content bundle remains a self-contained MV3 classic script.

### Task 7: Package and verify the loadable extension

**Files:**
- Modify: `extension/README.md`
- Modify: `extension/tests/build-output.test.ts`
- Generate: `extension/dist/**`

- [ ] **Step 1: Extend build-output assertions**

Check `dist/manifest.json`, side-panel HTML/assets, background/content/page bridge entries, no unresolved static imports in classic scripts, and all referenced files exist.

- [ ] **Step 2: Run all extension tests, typecheck, and build**

Run: `pnpm --filter momentq-browser-extension test && pnpm --filter momentq-browser-extension typecheck && pnpm --filter momentq-browser-extension build`

Expected: all pass and `extension/dist` is regenerated.

- [ ] **Step 3: Run root regression checks**

Run: `pnpm test && pnpm typecheck && pnpm build`

Expected: DSH bundle and extension both pass.

- [ ] **Step 4: Perform visual QA against the original prototype**

Serve `extension/dist`, inspect the side panel at realistic widths, compare against `extension/prototype/index.html`, and correct only composition/data-binding differences. Do not “improve” upstream visuals.

- [ ] **Step 5: Document loading and current capability boundary**

Document Chrome/Edge “Load unpacked” using `D:\Projects\MomentQ\extension\dist`, supported Bilibili pages, `Alt+Q`, the page transcription toggle, stored non-secret settings, and that real ASR requires the future local companion.
