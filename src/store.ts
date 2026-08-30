/**
 * dsh-memory 存储层:记忆文件读写、frontmatter 解析、MEMORY.md 索引管理、
 * 历史版本、搜索评分。纯 node API,零依赖。
 *
 * 目录结构(与 Claude Code auto-memory 同构):
 *   ~/.dsh/memory/
 *   ├── MEMORY.md          索引
 *   ├── imported/          从 Claude 导入的记忆
 *   ├── 用户画像/ 项目状态/ 工具参考/ 反馈/ 归档/
 *   └── <title>.md         记忆文件(Markdown + YAML frontmatter)
 */
import { mkdir, readFile, writeFile, readdir, stat, rename, unlink } from 'node:fs/promises'
import { join, basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { GENERAL_SCOPE, isSafeScopeName, topScopeFromId } from './scope.ts'

/** 记忆类型 → 目录名。archive 表示归档(不参与常规搜索)。 */
export const TYPE_DIRS = {
  user: '用户画像',
  feedback: '反馈',
  project: '项目状态',
  reference: '工具参考',
  archive: '归档',
}

/** 索引渲染顺序(对齐 Claude Code 四类型 + 归档)。 */
export const TYPE_ORDER = [
  ['user', '用户画像'],
  ['feedback', '反馈'],
  ['project', '项目状态'],
  ['reference', '工具参考'],
  ['archive', '归档'],
]

export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference', 'archive']

export const INDEX_FILE = 'MEMORY.md'

/** 默认记忆根目录。 */
export function defaultStorageDir() {
  return join(homedir(), '.dsh', 'memory')
}

/** 记忆条目的运行时表示。 */
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { meta: {}, body: text }
  const meta = {}
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    if (value === 'null') value = null
    meta[key] = value
  }
  return { meta, body: text.slice(match[0].length) }
}

/** 序列化为 Markdown + YAML frontmatter。 */
export function serializeMemory(memory) {
  const lines = ['---']
  if (memory.name) lines.push(`name: ${frontmatterLine(memory.name)}`)
  if (memory.description) lines.push(`description: ${frontmatterLine(memory.description)}`)
  if (memory.type) lines.push(`type: ${frontmatterLine(memory.type)}`)
  if (memory.created) lines.push(`created: ${frontmatterLine(memory.created)}`)
  if (memory.updated) lines.push(`updated: ${frontmatterLine(memory.updated)}`)
  if (Array.isArray(memory.tags) && memory.tags.length > 0) {
    lines.push(`tags: [${memory.tags.map((t) => `"${String(t).replaceAll('"', '\\"')}"`).join(', ')}]`)
  }
  if (memory.source) lines.push(`source: ${frontmatterLine(memory.source)}`)
  lines.push('---', '')
  const body = typeof memory.content === 'string' ? memory.content : ''
  return lines.join('\n') + body + (body.endsWith('\n') ? '' : '\n')
}

function frontmatterLine(value) {
  return String(value ?? '').replace(/\r?\n/g, ' ').trim()
}

/** title → 文件名(保留中文,清理非法字符,截断)。 */
export function slugify(title) {
  const cleaned = String(title ?? 'untitled')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48)
  return cleaned || 'untitled'
}

/** 按类型取子目录名(非内置类型归 archive 处理外的分类目录)。 */
export function dirForType(type) {
  return TYPE_DIRS[type] ?? '归档'
}

export class MemoryStore {
  constructor(root) {
    this.root = resolve(root)
    this.writeQueue = Promise.resolve()
  }

  /** 记忆文件绝对路径。id 即文件名(不含 .md)。 */
  pathOf(id) {
    const safeId = normalizeId(id)
    const abs = resolve(this.root, `${safeId}.md`)
    if (!isWithin(this.root, abs)) throw new Error('记忆路径越界')
    return abs
  }

  async ensureDirs() {
    const dirs = [this.root, join(this.root, '.history')]
    for (const d of dirs) await mkdir(d, { recursive: true })
  }

  /** 列出所有记忆文件(不含 imported 内部结构,含子目录),返回 {id, absPath}。 */
  async scan(opts = {}) {
    const allowedScopes = normalizeScopes(opts.scopes)
    const found = []
    const walk = async (dir) => {
      let entries = []
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (e.name === INDEX_FILE || e.name === '.history' || e.name === 'IMPORTED.md') continue
        const abs = join(dir, e.name)
        if (e.isDirectory()) await walk(abs)
        else if (e.isFile() && e.name.endsWith('.md')) {
          const id = relative(this.root, abs).replace(/\.md$/i, '').split(sep).join('/')
          if (!allowedScopes || allowedScopes.has(topScopeFromId(id))) found.push({ id, abs })
        }
      }
    }
    await walk(this.root)
    return found
  }

  /** 读单条记忆(含 frontmatter 元数据)。id 支持相对路径或文件名。 */
  async get(id, opts = {}) {
    const normalizedId = normalizeId(id)
    const files = await this.scan({ scopes: opts.scopes })
    const exact = files.find((f) => f.id === normalizedId)
    const matches = exact ? [exact] : files.filter((f) => f.id.endsWith(`/${normalizedId}`) || basename(f.abs, '.md') === normalizedId)
    if (matches.length !== 1) return null
    const abs = matches[0].abs
    let text
    try {
      text = await readFile(abs, 'utf8')
    } catch {
      return null
    }
    const { meta, body } = parseFrontmatter(text)
    return {
      id: matches[0].id,
      name: meta.name ?? basename(abs, '.md'),
      description: meta.description ?? '',
      type: meta.type ?? 'reference',
      tags: parseTags(meta.tags),
      created: meta.created ?? '',
      updated: meta.updated ?? '',
      source: meta.source ?? '',
      content: body.trim(),
      path: abs,
    }
  }

  /** 写入记忆。顶层目录表示作用域；默认写入通用，禁止静默覆盖。 */
  async write(input, opts = {}) {
    return this.withWriteLock(async () => {
      await this.ensureDirs()
      const type = MEMORY_TYPES.includes(input.type) ? input.type : 'reference'
      const scope = validateScope(opts.scope ?? GENERAL_SCOPE)
      const id = slugify(opts.id ?? input.title)
      const now = new Date().toISOString()
      const memory = {
        name: input.title,
        description: input.description ?? '',
        type,
        created: input.created ?? now,
        updated: now,
        tags: Array.isArray(input.tags) ? input.tags.filter(Boolean).map(String) : [],
        source: input.source ?? '',
        content: input.content ?? '',
      }
      const dir = resolve(this.root, scope)
      if (!isWithin(this.root, dir)) throw new Error('记忆作用域越界')
      await mkdir(dir, { recursive: true })
      const abs = resolve(dir, `${id}.md`)
      if (!isWithin(dir, abs)) throw new Error('记忆路径越界')
      const existing = await readFile(abs, 'utf8').catch(() => null)
      if (existing !== null && opts.overwrite !== true) {
        const error = new Error(`同名记忆已存在: ${scope}/${id}`)
        error.code = 'MEMORY_CONFLICT'
        throw error
      }
      await atomicWrite(abs, serializeMemory(memory))
      await this.refreshIndexUnlocked()
      const relId = relative(this.root, abs).replace(/\.md$/i, '').split(sep).join('/')
      return { id: relId, scope, path: abs, ...memory }
    })
  }

  /** 更新记忆:先存历史版本再覆盖。 */
  async update(id, patch) {
    return this.withWriteLock(async () => {
      const existing = await this.get(id, { scopes: patch.scopes })
      if (!existing) return null
      if (existing.content.trim() || existing.name) await this.saveHistory(existing.id, existing)
      const next = {
        ...existing,
        name: patch.title ?? existing.name,
        description: patch.description !== undefined ? patch.description : existing.description,
        type: patch.type !== undefined && MEMORY_TYPES.includes(patch.type) ? patch.type : existing.type,
        tags: patch.tags !== undefined ? patch.tags.filter(Boolean).map(String) : existing.tags,
        content: patch.content !== undefined ? patch.content : existing.content,
        updated: new Date().toISOString(),
      }
      await atomicWrite(existing.path, serializeMemory(next))
      await this.refreshIndexUnlocked()
      return { id: existing.id, ...next, path: existing.path }
    })
  }

  /** 删除记忆。 */
  async remove(id, opts = {}) {
    return this.withWriteLock(async () => {
      const existing = await this.get(id, { scopes: opts.scopes })
      if (!existing) return false
      await this.saveHistory(existing.id, existing)
      await unlink(existing.path)
      await this.refreshIndexUnlocked()
      return true
    })
  }

  /** 保存历史版本到 .history/。 */
  async saveHistory(id, memory) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const safeId = String(id).replace(/[\\/:*?"<>|]/g, '_')
    const abs = join(this.root, '.history', `${safeId}.${ts}.md`)
    const text = await readFile(memory.path, 'utf8').catch(() => serializeMemory(memory))
    await writeFile(abs, text, 'utf8')
  }

  /** 全文关键词搜索:标题/描述/内容分词评分。 */
  async search(query, opts = {}) {
    const q = String(query ?? '').trim().toLowerCase()
    if (!q) return []
    const limit = Math.min(opts.limit ?? 10, 50)
    const terms = [...new Set(q.split(/\s+/).filter(Boolean))]
    const files = await this.scan({ scopes: opts.scopes })
    const scored = []
    for (const { id, abs } of files) {
      let text
      try {
        text = await readFile(abs, 'utf8')
      } catch {
        continue
      }
      const { meta } = parseFrontmatter(text)
      if (opts.type && meta.type !== opts.type) continue
      const title = meta.name ?? id
      const description = meta.description ?? ''
      const body = text.slice(0, 4000)
      const hayTitle = title.toLowerCase()
      const hayDesc = description.toLowerCase()
      const hayBody = body.toLowerCase()
      let score = 0
      let hits = 0
      for (const term of terms) {
        if (hayTitle.includes(term)) score += 5
        if (hayDesc.includes(term)) score += 3
        if (hayBody.includes(term)) score += 1
        if (hayTitle.includes(term) || hayDesc.includes(term) || hayBody.includes(term)) hits++
      }
      if (hits === terms.length && score > 0) {
        scored.push({
          id,
          title,
          description,
          type: meta.type ?? 'reference',
          tags: parseTags(meta.tags),
          updated: meta.updated ?? '',
          score,
        })
      }
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit)
  }

  /** 从已有记忆收集标签频次,按输入文本相关性推荐。 */
  async suggestTags(text, limit = 5, opts = {}) {
    const files = await this.scan({ scopes: opts.scopes })
    const freq = new Map()
    for (const { abs } of files) {
      const raw = await readFile(abs, 'utf8').catch(() => '')
      const { meta } = parseFrontmatter(raw)
      for (const tag of parseTags(meta.tags)) {
        freq.set(tag, (freq.get(tag) ?? 0) + 1)
      }
    }
    const lower = String(text ?? '').toLowerCase()
    const sorted = [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([tag]) => tag)
    if (lower) {
      const matched = sorted.filter((t) => t.toLowerCase().includes(lower))
      const rest = sorted.filter((t) => !t.toLowerCase().includes(lower))
      return [...matched, ...rest].slice(0, limit)
    }
    return sorted.slice(0, limit)
  }

  /** 读索引文本。 */
  async readIndex() {
    try {
      return await readFile(join(this.root, INDEX_FILE), 'utf8')
    } catch {
      return ''
    }
  }

  /** 重建 MEMORY.md 索引(按顶层项目文件夹分节,条目 = - [title](rel) — desc)。 */
  async refreshIndex() {
    return this.withWriteLock(() => this.refreshIndexUnlocked())
  }

  async refreshIndexUnlocked() {
    await this.ensureDirs()
    const files = await this.scan()
    const groups = new Map()
    for (const { id, abs } of files) {
      const text = await readFile(abs, 'utf8').catch(() => '')
      const { meta } = parseFrontmatter(text)
      const rel = relative(this.root, abs).split(sep).join('/')
      const topDir = rel.includes('/') ? rel.split('/')[0] : '(根)'
      const entry = {
        title: meta.name ?? basename(abs, '.md'),
        description: meta.description ?? '',
        type: meta.type ?? 'reference',
        updated: meta.updated ?? '',
        rel,
      }
      if (!groups.has(topDir)) groups.set(topDir, [])
      groups.get(topDir).push(entry)
    }
    const lines = ['# 记忆索引', '', `> 自动生成,共 ${files.length} 条记忆。`, '']
    const ordered = [...groups.keys()].sort((a, b) => (a === '通用' ? -1 : b === '通用' ? 1 : a.localeCompare(b, 'zh')))
    for (const dir of ordered) {
      const entries = groups.get(dir)
      if (!entries?.length) continue
      lines.push(`## ${dir}`, '')
      for (const [type, label] of TYPE_ORDER) {
        const typed = entries.filter((e) => (e.type ?? 'reference') === type)
        if (!typed.length) continue
        lines.push(`### ${label}`, '')
        for (const e of typed) {
          const hook = e.description ? ` — ${e.description}` : ''
          lines.push(`- [${e.title}](${e.rel})${hook}`)
        }
        lines.push('')
      }
    }
    await atomicWrite(join(this.root, INDEX_FILE), lines.join('\n'))
  }

  /** 当前所有索引条目(按分类分节的结构化视图)。 */
  async indexEntries() {
    const text = await this.readIndex()
    const entries = []
    let section = '未分类'
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('## ')) section = line.slice(3).trim()
      const m = /^- \[(.+?)\]\((.+?)\)(?: — (.*))?$/.exec(line)
      if (m) {
        entries.push({ title: m[1], rel: m[2], description: m[3] ?? '', section })
      }
    }
    return entries
  }

  async manifest(scopes) {
    const files = await this.scan({ scopes })
    const entries = []
    for (const { id } of files) {
      const memory = await this.get(id, { scopes })
      if (!memory) continue
      entries.push({ id: memory.id, title: memory.name, description: memory.description, type: memory.type, tags: memory.tags, updated: memory.updated })
    }
    return entries
  }

  withWriteLock(operation) {
    const run = this.writeQueue.then(operation, operation)
    this.writeQueue = run.catch(() => {})
    return run
  }
}

function normalizeScopes(scopes) {
  if (!Array.isArray(scopes)) return null
  return new Set(scopes.map(validateScope))
}

function validateScope(scope) {
  if (!isSafeScopeName(scope)) throw new Error(`无效记忆作用域: ${scope}`)
  return scope
}

function normalizeId(id) {
  const value = String(id ?? '').replace(/\\/g, '/').replace(/\.md$/i, '')
  if (!value || value.startsWith('/') || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('无效记忆 id')
  }
  return value
}

function isWithin(root, target) {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

async function atomicWrite(target, content) {
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, content, 'utf8')
  try {
    await rename(temp, target)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

/** tags 字段解析:支持 [a, b] 或 "a, b" 或单值。 */
export function parseTags(raw) {
  if (Array.isArray(raw)) return raw.map(String)
  if (raw === null || raw === undefined || raw === '') return []
  const s = String(raw)
  if (s.startsWith('[') && s.endsWith(']')) {
    return s
      .slice(1, -1)
      .split(',')
      .map((t) => t.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'))
      .filter(Boolean)
  }
  return [s]
}

/** 统计目录大小/条目数(验证用)。 */
export async function memoryStats(root) {
  const store = new MemoryStore(root)
  const files = await store.scan()
  let bytes = 0
  for (const { abs } of files) {
    try {
      bytes += (await stat(abs)).size
    } catch {
      /* 忽略 */
    }
  }
  return { count: files.length, bytes }
}
