/**
 * 探针:dsh-chinese 的提示词文本、开关语义与注册/卸载行为。
 *
 * 这个插件的全部行为就是"往每次请求的系统提示词里塞三段固定中文规则"。于是真正
 * 的风险不在功能多,而在**契约**上:
 *
 *   - 文本是固定常量,必须逐字钉住——上游 `renderPrompt` 会丢弃空段落,所以一段被
 *     误删/误改的规则不会报错,只会静默地不再约束模型;
 *   - 开关必须按**每次装配**求值(provider 而非静态字符串),否则改了设置要重启才生效;
 *   - 关掉时贡献的是空串而非"段落仍在但内容为空"以外的任何东西,即不占用 token 预算;
 *   - 命名空间三处拼写(loader entry id / NS 常量 / 包名)必须逐字一致——不一致的表现
 *     是**静默**读不到值,不报错;
 *   - 注册必须走 `ctx.effect`,卸载后注册表必须干净这条 HMR 安全红线。
 *
 * 全程离线:真实 import 宿主半部的 `index.js` 与 `src/**`,用桩 ctx 驱动 `apply`,
 * 再从桩注册表读回段落并按上游 `renderPrompt` 的语义渲染。不连任何实例。
 *
 * 用法:node exploration/ch-prompt-probe.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = join(ROOT, 'dsh-chinese')

const load = (rel) => import(pathToFileURL(join(PLUGIN, rel)).href)

const index = await load('index.js')
const text = await load('src/core/prompt-text.js')
const settings = await load('src/core/settings.js')
const sections = await load('src/hooks/sections.js')
const rebrand = await load('src/core/rebrand.js')
const rebrandHook = await load('src/hooks/rebrand.js')

let passed = 0
let failed = 0
const check = (ok, label, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${label}`) }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

// ── 桩 ───────────────────────────────────────────────────────────────────────

/**
 * 桩 systemPrompt 注册表:按上游语义保存 name → { order, text }。
 * `getSectionOrder` 直接回答仓库里那两档锚点(工具规则用 TOOL_BASH,语言规则用
 * DEPLOYMENT_PERSONA_SUFFIX)。
 */
function makeSystemPrompt({ orders = { TOOL_BASH: 1000, DEPLOYMENT_PERSONA_SUFFIX: 10200 } } = {}) {
  const registered = new Map()
  return {
    registered,
    service: {
      getSectionOrder: (name) => orders[name],
      section: (section) => {
        if (registered.has(section.name)) throw new Error(`prompt section "${section.name}" is already registered`)
        if (!Number.isFinite(section.order)) throw new TypeError('order must be finite')
        registered.set(section.name, section)
        return () => { registered.delete(section.name) }
      },
    },
  }
}

/** 桩 ctx:`services` 走 ctx.get;`inject` 立即以 child 回调;effect 收下 disposer。 */
function makeCtx({ services = {} } = {}) {
  const logger = { info: [], warn: [], error: [], debug: [] }
  const effects = []
  const injections = []
  /** 事件名 → 监听器数组。waterfall 的调用顺序就是注册顺序(先注册的在最外层)。 */
  const listeners = new Map()
  for (const level of Object.keys(logger)) {
    logger[level] = []
  }
  const ctx = {
    fiber: { id: 'fiber-test' },
    logger: {
      info: (m) => logger.info.push(m),
      warn: (m) => logger.warn.push(m),
      error: (m) => logger.error.push(m),
      debug: (m) => logger.debug.push(m),
    },
    get: (name) => services[name],
    effect: (fn, label) => {
      const disposer = fn()
      effects.push({ label, disposer })
      return disposer
    },
    inject: (names, cb) => {
      injections.push(names)
      const child = { effect: ctx.effect, settings: services.settings }
      cb(child)
      return child
    },
    /** 收下监听器并归还 disposer,与 cordis 的 `ctx.on` 同形。 */
    on: (event, listener) => {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        const at = list.indexOf(listener)
        if (at >= 0) list.splice(at, 1)
      }
    },
    // 展开 services 到顶层,让 `inject: ['systemPrompt']` 对应的 ctx.systemPrompt 可用
    ...services,
  }
  return { ctx, logger, effects, injections, listeners }
}

/**
 * 按上游 `renderPrompt` 的语义渲染:provider 求值 → 丢弃空串 → 空行连接。
 * 只保留这两条规则,故不涉及变量插值。
 */
function render(registered) {
  return [...registered.values()]
    .slice()
    .sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((section) => (typeof section.text === 'function' ? section.text({}) : section.text))
    .filter((line) => line.length > 0)
    .join('\n\n')
}

/**
 * 按 cordis 的 waterfall 语义跑一条链:先注册的监听器在最外层,每个监听器收到
 * `(...args, next)`,`next()` 进入下一个,链末返回初始装配结果。与上游
 * `docs/cordis-primer.md` 的描述一致(around-middleware,值经 `next()` 传播)。
 */
function runWaterfall(listeners, assembly, context = {}) {
  const list = listeners.get('system-prompt/assemble') ?? []
  const invoke = (index) => {
    if (index >= list.length) return Promise.resolve(assembly)
    return Promise.resolve(list[index](assembly, context, () => invoke(index + 1)))
  }
  return invoke(0)
}

/**
 * 模拟上游 `assemble()`:从桩注册表取段落(provider 求值)→ 跑装配 waterfall。
 * 与上游一样先排序、**保留**空串段落(丢弃发生在 `renderPrompt`)。
 */
function assemble(registry, listeners, variables = {}) {
  const sections = [...registry.registered.values()]
    .slice()
    .sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((section) => ({
      name: section.name,
      text: typeof section.text === 'function' ? section.text({}) : section.text,
    }))
  return runWaterfall(listeners, { sections, contexts: [], tools: [], variables })
}

/** 按 `renderPrompt` 的语义渲染一次装配:丢弃空串段落 → 空行连接。 */
function renderAssembly(assembly) {
  return assembly.sections
    .filter((section) => section.text.length > 0)
    .map((section) => section.text)
    .join('\n\n')
}

/** 一次性装好插件:`apply` 拿到的是已绑定开关的 config 桩。 */
function mount({ toggles = {}, orders } = {}) {
  const registry = makeSystemPrompt(orders === undefined ? {} : { orders })
  const services = { systemPrompt: registry.service }
  const { ctx, logger, effects, injections, listeners } = makeCtx({ services })
  const config = makeConfig(toggles)
  settings.bindConfig(config)
  index.apply(ctx, config)
  return { registry, logger, effects, injections, listeners, config }
}

/** Config 桩:`[field] = { get() }`——与 schemastery 的 volatile ref 同形。 */
function makeConfig(values) {
  const config = {}
  for (const key of Object.keys(settings.DEFAULTS)) {
    config[key] = { get: () => (key in values ? values[key] : undefined) }
  }
  return config
}

// ── 1. 命名空间与包名一致性 ──────────────────────────────────────────────────
console.log('\n[1] 命名空间与包名一致性')
{
  const manifest = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'))
  const patch = readFileSync(join(PLUGIN, 'cordis.patch.yml'), 'utf8')
  check(settings.NS === 'falling-ts-chinese', `NS 常量 = falling-ts-chinese`, settings.NS)
  check(patch.includes(`id: ${settings.NS}`), `cordis.patch.yml 的 insert[].id = ${settings.NS}`)
  check(patch.includes(`'${manifest.name}'`), `cordis.patch.yml 按包名引用 ${manifest.name}`)
  check(manifest.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch 指向 ./cordis.patch.yml')
  check(manifest.name === '@falling-ts/dsh-chinese', '包名 = @falling-ts/dsh-chinese', manifest.name)
  // 纯 Host 插件:不得有客户端半部或 ./client 导出。
  check(manifest.dsh?.client === undefined, '无 dsh.client 声明(纯 Host 插件)')
  check(manifest.exports?.['./client'] === undefined, '无 "./client" 导出')
}

// ── 2. 提示词文本逐字钉住 ────────────────────────────────────────────────────
console.log('\n[2] 提示词文本逐字钉住')
{
  // 加粗总纲:每段第一行是 `**…**` 包裹的一句话核心要求。
  const DIGESTS = {
    CHINESE_RULE_TEXT: '**必须用中文思考和输出；代码、标识符与符号保持原样，不翻译、不改写。**',
    EDIT_TOOL_RULE_TEXT: '**修改文件必须用编辑文件工具；命令与脚本只能用于检验，检验出错必须回到编辑工具修正。**',
    INLINE_SCRIPT_RULE_TEXT: '**校验脚本一律内联执行，不要先写临时文件；只有需长期留存的脚本才写进仓库。**',
  }
  for (const [name, digest] of Object.entries(DIGESTS)) {
    const body = text[name]
    check(body.split('\n')[0] === digest, `${name} 首行是逐字钉住的加粗总纲`, body.split('\n')[0])
    // 恰好一对 `**`:加粗只给总纲,细则不加粗(加粗多了等于没加粗)。
    check((body.match(/\*\*/g) ?? []).length === 2, `${name} 只有总纲被一对 ** 包裹`,
      String((body.match(/\*\*/g) ?? []).length))
  }

  check(text.CHINESE_RULE_TEXT.includes('所有思考过程和临时输出都必须使用中文'),
    '中文规则含"所有思考过程和临时输出都必须使用中文"')
  check(/代码|符号/.test(text.CHINESE_RULE_TEXT) && text.CHINESE_RULE_TEXT.includes('不翻译、不改写'),
    '中文规则显式豁免代码与符号(不翻译、不改写)')
  // 「思考」必须显式绑定到推理流——实测推理流的中文密度远低于可见输出,
  // 所以规则必须说清"思考"不只是给用户看的那部分。
  check(text.CHINESE_RULE_TEXT.includes('「思考」指的是你的推理过程本身'),
    '中文规则把「思考」显式绑定到推理过程本身')
  check(text.CHINESE_RULE_TEXT.includes('不只是你展示给用户的那部分'),
    '中文规则区分推理流与"展示给用户的那部分"')
  check(text.CHINESE_RULE_TEXT.includes('即使上下文中其他内容都是英文')
    && text.CHINESE_RULE_TEXT.includes('即使你在分析英文文件或英文报错'),
    '中文规则声明上下文语言不影响推理语言(英文上下文/英文文件/英文报错)')
  // 点名实测观察到的滑落模式:纯英文块几乎全是 "Let me…" 式动作规划。
  check(text.CHINESE_RULE_TEXT.includes('Let me check'), '中文规则点名实测的 "Let me check" 滑落模式')
  check(text.CHINESE_RULE_TEXT.includes('Let me look at') && text.CHINESE_RULE_TEXT.includes('Now I need to'),
    '中文规则点名多例英文下一步计划句式')
  check(text.CHINESE_RULE_TEXT.includes('典型违规'), '中文规则把这些句式标为"典型违规"')
  check(text.EDIT_TOOL_RULE_TEXT.includes('必须使用专门的编辑文件工具'),
    '编辑规则含"必须使用专门的编辑文件工具"')
  check(text.EDIT_TOOL_RULE_TEXT.includes('禁止使用命令行或脚本'),
    '编辑规则含"禁止使用命令行或脚本"')
  check(/mjs/.test(text.EDIT_TOOL_RULE_TEXT) && /js/.test(text.EDIT_TOOL_RULE_TEXT) && /py/.test(text.EDIT_TOOL_RULE_TEXT),
    '编辑规则点名 mjs / js / py 等脚本语言')
  check(text.EDIT_TOOL_RULE_TEXT.includes('只能用于检验文件修改的结果'),
    '编辑规则限定命令与脚本只用于检验')
  check(text.EDIT_TOOL_RULE_TEXT.includes('必须再次使用编辑文件工具'),
    '编辑规则要求检验出错后仍回到编辑工具修正')
  check(text.INLINE_SCRIPT_RULE_TEXT.includes('优先直接内联执行'),
    '内联规则含"优先直接内联执行"')
  check(text.INLINE_SCRIPT_RULE_TEXT.includes('不要先创建临时文件'),
    '内联规则要求不要先创建临时文件')
  check(text.INLINE_SCRIPT_RULE_TEXT.includes('污染项目'),
    '内联规则点名"污染项目"这一动机')
  check(/python3/.test(text.INLINE_SCRIPT_RULE_TEXT) && /node/.test(text.INLINE_SCRIPT_RULE_TEXT),
    '内联规则给出 python3 与 node 两种执行方式')
  check(/heredoc|here-document|<<|--input-type=module|-e/.test(text.INLINE_SCRIPT_RULE_TEXT),
    '内联规则给出多行代码的传法(here-document / -e)')
  check(text.INLINE_SCRIPT_RULE_TEXT.includes('长期留存') && text.INLINE_SCRIPT_RULE_TEXT.includes('写入仓库文件'),
    '内联规则保留"需要长期留存时才写文件"的出口')
  // 总纲只准复述、不准新增要求:它讲到的每个概念,细则里都必须能对上。
  // 用概念词表而不是子串比对——总纲本就是凝练改写,不该要求逐字复述细则。
  const CONCEPTS = {
    CHINESE_RULE_TEXT: ['中文', '代码', '标识符', '符号', '输出'],
    EDIT_TOOL_RULE_TEXT: ['编辑文件工具', '命令', '脚本', '检验'],
    INLINE_SCRIPT_RULE_TEXT: ['内联执行', '临时文件', '长期留存'],
  }
  for (const [name, concepts] of Object.entries(CONCEPTS)) {
    const [digest, ...detailLines] = text[name].split('\n')
    const detail = detailLines.join('\n')
    const absentInDigest = concepts.filter((word) => !digest.includes(word))
    const absentInDetail = concepts.filter((word) => !detail.includes(word))
    check(absentInDigest.length === 0, `${name} 总纲覆盖了全部核心概念`, absentInDigest.join(' / '))
    check(absentInDetail.length === 0, `${name} 核心概念在细则中都有落点`, absentInDetail.join(' / '))
  }

  // 段落布局:工具规则(编辑/内联)排在官方工具说明前;语言规则排在提示词最末尾。
  // 两组锚点不同是有意的——理由见 prompt-text.js 的 TAIL_ORDER_OFFSET。
  const ARGS = { chinese: true, editTool: true, inlineScript: true, anchorOrder: 1000, tailAnchorOrder: 10200 }
  const all = text.buildSections(ARGS)
  check(all.length === 3, '三条规则都开时产生 3 段', String(all.length))
  const byName = Object.fromEntries(all.map((s) => [s.name, s]))
  const toolOrder = 1000 + text.SECTION_ORDER_OFFSET
  const tailOrder = 10200 + text.TAIL_ORDER_OFFSET
  check(byName[text.EDIT_TOOL_RULE_SECTION]?.order === toolOrder,
    `编辑规则 order = TOOL_BASH + OFFSET (${toolOrder})`, String(byName[text.EDIT_TOOL_RULE_SECTION]?.order))
  check(byName[text.INLINE_SCRIPT_RULE_SECTION]?.order === toolOrder + 1,
    `内联规则紧随编辑规则 (${toolOrder + 1})`, String(byName[text.INLINE_SCRIPT_RULE_SECTION]?.order))
  check(byName[text.CHINESE_RULE_SECTION]?.order === tailOrder,
    `语言规则 order = PERSONA_SUFFIX + TAIL_OFFSET (${tailOrder})`, String(byName[text.CHINESE_RULE_SECTION]?.order))
  check(toolOrder < 1000 && toolOrder + 1 < 1000,
    '编辑/内联两条都排在首个官方工具段(TOOL_BASH=1000)之前')
  // 尾部锚点 10200 是注册表最后一档(DEPLOYMENT_PERSONA_SUFFIX)。
  check(tailOrder > 10200, '语言规则排在注册表最后一档(PERSONA_SUFFIX)之后,即提示词最末尾')
  check(tailOrder > toolOrder + 1, '语言规则确实排在两条工具规则之后(不是夹在它们中间)')
  // 列表顺序仍是"插件贡献的规则"的稳定读序:工具规则在前、语言规则在后。
  check(all[0].name === text.EDIT_TOOL_RULE_SECTION
    && all[1].name === text.INLINE_SCRIPT_RULE_SECTION
    && all[2].name === text.CHINESE_RULE_SECTION,
    '返回列表顺序:编辑工具 → 内联执行 → 语言(与 order 一致)')

  // 渲染后的实际排布:语言规则必须落在最后一条。
  {
    const mounted = mount()
    const rendered = render(mounted.registry.registered)
    const lines = rendered.split('\n\n')
    check(lines.length === 3, '三段落渲染后是 3 块', String(lines.length))
    check(lines[lines.length - 1].startsWith('**必须用中文思考和输出'),
      '渲染后语言规则是最后一块(recency 生效)', lines[lines.length - 1]?.slice(0, 30))
    check(lines[0].startsWith('**修改文件必须用编辑文件工具'),
      '渲染后编辑规则在最前', lines[0]?.slice(0, 30))
  }

  // 关掉任意组合时的段落数与 order 连续性。
  const both = text.buildSections({ ...ARGS, inlineScript: false })
  check(both.length === 2, '只关内联规则时产生 2 段', String(both.length))
  check(both.find((s) => s.name === text.EDIT_TOOL_RULE_SECTION).order === toolOrder
    && both.find((s) => s.name === text.CHINESE_RULE_SECTION).order === tailOrder,
    '关掉内联规则时编辑/语言两段 order 不变')
  check(text.buildSections({ ...ARGS, chinese: false }).length === 2, '只关语言规则时产生 2 段')
  check(text.buildSections({ ...ARGS, editTool: false, inlineScript: false }).length === 1,
    '只开语言规则时产生 1 段')
  check(text.buildSections({ ...ARGS, chinese: false }).every((s) => s.order < 1000),
    '关掉语言规则后剩余两段都在工具段之前')
  check(text.buildSections({ ...ARGS, chinese: false, editTool: false, inlineScript: false }).length === 0,
    '三条都关时不产生段落')
  // 关掉中间那段的 order 不留空洞:内联规则顶到编辑规则的位置上。
  const gap = text.buildSections({ ...ARGS, editTool: false })
  check(gap.find((s) => s.name === text.INLINE_SCRIPT_RULE_SECTION).order === toolOrder,
    '关掉编辑规则后内联规则顶到同一位置(工具规则间不留 order 空洞)',
    String(gap.find((s) => s.name === text.INLINE_SCRIPT_RULE_SECTION).order))

  // 尾部锚点无法解析时,宁可**不注册**语言规则,也不把它塞到提示词中间:
  // 一个静默落错位置的语言规则比缺席更糟(用户以为它在生效)。
  const noTail = text.buildSections({ ...ARGS, tailAnchorOrder: Number.NaN })
  check(noTail.length === 2 && noTail.every((s) => s.name !== text.CHINESE_RULE_SECTION),
    '尾部锚点不可解析时不产出语言规则(而非落到中间)', noTail.map((s) => s.name).join(','))
  check(text.buildSections({ ...ARGS, tailAnchorOrder: undefined }).every((s) => s.name !== text.CHINESE_RULE_SECTION),
    'tailAnchorOrder 缺省时同样不产出语言规则')
}

// ── 3. 默认全开与清单导出 ────────────────────────────────────────────────────
console.log('\n[3] 默认值与静默回退')
{
  check(settings.DEFAULTS.chineseOnly === true, 'chineseOnly 默认 true')
  check(settings.DEFAULTS.editToolOnly === true, 'editToolOnly 默认 true')
  check(settings.DEFAULTS.inlineScriptOnly === true, 'inlineScriptOnly 默认 true')
  check(settings.DEFAULTS.rebrand === true, 'rebrand 默认 true')
  check(Object.keys(settings.DEFAULTS).length === 4, 'DEFAULTS 恰好 4 个开关', String(Object.keys(settings.DEFAULTS).length))
  check(settings.INLINE_SCRIPT_FIELD === 'inlineScriptOnly',
    'INLINE_SCRIPT_FIELD 常量 = inlineScriptOnly', settings.INLINE_SCRIPT_FIELD)
  check(settings.REBRAND_FIELD === 'rebrand', 'REBRAND_FIELD 常量 = rebrand', settings.REBRAND_FIELD)
  check(settings.readToggle(settings.CHINESE_FIELD, true) === true, '未绑定时 readToggle 回退到默认值')
  // 非布尔值(字符串 'false'、数字、null)一律回退,不做强制转换。
  settings.bindConfig({ [settings.CHINESE_FIELD]: { get: () => 'false' } })
  check(settings.readToggle(settings.CHINESE_FIELD, true) === true, '字符串 "false" 不生效(按未设置处理)')
  settings.bindConfig({ [settings.CHINESE_FIELD]: { get: () => false } })
  check(settings.readToggle(settings.CHINESE_FIELD, true) === false, '真正的 false 生效')
  settings.bindConfig(undefined)
  check(settings.readToggle(settings.CHINESE_FIELD, true) === true, 'Config 缺席时回退到默认值')
  check(settings.readConfigField(settings.CHINESE_FIELD) === undefined, 'Config 缺席时 readConfigField 返回 undefined')
}

// ── 4. apply 的注册行为 ──────────────────────────────────────────────────────
console.log('\n[4] apply 的注册行为')
{
  const { registry, logger, effects, injections, listeners } = mount()
  check(registry.registered.size === 3, 'apply 注册了 3 个段落', String(registry.registered.size))
  check(registry.registered.has(text.CHINESE_RULE_SECTION), `注册了 ${text.CHINESE_RULE_SECTION}`)
  check(registry.registered.has(text.EDIT_TOOL_RULE_SECTION), `注册了 ${text.EDIT_TOOL_RULE_SECTION}`)
  check(registry.registered.has(text.INLINE_SCRIPT_RULE_SECTION), `注册了 ${text.INLINE_SCRIPT_RULE_SECTION}`)
  check(effects.length === 4, '三个段落 + 一个替换监听器都由 ctx.effect 持有(可卸载)', String(effects.length))
  check(effects.every((e) => typeof e.disposer === 'function'), '每个 effect 都归还了 disposer')
  check(effects.every((e) => typeof e.label === 'string' && e.label.includes('dsh-chinese')),
    '每个 effect 都带 dsh-chinese 标签')
  check(effects.some((e) => e.label.includes('rebrand')), '替换监听器的 effect 带 rebrand 标签')
  check((listeners.get('system-prompt/assemble') ?? []).length === 1,
    'apply 在 system-prompt/assemble 上挂了 1 个监听器')
  check(typeof rebrandHook.registerRebrandRewrite === 'function', 'hooks/rebrand.js 导出 registerRebrandRewrite')
  check(injections.some((names) => Array.isArray(names) && names.includes('settings')),
    '设置表单声明走惰性 ctx.inject(["settings"])')
  check(logger.info.some((m) => m.includes('[dsh-chinese] active')), 'apply 打印了 active 行')
  check(Array.isArray(index.inject) && index.inject.includes('systemPrompt'),
    'inject 声明了 systemPrompt')
  check(index.name === 'chinese', '插件 name = chinese', index.name)
  check(index.default === undefined, '无 default export(函数插件约定)')
}

// ── 5. 每次装配求值开关 ──────────────────────────────────────────────────────
console.log('\n[5] 开关按每次装配求值')
{
  const ALL_ON = {
    [settings.CHINESE_FIELD]: true,
    [settings.EDIT_TOOL_FIELD]: true,
    [settings.INLINE_SCRIPT_FIELD]: true,
  }
  const { registry } = mount({ toggles: ALL_ON })
  const first = render(registry.registered)
  check(first.includes('所有思考过程和临时输出都必须使用中文'), '默认渲染含中文规则')
  check(first.includes('必须使用专门的编辑文件工具'), '默认渲染含编辑规则')
  check(first.includes('优先直接内联执行'), '默认渲染含内联执行规则')

  // 同一份注册表,改设置后再次渲染即生效——无需重注册、无需重启。
  settings.bindConfig(makeConfig({ ...ALL_ON, [settings.CHINESE_FIELD]: false }))
  const second = render(registry.registered)
  check(!second.includes('所有思考过程和临时输出都必须使用中文'), '关掉中文规则后该段不再出现')
  check(second.includes('必须使用专门的编辑文件工具'), '关掉中文规则不影响编辑规则')
  check(second.includes('优先直接内联执行'), '关掉中文规则不影响内联规则')
  check(registry.registered.size === 3, '改开关不改变注册表(仍 3 段)')

  // 三个开关彼此独立:只关内联规则时,另两段必须照旧。
  settings.bindConfig(makeConfig({ ...ALL_ON, [settings.INLINE_SCRIPT_FIELD]: false }))
  const third = render(registry.registered)
  check(!third.includes('优先直接内联执行'), '单独关掉内联规则后该段不再出现')
  check(third.includes('所有思考过程和临时输出都必须使用中文'), '关掉内联规则不影响中文规则')
  check(third.includes('必须使用专门的编辑文件工具'), '关掉内联规则不影响编辑规则')

  // 只关编辑规则:内联规则段必须仍由自己的开关管着,不能被连坐。
  settings.bindConfig(makeConfig({ ...ALL_ON, [settings.EDIT_TOOL_FIELD]: false }))
  const fourth = render(registry.registered)
  check(!fourth.includes('必须使用专门的编辑文件工具'), '单独关掉编辑规则后该段不再出现')
  check(fourth.includes('优先直接内联执行'), '关掉编辑规则不影响内联规则(不被连坐)')

  settings.bindConfig(makeConfig({
    [settings.CHINESE_FIELD]: false,
    [settings.EDIT_TOOL_FIELD]: false,
    [settings.INLINE_SCRIPT_FIELD]: false,
  }))
  check(render(registry.registered) === '', '三条都关时渲染为空串(零 token 贡献)')

  settings.bindConfig(makeConfig({}))
  check(render(registry.registered).includes('所有思考过程和临时输出都必须使用中文'),
    'Config 字段未设置时回退到默认全开')
}

// ── 6. 卸载后注册表干净(HMR 安全) ────────────────────────────────────────────
console.log('\n[6] 卸载后注册表干净')
{
  const { registry, effects, listeners } = mount()
  check(registry.registered.size === 3, '卸载前 3 段')
  check((listeners.get('system-prompt/assemble') ?? []).length === 1, '卸载前挂着替换监听器')
  for (const effect of effects) effect.disposer()
  check(registry.registered.size === 0, '卸载后 0 段(注册表干净)', String(registry.registered.size))
  check((listeners.get('system-prompt/assemble') ?? []).length === 0, '卸载后替换监听器也被摘掉')
  check(render(registry.registered) === '', '卸载后渲染为空')
  // 重新 apply 必须能再次注册(证明上一轮没留残留导致 duplicate 抛错)。
  settings.bindConfig(makeConfig({}))
  const again = makeSystemPrompt({})
  const { ctx } = makeCtx({ services: { systemPrompt: again.service } })
  let threw
  try {
    index.apply(ctx, makeConfig({}))
  } catch (error) {
    threw = error
  }
  check(threw === undefined, '卸载后重新 apply 不因重复注册抛错', threw === undefined ? '' : String(threw))
  check(again.registered.size === 3, '重新 apply 后再次注册 3 段')
}

// ── 7. 锚点回退与注册表异常面 ────────────────────────────────────────────────
console.log('\n[7] 锚点回退与健壮性')
{
  // 自定义锚点被跟随(证明不是写死 1000 / 10200)。
  const custom = mount({ orders: { TOOL_BASH: 4242, DEPLOYMENT_PERSONA_SUFFIX: 9000 } })
  const section = custom.registry.registered.get(text.EDIT_TOOL_RULE_SECTION)
  check(section.order === 4242 + text.SECTION_ORDER_OFFSET, '跟随注册表实际返回的 TOOL_BASH order', String(section.order))
  const inlineSection = custom.registry.registered.get(text.INLINE_SCRIPT_RULE_SECTION)
  check(inlineSection.order === 4242 + text.SECTION_ORDER_OFFSET + 1,
    '内联段同样跟随锚点(锚点 +1)', String(inlineSection.order))
  const tailSection = custom.registry.registered.get(text.CHINESE_RULE_SECTION)
  check(tailSection.order === 9000 + text.TAIL_ORDER_OFFSET,
    '语言段跟随注册表实际返回的 DEPLOYMENT_PERSONA_SUFFIX order', String(tailSection.order))

  // getSectionOrder 抛异常时:工具规则回退到 1000,语言规则则不注册(见下一条)。
  const throwing = {
    getSectionOrder: () => { throw new Error('registry exploded') },
    section: () => () => {},
  }
  const { ctx: ctxA } = makeCtx({ services: { systemPrompt: throwing } })
  let threw
  try { index.apply(ctxA, makeConfig({})) } catch (error) { threw = error }
  check(threw === undefined, 'getSectionOrder 抛异常时 apply 不挂(工具规则回退锚点)')

  // getSectionOrder 返回非有限值时:工具规则回退,语言规则不注册。
  const nan = { getSectionOrder: () => Number.NaN, section: () => () => {} }
  const { ctx: ctxB } = makeCtx({ services: { systemPrompt: nan } })
  threw = undefined
  try { index.apply(ctxB, makeConfig({})) } catch (error) { threw = error }
  check(threw === undefined, 'getSectionOrder 返回 NaN 时 apply 不挂')

  // 尾部锚点不可得时,语言规则**缺席**而不是落到提示词中间。
  const partial = makeSystemPrompt({ orders: { TOOL_BASH: 1000 } })
  const { ctx: ctxC } = makeCtx({ services: { systemPrompt: partial.service } })
  threw = undefined
  try { index.apply(ctxC, makeConfig({})) } catch (error) { threw = error }
  check(threw === undefined, '尾部锚点缺失时 apply 仍成功')
  check(partial.registered.size === 2, '尾部锚点缺失时只注册两条工具规则', String(partial.registered.size))
  check(!partial.registered.has(text.CHINESE_RULE_SECTION),
    '尾部锚点缺失时语言规则不注册(宁缺勿错位)')
  check([...partial.registered.values()].every((s) => s.order < 1000),
    '尾部锚点缺失时注册的两段仍在工具段之前')

  // settings 服务缺席时,表单声明被吞成 warn,段落注册照旧。
  const registry = makeSystemPrompt({})
  const { ctx, logger } = makeCtx({ services: { systemPrompt: registry.service } })
  ctx.inject = () => { throw new Error('settings unavailable') }
  threw = undefined
  try { index.apply(ctx, makeConfig({})) } catch (error) { threw = error }
  check(threw === undefined, 'settings 缺席时 apply 仍成功')
  check(registry.registered.size === 3, 'settings 缺席不影响段落注册')
  check(logger.warn.some((m) => m.includes('[dsh-chinese] settings.configure')), 'settings 缺席时记一条 warn')
}

// ── 8. 清单与显示元数据 ──────────────────────────────────────────────────────
console.log('\n[8] 清单与显示元数据')
{
  const manifest = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'))
  const files = Array.isArray(manifest.files) ? manifest.files : []
  for (const entry of ['index.js', 'src/', 'cordis.patch.yml', 'locale/*.json', 'icon.svg']) {
    check(files.includes(entry), `files 覆盖 "${entry}"`)
  }
  check(manifest.exports?.['./locale/*.json'] === './locale/*.json', 'exports 发布 ./locale/*.json')
  check(manifest.exports?.['./package.json'] === './package.json', 'exports 发布 ./package.json')
  check(manifest.icon === './icon.svg', 'icon 是相对路径 SVG', String(manifest.icon))
  for (const language of ['en', 'zh']) {
    const dict = JSON.parse(readFileSync(join(PLUGIN, 'locale', `${language}.json`), 'utf8'))
    check(typeof dict?.meta?.title === 'string' && dict.meta.title.length <= 40,
      `locale/${language}.json meta.title 非空且 ≤40 字`)
    check(typeof dict?.meta?.description === 'string' && dict.meta.description.length <= 240,
      `locale/${language}.json meta.description 非空且 ≤240 字`)
  }
  const peers = manifest.peerDependencies ?? {}
  const meta = manifest.peerDependenciesMeta ?? {}
  check(peers['@deepseek-ai/cordis'] === '>=4.0.5', 'cordis peer = >=4.0.5')
  check(peers['@deepseek-ai/schemastery'] === '>=3.18.5', 'schemastery peer = >=3.18.5')
  check(peers['@deepseek-ai/dsh-system-prompt'] === '>=0.2.1-rc.1', 'system-prompt peer = >=0.2.1-rc.1')
  check(peers['@deepseek-ai/dsh-settings'] === '>=0.2.1-rc.1', 'settings peer = >=0.2.1-rc.1')
  check(meta['@deepseek-ai/cordis']?.optional !== true, 'cordis 是 required peer')
  for (const name of ['@deepseek-ai/schemastery', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-settings']) {
    check(meta[name]?.optional === true, `${name} 是 optional peer`)
  }
}

// ── 9. 产品名替换 ────────────────────────────────────────────────────────────
console.log('\n[9] 产品名替换(DeepSeek Harness → Work Buddy)')
{
  check(rebrand.REBRAND_FROM === 'DeepSeek Harness', 'REBRAND_FROM 逐字 = DeepSeek Harness', rebrand.REBRAND_FROM)
  check(rebrand.REBRAND_TO === 'Work Buddy', 'REBRAND_TO 逐字 = Work Buddy', rebrand.REBRAND_TO)

  // 全部出现都换掉,而不是只换第一处。
  const many = 'DeepSeek Harness, then DeepSeek Harness, then DeepSeek Harness.'
  check(rebrand.rebrandText(many) === 'Work Buddy, then Work Buddy, then Work Buddy.',
    '文本里每一处都被替换', rebrand.rebrandText(many))
  check(rebrand.rebrandText('no product name here') === 'no product name here', '不含产品名的文本原样返回')
  check(rebrand.rebrandText('DeepSeek model') === 'DeepSeek model', '单独的 DeepSeek 不被替换')
  check(rebrand.rebrandText(undefined) === undefined, '非字符串原样返回(undefined)')
  check(rebrand.rebrandText(42) === 42, '非字符串原样返回(数字)')
  check(rebrand.rebrandText('') === '', '空串原样返回')

  // 上游身份句由 `SystemPrompt` 构造函数自己注册,正是本功能要改的那一句。
  // 桩注册表补上它,模拟上游那次注册。
  const registry = makeSystemPrompt({})
  const { ctx, effects, listeners } = makeCtx({ services: { systemPrompt: registry.service } })
  index.apply(ctx, makeConfig({}))
  registry.registered.set('harness:identity', {
    name: 'harness:identity',
    order: -1000,
    text: 'You are an AI agent powered by DeepSeek Harness.',
  })

  const rendered = renderAssembly(await assemble(registry, listeners))
  check(rendered.includes('You are an AI agent powered by Work Buddy.'),
    '身份句渲染为 powered by Work Buddy', rendered.split('\n\n')[0])
  check(!rendered.includes('DeepSeek Harness'), '渲染结果里不再出现 DeepSeek Harness')
  check(rendered.includes('所有思考过程和临时输出都必须使用中文'), '三段规则照常渲染(替换不吞掉它们)')

  // 替换只叠加在装配结果之上,不改动链上其它贡献与字段。
  const shape = await assemble(registry, listeners)
  check(Array.isArray(shape.sections) && shape.sections.length === 4,
    '装配仍是 4 段(3 条规则 + 身份句)', String(shape.sections?.length))
  check(Array.isArray(shape.contexts) && shape.contexts.length === 0,
    'contexts 按引用透传(刻意不改写:refreshContext 会重算)')
  check(Array.isArray(shape.tools), 'tools 字段按引用透传')

  // 下游监听器必须被走到,证明没有短路整条 waterfall。
  const down = makeSystemPrompt({})
  const { ctx: ctx2, listeners: listeners2 } = makeCtx({ services: { systemPrompt: down.service } })
  index.apply(ctx2, makeConfig({}))
  let innerRan = false
  listeners2.get('system-prompt/assemble').push((a, c, next) => { innerRan = true; return next() })
  await assemble(down, listeners2)
  check(innerRan === true, '替换监听器调用了 next()(未短路 waterfall)')

  // 关掉开关:一个字节都不改。
  settings.bindConfig(makeConfig({ [settings.REBRAND_FIELD]: false }))
  const off = renderAssembly(await assemble(registry, listeners))
  check(off.includes('You are an AI agent powered by DeepSeek Harness.'), '关掉 rebrand 后身份句保持原样')
  check(!off.includes('Work Buddy'), '关掉 rebrand 后不引入 Work Buddy')

  // 按每次装配求值:改回设置后同一条链的下一次装配立即生效,无需重启或重注册。
  settings.bindConfig(makeConfig({ [settings.REBRAND_FIELD]: true }))
  check(renderAssembly(await assemble(registry, listeners)).includes('Work Buddy'),
    '重新打开后下一次装配立即生效(无需重启/重注册)')

  // 非布尔值按未设置处理,回退到默认(开)。
  settings.bindConfig(makeConfig({ [settings.REBRAND_FIELD]: 'false' }))
  check(renderAssembly(await assemble(registry, listeners)).includes('Work Buddy'),
    '字符串 "false" 不生效(按未设置处理,回退默认开)')

  settings.bindConfig(makeConfig({}))
  for (const effect of effects) effect.disposer()
  check((listeners.get('system-prompt/assemble') ?? []).length === 0, '卸载后替换监听器被摘掉')
}

console.log('')
if (failed === 0) console.log(`全部 ${passed} 项通过:dsh-chinese 提示词文本 / 开关语义 / 注册与卸载 / 产品名替换`)
else console.log(`${failed} 项失败(通过 ${passed})`)
process.exit(failed === 0 ? 0 : 1)
