<template>
  <article
    ref="cardEl"
    class="mind-project-card drawer-project-card hover-card-fx"
    data-layout-role="card"
    :data-layout-key="`project:${project.id}`"
    :data-project-id="project.id"
    :style="{ '--pr-project-color': project.color }"
    @pointerdown.stop="onPointerDown"
    @click.stop="emit('add')"
  >
    <ProjectCardBody :project="project" />
  </article>
</template>

<script setup lang="ts">
import { ref, type PropType } from 'vue'
import type { Project } from '@/types/project'
import type { MoveAction } from '@/interaction/runtime'
import {
  MIND_CANVAS_SURFACE_ID,
  MIND_PROJECT_DRAWER_SURFACE_ID,
  MIND_PROJECT_OBJECT_TYPE,
  registerMindLandingTargetResolver,
} from '@/interaction/runtime/canvas'
import ProjectCardBody from './ProjectCardBody.vue'
import { useMindRuntimeObject } from '../composables/useMindRuntimeObject'

const props = defineProps({
  project: { type: Object as PropType<Project>, required: true },
  addToCanvas: {
    type: Function as PropType<(projectId: number, center: { x: number; y: number }, size: { w: number; h: number }) => Promise<HTMLElement | null>>,
    required: true,
  },
})
const emit = defineEmits<{ (e: 'add'): void }>()
const cardEl = ref<HTMLElement | null>(null)

function coastPoint(action: MoveAction) {
  const point = action.point
  if (!point) return null
  const velocity = action.releaseVelocity
  const coastX = velocity ? Math.max(-260, Math.min(260, velocity.x * 0.12)) : 0
  const coastY = velocity ? Math.max(-260, Math.min(260, velocity.y * 0.12)) : 0
  return { x: point.x + coastX, y: point.y + coastY }
}

function registerCanvasLandingTarget(objectId: string, projectId: number) {
  let stop: (() => void) | null = null
  const resolver = () => document.querySelector<HTMLElement>(
    `[data-canvas-item-id][data-project-id="${projectId}"]`,
  )
  stop = registerMindLandingTargetResolver(objectId, destination => {
    const destinationSurface = destination && typeof destination === 'object'
      ? (destination as { toSurfaceId?: unknown; columnId?: unknown }).toSurfaceId
        ?? (destination as { toSurfaceId?: unknown; columnId?: unknown }).columnId
      : null
    if (destinationSurface !== MIND_CANVAS_SURFACE_ID) return null
    const target = resolver()
    if (target) stop?.()
    return target
  })
  // The resolver normally removes itself on the first successful landing lookup.
  // Keep a bounded lifetime for failed optimistic inserts or cancelled sessions.
  window.setTimeout(() => stop?.(), 2000)
}

const { onPointerDown } = useMindRuntimeObject({
  objectId: () => `mind:drawer-project:${props.project.id}`,
  element: () => cardEl.value,
  objectType: MIND_PROJECT_OBJECT_TYPE,
  surfaceId: MIND_PROJECT_DRAWER_SURFACE_ID,
  onMove: action => {
    if (action.toSurfaceId !== MIND_CANVAS_SURFACE_ID) return
    const center = coastPoint(action)
    if (!center) return
    const landingObjectId = `mind:drawer-project:${props.project.id}`
    registerCanvasLandingTarget(landingObjectId, props.project.id)
    void props.addToCanvas(props.project.id, center, {
      w: action.sourceSize?.w ?? 240,
      h: action.sourceSize?.h ?? 120,
    })
  },
})
</script>

<style scoped>
/* Canvas drawer projects consume the same project-card contract as the board/design sample.
   The drawer keeps only its canvas-specific geometry/interaction here. */
.drawer-project-card {
  position: relative;
  box-sizing: border-box;
  align-self: center;
  width: 240px;
  cursor: grab;
}
.drawer-project-card:active { cursor: grabbing; }
</style>
