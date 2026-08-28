# DSH frontend reuse contract

MomentQ's browser UI is a standalone application under `extension/`. It is
not a DSH plugin and must not register into the DSH client slot runtime.

The visual baseline is pinned to the following upstream source:

- Repository: `https://github.com/deepseek-ai/deepseek-harness.git`
- Commit: `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`
- Package version represented by the captured build: `0.1.1-rc.2`

## Reuse rules

1. UI components, CSS modules, theme tokens and icons must be copied or
   imported from the pinned DSH source. “Similar”, hand-redrawn replacements
   are not allowed.
2. Upstream visual declarations stay byte-identical whenever possible. A
   MomentQ change may alter composition or data binding, but must not invent
   colors, typography, radii, shadows, spacing or icon paths.
3. MomentQ-specific code is limited to browser integration, content metadata,
   transcript state, SDK transport and the side-panel composition.
4. `@deepseek-ai/dsh-client-ui-layout`, `ui-sidebar`, `ui-conversation` plugin
   entry points and `ctx.slots.register()` are forbidden in the extension.
5. Every migrated file records its upstream relative path and commit in a
   source header or the vendor manifest.

## Initial source set

The standalone frontend will reuse these upstream areas:

```text
packages/client/ui-theme/src/styles/
packages/client/ui-primitives/src/
packages/client/ui-conversation/src/client/skeleton/
packages/client/ui-conversation/src/client/chat/
packages/client/ui-layout/src/client/AppFrame.module.css
packages/client/ui-settings-general/src/
```

`extension/prototype/` remains a byte-preserving capture of the original DSH
WebUI response and is used only as the visual comparison baseline.

The source set is refreshed mechanically, never rewritten by hand:

```powershell
pnpm --filter momentq-browser-extension vendor:dsh -- D:\path\to\deepseek-harness
```

The command refuses any checkout other than the pinned commit and generates
`src/vendor/deepseek-harness/manifest.json` with SHA-256 hashes for every
copied upstream file.
