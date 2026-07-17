import {
  startPhysicsDrag,
  startThresholdDrag,
  type PhysicsDragOpts,
} from '../../../composables/usePhysicsDrag'

export interface ProjectDragOptions {
  isCardControl: (target: EventTarget | null) => boolean
  onDrop: PhysicsDragOpts['onDrop']
  onClick: () => void
}

/** 看板项目卡 adapter：只组合看板所需的阈值和落点回调。 */
export function startProjectDrag(event: PointerEvent, options: ProjectDragOptions): (() => void) | undefined {
  return startThresholdDrag(event, {
    exclude: options.isCardControl,
    onDragStart: (moveEvent, card) => startPhysicsDrag(moveEvent, card, {
      pointer: true,
      skipAbsorb: true,
      // 普通列按卡片列表做 FLIP；完成列的卡片分散在「最近完成」/各月份分组里，
      // 要精确到卡片实际所在的那个 .month-cards（recent-card-list 也带这个类），
      // 不能笼统回退到整列 .col-body——否则 FLIP 会把年/月标题行和其它月份的卡片
      // 也当成"该让位的兄弟"，让位量算错，表现为落点顶部卡片跟新卡重叠。
      // 须与落点分支（single.ts 的 onRegrab）保持一致。
      flipContainer: card.closest<HTMLElement>('.kanban-card-list')
        ?? card.closest<HTMLElement>('.month-cards')
        ?? card.closest<HTMLElement>('.col-body')
        ?? undefined,
      flipAllDescendants: true,
      landingVisibilityWaitMs: 300,
      onDrop: options.onDrop,
    }),
    onClick: options.onClick,
  })
}
