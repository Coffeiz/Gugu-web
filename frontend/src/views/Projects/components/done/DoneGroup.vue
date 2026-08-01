<template>
  <template v-if="group.type === 'recent'">
    <div class="done-group-layout-node recent-done" :data-layout-key="group.key" data-layout-role="group" data-layout-group>
      <div class="recent-done-label"><PhCheckCircle :size="12" weight="fill" style="color:#5a9e88" />{{ group.label }}</div>
      <DoneCardList :projects="group.items" recent collection-key="recent" @card-click="$emit('card-click', $event)" />
    </div>
  </template>
  <div v-else-if="group.type === 'year'" class="done-group-layout-node" :data-layout-key="group.key" data-layout-role="group" data-layout-group>
    <button class="year-row" @click="$emit('toggle', group.key)">
      <svg class="year-chev" :class="{ open: group.open }" width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 3.5l3 3 3-3"/></svg>
      <span class="year-label">{{ group.label }}</span><span class="year-cnt">{{ group.children.reduce((total, child) => total + child.items.length, 0) }}</span>
    </button>
  </div>
  <template v-else-if="group.type === 'month'">
    <div class="done-group-layout-node" :data-layout-key="group.key" data-layout-role="group" data-layout-group>
      <button class="month-row" @click="$emit('toggle', `${group.year}${group.month}`)">
        <PhFolderOpen v-if="group.open" :size="13" weight="fill" style="color:#5a9e88; opacity:0.85; flex-shrink:0" /><PhFolder v-else :size="13" weight="regular" style="flex-shrink:0; opacity:0.6" />
        <span class="month-name">{{ group.label }}</span><span class="month-cnt">{{ group.items.length }}</span><svg class="month-chev" :class="{ open: group.open }" width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 3.5l3 3 3-3"/></svg>
      </button>
      <div :key="`${group.key}-cards`" class="month-folder" data-layout-content :data-layout-key="`${group.year}${group.month}`" :data-layout-open="group.open ? 'true' : 'false'">
        <DoneCardList :projects="group.items" :collection-key="group.key" @card-click="$emit('card-click', $event)" />
      </div>
    </div>
  </template>
  <template v-else>
    <div class="done-group-layout-node" :data-layout-key="group.key" data-layout-role="group">
      <button class="year-row" @click="$emit('toggle', '__undated')">
        <svg class="year-chev" :class="{ open: isUndatedOpen }" width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 3.5l3 3 3-3"/></svg><span class="year-label undated">{{ group.label }}</span><span class="year-cnt">{{ group.items.length }}</span>
      </button>
      <DoneCardList v-if="isUndatedOpen" :projects="group.items" :collection-key="group.key" @card-click="$emit('card-click', $event)" />
    </div>
  </template>
</template>

<script setup lang="ts">
import type { PropType } from 'vue'
import { PhFolder, PhFolderOpen, PhCheckCircle } from '@phosphor-icons/vue'
import type { DoneGroup } from './doneTypes'
import DoneCardList from './DoneCardList.vue'

const props = defineProps({
  group: { type: Object as PropType<DoneGroup>, required: true },
  isUndatedOpen: { type: Boolean, default: false },
})
defineEmits(['toggle', 'card-click'])
</script>
