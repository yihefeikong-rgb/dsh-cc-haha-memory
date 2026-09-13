/** dsh-memory store 单元测试(node --test)。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryStore, parseFrontmatter, serializeMemory, slugify, parseTags, INDEX_FILE } from '../src/store.ts'

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-test-'))
  try {
    await fn(new MemoryStore(dir))
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 })
  }
}

test('frontmatter 解析', () => {
  const { meta, body } = parseFrontmatter('---\nname: 测试\ndescription: 概述\ntype: user\ntags: ["a", "b"]\n---\n正文内容')
  assert.equal(meta.name, '测试')
  assert.equal(meta.type, 'user')
  assert.deepEqual(parseTags(meta.tags), ['a', 'b'])
  assert.equal(body.trim(), '正文内容')
})

test('序列化往返一致', () => {
  const text = serializeMemory({ name: 'x', description: 'd', type: 'project', tags: ['t1'], content: 'body\nline2' })
  const { meta, body } = parseFrontmatter(text)
  assert.equal(meta.name, 'x')
  assert.equal(meta.type, 'project')
  assert.deepEqual(parseTags(meta.tags), ['t1'])
  assert.equal(body.trim(), 'body\nline2')
})

test('frontmatter 单行字段会清理换行，避免破坏元数据结构', () => {
  const raw = serializeMemory({ name: '标题\n注入', description: '第一行\r\n第二行', type: 'project', tags: [] })
  const parsed = parseFrontmatter(raw)
  assert.equal(parsed.meta.name, '标题 注入')
  assert.equal(parsed.meta.description, '第一行 第二行')
})

test('slugify 清理非法字符', () => {
  assert.equal(slugify('a/b\\c:*?"<>|'), 'a b c')
  assert.equal(slugify('正常标题'), '正常标题')
  assert.equal(slugify(''), 'untitled')
})

test('write → get → update(历史版本)→ search → delete', async () => {
  await withStore(async (store) => {
    const written = await store.write(
      { title: 'DSH 插件知识', content: 'dsh 插件开发模式:ctx.tools.register', type: 'reference', tags: ['dsh'] },
      { scope: 'za xiang' },
    )
    assert.ok(written.id)
    assert.equal(written.id, 'za xiang/DSH 插件知识')

    const got = await store.get(written.id)
    assert.equal(got.name, 'DSH 插件知识')
    assert.equal(got.type, 'reference')
    assert.deepEqual(got.tags, ['dsh'])

    // 索引
    const idx = await readFile(join(store.root, INDEX_FILE), 'utf8')
    assert.ok(idx.includes('DSH 插件知识'))

    // update 产生历史版本
    const updated = await store.update(written.id, { content: '新内容', tags: ['dsh', '记忆'] })
    assert.equal(updated.content, '新内容')
    const history = await readdir(join(store.root, '.history'))
    assert.ok(history.length >= 1)

    // search 命中
    const results = await store.search('插件')
    assert.equal(results[0].id, written.id)

    // delete 后消失
    const ok = await store.remove(written.id)
    assert.equal(ok, true)
    assert.equal(await store.get(written.id), null)
  })
})

test('search 支持类型过滤和评分排序', async () => {
  await withStore(async (store) => {
    await store.write({ title: '用户是学生', content: '电力学院', type: 'user' })
    await store.write({ title: '项目进展', content: '网关迁移完成', type: 'project' })
    const userResults = await store.search('电力', { type: 'user' })
    assert.equal(userResults.length, 1)
    assert.equal(userResults[0].type, 'user')
    // 标题命中分更高
    const both = await store.search('项目 网关')
    assert.ok(both.length >= 1)
  })
})

test('suggestTags 按频次', async () => {
  await withStore(async (store) => {
    await store.write({ title: 'a', content: 'x', tags: ['dsh'] })
    await store.write({ title: 'b', content: 'y', tags: ['dsh'] })
    await store.write({ title: 'c', content: 'z', tags: ['vue'] })
    const tags = await store.suggestTags('')
    assert.deepEqual(tags.slice(0, 1), ['dsh'])
  })
})

test('indexEntries 结构化输出', async () => {
  await withStore(async (store) => {
    await store.write({ title: '记忆甲', content: '内容', type: 'reference' })
    const entries = await store.indexEntries()
    assert.ok(entries.some((e) => e.title === '记忆甲' && e.section === '通用'))
  })
})

test('搜索和读取严格限制在指定作用域', async () => {
  await withStore(async (store) => {
    await store.write({ title: 'PLC 决策', content: 'S7-1200', type: 'project' }, { scope: 'AI 接入PLC' })
    await store.write({ title: '逆向决策', content: 'VMProtect', type: 'project' }, { scope: '逆向' })
    assert.equal((await store.search('S7-1200', { scopes: ['通用', '逆向'] })).length, 0)
    assert.equal((await store.search('S7-1200', { scopes: ['通用', 'AI 接入PLC'] })).length, 1)
    assert.equal(await store.get('AI 接入PLC/PLC 决策', { scopes: ['通用', '逆向'] }), null)
  })
})

test('同名写入拒绝静默覆盖，显式更新保持项目目录', async () => {
  await withStore(async (store) => {
    const first = await store.write({ title: '部署规则', content: '先测试', type: 'feedback' }, { scope: 'demo' })
    await assert.rejects(
      store.write({ title: '部署规则', content: '直接发布', type: 'project' }, { scope: 'demo' }),
      (error) => error?.code === 'MEMORY_CONFLICT',
    )
    const updated = await store.update(first.id, { type: 'project', content: '测试后发布' })
    assert.equal(updated.id, 'demo/部署规则')
    assert.equal(updated.type, 'project')
    assert.equal((await store.scan()).some((entry) => entry.id === '项目状态/部署规则'), false)
  })
})

test('拒绝路径穿越和非法作用域', async () => {
  await withStore(async (store) => {
    await assert.rejects(store.write({ title: 'x', content: 'x' }, { scope: '../outside' }), /无效记忆作用域/)
    await assert.rejects(store.get('../outside'), /无效记忆 id/)
  })
})

test('索引覆盖前会备份上一版到 .history/_index', async () => {
  await withStore(async (store) => {
    await store.write({ title: 'A', content: 'a', type: 'project' }, { scope: 'demo' })
    const previous = await store.readIndex()
    assert.ok(previous.includes('A'))
    // 第二次写入会重写索引 → 旧索引应先落一份备份
    await store.write({ title: 'B', content: 'b', type: 'project' }, { scope: 'demo' })
    const dir = join(store.root, '.history', '_index')
    const files = (await readdir(dir)).filter((name) => name.startsWith(`${INDEX_FILE}.`))
    assert.ok(files.length >= 1, '应至少有一份索引备份')
    const contents = await Promise.all(files.map((name) => readFile(join(dir, name), 'utf8')))
    assert.ok(contents.includes(previous), '备份内容应等于上一版索引')
    // 索引相对最新备份已变化 → 再刷新一次补一份备份
    await store.refreshIndex()
    const mid = (await readdir(dir)).filter((name) => name.startsWith(`${INDEX_FILE}.`))
    assert.equal(mid.length, files.length + 1)
    // 内容与最新备份相同 → 不再产生新备份
    await store.refreshIndex()
    const after = (await readdir(dir)).filter((name) => name.startsWith(`${INDEX_FILE}.`))
    assert.equal(after.length, mid.length)
  })
})
