<template>
  <template v-if="group.type === 'recent'">
    <div class="done-group-layout-node recent-done" :data-layout-key="group.key" data-layout-role="group" data-layout-group>
      <div class="recent-done-label"><PhCheckCircle :size="12" weight="fill" style="color:#5a9e88" />{{ group.label }}</div>
      <DoneCardList :projects="group.items" :is-project-detached="isProjectDetached" recent collection-key="recent" @card-click="$emit('card-click', $event)" />
    </div>
  </template>
  <div v-else-if="group.type === 'year'" class="done-group-layout-node" :data-layout-key="group.key" data-layout-role="group" data-layout-group>
    <button class="year-row" @click="$emit('toggle', group.key)">
      <FlipChevron :open="group.open" />
      <span class="year-label">{{ group.label }}</span><span class="year-cnt">{{ group.children.reduce((total, child) => total + child.items.length, 0) }}</span>
    </button>
  </div>
  <template v-else-if="group.type === 'month'">
    <div class="done-group-layout-node" :data-layout-key="group.key" data-layout-role="group" data-layout-group>
      <button class="month-row" @click="$emit('toggle', `${group.year}${group.month}`)">
        <PhFolderOpen v-if="group.open" :size="13" weight="fill" style="color:#5a9e88; opacity:0.85; flex-shrink:0" /><PhFolder v-else :size="13" weight="regular" style="flex-shrink:0; opacity:0.6" />
        <span class="month-name">{{ group.label }}</span><span class="month-cnt">{{ group.items.length }}</span><FlipChevron :open="group.open" :size="8" />
      </button>
      <div :key="`${group.key}-cards`" class="month-folder" data-layout-content :data-layout-key="`${group.year}${group.month}`" :data-layout-open="group.open ? 'true' : 'false'">
        <DoneCardList :projects="group.items" :is-project-detached="isProjectDetached" :collection-key="group.key" @card-click="$emit('card-click', $event)" />
      </div>
    </div>
  </template>
  <template v-else>
    <div class="done-group-layout-node" :data-layout-key="group.key" data-layout-role="group">
      <button class="year-row" @click="$emit('toggle', '__undated')">
        <FlipChevron :open="isUndatedOpen" />
        <span class="year-label undated">{{ group.label }}</span><span class="year-cnt">{{ group.items.length }}</span>
      </button>
      <div class="year-folder" data-layout-content data-layout-key="__undated" :data-layout-open="isUndatedOpen ? 'true' : 'false'">
        <DoneCardList :projects="group.items" :is-project-detached="isProjectDetached" :collection-key="group.key" @card-click="$emit('card-click', $event)" />
      </div>
    </div>
  </template>
</template>

<script setup lang="ts">
import { type PropType } from 'vue'
import { PhFolder, PhFolderOpen, PhCheckCircle } from '@phosphor-icons/vue'
import FlipChevron from '@/components/common/FlipChevron.vue'
import type { DoneGroup } from './doneTypes'
import DoneCardList from './DoneCardList.vue'

const props = defineProps({
  group: { type: Object as PropType<DoneGroup>, required: true },
  isUndatedOpen: { type: Boolean, default: false },
  isProjectDetached: { type: Function as PropType<(projectId: string) => boolean>, required: true },
})
defineEmits(['toggle', 'card-click'])
</script>
