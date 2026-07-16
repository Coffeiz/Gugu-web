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
      // 普通列按卡片列表做 FLIP，完成列的卡片在月份分组内，回退到整列；须与落点分支一致。
      flipContainer: card.closest<HTMLElement>('.kanban-card-list')
        ?? card.closest<HTMLElement>('.col-body')
        ?? undefined,
      flipAllDescendants: true,
      landingVisibilityWaitMs: 300,
      onDrop: options.onDrop,
    }),
    onClick: options.onClick,
  })
}
