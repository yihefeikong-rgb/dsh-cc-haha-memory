/**
 * dsh-memory client 入口:会话页顶部新增「记忆」tab(对话上方)。
 * loader 格式(banner/footer)由 scripts/build.mjs 包装。
 */
import MemoryPanel from './Panel'

export const inject = ['slots']

export function apply(ctx) {
  const slots = ctx.get('slots')
  if (slots === undefined) return

  // 会话页 tab(对话/轨迹/记忆...):挂 conversation.view 槽位
  slots.inject('conversation.view', () => slots.register(
    { name: 'conversation.view', id: 'memory', order: 130, label: () => '记忆' },
    MemoryPanel,
  ))
}

export default { inject, apply }
