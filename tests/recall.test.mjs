import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryStore } from '../src/store.ts'
import { installRecall, recallText, selectRelevant } from '../src/recall.ts'
import { resolveProjectScope } from '../src/scope.ts'

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-recall-'))
  const memory = join(root, 'memory')
  const repo = join(root, 'za xiang')
  await mkdir(join(repo, '.git'), { recursive: true })
  try {
    const store = new MemoryStore(memory)
    resolveProjectScope(memory, repo)
    await fn({ store, repo })
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 })
  }
}

test('召回只包含通用和当前项目', async () => {
  await fixture(async ({ store, repo }) => {
    await store.write({ title: '通用偏好', content: '回答使用中文', type: 'user' })
    await store.write({ title: '当前项目', content: 'fileindex-rs 使用 Rust Tauri', type: 'project' }, { scope: 'za xiang' })
    await store.write({ title: '其他项目', content: 'PLC 使用 S7-1200', type: 'project' }, { scope: 'AI 接入PLC' })
    const text = recallText(store, {}, repo, 'fileindex-rs 用什么技术')
    assert.match(text, /通用偏好/)
    assert.match(text, /fileindex-rs 使用 Rust Tauri/)
    assert.doesNotMatch(text, /PLC 使用 S7-1200/)
  })
})

test('未知项目不泄漏任意项目记忆', async () => {
  await fixture(async ({ store }) => {
    await store.write({ title: '通用偏好', content: '中文', type: 'user' })
    await store.write({ title: '秘密项目', content: '不能泄漏', type: 'project' }, { scope: 'secret' })
    const text = recallText(store, {}, undefined, '秘密项目')
    assert.match(text, /通用偏好/)
    assert.doesNotMatch(text, /不能泄漏/)
  })
})

test('相关正文最多选择五条且项目优先', () => {
  const entries = Array.from({ length: 8 }, (_, index) => ({
    scope: index === 0 ? '通用' : 'demo', rel: `${index}.md`, name: `Rust ${index}`,
    description: 'Tauri 项目', body: 'fileindex-rs', type: 'project', updated: new Date().toISOString(),
  }))
  const selected = selectRelevant(entries, 'Rust Tauri fileindex-rs', 5)
  assert.equal(selected.length, 5)
  assert.equal(selected[0].scope, 'demo')
})

test('用户要求忽略记忆时不注入索引或正文', async () => {
  await fixture(async ({ store, repo }) => {
    await store.write({ title: '旧事实', content: '不要出现', type: 'project' }, { scope: 'za xiang' })
    const text = recallText(store, {}, repo, '这次忽略记忆，从零开始')
    assert.match(text, /本轮已忽略记忆/)
    assert.doesNotMatch(text, /不要出现/)
  })
})

test('明确记住时追加首轮 read 后调用 memory_remember 的引导', async () => {
  await fixture(async ({ store, repo }) => {
    const handlers = new Map()
    let appended
    const session = { id: 'session-1', header: { cwd: repo } }
    const agent = { session, inbox: { append(stage, message) { appended = { stage, message } } } }
    const ctx = {
      on(name, handler) { handlers.set(name, handler) },
      agents: { get: () => agent },
      systemPrompt: { context() {} },
      logger: { info() {} },
    }
    installRecall(ctx, store, {})
    handlers.get('session/event')(session, {
      type: 'user/message', seq: 1,
      data: { id: 'message-1', source: { kind: 'user' }, content: [{ type: 'text', text: '请记住：fileindex-rs 使用 Rust 和 Tauri' }] },
    })
    assert.equal(appended.stage, 'next-step')
    assert.match(appended.message.content[0].text, /先用 read 读取记忆索引/)
    assert.match(appended.message.content[0].text, /memory_remember/)
    assert.match(appended.message.content[0].text, /saved=true/)

    const assembled = await handlers.get('system-prompt/assemble')(
      {}, { agent }, async () => ({ sections: [], contexts: [], tools: [], variables: {} }),
    )
    assert.equal(assembled.contexts[0].name, 'memory:index')
    assert.match(assembled.contexts[0].text, /若首轮 memory_remember 尚未暴露，先用 read/)
  })
})

test('召回索引超过 200 行或字节上限时截断并告警', async () => {
  await fixture(async ({ store, repo }) => {
    await mkdir(join(store.root, 'za xiang'), { recursive: true })
    for (let index = 0; index < 210; index++) {
      await writeFile(join(store.root, 'za xiang', 'm' + index + '.md'), '记忆 ' + index, 'utf8')
    }
    const text = recallText(store, {}, repo, '')
    assert.match(text, /WARNING：记忆索引超过 200 行或 25KB/)
    assert.ok(text.split('\n').filter((line) => line.startsWith('- [')).length <= 200)
    const small = recallText(store, { recallMaxBytes: 300 }, repo, '')
    assert.match(small, /WARNING：记忆索引超过 200 行或 25KB/)
  })
})

/** 构造最小 ctx/agent,并触发一次用户消息(设置当前 query)。 */
function recallHarness(store, repo, config = {}) {
  const handlers = new Map()
  const session = { id: 'session-budget', header: { cwd: repo } }
  const agent = { session, options: { provider: 'test-provider', model: 'test-model' } }
  const sections = []
  const contexts = []
  const llmCalls = []
  const ctx = {
    on(name, handler) { handlers.set(name, handler) },
    agents: { get: () => agent },
    systemPrompt: {
      context(entry) { contexts.push(entry) },
      section(entry) { sections.push(entry) },
    },
    llm: {
      stream(options) {
        llmCalls.push(options)
        const text = options?.system?.includes('记忆相关性选择器') ? '[]' : ''
        return (async function* () { yield { type: 'text-delta', text } })()
      },
    },
    logger: { info() {}, warn() {} },
  }
  installRecall(ctx, store, config)
  const base = { sections: [], contexts: [], tools: [], variables: {} }
  return {
    agent,
    sections,
    contexts,
    llmCalls,
    say(text) {
      handlers.get('session/event')(session, {
        type: 'user/message', seq: 1,
        data: { id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text }] },
      })
    },
    tool(name) {
      handlers.get('session/event')(session, { type: 'tool/call', data: { name } })
    },
    assemble: () => handlers.get('system-prompt/assemble')({}, { agent }, async () => base),
  }
}

test('把"引用记忆前的核验"指南注册成静态系统提示词 section(对齐上游)', async () => {
  await fixture(async ({ store, repo }) => {
    const h = recallHarness(store, repo, {})
    const usage = h.sections.find((item) => item.name === 'memory:usage')
    assert.ok(usage, '应注册 memory:usage section')
    assert.equal(typeof usage.order, 'number')
    assert.match(usage.text, /先 grep 一遍/)
    assert.match(usage.text, /「记忆说 X 存在」不等于「X 现在存在」/)
    assert.match(usage.text, /以你现在观察到的为准/)
    // 关掉时不注册
    const off = recallHarness(store, repo, { guidanceEnabled: false })
    assert.equal(off.sections.find((item) => item.name === 'memory:usage'), undefined)
  })
})

test('最近使用过的工具会传给相关性选择器(对齐上游 recentTools)', async () => {
  await fixture(async ({ store, repo }) => {
    for (const name of ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']) {
      await store.write({ title: name, description: `${name} 关键词`, content: `${name} 正文`, type: 'project' }, { scope: 'za xiang' })
    }
    const h = recallHarness(store, repo, {})
    h.tool('bash')
    h.tool('grep')
    h.tool('bash')                    // 重复的应去重并前移
    h.say('m1 m2 关键词')
    await h.assemble()
    assert.equal(h.llmCalls.length, 1, '应触发一次相关性选择')
    assert.match(h.llmCalls[0].messages[0].content[0].text, /最近使用过的工具：bash, grep/)
    assert.match(h.llmCalls[0].system, /不要挑这些工具的用法\/API 参考类记忆/)
    // 关掉后不再附带
    const off = recallHarness(store, repo, { recentToolsEnabled: false })
    off.tool('bash')
    off.say('m1 m2 关键词')
    await off.assemble()
    assert.doesNotMatch(off.llmCalls[0].messages[0].content[0].text, /最近使用过的工具/)
  })
})

test('同一查询在同一回合内逐字节稳定(否则 harness 每步都会再追加一次注入)', async () => {
  await fixture(async ({ store, repo }) => {
    await store.write({ title: 'alpha', description: 'alpha 主题', content: 'ALPHA_BODY alpha', type: 'project' }, { scope: 'za xiang' })
    // 第二条也命中同一查询(仅正文命中 → 分数更低),用来暴露"集合相同但顺序不同"的坑
    await store.write({ title: 'gamma', description: '别的主题', content: 'GAMMA_BODY alpha', type: 'project' }, { scope: 'za xiang' })
    const h = recallHarness(store, repo, { selectEnabled: false })
    h.say('alpha')
    const first = (await h.assemble()).contexts[0].text
    assert.match(first, /ALPHA_BODY/)
    assert.match(first, /GAMMA_BODY/)
    // 同一回合的第 2、3 个 step:必须原样复用上一次的选择(含顺序),
    // 文本逐字节相同 → harness 判定快照未变 → 不会新增注入。
    const second = (await h.assemble()).contexts[0].text
    const third = (await h.assemble()).contexts[0].text
    assert.equal(second, first)
    assert.equal(third, first)
    assert.match(second, /ALPHA_BODY/)
  })
})

test('换新查询时已注入过的正文不再重复,索引仍在', async () => {
  await fixture(async ({ store, repo }) => {
    await store.write({ title: 'alpha', description: 'alpha 主题', content: 'ALPHA_BODY alpha', type: 'project' }, { scope: 'za xiang' })
    await store.write({ title: 'beta', description: 'beta 主题', content: 'BETA_BODY beta', type: 'project' }, { scope: 'za xiang' })
    const h = recallHarness(store, repo, { selectEnabled: false })
    h.say('alpha')
    const first = (await h.assemble()).contexts[0].text
    assert.match(first, /ALPHA_BODY/)
    assert.doesNotMatch(first, /BETA_BODY/)
    h.say('beta')
    const second = (await h.assemble()).contexts[0].text
    assert.match(second, /BETA_BODY/)          // 新查询拿到新正文
    assert.doesNotMatch(second, /ALPHA_BODY/)  // 已经给过的不再重复
    assert.match(second, /alpha/)              // 索引条目仍在
    assert.match(second, /# 记忆索引/)
  })
})

test('会话累计预算用尽后正文让位,只保留索引', async () => {
  await fixture(async ({ store, repo }) => {
    await store.write({ title: 'alpha', description: 'alpha 关键词', content: 'ALPHA_BODY 关键词', type: 'project' }, { scope: 'za xiang' })
    const h = recallHarness(store, repo, { selectEnabled: false, sessionMaxBytes: 1 })
    h.say('alpha 关键词')
    const text = (await h.assemble()).contexts[0].text
    assert.doesNotMatch(text, /ALPHA_BODY/)
    assert.match(text, /# 记忆索引/)
    // 预算用尽后同样要保持逐字节稳定(否则每步仍会新增注入)
    assert.equal((await h.assemble()).contexts[0].text, text)
    assert.equal((await h.assemble()).contexts[0].text, text)
  })
})

test('两条记忆都会被注入(去重不误伤首轮)', async () => {
  await fixture(async ({ store, repo }) => {
    await store.write({ title: 'alpha', description: 'alpha 关键词', content: 'ALPHA_BODY 关键词', type: 'project' }, { scope: 'za xiang' })
    await store.write({ title: 'beta', description: 'beta 关键词', content: 'BETA_BODY 关键词', type: 'project' }, { scope: 'za xiang' })
    const h = recallHarness(store, repo, { selectEnabled: false })
    h.say('alpha beta 关键词')
    const text = (await h.assemble()).contexts[0].text
    assert.match(text, /ALPHA_BODY/)
    assert.match(text, /BETA_BODY/)
  })
})
