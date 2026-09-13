import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { handle } from '../src/api.ts'
import { MemoryStore } from '../src/store.ts'

function request(method, url, body) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  stream.method = method
  stream.url = url
  return stream
}

function response() {
  return {
    status: 0,
    body: '',
    writeHead(status) { this.status = status },
    end(body) { this.body = body },
  }
}

async function call(ctx, store, method, path, body) {
  const res = response()
  await handle(request(method, `/memory/api/${path}`, body), res, ctx, store, async () => ({ imported: 0, skipped: 0 }))
  return { status: res.status, data: JSON.parse(res.body) }
}

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-api-'))
  const repo = join(root, 'demo')
  await mkdir(join(repo, '.git'), { recursive: true })
  const store = new MemoryStore(join(root, 'memory'))
  const agents = { get: (id) => id === 'session-1' ? { session: { header: { cwd: repo } } } : undefined }
  const ctx = { get: (name) => name === 'agents' ? agents : undefined, agents }
  try { await fn({ ctx, store }) } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }) }
}

test('API 只用 sessionId 反查项目并按项目写入', async () => {
  await fixture(async ({ ctx, store }) => {
    const result = await call(ctx, store, 'POST', 'write?sessionId=session-1', { title: 'API 记忆', content: '真实写入' })
    assert.equal(result.status, 200)
    assert.equal(result.data.id, 'demo/API 记忆')
  })
})

test('未知会话不能伪造项目写入，只能明确写通用', async () => {
  await fixture(async ({ ctx, store }) => {
    const denied = await call(ctx, store, 'POST', 'write?sessionId=missing', { title: 'x', content: 'x' })
    const general = await call(ctx, store, 'POST', 'write?sessionId=missing', { title: 'g', content: 'g', scope: 'general' })
    assert.equal(denied.status, 400)
    assert.equal(general.data.id, '通用/g')
  })
})

test('API 索引和 get 不泄漏其他项目', async () => {
  await fixture(async ({ ctx, store }) => {
    await store.write({ title: '当前', content: 'visible' }, { scope: 'demo' })
    await store.write({ title: '其他', content: 'secret' }, { scope: 'other' })
    const index = await call(ctx, store, 'GET', 'index?sessionId=session-1')
    const hidden = await call(ctx, store, 'GET', 'get?sessionId=session-1&id=other%2F其他')
    assert.equal(index.data.entries.some((entry) => entry.title === '其他'), false)
    assert.equal(hidden.status, 404)
  })
})

test('API 搜索 limit 与后端对齐,最多返回 50 条', async () => {
  await fixture(async ({ ctx, store }) => {
    for (let index = 0; index < 55; index++) {
      await store.write({ title: '条目 ' + index, content: '内容 ' + index, type: 'reference' }, { scope: 'demo' })
    }
    const result = await call(ctx, store, 'GET', 'search?sessionId=session-1&q=%E6%9D%A1%E7%9B%AE&limit=100')
    assert.equal(result.status, 200)
    assert.ok(result.data.count <= 50, '后端搜索上限必须为 50,与 UI 对齐')
    assert.ok(result.data.results.length <= 50)
  })
})
