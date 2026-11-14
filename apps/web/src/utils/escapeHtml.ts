/** 将不可信文本转为可安全嵌入 HTML 文本节点的实体。 */
export function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char] || char)
}
