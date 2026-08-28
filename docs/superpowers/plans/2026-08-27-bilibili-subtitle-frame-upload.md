# Bilibili Subtitle and Current-Frame Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Bilibili subtitle acquisition work with the signed-in page context and restore the DSH-native current-frame image attachment shortcut and preview flow.

**Architecture:** Subtitle requests will be issued by the Bilibili page-world bridge (same-origin browser session), then relayed to the extension worker for Host persistence. Frame capture will use the player video element and the existing vendored DSH attachment primitives; the captured image travels through the typed Host API and is admitted as a durable image attachment before the native DSH user message is created.

**Tech Stack:** TypeScript, React, Chrome MV3 content/page bridge, DSH vendored UI components and attachment contracts, Vitest.

---

### Task 1: Page-context subtitle relay

**Files:**
- Modify: `extension/src/shared/protocol.ts`
- Modify: `extension/src/content/page-bridge.ts`
- Modify: `extension/src/content/index.tsx`
- Modify: `extension/src/background/index.ts`
- Test: `extension/tests/bilibili-subtitle.spec.ts`

- [x] Add a validated `PAGE_SUBTITLE` envelope carrying BVID, CID, and normalized segments.
- [x] Read page/player subtitle tracks (including `list`, `subtitles`, and `biliapi.com` URLs), try both `x/player/v2` and `x/player/wbi/v2`, cancel stale requests on navigation, and post only non-empty validated segments.
- [x] Sample rendered Bilibili AI subtitle lines (`.bpx-player-subtitle-wrap`) against the video clock when the player exposes no downloadable URL.
- [x] Relay the envelope through the isolated content script and atomically sync it only when the stored tab identity matches.
- [x] Add tests for envelope validation and stale/malformed subtitle payloads.

### Task 2: Current-frame capture and DSH attachment submission

**Files:**
- Modify: `extension/src/sidepanel/ConversationView.tsx`
- Modify: `extension/src/sidepanel/App.tsx`
- Modify: `dsh/packages/bundle/src/index.ts`
- Modify: `dsh/packages/bundle/src/http-api.ts`
- Modify: `dsh/packages/bundle/src/sdk.ts`
- Modify: `extension/src/shared/host-client.ts`
- Test: `extension/tests/conversation-view.spec.tsx`
- Test: `dsh/packages/bundle/tests/http-api.spec.ts`

- [x] Add a keyboard shortcut handler that requests the active tab's video frame and places it in the composer attachment rail.
- [x] Render the attachment rail using the vendored DSH attachment slot classes and native remove/preview affordances.
- [ ] Extend the typed stream request with ordered encoded image attachments, enforce DSH media/size limits, persist through the Host attachment store, and pass image blocks to `createUserMessage`.
- [ ] Preserve native DSH streaming lifecycle and ensure attachments are released after submit or cancellation.
- [ ] Test capture failure, attachment preview/removal, and image-inclusive stream payloads.

### Task 3: Build and verification

- [ ] Run `pnpm test -- --run`.
- [ ] Run `pnpm --filter momentq-browser-extension typecheck` and `pnpm --filter momentq-browser-extension build`.
- [ ] Reload `extension/dist` in the browser, refresh a logged-in Bilibili video, verify a subtitle-bearing video imports `transcript.jsonl`, and verify the shortcut shows the captured frame in the composer before sending.
