/** 从 DSH session/event 的消息 data 中提取纯文本。 */
export function extractEventText(data) {
  const message = data?.message ?? data
  const content = message?.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
      .join('\n')
      .trim()
  }
  return String(message?.text ?? data?.text ?? '').trim()
}
