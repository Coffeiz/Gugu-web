<template>
  <TransitionGroup
    tag="div"
    name="done-card-list"
    class="month-cards"
    :class="{ 'recent-card-list': recent }"
    @before-enter="onBeforeEnter"
    @before-leave="onBeforeLeave"
  >
    <div v-for="project in projects" :key="`project-${project.id}`" class="done-card-item" :data-layout-key="`project-${project.id}`" data-layout-role="card">
      <ProjectCard :project="project" @click="$emit('card-click', project)" />
    </div>
  </TransitionGroup>
</template>

<script setup lang="ts">
import type { PropType } from 'vue'
import type { Project } from '@/types/project'
import ProjectCard from '../ProjectCard.vue'

defineEmits(['card-click'])

const props = defineProps({
  projects: { type: Array as PropType<Project[]>, default: () => [] },
  recent: { type: Boolean, default: false },
  instantLeave: { type: Boolean, default: false },
})

function onBeforeLeave(element: Element) {
  const el = element as HTMLElement
  if (!props.instantLeave) return
  el.style.display = 'none'
  el.style.visibility = 'hidden'
}

function onBeforeEnter(element: Element) {
  if (!props.recent) return
  const el = element as HTMLElement
  const parent = el.parentElement
  if (!parent) return
  const placeholder = document.createElement('div')
  const key = el.dataset.layoutKey || ''
  placeholder.className = 'recent-enter-placeholder'
  placeholder.dataset.placeholderFor = key
  placeholder.style.height = `${el.getBoundingClientRect().height}px`
  placeholder.style.width = '100%'
  parent.insertBefore(placeholder, el)
  el.dataset.recentEnter = 'true'
  el.style.position = 'absolute'
  el.style.left = '0'
  el.style.right = '0'
  el.style.width = '100%'
  el.style.pointerEvents = 'none'
  el.style.opacity = '0'
  el.style.transition = 'none'
}
</script>
