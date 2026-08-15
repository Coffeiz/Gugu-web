<template>
  <article
    ref="cardEl"
    class="drawer-project-card hover-card-fx"
    data-layout-role="card"
    :data-layout-key="`project:${project.id}`"
    :data-project-id="project.id"
    :style="{ background: `linear-gradient(to right, rgba(255,255,255,0.9) 0%, rgba(255,255,255,1) 40%), ${project.color}` }"
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
.drawer-project-card {
  position: relative;
  box-sizing: border-box;
  align-self: center;
  width: 240px;
  border: 1px solid rgba(255,255,255,.72);
  border-radius: var(--radius-md);
  box-shadow: 0 2px 8px rgba(80,90,110,.07);
  overflow: hidden;
  cursor: grab;
  user-select: none;
  font-family: var(--font-sans);
  /* 与项目页 .proj-card 保持同一条悬停曲线。这里必须包含 transform；否则本地 transition
     会覆盖全局 hover-card-fx，却让 -2px 抬起没有过渡、看起来像瞬间跳起。 */
  transition: transform .25s cubic-bezier(.34,1.2,.64,1),
              box-shadow .25s ease, background .25s ease-out,
              opacity .25s ease, border-color .25s ease;
}
.drawer-project-card::before {
  content: ''; position: absolute; inset: 0; border-radius: inherit;
  background: linear-gradient(to bottom, rgba(255,255,255,.12) 0%, transparent 50%);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.9); pointer-events: none;
  transition: opacity .25s ease;
}
.drawer-project-card::after {
  content: ''; position: absolute; inset: 0; border-radius: inherit;
  background: linear-gradient(to bottom, rgba(255,255,255,.55) 0%, rgba(255,255,255,.08) 45%, transparent 100%);
  box-shadow: inset 0 1px 0 rgba(255,255,255,1); opacity: 0;
  transition: opacity .25s ease; pointer-events: none;
}
.drawer-project-card:hover { box-shadow: 0 6px 18px rgba(80,90,110,.13); }
.drawer-project-card:hover::after { opacity: 1; }
.drawer-project-card:active { cursor: grabbing; }

.drawer-project-card :deep(.project-card-body) { transition: opacity .16s ease; }
</style>
