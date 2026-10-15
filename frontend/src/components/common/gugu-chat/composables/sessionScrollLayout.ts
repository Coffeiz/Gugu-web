/** 当前虚拟窗口中仍未完成 Markdown/Mermaid 展示准备的消息气泡。 */
export function hasPendingMessageMarkdown(element: HTMLElement): boolean {
  const bubbles = element.querySelectorAll<HTMLElement>(
    '.msg-virtual-row .msg-bubble.md-body, .msg-virtual-row .msg-bubble.user-md',
  )
  return [...bubbles].some(bubble =>
    bubble.querySelector<HTMLElement>('.md-view')?.dataset.mermaidReady !== 'true',
  )
}
