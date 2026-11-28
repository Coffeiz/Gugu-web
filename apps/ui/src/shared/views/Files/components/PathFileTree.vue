<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { PathFileEntry } from '@/services/api'

defineProps<{
  entries: readonly PathFileEntry[]
  childrenByPath: ReadonlyMap<string, readonly PathFileEntry[]>
  openPaths: ReadonlySet<string>
  depth: number
}>()
const { t } = useI18n()
</script>

<template>
  <template v-for="entry in entries" :key="entry.relativePath">
    <slot :entry="entry" :depth="depth" />
    <div v-if="entry.kind === 'directory'" class="path-tree-branch" data-layout-guide data-layout-content
      :data-tree-path="entry.relativePath" :data-layout-key="entry.relativePath"
      :data-layout-open="openPaths.has(entry.relativePath)"
      :inert="!openPaths.has(entry.relativePath)" :style="{ '--path-tree-depth': depth }">
      <span v-if="childrenByPath.get(entry.relativePath)?.length === 0" class="path-tree-empty" data-layout-guide-end>
        {{ t('filesViewUi.emptyFolder') }}
      </span>
      <PathFileTree v-else-if="childrenByPath.has(entry.relativePath)"
        :entries="childrenByPath.get(entry.relativePath) ?? []"
        :children-by-path="childrenByPath" :open-paths="openPaths" :depth="depth + 1">
        <template #default="row"><slot v-bind="row" /></template>
      </PathFileTree>
    </div>
  </template>
</template>

<style scoped>
.path-tree-branch {
  --tree-guide-anchor: calc(22px + min(45cqi, var(--path-tree-depth) * var(--path-tree-indent)));
  --tree-guide-end-anchor: calc(22px + min(45cqi, (var(--path-tree-depth) + 1) * var(--path-tree-indent)));
  position: relative;
  display: flex;
  flex-direction: column;
  /* 祖先执行 FLIP 时由祖先裁切内容，已展开的子分支保持自身高度。 */
  flex-shrink: 0;
  gap: 2px;
  min-height: 0;
  overflow: hidden;
  margin-block-start: -2px;
}
.path-tree-branch[data-layout-open="false"]:not([data-runtime-group-animating="true"]) {
  height: 0;
  display: none;
}
.path-tree-empty {
  position: relative;
  display: flex;
  align-items: center;
  min-block-size: 30px;
  padding-inline-start: calc(var(--tree-guide-end-anchor) + 15px);
  color: var(--content-tertiary);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-ui);
}
</style>
