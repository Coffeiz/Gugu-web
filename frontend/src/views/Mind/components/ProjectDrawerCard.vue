<template>
  <article
    class="drawer-project-card hover-card-fx"
    :data-project-id="project.id"
    :style="{ background: `linear-gradient(to right, rgba(255,255,255,0.9) 0%, rgba(255,255,255,1) 40%), ${project.color}` }"
    @pointerdown.stop="onPointerDown"
  >
    <ProjectCardBody :project="project" />
  </article>
</template>

<script setup lang="ts">
import { type PropType } from 'vue'
import { coastOffset } from '@/composables/useCardDrag'
import { startPhysicsDrag, startThresholdDrag } from '@/composables/usePhysicsDrag'
import type { Project } from '@/types/project'
import ProjectCardBody from './ProjectCardBody.vue'

const props = defineProps({
  project: { type: Object as PropType<Project>, required: true },
  addToCanvas: {
    type: Function as PropType<(projectId: number, center: { x: number; y: number }, size: { w: number; h: number }) => Promise<HTMLElement | null>>,
    required: true,
  },
})
const emit = defineEmits<{ (e: 'add'): void }>()

function onPointerDown(event: PointerEvent) {
  startThresholdDrag(event, {
    exclude: target => !!(target as HTMLElement | null)?.closest('.seg-bar-wrap, button, input, textarea, select, a'),
    onDragStart: (moveEvent, card) => {
      let landingTarget: HTMLElement | null = null
      startPhysicsDrag(moveEvent, card, {
        pointer: true,
        skipAbsorb: true,
        centerGrab: true,
        lift: 1.03,
        dragZIndex: 10,
        cloneClass: 'pr-card',
        keepSourcePlaceholder: true,
        removeSourceOnExternalDrop: true,
        onDrop: (center, velocity, size) => {
          const coast = coastOffset(velocity)
          props.addToCanvas(props.project.id, { x: center.x + coast.x, y: center.y + coast.y }, size)
            .then(target => { landingTarget = target })
            .catch(() => { landingTarget = null })
        },
        resolveLandingTarget: () => landingTarget,
        landingTargetWaitMs: 1400,
      })
    },
    onClick: () => emit('add'),
  })
}
</script>

<style scoped>
.drawer-project-card {
  box-sizing: border-box;
  width: 100%;
  border: 1px solid rgba(255,255,255,.72);
  border-radius: var(--radius-md);
  box-shadow: 0 2px 8px rgba(80,90,110,.07);
  cursor: grab;
  user-select: none;
  transition: opacity .18s ease, background .18s ease, border-color .18s ease, box-shadow .18s ease;
}
.drawer-project-card:hover { box-shadow: 0 6px 18px rgba(80,90,110,.13); }
.drawer-project-card:active { cursor: grabbing; }

/* 抽屉素材拖往画布时保留原尺寸的空位，不让列表在拖拽期间重排。 */
.drawer-project-card.phys-drag-source-placeholder {
  opacity: .44;
  background: rgba(255,255,255,.34) !important;
  border-color: rgba(255,255,255,.56);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.48);
  cursor: grabbing;
}
.drawer-project-card.phys-drag-source-placeholder :deep(.project-card-body) {
  opacity: 0;
  transition: opacity .16s ease;
}
.drawer-project-card :deep(.project-card-body) { transition: opacity .16s ease; }
</style>
