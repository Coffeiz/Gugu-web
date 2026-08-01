<template>
  <div
    class="month-cards"
    :data-layout-collection="collectionKey"
    :class="{ 'recent-card-list': recent }"
  >
    <Teleport
      v-for="project in projects"
      :key="`project-${project.id}`"
      to="body"
      :disabled="!isDetached(String(project.id))"
    >
      <div class="done-card-item" :data-layout-key="`project-${project.id}`" data-layout-role="card">
        <ProjectCard :project="project" @click="$emit('card-click', project)" />
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { type PropType } from 'vue'
import type { Project } from '@/types/project'
import { runtime } from '@/interaction/runtime'
import ProjectCard from '../ProjectCard.vue'

defineEmits(['card-click'])

function isDetached(projectId: string): boolean {
  props.ownershipVersion
  return runtime.owner.isControlled(projectId)
}

const props = defineProps({
  projects: { type: Array as PropType<Project[]>, default: () => [] },
  recent: { type: Boolean, default: false },
  collectionKey: { type: String, default: '' },
  ownershipVersion: { type: Number, default: 0 },
})
</script>
