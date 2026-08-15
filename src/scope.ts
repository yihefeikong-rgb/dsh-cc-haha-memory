import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, dirname, join, normalize, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

const REGISTRY_FILE = '.projects.json'
export const GENERAL_SCOPE = '通用'

function canonicalPath(path) {
  try {
    return normalize(realpathSync(path)).replace(/[\\/]+$/, '').toLowerCase()
  } catch {
    return normalize(resolve(path)).replace(/[\\/]+$/, '').toLowerCase()
  }
}

function findProjectRoot(cwd) {
  let current = resolve(cwd)
  while (true) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

export function sanitizeScopeName(value) {
  let cleaned = String(value ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64)
  if (cleaned.startsWith('.')) cleaned = `dot-${cleaned.replace(/^\.+/, '') || 'project'}`
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'project'
}

export function isSafeScopeName(value) {
  return typeof value === 'string'
    && value.length > 0
    && value === sanitizeScopeName(value)
    && !value.startsWith('.')
    && !value.includes('/')
    && !value.includes('\\')
}

function loadRegistry(memoryRoot) {
  try {
    const parsed = JSON.parse(readFileSync(join(memoryRoot, REGISTRY_FILE), 'utf8'))
    return parsed?.version === 1 && parsed.paths && typeof parsed.paths === 'object'
      ? parsed
      : { version: 1, paths: {} }
  } catch {
    return { version: 1, paths: {} }
  }
}

function saveRegistry(memoryRoot, registry) {
  mkdirSync(memoryRoot, { recursive: true })
  const target = join(memoryRoot, REGISTRY_FILE)
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temp, JSON.stringify(registry, null, 2), 'utf8')
  renameSync(temp, target)
}

function existingScope(memoryRoot, name) {
  try {
    return readdirSync(memoryRoot, { withFileTypes: true })
      .find((entry) => entry.isDirectory() && entry.name.toLowerCase() === name.toLowerCase())
      ?.name
  } catch {
    return undefined
  }
}

/**
 * 将当前 cwd 解析为稳定项目作用域。同一 Git 仓库的子目录共享作用域；
 * 无 cwd 时返回 null，调用方只能使用通用记忆。
 */
export function resolveProjectScope(memoryRoot, cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) return null
  const root = findProjectRoot(cwd.trim())
  const key = canonicalPath(root)
  const registry = loadRegistry(memoryRoot)
  const mapped = registry.paths[key]
  if (isSafeScopeName(mapped)) return mapped

  const base = sanitizeScopeName(basename(root))
  const usedByOtherPath = Object.entries(registry.paths)
    .some(([path, scope]) => path !== key && String(scope).toLowerCase() === base.toLowerCase())
  let scope = base
  const unownedExisting = existingScope(memoryRoot, base)
  if (scope === GENERAL_SCOPE || usedByOtherPath || unownedExisting) {
    const suffix = createHash('sha256').update(key).digest('hex').slice(0, 8)
    scope = `${base}-${suffix}`
  }
  registry.paths[key] = scope
  saveRegistry(memoryRoot, registry)
  return scope
}

/**
 * 用 Claude 会话中的真实 cwd 为已导入项目目录建立所有权映射。
 * 没有 cwd 证据的同名目录不会被自动认领。
 */
export function seedClaudeProjectMappings(memoryRoot, claudeProjectsRoot = join(homedir(), '.claude', 'projects')) {
  const registry = loadRegistry(memoryRoot)
  let changed = false
  let projects = []
  try { projects = readdirSync(claudeProjectsRoot, { withFileTypes: true }) } catch { return 0 }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = join(claudeProjectsRoot, project.name)
    let sessions = []
    try {
      sessions = readdirSync(projectDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
        .slice(0, 5)
    } catch { continue }
    for (const session of sessions) {
      const cwd = readSessionCwd(join(projectDir, session.name))
      if (!cwd) continue
      const root = findProjectRoot(cwd)
      const key = canonicalPath(root)
      if (isSafeScopeName(registry.paths[key])) break
      const base = sanitizeScopeName(basename(root))
      const existing = existingScope(memoryRoot, base)
      if (!existing) break
      const claimed = Object.entries(registry.paths)
        .some(([path, scope]) => path !== key && String(scope).toLowerCase() === existing.toLowerCase())
      if (!claimed && existing !== GENERAL_SCOPE) {
        registry.paths[key] = existing
        changed = true
      }
      break
    }
  }
  if (changed) saveRegistry(memoryRoot, registry)
  return changed ? 1 : 0
}

function readSessionCwd(path) {
  try {
    const lines = readFileSync(path, 'utf8').split(/\r?\n/).slice(0, 100)
    for (const line of lines) {
      if (!line.includes('cwd')) continue
      try {
        const parsed = JSON.parse(line)
        if (typeof parsed?.cwd === 'string' && parsed.cwd.trim()) return parsed.cwd.trim()
      } catch { /* 继续下一行 */ }
    }
  } catch { /* 单个会话不可读 */ }
  return null
}

export function scopesForCwd(memoryRoot, cwd) {
  const project = resolveProjectScope(memoryRoot, cwd)
  return project ? [GENERAL_SCOPE, project] : [GENERAL_SCOPE]
}

export function topScopeFromId(id) {
  const normalized = String(id ?? '').replace(/\\/g, '/')
  return normalized.includes('/') ? normalized.split('/')[0] : ''
}

export { REGISTRY_FILE }
