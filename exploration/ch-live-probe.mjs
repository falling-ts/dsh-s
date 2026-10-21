/**
 * 探针:dsh-chinese 在运行中实例上的端到端验证。
 *
 * 与离线探针的分工:离线探针证明"注册逻辑写得对",本探针证明"活实例上真的生效了"——
 * 插件的 entry 被启用且 active、命名空间进了 settings/describe,并且**系统提示词里真的
 * 出现了那三段中文规则(含每段的加粗总纲)**。最后一条只能靠活体证明:
 * `ctx.systemPrompt.section()` 是否被上游装配链采信,离线桩答不了。
 *
 * 判据顺序(从"插件在不在"到"规则进没进提示词"):
 *   1. pluginInventory/list 里 `include:falling-ts-chinese` 为 enabled + active;
 *   2. settings/describe 里出现 `falling-ts-chinese` 命名空间(说明 Config 被 loader 采信);
 *   3. 真实发一个回合,模型对"你现在遵守哪些语言与文件编辑规则"的回答里能观察到规则生效。
 *
 * 用法:node exploration/ch-live-probe.mjs [port]
 */
import { randomUUID } from 'node:crypto'

const PORT = process.argv[2] ?? '3080'
const BASE = `http://127.0.0.1:${PORT}`

let passed = 0
let failed = 0
const check = (ok, label, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${label}`) }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

/** 发一条 client-request 信封并取回结果。 */
async function rpc(method, args = {}) {
  const rpcId = randomUUID()
  const response = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
  })
  const text = await response.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { throw new Error(`${method}: non-JSON response (${response.status}): ${text.slice(0, 200)}`) }
  return parsed
}

console.log(`dsh-chinese 活体验证 — port ${PORT}\n`)

/**
 * 读一个会话的完整事件页,并顺带找出游标上界。
 *
 * `session/page` 拒绝超过会话游标的 `throughSeq`("past cursor N"),而游标本身不在
 * `session/list` 的字段里,所以先按一个较大的值试,从错误信息里读出真实上界再重试。
 * @param {string} sessionId - 目标会话。
 * @returns {Promise<{throughSeq: number, records: object[]}>} 事件页。
 */
async function readSessionPage(sessionId) {
  const address = { kind: 'session', sessionId }
  let throughSeq = 4096
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const page = await rpc('session/page', { request: { address, throughSeq, maxMessages: 200 } })
    const value = page?.result?.value ?? page?.result ?? page
    if (Array.isArray(value?.records)) return { throughSeq, records: value.records }
    const message = String(value?.error?.message ?? '')
    const past = /past cursor (\d+)/.exec(message)
    if (past === null) return { throughSeq, records: [], error: message }
    throughSeq = Number(past[1])
  }
  return { throughSeq, records: [] }
}

// ── 1. 插件在清单里启用且 active ─────────────────────────────────────────────
console.log('[1] pluginInventory/list')
let entry
{
  const result = await rpc('pluginInventory/list', {})
  const value = result?.result?.value ?? result?.result ?? result
  const entries = value?.entries ?? []
  check(Array.isArray(entries) && entries.length > 0, `清单返回 ${entries.length} 条`, String(entries.length))
  entry = entries.find((e) => String(e.moduleName ?? '').includes('dsh-chinese')
    || String(e.entryId ?? '').includes('chinese'))
  if (entry === undefined) {
    check(false, '清单里存在 dsh-chinese 条目', '未找到;moduleName 含 chinese 的行:'
      + JSON.stringify(entries.filter((e) => String(e.moduleName ?? '').includes('chin')).map((e) => e.moduleName)))
  } else {
    check(entry.enabled === true, `enabled=true (${entry.entryId})`, String(entry.enabled))
    check(entry.fiberPhase === 'active', `fiberPhase=active`, String(entry.fiberPhase))
    console.log(`       moduleName=${entry.moduleName}`)
  }
}

// ── 2. 命名空间进了 settings/describe ────────────────────────────────────────
console.log('\n[2] settings/describe')
{
  const result = await rpc('settings/describe', {})
  const value = result?.result?.value ?? result?.result ?? result
  const namespaces = value?.namespaces ?? value?.sections ?? []
  const found = JSON.stringify(value).includes('falling-ts-chinese')
  check(found, 'describe 里出现 falling-ts-chinese 命名空间',
    found ? '' : `namespaces=${JSON.stringify(namespaces).slice(0, 300)}`)
  if (found) {
    const ns = (Array.isArray(namespaces) ? namespaces : []).find((n) => (n?.namespace ?? n?.id ?? '') === 'falling-ts-chinese')
    if (ns !== undefined) {
      console.log(`       namespace=${ns.namespace ?? ns.id} autoGenerate=${ns.autoGenerate} applies=${ns.applies}`)
      check(ns.autoGenerate === false, 'autoGenerate=false(本插件不提供自有设置页)')
    }
  }
}

// ── 3. 系统提示词里真的有三段规则 ────────────────────────────────────────────
// 判据:让模型复述它当前遵守的语言与文件编辑规则。规则若没进系统提示词,模型无从知道
// 这些特定措辞(尤其"命令和脚本只能用于检验"、"校验脚本优先内联执行"这两条非默认约定),
// 回答会明显走样。
console.log('\n[3] 真实回合:规则是否进入系统提示词')
{
  // `session/create` 的形参名是 `request`(字段全可省);`session/prompt` 的形参名也是
  // `request`,但载荷里的 `requestId` 是客户端铸的 uuid 且必填(见根 AGENTS.md 的
  // "通过 wire 协议驱动一次对话")。
  const created = await rpc('session/create', { request: {} })
  const createdValue = created?.result?.value ?? created?.result ?? created
  const sessionId = createdValue?.sessionId ?? createdValue?.id
  check(typeof sessionId === 'string' && sessionId.length > 0, `创建会话 ${sessionId}`, String(sessionId))
  if (typeof sessionId !== 'string') {
    console.log('\n无法创建会话,跳过第 3 组')
  } else {
    const prompt = '不要使用任何工具。请直接逐字复述你当前被要求遵守的关于「输出语言」和「文件编辑方式」的规则各一条。'
    await rpc('session/prompt', {
      request: {
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
      },
    })
    // 轮询等回合结束:agent/status 转 idle 或会话 projection 出现 assistant 文本。
    const deadline = Date.now() + 180000
    let answer = ''
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000))
      const listed = await rpc('session/list', { _request: {} })
      const listedValue = listed?.result?.value ?? listed?.result ?? listed
      const rows = listedValue?.items ?? listedValue?.sessions ?? []
      const row = (Array.isArray(rows) ? rows : []).find((s) => (s?.sessionId ?? s?.id) === sessionId)
      if (row !== undefined && row.running !== true) {
        // `session/page` 的形参名是 `request`,载荷要 `address`(判别式 `kind:'session'`)
        // 与一个不超过会话游标的 `throughSeq`。游标从 `session/list` 行的 `asOfSeq`
        // 推不出来,`throughSeq` 给一个足够大的值会报 "past cursor",所以先探测上界。
        const detailValue = await readSessionPage(sessionId)
        answer = JSON.stringify(detailValue)
        break
      }
    }
    check(answer.length > 0, '回合已结束并取回会话内容', answer.length > 0 ? '' : '超时')
    if (answer.length > 0) {
      const page = JSON.parse(answer)
      // 最硬的判据:`system/message` 记录(seq 最小那条 = 本回合的请求头)里逐字出现三段规则。
      const sys = (page.records ?? []).find((r) => r?.event?.type === 'system/message')
      const prompt = sys === undefined
        ? ''
        : ((sys.event.data?.message?.content ?? []).map((c) => c.text ?? '').join('\n'))
      check(sys !== undefined, '会话记录里有 system/message(请求头的系统提示词)')
      check(prompt.includes('所有思考过程和临时输出都必须使用中文'),
        'system/message 里逐字出现中文语言规则')
      check(prompt.includes('编辑或修改文件时，必须使用专门的编辑文件工具'),
        'system/message 里逐字出现编辑工具规则')
      check(prompt.includes('命令和脚本只能用于检验文件修改的结果'),
        'system/message 里逐字出现"只能用于检验"这条限定')
      check(prompt.includes('优先直接内联执行'),
        'system/message 里逐字出现校验脚本内联执行规则')
      check(prompt.includes('不要先创建临时文件'),
        'system/message 里逐字出现"不要先创建临时文件"这条限定')
      // 加粗总纲:注册表不要插值 `**`,它必须原样到达模型。
      check(prompt.includes('**必须用中文思考和输出；代码、标识符与符号保持原样，不翻译、不改写。**'),
        'system/message 里逐字出现中文规则的加粗总纲')
      check(prompt.includes('**修改文件必须用编辑文件工具；命令与脚本只能用于检验，检验出错必须回到编辑工具修正。**'),
        'system/message 里逐字出现编辑规则的加粗总纲')
      check(prompt.includes('**校验脚本一律内联执行，不要先写临时文件；只有需长期留存的脚本才写进仓库。**'),
        'system/message 里逐字出现内联规则的加粗总纲')
      check(sys?.event?.data?.message?.source?.kind === 'system-prompt',
        'system/message 的来源是 system-prompt(证明走的是注册表装配)')
      // 位置:两组规则锚定在两个不同的槽位,活体判据也随之分成两族。
      //   · 工具规则(编辑/内联)锚 TOOL_BASH − 40 → 排在首个官方工具说明
      //     (TOOL_READ 那句 "Use the read tool")之前;
      //   · 语言规则锚 DEPLOYMENT_PERSONA_SUFFIX + 1 → 排在**最末尾**。
      // 这正是 prompt-text.js 的 TAIL_ORDER_OFFSET 记录的那次位置拆分:工具规则约束的是
      // 模型马上要用的机制,必须先读;语言规则的对立面是稀释,只能靠 recency。
      const languageAt = prompt.indexOf('所有思考过程和临时输出都必须使用中文')
      const editAt = prompt.indexOf('编辑或修改文件时，必须使用专门的编辑文件工具')
      const inlineAt = prompt.indexOf('优先直接内联执行')
      const digestAt = prompt.indexOf('**必须用中文思考和输出')
      const toolAt = prompt.indexOf('Use the read tool')
      check(editAt > 0 && toolAt > 0 && editAt < toolAt,
        '编辑工具规则排在官方工具说明之前', `edit@${editAt} tool@${toolAt}`)
      check(inlineAt > 0 && inlineAt < toolAt, '内联执行规则也排在官方工具说明之前',
        `inline@${inlineAt} tool@${toolAt}`)
      check(inlineAt > editAt, '内联执行规则排在编辑工具规则之后',
        `edit@${editAt} inline@${inlineAt}`)
      check(languageAt > 0 && toolAt > 0 && languageAt > toolAt,
        '中文规则排在官方工具说明之后(锚在提示词尾部)', `language@${languageAt} tool@${toolAt}`)
      check(languageAt > editAt && languageAt > inlineAt,
        '中文规则排在两条工具规则之后', `language@${languageAt} edit@${editAt} inline@${inlineAt}`)
      check(digestAt > 0 && digestAt < languageAt,
        '加粗总纲排在细则之前(同段内)', `digest@${digestAt} language@${languageAt}`)
      // "最末尾"这条不能只看它排在工具说明之后:一个落在提示词中段的中文规则同样满足
      // 前两条。它必须落在整个提示词的后半——首尾之间没有更多官方英文内容插在它后面。
      check(languageAt > prompt.length / 2,
        '中文规则落在系统提示词后半(尾部锚点未被中间槽位挤走)',
        `language@${languageAt} len@${prompt.length}`)

      // 产品名替换:身份句由上游 `SystemPrompt` 构造函数自己注册,本插件改不动它,
      // 因此走的是 `system-prompt/assemble` waterfall 的后处理。这里验证它到达模型时
      // 已经换名,并且提示词里不再残留旧名(旧名还出现在 harness-dev-context 的两段里)。
      check(prompt.includes('You are an AI agent powered by Work Buddy.'),
        'system/message 里身份句已替换为 powered by Work Buddy')
      const staleAt = prompt.indexOf('DeepSeek Harness')
      check(staleAt < 0, 'system/message 里不再出现 DeepSeek Harness',
        staleAt < 0 ? '' : `首个残留 @${staleAt}`)

      // 软判据:模型自己在回答里复述了这些规则(说明它确实读到了)。
      const assistant = (page.records ?? []).find((r) => r?.event?.type === 'assistant/message')
      const reply = ((assistant?.event?.data?.message?.content ?? []).map((c) => c.text ?? '').join('\n'))
      check(/中文/.test(reply), '模型回答里复述了"中文"这条规则')
      check(/编辑工具|编辑文件/.test(reply), '模型回答里复述了"编辑工具"这条规则')
      check(/内联|临时文件/.test(reply), '模型回答里复述了"内联执行/不留临时文件"这条规则')
      const snippet = prompt.replace(/\n+/g, ' | ').slice(0, 200)
      console.log(`       系统提示词开头:${snippet}`)
    }
  }
}

console.log('')
if (failed === 0) console.log(`全部 ${passed} 项通过:dsh-chinese 在 ${PORT} 上启用且规则进入系统提示词`)
else console.log(`${failed} 项失败(通过 ${passed})`)
process.exit(failed === 0 ? 0 : 1)
