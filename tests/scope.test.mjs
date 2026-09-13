import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GENERAL_SCOPE, resolveProjectScope, scopesForCwd, seedClaudeProjectMappings } from '../src/scope.ts'

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-scope-'))
  const memory = join(root, 'memory')
  const repo = join(root, 'workspace', 'demo')
  await mkdir(join(repo, '.git'), { recursive: true })
  await mkdir(memory, { recursive: true })
  try {
    await fn({ root, memory, repo })
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 })
  }
}

test('未知 cwd 只返回通用作用域', async () => {
  await fixture(async ({ memory }) => {
    assert.deepEqual(scopesForCwd(memory, undefined), [GENERAL_SCOPE])
  })
})

test('Git 仓库子目录映射到同一项目', async () => {
  await fixture(async ({ memory, repo }) => {
    const child = join(repo, 'src', 'nested')
    await mkdir(child, { recursive: true })
    assert.equal(resolveProjectScope(memory, repo), 'demo')
    assert.equal(resolveProjectScope(memory, child), 'demo')
    assert.deepEqual(scopesForCwd(memory, child), [GENERAL_SCOPE, 'demo'])
  })
})

test('优先复用现有同名项目文件夹', async () => {
  await fixture(async ({ root, memory, repo }) => {
    await mkdir(join(memory, 'Demo'), { recursive: true })
    await writeFile(join(memory, 'Demo', 'existing.md'), 'x', 'utf8')
    const claudeRoot = join(root, 'claude-projects')
    const claudeProject = join(claudeRoot, 'encoded-demo')
    await mkdir(claudeProject, { recursive: true })
    await writeFile(join(claudeProject, 'session.jsonl'), `${JSON.stringify({ cwd: repo })}\n`, 'utf8')
    seedClaudeProjectMappings(memory, claudeRoot)
    assert.equal(resolveProjectScope(memory, repo), 'Demo')
  })
})

test('无路径证据时不认领同名旧目录', async () => {
  await fixture(async ({ memory, repo }) => {
    await mkdir(join(memory, 'demo'), { recursive: true })
    assert.match(resolveProjectScope(memory, repo), /^demo-[0-9a-f]{8}$/)
  })
})

test('点开头项目名会转换成安全作用域', async () => {
  await fixture(async ({ root, memory }) => {
    const repo = join(root, '.dotfiles')
    await mkdir(join(repo, '.git'), { recursive: true })
    assert.equal(resolveProjectScope(memory, repo), 'dot-dotfiles')
  })
})

test('同名不同路径项目使用哈希后缀避免冲突', async () => {
  await fixture(async ({ root, memory, repo }) => {
    const first = resolveProjectScope(memory, repo)
    const other = join(root, 'other', 'demo')
    await mkdir(join(other, '.git'), { recursive: true })
    const second = resolveProjectScope(memory, other)
    assert.equal(first, 'demo')
    assert.match(second, /^demo-[0-9a-f]{8}$/)
    assert.notEqual(first, second)
  })
})
