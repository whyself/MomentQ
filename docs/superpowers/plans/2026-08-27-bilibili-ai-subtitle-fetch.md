# Bilibili AI Subtitle Fetch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fetch the AI/native subtitle track that the current Bilibili player loads through `/x/v2/subtitle/web/view`, even when `videoData.subtitle.list[].subtitle_url` is empty.

**Architecture:** Extend the shared Bilibili subtitle adapter with a subtitle-index request that uses the page's `aid`/`cid` and preferred language, then normalize the returned track URL/body with strict BVID/CID identity checks. Keep the existing player/v2 path as a fallback and route both the page bridge and background fetcher through the same parser so the side panel and saved transcript use identical data.

**Tech Stack:** TypeScript, Chrome extension content/background scripts, Vitest, Vite.

---

### Task 1: Define failing coverage for URL-less AI tracks

**Files:**
- Modify: `extension/tests/bilibili-subtitle.spec.ts`
- Modify: `extension/src/shared/bilibili-subtitle.ts`

- [x] **Step 1: Add a fixture for `videoData.subtitle.list` with `lan: ai-zh` and an empty `subtitle_url`, plus a `/x/v2/subtitle/web/view` response containing a signed `subtitle_url` and timed body.**
- [x] **Step 2: Add assertions that the preferred language is `ai-zh`, the returned body normalizes to `{start,end,text}`, and a mismatched `bvid`/`cid` response is rejected.**
- [x] **Step 3: Run the focused subtitle tests; the new protobuf URL extraction test passes.**

### Task 2: Implement the Bilibili subtitle-web resolver

**Files:**
- Modify: `extension/src/shared/bilibili-subtitle.ts`
- Modify: `extension/src/background/bilibili-subtitle.ts`
- Modify: `extension/src/content/page-bridge.ts`

- [x] **Step 1: Add a parser for the protobuf `/x/v2/subtitle/web/view` response and validate signed subtitle hosts.**
- [x] **Step 2: Build the request from the current snapshot (`aid` from page metadata, `cid`, `preferred_language=ai-zh`, `type=1`, `cur_production_type=0`, `playlist_switch=0`) and fetch with page credentials.**
- [x] **Step 3: Publish the returned signed track URL only when the response is still for the visible BVID/CID; the background fetcher normalizes its timed entries.**
- [x] **Step 4: Preserve the existing `/x/player/wbi/v2` and `/x/player/v2` paths as fallbacks for older/native tracks.**
- [x] **Step 5: Run the focused subtitle tests and verify they pass.**

### Task 3: Build and verify the extension artifact

**Files:**
- Verify: `extension/public/manifest.json`
- Verify: `extension/dist/manifest.json`

- [x] **Step 1: Run `pnpm --filter momentq-browser-extension typecheck`.**
- [x] **Step 2: Run `pnpm --filter momentq-browser-extension test` (93 tests passed).**
- [x] **Step 3: Run `pnpm --filter momentq-browser-extension build`.**
- [x] **Step 4: Confirm the built manifest is version `0.1.7` and contains the updated page bridge/background bundles.**

### Task 4: Real-browser verification on the current Bilibili tab

**Files:**
- No source changes.

- [x] **Step 1: Inspect the current `BV1pirWB3EGs` tab with the Bilibili subtitle button enabled.**
- [x] **Step 2: Confirm the player shows `data-lan="ai-zh"` and a visible caption.**
- [ ] **Step 3: Reload the installed extension and confirm the MomentQ diagnostic count is greater than zero; the current tab still reports extension version `0.1.5`, so this final deployment check requires installing/reloading the generated `0.1.7` artifact.**
