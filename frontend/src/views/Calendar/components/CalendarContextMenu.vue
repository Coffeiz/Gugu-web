<template>
  <PopupMenu ref="menu" :show="open" :position="position" popup-class="cal-ctx-menu popup-menu">
        <button v-if="context?.type === 'week-column'" class="popup-menu-item" @click="$emit('add-event')"><Icon name="navigation.calendar-add" :size="13" />新建活动</button>
        <button v-else class="popup-menu-item" @click="$emit('add-project')"><Icon name="file.folder-add" :size="13" />新建项目</button>
  </PopupMenu>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import Icon from '@/components/common/Icon.vue'
import PopupMenu from '@/components/common/PopupMenu.vue'
import type { CalendarContext } from '../domain/calendarContext'

defineProps<{
  open: boolean
  context: CalendarContext | null
  position: { x: number; y: number }
}>()
defineEmits<{ 'add-event': []; 'add-project': [] }>()

const menu = ref<InstanceType<typeof PopupMenu> | null>(null)
defineExpose({ contains: (target: Node) => !!menu.value?.contains(target) })
</script>
