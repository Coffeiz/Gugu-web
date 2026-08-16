<template>
  <article
    ref="cardEl"
    class="drawer-project-card hover-card-fx"
    data-layout-role="card"
    :data-layout-key="`project:${project.id}`"
    :data-project-id="project.id"
    :style="{ '--project-color': project.color }"
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
    registerCanvasLandingTarget(`mind:drawer-project:${props.project.id}`, props.project.id)
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
  overflow: hidden;
  cursor: grab;
  user-select: none;
  font-family: var(--font-sans);
  border: 1px solid var(--project-card-border);
  border-radius: var(--project-card-radius);
  background: linear-gradient(to right,var(--project-card-gradient-start) 0%,var(--project-card-gradient-end) 40%), var(--project-color);
  box-shadow: var(--project-card-shadow);
  transition: var(--project-card-motion);
}
.drawer-project-card::before,
.drawer-project-card::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
}
.drawer-project-card::before {
  background: var(--project-card-sheen-rest);
  box-shadow: inset 0 1px 0 var(--project-card-highlight-rest);
}
.drawer-project-card::after {
  opacity: 0;
  background: var(--project-card-sheen-hover);
  box-shadow: inset 0 1px 0 var(--project-card-highlight-hover);
  transition: var(--card-overlay-motion);
}
.drawer-project-card:hover {
  border-color: var(--project-card-hover-border);
  box-shadow: var(--project-card-hover-shadow);
}
.drawer-project-card:hover::after { opacity: 1; }
.drawer-project-card:active { cursor: grabbing; }

.drawer-project-card :deep(.project-card-body) { transition: opacity .16s ease; }
</style>
