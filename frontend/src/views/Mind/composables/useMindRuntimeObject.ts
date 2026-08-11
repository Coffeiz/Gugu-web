import { onBeforeUnmount, onMounted, watch, type Ref } from 'vue'
import { runtime } from '@/interaction/runtime'
import {
  MIND_CANVAS_OBJECT_TYPE,
  MIND_CANVAS_SURFACE_ID,
  registerMindLandingResolver,
} from '@/interaction/runtime/canvas'

export function useMindRuntimeObject(options: {
  objectId: string
  element: Ref<HTMLElement | null> | (() => HTMLElement | null)
  onClick?: () => void
}) {
  let generation: number | null = null
  let boundElement: HTMLElement | null = null
  let stopBinding: (() => void) | null = null
  let stopResolver: (() => void) | null = null

  const getElement = () => typeof options.element === 'function' ? options.element() : options.element.value
  const sync = () => {
    const element = getElement()
    if (!element) return
    if (generation === null) {
      generation = runtime.objects.register({
        id: options.objectId,
        type: MIND_CANVAS_OBJECT_TYPE,
        visual: MIND_CANVAS_OBJECT_TYPE,
        visualMode: 'detach',
        surfaceId: MIND_CANVAS_SURFACE_ID,
        element,
        abilities: ['move'],
      })
    } else {
      runtime.objects.setElement(options.objectId, element)
    }
    if (boundElement === element) return
    stopBinding?.()
    stopBinding = runtime.bindObjectPointer(options.objectId, element)
    boundElement = element
    stopResolver?.()
    stopResolver = registerMindLandingResolver(options.objectId, destination => {
      const rect = element.getBoundingClientRect()
      const point = destination as { point?: { x?: unknown; y?: unknown }; releaseVelocity?: { x?: unknown; y?: unknown } } | null
      if (!point?.point || typeof point.point.x !== 'number' || typeof point.point.y !== 'number') return null
      const velocity = point.releaseVelocity
      const coastX = typeof velocity?.x === 'number' ? Math.max(-260, Math.min(260, velocity.x * 0.12)) : 0
      const coastY = typeof velocity?.y === 'number' ? Math.max(-260, Math.min(260, velocity.y * 0.12)) : 0
      return {
        left: point.point.x + coastX - rect.width / 2,
        top: point.point.y + coastY - rect.height / 2,
        width: rect.width,
        height: rect.height,
      }
    })
  }

  onMounted(sync)
  watch(() => getElement(), sync)
  onBeforeUnmount(() => {
    stopBinding?.()
    stopResolver?.()
    if (generation !== null && runtime.objects.get(options.objectId)?.generation === generation) {
      runtime.objects.unregister(options.objectId, generation)
    }
    generation = null
    boundElement = null
  })

  return {
    onPointerDown: () => undefined,
    onClick: options.onClick,
  }
}
