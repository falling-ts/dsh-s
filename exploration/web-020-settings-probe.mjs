/**
 * web-020-settings-probe.mjs — deeper headless pass: dismiss the 0.2.0
 * onboarding dialog, open the settings surface, and verify the two workspace
 * plugins' settings sections actually render there (the client half is what
 * 0.2.0's ui-settings rename could have broken).
 *
 * Usage: node exploration/web-020-settings-probe.mjs [port]   (default 3080)
 */
import { createRequire } from 'node:module'
const require = createRequire('D:/AI/dsh-s/deepseek-harness/apps/web/package.json')
const { chromium } = require('playwright')

const PORT = Number(process.argv[2] ?? 3080)
const BASE = `http://127.0.0.1:${PORT}`
const OUT = 'D:/AI/dsh-s/exploration'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const consoleErrors = []
const pageErrors = []
const failed = []
const pluginRequests = []

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => pageErrors.push(String(e?.stack ?? e)))
page.on('requestfailed', (r) => failed.push(`${r.url()} — ${r.failure()?.errorText ?? '?'}`))
page.on('response', (r) => {
  if (/plugins|client\.js|patch/i.test(r.url()) && r.request().resourceType() !== 'document') {
    pluginRequests.push(`${r.status()} ${r.url().replace(BASE, '')}`)
  }
  if (r.status() >= 400 && !r.url().includes('/api/')) failed.push(`HTTP ${r.status()} ${r.url()}`)
})

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(9000)

// 1) dismiss the preview onboarding dialog if present
const dismissed = await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button'))
    .find((b) => (b.textContent || '').trim() === '继续')
  if (btn) { btn.click(); return true }
  return false
})
await sleep(1500)

// 2) open settings. 0.2.1-rc.3 moved the entry into the account menu; the
//    shortcut that menu advertises is the composition-independent way in, with
//    the account-menu walk kept as a fallback.
await page.keyboard.press('Control+Alt+,')
await sleep(3000)
const opened = await page.evaluate(() => document.querySelectorAll('[role="dialog"] nav button').length > 0)
if (!opened) {
  await page.evaluate(() => {
    const account = Array.from(document.querySelectorAll('button'))
      .find((b) => (b.getAttribute('aria-label') || '') === '账号菜单')
    if (account) account.click()
  })
  await sleep(1200)
  await page.evaluate(() => {
    const item = Array.from(document.querySelectorAll('[role="menuitem"], [role="menu"] button, [role="menu"] div'))
      .find((n) => (n.textContent || '').trim().startsWith('设置'))
    if (item) item.click()
  })
}
await sleep(6000)
await page.screenshot({ path: `${OUT}/web-020-settings-1.png` })

// collect all rendered section labels
const sectionText = await page.evaluate(() => (document.body.innerText || '').slice(0, 3000))
await sleep(2000)
await page.screenshot({ path: `${OUT}/web-020-settings-2.png` })

await browser.close()

console.log('— settings surface probe —')
console.log(`onboarding dismissed : ${dismissed}`)
console.log('page text (first 1500):')
console.log(sectionText.slice(0, 1500))
console.log('')
console.log(`plugin-ish requests (${pluginRequests.length}):`)
for (const r of pluginRequests) console.log(`  ${r.slice(0, 200)}`)
console.log(`console.error (${consoleErrors.length}):`)
for (const e of consoleErrors.slice(0, 20)) console.log(`  ${e.slice(0, 300)}`)
console.log(`pageerror (${pageErrors.length}):`)
for (const p of pageErrors.slice(0, 10)) console.log(`  ${p.slice(0, 500)}`)
console.log(`failed (${failed.length}):`)
for (const f of failed.slice(0, 20)) console.log(`  ${f.slice(0, 250)}`)
console.log(`screens: ${OUT}/web-020-settings-1.png, ${OUT}/web-020-settings-2.png`)
