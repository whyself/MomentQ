# MomentQ Shared Protocol

Cross-package message types that are independent of DSH internals. Both the browser extension and the local companion import these sources directly (no build step, no runtime dependencies).

- `src/companion-protocol.ts` — the extension ↔ companion WebSocket contract for streaming ASR: JSON control/result frames (`start` / `clock` / `stop` → `ready` / `partial` / `final` / `persisted` / `error`) plus raw binary frames of `16kHz / 16bit / mono` PCM. The content identity mirrors the Host schema, so Bilibili subtitles (`source='bilibili'`) and ASR output (`source='asr'`) land in the same `transcript.jsonl` shape.
