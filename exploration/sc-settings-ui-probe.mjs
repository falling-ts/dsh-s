/**
 * 探针:dsh-start-command 客户端半部在真浏览器里的渲染与写入路径。
 *
 * 与 `sc-prestep-probe.mjs`(离线、桩 ctx)和 `sc-e2e-probe.mjs`(真回合、wire 协议)互补:
 * 这一支回答的是"设置页里能不能看见、能不能改"——即客户端半部那三个缝是否真的通:
 *
 *   1. `ctx.slots.inject('settings.section')` —— 分区在导航里出现、点得开;
 *   2. `ctx.locale.bind` —— 分区文案是词典里的中文(而不是键名或英文回落);
 *   3. `ctx.configForms.get(ns)` 的**读与写** —— 输入框初值等于宿主当前值;在输入框里
 *      改值并点「保存」后,宿主侧 `settings/describe` 的 `user.startCommand` 变成新值
 *      (说明提交确实走了 `scope.set`),再改回原值。
 *
 * 判据是宿主的状态,不是页面上的一行字:页面文本只作为"渲染了"的附带证据落到报告文件里。
 * 探针在 finally 里用 wire 协议把设置还原成本次运行前的值。
 *
 * 用法:node exploration/sc-settings-ui-probe.mjs [port]
 * 输出:检查行打印到 stdout(纯 ASCII);页面文本与截图落
 *      `exploration/sc-settings-ui.txt` / `sc-settings-section.png`。
 */
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'

const require = createRequire('D:/AI/dsh-s/deepseek-harness/apps/web/package.json')
const { chromium } = require('playwright')

const PORT = Number(process.argv[2] ?? 3080)
const BASE = `http://127.0.0.1:${PORT}`
const OUT = 'D:/AI/dsh-s/exploration'
const NS = 'falling-ts-start-command'
const FIELD = 'startCommand'
const NAV = '开始前命令'
const SAVE = '保存'
const SENTINEL = `echo sc-ui-${Date.now().toString(36)}`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let passed = 0
let failed = 0
const check = (ok, label, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${label}`) }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
const info = (label) => console.log(`  --   ${label}`)

/** 一元 RPC(与其它探针同一信封形态)。 */
async function call(method, args) {
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args } }),
  })
  const json = await res.json().catch(() => null)
  if (res.status !== 200 || json?.result?.ok !== true) {
    throw new Error(`${method} -> ${res.status} ${JSON.stringify(json).slice(0, 300)}`)
  }
  return json.result.value
}

/** 宿主侧该命名空间的视图。 */
async function view() {
  const described = await call('settings/describe', {})
  return described.namespaces.find((entry) => entry.ns === NS)
}

const original = (await view())?.value?.[FIELD] ?? ''
const report = []
let browser
try {
  console.log(`\n=== 现场 ===`)
  info(`原值=${JSON.stringify(original)}  拟写入=${JSON.stringify(SENTINEL)}`)

  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
  const consoleErrors = []
  const pageErrors = []
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('pageerror', (error) => pageErrors.push(String(error?.stack ?? error)))

  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await sleep(9000)
  // 关掉首次引导(它在时挡住设置入口)。
  await page.evaluate(() => {
    const button = Array.from(document.querySelectorAll('button'))
      .find((candidate) => (candidate.textContent || '').trim() === '继续')
    if (button) button.click()
  })
  await sleep(1200)
  // 0.2.1-rc.3 moved the settings entry into the account menu (the standalone
  // bottom-left "设置" node is gone); the advertised shortcut is the stable way
  // in, with the account-menu walk as a fallback.
  await page.keyboard.press('Control+Alt+,')
  await sleep(3000)
  const settingsOpen = await page.evaluate(
    () => document.querySelectorAll('[role="dialog"] nav button').length > 0,
  )
  if (!settingsOpen) {
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
  await sleep(4000)

  console.log(`\n=== 1. 分区渲染 ===`)
  const clicked = await page.evaluate((label) => {
    const entry = Array.from(document.querySelectorAll('button, a, [role="button"], div, span'))
      .find((node) => node.children.length === 0 && (node.textContent || '').trim() === label)
    if (entry) { entry.click(); return true }
    return false
  }, NAV)
  await sleep(4000)
  await page.screenshot({ path: `${OUT}/sc-settings-section.png` })
  check(clicked, `设置导航里点开了「${NAV}」`)

  // 给本分区的输入框与保存按钮打上临时 id,便于用真实输入驱动写入路径。
  const tagged = await page.evaluate(({ nav, save }) => {
    const title = Array.from(document.querySelectorAll('h2'))
      .find((node) => (node.textContent || '').trim() === nav)
    if (title === undefined) return { input: false, save: false, text: '' }
    let root = title.parentElement
    while (root !== null && root.querySelector('input[type="text"]') === null) root = root.parentElement
    if (root === null) return { input: false, save: false, text: title.parentElement?.innerText ?? '' }
    const input = root.querySelector('input[type="text"]')
    input.id = 'sc-probe-input'
    const button = Array.from(root.querySelectorAll('button'))
      .find((candidate) => (candidate.textContent || '').trim() === save)
    if (button !== undefined) button.id = 'sc-probe-save'
    return {
      input: true,
      save: button !== undefined,
      placeholder: input.getAttribute('placeholder') ?? '',
      text: (root.innerText || '').slice(0, 2000),
    }
  }, { nav: NAV, save: SAVE })
  check(tagged.input === true, '分区里有文本框')
  check(tagged.save === true, `分区里有「${SAVE}」按钮`)
  report.push(`# dsh-start-command 设置分区渲染文本\n\n${tagged.text}\n`)

  console.log(`\n=== 2. 读路径 ===`)
  const initial = await page.inputValue('#sc-probe-input').catch(() => undefined)
  check(initial === original, '输入框初值等于宿主当前值', `页面=${JSON.stringify(initial)} 宿主=${JSON.stringify(original)}`)

  console.log(`\n=== 3. 写路径(经「保存」提交) ===`)
  await page.fill('#sc-probe-input', SENTINEL)
  await page.click('#sc-probe-save')
  await sleep(2500)
  const afterWrite = (await view())?.value?.[FIELD]
  check(afterWrite === SENTINEL, '点「保存」后宿主值变成新值(提交走了 scope.set)',
    `宿主=${JSON.stringify(afterWrite)}`)

  const restoredViaUi = await page.evaluate(() => {
    const input = document.querySelector('#sc-probe-input')
    return input === null ? false : input.disabled === false
  }).catch(() => false)
  if (restoredViaUi) {
    await page.fill('#sc-probe-input', original)
    await page.click('#sc-probe-save')
    await sleep(2500)
  }
  const afterRestore = (await view())?.value?.[FIELD]
  check(afterRestore === original, '在界面上改回原值后宿主值也回到原值', `宿主=${JSON.stringify(afterRestore)}`)

  report.push(`## 控制台\n\nconsole.error: ${consoleErrors.length}\npageerror: ${pageErrors.length}\n`)
  for (const line of consoleErrors.slice(0, 10)) report.push(`- console.error: ${line.slice(0, 300)}`)
  for (const line of pageErrors.slice(0, 10)) report.push(`- pageerror: ${line.slice(0, 300)}`)
  check(pageErrors.length === 0, '页面没有未捕获异常', `${pageErrors.length} 条`)
} catch (error) {
  failed += 1
  console.log(`  FAIL 探针异常中止 — ${error instanceof Error ? error.message : String(error)}`)
} finally {
  if (browser !== undefined) await browser.close().catch(() => {})
  try {
    const current = await view()
    if (current?.value?.[FIELD] !== original) {
      await call('settings/update', { ns: NS, patch: { [FIELD]: original }, expectedRevision: current.revision })
      console.log(`  --   已用 wire 协议把设置还原为 ${JSON.stringify(original)}`)
    }
  } catch (error) {
    console.log(`  FAIL 还原失败(需人工检查) — ${error instanceof Error ? error.message : String(error)}`)
    failed += 1
  }
  writeFileSync(`${OUT}/sc-settings-ui.txt`, `${report.join('\n')}\n`, 'utf8')
  info(`报告:${OUT}/sc-settings-ui.txt  截图:${OUT}/sc-settings-section.png`)
}

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
