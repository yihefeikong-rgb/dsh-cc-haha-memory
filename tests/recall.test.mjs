import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
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
    await rm(root, { recursive: true, force: true })
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
