// Verification probe for the 2026-09-17 timeout-guard hardening + adapter-bound
// diagnostic fix in dsh-force-compact.
//
// Covers three defects found in review:
//   1. `summarizationTimeoutMs` accepted fractional / astronomically large values
//      that `AbortSignal.timeout` cannot honor (THROWS ERR_OUT_OF_RANGE on a
//      fractional delay; silently degrades a 2^31..2^32-1 delay to 1ms).
//   2. The timeout-race diagnostic only read `llm-pi-ai.providers.<p>...`, so a
//      `llm-deepseek` (top-level field) route produced a wrong bound -> false
//      WARN pointing at an unused settings namespace.
//   3. (covered by fc-badge-i18n-parity-probe.mjs / the source scan) both liveUi
//      schema keys.
//
// Run: node exploration/fc-timeout-guard-probe.mjs [--slow]
import { bindConfig, DEFAULTS, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, readSettings } from '../dsh-force-compact/src/core/settings.js'
import {
  ADAPTER_STREAM_IDLE_TIMEOUT_MS,
  adapterIdleBound,
  emitTimeoutRaceDiagnostic,
  summarize,
} from '../dsh-force-compact/src/engine/summarizer.js'

const NS = 'falling-ts-force-compact'
const SLOW = process.argv.includes('--slow')
let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  ${detail}`}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Harness 0.1.7 removed `settings.get(ns)`: `readSettings` no longer consults the
// ctx at all (`void ctx`) — it reads the plugin's own Config refs, which `apply`
// binds once via `bindConfig(config)`. So the probe must bind a field-shaped store
// (each field an object with `.get()`) instead of stubbing a ctx service; a
// ctx-only stub silently resolves EVERY field to its default, which is exactly how
// this probe went stale.
const bindStore = (section) => {
  const store = {}
  for (const [field, value] of Object.entries(section)) store[field] = { get: () => value }
  bindConfig(store)
  return store
}
const ctxWith = (section) => {
  bindStore(section)
  return {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    get() { return undefined },
  }
}

console.log('== 1. readSettings clamps summarizationTimeoutMs to a schedulable integer ==')
console.log(`   bounds: MIN=${MIN_TIMEOUT_MS} MAX=${MAX_TIMEOUT_MS} default=${DEFAULTS.summarizationTimeoutMs}`)
const settingsCases = [
  { stored: 90_000, expect: 90_000, why: 'in-range value passes through' },
  { stored: 5_000, expect: 5_000, why: 'floor boundary is inclusive' },
  { stored: 1, expect: MIN_TIMEOUT_MS, why: 'below floor -> floors UP' },
  { stored: 1.5, expect: MIN_TIMEOUT_MS, why: 'fractional below floor -> floor (was: THREW ERR_OUT_OF_RANGE)' },
  { stored: 5_000.9, expect: 5_000, why: 'fractional above floor -> TRUNCATED (was: threw)' },
  { stored: 90_000.7, expect: 90_000, why: 'fractional default-adjacent -> truncated' },
  { stored: 2_147_483_647, expect: MAX_TIMEOUT_MS, why: 'ceiling boundary is inclusive' },
  { stored: 2_147_483_648, expect: MAX_TIMEOUT_MS, why: '2^31 -> ceiling (was: silently 1ms!)' },
  { stored: 4_294_967_295, expect: MAX_TIMEOUT_MS, why: '2^32-1 -> ceiling (was: silently 1ms!)' },
  { stored: 1e15, expect: MAX_TIMEOUT_MS, why: 'astronomical -> ceiling' },
  { stored: Number.NaN, expect: DEFAULTS.summarizationTimeoutMs, why: 'NaN -> default' },
  { stored: -5, expect: DEFAULTS.summarizationTimeoutMs, why: 'non-positive -> default' },
  { stored: '90000', expect: DEFAULTS.summarizationTimeoutMs, why: 'string -> default (not coerced)' },
]
const resolved = []
for (const c of settingsCases) {
  const out = await readSettings(ctxWith({ summarizationTimeoutMs: c.stored }))
  resolved.push(out.summarizationTimeoutMs)
  check(
    `stored=${String(c.stored)} -> ${out.summarizationTimeoutMs}`,
    out.summarizationTimeoutMs === c.expect && Number.isInteger(out.summarizationTimeoutMs),
    c.why,
  )
}
console.log('  -- every resolved value must be schedulable by AbortSignal.timeout --')
for (const [i, ms] of resolved.entries()) {
  let threw = null
  try {
    AbortSignal.timeout(ms)
  } catch (error) {
    threw = error.code || error.name
  }
  check(`AbortSignal.timeout(${ms}) does not throw`, threw === null, threw === null ? '' : `threw ${threw}`)
}

console.log('\n== 2. adapterIdleBound reads BOTH adapter settings places, tightest wins ==')
const boundCases = [
  { name: 'pi-ai route only', sections: { 'llm-pi-ai': { providers: { p: { streamIdleTimeoutMs: 600_000 } } } }, expect: { ms: 600_000, origin: 'llm-pi-ai.providers.p.streamIdleTimeoutMs' } },
  { name: 'deepseek top-level only (THE FIX)', sections: { 'llm-deepseek': { streamIdleTimeoutMs: 450_000 } }, expect: { ms: 450_000, origin: 'llm-deepseek.streamIdleTimeoutMs' } },
  { name: 'both -> tightest wins (deepseek tighter)', sections: { 'llm-pi-ai': { providers: { p: { streamIdleTimeoutMs: 600_000 } } }, 'llm-deepseek': { streamIdleTimeoutMs: 100_000 } }, expect: { ms: 100_000, origin: 'llm-deepseek.streamIdleTimeoutMs' } },
  { name: 'both -> tightest wins (pi-ai tighter)', sections: { 'llm-pi-ai': { providers: { p: { streamIdleTimeoutMs: 20_000 } } }, 'llm-deepseek': { streamIdleTimeoutMs: 100_000 } }, expect: { ms: 20_000, origin: 'llm-pi-ai.providers.p.streamIdleTimeoutMs' } },
  { name: 'pi-ai route for a DIFFERENT provider', sections: { 'llm-pi-ai': { providers: { other: { streamIdleTimeoutMs: 1_000 } } } }, expect: undefined },
  { name: 'no sections at all', sections: {}, expect: undefined },
  { name: 'weird shapes everywhere', sections: { 'llm-pi-ai': { providers: { p: { streamIdleTimeoutMs: Number.NaN } } }, 'llm-deepseek': { streamIdleTimeoutMs: '600000' } }, expect: undefined },
  { name: 'zero/negative are not bounds', sections: { 'llm-deepseek': { streamIdleTimeoutMs: 0 } }, expect: undefined },
]
// Another plugin's namespace is reachable only through `describe()` since harness
// 0.1.7 removed `settings.get(ns)`: its descriptors carry the resolved `value`.
const boundCtxFor = (sections) => ({
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  get: (name) => (name === 'settings'
    ? { describe: () => Object.entries(sections).map(([ns, value]) => ({ ns, value })) }
    : undefined),
})
for (const c of boundCases) {
  const got = adapterIdleBound(boundCtxFor(c.sections), 'p')
  const ok = c.expect === undefined
    ? got === undefined
    : got !== undefined && got.ms === c.expect.ms && got.origin === c.expect.origin
  check(c.name, ok, got === undefined ? '-> undefined' : `-> ${got.ms}ms via ${got.origin}`)
}
check('settings service absent -> undefined', adapterIdleBound({ logger: {} }, 'p') === undefined)
check('ctx null-ish -> undefined (total)', adapterIdleBound(undefined, 'p') === undefined)

console.log('\n== 3. timeout-race WARN arbitration (the false-positive regression) ==')
const capture = (sections) => {
  const lines = []
  const ctx = {
    logger: {
      debug: (m) => lines.push(['debug', m]),
      info() {},
      warn: (m) => lines.push(['warn', m]),
      error() {},
    },
    // Same 0.1.7 seam as `boundCtxFor`: adapters' namespaces come from `describe()`.
    get: (name) => (name === 'settings'
      ? { describe: () => Object.entries(sections).map(([ns, value]) => ({ ns, value })) }
      : undefined),
  }
  return { ctx, lines }
}
// The exact 2026-09-14 live scenario: a slow llama.cpp route whose adapter
// watchdog was raised to 600000ms in llm-deepseek, cap set below it.
{
  const { ctx, lines } = capture({ 'llm-deepseek': { streamIdleTimeoutMs: 600_000 } })
  emitTimeoutRaceDiagnostic(ctx, 'p', 500_000)
  const warns = lines.filter(([lvl]) => lvl === 'warn')
  check('cap 500000 < deepseek watchdog 600000 -> NO warn', warns.length === 0, warns.length === 0 ? '(clean debug)' : warns[0][1].slice(0, 90))
}
{
  const { ctx, lines } = capture({ 'llm-deepseek': { streamIdleTimeoutMs: 450_000 } })
  emitTimeoutRaceDiagnostic(ctx, 'p', 500_000)
  const warn = lines.find(([lvl]) => lvl === 'warn')
  check('cap 500000 >= deepseek watchdog 450000 -> WARN naming llm-deepseek', warn !== undefined, warn === undefined ? '' : warn[1].slice(0, 120))
  check('  ...and the fix text names BOTH knobs', warn !== undefined && warn[1].includes('llm-deepseek.streamIdleTimeoutMs') && warn[1].includes('llm-pi-ai.providers.p.streamIdleTimeoutMs'))
}
{
  const { ctx, lines } = capture({})
  emitTimeoutRaceDiagnostic(ctx, 'p', 300_000)
  const warn = lines.find(([lvl]) => lvl === 'warn')
  check('nothing configured, cap == platform default 300000 -> WARN (default assumed)', warn !== undefined, warn === undefined ? '' : 'not confirmed')
}
{
  const { ctx, lines } = capture({})
  emitTimeoutRaceDiagnostic(ctx, 'p', ADAPTER_STREAM_IDLE_TIMEOUT_MS - 1)
  check('nothing configured, cap just below 300000 -> no WARN', lines.filter(([l]) => l === 'warn').length === 0)
}

console.log('\n== 4. end-to-end: a 25ms summarization stream must survive hostile caps ==')
// Minimal successful stream: one text-delta then a terminal finish{kind:'stop'}.
const slowStreamCtx = (delayMs) => ({
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  get(name) {
    if (name === 'llm') {
      return {
        // eslint-disable-next-line require-yield
        stream: async function* () {
          await sleep(delayMs)
          yield { type: 'text-delta', text: '## Probe\n- a summarization that took longer than 1ms to stream\n' }
          // The raw finish chunk carries `reason` (a `{kind, failure?}`), per the
          // StreamChunk protocol the assembler reads (`finish = chunk.reason`).
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    }
    return undefined
  },
})
const runSummarize = async (timeoutMs, delayMs) => {
  const config = { summarizationProvider: 'probe', summarizationModel: 'probe-model', summarizationTimeoutMs: timeoutMs }
  return summarize(slowStreamCtx(delayMs), config, {}, [], undefined, undefined)
}
for (const timeoutMs of [1.5, 4_294_967_295, 2_147_483_648, 2_147_483_647, 90_000]) {
  let result
  let threw = null
  try {
    result = await runSummarize(timeoutMs, 25)
  } catch (error) {
    threw = error.code || error.name || String(error)
  }
  const ok = threw === null && result !== undefined && result.status === 'ok'
  check(
    `cap=${timeoutMs} with a 25ms stream -> ${threw !== null ? `THREW ${threw}` : result.status}`,
    ok,
    ok ? '' : '(pre-fix: 1.5 threw ERR_OUT_OF_RANGE; 4294967295/2147483648 aborted instantly as timeout)',
  )
}

if (SLOW) {
  console.log('\n== 5. --slow: the guard still FIRES (not defanged by the clamping) ==')
  // cap=1 floors to MIN_TIMEOUT_MS (5000); the stream needs 5400ms -> must abort.
  const result = await runSummarize(1, 5_400)
  check('cap floored to 5000 vs a 5400ms stream -> status=timeout', result !== undefined && result.status === 'timeout', `status=${result && result.status}`)
} else {
  console.log('\n(skipping the 5.4s "guard still fires" case; re-run with --slow)')
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
