<template>
  <Teleport to="body">
    <Transition name="menu-pop">
      <div v-if="open" ref="menu" class="popup-menu cal-ctx-menu" :style="{ position: 'fixed', left: position.x + 'px', top: position.y + 'px', zIndex: 3000, minWidth: '110px' }">
        <button v-if="context?.type === 'week-column'" class="popup-menu-item" @click="$emit('add-event')"><Icon name="navigation.calendar-add" :size="13" />新建活动</button>
        <button v-else class="popup-menu-item" @click="$emit('add-project')"><Icon name="file.folder-add" :size="13" />新建项目</button>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import Icon from '@/components/common/Icon.vue'
import type { CalendarContext } from '../domain/calendarContext'

defineProps<{
  open: boolean
  context: CalendarContext | null
  position: { x: number; y: number }
}>()
defineEmits<{ 'add-event': []; 'add-project': [] }>()

const menu = ref<HTMLElement | null>(null)
defineExpose({ contains: (target: Node) => !!menu.value?.contains(target) })
</script>
