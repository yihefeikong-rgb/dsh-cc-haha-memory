/**
 * 严格作用域召回：只注入通用 + 当前项目索引，并按当前查询选择最多 5 条正文。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { extractEventText } from './events.ts'
import { parseFrontmatter, TYPE_ORDER } from './store.ts'
import { scopesForCwd } from './scope.ts'

const MAX_INDEX_LINES = 200
const DEFAULT_INDEX_BYTES = 25_000
const DEFAULT_RELEVANT_BYTES = 16_000
const IGNORE_MEMORY = /(?:本次|本轮|这次)?.{0,4}(?:忽略|不要使用|不用|别用).{0,4}记忆|从零开始/u
const EXPLICIT_REMEMBER = /(?:请|帮我|一定要|务必)?(?:记住|记一下|记下来|保存到记忆|以后(?:都|统一|一直).{0,12}(?:按|用|是|不要|别))/u

/** 作用域内记忆文件列表的合并窗口(ms):同一 assemble 内多处读取复用同一次结果。 */
const ENTRY_CACHE_TTL_MS = 1000
/** 本会话"相关正文"累计注入上限(字节)。对齐上游 cc-haha 的 MAX_SESSION_BYTES=60KB。 */
const DEFAULT_SESSION_BYTES = 60 * 1024

/**
 * 记忆使用指南(静态)。放在系统提示词的稳定 section 里,而不是每轮重新注入的尾部
 * 快照——上游把"怎么用记忆"的规则放在 system prompt 的 memory section,内容不变
 * 就能命中前缀缓存,不产生每轮开销。
 * 上游原文(commit d52bbec7):
 *   src/memdir/memoryTypes.ts:240-256 TRUSTING_RECALL_SECTION
 *     "A memory that names a specific function, file, or flag is a claim that it existed
 *      *when the memory was written*... If the memory names a file path: check the file
 *      exists. If the memory names a function or flag: grep for it. If the user is about to
 *      act on your recommendation ... verify first. 'The memory says X exists' is not the
 *      same as 'X exists now.'"
 *   src/memdir/memoryTypes.ts:201-202 MEMORY_DRIFT_CAVEAT
 *     "Memory records can become stale over time... If a recalled memory conflicts with
 *      current information, trust what you observe now — and update or remove the stale
 *      memory rather than acting on it."
 */
const MEMORY_USAGE_GUIDANCE = [
  '## 引用记忆前的核验',
  '',
  '记忆里提到某个函数、文件或开关，只代表**写下那条记忆时**它存在：它可能已被改名、删除，或从未合入。据此给出建议之前：',
  '',
  '- 记忆里给了文件路径 → 先确认该文件存在。',
  '- 记忆里给了函数名或开关 → 先 grep 一遍。',
  '- 用户准备照着你的建议动手（而不只是问历史）→ 先验证再答。',
  '',
  '「记忆说 X 存在」不等于「X 现在存在」。',
  '',
  '- 记忆会随时间过时：把它当成"某个时间点为真"的上下文；仅凭记忆作答或建立假设前，先读当前文件/资源的实际状态核实。',
  '- 记忆与现状冲突时，以你现在观察到的为准——并顺手更新或删除那条过期记忆，而不是照着它行动。',
  '- 记忆只是仓库状态的快照（活动记录、架构快照）时，若用户问的是近期/当前状态，优先 `git log` 或直接读代码。',
].join('\n')

export function installRecall(ctx, store, config) {
  const latestQueries = new Map()
  // 本会话最近调用过的工具名(最近在前、去重)。传给相关性选择器用——上游
  // findRelevantMemories 的提示词会让模型避开"正在使用的工具"的用法/API 文档类记忆。
  const recentToolsBySession = new Map()
  const toolsWindow = Math.max(0, Number(config.recentToolsWindow ?? 8))
  ctx.on('session/event', (session, event) => {
    if (event?.type === 'tool/call' && session?.id) {
      const name = typeof event.data?.name === 'string' ? event.data.name : ''
      if (name && toolsWindow > 0) {
        const list = recentToolsBySession.get(session.id) ?? []
        recentToolsBySession.set(session.id, [name, ...list.filter((item) => item !== name)].slice(0, toolsWindow))
        if (recentToolsBySession.size > 500) recentToolsBySession.delete(recentToolsBySession.keys().next().value)
      }
      return
    }
    if (event?.type !== 'user/message' || event.data?.source?.kind !== 'user') return
    const text = extractEventText(event.data)
    if (text && session?.id) {
      latestQueries.set(session.id, text)
      if (latestQueries.size > 500) latestQueries.delete(latestQueries.keys().next().value)
      if (EXPLICIT_REMEMBER.test(text)) appendRememberGuide(ctx, store, session, event)
    }
  }, { global: true })

  // 静态使用指南进系统提示词 section(与上游一致);旧宿主没有 section() 时静默跳过。
  if (config.guidanceEnabled !== false) {
    try {
      ctx.systemPrompt?.section?.({ name: 'memory:usage', order: Number(config.guidanceOrder ?? 118), text: MEMORY_USAGE_GUIDANCE })
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-memory] 使用指南 section 注册失败(已忽略): ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 作用域内全部记忆文件。原本注册回调、assemble hook、语义选择器各读一次全量
  // (本机 170 个 .md × 3 次/步),这里用 1s TTL 合并成 1 次。窗口内索引最多滞后
  // 一步,对记忆目录这种写频率极低的场景可接受。
  let entryCache = { key: '', at: 0, entries: [] }
  const cachedEntries = (cwd) => {
    const key = `${store.root}|${cwd ?? ''}`
    if (entryCache.key === key && Date.now() - entryCache.at < ENTRY_CACHE_TTL_MS) return entryCache.entries
    const entries = readScopedEntries(store.root, scopedDirs(store, cwd))
    entryCache = { key, at: Date.now(), entries }
    return entries
  }

  // 本会话已注入过的记忆正文路径 + 已用字节数。对齐上游 cc-haha 的
  // alreadySurfaced + MAX_SESSION_BYTES:每条正文只在首次命中时注入,整会话累计
  // 到预算后只保留索引,避免长会话每轮把同样的正文重灌进上下文。
  const sessionState = new Map()
  const stateFor = (sessionId) => {
    const key = String(sessionId ?? '')
    let state = sessionState.get(key)
    if (!state) {
      state = { paths: new Set(), bytes: 0, decision: null }
      sessionState.set(key, state)
      if (sessionState.size > 200) sessionState.delete(sessionState.keys().next().value)
    }
    return state
  }

  // 注册回调只产出索引(正文统一由下面的 assemble hook 产出并记账),避免同一份
  // 内容被两处重复生成;hook 若被某种预设整体清空 contexts,至少索引仍在。
  const memoryContext = (context) => {
    const session = context?.agent?.session
    const cwd = session?.header?.cwd
    const query = latestQueries.get(session?.id) ?? ''
    return buildRecallBundle(store, config, cwd, query, cachedEntries(cwd), [], 0).text || undefined
  }
  ctx.systemPrompt.context({ name: 'memory:index', order: config.recallOrder ?? 117, text: memoryContext })

  // 语义相关性选择(对齐 Claude Code findRelevantMemories 的 LLM 选择):
  // 组装阶段异步用 LLM 从候选清单中挑选 ≤5 条最相关的记忆正文注入;
  // 按 (sessionId, query) 缓存,同一查询不重复调用;失败/超时回落关键词评分。
  const selectionCache = new Map()
  const selectRelevantAsync = async (context, entries) => {
    if (config.selectEnabled === false) return null
    const session = context?.agent?.session
    const query = latestQueries.get(session?.id) ?? ''
    if (entries.length <= 5 || !query) return null
    // 上游 findRelevantMemories 会把"最近使用过的工具"一并交给选择器(默认开启)。
    const tools = config.recentToolsEnabled === false
      ? []
      : (recentToolsBySession.get(session?.id) ?? [])
    const cacheKey = `${session?.id ?? ''}|${query}|${entries.length}|${entries[0]?.updated ?? ''}|${tools.join(',')}`
    if (selectionCache.has(cacheKey)) return selectionCache.get(cacheKey)
    const promise = selectRelevantByLlm(ctx, config, context, entries, query, 5, tools)
      .then((picked) => picked ?? null)
      .catch(() => null)
    selectionCache.set(cacheKey, promise)
    if (selectionCache.size > 200) selectionCache.delete(selectionCache.keys().next().value)
    return promise
  }

  // Router Standard 会有意清空普通 contexts。该外层 waterfall 在所有预设
  // 过滤完成后恢复严格作用域记忆，既不改变首轮工具目录，也不破坏完整 persona。
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const session = context?.agent?.session
    const cwd = session?.header?.cwd
    const query = latestQueries.get(session?.id) ?? ''
    const entries = cachedEntries(cwd)
    const state = stateFor(session?.id)
    const dedupe = config.dedupeRelevant !== false
    const sessionMax = Number(config.sessionMaxBytes ?? DEFAULT_SESSION_BYTES)
    const budgetLeft = sessionMax <= 0 ? Number.POSITIVE_INFINITY : Math.max(0, sessionMax - state.bytes)
    // 一个用户回合内有多个 step,每个 step 都会重新 assemble。若每次都重新挑一批
    // 正文,快照文本每步都变 → harness 每步都追加一次 runtime context 注入(实测
    // 6 步连注 6 次、把 60KB 预算在一步之内烧完)。因此按 (会话, 当前查询) 记住
    // 本回合的选择并原样复用: 同一查询下文本逐字节一致,harness 不会再追加,
    // 模型仍能从历史里看到上一份快照。对齐上游「每个用户回合只预取一次」。
    const reused = state.decision && state.decision.query === query ? state.decision : null
    let pick
    let bodyMax
    if (reused) {
      // 必须按上次的**相关度顺序**还原(顺序不同会让文本逐字节变化),
      // 并且复用原始 pick 而不是 only-included:预算截断到"一条都没进正文"时,
      // 只有用原始 pick 才能复现出同样的截断提示,文本才真正逐字节一致。
      const byRel = new Map(entries.map((entry) => [entry.rel, entry]))
      pick = reused.picked.map((rel) => byRel.get(rel)).filter(Boolean)
      bodyMax = reused.bodyMax
    } else {
      // 已注入过的记忆不再作为候选(选择器也因此不会在 5 个名额上重复挑旧条目)。
      const candidates = dedupe ? entries.filter((entry) => !state.paths.has(entry.rel)) : entries
      pick = candidates.length ? selectRelevant(candidates, query, 5) : []
      const llmPick = await selectRelevantAsync(context, candidates)
      if (llmPick && llmPick.length > 0) pick = llmPick
      bodyMax = Math.min(Number(config.recallRelevantMaxBytes ?? DEFAULT_RELEVANT_BYTES), budgetLeft)
    }
    const bundle = buildRecallBundle(store, config, cwd, query, entries, pick, bodyMax)
    if (!bundle.text) return assembled
    if (!reused) {
      if (dedupe) {
        for (const rel of bundle.included) state.paths.add(rel)
        state.bytes += bundle.bodyBytes
      }
      state.decision = { query, picked: pick.map((entry) => entry.rel), rels: bundle.included, bodyMax }
    }
    return {
      ...assembled,
      contexts: [
        ...assembled.contexts.filter((item) => item.name !== 'memory:index'),
        { name: 'memory:index', text: bundle.text },
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
  if (IGNORE_MEMORY.test(String(query))) return ignoreMemoryText()

  const dirs = scopedDirs(store, cwd)
  const entries = readScopedEntries(store.root, dirs)
  const relevant = selectRelevant(entries, query, 5)
  return buildRecallBundle(store, config, cwd, query, entries, relevant).text
}

function ignoreMemoryText() {
  return '# 本轮已忽略记忆\n\n用户要求本轮不使用历史记忆；不要依据记忆内容作答。'
}

export function buildRecallText(store, config, cwd, query, entries, relevant, relevantMaxBytes) {
  return buildRecallBundle(store, config, cwd, query, entries, relevant, relevantMaxBytes).text
}

/**
 * 组装记忆文本并返回记账信息:
 *   text      = 规则头 + 索引 + 相关正文
 *   bodyBytes = 实际注入的"相关正文"字节数(计入会话预算)
 *   included  = 正文确实进入文本的记忆路径(计入会话内去重)
 */
function buildRecallBundle(store, config, cwd, query, entries, relevant, relevantMaxBytes) {
  if (IGNORE_MEMORY.test(String(query))) {
    return { text: ignoreMemoryText(), bodyBytes: 0, included: [] }
  }

  const dirs = scopedDirs(store, cwd)
  const lines = []
  for (const dir of dirs) {
    const scoped = entries.filter((entry) => entry.scope === dir)
    if (scoped.length === 0) continue
    lines.push(`## ${dir}`, '')
    for (const [type, label] of TYPE_ORDER) {
      const typed = scoped.filter((entry) => (entry.type ?? 'reference') === type)
      if (!typed.length) continue
      lines.push(`### ${label}`, '')
      for (const memory of typed) {
        lines.push(`- [${memory.name}](${memory.rel})${memory.description ? ` — ${memory.description}` : ''}`)
      }
      lines.push('')
    }
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
  const detail = renderRelevant(relevant ?? [], relevantMaxBytes ?? config.recallRelevantMaxBytes ?? DEFAULT_RELEVANT_BYTES)
  return { text: head + index + detail.text, bodyBytes: detail.bytes, included: detail.included }
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

/**
 * LLM 语义相关性选择(对齐 Claude Code findRelevantMemories):
 * 让模型从候选清单(title+description)中挑选与当前查询最相关的 ≤limit 条记忆,
 * 结果经白名单过滤防幻觉;任何异常由调用方回落关键词评分。
 */
const SELECT_SYSTEM = [
  '你是记忆相关性选择器。根据用户当前查询，从候选记忆清单中挑选最相关的记忆条目。',
  '只输出严格 JSON 数组，元素是候选条目的 id 字符串，例如 ["逆向/box_analysis"]。',
  '最多挑 5 条；不相关的查询允许输出空数组 []。不要输出任何解释或代码块。',
  '优先选择能直接帮助回答当前查询的记忆；项目记忆优先于通用记忆；与查询无关的不要选。',
  // 以下两条对齐上游 cc-haha 的选择器提示词(commit d52bbec7,
  // src/memdir/findRelevantMemories.ts:18-24)。上游用 json_schema 强制结构化输出,
  // DSH 的 llm.stream 没有 output_format,因此改为把同一约束写进提示词。
  '只挑你有把握确实有帮助的条目；不确定就不要挑，宁可返回空数组——要挑剔、要有判断力。',
  '若给出了「最近使用过的工具」：不要挑这些工具的用法/API 参考类记忆（对话里已经在用了）；但要挑包含**坑、警告、已知问题**的此类记忆。',
].join('\n')

async function selectRelevantByLlm(ctx, config, context, entries, query, limit = 5, recentTools = []) {
  const llm = ctx.get?.('root')?.get?.('llm') ?? ctx.get?.('llm') ?? ctx.llm
  if (!llm?.stream) return null
  const sessionId = context?.agent?.session?.id
  let provider = config.selectProvider || config.provider || undefined
  let model = config.selectModel || config.model || undefined
  if (!provider || !model) {
    const agent = sessionId ? ctx.agents?.get?.(sessionId) : null
    provider = provider ?? agent?.options?.provider ?? context?.agent?.options?.provider
    model = model ?? agent?.options?.model ?? context?.agent?.options?.model
  }
  if (!provider || !model) return null

  const manifest = entries
    .map((e) => `- ${e.rel} [${e.type ?? 'reference'}] ${e.name}${e.description ? ` — ${e.description}` : ''}`)
    .join('\n')
  const toolsSection = Array.isArray(recentTools) && recentTools.length > 0
    ? `\n\n最近使用过的工具：${recentTools.join(', ')}`
    : ''
  const prompt = `候选记忆清单：\n${manifest}\n\n当前用户查询：\n${query}${toolsSection}\n\n输出相关记忆 id 的 JSON 数组。`
  const controller = new AbortController()
  const timeoutMs = Math.max(Number(config.selectTimeoutMs) > 0 ? Number(config.selectTimeoutMs) : 12_000, 2_000)
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  let text = ''
  try {
    const stream = await llm.stream({
      provider,
      model,
      system: SELECT_SYSTEM,
      messages: [{
        id: crypto.randomUUID(),
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: prompt }],
      }],
      temperature: 0,
      reasoningEffort: 'off',
      maxTokens: 256,
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta') text += chunk.text ?? ''
    }
  } finally {
    clearTimeout(timeout)
  }
  if (!text.trim()) return null
  let ids = []
  try {
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    const start = cleaned.indexOf('[')
    const end = cleaned.lastIndexOf(']')
    const parsed = JSON.parse(start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned)
    if (Array.isArray(parsed)) ids = parsed.map(String)
  } catch {
    return null
  }
  // 白名单过滤防幻觉:只保留真实存在的条目
  const byId = new Map(entries.map((e) => [e.rel.replace(/\.md$/i, ''), e]))
  const picked = []
  for (const id of ids) {
    const normalized = String(id).replace(/\\/g, '/').replace(/\.md$/i, '')
    const entry = byId.get(normalized) ?? entries.find((e) => e.rel.replace(/\.md$/i, '') === normalized || e.rel.endsWith(`/${normalized}.md`))
    if (entry && !picked.includes(entry)) picked.push(entry)
    if (picked.length >= limit) break
  }
  return picked
}

function renderRelevant(entries, maxBytes) {
  if (entries.length === 0 || maxBytes <= 0) return { text: '', bytes: 0, included: [] }
  const lines = ['', '# 与当前问题相关的记忆正文', '']
  for (const entry of entries) {
    lines.push(`## ${entry.name}（${entry.scope}）`)
    const age = memoryAgeDays(entry.updated)
    if (age > 1 && (entry.type === 'project' || entry.type === 'reference')) {
      lines.push(`> 此记忆约 ${age} 天前更新，可能已经过时；引用路径、版本或状态前必须重新核验。`)
    }
    lines.push(entry.body, '')
  }
  const text = truncateByBytes(lines.join('\n'), maxBytes)
  // 只有标题行确实进了文本的记忆才算"已注入"(被截断掉的仍可后续再选)。
  const included = []
  for (const entry of entries) {
    if (text.includes(`## ${entry.name}（${entry.scope}）`)) included.push(entry.rel)
  }
  return { text, bytes: Buffer.byteLength(text), included }
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
