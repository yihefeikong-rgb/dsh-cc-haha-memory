/**
 * dsh-memory 插件入口:结构化记忆系统(复刻 Claude Code auto-memory)。
 *
 * 能力:
 *  - 8 个 memory_* 工具(agent 调用，含显式 memory_remember)
 *  - 回合后自动记录(llm 判断 → 写入)
 *  - 会话启动注入 MEMORY.md 索引
 *  - 首次启动导入 Claude Code 现有记忆
 *  - /memory HTTP API + 设置页「记忆」tab(client)
 */
import z from '@deepseek-ai/schemastery'
import { MemoryStore, defaultStorageDir, INDEX_FILE } from './store.js'
import { importClaudeMemory } from './import.js'
import { registerMemoryTools } from './tools.js'
import { TurnRecorder } from './recorder.js'
import { installRecall } from './recall.js'
import { installMemoryApi } from './api.js'
import { seedClaudeProjectMappings } from './scope.ts'

export const name = 'dsh-memory'

export const inject = ['tools', 'systemPrompt', 'agents', 'llm', 'settings']

export const Config = z.object({
  storageDir: z.string().default(defaultStorageDir()).description('记忆存储目录(默认 ~/.dsh/memory)'),
  reviewEnabled: z.boolean().default(true).description('回合后自动记录'),
  reviewInterval: z.natural().min(1).default(5).description('每 N 回合评审一次'),
  reviewMaxTokens: z.natural().min(64).default(1000).description('单次评审输出上限'),
  reviewTimeoutMs: z.natural().min(1000).default(120000).description('自动记录评审总超时(ms)'),
  provider: z.string().default('').description('自动记录 provider(空=继承会话)'),
  model: z.string().default('').description('自动记录 model(空=继承会话)'),
  recallOrder: z.number().default(117).description('索引注入顺序'),
  recallMaxBytes: z.natural().min(1024).default(25000).description('注入索引上限字节'),
  recallRelevantMaxBytes: z.natural().min(1024).default(16000).description('相关记忆正文注入上限字节'),
})

export function apply(ctx, config = {}) {
  const storageDir = config.storageDir ?? defaultStorageDir()
  const store = new MemoryStore(storageDir)

  // 初始化存储 + 首次导入 Claude 记忆(幂等,失败不阻塞)
  void (async () => {
    try {
      await store.ensureDirs()
      await store.refreshIndex()
      const result = await importClaudeMemory(storageDir)
      seedClaudeProjectMappings(storageDir)
      await store.refreshIndex()
      if (result.imported > 0) {
        ctx.logger?.info?.(`[dsh-memory] imported ${result.imported} memory(ies) from Claude Code`)
      }
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-memory] init failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })()

  // 工具
  registerMemoryTools(ctx, store)

  // 回合后自动记录
  const recorder = new TurnRecorder(ctx, store, config)
  recorder.install()

  // 会话回顾注入
  installRecall(ctx, store, config)

  // HTTP API(web-only 服务动态注入)
  installMemoryApi(ctx, store, importClaudeMemory)

  ctx.logger?.info?.(`[dsh-memory] ready; storage=${storageDir} (index=${INDEX_FILE})`)
}

export default { name, inject, Config, apply }
