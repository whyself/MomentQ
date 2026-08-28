# Capture and Subtitle Stream UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or **superpowers:executing-plans** to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make video-frame capture reliable, avoid browser shortcut conflicts, import complete rendered/native Bilibili subtitles without starting ASR, persist them as one transcript, and show a fading DeepSeek-style subtitle ticker above the composer.

**Architecture:** Keep frame capture in the page content script using the active `<video>` element and move the user shortcut to an extension-owned command plus a non-conflicting Side Panel shortcut. Make the MAIN-world bridge isolated and pass the Host-resolved BVID/CID into it so it can sample visible `[role="caption"]` text; emit cumulative timed segments through the existing `PAGE_SUBTITLE` protocol and let Host replacement persistence provide the same JSONL shape as ASR. Add a geometry-only ticker that consumes the latest subtitle segments from tab state/events and uses vendored DSH typography/colors.

**Tech Stack:** TypeScript, React 18, Vite, Chrome MV3, Canvas, Bilibili DOM subtitle nodes, MomentQ Host API, Vitest.

---

### Task 1: Repair content/page bridge runtime isolation

**Files:**
- Modify: `extension/vite.content.config.ts`
- Modify: `extension/src/content/page-bridge.ts`
- Test: `extension/tests/build-output.spec.ts`

- [ ] **Step 1: Add regression assertions**

Assert the production content bundle contains a production `NODE_ENV` replacement and the page bridge output is wrapped so its minified top-level names cannot collide with page globals.

- [ ] **Step 2: Implement the build/runtime fix**

Define `process.env.NODE_ENV` as `"production"` for the content build and compile the page bridge as an IIFE (or equivalent source closure) while preserving the MV3 classic script entry.

- [ ] **Step 3: Run focused build checks**

Run `pnpm --filter momentq-browser-extension build` and `pnpm --filter momentq-browser-extension test -- build-output.spec.ts`.

### Task 2: Use an extension-owned, non-conflicting frame shortcut

**Files:**
- Modify: `extension/public/manifest.json`
- Modify: `extension/src/shared/protocol.ts`
- Modify: `extension/src/background/index.ts`
- Modify: `extension/src/sidepanel/ConversationView.tsx`
- Test: `extension/tests/manifest.spec.ts`
- Test: `extension/tests/conversation-view.spec.tsx`

- [ ] **Step 1: Add a command and protocol message**

Register `capture-current-frame` with suggested `Alt+Shift+F`, handle it from the command callback, and route the existing capture request to the active tab's `<video>` listener.

- [ ] **Step 2: Update the Side Panel shortcut**

Replace `Alt+Shift+S` with `Alt+Shift+F`; keep the plus button behavior unchanged.

- [ ] **Step 3: Test shortcut ownership and capture routing**

Assert the manifest command, the new key hint, and that capture requests use `MOMENTQ_CAPTURE_CURRENT_FRAME` rather than browser screenshot APIs.

### Task 3: Make subtitle acquisition prefer native/AI rendered captions and never start ASR

**Files:**
- Modify: `extension/src/shared/protocol.ts`
- Modify: `extension/src/content/page-bridge.ts`
- Modify: `extension/src/content/index.tsx`
- Modify: `extension/src/background/index.ts`
- Modify: `extension/src/shared/bilibili-subtitle.ts`
- Test: `extension/tests/bilibili-subtitle.spec.ts`

- [ ] **Step 1: Add context handoff and source markers**

Add a validated page message carrying the resolved BVID/CID from Background to MAIN-world bridge, and add a subtitle source marker (`bilibili` covers both downloadable and rendered captions) so successful subtitle import suppresses ASR activation.

- [ ] **Step 2: Replace broad subtitle probing with targeted acquisition**

Use `x/player/v2`/`wbi/v2` only when a concrete track is present; otherwise sample `.bpx-player-subtitle-wrap [role="caption"]` against `video.currentTime`. Do not enumerate unrelated subtitle endpoints or call any ASR/companion API when non-empty subtitle segments are available.

- [ ] **Step 3: Stream finalized segments to Host**

Emit cumulative finalized rows as the caption changes, relay only matching BVID/CID, and call `syncTranscript(identity, 'bilibili', segments)` so `transcript.jsonl` has the same `{start,end,text}` JSONL format as ASR output.

- [ ] **Step 4: Add tests for AI caption DOM and ASR suppression**

Cover visible caption extraction, timestamp boundaries, stale identity rejection, and the rule that a successful Bilibili subtitle source leaves transcription inactive.

### Task 4: Add the fading subtitle ticker above the composer

**Files:**
- Modify: `extension/src/shared/protocol.ts`
- Modify: `extension/src/content/index.tsx`
- Modify: `extension/src/sidepanel/App.tsx`
- Modify: `extension/src/sidepanel/ConversationView.tsx`
- Modify: `extension/src/sidepanel/composition.css`
- Test: `extension/tests/conversation-view.spec.tsx`

- [ ] **Step 1: Expose recent subtitle segments per tab**

Keep a bounded recent list in the background/session state and publish it with tab state changes; clear it when the content identity changes.

- [ ] **Step 2: Render the DSH-style ticker**

Place it immediately above the composer, use vendored DSH classes/tokens for text, and author only geometry/overflow/opacity transitions locally. Newer lines stay fully opaque; older lines move upward and fade.

- [ ] **Step 3: Verify layout and behavior**

Assert ticker placement, bounded rendering, identity reset, and that it remains absent when no subtitle is currently available.

### Task 5: Full verification and documentation

**Files:**
- Modify: `extension/README.md`
- Modify: `docs/project-plan.md`

- [ ] **Step 1: Run all checks**

Run `pnpm test`, `pnpm typecheck`, and `pnpm build`.

- [ ] **Step 2: Document shortcut and subtitle behavior**

Document `Alt+Shift+F`, Canvas capture from `<video>`, AI/native subtitle preference, JSONL persistence, and the ASR suppression rule.
