/** 回合自动记录：失败保留缓冲，只有明确 none 或动作落盘后才推进。 */
import { extractEventText } from './events.ts'
import { parseTags, slugify } from './store.ts'
import { GENERAL_SCOPE, resolveProjectScope } from './scope.ts'

const REVIEWABLE_KINDS = new Set(['completed'])
const MAX_MESSAGE_CHARS = 8_000
const MAX_BUFFER_MESSAGES = 50

const REVIEW_SYSTEM = [
  '你是项目记忆提取器。只输出严格 JSON，不要输出代码块或解释。',
  '格式：{"actions":[{"action":"create|update|delete","id":"更新/删除时必填","type":"user|feedback|project|reference","title":"创建时必填","content":"创建/更新正文","description":"一行索引说明","tags":["标签"]}]}。',
  '没有值得长期保存的信息时，必须明确输出 {"actions":[]}。',
  '只保存：用户画像、用户对工作方式的反馈、无法从代码或 Git 推断的项目决策/状态、外部系统或工具引用。',
  '不要保存：能从当前代码/Git/计划直接得到的信息、一次性调试过程、寒暄、临时任务清单。',
  '先检查已有记忆。相同主题优先 update；不要创建重复条目；只有明确过时且应移除时才 delete。',
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
    if (event.type === 'turn/end' && REVIEWABLE_KINDS.has(event.data?.reason?.kind)) {
      const count = (this.turnCounts.get(sessionId) ?? 0) + 1
      this.turnCounts.set(sessionId, count)
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
          content: action.content,
          description: action.description,
          type: action.type ?? 'reference',
          tags: Array.isArray(action.tags) ? action.tags.map(String) : parseTags(action.tags),
        }, { scope })
        continue
      }
      if (action.action === 'update') {
        const result = await this.store.update(action.id, { ...action, scopes: [scope] })
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
    const timeoutMs = Math.max(this.config.reviewTimeoutMs ?? 120_000, 1)
    // 0 = 无上限(不传 maxTokens,交给 provider 默认),>0 时手动限制
    const maxTokens = Number(this.config.reviewMaxTokens) > 0 ? Math.max(Number(this.config.reviewMaxTokens), 256) : 0

    const buildParams = (withReasoning, tokenCap) => {
      const params = {
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
      }
      if (tokenCap && tokenCap > 0) params.maxTokens = tokenCap
      if (withReasoning) params.reasoningEffort = 'off'
      return params
    }

    /** 单次完整流式调用(含 finish 终态检查)，失败抛 ReviewError。 */
    const runOnce = async (params) => {
      const controller = new AbortController()
      let timeout
      const timeoutPromise = new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort()
          reject(new ReviewError('REVIEW_TIMEOUT', `自动记录评审超过 ${timeoutMs}ms`))
        }, timeoutMs)
      })
      let iterator
      let done = false
      let terminal = false
      let text = ''
      let finish
      try {
        const stream = await Promise.race([llm.stream({ ...params, signal: controller.signal }), timeoutPromise])
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
      if (finish?.kind === 'error' || finish?.kind === 'aborted') {
        throw new ReviewError(finish.failure?.code ?? `LLM_${finish.kind.toUpperCase()}`, finish.failure?.message ?? `LLM ${finish.kind}`)
      }
      if (!finish) throw new ReviewError('LLM_NO_FINISH', '自动记录模型流结束但没有 finish 终态')
      if (!text.trim()) throw new ReviewError('REVIEW_EMPTY_OUTPUT', '自动记录模型没有返回文本')
      return { text, truncated: finish?.kind === 'max-tokens' }
    }

    /** 一次"发起+解析"尝试；输出被截断时先试解析，失败则(仅当设了有限上限)放大再试一次。 */
    const attempt = async (withReasoning, tokenCap) => {
      let first
      try {
        first = await runOnce(buildParams(withReasoning, tokenCap))
      } catch (error) {
        // 部分 provider 在省略 maxTokens(0) 时返回空输出 → 显式给大上限重试一次
        if (error?.code === 'REVIEW_EMPTY_OUTPUT' && !(tokenCap > 0)) {
          first = await runOnce(buildParams(withReasoning, 16384))
        } else {
          throw error
        }
      }
      if (!first.truncated) return parseReviewJson(first.text)
      try {
        return parseReviewJson(first.text)
      } catch {
        if (tokenCap > 0) {
          const retried = await runOnce(buildParams(withReasoning, tokenCap * 2))
          return parseReviewJson(retried.text)
        }
        throw new ReviewError('REVIEW_JSON_INVALID', '自动记录输出被 provider 截断且 JSON 不完整')
      }
    }

    let parsed
    try {
      parsed = await attempt(true, maxTokens)
    } catch (error) {
      // 部分 provider/model 不支持 reasoningEffort('off')，降级重试一次不带该参数
      if (/reasoning\s?effort/i.test(String(error?.message ?? ''))) {
        parsed = await attempt(false, maxTokens)
      } else {
        throw error
      }
    }
    return parsed
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
