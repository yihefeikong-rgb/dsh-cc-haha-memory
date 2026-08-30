/**
 * dsh-memory 工具层:注册 memory_* 工具(agent 可直接调用)。
 *
 * 与 Claude Code auto-memory 的能力对齐:
 *   write/read/update/delete/search/list/suggest_tags。
 * 工具注册用纯对象风格(参考 dsh-memory-evolve sessionToolDefinition),
 * 不依赖 @deepseek-ai/dsh-tools 的类型。
 */
import { MEMORY_TYPES, slugify } from './store.ts'
import { GENERAL_SCOPE, resolveProjectScope, scopesForCwd, topScopeFromId } from './scope.ts'

const STR = { type: 'string' }
const STR_ARRAY = { type: 'array', items: { type: 'string' } }

/** 输出块渲染(简单文本)。 */
function renderText(title, text) {
  return [{ type: 'text', text: `${title}\n${String(text ?? '').slice(0, 12000)}` }]
}

/** 统一工具定义构造。 */
function tool(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters: { type: 'object', properties: parameters, required: [] },
    output: { schema: { type: 'object' }, render: (_args, value) => renderText(name, typeof value === 'string' ? value : JSON.stringify(value, null, 2)) },
    async execute(args, exec) {
      return (await execute(args, exec)) ?? {}
    },
  }
}

export function registerMemoryTools(ctx, store) {
  const tools = [
    tool(
      'memory_remember',
      '把用户明确要求记住的信息真实保存到当前项目的独立 Markdown 记忆文件。读取索引发现同主题时传入其 id 更新；未传 id 时仅同名更新，否则新建，禁止用模糊标题覆盖其他主题。' +
        '只有返回 saved=true 后才能向用户确认“已记住”。如首轮尚未暴露此工具，先用 read 读取记忆索引，下一步再调用本工具。',
      {
        title: { ...STR, description: '主题化的短标题；同一主题应保持稳定' },
        content: { ...STR, description: '需要长期保存的完整事实或规则(Markdown)' },
        id: { ...STR, description: '读取索引后发现同主题条目时传入其记忆 id；可选' },
        type: { ...STR, description: '记忆类型', enum: MEMORY_TYPES },
        tags: { ...STR_ARRAY, description: '标签列表(可选)' },
        description: { ...STR, description: '一行概述(可选)' },
        scope: { ...STR, description: 'project=当前项目(默认),general=通用', enum: ['project', 'general'] },
      },
      async (args, exec) => {
        if (!args.title || !args.content) throw new Error('memory_remember 需要 title 和 content')
        const scope = args.scope === 'general' ? GENERAL_SCOPE : currentProjectScope(store, exec)
        const target = await findRememberTarget(store, scope, args.title, args.id)
        if (target?.error) return { ok: false, saved: false, code: target.code, error: target.error }

        if (target?.memory) {
          const result = await store.update(target.memory.id, {
            title: args.title,
            content: args.content,
            type: args.type ?? target.memory.type,
            tags: args.tags ?? target.memory.tags,
            description: args.description ?? target.memory.description,
            scopes: [scope],
          })
          if (!result) return { ok: false, saved: false, code: 'MEMORY_NOT_FOUND', error: `记忆不存在: ${target.memory.id}` }
          return { ok: true, saved: true, action: 'updated', id: result.id, scope, path: result.path, type: result.type }
        }

        const result = await store.write({
          title: args.title,
          content: args.content,
          type: args.type ?? 'reference',
          tags: args.tags,
          description: args.description,
        }, { scope })
        return { ok: true, saved: true, action: 'created', id: result.id, scope, path: result.path, type: result.type }
      },
    ),

    tool(
      'memory_write',
      '写入一条记忆:标题、正文、类型(user=用户画像/feedback=反馈纠正/project=项目状态/reference=通用参考),可选标签。' +
        '写入后自动更新 MEMORY.md 索引。适合:用户明确要求记住、学到用户偏好/纠正/项目事实/外部资料。',
      {
        title: { ...STR, description: '记忆标题(简短,主题化)' },
        content: { ...STR, description: '记忆正文(Markdown)' },
        type: { ...STR, description: '记忆类型', enum: MEMORY_TYPES },
        tags: { ...STR_ARRAY, description: '标签列表(可选)' },
        description: { ...STR, description: '一行概述(索引 hook,可选)' },
        scope: { ...STR, description: '写入范围:project=当前项目(默认),general=通用', enum: ['project', 'general'] },
      },
      async (args, exec) => {
        if (!args.title || !args.content) throw new Error('memory_write 需要 title 和 content')
        const scope = args.scope === 'general' ? GENERAL_SCOPE : currentProjectScope(store, exec)
        try {
          const result = await store.write({
            title: args.title,
            content: args.content,
            type: args.type ?? 'reference',
            tags: args.tags,
            description: args.description,
          }, { scope })
          return { ok: true, saved: true, id: result.id, scope, path: result.path, type: result.type }
        } catch (error) {
          if (error?.code === 'MEMORY_CONFLICT') {
            return { ok: false, saved: false, code: error.code, error: `${error.message};请先 memory_read，再使用 memory_update 更新原条目` }
          }
          throw error
        }
      },
    ),

    tool(
      'memory_read',
      '读取一条记忆的完整内容(含元数据)。先用 memory_search 或 memory_list 找到 id。',
      { id: { ...STR, description: '记忆 id(文件名,不含 .md)' } },
      async (args, exec) => {
        if (!args.id) throw new Error('memory_read 需要 id')
        const memory = await store.get(args.id, { scopes: visibleScopes(store, exec) })
        if (!memory) return { ok: false, error: `记忆不存在: ${args.id}` }
        return { ok: true, ...memory }
      },
    ),

    tool(
      'memory_update',
      '更新一条记忆(标题/正文/类型/标签)。更新前自动保存历史版本到 .history/。',
      {
        id: { ...STR, description: '记忆 id' },
        title: { ...STR, description: '新标题(可选)' },
        content: { ...STR, description: '新正文(可选)' },
        type: { ...STR, description: '新类型(可选)', enum: MEMORY_TYPES },
        tags: { ...STR_ARRAY, description: '新标签(可选,传空数组清空)' },
        description: { ...STR, description: '新概述(可选)' },
      },
      async (args, exec) => {
        if (!args.id) throw new Error('memory_update 需要 id')
        const result = await store.update(args.id, { ...args, scopes: visibleScopes(store, exec) })
        if (!result) return { ok: false, error: `记忆不存在: ${args.id}` }
        return { ok: true, id: result.id, updated: result.updated }
      },
    ),

    tool(
      'memory_delete',
      '删除一条记忆(删除前保存历史版本到 .history/,可恢复)。',
      { id: { ...STR, description: '记忆 id' } },
      async (args, exec) => {
        if (!args.id) throw new Error('memory_delete 需要 id')
        const ok = await store.remove(args.id, { scopes: visibleScopes(store, exec) })
        return ok ? { ok: true } : { ok: false, error: `记忆不存在: ${args.id}` }
      },
    ),

    tool(
      'memory_search',
      '全文搜索记忆:按标题/描述/正文关键词评分返回 Top-N。' +
        '会话开始时可搜索相关记忆获得上下文(参考:用户名/项目名/工具名/主题词)。',
      {
        query: { ...STR, description: '搜索关键词(空格分隔多个词)' },
        type: { ...STR, description: '过滤类型(可选)', enum: MEMORY_TYPES },
        limit: { type: 'number', description: '返回条数(默认 10,最大 50)' },
      },
      async (args, exec) => {
        if (!args.query) throw new Error('memory_search 需要 query')
        const results = await store.search(args.query, { type: args.type, limit: args.limit, scopes: visibleScopes(store, exec) })
        return { ok: true, count: results.length, results }
      },
    ),

    tool(
      'memory_list',
      '列出全部记忆索引(可按类型/标签过滤)。查看整体记忆结构用此工具。',
      {
        type: { ...STR, description: '过滤类型(可选)', enum: MEMORY_TYPES },
        tag: { ...STR, description: '过滤标签(可选)' },
      },
      async (args, exec) => {
        const scopes = visibleScopes(store, exec)
        const entries = await store.manifest(scopes)
        const filtered = entries
          .filter((entry) => !args.type || entry.type === args.type)
          .filter((entry) => !args.tag || entry.tags?.includes(args.tag))
          .map((entry) => ({ ...entry, section: topScopeFromId(entry.id) }))
        return { ok: true, count: filtered.length, entries: filtered }
      },
    ),

    tool(
      'memory_suggest_tags',
      '从已有记忆的标签中推荐相关标签(按频次,可选输入文本做相关性过滤)。',
      { text: { ...STR, description: '输入文本(可选,用于相关性过滤)' } },
      async (args, exec) => {
        const tags = await store.suggestTags(args.text ?? '', 5, { scopes: visibleScopes(store, exec) })
        return { ok: true, tags }
      },
    ),
  ]

  for (const t of tools) {
    ctx.tools.register(t)
  }
  ctx.logger?.info?.('[dsh-memory] registered 8 memory tools')
}

async function findRememberTarget(store, scope, title, requestedId) {
  if (requestedId) {
    if (topScopeFromId(requestedId) !== scope) {
      return { code: 'SCOPE_VIOLATION', error: `记忆 id 不属于当前作用域: ${requestedId}` }
    }
    const memory = await store.get(requestedId, { scopes: [scope] })
    return memory ? { memory } : { code: 'MEMORY_NOT_FOUND', error: `记忆不存在: ${requestedId}` }
  }

  const exact = await store.get(`${scope}/${slugify(title)}`, { scopes: [scope] })
  if (exact) return { memory: exact }

  return null
}

function cwdFromExec(exec) {
  return exec?.agent?.session?.header?.cwd
}

function currentProjectScope(store, exec) {
  const scope = resolveProjectScope(store.root, cwdFromExec(exec))
  if (scope) return scope
  const error = new Error('无法确认当前项目，拒绝把项目记忆写入通用作用域；如确需跨项目记忆，请明确设置 scope=general')
  error.code = 'PROJECT_SCOPE_UNRESOLVED'
  throw error
}

function visibleScopes(store, exec) {
  return scopesForCwd(store.root, cwdFromExec(exec))
}
