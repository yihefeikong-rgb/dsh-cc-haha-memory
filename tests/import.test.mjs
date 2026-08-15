import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { importClaudeMemory } from '../src/import.ts'

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-import-'))
  const projectsRoot = join(root, 'claude-projects')
  const storageRoot = join(root, 'dsh-memory')
  const project = join(projectsRoot, 'encoded-demo')
  await mkdir(join(project, 'memory', '项目状态'), { recursive: true })
  await writeFile(join(project, 'session.jsonl'), `${JSON.stringify({ cwd: join(root, 'demo') })}\n`, 'utf8')
  await writeFile(join(project, 'memory', '项目状态', '事实.md'), '---\nname: 事实\ntype: project\n---\nClaude 原内容\n', 'utf8')
  try { await fn({ projectsRoot, storageRoot }) } finally { await rm(root, { recursive: true, force: true }) }
}

test('Claude 导入第二次启动不会覆盖 DSH 中的用户更新', async () => {
  await fixture(async ({ projectsRoot, storageRoot }) => {
    const first = await importClaudeMemory(storageRoot, { projectsRoot })
    const target = join(storageRoot, 'demo', '事实.md')
    assert.equal(first.imported, 1)
    await writeFile(target, '---\nname: 事实\ntype: project\n---\nDSH 用户更新\n', 'utf8')
    const second = await importClaudeMemory(storageRoot, { projectsRoot })
    assert.equal(second.imported, 0)
    assert.equal(second.skipped, 1)
    assert.match(await readFile(target, 'utf8'), /DSH 用户更新/)
  })
})

test('导入不会删除与旧分类同名的真实项目目录', async () => {
  await fixture(async ({ projectsRoot, storageRoot }) => {
    const preserved = join(storageRoot, '反馈', '保留.md')
    await mkdir(join(storageRoot, '反馈'), { recursive: true })
    await writeFile(preserved, '真实项目记忆', 'utf8')
    await importClaudeMemory(storageRoot, { projectsRoot })
    assert.equal(await readFile(preserved, 'utf8'), '真实项目记忆')
  })
})

test('已有同名目标只记录跳过，不覆盖内容', async () => {
  await fixture(async ({ projectsRoot, storageRoot }) => {
    const target = join(storageRoot, 'demo', '事实.md')
    await mkdir(join(storageRoot, 'demo'), { recursive: true })
    await writeFile(target, '预先存在', 'utf8')
    const result = await importClaudeMemory(storageRoot, { projectsRoot })
    assert.equal(result.imported, 0)
    assert.equal(result.skipped, 1)
    assert.equal(await readFile(target, 'utf8'), '预先存在')
  })
})

test('重复通用来源不会让导入标记在每次启动持续变化', async () => {
  await fixture(async ({ projectsRoot, storageRoot }) => {
    const firstGeneric = join(projectsRoot, 'encoded-demo', 'memory', '通用基线')
    const secondGeneric = join(projectsRoot, 'encoded-other', 'memory', '通用基线')
    await mkdir(firstGeneric, { recursive: true })
    await mkdir(secondGeneric, { recursive: true })
    await writeFile(join(firstGeneric, '偏好.md'), '短内容', 'utf8')
    await writeFile(join(secondGeneric, '偏好.md'), '更完整的通用偏好内容', 'utf8')
    await importClaudeMemory(storageRoot, { projectsRoot })
    const firstMarker = await readFile(join(storageRoot, 'IMPORTED.md'), 'utf8')
    await importClaudeMemory(storageRoot, { projectsRoot })
    const secondMarker = await readFile(join(storageRoot, 'IMPORTED.md'), 'utf8')
    assert.equal(secondMarker, firstMarker)
    assert.equal(await readFile(join(storageRoot, '通用', '偏好.md'), 'utf8'), '更完整的通用偏好内容')
  })
})
