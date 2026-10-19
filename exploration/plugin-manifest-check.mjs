/**
 * 严格校验三个自有插件的 package.json 与 peer 基线。
 *
 * 存在的理由：PowerShell 5.1 的字符串 cmdlet 往返会以 ANSI 解码 UTF-8（无 BOM）
 * 文件，把多字节字符截断成非法 UTF-8；文件仍"看起来正常"、`ConvertFrom-Json`
 * 也照样解析，但 Node 的 `JSON.parse` 直接拒绝。本探针用 JSON.parse 作为唯一判据，
 * 并断言 peer 基线为 dsh-v0.2.1-rc.1 列车（cordis 4.0.5 / schemastery 3.18.5）。
 *
 * 基线历史：0.1.5 → 0.1.6-alpha.1 → 0.1.7-alpha.1 → 0.2.0-rc.1（2026-09-29 切换）
 * → 0.2.1-rc.1（2026-10-19 切换）。
 * 每次换基线都要同步改这里的 DSH_BASELINE，并把上一档字面量加进 STALE。
 *
 * 2026-09-30 起同时守住**显示元数据**（官方 `cordis-plugin-development` skill 的
 * `references/host-plugin.md`：标题/描述放 `locale/<lang>.json` 的 `meta` 下、图标是
 * 清单里的相对路径，两者都要经 `exports` + `files` 发布）。宿主 `readPluginMeta`
 * （`packages/boot/app-boot/src/package-meta.ts`）按 `${specifier}/locale/en.json`
 * 解析，所以少了 `./locale/*.json` 这条 export 就会静默回退到 package.json 的
 * name/description —— 也就是把那一整段 npm 描述当标题用。
 *
 * 用法：node exploration/plugin-manifest-check.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, extname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 四个自有插件目录名。 */
const PLUGINS = ['dsh-force-compact', 'dsh-local-no-auth', 'dsh-web-ding', 'dsh-start-command', 'dsh-chinese']

/** 必须已被替换掉的旧基线字面量。 */
const STALE = ['0.1.6-alpha.1', '0.1.7-alpha.1', '"4.0.2"', '">=0.2.0-rc.1"', '">=4.0.4"', '">=3.18.4"']

/** 所有 `@deepseek-ai/dsh-*` peer 的下界（harness tag dsh-v0.2.1-rc.1）。 */
const DSH_BASELINE = '>=0.2.1-rc.1'

/** 非 dsh 命名空间的 peer 下界。 */
const OTHER_RANGES = {
  '@deepseek-ai/cordis': '>=4.0.5',
  '@deepseek-ai/schemastery': '>=3.18.5',
}

/** 唯一允许是 required 的 peer；其余 dsh-* 一律 optional（由 dsh 安装提供）。 */
const REQUIRED = new Set(['@deepseek-ai/cordis'])

/** 必须提供的 display 字典（zh 是集合的第二语言；en 是 readPluginMeta 的入口）。 */
const LOCALE_LANGUAGES = ['en', 'zh']

/** 宿主 `iconOf` 接受的扩展名与体积上限。 */
const ICON_EXTENSIONS = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp'])
const MAX_ICON_BYTES = 256 * 1024

/** 清单卡片文案的长度上限：防止再把整段 npm 描述当 description 用。 */
const MAX_TITLE_CHARS = 40
const MAX_DESCRIPTION_CHARS = 240

let failures = 0
const fail = (message) => {
  console.log(`  [!!] ${message}`)
  failures += 1
}

/**
 * 校验一个插件的 `locale/<lang>.json` 与顶层 `icon`。
 * @param {string} plugin 插件目录名
 * @param {object} manifest 已严格解析的 package.json
 * @param {Array<[string, string]>} declared 该插件要求的 (meta 字段, 值) 检查结果回填
 */
function checkDisplayMetadata(plugin, manifest, declared) {
  const exportsMap = manifest.exports ?? {}
  const files = Array.isArray(manifest.files) ? manifest.files : []
  declared.push([`${plugin}: exports 声明 "./package.json"`, exportsMap['./package.json'] === './package.json'])
  declared.push([`${plugin}: exports 声明 "./locale/*.json"`, exportsMap['./locale/*.json'] === './locale/*.json'])
  declared.push([`${plugin}: files 覆盖 "locale/*.json"`, files.includes('locale/*.json')])
  declared.push([`${plugin}: files 覆盖 "icon.svg"`, files.includes('icon.svg')])

  const icon = manifest.icon
  if (typeof icon !== 'string' || icon.trim() === '') {
    fail(`${plugin}: 缺少顶层 "icon"（显示元数据约定）`)
  } else {
    if (!icon.startsWith('./')) fail(`${plugin}: icon 必须是清单目录内的相对路径，实为 "${icon}"`)
    const extension = extname(icon).toLowerCase()
    if (!ICON_EXTENSIONS.has(extension)) {
      fail(`${plugin}: icon 只能是 SVG/PNG/JPEG/WebP，实为 "${extension}"`)
    }
    const iconPath = join(ROOT, plugin, icon)
    if (!existsSync(iconPath)) {
      fail(`${plugin}: icon 文件不存在：${icon}`)
    } else {
      const size = statSync(iconPath).size
      if (size === 0) fail(`${plugin}: icon 是空文件：${icon}`)
      if (size > MAX_ICON_BYTES) fail(`${plugin}: icon 超过 256 KiB（${size} B）`)
    }
  }

  const localeDir = join(ROOT, plugin, 'locale')
  if (!existsSync(localeDir)) {
    fail(`${plugin}: 缺少 locale/ 目录（显示元数据约定）`)
    return
  }
  const present = readdirSync(localeDir).filter((name) => name.endsWith('.json'))
  for (const language of LOCALE_LANGUAGES) {
    const file = `${language}.json`
    if (!present.includes(file)) {
      fail(`${plugin}: 缺少 locale/${file}`)
      continue
    }
    let parsed
    try {
      parsed = JSON.parse(readFileSync(join(localeDir, file), 'utf8'))
    } catch (error) {
      fail(`${plugin}/locale/${file} 不是合法 UTF-8 JSON：${error.message}`)
      continue
    }
    const meta = parsed?.meta
    const title = meta?.title
    const description = meta?.description
    declared.push([`${plugin}/locale/${file}: meta.title 非空`, typeof title === 'string' && title.trim() !== ''])
    declared.push([`${plugin}/locale/${file}: meta.description 非空`, typeof description === 'string' && description.trim() !== ''])
    if (typeof title === 'string' && title.length > MAX_TITLE_CHARS) {
      fail(`${plugin}/locale/${file}: meta.title 过长（${title.length} > ${MAX_TITLE_CHARS}）`)
    }
    if (typeof description === 'string' && description.length > MAX_DESCRIPTION_CHARS) {
      fail(`${plugin}/locale/${file}: meta.description 过长（${description.length} > ${MAX_DESCRIPTION_CHARS}）`)
    }
  }
  for (const name of present) {
    if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*\.json$/u.test(name)) {
      fail(`${plugin}/locale/${name}: 文件名必须是语言 id（宿主 dictionariesOf 会抛错）`)
    }
  }
}

for (const plugin of PLUGINS) {
  const raw = readFileSync(join(ROOT, plugin, 'package.json'), 'utf8')
  let manifest
  try {
    manifest = JSON.parse(raw)
  } catch (error) {
    fail(`${plugin}/package.json 不是合法 UTF-8 JSON：${error.message}`)
    continue
  }
  console.log(`${plugin.padEnd(20)} v${manifest.version}`)
  const peers = manifest.peerDependencies ?? {}
  const meta = manifest.peerDependenciesMeta ?? {}
  for (const [name, range] of Object.entries(peers)) {
    const expected = name.startsWith('@deepseek-ai/dsh-') ? DSH_BASELINE : OTHER_RANGES[name]
    const optional = meta[name]?.optional === true
    const okRange = expected === undefined ? true : range === expected
    const okOptional = REQUIRED.has(name) ? !optional : optional
    const mark = okRange && okOptional ? ' [OK]' : ' [!!]'
    console.log(`    ${name.padEnd(42)} ${range}${optional ? ' (optional)' : ''}${mark}`)
    if (!okRange) fail(`${plugin}: ${name} 应为 "${expected}"，实为 "${range}"`)
    if (!okOptional) fail(`${plugin}: ${name} 的 optional 应为 ${!REQUIRED.has(name)}`)
  }
  for (const stale of STALE) {
    if (raw.includes(stale)) fail(`${plugin}/package.json 仍残留旧基线字面量 ${stale}`)
  }
  const declared = []
  checkDisplayMetadata(plugin, manifest, declared)
  for (const [label, ok] of declared) {
    console.log(`    ${ok ? '[OK]' : '[!!]'} ${label}`)
    if (!ok) fail(label)
  }
  // 客户端半部的清单约定：platform 必须是 web，且 ./client 必须导出。
  const client = manifest.dsh?.client
  if (client !== undefined) {
    if (client.platform !== 'web') fail(`${plugin}: dsh.client.platform 必须是 "web"，实为 ${JSON.stringify(client.platform)}`)
    if (manifest.exports?.['./client'] === undefined) fail(`${plugin}: dsh.client 声明了客户端半部，却没有 "./client" 导出`)
    if (client.immediately === true) {
      console.log(`    [--] dsh.client.immediately=true（仅基础设施行应当如此，确认是有意的）`)
    }
  }
}

console.log('')
if (failures === 0) {
  console.log(`全部 ${PLUGINS.length} 个 manifest 干净：严格 JSON + peer 基线 + 显示元数据（locale/icon/导出）`)
} else {
  console.log(`${failures} 处失败`)
}
process.exit(failures === 0 ? 0 : 1)
