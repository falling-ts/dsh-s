---
name: dsh-s-chinese-plugin
description: Use when working on the dsh-chinese plugin (system-prompt rule injection or the DeepSeek-Harness→Work Buddy product-name substitution), reasoning about why model thinking still appears in English, or anchoring prompt sections. Covers how dsh-chinese contributes three Chinese rules via ctx.systemPrompt.section plus the product-name rewrite on the system-prompt/assemble waterfall, the two anchor points, and the corroborating forensics.
---

# 系统提示词规则注入（dsh-chinese）—— 2026-10-01 新增并实测

第四个自研插件，也是集合里**唯一走官方文档化扩展点、不做任何运行期替换**的：经 `ctx.systemPrompt.section()`（`packages/core/system-prompt/src/index.ts`）向每次请求的系统提示词贡献三段固定中文规则——① 所有思考与临时输出必须用中文（代码、标识符、路径、命令、配置键、API 名、符号保持原样）；② 编辑文件必须用编辑文件工具，命令与脚本只能用于**检验**，检验出错仍须回到编辑工具修正；③ 校验脚本优先**内联执行**（here-document 或 `-e`），不要先建临时文件以免污染项目（2026-10-02 起）。**每段首行是一句 `**…**` 加粗总纲**，凝练该段核心要求，其后才是细则。

**v0.3.0（2026-10-21）另加产品名替换**：系统提示词里每一处 `DeepSeek Harness` 都以 `Work Buddy` 到达模型。它走注册表公开的 `system-prompt/assemble` waterfall（见下文专节），所以本插件仍是集合里**唯一不 patch 任何运行期对象**的那个——两条缝都是官方扩展点。

## 规则①的两次加固（2026-10-11，v0.1.3，实测驱动）

- 文本上，细则头两行显式把「思考」绑定到**推理流本身**（"不只是你展示给用户的那部分"、"即使上下文中其他内容都是英文"），并点名典型违规 `Let me check…` / `Let me look at…` / `Now I need to…`。
- 位置上，语言段从"与工具规则挤在 `TOOL_BASH` 之前"改为锚 `DEPLOYMENT_PERSONA_SUFFIX`+1，落在**提示词最末尾**。
- ③ 与 ② 的分工：② 说脚本**能不能**用（只能检验），③ 说既然能用**该怎么用**（内联、不落盘）。"为了跑脚本而先创建它"本身也是一次文件创建，但 ② 没法在不把检验一并禁掉的前提下禁止它，所以 ③ 补缺口；③ 同时留出口——确实要被复用、被项目引用的脚本属于仓库正式文件。
- 加粗总纲的分工：让规则以**约束**身份被读到。`**` 原样送达——上游 `renderPrompt` 只插值 `{{…}}`、只丢弃空段落，不做 markdown 剥离。总纲只准**复述**细则、不准新增要求（细则才是契约）。

## 取证：为什么"思考"要绑定推理流、语言段要挪到末尾

用户报告"dsh 有时思考还是纯英文"。逐段核对后**排除提示词冲突**。对本会话日志（多帧 zstd，`session.v4.jsonl.zstd`）按内容块类型统计中文密度（剥掉代码块后）：`text` 块 131 个、平均密度 **0.660**、以英文为主仅 3%；`reasoning` 块 210 个、平均密度 **0.460**、以英文为主 26%。纯英文块**全是 "Let me…" 式动作规划**。结论：模型把「思考」读成"展示给用户的思考摘要"，把推理流当成无约束草稿 → 规则①按**名字**绑定推理流并点名该句式。

**位置稀释**（同一会话，按 step 看推理流密度）：step1 **0.616** → step3 0.382 / step5 0.353 / step6 0.378，越往后越差。真实提示词里规则落在约 1/4 处，之后约 30 行全是英文工具说明。语言规则失败模式是**被长上下文稀释**，recency 是唯一可用杠杆 → 锚到注册表最后一档 `DEPLOYMENT_PERSONA_SUFFIX`（`SECTION_ORDERS` 里 = 10200，`packages/core/system-prompt/src/index.ts:125-159`）+1。

**摘要中文化**（属 `dsh-force-compact`）：压缩摘要散文本来中文为主（剥掉代码块后密度 0.591–0.806），真正问题是 8 个英文小标题 + 英文指令模板，而摘要会被**重新注入上下文**，等于每隔一段用英文小标题示范"正式推理用英文写"。故 `dsh-force-compact` 摘要指令整份中文化（结构与官方一致、文案本地化，两条 `<compacted-summary>` 标签逐字保留）。详见 `dsh-force-compact/AGENTS.md`。

**为什么它是纯 Host 插件**：规则改变的是**模型读到什么**，不是界面显示什么。因此没有 `web/client.js`、没有 `dsh.client` 声明、没有 `./client` 导出，也因此**不在** `i18n-parity-probe.mjs` / `theme-token-probe.mjs` 覆盖范围；语言面只有 `locale/{en,zh}.json` 的 `meta`，由 `plugin-manifest-check.mjs` 守住。

## 四条实现要点（改动前必读）

- **文本必须是 provider（函数）而非静态字符串**：`PromptSection.text` 允许 `string | (ctx) => string`，provider 在**每次装配**时求值。静态字符串会在加载时冻结，改开关要重启才生效。
- **关掉的规则贡献空串而不是注销段落**：上游 `renderPrompt` 丢弃空段落，关掉的规则零 token 贡献；按开关注册/注销反而需要 settings 订阅且每次翻转有半生效窗口。
- **order 用两个锚点，因两组规则职责不同**（v0.1.3 拆分）。**工具规则**（编辑 / 内联）锚 `getSectionOrder('TOOL_BASH')` + (-40)，排在官方工具说明**之前**；**语言规则**锚 `getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')` + (+1)，即**提示词最末尾**。**尾部锚点解析不到时宁可不注册语言段**（`resolveTailAnchorOrder` 传 `Number.NaN`，故意的）：静默落在中段的中文规则比缺席更糟，用户会以为它在生效；工具规则能容忍 `FALLBACK_ANCHOR_ORDER = 1000` 兜底（"略早于工具说明"无害），语言规则不能。
- **规则文本固定不可配置**（`src/core/prompt-text.js` 模块常量），只有四个布尔开关（`chineseOnly` / `editToolOnly` / `inlineScriptOnly` / `rebrand`）。把文本做成设置项只会为同一条规则制造第二个会漂移的真相源。文本逐字进 `ch-prompt-probe.mjs`。**加粗总纲同样固定**：也逐字进探针，且只准复述该段细则已有要求。品牌替换的两个词（`REBRAND_FROM` / `REBRAND_TO`）同理是常量，不是配置项。

## 产品名替换：`system-prompt/assemble` waterfall（v0.3.0，2026-10-21）

**要改的那句话盖不掉。** 身份句 `You are an AI agent powered by DeepSeek Harness.` 由上游 `SystemPrompt` **构造函数自己注册**（`packages/core/system-prompt/src/index.ts`，section 名 `harness:identity`、order `HARNESS_IDENTITY = -1000`），本插件无法用同名段落覆盖——同名注册直接 duplicate throw，而 `section()` 只能**追加**。

**所以走缝二**：上游在 `Events` 接口里声明的 `system-prompt/assemble` waterfall（JSDoc 带 `@mode waterfall`，返回值即最终装配）。注册就是 `ctx.on('system-prompt/assemble', async (assembly, _ctx, next) => { const r = await next(); return rewrite(r) })`。

- **必须调用 `next()`，且在 `next()` 之后改写**。上游把"listener 必须调 `next()` 委派"写成红线（`docs/cordis-primer.md`：不调就是短路整条链）。放在 `next()` 之后意味着拿到链上最终结果，改写只叠加、不改动任何既有贡献。探针第 9 组用"内层监听器是否被执行"把不短路这条锁死。
- **只改 `sections` 与 `variables`，绝不动 `contexts`**。运行时上下文由 `refreshContext` 在**每次请求**用 provider 重新求值（上游 `agent.ts`：`renderPrompt(assembly)` 之后紧接着 `refreshContext(assembly, …)`），写进 `contexts` 的改写会被那次求值覆盖。代价是 runtime context 里 `Current DeepSeek Harness implementation checkout: …` 与 `Current DeepSeek Harness Web GUI URL: …` 两行仍带旧名——它们是 user-role 运行时快照，不属于系统提示词。**别为了"全改干净"去动 `contexts`**：那只会换来一个"有时生效"的行为。
- **装配每个 step 都重跑**（`agent.ts` 里 `await systemPrompt.assemble(...)`），所以后处理对每个请求都生效，不存在"只改到第一个请求"。
- **改写只重建动过的字段**：`{ ...assembly, sections, variables }`，其余按引用透传——链上别的 listener 加进来的字段不能被整体重建丢掉。
- **开关按每次装配求值**（`readRebrandRewrite()` 在 listener 体内读），所以设置里翻转 `rebrand` 对下一个请求立即生效，无需重启或重新注册。
- 注册走 `ctx.effect`，卸载即摘掉监听器（探针第 6 组断言）。

## 挂载实测与装插件坑

- 挂载（3080，`DSH_HOME=~/.dsh-web`）：`dsh plugin --profile web add <本地路径>` 装为 `link:` 依赖后，profile HMR **进程内热装载，无需重启**——`pluginInventory/list` 立刻出现 `include:falling-ts-chinese`（`enabled:true`/`fiberPhase:active`），`settings/describe` 出现 `falling-ts-chinese`（`autoGenerate:false`/`applies:'live'`）。
- 装它时踩到的坑（本机 pnpm 11.7.0）：`dsh plugin add` 内部跑 `pnpm install`，本机报 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`（无 TTY 时拒绝清空 modules 目录）。解法是加 `CI=true` 环境变量自动应答（比手工"四步安装"省事）；另外该命令必须在 **`deepseek-harness/` 检出目录内**执行（在容器仓库根跑报 `ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND`），且 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 在 **PowerShell 里要写成 `$env:CODEBUDDY_SAFE_DELETE_ENABLED='0'`**（`VAR=value cmd` 是 bash 语法，pwsh 会当命令名报 CommandNotFoundException）。

## 活体验证判据（`exploration/ch-live-probe.mjs 3080`）

最硬一条是读回会话的 `system/message` 记录（`session/page`，载荷 `{request:{address:{kind:'session',sessionId},throughSeq}}`；`throughSeq` 超会话游标报 `past cursor N`，探针据此自动探测上界），断言三段规则**逐字出现**、来源 `source.kind === 'system-prompt'`（证明走注册表装配而非别的路径），并按**两个锚点**分族断言：两条工具规则**早于**官方工具说明 `Use the read tool`，中文规则**晚于**它且落在提示词**后半**。实测该请求的 `system/message` 里，工具规则接在 preamble 之后、工具说明之前，语言段在最末。

v0.3.0 起另加两条替换判据：身份句必须是 `You are an AI agent powered by Work Buddy.`，且整份提示词里 **`DeepSeek Harness` 零出现**（旧名原本还出现在 harness-dev-context 的两段里，正好一并验证 waterfall 改的是全部 section 而不是只有身份句）。实测（3099 隔离实例）**27/28 通过**，唯一失败是"模型回答里复述了内联执行规则"那条**模型输出随机性**断言。

## 相关技能

- `dsh-s-plugin-collection`：纯 Host 插件定位、规范评审红线。
- `dsh-s-server-run`：HMR 热装载、PowerShell 环境变量写法。
