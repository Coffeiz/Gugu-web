<template>
  <TransitionGroup tag="div" name="done-card-list" class="month-cards" :class="{ 'recent-card-list': recent }" :css="false">
    <div v-for="project in projects" :key="`project-${project.id}`" class="done-card-item" :data-layout-key="`project-${project.id}`" data-layout-role="card">
      <ProjectCard :project="project" @click="$emit('card-click', project)" />
    </div>
  </TransitionGroup>
</template>

<script setup lang="ts">
import type { PropType } from 'vue'
import type { Project } from '@/types/project'
import ProjectCard from '../ProjectCard.vue'

defineProps({
  projects: { type: Array as PropType<Project[]>, default: () => [] },
  recent: { type: Boolean, default: false },
})
defineEmits(['card-click'])
</script>
