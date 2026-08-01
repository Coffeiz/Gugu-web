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
import { onUnmounted, ref, type PropType } from 'vue'
import type { Project } from '@/types/project'
import { runtime } from '@/interaction/runtime'
import ProjectCard from '../ProjectCard.vue'

defineEmits(['card-click'])

const ownershipVersion = ref(0)
const stopOwnershipSubscription = runtime.owner.subscribe(() => {
  ownershipVersion.value += 1
})
onUnmounted(stopOwnershipSubscription)

function isDetached(projectId: string): boolean {
  ownershipVersion.value
  return runtime.owner.isControlled(projectId)
}

defineProps({
  projects: { type: Array as PropType<Project[]>, default: () => [] },
  recent: { type: Boolean, default: false },
  collectionKey: { type: String, default: '' },
})
</script>
