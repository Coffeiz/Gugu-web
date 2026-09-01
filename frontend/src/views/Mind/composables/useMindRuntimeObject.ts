import { onBeforeUnmount, onMounted, watch, type Ref } from 'vue'
import { runtime } from '@/interaction/runtime'
import type { MoveAction } from '@/interaction/runtime'
import {
  MIND_CANVAS_OBJECT_TYPE,
  MIND_CANVAS_OBJECT_TYPES,
  MIND_CANVAS_SURFACE_ID,
  MIND_PROJECT_DRAWER_SURFACE_ID,
  registerMindLandingResolver,
} from '@/interaction/runtime/canvas'

export function useMindRuntimeObject(options: {
  objectId: string | (() => string)
  element: Ref<HTMLElement | null> | (() => HTMLElement | null)
  objectType?: string
  onClick?: () => void
  surfaceId?: string
  onMove?: (action: MoveAction) => void | Promise<void>
}) {
  let generation: number | null = null
  let boundElement: HTMLElement | null = null
  let registeredObjectId: string | null = null
  let stopBinding: (() => void) | null = null
  let stopResolver: (() => void) | null = null
  let stopAction: (() => void) | null = null

  const getElement = () => typeof options.element === 'function' ? options.element() : options.element.value
  const getObjectId = () => typeof options.objectId === 'function' ? options.objectId() : options.objectId
  const sync = () => {
    const element = getElement()
    if (!element) return
    const objectId = getObjectId()
    if (!objectId) return
    // ProjectRefCard（canvas）和 ProjectDrawerCard（drawer）是同一个项目对象在
    // 两个 Surface 上的不同 DOM。CollectionPresence 的 move ownership 通过
    // data-layout-key 识别语义对象；drawer 模板已经显式提供 key，canvas 卡只
    // 暴露 data-project-id，因此在 Mind 的 Runtime 接入边界统一补齐，避免把
    // data-project-id 这种业务字段耦合进通用 interaction runtime。
    if (!element.dataset.layoutKey && element.dataset.projectId) {
      element.dataset.layoutKey = `project:${element.dataset.projectId}`
    }
    if (registeredObjectId !== null && registeredObjectId !== objectId) {
      stopBinding?.()
      stopResolver?.()
      stopAction?.()
      if (generation !== null && runtime.objects.get(registeredObjectId)?.generation === generation) {
        runtime.unregisterObjectWhenIdle(registeredObjectId, generation)
      }
      generation = null
      boundElement = null
      registeredObjectId = null
    }
    if (generation === null) {
      const surfaceId = options.surfaceId ?? MIND_CANVAS_SURFACE_ID
      const isCanvasObject = surfaceId === MIND_CANVAS_SURFACE_ID
      generation = runtime.objects.register({
        id: objectId,
        type: options.objectType ?? MIND_CANVAS_OBJECT_TYPE,
        visual: options.objectType ?? MIND_CANVAS_OBJECT_TYPE,
        visualMode: 'detach',
        surfaceId,
        element,
        abilities: isCanvasObject ? ['move', 'link'] : ['move'],
        ...(isCanvasObject ? {
          node: {
            ports: [
              // 与 CardAffordances 的 32px 透明连接按钮保持一致：命中半径为 16px，
              // 不要求鼠标必须精确压在可见圆点中心。
              { id: 'left', side: 'left', position: 0.5, hitRadius: 16, accepts: [...MIND_CANVAS_OBJECT_TYPES] },
              { id: 'right', side: 'right', position: 0.5, hitRadius: 16, accepts: [...MIND_CANVAS_OBJECT_TYPES] },
            ],
          },
        } : {}),
      })
      registeredObjectId = objectId
    } else {
      runtime.objects.setElement(objectId, element)
    }
    if (boundElement === element) return
    stopBinding?.()
    stopBinding = runtime.bindObjectPointer(objectId, element)
    boundElement = element
    stopResolver?.()
    stopAction?.()
    stopResolver = registerMindLandingResolver(objectId, destination => {
      const rect = element.getBoundingClientRect()
      const point = destination as { point?: { x?: unknown; y?: unknown }; releaseVelocity?: { x?: unknown; y?: unknown } } | null
      if (!point?.point || typeof point.point.x !== 'number' || typeof point.point.y !== 'number') return null
      const destinationSurface = destination && typeof destination === 'object'
        ? (destination as { toSurfaceId?: unknown; columnId?: unknown }).toSurfaceId
          ?? (destination as { toSurfaceId?: unknown; columnId?: unknown }).columnId
        : null
      if (destinationSurface === MIND_PROJECT_DRAWER_SURFACE_ID) return null
      const velocity = point.releaseVelocity
      const coastX = typeof velocity?.x === 'number' ? Math.max(-260, Math.min(260, velocity.x * 0.12)) : 0
      const coastY = typeof velocity?.y === 'number' ? Math.max(-260, Math.min(260, velocity.y * 0.12)) : 0
      const resolved = {
        left: point.point.x + coastX - rect.width / 2,
        top: point.point.y + coastY - rect.height / 2,
        width: rect.width,
        height: rect.height,
      }
      return resolved
    })
    if (options.onMove) {
      stopAction = runtime.onAction(action => {
        if (action.type === 'move' && action.objectId === objectId) return options.onMove?.(action)
      })
    }
  }

  onMounted(sync)
  watch(() => [getObjectId(), getElement()] as const, sync)
  onBeforeUnmount(() => {
    stopBinding?.()
    stopResolver?.()
    stopAction?.()
    if (generation !== null && registeredObjectId !== null && runtime.objects.get(registeredObjectId)?.generation === generation) {
      runtime.unregisterObjectWhenIdle(registeredObjectId, generation)
    }
    generation = null
    boundElement = null
    registeredObjectId = null
  })

  return {
    onPointerDown: () => {},
    onClick: options.onClick,
  }
}
