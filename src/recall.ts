/**
 * 严格作用域召回：只注入通用 + 当前项目索引，并按当前查询选择最多 5 条正文。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { extractEventText } from './events.ts'
import { parseFrontmatter } from './store.ts'
import { scopesForCwd } from './scope.ts'

const MAX_INDEX_LINES = 200
const DEFAULT_INDEX_BYTES = 25_000
const DEFAULT_RELEVANT_BYTES = 16_000
const IGNORE_MEMORY = /(?:本次|本轮|这次)?.{0,4}(?:忽略|不要使用|不用|别用).{0,4}记忆|从零开始/u
const EXPLICIT_REMEMBER = /(?:请|帮我|一定要|务必)?(?:记住|记一下|记下来|保存到记忆|以后(?:都|统一|一直).{0,12}(?:按|用|是|不要|别))/u

export function installRecall(ctx, store, config) {
  const latestQueries = new Map()
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'user/message' || event.data?.source?.kind !== 'user') return
    const text = extractEventText(event.data)
    if (text && session?.id) {
      latestQueries.set(session.id, text)
      if (latestQueries.size > 500) latestQueries.delete(latestQueries.keys().next().value)
      if (EXPLICIT_REMEMBER.test(text)) appendRememberGuide(ctx, store, session, event)
    }
  }, { global: true })

  const memoryContext = (context) => {
    const session = context?.agent?.session
    const cwd = session?.header?.cwd
    const query = latestQueries.get(session?.id) ?? ''
    return recallText(store, config, cwd, query) || undefined
  }
  ctx.systemPrompt.context({ name: 'memory:index', order: config.recallOrder ?? 117, text: memoryContext })

  // Router Standard 会有意清空普通 contexts。该外层 waterfall 在所有预设
  // 过滤完成后恢复严格作用域记忆，既不改变首轮工具目录，也不破坏完整 persona。
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const text = memoryContext(context)
    if (!text) return assembled
    return {
      ...assembled,
      contexts: [
        ...assembled.contexts.filter((item) => item.name !== 'memory:index'),
        { name: 'memory:index', text },
      ],
    }
  }, { global: true, prepend: true })
  ctx.logger?.info?.('[dsh-memory] recall injector installed')
}

function appendRememberGuide(ctx, store, session, event) {
  const fromRegistry = ctx.agents?.get?.(session.id)
  const fromScope = ctx.get?.('agent')
  const agent = fromRegistry ?? (fromScope?.session === session || fromScope?.session?.id === session.id ? fromScope : null)
  if (!agent?.inbox?.append) return
  const indexPath = join(store.root, 'MEMORY.md')
  try {
    agent.inbox.append('next-step', {
      id: `dsh-memory-guide-${event.data?.id ?? event.seq ?? Date.now()}`,
      role: 'user',
      source: { kind: 'plugin', plugin: 'dsh-memory', form: 'notice', summary: '显式记忆写入规则' },
      content: [{
        type: 'text',
        text: `记忆规则：用户明确要求长期记住。现在不要只用文字声称已记住。若 memory_remember 尚未出现在首轮工具中，先用 read 读取记忆索引 ${indexPath}；首次真实工具调用后完整工具目录会展开。随后必须调用 memory_remember，将内容保存为当前项目的独立记忆文件。只有工具返回 saved=true 后才能确认“已记住”；失败时明确说明未保存成功。`,
      }],
    })
  } catch { /* 会话重放或重复 id 不应阻塞正常对话 */ }
}

export function scopedDirs(store, cwd) {
  return scopesForCwd(store.root, cwd)
}

export function recallText(store, config, cwd, query = '') {
  if (IGNORE_MEMORY.test(String(query))) {
    return '# 本轮已忽略记忆\n\n用户要求本轮不使用历史记忆；不要依据记忆内容作答。'
  }

  const dirs = scopedDirs(store, cwd)
  const entries = readScopedEntries(store.root, dirs)

  const lines = []
  for (const dir of dirs) {
    const scoped = entries.filter((entry) => entry.scope === dir)
    if (scoped.length === 0) continue
    lines.push(`## ${dir}`, '')
    for (const memory of scoped) {
      lines.push(`- [${memory.name}](${memory.rel})${memory.description ? ` — ${memory.description}` : ''}`)
    }
    lines.push('')
  }

  const maxIndexBytes = config.recallMaxBytes ?? DEFAULT_INDEX_BYTES
  const head = [
    '# 记忆索引（仅通用 + 当前项目）',
    '',
    `记忆索引文件：${join(store.root, 'MEMORY.md')}`,
    '当前用户指令优先于历史记忆；项目记忆优先于通用记忆。需要更多内容时使用 memory_search/memory_read。',
    '用户明确说“记住”时，必须产生真实记忆工具调用，不能只用文字确认。若首轮 memory_remember 尚未暴露，先用 read 读取上述索引文件以触发完整工具目录；已有同主题时把索引中的 id 传给 memory_remember 更新，否则新建独立文件。只有工具返回 saved=true 才能说已记住。',
    '用户要求忘记时，先搜索并确认目标，再使用 memory_delete。不要把当前计划、可从代码/Git 推断的信息或一次性调试过程写入长期记忆。',
    '',
  ].join('\n')
  const index = truncateLines(lines, Math.max(maxIndexBytes - Buffer.byteLength(head), 0))
  const relevant = selectRelevant(entries, query, 5)
  const detail = renderRelevant(relevant, config.recallRelevantMaxBytes ?? DEFAULT_RELEVANT_BYTES)
  return head + index + detail
}

function readScopedEntries(root, dirs) {
  const entries = []
  for (const scope of dirs) {
    readDir(join(root, scope), scope, scope, entries)
  }
  return entries
}

function readDir(dir, scope, relBase, entries) {
  let files = []
  try { files = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const file of files) {
    if (file.name.startsWith('.')) continue
    const abs = join(dir, file.name)
    const rel = `${relBase}/${file.name}`
    if (file.isDirectory()) {
      readDir(abs, scope, rel, entries)
      continue
    }
    if (!file.isFile() || !file.name.endsWith('.md') || file.name === 'MEMORY.md') continue
    try {
      const raw = readFileSync(abs, 'utf8')
      const { meta, body } = parseFrontmatter(raw)
      const info = statSync(abs)
      entries.push({
        scope,
        rel,
        name: meta.name ?? file.name.replace(/\.md$/, ''),
        description: meta.description ?? '',
        type: meta.type ?? 'reference',
        updated: meta.updated ?? meta.created ?? info.mtime.toISOString(),
        body: body.trim(),
      })
    } catch { /* 单个损坏文件不阻塞其他记忆召回 */ }
  }
}

export function selectRelevant(entries, query, limit = 5) {
  const terms = queryTerms(query)
  if (terms.length === 0) return []
  const scored = []
  for (const entry of entries) {
    const title = entry.name.toLowerCase()
    const description = entry.description.toLowerCase()
    const body = entry.body.toLowerCase().slice(0, 8000)
    let score = entry.scope === '通用' ? 0 : 2
    let hits = 0
    for (const term of terms) {
      let hit = false
      if (title.includes(term)) { score += 8; hit = true }
      if (description.includes(term)) { score += 4; hit = true }
      if (body.includes(term)) { score += 1; hit = true }
      if (hit) hits++
    }
    if (hits > 0) scored.push({ ...entry, score: score + hits })
  }
  scored.sort((a, b) => b.score - a.score || Date.parse(b.updated || 0) - Date.parse(a.updated || 0))
  return scored.slice(0, Math.max(0, limit))
}

function queryTerms(query) {
  const text = String(query ?? '').toLowerCase().trim()
  if (!text) return []
  const terms = new Set(text.match(/[a-z0-9_.+#-]{2,}|[\p{Script=Han}]{2,}/gu) ?? [])
  for (const run of text.match(/[\p{Script=Han}]{3,}/gu) ?? []) {
    for (let index = 0; index < run.length - 1; index++) terms.add(run.slice(index, index + 2))
  }
  return [...terms].slice(0, 24)
}

function renderRelevant(entries, maxBytes) {
  if (entries.length === 0 || maxBytes <= 0) return ''
  const lines = ['', '# 与当前问题相关的记忆正文', '']
  for (const entry of entries) {
    lines.push(`## ${entry.name}（${entry.scope}）`)
    const age = memoryAgeDays(entry.updated)
    if (age > 1 && (entry.type === 'project' || entry.type === 'reference')) {
      lines.push(`> 此记忆约 ${age} 天前更新，可能已经过时；引用路径、版本或状态前必须重新核验。`)
    }
    lines.push(entry.body, '')
  }
  return truncateByBytes(lines.join('\n'), maxBytes)
}

function memoryAgeDays(value) {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return 0
  return Math.floor(Math.max(0, Date.now() - timestamp) / 86_400_000)
}

function truncateLines(lines, maxBytes) {
  const selected = []
  let bytes = 0
  let truncated = false
  for (const line of lines.slice(0, MAX_INDEX_LINES)) {
    const next = Buffer.byteLength(`${line}\n`)
    if (bytes + next > maxBytes) { truncated = true; break }
    selected.push(line)
    bytes += next
  }
  if (lines.length > MAX_INDEX_LINES) truncated = true
  if (truncated) selected.push('', '> WARNING：记忆索引超过 200 行或 25KB，已截断；请使用 memory_search 检索完整内容。', '')
  return selected.join('\n')
}

function truncateByBytes(text, maxBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return text
  let output = ''
  for (const line of text.split('\n')) {
    if (Buffer.byteLength(`${output}${line}\n`) > maxBytes) break
    output += `${line}\n`
  }
  return `${output}> 相关记忆正文已截断；需要时使用 memory_read 读取完整内容。\n`
}
