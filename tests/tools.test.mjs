import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryStore, slugify } from '../src/store.ts'
import { registerMemoryTools } from '../src/tools.ts'

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-tools-'))
  const repo = join(root, 'demo')
  await mkdir(join(repo, '.git'), { recursive: true })
  const store = new MemoryStore(join(root, 'memory'))
  const registered = new Map()
  const ctx = { tools: { register(tool) { registered.set(tool.name, tool) } }, logger: { info() {} } }
  registerMemoryTools(ctx, store)
  const exec = { agent: { session: { header: { cwd: repo } } } }
  try { await fn({ store, registered, exec }) } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }) }
}

test('memory_write 默认写当前项目，明确 general 才写通用', async () => {
  await fixture(async ({ store, registered, exec }) => {
    const write = registered.get('memory_write')
    const project = await write.execute({ title: '项目规则', content: '使用 pnpm', type: 'feedback' }, exec)
    const general = await write.execute({ title: '通用规则', content: '回答中文', type: 'user', scope: 'general' }, exec)
    assert.equal(project.id, 'demo/项目规则')
    assert.equal(general.id, '通用/通用规则')
    assert.equal(project.saved, true)
  })
})

test('memory_remember 新建独立文件并返回真实路径', async () => {
  await fixture(async ({ store, registered, exec }) => {
    const remember = registered.get('memory_remember')
    const result = await remember.execute({
      title: 'fileindex-rs 技术栈',
      content: '核心语言是 Rust，桌面框架是 Tauri。',
      type: 'project',
    }, exec)
    assert.equal(result.saved, true)
    assert.equal(result.action, 'created')
    assert.equal(result.id, 'demo/fileindex-rs 技术栈')
    await access(result.path)
    assert.equal((await store.get(result.id)).content, '核心语言是 Rust，桌面框架是 Tauri。')
  })
})

test('memory_remember 按索引 id 更新原文件', async () => {
  await fixture(async ({ store, registered, exec }) => {
    const remember = registered.get('memory_remember')
    const first = await remember.execute({ title: 'fileindex-rs 技术选型', content: '旧内容', type: 'project' }, exec)
    const second = await remember.execute({ id: first.id, title: 'fileindex-rs 技术栈', content: 'Rust + Tauri', type: 'project' }, exec)
    assert.equal(second.saved, true)
    assert.equal(second.action, 'updated')
    assert.equal(second.id, first.id)
    assert.equal(second.path, first.path)
    assert.equal((await store.manifest(['demo'])).length, 1)
    assert.equal((await store.get(first.id)).content, 'Rust + Tauri')
  })
})

test('memory_remember 不用模糊标题覆盖同项目其他主题', async () => {
  await fixture(async ({ store, registered, exec }) => {
    const remember = registered.get('memory_remember')
    await remember.execute({ title: 'fileindex-rs 技术栈', content: 'Rust + Tauri', type: 'project' }, exec)
    await remember.execute({ title: 'fileindex-rs 技术文档', content: '文档使用中文', type: 'project' }, exec)
    assert.equal((await store.manifest(['demo'])).length, 2)
  })
})

test('memory_remember 拒绝更新其他项目 id', async () => {
  await fixture(async ({ registered, exec }) => {
    const result = await registered.get('memory_remember').execute({
      id: 'other/秘密', title: '秘密', content: '不能写入', type: 'project',
    }, exec)
    assert.equal(result.saved, false)
    assert.equal(result.code, 'SCOPE_VIOLATION')
  })
})

test('未知 cwd 的项目写入必须失败，不能静默落入通用', async () => {
  await fixture(async ({ registered }) => {
    const exec = { agent: { session: { header: {} } } }
    await assert.rejects(
      registered.get('memory_remember').execute({ title: '项目事实', content: '不能泄漏' }, exec),
      (error) => error?.code === 'PROJECT_SCOPE_UNRESOLVED',
    )
    await assert.rejects(
      registered.get('memory_write').execute({ title: '项目事实', content: '不能泄漏' }, exec),
      (error) => error?.code === 'PROJECT_SCOPE_UNRESOLVED',
    )
  })
})

test('工具搜索和读取不能访问其他项目', async () => {
  await fixture(async ({ store, registered, exec }) => {
    await store.write({ title: '其他秘密', content: '不可见事实' }, { scope: 'other' })
    const search = await registered.get('memory_search').execute({ query: '不可见事实' }, exec)
    const read = await registered.get('memory_read').execute({ id: 'other/其他秘密' }, exec)
    assert.equal(search.count, 0)
    assert.equal(read.ok, false)
  })
})

test('同名工具写入返回冲突而不覆盖', async () => {
  await fixture(async ({ store, registered, exec }) => {
    const write = registered.get('memory_write')
    await write.execute({ title: '规则', content: '原内容' }, exec)
    const conflict = await write.execute({ title: '规则', content: '新内容' }, exec)
    assert.equal(conflict.ok, false)
    assert.equal(conflict.code, 'MEMORY_CONFLICT')
    assert.equal((await store.get('demo/规则')).content, '原内容')
  })
})

test('memory_remember 截断 slug 命中但完整标题不同时必须显式冲突，不能误更新', async () => {
  await fixture(async ({ store, registered, exec }) => {
    const remember = registered.get('memory_remember')
    const longA = '相同前缀'.repeat(20) + '甲'
    const longB = '相同前缀'.repeat(20) + '乙'
    assert.ok(longA.length > 48)
    assert.equal(slugify(longA), slugify(longB), '前置条件:两标题截断后同 slug')
    const first = await remember.execute({ title: longA, content: '甲内容', type: 'project' }, exec)
    assert.equal(first.saved, true)
    assert.equal(first.action, 'created')
    const second = await remember.execute({ title: longB, content: '乙内容', type: 'project' }, exec)
    assert.equal(second.saved, false, '标题不同必须显式冲突')
    assert.equal(second.code, 'MEMORY_CONFLICT')
    const stored = await store.get(first.id)
    assert.equal(stored.content, '甲内容', '原记忆不能被误更新')
    assert.equal(stored.name, longA)
    assert.equal((await store.manifest(['demo'])).length, 1)
  })
})

test('memory_remember 用持久化后的等价标题重复调用时正常更新', async () => {
  await fixture(async ({ store, registered, exec }) => {
    const remember = registered.get('memory_remember')
    const first = await remember.execute({ title: '规则 \n', content: '第一版', type: 'project' }, exec)
    assert.equal(first.saved, true)
    const second = await remember.execute({ title: '规则 \n', content: '第二版', type: 'project' }, exec)
    assert.equal(second.saved, true)
    assert.equal(second.action, 'updated')
    assert.equal((await store.manifest(['demo'])).length, 1)
    assert.equal((await store.get(first.id)).content, '第二版')
  })
})
