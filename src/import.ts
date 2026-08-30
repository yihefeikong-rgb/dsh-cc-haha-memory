/**
 * dsh-memory 导入层:从 Claude Code 的记忆目录
 * (~/.claude/projects/ 下每个项目 /memory/) 导入现有记忆到 ~/.dsh/memory/。
 *
 * 结构策略(与 Claude 一致:每个项目一个文件夹,项目间互不冲突):
 *   ~/.dsh/memory/
 *   ├── 通用/               跨项目通用基线(每个项目都有的"通用基线"目录,
 *   │                       内容去重后只保留一份)
 *   ├── <项目名>/           每个 Claude 项目一个文件夹(项目名 = 该项目
 *   │   └── *.md            首个 session 文件的真实 cwd basename)
 *   └── ...
 *
 * 其他规则:
 *   - 同文件夹内同名文件(内容不同)只保留内容最完整的一份
 *   - source 记录来源项目;幂等标记 IMPORTED.md(源路径 → 目标 rel)
 */
import { readFile, writeFile, mkdir, readdir, stat, rename, unlink } from 'node:fs/promises'
import { join, basename, relative, sep } from 'node:path'
import { homedir } from 'node:os'

const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects')
const MARKER = 'IMPORTED.md'

/** 跨项目通用记忆的目录名(每个项目里都有一份,去重后放顶层"通用")。 */
const GENERIC_SUBDIRS = new Set(['通用基线', '用户画像', '通用'])

/** 扫描 Claude 项目(目录名 + 该项目记忆文件)。 */
async function findClaudeProjects(projectsRoot) {
  const projects = []
  let entries
  try {
    entries = await readdir(projectsRoot, { withFileTypes: true })
  } catch {
    return projects
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const memRoot = join(projectsRoot, e.name, 'memory')
    try {
      await stat(memRoot)
    } catch {
      continue
    }
    const files = []
    const walk = async (dir) => {
      let list
      try {
        list = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const f of list) {
        if (f.name === 'MEMORY.md') continue
        const abs = join(dir, f.name)
        if (f.isDirectory()) await walk(abs)
        else if (f.isFile() && f.name.endsWith('.md')) files.push(abs)
      }
    }
    await walk(memRoot)
    if (files.length > 0) projects.push({ dir: e.name, files })
  }
  return projects
}

/** 读项目真实路径:首个 session 文件的 cwd;找不到则启发式解码。 */
async function resolveProjectName(projectDir, projectsRoot = CLAUDE_PROJECTS) {
  const dir = join(projectsRoot, projectDir)
  let entries
  try {
    entries = await readdir(dir)
  } catch {
    return null
  }
  const sessions = entries.filter((f) => f.endsWith('.jsonl')).slice(0, 3)
  for (const s of sessions) {
    try {
      const raw = await readFile(join(dir, s), 'utf8')
      for (const line of raw.split('\n').slice(0, 60)) {
        if (!line.includes('cwd')) continue
        const parsed = JSON.parse(line)
        const cwd = parsed?.cwd
        if (typeof cwd === 'string' && cwd.trim()) {
          return safeProjectName(basename(cwd.replace(/[\\/]+$/, '')).trim(), projectDir)
        }
      }
    } catch {
      /* 单文件失败继续 */
    }
  }
  return decodeProjectName(projectDir)
}

/** 启发式解码 Claude 项目目录名(\→--, 空格→-)。 */
function decodeProjectName(dir) {
  let p = dir.replace(/^([A-Za-z])-/, '$1:/')
  p = p.replace(/--/g, '/')
  p = p.replace(/-/g, ' ')
  return safeProjectName(p.split(/[/\\]/).pop().trim(), dir)
}

function safeProjectName(value, fallback) {
  const cleaned = String(value ?? '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim()
  if (cleaned && !/^[A-Za-z]_?$/.test(cleaned)) return cleaned
  return String(fallback ?? 'claude-project').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '') || 'claude-project'
}

/**
 * 执行非破坏增量导入。已记录源文件或已存在目标文件一律跳过，
 * 永不覆盖 DSH 中已经修改过的记忆，也不删除任何旧目录。
 */
export async function importClaudeMemory(storageRoot, options = {}) {
  const projectsRoot = options.projectsRoot ?? CLAUDE_PROJECTS
  const projects = await findClaudeProjects(projectsRoot)
  await mkdir(storageRoot, { recursive: true })
  const markerPath = join(storageRoot, MARKER)
  const marker = await readMarker(markerPath)
  let imported = 0
  let skipped = 0
  let total = 0

  // 每个项目:通用基线文件 → 顶层"通用",项目特定文件 → <项目名> 文件夹
  const genericByName = new Map() // 通用文件按文件名保留最完整一份(跨项目去重)

  for (const project of projects) {
    const projectName = (await resolveProjectName(project.dir, projectsRoot)) ?? project.dir
    // 解析不出真实项目名(会话缺 cwd 且 slug 解码失败)→ 跳过,
    // 避免每次启动都重建 D--... 机器 slug 目录
    if (projectName === project.dir) continue

    // 项目内同名文件保留内容最完整的一份
    const byName = new Map()
    for (const abs of project.files) {
      let content
      try {
        content = await readFile(abs, 'utf8')
      } catch {
        continue
      }
      total++
      const key = basename(abs)
      const existing = byName.get(key)
      if (!existing || content.length > existing.content.length) byName.set(key, { abs, content })
    }

    // 只有存在待写入的项目文件时才创建目标目录(不建空目录)
    const pendingFiles = [...byName.values()]
      .filter(({ abs }) => !GENERIC_SUBDIRS.has(basename(join(abs, '..'))))
      .filter(({ abs }) => !marker[abs])
    if (pendingFiles.length === 0) continue

    const targetRoot = join(storageRoot, projectName)
    await mkdir(targetRoot, { recursive: true })

    for (const { abs, content } of byName.values()) {
      // 通用基线目录 → 顶层"通用"(跨项目内容去重,只留最完整一份)
      const inGenericDir = GENERIC_SUBDIRS.has(basename(join(abs, '..')))
      if (inGenericDir) {
        const key = basename(abs)
        const existing = genericByName.get(key)
        if (!existing || content.length > existing.content.length) {
          genericByName.set(key, { abs, content })
        }
        continue
      }
      if (marker[abs]) { skipped++; continue }
      const target = join(targetRoot, basename(abs))
      const tagged = tagSource(content, projectName)
      const written = await writeNew(target, tagged)
      marker[abs] = relative(storageRoot, target).split(sep).join('/')
      if (written) imported++
      else skipped++
    }
  }

  // 写入通用记忆(去重后)
  if (genericByName.size > 0) {
    const genericRoot = join(storageRoot, '通用')
    await mkdir(genericRoot, { recursive: true })
    for (const { abs, content } of genericByName.values()) {
      if (marker[abs]) { skipped++; continue }
      const target = join(genericRoot, basename(abs))
      const written = await writeNew(target, tagSource(content, '通用'))
      marker[abs] = relative(storageRoot, target).split(sep).join('/')
      if (written) imported++
      else skipped++
    }
  }

  await atomicWriteMarker(markerPath, marker)
  return { imported, skipped, total }
}

async function readMarker(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

async function writeNew(path, content) {
  try {
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx' })
    return true
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    throw error
  }
}

async function atomicWriteMarker(path, marker) {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    await rename(temp, path)
  } finally {
    await unlink(temp).catch(() => {})
  }
}

/** 在 frontmatter 里补 source 字段(保留正文不变)。 */
function tagSource(content, project) {
  if (!project) return content
  const lines = content.split('\n')
  if (lines[0]?.trim() !== '---') return content
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i
      break
    }
  }
  if (end === -1) return content
  for (let i = 1; i < end; i++) {
    if (lines[i].startsWith('source:')) return content
  }
  lines.splice(end, 0, `source: claude:${project}`)
  return lines.join('\n')
}
