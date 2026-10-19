// Probe: do the plugins' peer ranges actually admit the harness we ship against?
//
// A peer range is a promise, and a wrong one fails silently in two directions:
// too narrow and the plugin is un-installable on the harness the user actually
// runs; too loose and it loads onto an API surface it was never written for.
// This probe resolves the ranges with the SAME semver implementation the
// harness vendors (pnpm store), against the versions declared by the upstream
// packages in deepseek-harness/, and reports both directions.
//
// Baseline (2026-10-19, was 2026-09-30): the plugins target the dsh **0.2.1 release
// train**; the declared floor is its first prerelease, `0.2.1-rc.1`, and the
// checkout is now pinned at `dsh-v0.2.1-rc.2` (0.2.0-rc.2 → 0.2.1-rc.2, 1925
// commits). The 0.2.1 train is a real move, not a patch inside 0.2.0: it rewrote
// `connection.admit` to authenticate directly (which is why the no-auth bypass had
// to start overriding `admit`/`admitConnection`), and it hides `engines.dsh` behind
// a new precedence rule in the boot preflight. Baseline note for 0.2.0: that train
// added the boot-time peer compatibility preflight (app-boot
// `plugin-compatibility.ts`) that DISABLES a profile row whose `@deepseek-ai/dsh*`
// peers are not satisfied by the running runtime (semver, includePrerelease),
// unless an exact-version exemption is granted via `dsh plugin allow-version` --
// so a wrong floor is no longer just "un-installable", it silently disables the
// plugin.
//
// A PURE LOWER BOUND IS A PROMISE ABOUT A WHOLE TRAIN, NOT ABOUT ONE PRERELEASE.
// rc.1 -> rc.2 is a patch inside one train (the running-status anchor this plugin
// patches, `[data-chat-running]`, exists in both), so the floor deliberately does
// NOT chase the pinned prerelease: raising it to rc.2 would make the preflight
// disable the plugins on an rc.1 runtime for no reason. What this probe therefore
// enforces is (a) every dsh peer names exactly the declared train floor, (b) the
// declared floor is the SAME release train as the checkout (so a move to 0.2.1 /
// 0.3.0 fails here and forces a re-decision), and (c) the shipped version -- and
// every certifiably-compatible successor -- satisfies the range under the
// includePrerelease semantics the preflight actually uses.
//
// cordis / schemastery are NOT on the dsh train: they are the vendor pins, and
// their floors must equal the vendored version exactly.
//
// It also parses every package.json with Node's JSON.parse rather than a lenient
// reader: this workspace was once bitten by a shell round-trip that replaced an
// em dash with a bare 0x3F byte, which ConvertFrom-Json happily accepted while
// Node refused it -- the plugin then failed to import and its host half silently
// never loaded.
//
// Run: node exploration/peer-range-probe.mjs
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

/** The dsh release train the plugins ship against (first prerelease of the train). */
const DECLARED_FLOOR = '0.2.1-rc.1'

/** Vendor pins: their floors equal the vendored version, so they track the checkout. */
const VENDOR_PINS = {
  '@deepseek-ai/cordis': '4.0.5',
  '@deepseek-ai/schemastery': '3.18.5',
}

/** The floor one peer name must declare, per the collection convention. */
const expectedFloor = (name) => VENDOR_PINS[name] ?? DECLARED_FLOOR

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'))

// The harness vendors several semver majors; use the newest (what npm itself uses).
const store = path.join(root, 'deepseek-harness/node_modules/.pnpm')
const semverDir = fs.readdirSync(store)
  .filter((d) => /^semver@\d/.test(d))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  .pop()
if (!semverDir) throw new Error('no vendored semver found under deepseek-harness/node_modules/.pnpm')
const require_ = createRequire(import.meta.url)
const semver = require_(path.join(store, semverDir, 'node_modules/semver'))

let passed = 0
let failed = 0
const check = (ok, label, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${label}`) }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`) }
}

console.log(`semver ${require_(path.join(store, semverDir, 'node_modules/semver/package.json')).version}` +
  `  (vendored by the harness at ${semverDir})`)

// ── what the harness actually declares ───────────────────────────────────────
// Scan the whole checkout for every published package name → version, so ANY
// `@deepseek-ai/dsh-*` peer resolves (0.2.0's preflight checks every dsh peer,
// so the probe must too). Vendor copies (cordis, schemastery) win over any
// workspace row of the same name, since that is the pin the harness ships.
const upstreamVersion = {}
const scanRoots = [
  'deepseek-harness/packages',
  'deepseek-harness/apps',
  'deepseek-harness/examples',
]
const scanDir = (dir, depth = 0) => {
  if (depth > 4) return
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  const manifest = path.join(dir, 'package.json')
  if (fs.existsSync(manifest)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'))
      if (typeof pkg.name === 'string' && typeof pkg.version === 'string' && !pkg.private) {
        upstreamVersion[pkg.name] ??= pkg.version
      }
    } catch { /* an unreadable manifest is not this probe's subject */ }
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    scanDir(path.join(dir, entry.name), depth + 1)
  }
}
for (const rel of scanRoots) scanDir(path.join(root, rel))
for (const vendor of ['vendor/cordis', 'vendor/schemastery']) {
  try {
    const pkg = readJson(`deepseek-harness/${vendor}/package.json`)
    if (typeof pkg.name === 'string') upstreamVersion[pkg.name] = pkg.version
  } catch { /* vendor copy absent */ }
}
console.log('\nupstream versions in this checkout:')
const peerNames = new Set()
for (const plugin of ['dsh-force-compact', 'dsh-web-ding', 'dsh-local-no-auth']) {
  for (const name of Object.keys(readJson(`${plugin}/package.json`).peerDependencies ?? {})) peerNames.add(name)
}
for (const name of [...peerNames].sort()) {
  console.log(`  ${name.padEnd(38)} ${upstreamVersion[name] ?? '<NOT FOUND IN CHECKOUT>'}`)
}

const PLUGINS = ['dsh-force-compact', 'dsh-web-ding', 'dsh-local-no-auth']
const harnessVersion = upstreamVersion['@deepseek-ai/dsh-settings']

/** `major.minor.patch` of a version -- the release train it belongs to. */
const trainOf = (version) => {
  const parsed = semver.parse(version)
  if (parsed === null) throw new Error(`not a semver version: ${version}`)
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`
}
/** Whether two versions ride the same release train. */
const sameTrain = (left, right) => trainOf(left) === trainOf(right)

// A pure lower bound promises the whole train, so the checkout may advance within
// the train without changing it -- but moving to another train means the promise
// was never checked against that surface and the baseline must be re-decided.
check(sameTrain(DECLARED_FLOOR, harnessVersion),
  `declared floor ${DECLARED_FLOOR} rides the same train as the shipped ${harnessVersion}`,
  `floor train ${trainOf(DECLARED_FLOOR)} vs shipped train ${trainOf(harnessVersion)}`)
check(semver.gte(harnessVersion, DECLARED_FLOOR),
  `the shipped ${harnessVersion} is at or above the declared floor ${DECLARED_FLOOR}`)

for (const plugin of PLUGINS) {
  console.log(`\n=== ${plugin} ===`)
  const pkg = readJson(`${plugin}/package.json`)   // strict parse = the em-dash gate
  check(true, `package.json parses strictly as JSON (${pkg.name} ${pkg.version})`)

  const peers = pkg.peerDependencies ?? {}
  const meta = pkg.peerDependenciesMeta ?? {}
  check(Object.keys(peers).length > 0, 'declares peer dependencies')
  check(/^\d+\.\d+\.\d+/.test(pkg.version), `version is plain semver (${pkg.version})`)

  for (const [name, range] of Object.entries(peers)) {
    const actual = upstreamVersion[name]
    const optional = meta[name]?.optional === true
    if (actual === undefined) {
      check(!name.startsWith('@deepseek-ai/dsh-'),
        `${name} ${range} [${optional ? 'optional' : 'required'}] -- no upstream copy to compare`)
      continue
    }
    check(semver.satisfies(actual, range),
      `${name} ${range} [${optional ? 'optional' : 'required'}] admits the shipped ${actual}`)
    // The preflight that can disable a profile row uses includePrerelease, so the
    // range must admit the shipped prerelease under THOSE semantics too.
    check(semver.satisfies(actual, range, { includePrerelease: true }),
      `${name} ${range} admits the shipped ${actual} under the boot preflight (includePrerelease)`)

    // Every peer floor names the declared train floor (or the vendor pin) -- a
    // pure lower bound of the train, not of whichever prerelease is pinned today.
    check(range.trim() === `>=${expectedFloor(name)}`,
      `${name} range is exactly >=${expectedFloor(name)}`,
      `got ${range}`)
    check(expectedFloor(name) === VENDOR_PINS[name] || sameTrain(expectedFloor(name), actual),
      `${name} floor ${expectedFloor(name)} is the same release train as the shipped ${actual}`,
      `floor train ${trainOf(expectedFloor(name))} vs shipped train ${trainOf(actual)}`)
  }

  // npm refuses to publish a package whose own version is below a peer floor it names.
  check(semver.valid(pkg.version) !== null, 'publishable version')
}

// ── the boundary semantics the range relies on ───────────────────────────────
console.log('\n=== range boundary semantics ===')
const FLOOR = `>=${DECLARED_FLOOR}`
check(semver.satisfies(DECLARED_FLOOR, FLOOR), `${DECLARED_FLOOR} satisfies ${FLOOR} (the floor admits itself)`)
check(semver.satisfies(harnessVersion, FLOOR, { includePrerelease: true }),
  `the shipped ${harnessVersion} satisfies ${FLOOR} with includePrerelease (what the 0.2.0 preflight uses)`)
check(semver.satisfies('0.2.1-rc.2', FLOOR, { includePrerelease: true }),
  `0.2.1-rc.2 (a later prerelease of the train) is admitted by ${FLOOR}`)
check(!semver.satisfies('0.1.6-alpha.2', FLOOR, { includePrerelease: true }),
  `0.1.6-alpha.2 is excluded by ${FLOOR}`)
check(!semver.satisfies('0.1.7-alpha.2', FLOOR, { includePrerelease: true }),
  `0.1.7-alpha.2 is excluded by ${FLOOR} (previous baseline, pre-0.2.0 surface)`)
check(!semver.satisfies('0.2.0-rc.2', FLOOR, { includePrerelease: true }),
  `0.2.0-rc.2 (the previous train) is excluded by ${FLOOR}`)
check(!semver.satisfies('0.2.0', FLOOR, { includePrerelease: true }),
  `0.2.0 (release of the previous train) is excluded by ${FLOOR}`)
check(!semver.satisfies('0.2.1-rc.0', FLOOR, { includePrerelease: true }),
  `0.2.1-rc.0 (earlier prerelease of the tuple) is excluded by ${FLOOR}`)
check(semver.satisfies('0.2.1', FLOOR, { includePrerelease: true }),
  `0.2.1 (release of this train) is admitted`)
check(semver.satisfies('0.2.2', FLOOR, { includePrerelease: true }),
  `0.2.2 is admitted (>= has no upper cap)`)
check(semver.satisfies('0.2.1', FLOOR, { includePrerelease: true }),
  `0.2.1 is admitted (>= has no upper cap)`)
check(!semver.satisfies('0.1.7', FLOOR, { includePrerelease: true }),
  `0.1.7 (release) is excluded by ${FLOOR}`)

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} -- ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
