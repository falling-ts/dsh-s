// Live probe: the three settings-nav icons in a REAL browser against a running
// `dsh web` (the web profile links all four plugins to this workspace).
//
// Offline, fc-settings-nav-icon-probe.mjs proves the installer logic against a
// DOM stub. This probe proves the part only a browser can: that the claimed
// rows really do lose the shell gear, that the injected `::before` carries a
// resolvable mask, and — the load-bearing question for a mask built out of
// `currentColor` — that the SVG STENCIL actually paints opaque pixels when the
// browser decodes it as an image.
//
// Run: node exploration/fc-settings-nav-icon-live-probe.mjs [port]
import { createRequire } from 'node:module'

const require = createRequire('D:/AI/dsh-s/deepseek-harness/apps/web/package.json')
const { chromium } = require('playwright')

const PORT = Number(process.argv[2] ?? 3080)
const BASE = `http://127.0.0.1:${PORT}`
const OUT = 'D:/AI/dsh-s/exploration'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PLUGINS = [
  { attr: 'data-fc-nav-icon', nav: '强制压缩' },
  { attr: 'data-wd-nav-icon', nav: '提示音配置' },
  { attr: 'data-sc-nav-icon', nav: '开始前命令' },
]
// official rows whose gear the shell draws itself — must stay untouched
const OFFICIAL = ['模型', '插件市场', '插件', '通用']

let passed = 0
let failed = 0
const check = (ok, label, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${label}`) } 
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

let browser
try {
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e?.stack ?? e)))
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await sleep(9000)
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((c) => (c.textContent || '').trim() === '继续')
    if (b) b.click()
  })
  await sleep(1200)
  // 0.2.1-rc.3 moved the settings entry into the account menu (the standalone
  // bottom-left "设置" node is gone), so the shortcut that menu advertises is
  // the stable way in. The account-menu walk stays as a fallback for any
  // composition that lacks the shortcut plugin.
  await page.keyboard.press('Control+Alt+,')
  await sleep(3000)
  const settingsOpen = await page.evaluate(() => document.querySelectorAll('[role="dialog"] nav button').length > 0)
  if (!settingsOpen) {
    await page.evaluate(() => {
      const account = [...document.querySelectorAll('button')]
        .find((b) => (b.getAttribute('aria-label') || '') === '账号菜单')
      if (account) account.click()
    })
    await sleep(1200)
    await page.evaluate(() => {
      const item = [...document.querySelectorAll('[role="menuitem"], [role="menu"] button, [role="menu"] div')]
        .find((n) => (n.textContent || '').trim().startsWith('设置'))
      if (item) item.click()
    })
  }
  await sleep(4500)

  console.log('\n=== 1. 认领情况 ===')
  const claimed = await page.evaluate((plugins) => {
    const rows = [...document.querySelectorAll('[role="dialog"] nav button')]
    return rows.map((row) => ({
      text: (row.textContent || '').trim(),
      attrs: plugins.map((p) => row.hasAttribute(p.attr)),
    }))
  }, PLUGINS)
  for (const p of PLUGINS) {
    const row = claimed.find((r) => r.text === p.nav)
    check(row !== undefined, `导航里存在「${p.nav}」行`)
    check(row !== undefined && row.attrs[PLUGINS.indexOf(p)] === true, `「${p.nav}」行带 ${p.attr}`)
  }
  const markedCount = claimed.filter((r) => r.attrs.some(Boolean)).length
  check(markedCount === PLUGINS.length, `恰好认领 ${PLUGINS.length} 行`, `实际 ${markedCount}`)
  for (const label of OFFICIAL) {
    const row = claimed.find((r) => r.text === label)
    if (row !== undefined) check(row.attrs.every((a) => a === false), `官方行「${label}」未被误标`)
  }

  console.log('\n=== 2. 每个标记的样式与 mask ===')
  const styled = await page.evaluate((plugins) => {
    const out = {}
    for (const p of plugins) {
      const row = document.querySelector(`[${p.attr}]`)
      if (row === null) { out[p.attr] = null; continue }
      const svg = row.querySelector(':scope > svg')
      const before = getComputedStyle(row, '::before')
      const mask = before.maskImage !== 'none' ? before.maskImage : before.webkitMaskImage
      out[p.attr] = {
        gearHidden: svg !== null && getComputedStyle(svg).display === 'none',
        hasGear: svg !== null,
        beforeWidth: before.width,
        beforeHeight: before.height,
        content: before.content,
        color: before.backgroundColor,
        mask,
      }
    }
    return out
  }, PLUGINS)
  for (const p of PLUGINS) {
    const s = styled[p.attr]
    check(s !== null, `${p.attr}: 行存在`)
    if (s === null) continue
    check(s.hasGear && s.gearHidden, `${p.attr}: 外壳齿轮被隐藏`)
    check(s.beforeWidth === '16px' && s.beforeHeight === '16px', `${p.attr}: ::before 为 16x16`, `${s.beforeWidth}x${s.beforeHeight}`)
    check(typeof s.mask === 'string' && s.mask.includes('data:image/svg+xml'), `${p.attr}: ::before 带 data: SVG mask`)
    check(s.content === '""', `${p.attr}: ::before 有内容盒`)
  }

  console.log('\n=== 3. mask 模板真的会绘制吗（解码成图片数不透明像素） ===')
  const painted = await page.evaluate(async (plugins) => {
    const out = {}
    for (const p of plugins) {
      const row = document.querySelector(`[${p.attr}]`)
      if (row === null) { out[p.attr] = -1; continue }
      const before = getComputedStyle(row, '::before')
      const mask = before.maskImage !== 'none' ? before.maskImage : before.webkitMaskImage
      const start = mask.indexOf('url(')
      if (start < 0) { out[p.attr] = -1; continue }
      const url = mask.slice(start + 4, mask.lastIndexOf(')')).replace(/^["']|["']$/g, '')
      const img = new Image()
      img.src = url
      try { await img.decode() } catch { out[p.attr] = -2; continue }
      const canvas = document.createElement('canvas')
      canvas.width = 16
      canvas.height = 16
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0, 16, 16)
      const data = ctx.getImageData(0, 0, 16, 16).data
      let opaque = 0
      for (let i = 3; i < data.length; i += 4) if (data[i] > 128) opaque++
      out[p.attr] = opaque
    }
    return out
  }, PLUGINS)
  for (const p of PLUGINS) {
    check(painted[p.attr] > 0, `${p.attr}: mask 模板有 ${painted[p.attr]} 个不透明像素`, '0 = 图标不可见')
  }

  console.log('\n=== 4. 切语言后重新认领 ===')
  // The shell re-renders the nav with the new label; the observer must re-claim.
  const relabelled = await page.evaluate(async (plugins) => {
    // simulate the shell re-writing the label text in place (a locale switch does
    // exactly this through React), then let the MutationObserver settle
    const rows = plugins.map((p) => document.querySelector(`[${p.attr}]`))
    const before = rows.map((r) => r !== null)
    for (const r of rows) if (r) r.querySelector('span').textContent = 'ZZZ-renamed'
    await new Promise((res) => setTimeout(res, 300))
    const released = plugins.map((p) => document.querySelector(`[${p.attr}]`) === null)
    return { before, released }
  }, PLUGINS)
  check(relabelled.released.every(Boolean), '标签被改写后认领被释放（不会贴错行）')

  await page.screenshot({ path: `${OUT}/fc-nav-icon-settings.png` })
  check(pageErrors.length === 0, '无 pageerror', pageErrors.slice(0, 2).join(' | '))
} finally {
  if (browser) await browser.close()
}
console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES'} — ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)