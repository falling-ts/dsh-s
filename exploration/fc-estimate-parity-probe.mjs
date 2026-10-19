// fc-estimate-parity-probe.mjs — 差分实证：插件移植的估价器 vs 官方实现
//
// 背景（2026-09-17，harness 0.1.6-alpha.1 上游窗口）：
// 上游新增 `packages/compaction/compaction-image-offload`，引入 log-only 投影事件
// `image/offload`：它把被选中的图像块标成 `{ ...block, offloaded: true }`（标记只存在于
// **投影输出**里，不在存储事件里）。随后 `token-meter/src/estimate.ts` 的
// `estimateStructuralBlock` 改为对 image 块**先剥离 offloaded 再计价**：
//
//   if (block.type === 'image') {
//     const { offloaded: _offloaded, ...reference } = block
//     return BLOCK_OVERHEAD + Math.ceil(JSON.stringify(reference).length / CHARS_PER_TOKEN)
//   }
//
// 本插件 `src/engine/builtin.js` 逐字移植了同一套估价数学，用来写 `shadowedTokenCount`
// 影子价格索赔（必须与折叠器对同一区间的估价**逐位相等**）。若移植落后于官方，索赔就会
// 系统性偏大（每个已离线图像多算 `"offloaded":true` 的 JSON 长度），结算出错误 delta。
//
// 本探针做两件事：
//   A. 用 Node 22 的原生类型擦除**直接加载官方 `estimate.ts`**，与插件移植逐例对拍
//      （黄金基准，不是复述常量）；
//   B. 验证 `projectRegion` 已改走官方投影缝 `surface.deriveEventMessage`——离线标记必须
//      进入回放消息（否则适配器的占位替换会跳过该图像，回放区间可能撑爆路由图像预算）。
//
// 运行：node exploration/fc-estimate-parity-probe.mjs

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const OFFICIAL = new URL('../deepseek-harness/packages/llm/token-meter/src/estimate.ts', import.meta.url)
const PLUGIN = new URL('../dsh-force-compact/src/engine/builtin.js', import.meta.url)

let passed = 0
let failed = 0
const failures = []

function ok(name, detail) {
  passed += 1
  console.log(`  PASS  ${name}${detail === undefined ? '' : `   ${detail}`}`)
}

function bad(name, detail) {
  failed += 1
  failures.push(`${name}: ${detail}`)
  console.log(`  FAIL  ${name}   ${detail}`)
}

function check(name, condition, detail) {
  if (condition) ok(name, detail)
  else bad(name, detail)
}

// ---------------------------------------------------------------- 载入两侧

if (!existsSync(fileURLToPath(OFFICIAL))) {
  console.log(`SKIP: 官方向量不存在（harness 子模块未检出？）\n  ${fileURLToPath(OFFICIAL)}`)
  process.exit(0)
}

const official = await import(OFFICIAL.href)
const mine = await import(PLUGIN.href)

const { estimateContent } = official
const { estimateContentBlocks, projectRegion } = mine

console.log('=== A. 估价器差分对拍（官方 estimate.ts vs 插件 builtin.js 移植）===\n')
console.log(`  官方: ${fileURLToPath(OFFICIAL)}`)
console.log(`  插件: ${fileURLToPath(PLUGIN)}\n`)

const IMG = { type: 'image', attachment: { attachmentId: 'att-1', mimeType: 'image/png' } }

const CASES = [
  ['空数组', []],
  ['纯文本', [{ type: 'text', text: 'hello world' }]],
  ['推理块', [{ type: 'reasoning', text: 'thinking hard about this' }]],
  ['中文本（多字节）', [{ type: 'text', text: '压缩上下文并保留最近的消息' }]],
  ['工具调用', [{ type: 'tool-call', name: 'read_file', arguments: '{"path":"a/b.ts","limit":200}' }]],
  ['工具结果（递归）', [{ type: 'tool-result', content: [{ type: 'text', text: 'file body' }] }]],
  ['工具结果（嵌套图像）', [{ type: 'tool-result', content: [IMG] }]],
  ['图像（无标记）', [IMG]],
  ['图像（已离线）', [{ ...IMG, offloaded: true }]],
  ['图像 + 文本 混合', [{ type: 'text', text: 'look at this' }, { ...IMG, offloaded: true }]],
  ['文件块', [{ type: 'file', attachment: { attachmentId: 'f-1', mimeType: 'text/plain' } }]],
  ['未知（merge-extensible）块', [{ type: 'future-block', payload: { a: 1, b: [2, 3] } }]],
  ['空文本块', [{ type: 'text', text: '' }]],
]

for (const [name, blocks] of CASES) {
  const want = estimateContent(blocks)
  const got = estimateContentBlocks(blocks)
  check(`估价一致 — ${name}`, want === got, `官方=${want} 插件=${got}`)
}

// 回归要点：标记不得参与计价（这正是本次修复的内容）。
{
  const plain = estimateContentBlocks([IMG])
  const offloaded = estimateContentBlocks([{ ...IMG, offloaded: true }])
  check('回归：offloaded 标记不增加估价', plain === offloaded, `无标记=${plain} 已离线=${offloaded}`)
  const markerCost = Math.ceil('"offloaded":true,'.length / 4)
  check(
    '回归：移植未把标记的 JSON 长度计进去',
    offloaded === estimateContent([{ ...IMG, offloaded: true }]),
    `若含标记会多出约 ${markerCost} tokens`,
  )
}

// 逐块单项（官方导出 estimateStructuralBlock 只对 default 臂生效，这里直接对齐图像臂）
{
  const want = official.estimateStructuralBlock(IMG)
  const wantOff = official.estimateStructuralBlock({ ...IMG, offloaded: true })
  check('官方 estimateStructuralBlock 对 image 两态同价', want === wantOff, `${want} / ${wantOff}`)
  const gotOff = estimateContentBlocks([{ ...IMG, offloaded: true }])
  check('插件图像臂与官方单块臂一致', gotOff === wantOff, `插件=${gotOff} 官方=${wantOff}`)
}

// ---------------------------------------------------------------- B. 投影缝

console.log('\n=== B. projectRegion 的官方投影缝（surface.deriveEventMessage）===\n')

const RAW_IMAGE = {
  type: 'user/message',
  seq: 1,
  data: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'see image' }, IMG] },
}
// 投影输出：图像块被标上 offloaded（上游 image/offload 投影只做标记，占位替换由适配器完成）。
const PROJECTED_IMAGE = {
  ...RAW_IMAGE.data,
  content: [{ type: 'text', text: 'see image' }, { ...IMG, offloaded: true }],
}
const ASSISTANT = { type: 'assistant/message', seq: 2, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], source: { kind: 'model' } } } }
const EMPTY_ASSISTANT = { type: 'assistant/message', seq: 3, data: { message: { role: 'assistant', content: [], source: { kind: 'model' } } } }
const TOOL_RESULT = { type: 'tool/result', seq: 4, data: { message: { role: 'tool', content: [{ type: 'text', text: 'tool out' }], toolCallId: 'tc-1' } } }

const EVENTS = [null, RAW_IMAGE, ASSISTANT, EMPTY_ASSISTANT, TOOL_RESULT]
const NODES = [1, 2, 3, 4]
const REGION = { start: 1, end: 4 }

function makeSession(surfaceOverride) {
  const surface = { nodes: NODES, ...surfaceOverride }
  return {
    surface,
    snapshotEvents: () => EVENTS,
  }
}

// B1 —— 有投影缝：回放内容必须带 offloaded 标记。
{
  const session = makeSession({
    deriveEventMessage: (event) => {
      if (event.seq === 1) return PROJECTED_IMAGE
      if (event.seq === 2) return ASSISTANT.data.message
      if (event.seq === 3) return null
      if (event.seq === 4) return TOOL_RESULT.data.message
      return null
    },
  })
  const { shadowedSeqs, messages } = projectRegion(session, REGION)
  const first = messages[0]
  const imageBlock = first?.content?.find(block => block.type === 'image')
  check('投影缝生效：回放消息采用投影输出', imageBlock?.offloaded === true, `offloaded=${String(imageBlock?.offloaded)}`)
  check(
    '投影缝生效：未回退到原始事件内容',
    imageBlock !== undefined && imageBlock.offloaded === true && imageBlock !== RAW_IMAGE.data.content[1],
    '原始内容里的图像块无标记',
  )
  check('影子 seq 集合不变（含产出空消息的节点）', JSON.stringify(shadowedSeqs) === JSON.stringify([1, 2, 3, 4]), JSON.stringify(shadowedSeqs))
  check('消息数不变（空 assistant 不产出消息）', messages.length === 3, `messages=${messages.length}`)
  // Session format V4 (harness 0.1.7+): a tool result is a `role:'tool'` message
  // carrying `toolCallId` — the old `role:'user'` + `{type:'tool-result'}` block
  // family was deleted upstream, so asserting 'user' here would pin a shape the
  // harness no longer produces.
  check('工具结果角色与 tool_call_id 保持原样', messages[2]?.toolCallId === 'tc-1' && messages[2]?.role === 'tool', JSON.stringify({ role: messages[2]?.role, toolCallId: messages[2]?.toolCallId }))
  check('assistant source 保持原样', messages[1]?.source?.kind === 'model', JSON.stringify(messages[1]?.source))
}

// B2 —— 没有投影缝（旧会话核 / 旧 harness）：必须原样回退，行为与修复前一致。
{
  const session = makeSession({})
  const { shadowedSeqs, messages } = projectRegion(session, REGION)
  check('无投影缝时回退到原始内容', JSON.stringify(messages[0]?.content) === JSON.stringify(RAW_IMAGE.data.content), '内容逐位相同')
  check('无投影缝时影子 seq 集合不变', JSON.stringify(shadowedSeqs) === JSON.stringify([1, 2, 3, 4]), JSON.stringify(shadowedSeqs))
  check('无投影缝时同样跳过空内容 assistant（镜像上游语义）', messages.length === 3, `messages=${messages.length}`)
}

// B3 —— 投影缝抛异常：必须吞掉并回退，绝不中断事务。
{
  const session = makeSession({
    deriveEventMessage: () => { throw new Error('projection exploded') },
  })
  let threw = false
  let out
  try {
    out = projectRegion(session, REGION)
  } catch {
    threw = true
  }
  check('投影缝抛异常不传播', threw === false, threw ? '抛出了异常' : '正常返回')
  check('投影缝抛异常时回退到原始内容', JSON.stringify(out?.messages?.[0]?.content) === JSON.stringify(RAW_IMAGE.data.content), '内容逐位相同')
  check('投影缝抛异常时影子 seq 集合不变', JSON.stringify(out?.shadowedSeqs) === JSON.stringify([1, 2, 3, 4]), JSON.stringify(out?.shadowedSeqs))
}

// B4 —— deriveEventMessage 返回 null（空 assistant）：节点仍需被记入影子集合。
{
  const session = makeSession({ deriveEventMessage: () => null })
  const { shadowedSeqs, messages } = projectRegion(session, REGION)
  check('投影返回 null 时仍记入影子集合', JSON.stringify(shadowedSeqs) === JSON.stringify([1, 2, 3, 4]), JSON.stringify(shadowedSeqs))
  check('投影返回 null 时不产出消息', messages.length === 0, `messages=${messages.length}`)
}

// B5 —— surface 完全缺失：空投影而非抛错（既有容错契约）。
{
  let threw = false
  let out
  try {
    out = projectRegion({}, REGION)
  } catch {
    threw = true
  }
  check('surface 缺失时不抛错', threw === false, threw ? '抛出了异常' : '正常返回')
  check('surface 缺失时返回空投影', out?.shadowedSeqs?.length === 0 && out?.messages?.length === 0, JSON.stringify(out))
}

// ---------------------------------------------------------------- 汇总

console.log(`\n${'='.repeat(64)}`)
if (failed === 0) {
  console.log(`ALL CHECKS PASSED — ${passed} passed, 0 failed`)
} else {
  console.log(`${passed} passed, ${failed} FAILED`)
  for (const f of failures) console.log(`  - ${f}`)
  process.exitCode = 1
}
