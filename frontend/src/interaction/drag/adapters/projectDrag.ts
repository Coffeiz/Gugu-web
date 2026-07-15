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
      onDrop: options.onDrop,
    }),
    onClick: options.onClick,
  })
}
