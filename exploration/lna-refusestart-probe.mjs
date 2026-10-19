// lna-refusestart-probe.mjs — 单元级实证：dsh-local-no-auth 的拒载路径
//
// 背景（2026-09-17，harness 0.1.6-alpha.1）：
// 上游把 app-boot 的 `assertEntriesActivated`（任何启用但未激活的 entry 都致命）
// 换成了 `auditStartupEntries`——只对一份**私有**必需 entry 清单致命。本插件 entry
// 不在表内，因此 `apply` 抛错不再中止启动：`dsh web` 照常服务、鉴权完好，只留一条
// 通用 warning。于是插件必须自己承担 fail-loud：stderr 明示原因 + 通过启动器的
// `ctx.get('appExit')(1)` 请求非零退出 + 保留抛错（对更老 harness 仍然致命）。
//
// 本探针用假 ctx 逐条验证 `refuseStart` 的四种触发点、正常路径、优雅降级与
// dispose 还原语义。不启动任何服务器。
//
// 运行：node exploration/lna-refusestart-probe.mjs

const PLUGIN = new URL('../dsh-local-no-auth/index.js', import.meta.url)

let passed = 0
let failed = 0
const failures = []

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}${detail === undefined ? '' : `   ${detail}`}`)
  } else {
    failed += 1
    failures.push(`${name}: ${detail}`)
    console.log(`  FAIL  ${name}   ${detail}`)
  }
}

const { apply } = await import(PLUGIN.href)

/** Capture process.stderr writes around one call. */
function withStderr(fn) {
  const lines = []
  const original = process.stderr.write
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true }
  try {
    fn()
  } finally {
    process.stderr.write = original
  }
  return lines.join('')
}

/** A ctx with working connection/webServer plus a recording appExit. */
function makeCtx({ connection, host, appExit = true, getThrows = false, noConnection = false } = {}) {
  const calls = { exits: [], disposers: [] }
  const browserPeer = { marker: 'owner-peer' }
  const conn = connection ?? {
    requestRejection: () => 'reject',
    // 0.2.1 authenticates inside admit/admitConnection instead of delegating to
    // requestRejection; the plugin must replace all five to bypass `/api`.
    admit: () => ({ rejection: 401 }),
    admitConnection: () => ({ rejection: 401 }),
    browserPeer,
    authorizeIndex: () => false,
    authenticatedUrl: (u) => `${u}?token=abc`,
  }
  const ctx = {
    // `noConnection` is explicit because `null ?? default` would silently
    // substitute the default and make the missing-service case untested.
    connection: noConnection ? undefined : conn,
    webServer: host === undefined ? {} : { host },
    on(event, handler) { if (event === 'dispose') calls.disposers.push(handler) },
    // cordis has NO 'dispose' event — the only cleanup idiom is
    // `ctx.effect(() => () => {restore})`, where `effect` runs its callback
    // immediately and treats the returned function as the disposer.
    effect(execute) {
      const produced = execute()
      if (typeof produced === 'function') calls.disposers.push(produced)
      return { dispose: () => { produced?.() } }
    },
    get(name) {
      if (getThrows) throw new Error('service store unavailable')
      if (name === 'appExit' && appExit) return (code) => { calls.exits.push(code) }
      return undefined
    },
  }
  return { ctx, calls, conn }
}

/** Run apply and report {threw, message, stderr, exits}. */
function run(options) {
  const { ctx, calls, conn } = makeCtx(options)
  let threw = false
  let message
  const stderr = withStderr(() => {
    try {
      apply(ctx)
    } catch (error) {
      threw = true
      message = error.message
    }
  })
  return { threw, message, stderr, exits: calls.exits, conn, calls }
}

console.log('=== A. 四种拒载触发点：stderr + appExit(1) + 抛错 ===\n')

// A1 — connection 服务缺失
{
  const r = run({ noConnection: true })
  check('A1 connection 缺失 → 抛错', r.threw, r.message)
  check('A1 stderr 写出明确原因', r.stderr.includes('refusing to start') && r.stderr.includes('connection service unavailable'), JSON.stringify(r.stderr.trim()))
  check('A1 请求非零退出', JSON.stringify(r.exits) === '[1]', JSON.stringify(r.exits))
  check('A1 stderr 明示免鉴权未生效', r.stderr.includes('NOT active') && r.stderr.includes('token'), '指出实例仍需 token/cookie')
  check('A1 抛错文案标注已请求退出', (r.message ?? '').includes('nonzero exit requested'), r.message)
}

// A2 — webServer 绑定地址读不到
{
  const r = run({ host: undefined })
  check('A2 绑定地址缺失 → 抛错', r.threw, r.message)
  check('A2 stderr 写出原因', r.stderr.includes('bind host unavailable'), JSON.stringify(r.stderr.trim()))
  check('A2 请求非零退出', JSON.stringify(r.exits) === '[1]', JSON.stringify(r.exits))
}

// A3 — 非回环绑定（安全闸门）
{
  const r = run({ host: '0.0.0.0' })
  check('A3 非回环绑定 → 抛错', r.threw, r.message)
  check('A3 stderr 点名非法地址', r.stderr.includes('"0.0.0.0"') && r.stderr.includes('not loopback-only'), JSON.stringify(r.stderr.trim()))
  check('A3 请求非零退出', JSON.stringify(r.exits) === '[1]', JSON.stringify(r.exits))
  check('A3 未触碰任何认证方法', r.conn.requestRejection() === 'reject', '原方法完好')
}

// A4 — 认证方法不再是函数（接口漂移）
// 0.2.1 起插件依次校验 requestRejection / admit / admitConnection /
// authorizeIndex / authenticatedUrl，所以 mock 必须先把新增的三个补齐，
// 否则这里测到的会是「admit 缺失」而不是「authorizeIndex 漂移」。
{
  const r = run({
    host: '127.0.0.1',
    connection: {
      requestRejection: () => 'reject',
      admit: () => ({ rejection: 401 }),
      admitConnection: () => ({ rejection: 401 }),
      browserPeer: {},
      authorizeIndex: 'not-a-function',
      authenticatedUrl: (u) => u,
    },
  })
  check('A4 方法非函数 → 抛错', r.threw, r.message)
  check('A4 stderr 点名具体方法', r.stderr.includes('authorizeIndex is not a function'), JSON.stringify(r.stderr.trim()))
  check('A4 请求非零退出', JSON.stringify(r.exits) === '[1]', JSON.stringify(r.exits))
}

console.log('\n=== B. 正常路径：回环绑定 + 五方法齐备 ===\n')

{
  const r = run({ host: '127.0.0.1' })
  check('B1 不抛错、不请求退出', r.threw === false && r.exits.length === 0, `threw=${r.threw} exits=${JSON.stringify(r.exits)}`)
  const admitted = r.conn.admit()
  const admittedSocket = r.conn.admitConnection()
  check('B1 五个方法均被替换',
    r.conn.requestRejection() === undefined
    && admitted.rejection === undefined && admitted.peer === r.conn.browserPeer
    && admittedSocket.rejection === undefined && admittedSocket.peer === r.conn.browserPeer
    && r.conn.authorizeIndex() === true
    && r.conn.authenticatedUrl('http://x') === 'http://x',
    '免 token / 免 cookie / /api 放行 / URL 干净')
  check('B1 admitConnection 的 release 是 resolved no-op',
    typeof admittedSocket.release === 'function' && admittedSocket.release() instanceof Promise)
  // The plugin legitimately warns on stderr when `pluginPackages` is absent (the
  // optional metadata shim is skipped by design, see AGENTS.md); what must never
  // appear on the success path is a `refusing to start` line.
  check('B1 未写拒载 stderr', !r.stderr.includes('refusing to start'), JSON.stringify(r.stderr))
  check('B1 注册了 dispose 还原器', r.calls.disposers.length === 1, `disposers=${r.calls.disposers.length}`)
  // dispose 还原语义
  r.calls.disposers[0]()
  check('B2 dispose 后原方法全部还原',
    r.conn.requestRejection() === 'reject'
    && r.conn.admit().rejection === 401
    && r.conn.admitConnection().rejection === 401
    && r.conn.authorizeIndex() === false
    && r.conn.authenticatedUrl('http://x') === 'http://x?token=abc',
    '卸载后与未打补丁一致')
}

// localhost 别名也应放行
{
  const r = run({ host: 'localhost' })
  check('B3 localhost 别名放行', r.threw === false && r.exits.length === 0, `threw=${r.threw}`)
}

console.log('\n=== C. 缺退出缝时的降级（仍须抛错 + stderr）===\n')

// C1 — launcher 未提供 appExit（老 harness 或非 CLI 宿主）
{
  const r = run({ host: '0.0.0.0', appExit: false })
  check('C1 无 appExit 仍抛错', r.threw, r.message)
  check('C1 无 appExit 仍写 stderr', r.stderr.includes('refusing to start'), JSON.stringify(r.stderr.trim()))
  check('C1 无 appExit 时不谎称已请求退出', (r.message ?? '').includes('nonzero exit requested') === false, r.message)
}

// C2 — 服务存储读取本身抛错
{
  const r = run({ host: '0.0.0.0', getThrows: true })
  check('C2 ctx.get 抛错被吞掉且不掩盖拒载', r.threw && r.stderr.includes('refusing to start'), r.message)
}

// C3 — appExit 本身抛错
{
  const { ctx, calls, conn } = makeCtx({ host: '0.0.0.0' })
  ctx.get = (name) => {
    if (name === 'appExit') return () => { throw new Error('shutdown controller busy') }
    return undefined
  }
  let threw = false
  let message
  const stderr = withStderr(() => {
    try {
      apply(ctx)
    } catch (error) {
      threw = true
      message = error.message
    }
  })
  check('C3 appExit 抛错不掩盖拒载', threw && stderr.includes('refusing to start'), message)
  check('C3 appExit 抛错时认证方法未被替换', conn.requestRejection() === 'reject', '闸门保持原样')
  check('C3 未注册 dispose 还原器（未替换就无需还原）', calls.disposers.length === 0, `disposers=${calls.disposers.length}`)
}

console.log(`\n${'='.repeat(64)}`)
if (failed === 0) {
  console.log(`ALL CHECKS PASSED — ${passed} passed, 0 failed`)
} else {
  console.log(`${passed} passed, ${failed} FAILED`)
  for (const f of failures) console.log(`  - ${f}`)
  process.exitCode = 1
}
