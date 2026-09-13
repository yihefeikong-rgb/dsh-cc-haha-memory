/** 回合自动记录：失败保留缓冲，只有明确 none 或动作落盘后才推进。 */
import { extractEventText } from './events.ts'
import { parseTags, slugify } from './store.ts'
import { GENERAL_SCOPE, resolveProjectScope } from './scope.ts'

/** 只有终态 completed 的 turn/end 才算一个可用回合:error/max-tokens 等中断回合不进评审。 */
const REVIEWABLE_KINDS = new Set(['completed'])
/**
 * 记忆写工具名。主 agent 本回合调用过其中任一 → 本回合不再跑后台提取
 * (对齐上游 hasMemoryWritesSince 的自我写入互斥)。上游判据是"有没有写记忆文件",
 * 因此除本仓 tools.ts 里的写工具外,把隔壁 dsh-dream 注册的 `memory_dream`
 * (它同样会 create/update/delete 记忆文件)一并纳入。
 */
const MEMORY_WRITE_TOOLS = new Set(['memory_remember', 'memory_write', 'memory_update', 'memory_delete', 'memory_dream'])
const MAX_MESSAGE_CHARS = 8_000
const MAX_BUFFER_MESSAGES = 50

/**
 * 保存门(对齐 cc-haha v0.5.4 src/memdir/memoryTypes.ts:192-194，上游注明经评测验证：
 * memory-prompt-iteration case 3，0/2 → 3/3)。上游英文原文：
 *   These exclusions apply even when the user explicitly asks you to save. If they ask you to save a PR list
 *   or activity summary, ask what is *surprising* or *non-obvious* about it — that is the part worth keeping.
 * 即：排除项优先于用户的显式保存请求；显式保存请求要落到"意外/非显然"的部分，而不是原文搬运。
 */
const REVIEW_SYSTEM = [
  '你是项目记忆提取器。只输出严格 JSON，不要输出代码块或解释。',
  '格式：{"actions":[{"action":"create|update|delete","id":"更新/删除时必填","type":"user|feedback|project|reference","title":"创建时必填","content":"创建/更新正文","description":"一行索引说明","tags":["标签"]}]}。',
  '没有值得长期保存的信息时，必须明确输出 {"actions":[]}。',
  '记忆类型（严格四选一）：',
  '- user: 用户画像——用户的角色、目标、技能水平与协作偏好（工作方式/回复风格）',
  '- feedback: 行为反馈——用户对你工作方式的纠正或肯定；正文末尾必须含 "**Why:**" 与 "**How to apply:**" 两段',
  '- project: 无法从代码或 Git 推断的项目动态——谁在做什么、为什么、截止日期；相对日期（"昨天""周四"）必须转换为绝对日期（YYYY-MM-DD）',
  '- reference: 指向外部系统的指针——仪表板、工单系统、工具用法、外部资源位置',
  '必须保存：跨会话仍有价值的用户画像、行为反馈、项目决策/状态、外部系统与工具引用。',
  '不要保存：能从当前代码/Git/计划直接推断的信息、一次性调试过程、寒暄、临时任务清单、会话原文搬运。',
  '即使用户明确要求保存，上述排除项依然适用。',
  '若用户要求保存 PR 列表、活动流水这类内容，先问其中什么是意外/非显然的——那才是值得留下的部分。',
  '先检查已有记忆。相同主题优先 update；不要创建近似重复条目；只有明确过时且应移除时才 delete。更新时保留源文件中仍有效的内容。',
].join('\n')

export class ReviewError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ReviewError'
    this.code = code
  }
}

export class TurnRecorder {
  constructor(ctx, store, config) {
    this.ctx = ctx
    this.store = store
    this.config = config
    this.turnCounts = new Map()
    this.buffers = new Map()
    this.sessionCwds = new Map()
    this.agentWrote = new Set()
    this.inFlight = new Set()
    this.pending = new Set()
  }

  install() {
    this.ctx.on('session/event', (session, event) => this.handleEvent(session, event), { global: true })
    this.ctx.on('session/disposed', (session) => this.disposeSession(session?.id), { global: true })
    this.ctx.logger?.info?.('[dsh-memory] recorder installed')
  }

  handleEvent(session, event) {
    if (!event?.type || !session?.id) return
    const sessionId = session.id
    if (session.header?.cwd) this.sessionCwds.set(sessionId, session.header.cwd)

    if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
      this.pushMessage(sessionId, 'user', extractEventText(event.data))
      return
    }
    if (event.type === 'assistant/message') {
      this.pushMessage(sessionId, 'assistant', extractEventText(event.data))
      return
    }
    // 自我写入互斥(对齐上游 extractMemories.hasMemoryWritesSince):本回合主 agent 自己写过记忆 →
    // 本回合跳过 fork 出来的后台提取,并推进游标(见下方 turn/end 分支)。
    if (event.type === 'tool/call') {
      if (MEMORY_WRITE_TOOLS.has(event.data?.name)) this.agentWrote.add(sessionId)
      return
    }
    if (event.type === 'turn/end' && REVIEWABLE_KINDS.has(event.data?.reason?.kind)) {
      const count = (this.turnCounts.get(sessionId) ?? 0) + 1
      this.turnCounts.set(sessionId, count)
      // 计数照旧推进,保证"每 N 回合评审一次"的节奏不乱。
      // 主 agent 本回合自己写过记忆 → 跳过本次评审并清空缓冲(等价上游游标推进,这段不再被下次提取重复处理)。
      if (this.config.skipReviewAfterAgentWrite !== false && this.agentWrote.has(sessionId)) {
        this.agentWrote.delete(sessionId)
        this.buffers.delete(sessionId)
        this.ctx.logger?.info?.(`[dsh-memory] review skipped code=AGENT_WROTE_MEMORY session=${shortId(sessionId)}`)
        return
      }
      const interval = Math.max(this.config.reviewInterval ?? 5, 1)
      if (count % interval === 0) void this.maybeReview(sessionId)
    }
  }

  pushMessage(sessionId, role, text) {
    if (!text) return
    let buffer = this.buffers.get(sessionId)
    if (!buffer) {
      buffer = []
      this.buffers.set(sessionId, buffer)
    }
    buffer.push({ role, text: text.slice(0, MAX_MESSAGE_CHARS) })
    if (buffer.length > MAX_BUFFER_MESSAGES) buffer.splice(0, buffer.length - MAX_BUFFER_MESSAGES)
  }

  disposeSession(sessionId) {
    if (!sessionId) return
    this.turnCounts.delete(sessionId)
    this.buffers.delete(sessionId)
    this.sessionCwds.delete(sessionId)
    this.agentWrote.delete(sessionId)
    this.inFlight.delete(sessionId)
    this.pending.delete(sessionId)
  }

  async maybeReview(sessionId) {
    if (this.config.reviewEnabled === false) return { status: 'disabled' }
    if (this.inFlight.has(sessionId)) {
      this.pending.add(sessionId)
      return { status: 'coalesced' }
    }
    const buffer = this.buffers.get(sessionId)
    if (!buffer?.length) return { status: 'empty' }

    this.inFlight.add(sessionId)
    const snapshot = buffer.slice()
    const cwd = this.sessionCwds.get(sessionId)
      ?? this.ctx.agents?.get?.(sessionId)?.session?.header?.cwd
    const projectScope = resolveProjectScope(this.store.root, cwd)
    if (!projectScope) {
      buffer.splice(0, snapshot.length)
      this.ctx.logger?.warn?.(`[dsh-memory] review skipped code=PROJECT_SCOPE_UNRESOLVED session=${shortId(sessionId)}`)
      return { status: 'skipped', code: 'PROJECT_SCOPE_UNRESOLVED' }
    }
    const visibleScopes = projectScope === GENERAL_SCOPE ? [GENERAL_SCOPE] : [GENERAL_SCOPE, projectScope]
    try {
      const manifest = await this.store.manifest(visibleScopes)
      const review = await this.reviewWithLlm(sessionId, snapshot, manifest)
      await this.applyActions(review.actions, projectScope)
      buffer.splice(0, snapshot.length)
      this.ctx.logger?.info?.(`[dsh-memory] review ${review.actions.length ? `applied=${review.actions.length}` : 'none'} session=${shortId(sessionId)} scope=${projectScope}`)
      return { status: review.actions.length ? 'applied' : 'none', count: review.actions.length }
    } catch (error) {
      const code = error?.code ?? 'REVIEW_FAILED'
      this.ctx.logger?.warn?.(`[dsh-memory] review failed code=${code} session=${shortId(sessionId)} scope=${projectScope}: ${error instanceof Error ? error.message : String(error)}`)
      return { status: 'failed', code }
    } finally {
      this.inFlight.delete(sessionId)
      if (this.pending.delete(sessionId) && this.buffers.get(sessionId)?.length) {
        queueMicrotask(() => { void this.maybeReview(sessionId) })
      }
    }
  }

  async applyActions(actions, scope) {
    const prepared = []
    const createIds = new Set()
    for (const action of actions) {
      if (action.action === 'create') {
        const id = `${scope}/${slugify(action.title)}`
        if (createIds.has(id)) throw new ReviewError('DUPLICATE_ACTION', `同一批评审包含重复 create: ${id}`)
        createIds.add(id)
        const existing = await this.store.get(id, { scopes: [scope] })
        if (existing) {
          if (existing.content.trim() === String(action.content).trim()) continue
          throw new ReviewError('MEMORY_CONFLICT', `同主题记忆已存在，应改用 update: ${id}`)
        }
        prepared.push(action)
        continue
      }
      if (!action.id || !String(action.id).startsWith(`${scope}/`)) {
        throw new ReviewError('SCOPE_VIOLATION', `自动记录动作越出当前项目: ${action.id ?? '(missing id)'}`)
      }
      const existing = await this.store.get(action.id, { scopes: [scope] })
      if (!existing) throw new ReviewError('MEMORY_NOT_FOUND', `目标记忆不存在: ${action.id}`)
      prepared.push(action)
    }

    for (const action of prepared) {
      if (action.action === 'create') {
        await this.store.write({
          title: action.title,
          content: stripFrontmatter(action.content),
          description: action.description,
          type: action.type ?? 'reference',
          tags: Array.isArray(action.tags) ? action.tags.map(String) : parseTags(action.tags),
        }, { scope })
        continue
      }
      if (action.action === 'update') {
        const result = await this.store.update(action.id, { ...action, content: stripFrontmatter(action.content), scopes: [scope] })
        if (!result) throw new ReviewError('MEMORY_NOT_FOUND', `待更新记忆不存在: ${action.id}`)
      } else if (action.action === 'delete') {
        const removed = await this.store.remove(action.id, { scopes: [scope] })
        if (!removed) throw new ReviewError('MEMORY_NOT_FOUND', `待删除记忆不存在: ${action.id}`)
      }
    }
  }

  async reviewWithLlm(sessionId, buffer, manifest) {
    const llm = this.resolveLlm()
    if (!llm) throw new ReviewError('LLM_UNAVAILABLE', 'LLM 服务不可用')

    let provider = this.config.provider || undefined
    let model = this.config.model || undefined
    if (!provider || !model) {
      const agent = this.ctx.agents?.get?.(sessionId)
      provider = provider ?? agent?.options?.provider
      model = model ?? agent?.options?.model
    }
    if (!provider || !model) throw new ReviewError('MODEL_UNRESOLVED', '无法解析自动记录使用的 provider/model')
    provider = unwrapReviewProvider(provider)

    const transcript = buffer
      .map((message) => `${message.role === 'user' ? '用户' : '助手'}: ${message.text}`)
      .join('\n')
      .slice(0, 32_000)
    const existing = manifest.length
      ? manifest.map((item) => `- ${item.id} [${item.type}] ${item.title}${item.description ? ` — ${item.description}` : ''}`).join('\n')
      : '(当前作用域没有已有记忆)'
    const prompt = `已有记忆清单：\n${existing}\n\n待评审对话：\n${transcript}\n\n输出动作 JSON。`

    // 模型偶发空输出(空回复/推理吃满预算)时自动重试一次,再判定失败。
    let attempt = 0
    while (true) {
      const { text, finish } = await this.streamReview(llm, provider, model, prompt)
      if (finish?.kind === 'error' || finish?.kind === 'aborted') {
        throw new ReviewError(finish.failure?.code ?? `LLM_${finish.kind.toUpperCase()}`, finish.failure?.message ?? `LLM ${finish.kind}`)
      }
      if (!finish) throw new ReviewError('LLM_NO_FINISH', '自动记录模型流结束但没有 finish 终态')
      if (finish.kind === 'max-tokens') throw new ReviewError('LLM_MAX_TOKENS', '自动记录输出达到 token 上限，结果可能不完整')
      if (text.trim()) return parseReviewJson(text)
      attempt++
      if (attempt >= 2) throw new ReviewError('LLM_EMPTY_OUTPUT', '自动记录模型没有返回文本')
    }
  }

  /** 单次评审流读取:超时/提前结束都释放迭代器,返回 { text, finish }。 */
  async streamReview(llm, provider, model, prompt) {
    const controller = new AbortController()
    const timeoutMs = Math.max(this.config.reviewTimeoutMs ?? 120_000, 1)
    const maxTokens = this.config.reviewMaxTokens ?? 1_000
    let timeout
    let iterator
    let done = false
    let terminal = false
    let text = ''
    let finish
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort()
        reject(new ReviewError('REVIEW_TIMEOUT', `自动记录评审超过 ${timeoutMs}ms`))
      }, timeoutMs)
    })
    try {
      const stream = await Promise.race([llm.stream({
        provider,
        model,
        system: REVIEW_SYSTEM,
        messages: [{
          id: crypto.randomUUID(),
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: prompt }],
        }],
        temperature: 0,
        reasoningEffort: 'off',
        maxTokens,
        signal: controller.signal,
      }), timeoutPromise])
      iterator = stream[Symbol.asyncIterator]()
      while (true) {
        const step = await Promise.race([iterator.next(), timeoutPromise])
        if (step.done) { done = true; break }
        const chunk = step.value
        if (chunk?.type === 'text-delta') text += chunk.text ?? ''
        if (chunk?.type === 'finish') {
          finish = chunk.reason
          terminal = true
          break
        }
      }
    } finally {
      if (timeout) clearTimeout(timeout)
      if (!done) {
        if (!terminal) controller.abort()
        try { void iterator?.return?.() } catch { /* 释放失败不覆盖原错误 */ }
      }
    }

    return { text, finish }
  }

  resolveLlm() {
    const root = this.ctx.get?.('root') ?? this.ctx.root
    return root?.get?.('llm') ?? this.ctx.get?.('llm') ?? this.ctx.llm ?? null
  }
}

/** 纯文本后台评审绕过 modlens 视觉包装，避免包装器再次嵌套 llm.stream。 */
export function unwrapReviewProvider(provider) {
  if (provider === 'deepseek-modlens') return 'deepseek-official'
  return String(provider).startsWith('modlens-') ? String(provider).slice('modlens-'.length) : provider
}

export function parseReviewJson(text) {
  const cleaned = String(text ?? '').replace(/```(?:json)?\s*/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end < start) throw new ReviewError('INVALID_JSON', '自动记录输出中没有 JSON 对象')
  let parsed
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    throw new ReviewError('INVALID_JSON', '自动记录输出不是有效 JSON')
  }
  if (Array.isArray(parsed.memories)) {
    return { actions: parsed.memories.map((memory) => ({ action: 'create', ...memory })) }
  }
  if (!Array.isArray(parsed.actions)) throw new ReviewError('INVALID_SCHEMA', '自动记录输出缺少 actions 数组')
  const actions = parsed.actions.map(validateAction)
  return { actions }
}

/** 剥离模型输出中误带的 frontmatter 块(落盘时由 store 重新序列化)。 */
function stripFrontmatter(text) {
  const s = String(text ?? '')
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(s)
  return m ? s.slice(m[0].length) : s
}

function validateAction(action) {
  if (!action || !['create', 'update', 'delete'].includes(action.action)) {
    throw new ReviewError('INVALID_ACTION', `未知自动记录动作: ${action?.action}`)
  }
  if (action.action === 'create' && (!action.title || !action.content)) {
    throw new ReviewError('INVALID_ACTION', 'create 动作缺少 title/content')
  }
  if (action.action !== 'create' && !action.id) {
    throw new ReviewError('INVALID_ACTION', `${action.action} 动作缺少 id`)
  }
  return action
}

function shortId(value) {
  return String(value ?? '').slice(0, 8)
}
