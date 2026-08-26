import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'session-context': 'src/session-context.ts',
    'tool-policy': 'src/tool-policy.ts',
    'http-api': 'src/http-api.ts',
    sdk: 'src/sdk.ts',
  },
  format: 'esm',
  fixedExtension: false,
  dts: true,
  clean: true,
})
