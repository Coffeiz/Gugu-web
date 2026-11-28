import type { ChatReference } from '@/components/common/gugu-chat/chatTypes'

export const selectionDraftEvent = 'gugu:selection-draft'
export const maxSelectionLength = 8000

export interface SelectionSnapshot {
  location: string
  content: string
  unsaved?: boolean
  rendered?: boolean
  version?: number
}

export interface SelectionDraft extends SelectionSnapshot {
  reference: ChatReference
}

/** 早期版本把内部上下文直接存进了正文，只在已有引用的消息中隐藏已知旧格式。 */
export function selectionMessageText(text: string, references: readonly ChatReference[] = []) {
  const candidates = references.filter(ref => !ref.selection && ref.label &&
    /^(提出修改|Suggest an edit|修正を提案) · /u.test(ref.label))
  let end = text.length
  for (const ref of candidates) {
    const prefix = `\n\n修改引用 · ${ref.label} · `
    const start = text.indexOf(prefix)
    if (start < 0) continue
    const remainder = text.slice(start + prefix.length)
    if (/^[^\n]*\n修改前重新读取来源并核对原文与范围。未保存或无法核对时，请先询问我。\n\n`{3,}\n/u.test(remainder))
      end = Math.min(end, start)
  }
  return text.slice(0, end)
}

/** 渲染后的引用胶囊只显示名称，选区快照需要保留原始引用标记。 */
export function renderedSelectionContent(root: HTMLElement, range: Range) {
  const remaining = range.cloneRange()
  let content = ''
  for (const chip of root.querySelectorAll<HTMLElement>('.mind-ref[data-ref-type][data-ref-id]')) {
    if (!range.intersectsNode(chip)) continue
    const bounds = chip.ownerDocument.createRange()
    bounds.selectNodeContents(chip)
    if (range.comparePoint(chip, 0) === -1 && range.comparePoint(chip, chip.childNodes.length) === -1) continue
    if (range.comparePoint(chip, 0) === 1) continue

    const { refType, refId } = chip.dataset
    const label = chip.querySelector('.mind-ref-label')?.textContent ?? chip.textContent
    if (!refType || !refId || !label) continue

    const before = remaining.cloneRange()
    before.setEnd(bounds.startContainer, bounds.startOffset)
    content += before.toString() + `[[${refType}:${refId}|${label}]]`
    remaining.setStart(bounds.endContainer, bounds.endOffset)
  }
  return content + remaining.toString()
}

export function readRenderedSelection(root: HTMLElement | null) {
  const selection = window.getSelection()
  if (!root || !selection?.rangeCount || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const content = renderedSelectionContent(root, range)
  const rect = range.getBoundingClientRect()
  if (!content.trim() || !rect.height) return null
  return { content, position: { x: rect.left + rect.width / 2, y: rect.top }, rendered: true }
}
