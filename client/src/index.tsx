/**
 * dsh-memory client 入口:会话页顶部新增「记忆」tab(对话上方)。
 * loader 格式(banner/footer)由 scripts/build.mjs 包装。
 */
import MemoryPanel from './Panel'

export const inject = ['slots']

export function apply(ctx) {
  // 深色主题下让原生表单控件/下拉/滚动条按深色渲染(否则浏览器默认浅色外观)
  if (typeof document !== 'undefined') {
    try {
      const tag = document.createElement('style')
      tag.setAttribute('data-plugin', 'dsh-memory')
      tag.textContent =
        'body[data-ds-dark-theme] input, body[data-ds-dark-theme] select, ' +
        'body[data-ds-dark-theme] textarea, body[data-ds-dark-theme] button { color-scheme: dark; }'
      document.head.appendChild(tag)
    } catch { /* 样式注入失败不影响功能 */ }
  }

  const slots = ctx.get('slots')
  if (slots === undefined) return

  // 会话页 tab(对话/轨迹/记忆...):挂 conversation.view 槽位
  slots.inject('conversation.view', () => slots.register(
    { name: 'conversation.view', id: 'memory', order: 130, label: () => '记忆' },
    MemoryPanel,
  ))
}

export default { inject, apply }
