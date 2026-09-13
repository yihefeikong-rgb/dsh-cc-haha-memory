/**
 * dsh-memory 会话页「记忆」tab:按文件夹(分类)分组浏览/搜索/查看/编辑。
 * 通过同源 fetch 调用 /memory/api/*。
 * 配色全部走 DSH 语义变量(--dsw-alias-*),深浅主题自动适配。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'

const TYPES = [
  { value: 'user', label: '用户画像' },
  { value: 'feedback', label: '反馈' },
  { value: 'project', label: '项目状态' },
  { value: 'reference', label: '参考' },
]

const EMPTY = { title: '', content: '', type: 'reference', tags: [], scope: 'project' }

// 主题适配:背景/文字/边框/交互态全部引用 DSH 语义变量(随 data-ds-dark-theme 切换)
const theme = {
  border: '1px solid var(--dsw-alias-border-l2)',
  muted: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
  chip: { fontSize: 11, color: 'var(--dsw-alias-label-caption)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '0 6px' },
  field: { background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l2)' },
  btn: { background: 'var(--dsw-alias-interactive-bg-hover)', color: 'var(--dsw-alias-label-secondary)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, cursor: 'pointer' },
}

async function api(path, options = {}, sessionId = '') {
  const separator = path.includes('?') ? '&' : '?'
  const response = await fetch(`/memory/api/${path}${separator}sessionId=${encodeURIComponent(sessionId)}`, options)
  const data = await response.json().catch(() => ({}))
  if (!data.ok) throw new Error(data.error ?? `请求失败: ${response.status}`)
  return data
}

export default function MemoryPanel({ sessionId, useSessions }) {
  const cwd = useSessions((state) => state.byId?.[sessionId]?.cwd)
  const [entries, setEntries] = useState([])
  const [selected, setSelected] = useState(null)
  const [editing, setEditing] = useState(null)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState({}) // section -> 是否展开
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [scopeInfo, setScopeInfo] = useState({ project: null, scopes: ['通用'], cwdKnown: false })

  const refresh = useCallback(async (q = '') => {
    setLoading(true)
    setError('')
    try {
      if (q.trim()) {
        const data = await api(`search?q=${encodeURIComponent(q)}&limit=100`, {}, sessionId)
        setEntries((data.results ?? []).map((r) => ({ ...r, section: pathSection(r.id ?? r.rel) })))
      } else {
        const data = await api('index', {}, sessionId)
        setEntries(data.entries ?? [])
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    void api('scope', {}, sessionId)
      .then((data) => setScopeInfo(data))
      .catch((e) => setError(e.message))
  }, [sessionId, cwd])

  // 按 section 分组(文件夹视图)
  const groups = useMemo(() => {
    const map = new Map()
    for (const e of entries) {
      const section = e.section || '未分类'
      if (!map.has(section)) map.set(section, [])
      map.get(section).push(e)
    }
    return [...map.entries()]
  }, [entries])

  const toggleSection = useCallback((section) => {
    setExpanded((prev) => ({ ...prev, [section]: !prev[section] }))
  }, [])

  const openEntry = useCallback(async (entry) => {
    try {
      const data = await api(`get?id=${encodeURIComponent(entry.rel ?? entry.id ?? entry.title)}`, {}, sessionId)
      setSelected(data.memory)
      setEditing(null)
    } catch (e) {
      setError(e.message)
    }
  }, [sessionId])

  const save = useCallback(async () => {
    if (!editing?.title?.trim() || !editing?.content?.trim()) {
      setError('标题和内容不能为空')
      return
    }
    try {
      if (editing.__new) {
        await api('write', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: editing.title,
            content: editing.content,
            type: editing.type,
            tags: editing.tags,
            description: editing.content.split('\n')[0].slice(0, 120),
            scope: editing.scope,
          }),
        }, sessionId)
      } else {
        await api('update', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: editing.id, ...editing, __new: undefined }),
        }, sessionId)
      }
      setEditing(null)
      setSelected(null)
      setNotice(editing.__new ? '已写入' : '已更新')
      setTimeout(() => setNotice(''), 2000)
      void refresh(query)
    } catch (e) {
      setError(e.message)
    }
  }, [editing, query, refresh, sessionId])

  const remove = useCallback(async (entry) => {
    if (!window.confirm(`删除记忆「${entry.title ?? entry.id}」?`)) return
    try {
      await api('delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: entry.id }),
      }, sessionId)
      setSelected(null)
      setNotice('已删除')
      setTimeout(() => setNotice(''), 2000)
      void refresh(query)
    } catch (e) {
      setError(e.message)
    }
  }, [query, refresh, sessionId])

  const runImport = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api('import', { method: 'POST' }, sessionId)
      setNotice(`导入完成:新增 ${data.imported ?? 0},跳过 ${data.skipped ?? 0}`)
      setTimeout(() => setNotice(''), 4000)
      void refresh(query)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [query, refresh, sessionId])

  const { border, muted, chip, field, btn } = theme

  return (
    <div style={{ padding: '12px 0' }}>
      {error && <div style={{ color: 'var(--dsw-alias-state-error-primary)', marginBottom: 8 }}>⚠ {error}</div>}
      {notice && <div style={{ color: 'var(--dsw-alias-state-success-primary)', marginBottom: 8 }}>✓ {notice}</div>}
      <div style={{ ...muted, marginBottom: 8 }}>
        当前作用域：通用{scopeInfo.project ? ` + ${scopeInfo.project}` : '（未识别项目，仅通用）'}
      </div>

      {/* 顶部:搜索 + 操作 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center' }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void refresh(e.target.value)}
          placeholder="搜索记忆…"
          style={{ flex: 1, padding: '6px 10px', borderRadius: 6, ...field }}
        />
        <button onClick={() => { setEditing({ ...EMPTY, scope: scopeInfo.project ? 'project' : 'general', __new: true }); setSelected(null) }} style={{ padding: '6px 14px', ...btn }}>＋ 新建</button>
        <button onClick={() => void runImport()} style={{ padding: '6px 14px', ...btn }}>导入</button>
      </div>

      {/* 文件夹分类视图 */}
      {loading && <div style={{ ...muted, padding: 8 }}>加载中…</div>}
      {!loading && groups.length === 0 && <div style={{ ...muted, padding: 8 }}>暂无记忆</div>}
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        {/* 左:文件夹树 */}
        <div style={{ flex: 1, minWidth: 300 }}>
          {groups.map(([section, items]) => {
            const open = expanded[section] ?? false
            return (
              <div key={section} style={{ marginBottom: 6, border, borderRadius: 8, overflow: 'hidden' }}>
                <div
                  onClick={() => toggleSection(section)}
                  style={{ padding: '7px 10px', cursor: 'pointer', fontWeight: 600, fontSize: 13, background: 'var(--dsw-alias-interactive-bg-hover)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                >
                  <span>📁 {section}</span>
                  <span style={chip}>{items.length}</span>
                </div>
                {open && (
                  <div style={{ padding: '4px 6px' }}>
                    {items.map((e) => (
                      <div
                        key={e.rel ?? e.id ?? e.title}
                        onClick={() => void openEntry(e)}
                        style={{ padding: '6px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}
                        onMouseEnter={(ev) => { ev.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)' }}
                        onMouseLeave={(ev) => { ev.currentTarget.style.background = '' }}
                      >
                        <div style={{ fontWeight: 500 }}>{e.title ?? e.id}</div>
                        <div style={{ ...muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.description}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* 右:详情/编辑 */}
        <div style={{ flex: 1.4, border, borderRadius: 8, padding: 12, minHeight: 300 }}>
          {editing ? (
            <div>
              <input value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} placeholder="标题" style={{ width: '100%', padding: 6, marginBottom: 8, borderRadius: 4, ...field }} />
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <select value={editing.type} onChange={(e) => setEditing({ ...editing, type: e.target.value })} style={{ padding: 6, borderRadius: 4, ...field }}>
                  {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <input value={(editing.tags ?? []).join(', ')} onChange={(e) => setEditing({ ...editing, tags: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} placeholder="标签(逗号分隔)" style={{ flex: 1, padding: 6, borderRadius: 4, ...field }} />
              </div>
              {editing.__new && (
                <div style={{ marginBottom: 8 }}>
                  <select value={editing.scope} onChange={(e) => setEditing({ ...editing, scope: e.target.value })} style={{ padding: 6, borderRadius: 4, ...field }}>
                    {scopeInfo.project && <option value="project">当前项目：{scopeInfo.project}</option>}
                    <option value="general">通用记忆</option>
                  </select>
                </div>
              )}
              <textarea value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value })} placeholder="内容(Markdown)" style={{ width: '100%', height: 260, padding: 6, borderRadius: 4, ...field, fontFamily: 'monospace', fontSize: 12 }} />
              <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                <button onClick={() => void save()} style={{ padding: '6px 16px', ...btn }}>保存</button>
                <button onClick={() => setEditing(null)} style={{ padding: '6px 16px', ...btn }}>取消</button>
              </div>
            </div>
          ) : selected ? (
            <div>
              <h3 style={{ margin: '0 0 4px', fontSize: 15 }}>{selected.name}</h3>
              <div style={muted}>
                类型:{TYPES.find((t) => t.value === selected.type)?.label ?? selected.type}
                {selected.tags?.length > 0 && <> · 标签:{selected.tags.join(', ')}</>}
                {selected.updated && <> · 更新:{selected.updated.slice(0, 10)}</>}
                <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-caption)' }}>{selected.path}</div>
              </div>
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.6, margin: '8px 0' }}>{selected.content}</pre>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => setEditing({ ...selected })} style={{ padding: '6px 16px', ...btn }}>编辑</button>
                <button onClick={() => void remove(selected)} style={{ padding: '6px 16px', ...btn, color: 'var(--dsw-alias-state-error-primary)' }}>删除</button>
              </div>
            </div>
          ) : (
            <div style={{ ...muted, paddingTop: 24, textAlign: 'center' }}>选择左侧记忆查看详情,或点「＋ 新建」记录新记忆</div>
          )}
        </div>
      </div>
    </div>
  )
}

function pathSection(value) {
  const normalized = String(value ?? '').replaceAll('\\', '/')
  return normalized.includes('/') ? normalized.split('/')[0] : '未分类'
}
