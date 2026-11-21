/** 笔记 Markdown 的行内引用，兼容数字 ID 和桌面文件路径 ID。 */
export const MIND_REF_RE = /\[\[([a-z_]+):(\d+|(?:path|drop)-[A-Za-z0-9_-]+)\|([^\]]*)\]\]/

export function mindReferenceLabels(markdown: string): string {
  return markdown.replace(new RegExp(MIND_REF_RE.source, 'g'), '$3')
}

/** 摘要仅显示引用名称，保留名称本身的 Markdown 标点。 */
export function mindPreviewText(markdown: string): string {
  const markup = new RegExp(MIND_REF_RE.source + '|^\\s{0,3}(?:#{1,6}\\s+|>\\s?|-\\s\\[[ xX]\\]\\s*|[-*]\\s+|\\d+\\.\\s+)|[*`~]', 'gm')
  return markdown.replace(markup, (_match, _type, _id, label?: string) => label ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}
