import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { extractEventText } from '../src/events.ts'
import { TurnRecorder, parseReviewJson, unwrapReviewProvider } from '../src/recorder.ts'
import { MemoryStore } from '../src/store.ts'

function streamOf(chunks) {
  return { async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk } }
}

async function fixture(chunks, fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-recorder-'))
  const memory = join(root, 'memory')
  const repo = join(root, 'demo')
  await mkdir(join(repo, '.git'), { recursive: true })
  const warnings = []
  const infos = []
  const calls = []
  const llm = { async stream(options) { calls.push(options); return typeof chunks === 'function' ? chunks() : streamOf(chunks) } }
  const agent = { options: { provider: 'test', model: 'memory-model' }, session: { header: { cwd: repo } } }
  const ctx = {
    agents: { get: () => agent },
    get: (name) => name === 'root' ? { get: (service) => service === 'llm' ? llm : null } : null,
    logger: { info(message) { infos.push(message) }, warn(message) { warnings.push(message) } },
  }
  try {
    await fn({ recorder: new TurnRecorder(ctx, new MemoryStore(memory), { reviewInterval: 1, reviewTimeoutMs: 2_000 }), memory, repo, warnings, infos, calls })
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 })
  }
}

async function hangingFixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-recorder-timeout-'))
  const repo = join(root, 'demo')
  await mkdir(join(repo, '.git'), { recursive: true })
  const llm = { stream() { return new Promise(() => {}) } }
  const agent = { options: { provider: 'test', model: 'memory-model' }, session: { header: { cwd: repo } } }
  const ctx = {
    agents: { get: () => agent },
    get: (name) => name === 'root' ? { get: () => llm } : null,
    logger: { info() {}, warn() {} },
  }
  try {
    await fn({ recorder: new TurnRecorder(ctx, new MemoryStore(join(root, 'memory')), { reviewTimeoutMs: 20 }), repo })
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 })
  }
}

test('提取嵌套 assistant/message 文本', () => {
  const text = extractEventText({ message: { content: [{ type: 'text', text: '助手正文' }] } })
  assert.equal(text, '助手正文')
})

test('严格解析 actions 与兼容 memories', () => {
  assert.deepEqual(parseReviewJson('{"actions":[]}'), { actions: [] })
  assert.equal(parseReviewJson('{"memories":[{"title":"x","content":"y"}]}').actions[0].action, 'create')
  assert.throws(() => parseReviewJson('not json'), (error) => error?.code === 'INVALID_JSON')
})

test('后台纯文本评审绕过 modlens 视觉包装', () => {
  assert.equal(unwrapReviewProvider('modlens-opencode-go'), 'opencode-go')
  assert.equal(unwrapReviewProvider('deepseek-modlens'), 'deepseek-official')
  assert.equal(unwrapReviewProvider('plain-provider'), 'plain-provider')
})

test('自动记录成功落入当前项目并清除已处理缓冲', async () => {
  const output = JSON.stringify({ actions: [{ action: 'create', type: 'project', title: '技术选型', content: '使用 Rust 和 Tauri' }] })
  await fixture([{ type: 'text-delta', text: output }, { type: 'finish', reason: { kind: 'stop' } }], async ({ recorder, repo, calls }) => {
    recorder.sessionCwds.set('session-1', repo)
    recorder.pushMessage('session-1', 'user', '记住使用 Rust 和 Tauri')
    const result = await recorder.maybeReview('session-1')
    assert.equal(result.status, 'applied')
    assert.equal(recorder.buffers.get('session-1').length, 0)
    const stored = await recorder.store.get('demo/技术选型')
    assert.equal(stored.content, '使用 Rust 和 Tauri')
    assert.equal(calls[0].messages[0].source.kind, 'user')
    assert.ok(calls[0].messages[0].id)
    assert.equal(calls[0].reasoningEffort, 'off')
    assert.equal(calls[0].temperature, 0)
    assert.ok(Array.isArray(calls[0].messages[0].content))
    assert.equal(calls[0].messages[0].content[0].type, 'text')
    assert.match(calls[0].messages[0].content[0].text, /待评审对话/)
  })
})

test('明确 none 才会清除缓冲', async () => {
  await fixture([{ type: 'text-delta', text: '{"actions":[]}' }, { type: 'finish', reason: { kind: 'stop' } }], async ({ recorder, repo }) => {
    recorder.sessionCwds.set('session-1', repo)
    recorder.pushMessage('session-1', 'user', '你好')
    assert.equal((await recorder.maybeReview('session-1')).status, 'none')
    assert.equal(recorder.buffers.get('session-1').length, 0)
  })
})

test('收到 finish 后立即结束，不等待适配器迭代器自行关闭', async () => {
  const dangling = () => {
    let index = 0
    return {
      [Symbol.asyncIterator]() { return this },
      next() {
        index += 1
        if (index === 1) return Promise.resolve({ done: false, value: { type: 'text-delta', text: '{"actions":[]}' } })
        if (index === 2) return Promise.resolve({ done: false, value: { type: 'finish', reason: { kind: 'stop' } } })
        return new Promise(() => {})
      },
      return() { return Promise.resolve({ done: true }) },
    }
  }
  await fixture(dangling, async ({ recorder, repo }) => {
    recorder.sessionCwds.set('session-1', repo)
    recorder.pushMessage('session-1', 'user', '你好')
    assert.equal((await recorder.maybeReview('session-1')).status, 'none')
  })
})

test('流自然结束但缺少 finish 时失败并保留缓冲', async () => {
  await fixture([{ type: 'text-delta', text: '{"actions":[]}' }], async ({ recorder, repo }) => {
    recorder.sessionCwds.set('session-1', repo)
    recorder.pushMessage('session-1', 'user', '不能误判成功')
    const result = await recorder.maybeReview('session-1')
    assert.equal(result.code, 'LLM_NO_FINISH')
    assert.equal(recorder.buffers.get('session-1').length, 1)
  })
})

test('LLM finish error 不伪装成 none 且保留缓冲', async () => {
  const finish = { type: 'finish', reason: { kind: 'error', failure: { code: 'NO_ADAPTER', message: 'adapter missing' } } }
  await fixture([finish], async ({ recorder, repo, warnings }) => {
    recorder.sessionCwds.set('session-1', repo)
    recorder.pushMessage('session-1', 'user', '这是必须保留的决定')
    const result = await recorder.maybeReview('session-1')
    assert.equal(result.status, 'failed')
    assert.equal(result.code, 'NO_ADAPTER')
    assert.equal(recorder.buffers.get('session-1').length, 1)
    assert.ok(warnings.some((message) => message.includes('NO_ADAPTER')))
  })
})

test('无效 JSON 保留缓冲', async () => {
  await fixture([{ type: 'text-delta', text: '坏结果' }, { type: 'finish', reason: { kind: 'stop' } }], async ({ recorder, repo }) => {
    recorder.sessionCwds.set('session-1', repo)
    recorder.pushMessage('session-1', 'user', '项目决定')
    assert.equal((await recorder.maybeReview('session-1')).code, 'INVALID_JSON')
    assert.equal(recorder.buffers.get('session-1').length, 1)
  })
})

test('LLM 建流阶段超时也会释放并保留缓冲', async () => {
  await hangingFixture(async ({ recorder, repo }) => {
    recorder.sessionCwds.set('session-1', repo)
    recorder.pushMessage('session-1', 'user', '不能丢失')
    const result = await recorder.maybeReview('session-1')
    assert.equal(result.code, 'REVIEW_TIMEOUT')
    assert.equal(recorder.buffers.get('session-1').length, 1)
    assert.equal(recorder.inFlight.has('session-1'), false)
  })
})

test('未知 cwd 的自动记录跳过且不写入通用', async () => {
  await fixture([{ type: 'text-delta', text: '{"actions":[]}' }, { type: 'finish', reason: { kind: 'stop' } }], async ({ recorder }) => {
    recorder.ctx.agents.get = () => undefined
    recorder.pushMessage('session-unknown', 'user', '项目秘密')
    const result = await recorder.maybeReview('session-unknown')
    assert.equal(result.code, 'PROJECT_SCOPE_UNRESOLVED')
    assert.equal(recorder.buffers.get('session-unknown').length, 0)
    assert.equal((await recorder.store.manifest(['通用'])).length, 0)
  })
})

test('录制缓冲有上限且会话释放时清理状态', () => {
  const recorder = new TurnRecorder({}, {}, {})
  for (let index = 0; index < 80; index++) recorder.pushMessage('session-1', 'user', `message-${index}`)
  assert.equal(recorder.buffers.get('session-1').length, 50)
  recorder.turnCounts.set('session-1', 2)
  recorder.sessionCwds.set('session-1', 'cwd')
  recorder.pending.add('session-1')
  recorder.disposeSession('session-1')
  assert.equal(recorder.buffers.has('session-1'), false)
  assert.equal(recorder.turnCounts.has('session-1'), false)
  assert.equal(recorder.sessionCwds.has('session-1'), false)
  assert.equal(recorder.pending.has('session-1'), false)
})

test('同批重复 create 在任何写入前整体拒绝', async () => {
  await fixture([], async ({ recorder, repo }) => {
    const scope = repo.split(/[\\/]/).at(-1)
    await assert.rejects(
      recorder.applyActions([
        { action: 'create', title: '重复', content: '一' },
        { action: 'create', title: '重复', content: '二' },
      ], scope),
      (error) => error?.code === 'DUPLICATE_ACTION',
    )
    assert.equal((await recorder.store.manifest([scope])).length, 0)
  })
})

test('只有 completed 的 turn/end 才推进计数并触发评审', async () => {
  const waitFor = async (predicate, timeout = 2_000) => {
    const start = Date.now()
    while (!predicate()) {
      if (Date.now() - start > timeout) throw new Error('等待评审完成超时')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  await fixture([{ type: 'text-delta', text: '{"actions":[]}' }, { type: 'finish', reason: { kind: 'stop' } }], async ({ recorder, repo, calls }) => {
    recorder.sessionCwds.set('session-1', repo)
    recorder.pushMessage('session-1', 'user', '记住技术选型')
    for (const kind of ['error', 'max-tokens', 'aborted', 'blocked', 'interrupted']) {
      recorder.handleEvent({ id: 'session-1' }, { type: 'turn/end', data: { reason: { kind } } })
      assert.equal(recorder.turnCounts.get('session-1'), undefined, `kind=${kind} 不应推进计数`)
    }
    assert.equal(recorder.buffers.get('session-1').length, 1, '非 completed 应保留缓冲')
    assert.equal(calls.length, 0, '非 completed 不应触发评审')
    recorder.handleEvent({ id: 'session-1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    assert.equal(recorder.turnCounts.get('session-1'), 1)
    await waitFor(() => recorder.buffers.get('session-1')?.length === 0)
    assert.ok(calls.length >= 1, 'completed 应触发评审')
  })
})

test('首次空输出自动重试，第二次成功才落盘', async () => {
  const streams = [
    [{ type: 'text-delta', text: '' }, { type: 'finish', reason: { kind: 'stop' } }],
    [{ type: 'text-delta', text: '{"actions":[]}' }, { type: 'finish', reason: { kind: 'stop' } }],
  ]
  let streamIndex = 0
  await fixture(() => streamOf(streams[Math.min(streamIndex++, streams.length - 1)]), async ({ recorder, repo, calls }) => {
    recorder.sessionCwds.set('session-1', repo)
    recorder.pushMessage('session-1', 'user', '记住技术选型')
    const result = await recorder.maybeReview('session-1')
    assert.equal(result.status, 'none', '空输出应自动重试而非直接失败')
    assert.equal(calls.length, 2, '应发起两次 LLM 调用')
    assert.equal(recorder.buffers.get('session-1').length, 0)
  })
})

async function waitFor(predicate, timeout = 2_000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('等待评审完成超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('REVIEW_SYSTEM 含保存门:显式保存请求不豁免排除项,要问出意外/非显然的部分', async () => {
  await fixture([{ type: 'text-delta', text: '{"actions":[]}' }, { type: 'finish', reason: { kind: 'stop' } }], async ({ recorder, repo, calls }) => {
    recorder.sessionCwds.set('session-1', repo)
    recorder.pushMessage('session-1', 'user', '把这次的 PR 列表存进记忆')
    assert.equal((await recorder.maybeReview('session-1')).status, 'none')
    const system = calls[0].system
    assert.match(system, /即使用户明确要求保存/)
    assert.match(system, /意外|非显然/)
    assert.match(system, /PR 列表|活动流水/)
  })
})

test('本回合主 agent 写过记忆时跳过评审、清空缓冲且计数照旧推进', async () => {
  await fixture([{ type: 'text-delta', text: '{"actions":[]}' }, { type: 'finish', reason: { kind: 'stop' } }], async ({ recorder, repo, calls, infos }) => {
    recorder.sessionCwds.set('session-1', repo)
    recorder.pushMessage('session-1', 'user', '记住技术选型')
    recorder.handleEvent({ id: 'session-1' }, {
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'call-1', name: 'memory_remember', arguments: '{"title":"技术选型"}' },
    })
    recorder.handleEvent({ id: 'session-1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    assert.equal(recorder.turnCounts.get('session-1'), 1, '计数应照旧推进')
    assert.equal(recorder.buffers.has('session-1'), false, '缓冲应被清空(等价上游游标推进)')
    assert.equal(recorder.agentWrote.has('session-1'), false, '标记应被清掉')
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(calls.length, 0, '不应调用 LLM(评审被跳过)')
    assert.ok(infos.some((message) => message.includes('AGENT_WROTE_MEMORY')), '应记录一条跳过说明')
    assert.equal((await recorder.store.manifest(['demo'])).length, 0)
  })
})

test('skipReviewAfterAgentWrite=false 时主 agent 写记忆后评审照常触发', async () => {
  await fixture([{ type: 'text-delta', text: '{"actions":[]}' }, { type: 'finish', reason: { kind: 'stop' } }], async ({ recorder, repo, calls }) => {
    recorder.config.skipReviewAfterAgentWrite = false
    recorder.sessionCwds.set('session-1', repo)
    recorder.pushMessage('session-1', 'user', '记住技术选型')
    recorder.handleEvent({ id: 'session-1' }, {
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'call-1', name: 'memory_remember', arguments: '{"title":"技术选型"}' },
    })
    recorder.handleEvent({ id: 'session-1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    assert.equal(recorder.turnCounts.get('session-1'), 1)
    await waitFor(() => calls.length >= 1)
    await waitFor(() => recorder.buffers.get('session-1')?.length === 0)
    assert.ok(calls.length >= 1, '关掉开关后应照常评审')
  })
})

test('主 agent 调用非记忆工具不影响评审', async () => {
  await fixture([{ type: 'text-delta', text: '{"actions":[]}' }, { type: 'finish', reason: { kind: 'stop' } }], async ({ recorder, repo, calls }) => {
    recorder.sessionCwds.set('session-1', repo)
    recorder.pushMessage('session-1', 'user', '记住技术选型')
    for (const name of ['bash', 'read', 'memory_search', 'memory_list']) {
      recorder.handleEvent({ id: 'session-1' }, {
        type: 'tool/call',
        data: { turn: 1, step: 1, callId: `call-${name}`, name, arguments: '{}' },
      })
    }
    recorder.handleEvent({ id: 'session-1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    assert.equal(recorder.buffers.get('session-1').length, 1, '不应清空缓冲')
    await waitFor(() => calls.length >= 1)
    await waitFor(() => recorder.buffers.get('session-1')?.length === 0)
    assert.ok(calls.length >= 1, '非记忆工具不应阻止评审')
  })
})

test('五个记忆写工具名都触发自我写入互斥', () => {
  const infos = []
  const ctx = { logger: { info(message) { infos.push(message) }, warn() {} } }
  // memory_dream 由隔壁 dsh-dream 注册,但它同样会 create/update/delete 记忆文件,
  // 上游判据是"有没有写记忆文件",因此一并纳入。
  const writeTools = ['memory_remember', 'memory_write', 'memory_update', 'memory_delete', 'memory_dream']
  for (const name of writeTools) {
    const recorder = new TurnRecorder(ctx, {}, { reviewInterval: 1 })
    const sessionId = `session-${name}`
    recorder.sessionCwds.set(sessionId, 'D:/x/demo')
    recorder.pushMessage(sessionId, 'user', '记住这个')
    recorder.handleEvent({ id: sessionId }, {
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'call-1', name, arguments: '{}' },
    })
    recorder.handleEvent({ id: sessionId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    assert.equal(recorder.turnCounts.get(sessionId), 1, `${name} 应照旧推进计数`)
    assert.equal(recorder.buffers.has(sessionId), false, `${name} 应清空缓冲`)
    assert.equal(recorder.agentWrote.has(sessionId), false, `${name} 应清掉标记`)
  }
  assert.equal(infos.length, writeTools.length)
  assert.ok(infos.every((message) => message.includes('AGENT_WROTE_MEMORY')))
})

test('非 completed 回合计入的写标记在下一个 completed 回合生效后清掉', async () => {
  await fixture([{ type: 'text-delta', text: '{"actions":[]}' }, { type: 'finish', reason: { kind: 'stop' } }], async ({ recorder, repo, calls }) => {
    recorder.sessionCwds.set('session-1', repo)
    recorder.pushMessage('session-1', 'user', '记住技术选型')
    recorder.handleEvent({ id: 'session-1' }, {
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'call-1', name: 'memory_write', arguments: '{}' },
    })
    recorder.handleEvent({ id: 'session-1' }, { type: 'turn/end', data: { reason: { kind: 'error' } } })
    assert.equal(recorder.turnCounts.get('session-1'), undefined, '中断回合不推进计数')
    assert.equal(recorder.agentWrote.has('session-1'), true, '中断回合保留标记')
    recorder.handleEvent({ id: 'session-1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    assert.equal(recorder.turnCounts.get('session-1'), 1)
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(calls.length, 0, '缓冲含中断回合的写入,应一并跳过')
    assert.equal(recorder.agentWrote.has('session-1'), false)
  })
})

test('会话释放时清掉自我写入标记', () => {
  const recorder = new TurnRecorder({}, {}, {})
  recorder.agentWrote.add('session-1')
  recorder.disposeSession('session-1')
  assert.equal(recorder.agentWrote.has('session-1'), false)
})
