/**
 * Live probe for the force-compact threshold markers:
 *   - a red horizontal tick on the composer context ring at threshold/capacity;
 *   - a red vertical line on the expanded breakdown bar at the same ratio;
 *   - both suppressed once threshold >= capacity.
 * Run: node fc-threshold-marker-probe.mjs [port]
 */
import { createRequire } from 'node:module'
const require = createRequire('D:/AI/dsh-s/deepseek-harness/apps/web/package.json')
const { chromium } = require('playwright')
const PORT = Number(process.argv[2] ?? 3080)
const BASE = `http://127.0.0.1:${PORT}`
// 本探针验证的是「打开一个带上下文压力的会话后」的几何渲染，所以需要一个已存在的会话。
// 会话名可传参：`node fc-threshold-marker-probe.mjs 3099 <会话标题>`。默认沿用本仓库历史上
// 用过的那一个；找不到时探针干净跳过（见文末），不把「环境里没有这个会话」报成插件失败。
const SESSION_NAME = process.argv[3] ?? '熟悉项目'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let ok = 0, bad = 0
const check = (c, label, d = '') => {
  if (c) { ok++; console.log('  ok   ' + label) } else { bad++; console.log('  FAIL ' + label + (d ? '  -- ' + d : '')) }
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e.message)))
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(10000)
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((c) => (c.textContent || '').trim() === '继续')
  if (b) b.click()
})
await sleep(2000)
await page.evaluate((name) => {
  const row = [...document.querySelectorAll('*')].find((n) => n.children.length === 0 && (n.textContent || '').trim() === name)
  if (row) { const b = row.closest('button, a, [role="button"], li, div'); (b || row).click() }
}, SESSION_NAME)
await sleep(9000)

const meterOf = () => `(() => {
  const chip = document.querySelector('[data-fc-threshold-chip]')
  if (!chip) return null
  const wrap = chip.parentElement
  const dock = wrap && wrap.parentElement
  const meter = dock ? [...dock.children].find((c) => c !== wrap) : null
  return meter
})()`

const ringGeometry = () => page.evaluate(() => {
  const chip = document.querySelector('[data-fc-threshold-chip]')
  if (!chip || !chip.parentElement) return null
  const wrap = chip.parentElement
  const dock = wrap.parentElement
  const meter = dock ? [...dock.children].find((c) => c !== wrap) : null
  const mark = document.querySelector('[data-fc-ring-marker]')
  const svg = meter ? meter.querySelector('svg') : null
  if (!meter || !svg) return null
  const mr = meter.getBoundingClientRect(), sr = svg.getBoundingClientRect()
  const a = mark ? mark.getBoundingClientRect() : null
  return {
    hasMark: !!mark,
    markCenterX: a ? a.left + a.width / 2 - mr.left : null,
    markCenterY: a ? a.top + a.height / 2 - mr.top : null,
    markW: a ? a.width : null,
    markH: a ? a.height : null,
    markRadius: mark ? getComputedStyle(mark).borderRadius : null,
    svgX: sr.left - mr.left,
    svgY: sr.top - mr.top,
    svgW: sr.width,
    color: mark ? getComputedStyle(mark).backgroundColor : null,
    pointer: mark ? getComputedStyle(mark).pointerEvents : null,
  }
})

const barGeometry = () => page.evaluate(() => {
  const chip = document.querySelector('[data-fc-threshold-chip]')
  if (!chip || !chip.parentElement) return { open: false, hasMark: false, color: null }
  const wrap = chip.parentElement
  const dock = wrap.parentElement
  const meter = dock ? [...dock.children].find((c) => c !== wrap) : null
  const panel = [...document.querySelectorAll('[role="dialog"]')].find((d) => !d.hasAttribute('data-fc-threshold-panel'))
  const meterBtn = meter ? meter.querySelector('button') : null
  const open = meterBtn && meterBtn.getAttribute('aria-expanded') === 'true'
  const mark = document.querySelector('[data-fc-bar-marker]')
  let info = { open, hasMark: !!mark, color: mark ? getComputedStyle(mark).backgroundColor : null }
  if (panel) {
    const bar = [...panel.children].find((c) => c.tagName === 'DIV' && c.getBoundingClientRect().height <= 8 && c.getBoundingClientRect().width > 20)
    if (bar && mark) {
      const br = bar.getBoundingClientRect(), mr2 = mark.getBoundingClientRect()
      info.barWidth = br.width
      info.markX = mr2.left + mr2.width / 2 - br.left
      info.markH = mr2.height
      info.barH = br.height
      info.panelText = (panel.textContent || '').trim()
    }
  }
  return info
})

// --- 0. 前置：必须已经打开一个带上下文压力的会话 ---------------------------
// 空态首页（尚未打开任何会话）不会渲染阈值 chip。这不是插件回归，而是探针前提不满足，
// 所以干净跳过而不是把「环境没准备好」报成失败。
if ((await page.evaluate(() => !!document.querySelector('[data-fc-threshold-chip]'))) === false) {
  console.log('')
  console.log(`SKIP: 页面上没有阈值 chip——本探针需要先打开一个带上下文压力的会话。`)
  console.log(`      尝试的会话名: ${SESSION_NAME}`)
  console.log(`      用法: node exploration/fc-threshold-marker-probe.mjs <port> <会话标题>`)
  await browser.close()
  process.exit(0)
}

// --- 1. ratio < 1: both markers present -----------------------------------
const ring1 = await ringGeometry()
check(ring1.hasMark, 'the ring dot exists while threshold < capacity')
check(ring1.color === 'rgb(229, 72, 77)', 'the ring dot is red', String(ring1.color))
check(ring1.pointer === 'none', 'the ring dot does not eat pointer events', String(ring1.pointer))
check(Math.abs(ring1.markW - ring1.markH) < 0.01, 'the ring marker is a dot, not a line', `${ring1.markW}x${ring1.markH}`)
check(ring1.markW >= 2 && ring1.markW <= 5, 'the dot is roughly one ring-stroke wide', String(ring1.markW))
check(ring1.markRadius === '50%', 'the dot is fully round', String(ring1.markRadius))

// the tick must sit ON the ring circumference (r = 5.5 in a 14px viewBox)
const cxv = (ring1.markCenterX - ring1.svgX) / (ring1.svgW / 14)
const cyv = (ring1.markCenterY - ring1.svgY) / (ring1.svgW / 14)
const radius = Math.hypot(cxv - 7, cyv - 7)
check(Math.abs(radius - 5.5) < 0.6, 'the ring dot sits on the ring circumference', `r=${radius.toFixed(2)}`)

// --- 2. open the panel with a REAL click; the bar line appears ------------
// A real click, resolved through the meter root so no other disclosure button matches.
const meterBtn = await page.evaluateHandle(() => {
  const chip = document.querySelector('[data-fc-threshold-chip]')
  const wrap = chip.parentElement
  const meter = [...wrap.parentElement.children].find((c) => c !== wrap)
  return meter.querySelector('button')
})
await meterBtn.asElement().click()
await sleep(900)
const bar1 = await barGeometry()
check(bar1.open, 'the context breakdown panel is open')
check(bar1.hasMark, 'the bar limit line exists while threshold < capacity')
check(bar1.color === 'rgb(229, 72, 77)', 'the bar limit line is red', String(bar1.color))
check(Math.abs(bar1.markH - bar1.barH) < 0.51, 'the bar limit line is exactly the bar height', `${bar1.markH} vs ${bar1.barH}`)
const barRatio = bar1.markX / bar1.barWidth
const chipAria = await page.evaluate(() => {
  const b = document.querySelector('[data-fc-threshold-chip] button')
  return b ? b.getAttribute('aria-label') : null
})
console.log('  info chip=' + chipAria + '  barRatio=' + barRatio.toFixed(3))
check(barRatio > 0.05 && barRatio < 0.99, 'the bar limit line sits inside the bar', String(barRatio))

// cross-check: the ring dot angle must equal the bar ratio (both derived from threshold/capacity)
const thetaDeg = ((Math.atan2(cxv - 7, -(cyv - 7)) * 180 / Math.PI) + 360) % 360
const expectedDeg = barRatio * 360
check(Math.abs(thetaDeg - expectedDeg) < 12,
  'the ring dot angle agrees with the bar ratio',
  `${thetaDeg.toFixed(1)}deg vs ${expectedDeg.toFixed(1)}deg`)

// --- 3. threshold >= capacity: both markers disappear ---------------------
const setThreshold = async (text) => {
  await page.evaluate(() => {
    const chip = document.querySelector('[data-fc-threshold-chip]')
    const b = chip.querySelector('button')
    if (b.getAttribute('aria-expanded') !== 'true') b.click()
  })
  await sleep(600)
  await page.fill('[data-fc-threshold-panel] input', text)
  await page.click('[data-fc-threshold-panel] button')
  await sleep(1500)
}
await setThreshold('2M')
const ring2 = await ringGeometry()
check(!ring2.hasMark, 'threshold >= capacity removes the ring dot')
const bar2 = await barGeometry()
check(!bar2.hasMark, 'threshold >= capacity removes the bar limit line')

// --- 4. clearing the override brings them back ----------------------------
await page.evaluate(() => {
  const chip = document.querySelector('[data-fc-threshold-chip]')
  const b = chip.querySelector('button')
  if (b.getAttribute('aria-expanded') !== 'true') b.click()
})
await sleep(600)
await page.evaluate(() => {
  const panel = document.querySelector('[data-fc-threshold-panel]')
  const reset = [...panel.querySelectorAll('button')].find((b) => /默认|default/.test(b.textContent || ''))
  if (reset) reset.click()
})
await sleep(1500)
const ring3 = await ringGeometry()
check(ring3.hasMark, 'clearing the override restores the ring dot')

check(errors.length === 0, 'no page errors', errors.join(' | '))
await browser.close()
console.log('')
console.log(ok + ' ok, ' + bad + ' failed')
process.exit(bad === 0 ? 0 : 1)