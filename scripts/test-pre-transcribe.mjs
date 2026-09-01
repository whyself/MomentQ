/**
 * End-to-end pre-transcription test: real Edge + the built extension + a
 * real Bilibili video. Loads the panel, clicks 预识别, and watches the
 * progress banner until it completes or fails. Prints the outcome.
 *
import path from 'node:path'
 * Run: node scripts/test-pre-transcribe.mjs
 */
import { chromium } from 'playwright'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'

const extensionDir = new URL('../extension/dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const userDataDir = process.env.LOCALAPPDATA + path.join('\Temp', 'momentq-user-profile')

const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'msedge',
  headless: false,
  args: [
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
})

// Find the extension's service worker to learn its origin, then open the
// panel page directly in a tab. Race: the worker may already be listed, may
// arrive late, or may be discoverable via the background target list.
let swOrigin = null
for (let attempt = 0; attempt < 20 && swOrigin === null; attempt += 1) {
  for (const worker of context.serviceWorkers()) {
    if (worker.url().startsWith('chrome-extension://')) swOrigin = worker.url().split('/').slice(0, 3).join('/')
  }
  if (swOrigin === null) {
    for (const bg of context.backgroundPages()) {
      if (bg.url().startsWith('chrome-extension://')) swOrigin = bg.url().split('/').slice(0, 3).join('/')
    }
  }
  if (swOrigin === null) await sleep(500)
}
if (swOrigin === null) {
  const worker = await context.waitForEvent('serviceworker', { timeout: 15_000 }).catch(() => null)
  if (worker !== null) swOrigin = worker.url().split('/').slice(0, 3).join('/')
}
if (swOrigin === null) {
  console.error('[e2e] FAIL: extension service worker never appeared (load unpacked failed?)')
  await context.close()
  process.exit(1)
}
console.log('[e2e] extension origin:', swOrigin)

// Open the video FIRST so the extension binds to it, then the panel.
const videoPage = await context.newPage()
await videoPage.goto('https://www.bilibili.com/video/BV1cD4y1D7uR/')
await videoPage.waitForLoadState('domcontentloaded')
await sleep(8000)

const page = await context.newPage()
await page.goto(`${swOrigin}/sidepanel.html`)
// Wait until the header shows the video title (state bound) or 30s.
for (let second = 0; second < 30; second += 1) {
  const text = await page.evaluate(() => document.body.innerText)
  if (text.includes('计算机系统漫游')) break
  await sleep(1000)
}

const button = page.locator('button[title*="预识别"]')
try {
  await button.waitFor({ state: 'visible', timeout: 15_000 })
} catch {
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 300))
  console.error('[e2e] Pre button not visible. Panel text:', bodyText.split(String.fromCharCode(10)).join(' | '))
  await context.close()
  process.exit(1)
}
await button.click()
console.log('[e2e] clicked 预识别')

// Watch the banner.
const outcome = await Promise.race([
  (async () => {
    for (let second = 0; second < 900; second += 1) {
      await sleep(1000)
      const text = await page.locator('.momentq-pretranscribe-text').textContent().catch(() => null)
      if (text === null || text === '') continue
      process.stdout.write(`\r[e2e] ${text.slice(0, 80)}   `)
      if (/预识别完成/.test(text)) return { ok: true, text }
      if (/预识别失败/.test(text)) return { ok: false, text }
    }
    return { ok: false, text: 'timeout after 900s' }
  })(),
])

console.log(`\n[e2e] OUTCOME: ${outcome.ok ? 'PASS' : 'FAIL'} — ${outcome.text}`)
await context.close()
process.exit(outcome.ok ? 0 : 1)
