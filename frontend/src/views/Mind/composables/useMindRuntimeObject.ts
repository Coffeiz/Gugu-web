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
  let stopHoverProbe: (() => void) | null = null

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
    stopHoverProbe?.()
    stopHoverProbe = installHoverProbe(element, objectId)
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
    stopHoverProbe?.()
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

function installHoverProbe(element: HTMLElement, objectId: string): (() => void) | null {
  if (!import.meta.env.DEV || typeof MutationObserver === 'undefined') return null
  ;(window as Window & { __GUGU_RUNTIME_HOVER_PROBE__?: boolean }).__GUGU_RUNTIME_HOVER_PROBE__ = true

  let lastPhase: string | null = null
  let lastVisualPhase: string | null = null
  const snapshot = (kind: string, extra: Record<string, unknown> = {}) => {
    const affordances = element.querySelector<HTMLElement>('[data-card-affordances]')
    const actions = affordances?.querySelector<HTMLElement>('.card-actions')
    const dot = affordances?.querySelector<HTMLElement>('.conn-dot')
    console.log('[mind-hover-probe] ' + JSON.stringify({
      kind,
      objectId,
      t: Math.round(performance.now() * 10) / 10,
      phase: element.dataset.runtimePhase ?? null,
      connected: element.isConnected,
      hovered: element.matches(':hover'),
      affordancesHidden: affordances?.classList.contains('runtime-affordances-hidden') ?? false,
      affordancesOpacity: affordances ? getComputedStyle(affordances).opacity : null,
      actionsOpacity: actions ? getComputedStyle(actions).opacity : null,
      dotOpacity: dot ? getComputedStyle(dot).opacity : null,
      ...extra,
    }))
  }

  const stopRuntimeEvents = runtime.subscribe(event => {
    if (event.type === 'move-visual-update' && event.objectId === objectId) {
      if (lastVisualPhase === event.phase) return
      lastVisualPhase = event.phase
      snapshot('runtime-visual-phase', { sessionId: event.sessionId, visualPhase: event.phase })
    }
    if (event.type === 'move-visual-end' && event.objectId === objectId) {
      snapshot('runtime-visual-end', { sessionId: event.sessionId })
      lastVisualPhase = null
    }
  })

  const phaseObserver = new MutationObserver(records => {
    if (!records.some(record => record.target === element && record.attributeName === 'data-runtime-phase')) return
    const phase = element.dataset.runtimePhase ?? null
    if (phase === lastPhase) return
    lastPhase = phase
    snapshot('dom-phase', { phase })
  })
  phaseObserver.observe(element, { attributes: true, attributeFilter: ['data-runtime-phase'] })

  const geometrySnapshot = () => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return {
      rect: {
        left: Math.round(rect.left * 10) / 10,
        top: Math.round(rect.top * 10) / 10,
        width: Math.round(rect.width * 10) / 10,
        height: Math.round(rect.height * 10) / 10,
      },
      transform: style.transform,
      opacity: style.opacity,
      visibility: style.visibility,
      pointerEvents: style.pointerEvents,
      display: style.display,
      parentConnected: element.parentElement?.isConnected ?? false,
    }
  }

  const elementObserver = new MutationObserver(records => {
    const relevant = records.filter(record => record.type === 'attributes')
    if (relevant.length === 0) return
    snapshot('dom-element-mutation', {
      attributes: relevant.map(record => record.attributeName),
      ...geometrySnapshot(),
    })
  })
  elementObserver.observe(element, {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-runtime-phase', 'data-layout-key'],
  })

  const parentObserver = new MutationObserver(records => {
    const relevant = records.filter(record => record.type === 'childList')
    if (relevant.length === 0) return
    snapshot('dom-parent-mutation', {
      added: relevant.flatMap(record => Array.from(record.addedNodes)).length,
      removed: relevant.flatMap(record => Array.from(record.removedNodes)).length,
      stillSameNode: element.isConnected,
      ...geometrySnapshot(),
    })
  })
  if (element.parentElement) parentObserver.observe(element.parentElement, { childList: true })

  const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
    snapshot('dom-resize', geometrySnapshot())
  })
  resizeObserver?.observe(element)

  const affordanceObserver = new MutationObserver(records => {
    if (!records.some(record => record.attributeName === 'class')) return
    const target = records.find(record => record.attributeName === 'class')?.target
    if (!(target instanceof HTMLElement)) return
    if (!target.matches('[data-card-affordances], .card-actions, .conn-dot')) return
    snapshot('affordance-class', { target: target.className })
  })
  affordanceObserver.observe(element, { subtree: true, attributes: true, attributeFilter: ['class'] })

  const onMouseEnter = (event: MouseEvent) => snapshot('dom-mouseenter', {
    clientX: event.clientX,
    clientY: event.clientY,
    elementAtPoint: document.elementFromPoint(event.clientX, event.clientY)?.className ?? null,
    ...geometrySnapshot(),
  })
  const onMouseLeave = (event: MouseEvent) => snapshot('dom-mouseleave', {
    clientX: event.clientX,
    clientY: event.clientY,
    elementAtPoint: document.elementFromPoint(event.clientX, event.clientY)?.className ?? null,
    ...geometrySnapshot(),
  })
  element.addEventListener('mouseenter', onMouseEnter)
  element.addEventListener('mouseleave', onMouseLeave)

  snapshot('bind')
  return () => {
    stopRuntimeEvents()
    phaseObserver.disconnect()
    elementObserver.disconnect()
    parentObserver.disconnect()
    resizeObserver?.disconnect()
    affordanceObserver.disconnect()
    element.removeEventListener('mouseenter', onMouseEnter)
    element.removeEventListener('mouseleave', onMouseLeave)
  }
}
