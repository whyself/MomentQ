/**
 * Stage a test Edge profile that carries the user's real Bilibili login
 * (Cookies + Local State for the decryption key), then verify login.
 * Run: node scripts/stage-test-profile.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const src = String.raw`${process.env.LOCALAPPDATA}` + '\\Microsoft\\Edge\\User Data'
const dest = String.raw`${process.env.LOCALAPPDATA}` + '\\Temp\\momentq-user-profile'

fs.rmSync(dest, { recursive: true, force: true })
fs.mkdirSync(dest + '\\Default', { recursive: true })
for (const name of ['Cookies', 'Cookies-journal', 'Login Data', 'Web Data', 'Preferences']) {
  const from = path.join(src, 'Default', name)
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dest, 'Default', name))
}
if (fs.existsSync(path.join(src, 'Local State'))) {
  fs.copyFileSync(path.join(src, 'Local State'), path.join(dest, 'Local State'))
}
console.log('[stage] profile copied to', dest)

const context = await chromium.launchPersistentContext(dest, {
  channel: 'msedge',
  headless: false,
  args: [
    '--load-extension=D:/Projects/MomentQ/extension/dist',
    '--disable-extensions-except=D:/Projects/MomentQ/extension/dist',
  ],
})
await sleep(5000)
const sw = context.serviceWorkers()[0]
console.log('[stage] SW:', sw ? sw.url().slice(0, 70) : 'none')
const videoPage = await context.newPage()
await videoPage.goto('https://www.bilibili.com/video/BV1cD4y1D7uR/')
await sleep(9000)
const text = await videoPage.evaluate(() => document.body.innerText)
console.log('[stage] bilibili login:', text.includes('发消息') || text.includes('大会员') ? 'logged-in' : 'anonymous')
await context.close()
process.exit(0)

async function sleep(ms) { await new Promise(r => setTimeout(r, ms)) }
