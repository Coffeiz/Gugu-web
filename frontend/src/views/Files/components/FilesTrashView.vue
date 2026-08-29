<template>
  <div v-if="trashFolders.length > 0 || contents.files.length > 0" class="file-list trash-list">
    <div class="list-head">
      <span class="lh-sortable" :class="{ active: sortKey === 'name' }" @click="onSortSelect('name')">名称<svg class="lh-arrow" :class="{ desc: sortDir === 'desc' }" width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 2v6M2 5l3-3 3 3"/></svg></span>
      <span>类型</span>
      <span class="lh-sortable" :class="{ active: sortKey === 'createdAt' }" @click="onSortSelect('createdAt')">删除时间<svg class="lh-arrow" :class="{ desc: sortDir === 'desc' }" width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 2v6M2 5l3-3 3 3"/></svg></span>
      <span>剩余</span>
      <span class="lh-sortable" :class="{ active: sortKey === 'size' }" @click="onSortSelect('size')">大小<svg class="lh-arrow" :class="{ desc: sortDir === 'desc' }" width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 2v6M2 5l3-3 3 3"/></svg></span>
      <span></span>
    </div>
    <template v-for="folder in sortedTrashFolders" :key="`trash-folder-${folder.id}`">
      <div class="list-row trash-folder-row" :data-trash-folder-id="`trash:${folder.id}`" :class="{ expanded: expandedTrashFolders.has(folder.id), selected: selectedTrashFolderIds.has(folder.id), 'pre-selected': previewFolderKeys.has(`trash:${folder.id}`) }" @click.stop="handleTrashFolderClick(folder, $event)">
        <span class="lr-name-cell">
          <button class="trash-expand-btn" :title="expandedTrashFolders.has(folder.id) ? '收起内容' : '查看内容'" @click.stop="toggleTrashFolder(folder)">
            <FlipChevron :open="expandedTrashFolders.has(folder.id)" :size="8" />
          </button>
          <Icon :name="expandedTrashFolders.has(folder.id) ? 'file.folder-open' : 'file.folder'" class="lr-folder-icon" :size="16" />
          <span class="lr-filename" :title="folder.name">{{ folder.name }}</span>
        </span>
        <span class="lr-type-cell"><span class="lr-type-text">文件夹</span></span>
        <span class="lr-text">{{ formatDate(folder.deletedAt) }}</span>
        <span class="lr-text" :class="{ 'days-warn': daysLeft(folder.deletedAt) <= 3 }">{{ daysLeft(folder.deletedAt) }} 天</span>
        <span class="lr-text">{{ folder.fileCount }} 个文件</span>
        <span class="lr-actions">
          <Transition name="sel-cb"><div v-if="inSelectionMode" class="sel-checkbox" :class="{ checked: selectedTrashFolderIds.has(folder.id) }"><svg v-if="selectedTrashFolderIds.has(folder.id)" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6l3 3 5-5"/></svg></div></Transition>
          <template v-if="!inSelectionMode">
            <button class="file-list-btn trash-restore-btn" title="恢复文件夹及其内容" @click.stop="restoreTrashFolder(folder)"><svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 7A5 5 0 1 0 7 2"/><path d="M2 2v5h5"/></svg>恢复</button>
            <button class="file-list-btn del" title="永久删除文件夹及其内容" @click.stop="hardDeleteTrashFolder(folder)"><Icon name="action.delete" :size="11" /></button>
          </template>
        </span>
      </div>
      <div class="trash-folder-contents" :data-layout-open="expandedTrashFolders.has(folder.id) ? 'true' : 'false'">
        <div class="trash-folder-contents-inner">
          <div v-if="trashFolderContents[folder.id]?.folders.length === 0 && trashFolderContents[folder.id]?.files.length === 0" class="trash-folder-empty">空文件夹</div>
          <div v-for="child in trashFolderContents[folder.id]?.folders || []" :key="`trash-child-${child.id}`" class="trash-child-row"><Icon name="file.folder" :size="14" /><span>{{ child.name }}</span><small>{{ child.fileCount }} 个文件</small></div>
          <div v-for="file in trashFolderContents[folder.id]?.files || []" :key="`trash-child-file-${file.id}`" class="trash-child-row file"><component :is="fileListIcon(file.ext)" :size="14" :style="{ color: fileIconColor(file.ext) }" /><span>{{ file.displayName }}.{{ file.ext.toLowerCase() }}</span></div>
        </div>
      </div>
    </template>
    <div v-for="f in sortedContents.files" :key="f.id" class="list-row" :data-file-id="f.id" :class="{ selected: selectedIds.has(f.id), 'pre-selected': previewFileIds.has(f.id) }" @click.stop="handleTrashFileClick(f, $event)">
      <span class="lr-name-cell"><component :is="fileListIcon(f.ext)" class="lr-file-icon" :size="16" :style="{ color: fileIconColor(f.ext) }" /><span class="lr-filename" :title="f.displayName">{{ f.displayName }}</span></span>
      <span class="lr-type-cell"><span class="lr-ext" :style="{ color: fileIconColor(f.ext), background: fileIconColor(f.ext) + '18' }">{{ f.ext }}</span></span>
      <span class="lr-text">{{ f.deletedAt ? formatDate(f.deletedAt) : '—' }}</span>
      <span class="lr-text" :class="{ 'days-warn': daysLeft(f.deletedAt) <= 3 }">{{ daysLeft(f.deletedAt) }} 天</span>
      <span class="lr-text">{{ f.size }}</span>
      <span class="lr-actions">
        <Transition name="sel-cb"><div v-if="inSelectionMode" class="sel-checkbox" :class="{ checked: selectedIds.has(f.id) }"><svg v-if="selectedIds.has(f.id)" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6l3 3 5-5"/></svg></div></Transition>
        <template v-if="!inSelectionMode"><button class="file-list-btn trash-restore-btn" title="恢复" @click.stop="restoreFile(f)"><svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 7A5 5 0 1 0 7 2"/><path d="M2 2v5h5"/></svg>恢复</button><button class="file-list-btn del" title="永久删除" @click.stop="hardDeleteFile(f)"><Icon name="action.delete" :size="11" /></button></template>
      </span>
    </div>
  </div>
  <FileBrowserEmptyState v-else-if="!loading" variant="trash" text="回收站为空" />
</template>

<script setup lang="ts">
import Icon from '@/components/common/Icon.vue'
import FlipChevron from '@/components/common/FlipChevron.vue'
import type { PropType } from 'vue'
import FileBrowserEmptyState from '@/components/common/file-browser/FileBrowserEmptyState.vue'
const props = defineProps({ context: { type: Object as PropType<Record<string, any>>, required: true } })
const { trashFolders, contents, sortedContents, sortedTrashFolders, expandedTrashFolders, trashFolderContents, sortKey, sortDir, onSortSelect, inSelectionMode, selectedTrashFolderIds, selectedIds, previewFolderKeys, previewFileIds, handleTrashFolderClick, toggleTrashFolder, restoreTrashFolder, hardDeleteTrashFolder, handleTrashFileClick, restoreFile, hardDeleteFile, fileListIcon, fileIconColor, formatDate, daysLeft, loading } = props.context
</script>

<style scoped>
/* 容器/表头基础/行基础/.lr-* 单元格/.sel-checkbox/.sel-cb-* 全部由 filesListRows.css 唯一拥有
   （本页根节点带 .file-list，共享选择器命中）；这里只保留回收站专属样式和自己的列宽。 */
.list-head, .list-row { grid-template-columns: 2fr 90px 1.2fr 56px 72px 96px; }
.days-warn { color: #c85a5a; font-weight: 600; }
.trash-restore-btn { width: auto; display: flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; color: var(--color-primary); padding: 4px 8px; }
.trash-restore-btn:hover { background: rgba(123,127,178,.15); }
.trash-expand-btn { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; padding: 0; border: 0; background: transparent; color: var(--text-secondary); cursor: pointer; }
.trash-folder-row.expanded { background: var(--surface-soft-hover); }
.trash-folder-contents { --trash-chevron-center: 9px; --trash-content-indent: 20px; position: relative; display: grid; grid-template-rows: 1fr; min-height: 0; overflow: hidden; margin: -2px 0 0 14px; padding: 4px 0 4px var(--trash-content-indent); transform-origin: top; transition: grid-template-rows .22s ease, margin-top .22s ease, padding .22s ease; }
.trash-folder-contents::before { content: ''; position: absolute; left: var(--trash-chevron-center); top: 0; bottom: 0; width: 1px; background: var(--done-group-border); opacity: 1; transition: opacity .18s ease; pointer-events: none; }
.trash-folder-contents[data-layout-open="false"] { grid-template-rows: 0fr; margin-top: -2px; padding-top: 0; padding-bottom: 0; pointer-events: none; }
.trash-folder-contents[data-layout-open="false"]::before { opacity: 0; }
.trash-folder-contents-inner { min-height: 0; overflow: hidden; }
.trash-child-row { display: flex; align-items: center; gap: 7px; min-height: 28px; color: var(--text-secondary); font-size: 11px; }
.trash-child-row svg { color: var(--color-primary); flex: 0 0 auto; }
.trash-child-row small { margin-left: auto; margin-right: 12px; opacity: .65; }
.trash-child-row.file svg { color: var(--text-tertiary); }
.trash-folder-empty { color: var(--text-tertiary); font-size: 11px; padding: 5px 0; }
</style>
