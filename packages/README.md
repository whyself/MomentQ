# MomentQ Application Packages

This directory is separate from the DSH runtime layer:

- `extension/` owns the future Chrome/Edge extension and side-panel UI.
- `shared/` owns browser/runtime protocol types that are not DSH implementation details.
- `companion/` owns future local integration such as Native Messaging and ASR orchestration.

DSH framework packaging, Presets, Host services and Docker runtime stay under `../dsh/`.
