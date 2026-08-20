/**
 * dsh-memory HTTP API(client 侧同源 fetch 用)。
 * 路由:prefix /memory,端点:
 *   GET  /memory/api/index?type=     索引条目
 *   GET  /memory/api/get?id=         单条记忆
 *   POST /memory/api/write           写记忆 {title,content,type,tags,description}
 *   POST /memory/api/update          更新 {id,title?,content?,type?,tags?}
 *   POST /memory/api/delete          删除 {id}
 *   GET  /memory/api/search?q=&type=&limit=
 *   GET  /memory/api/suggest-tags?text=
 *   POST /memory/api/import          手动触发 Claude 记忆导入
 * 同源信任(与现有插件一致),JSON,无鉴权,64KB 上限。
 */
import { GENERAL_SCOPE, resolveProjectScope, scopesForCwd } from './scope.ts'

const BODY_LIMIT = 64 * 1024

export function installMemoryApi(ctx, store, importer) {
  ctx.inject(['webServer'], (scope) => {
    scope.webServer.register({
      kind: 'prefix',
      path: '/memory',
      handler: (request, response) => {
        void handle(request, response, ctx, store, importer)
      },
    })
  })
}

export async function handle(request, response, ctx, store, importer) {
  try {
    const url = new URL(request.url, 'http://dsh.local')
    const path = url.pathname.replace(/^\/memory/, '')
    const method = request.method ?? 'GET'
    const sessionId = url.searchParams.get('sessionId') ?? ''
    const scope = requestScope(ctx, store, sessionId)

    if (path === '/api/scope' && method === 'GET') {
      return json(response, 200, { ok: true, project: scope.project, scopes: scope.scopes, cwdKnown: Boolean(scope.cwd) })
    }

    if (path === '/api/index' && method === 'GET') {
      const entries = await store.indexEntries()
      return json(response, 200, { ok: true, entries: entries.filter((entry) => scope.scopes.includes(entry.section)) })
    }
    if (path === '/api/get' && method === 'GET') {
      const id = url.searchParams.get('id')
      const memory = id ? await store.get(id, { scopes: scope.scopes }) : null
      return memory ? json(response, 200, { ok: true, memory }) : json(response, 404, { ok: false, error: '记忆不存在' })
    }
    if (path === '/api/search' && method === 'GET') {
      const q = url.searchParams.get('q') ?? ''
      const results = await store.search(q, {
        type: url.searchParams.get('type') ?? undefined,
        limit: Number(url.searchParams.get('limit') ?? 10),
        scopes: scope.scopes,
      })
      return json(response, 200, { ok: true, count: results.length, results })
    }
    if (path === '/api/suggest-tags' && method === 'GET') {
      const tags = await store.suggestTags(url.searchParams.get('text') ?? '', 5, { scopes: scope.scopes })
      return json(response, 200, { ok: true, tags })
    }
    if (path === '/api/import' && method === 'POST') {
      const result = await importer(store.root)
      return json(response, 200, { ok: true, ...result })
    }
    if (method === 'POST' && ['/api/write', '/api/update', '/api/delete'].includes(path)) {
      const body = await readBody(request)
      if (path === '/api/write') {
        const targetScope = body.scope === 'general' ? GENERAL_SCOPE : scope.project
        if (!targetScope) return json(response, 400, { ok: false, error: '当前会话没有可识别的项目；请选择写入通用记忆' })
        try {
          const memory = await store.write(body, { scope: targetScope })
          return json(response, 200, { ok: true, saved: true, id: memory.id, scope: targetScope })
        } catch (error) {
          if (error?.code === 'MEMORY_CONFLICT') return json(response, 409, { ok: false, saved: false, code: error.code, error: error.message })
          throw error
        }
      }
      if (path === '/api/update') {
        const memory = await store.update(body.id, { ...body, scopes: scope.scopes })
        return memory ? json(response, 200, { ok: true, id: memory.id }) : json(response, 404, { ok: false, error: '记忆不存在' })
      }
      const removed = await store.remove(body.id, { scopes: scope.scopes })
      return removed ? json(response, 200, { ok: true }) : json(response, 404, { ok: false, error: '记忆不存在' })
    }
    return json(response, 404, { ok: false, error: `unknown endpoint: ${method} ${path}` })
  } catch (error) {
    return json(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

function requestScope(ctx, store, sessionId) {
  const agents = ctx.get?.('agents') ?? ctx.agents
  const cwd = sessionId ? agents?.get?.(sessionId)?.session?.header?.cwd : undefined
  const project = resolveProjectScope(store.root, cwd)
  return { cwd, project, scopes: scopesForCwd(store.root, cwd) }
}

function json(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

async function readBody(request) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > BODY_LIMIT) throw new Error('body too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}
