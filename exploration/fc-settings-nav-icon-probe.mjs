// Probe: the settings-nav-icon feature of the three settings-bearing plugins.
//
// The settings shell (ui-settings-general / SettingsRoot) picks a nav glyph from
// a CLOSED list of section ids and falls back to its own gear for every other
// id; `settings.section` projects only id/order/label, so a third-party section
// cannot declare an icon. The ecosystem answer (dshmarket, dsh-better-sidebar,
// dsh-skill-mcp-panel) is to claim your own row once the dialog is mounted and
// paint over the gear with a CSS mask. This probe drives the REAL extracted
// implementation of each plugin against a minimal DOM stub and locks:
//
//   1. only the row whose visible text equals the plugin's own localized label
//      is marked — never a sibling plugin's row, never an empty-label nav;
//   2. the injected stylesheet hides the shell gear and draws a 16x16 mask;
//   3. a locale switch re-claims the row through the MutationObserver;
//   4. resolving to an empty label releases the claim;
//   5. disposing the fiber removes both the attribute and the stylesheet;
//   6. the three plugins use DISTINCT attribute names and stylesheet ids, so
//      one plugin's sync can never un-claim another plugin's row.
//
// Run: node exploration/fc-settings-nav-icon-probe.mjs
import fs from 'node:fs'

const ROOT = new URL('../', import.meta.url)
const PLUGINS = [
  { dir: 'dsh-force-compact', attr: 'data-fc-nav-icon', id: '@falling-ts/dsh-force-compact' },
  { dir: 'dsh-web-ding', attr: 'data-wd-nav-icon', id: '@falling-ts/dsh-web-ding' },
  { dir: 'dsh-start-command', attr: 'data-sc-nav-icon', id: '@falling-ts/dsh-start-command' },
]
const NAV_ROW_SELECTOR = '[role="dialog"] nav button'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : '  ' + detail}`)
}

/** Minimal DOM stub covering exactly what the installers touch. */
function makeDom() {
  const rows = []
  const head = { children: [] }
  head.appendChild = (node) => { node.parent = head; head.children.push(node) }
  const doc = {
    head,
    createElement(tagName) {
      return {
        tagName, dataset: {}, textContent: '', parent: null,
        remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this) },
      }
    },
    querySelectorAll(selector) {
      if (selector === NAV_ROW_SELECTOR) return rows
      const m = /^\[([^\]]+)\]$/.exec(selector)
      return m ? rows.filter((r) => r.attrs[m[1]] !== undefined) : []
    },
  }
  return { doc, rows }
}
function makeRow(text) {
  const attrs = {}
  return {
    textContent: text,
    attrs,
    setAttribute(k) { attrs[k] = '' },
    removeAttribute(k) { delete attrs[k] },
  }
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

for (const plugin of PLUGINS) {
  console.log(`\n== ${plugin.dir} ==`)
  const src = fs.readFileSync(new URL(`${plugin.dir}/web/client.js`, ROOT), 'utf8')

  const block = src.match(/ {4}\/\/ ── 设置导航图标[\s\S]*?\n {4}function apply\(ctx\) \{/)
  check(block !== null, `${plugin.dir}: nav-icon block is present`)
  if (block === null) continue
  const body = block[0].replace(/\n {4}function apply\(ctx\) \{$/, '')
  check(body.includes(plugin.attr), `${plugin.dir}: uses its own attribute ${plugin.attr}`)
  check(body.includes(plugin.id), `${plugin.dir}: stylesheet is tagged with its own plugin id`)

  // Fresh DOM + observers per plugin, so "connected observers" is unambiguous.
  const { doc, rows } = makeDom()
  const observers = []
  class FakeMutationObserver {
    constructor(cb) { this.cb = cb; this.connected = false; observers.push(this) }
    observe(_t, opts) { this.connected = true; this.opts = opts }
    disconnect() { this.connected = false }
  }
  // `apply`'s body closes over module-level constants declared OUTSIDE the nav-icon
  // block (e.g. `brandGrad`, used by the save chip), so they must be re-declared
  // ahead of the folded body or the eval throws `ReferenceError: brandGrad is not
  // defined`. Kept to a single explicit name on purpose: a generic single-line
  // harvest pulls in identifiers the folded body already declares, and a
  // multi-line literal would be truncated into a syntax error.
  const brandGradLine = src.match(/^ {4}const brandGrad = [^\n]*$/m)?.[0] ?? ''
  const api = new Function(
    'document', 'MutationObserver', 'queueMicrotask',
    `${brandGradLine}\n${body}\nreturn { installSettingsNavIcon, isOwnNavRow, navMarkUrl, navIconCss, NAV_ICON_ATTR };`,
  )(doc, FakeMutationObserver, (fn) => { Promise.resolve().then(fn) })

  // --- pure predicate -----------------------------------------------------
  check(api.isOwnNavRow('  强制压缩 ', '强制压缩'), `${plugin.dir}: predicate trims and matches`)
  check(!api.isOwnNavRow('提示音配置', '强制压缩'), `${plugin.dir}: predicate rejects a sibling row`)
  check(!api.isOwnNavRow('', ''), `${plugin.dir}: an empty label claims nothing`)
  check(!api.isOwnNavRow(null, undefined), `${plugin.dir}: null/undefined never match`)

  // --- mask + stylesheet --------------------------------------------------
  const url = api.navMarkUrl()
  check(url.startsWith('data:image/svg+xml,'), `${plugin.dir}: mask URL is a data: SVG`)
  const svg = decodeURIComponent(url.slice('data:image/svg+xml,'.length))
  check(svg.startsWith('<svg') && svg.endsWith('</svg>'), `${plugin.dir}: mask decodes to one SVG element`)
  check(svg.includes('viewBox="0 0 16 16"'), `${plugin.dir}: mask is authored on a 16x16 grid`)
  check(!/[\s"'](?:id|class)=/.test(svg), `${plugin.dir}: mask carries no id/class that could collide`)
  const css = api.navIconCss(url)
  check(css.includes(`[${plugin.attr}] > svg { display: none; }`), `${plugin.dir}: hides the shell fallback gear`)
  check(css.includes('mask-image') && css.includes('background-color: currentColor'), `${plugin.dir}: paints the mark in currentColor`)
  check(css.includes('width: 16px') && css.includes('height: 16px'), `${plugin.dir}: mark is sized 16x16`)

  // --- claim lifecycle ----------------------------------------------------
  const own = makeRow('强制压缩')
  const sibling = makeRow('提示音配置')
  const general = makeRow('通用')
  rows.push(own, sibling, general)

  let label = '强制压缩'
  let disposer
  api.installSettingsNavIcon({ effect: (fn) => { disposer = fn() } }, () => label)
  await flush()

  check(doc.head.children.length === 1, `${plugin.dir}: injects exactly one stylesheet`)
  check(api.NAV_ICON_ATTR === plugin.attr, `${plugin.dir}: NAV_ICON_ATTR is its own attribute`)
  check(own.attrs[plugin.attr] !== undefined, `${plugin.dir}: claims its own row`)
  check(sibling.attrs[plugin.attr] === undefined, `${plugin.dir}: leaves the sibling row alone`)
  check(general.attrs[plugin.attr] === undefined, `${plugin.dir}: leaves unrelated rows alone`)
  const sync = () => { for (const o of observers) if (o.connected) o.cb([]) }

  label = 'Force Compact'
  own.textContent = 'Force Compact'
  sync()
  await flush()
  check(own.attrs[plugin.attr] !== undefined, `${plugin.dir}: re-claims the row after a locale switch`)
  check(sibling.attrs[plugin.attr] === undefined, `${plugin.dir}: still leaves the sibling alone after the switch`)

  label = ''
  sync()
  await flush()
  check(own.attrs[plugin.attr] === undefined, `${plugin.dir}: an unresolved label releases the claim`)

  label = '强制压缩'
  own.textContent = '强制压缩'
  sync()
  await flush()
  check(own.attrs[plugin.attr] !== undefined, `${plugin.dir}: re-claimed before disposal`)

  disposer()
  check(own.attrs[plugin.attr] === undefined, `${plugin.dir}: disposal removes the marker`)
  check(doc.head.children.length === 0, `${plugin.dir}: disposal removes the stylesheet`)
  check(observers.filter((o) => o.connected).length === 0, `${plugin.dir}: disposal disconnects the observer`)

  // a second fiber must be able to install again (no module-level latch)
  let disposer2
  api.installSettingsNavIcon({ effect: (fn) => { disposer2 = fn() } }, () => label)
  await flush()
  check(own.attrs[plugin.attr] !== undefined, `${plugin.dir}: reinstalls on a fresh fiber`)
  disposer2()
}

const attrs = PLUGINS.map((p) => p.attr)
check(new Set(attrs).size === attrs.length, 'the three plugins use three distinct nav-icon attributes', attrs.join(' '))
check(new Set(PLUGINS.map((p) => p.id)).size === PLUGINS.length, 'the three plugins tag stylesheets with distinct ids')

console.log(failures === 0 ? '\nALL PASS' : `\nFAILURES: ${failures}`)
process.exit(failures === 0 ? 0 : 1)