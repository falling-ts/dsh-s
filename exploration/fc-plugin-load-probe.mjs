/**
 * fc-plugin-load-probe.mjs — load smoke for the three workspace plugins under a
 * mocked Cordis context: every module in each plugin's import graph must
 * resolve, and each `apply` must register its listeners without throwing.
 *
 * This is a module-graph / registration check, NOT a functional harness test.
 *
 * Run: node D:\AI\dsh-s\exploration\fc-plugin-load-probe.mjs
 */

const ROOT = new URL('../', import.meta.url)

function mockCtx() {
  const listeners = []
  const effects = []
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    get: () => undefined,
    on: (name, fn) => { listeners.push(name); void fn },
    effect: (fn) => { effects.push(fn) },
    listeners,
    effects,
  }
  return ctx
}

let failed = false
function check(name, ok, detail = '') {
  if (!ok) failed = true
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

// ── dsh-force-compact ──────────────────────────────────────────────────────
console.log('— dsh-force-compact —')
{
  const mod = await import(new URL('dsh-force-compact/index.js', ROOT))
  check('exports apply/name', typeof mod.apply === 'function' && typeof mod.name === 'string')
  const ctx = mockCtx()
  let threw
  try { mod.apply(ctx) } catch (e) { threw = e }
  check('apply does not throw', threw === undefined, threw && threw.message)
  const want = ['agent/request', 'agent/pre-step', 'agent/status', 'session/flush']
  for (const name of want) check(`registered ${name}`, ctx.listeners.includes(name))
}

// ── dsh-force-compact: the deferred /force-compact registration ─────────────
// The registration is deferred to the first guarded listener, so this scenario
// mounts a `commands` service and then invokes `agent/request` once — the same
// path the real host takes. It pins the official-parity registration fields
// (identity + one-line copy) the slash-menu row face is built on.
console.log('— dsh-force-compact: /force-compact registration —')
{
  const mod = await import(new URL('dsh-force-compact/index.js', ROOT))
  const captured = []
  const listeners = new Map()
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    get: (name) => (name === 'commands'
      ? { register: (definition) => { captured.push(definition); return () => {} } }
      : undefined),
    on: (name, fn) => { listeners.set(name, fn) },
    effect: () => {},
  }
  let threw
  try { mod.apply(ctx) } catch (e) { threw = e }
  check('apply does not throw with commands mounted', threw === undefined, threw && threw.message)
  const requestListener = listeners.get('agent/request')
  check('agent/request listener registered', typeof requestListener === 'function')
  if (typeof requestListener === 'function') {
    try { await requestListener({}, async () => ({})) } catch (e) { check('agent/request listener does not throw', false, e && e.message) }
  }
  const definition = captured[0]
  check('the command registered exactly once', captured.length === 1, `captured=${captured.length}`)
  check('name is force-compact', definition?.name === 'force-compact', String(definition?.name))
  check('definitionId is plugin-owned',
    definition?.definitionId === '@falling-ts/dsh-force-compact', String(definition?.definitionId))
  check('description is the one-line official-style copy',
    definition?.description === 'Force-compact this session context now', String(definition?.description))
  check('recordInput is false', definition?.recordInput === false, String(definition?.recordInput))
  check('handler is a function', typeof definition?.handler === 'function')
}

// ── dsh-web-ding ───────────────────────────────────────────────────────────
console.log('— dsh-web-ding —')
{
  const mod = await import(new URL('dsh-web-ding/index.js', ROOT))
  check('exports apply/name', typeof mod.apply === 'function' && typeof mod.name === 'string')
  const ctx = mockCtx()
  let threw
  try { mod.apply(ctx) } catch (e) { threw = e }
  check('apply does not throw', threw === undefined, threw && threw.message)
  check('registered agent/status', ctx.listeners.includes('agent/status'))
}

// ── dsh-local-no-auth ──────────────────────────────────────────────────────
console.log('— dsh-local-no-auth —')
{
  const mod = await import(new URL('dsh-local-no-auth/index.js', ROOT))
  check('exports apply/name/inject', typeof mod.apply === 'function' && typeof mod.name === 'string' && Array.isArray(mod.inject))
  const browserPeer = { marker: 'owner-peer' }
  const connection = {
    requestRejection: () => 401,
    // Unlike the 0.2.0 shape (which delegated to `requestRejection`), 0.2.1
    // authenticates inside `admit` / `admitConnection` — the plugin must replace
    // all three or `/api` keeps answering 401.
    admit: () => ({ rejection: 401 }),
    admitConnection: () => ({ rejection: 401 }),
    browserPeer,
    authorizeIndex: () => false,
    authenticatedUrl: (u) => `${u}?token=secret`,
  }
  const ctx = {
    connection,
    webServer: { host: '127.0.0.1' },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    on: (name, fn) => { if (name === 'dispose') ctx._dispose = fn },
    // `effect(execute)` runs `execute` IMMEDIATELY (cordis fiber.effect) and
    // registers what it returns as the disposer — the plugin hands
    // `() => () => {restore}`, so the mock must capture the returned fn.
    effect: (execute) => {
      const produced = execute()
      if (typeof produced === 'function') disposables.push(produced)
      return { async dispose() { for (const d of disposables.splice(0).reverse()) d() } }
    },
    get: () => undefined,   // pluginPackages absent → the meta shim is skipped
  }
  const disposables = []
  let threw
  try { mod.apply(ctx) } catch (e) { threw = e }
  check('apply does not throw', threw === undefined, threw && threw.message)
  check('requestRejection bypassed', connection.requestRejection() === undefined)
  const admitted = connection.admit()
  check('admit bypassed with the owner peer', admitted.rejection === undefined && admitted.peer === browserPeer)
  const admittedSocket = connection.admitConnection()
  check('admitConnection bypassed with the owner peer',
    admittedSocket.rejection === undefined && admittedSocket.peer === browserPeer)
  check('admitConnection release is a resolved no-op',
    typeof admittedSocket.release === 'function' && admittedSocket.release() instanceof Promise)
  check('authorizeIndex bypassed', connection.authorizeIndex() === true)
  check('authenticatedUrl clean', connection.authenticatedUrl('http://x') === 'http://x')
  if (disposables.length > 0) {
    for (const dispose of disposables) dispose()
    check('dispose restores originals',
      connection.requestRejection() === 401
      && connection.admit().rejection === 401
      && connection.admitConnection().rejection === 401
      && connection.authorizeIndex() === false)
  } else {
    check('dispose hook registered', false)
  }
}

console.log(failed ? '\nPROBE FAILED' : '\nPROBE PASSED')
process.exit(failed ? 1 : 0)
