<template>
  <FileBrowserList :layout-collection="layoutCollection" @empty-context="openCtx('empty', null, $event)">
    <!-- 表头 -->
    <div class="list-head">
      <span
        v-for="item in headers"
        :key="item.key"
        class="lh-sortable"
        :class="{ active: sortKey === item.key }"
        @click="onSortSelect(item.key)"
      >{{ item.label }}<svg
        v-if="item.key"
        class="lh-arrow"
        :class="{ desc: sortDir === 'desc' }"
        width="8" height="8" viewBox="0 0 10 10" fill="none"
        stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
      ><path d="M5 2v6M2 5l3-3 3 3"/></svg></span>
    </div>

    <RuntimeFolderListRow v-for="f in sortedContents.folders" :key="f.id" :item="f" :context="props.context" :runtime-id="folderLayoutKey(f)" runtime-surface-id="files:surface:browser" :runtime-selected="selectedFolderKeys.has(f.id)" :runtime-abilities="f.type === 'folder' && f.folderId != null ? ['move'] : []" :runtime-target="f.type === 'folder' && f.folderId != null ? { surfaceId: `files:surface:folder:${f.folderId}`, accepts: ['file-item', 'folder-item'], priority: 2 } : undefined" />
    <RuntimeFileListRow v-for="f in sortedContents.files" :key="f.id" :item="f" :context="props.context" :runtime-id="fileLayoutKey(f)" runtime-surface-id="files:surface:browser" :runtime-selected="selectedIds.has(f.id)" :runtime-abilities="['move']" />

    <!-- 上传中的幽灵卡片 -->
    <FileUploadGhostCard
      v-for="g in uploadingItems"
      :key="g.uid"
      mode="list"
      :name="g.name"
      :ext="g.ext"
      :is-folder="g.isFolder"
      :progress="g.progress"
      :done="g.done"
      :total="g.total"
      :failed="g.failed"
      :error="g.error"
      data-flip-target
    >
      <template #list="{ color, statusText }">
        <span class="lr-name-cell">
          <PhFolder v-if="g.isFolder" class="lr-file-icon" :size="16" weight="fill" :style="{ color }" />
          <component v-else :is="fileListIcon(g.ext)" class="lr-file-icon" :size="16" weight="fill" :style="{ color }" />
          <span class="lr-filename">{{ g.name }}</span>
        </span>
        <span class="lr-type-cell">
          <span v-if="!g.isFolder" class="lr-ext" :style="{ color: fileIconColor(g.ext), background: fileIconColor(g.ext) + '18' }">{{ g.ext || '—' }}</span>
        </span>
        <span class="lr-text">—</span>
        <span class="lr-text">—</span>
        <span class="lr-text">{{ statusText }}</span>
        <span class="lr-actions" />
      </template>
    </FileUploadGhostCard>

    <FileBrowserEmptyState v-if="contents.folders.length === 0 && contents.files.length === 0 && !loading && !canUpload" variant="list" />
    <FileUploadButton v-if="canUpload" mode="list" data-flip-target @select="handleFileInput" />
  </FileBrowserList>
</template>
<script setup lang="ts">
import type { PropType } from 'vue'
import { PhFolder } from '@phosphor-icons/vue'
import FileBrowserList from '@/components/common/file-browser/FileBrowserList.vue'
import FileBrowserEmptyState from '@/components/common/file-browser/FileBrowserEmptyState.vue'
import FileUploadButton from '@/components/common/file-browser/FileUploadButton.vue'
import FileUploadGhostCard from '@/components/common/file-browser/FileUploadGhostCard.vue'
import RuntimeFolderListRow from '@/views/Files/components/RuntimeFolderListRow.vue'
import RuntimeFileListRow from '@/views/Files/components/RuntimeFileListRow.vue'

const props = defineProps({ context: { type: Object as PropType<Record<string, any>>, required: true } })

const headers = [
  { key: 'name', label: '名称' },
  { key: 'type', label: '类型' },
  { key: 'stage', label: '项目 / 阶段' },
  { key: 'size', label: '大小' },
  { key: 'createdAt', label: '日期' },
  { key: '', label: '' },
]

const {
  contents, sortedContents, sortKey, sortDir, onSortSelect, openCtx,
  selectedFolderKeys, previewFolderKeys, handleFolderClick,
  folderListIcon, folderAccentColor, renamingFolderKey, renameText, commitRename, cancelRename,
  startRenameFolder, downloadFolder, deleteFolder, inSelectionMode,
  selectedIds, previewFileIds, cbStore, handleFileClick,
  fileListIcon, fileIconColor, renamingFileId, startRenameFile, downloadFile, deleteSingleFile,
  uploadingItems, loading, canUpload, handleFileInput,
  folderLayoutKey, fileLayoutKey, layoutCollection,
} = props.context
</script>

<style scoped>
/* 视图拆分（8fc23c0f）时这份 CSS 漏迁移，留在了 Files/index.vue 的 scoped 样式里——
   scoped 样式不跨组件边界，那边的规则对这里渲染出来的元素完全不生效，列表视图曾经
   有一段时间是裸样式。FilesGridView.vue/FilesTrashView.vue 当时都迁移了各自那份，
   只有这个漏了，这里补齐。 */
.file-list { display: flex; flex-direction: column; gap: 2px; }

.lh-sortable {
  display: flex; align-items: center; gap: 3px;
  cursor: pointer; user-select: none; transition: color 0.12s;
}
.lh-sortable:hover { color: var(--text-primary); }
.lh-sortable.active { color: var(--color-primary); }
.lh-arrow { opacity: 0; flex-shrink: 0; transition: opacity 0.15s, transform 0.2s; }
.lh-sortable.active .lh-arrow { opacity: 1; }
.lh-arrow.desc { transform: rotate(180deg); }

.list-head {
  display: grid;
  grid-template-columns: 2fr 90px 1.2fr 80px 72px 56px;
  padding: 0 10px 8px;
  font-size: 10px; font-weight: 600; color: var(--text-secondary);
  text-transform: uppercase; letter-spacing: 0.06em;
  border-bottom: 1px solid rgba(0,0,0,0.06); margin-bottom: 2px;
}
.list-row {
  display: grid;
  grid-template-columns: 2fr 90px 1.2fr 80px 72px 56px;
  align-items: center; padding: 9px 10px;
  min-height: 42px;
  border-radius: 9px; transition: background 0.12s;
  cursor: pointer;
}
.list-row:hover { background: rgba(123,127,178,0.06); }
.list-row.selected { background: rgba(123,127,178,0.1); }
.list-row.pre-selected {
  background: rgba(123,127,178,0.06);
  outline: 1px solid rgba(123,127,178,0.25);
}
.list-row.cut { opacity: 0.45; }
.folder-row { cursor: pointer; }
.folder-row:hover { background: rgba(180,148,80,0.06); }
.list-row.folder-row.selected { background: rgba(123,127,178,0.09); }

.lr-name-cell { display: flex; align-items: center; gap: 7px; min-width: 0; }
.lr-folder-icon, .lr-file-icon { flex-shrink: 0; opacity: 0.82; }
.lr-type-cell { display: flex; align-items: center; gap: 5px; min-width: 0; }
.lr-ext {
  font-size: 8px; font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase;
  border-radius: 3px; padding: 1px 4px; flex-shrink: 0; line-height: 1.5;
}
.lr-type-text { font-size: 11px; color: var(--text-secondary); }
.lr-filename {
  font-size: 12px; font-weight: 600; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  flex: 1; min-width: 0; padding-bottom: 2px; margin-bottom: -2px;
}
.lr-proj-cell { display: flex; align-items: center; gap: 6px; min-width: 0; }
.lr-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; opacity: 0.8; }
.lr-projname {
  font-size: 11px; color: var(--text-secondary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  padding-bottom: 2px; margin-bottom: -2px;
}
.lr-text { font-size: 11px; color: var(--text-secondary); }

.lr-actions { display: flex; align-items: center; justify-content: flex-end; gap: 2px; position: relative; }
.list-row:hover .file-list-btn { opacity: 1; }

.sel-checkbox {
  position: absolute; top: 8px; right: 8px; z-index: 3;
  width: 18px; height: 18px; border-radius: 5px;
  border: 2px solid rgba(123, 127, 178, 0.55);
  background: rgba(255,255,255,0.75);
  display: flex; align-items: center; justify-content: center;
  transition: background 0.15s, border-color 0.15s;
  pointer-events: none;
}
.sel-checkbox.checked {
  background: var(--color-primary, #7b7fb2);
  border-color: var(--color-primary, #7b7fb2);
}
.lr-actions .sel-checkbox {
  position: absolute;
  right: 0; top: 50%; transform: translateY(-50%);
  background: rgba(255,255,255,0.55);
  transition: background 0.15s, border-color 0.15s, opacity 0.18s ease;
}
.lr-actions .sel-checkbox.checked {
  background: var(--color-primary, #7b7fb2);
  border-color: var(--color-primary, #7b7fb2);
}
.sel-cb-enter-active,
.sel-cb-leave-active { transition: background 0.15s, border-color 0.15s, opacity 0.18s ease; }
.sel-cb-enter-from,
.sel-cb-leave-to { opacity: 0; }

/* 抓起时的紧凑代理（proxyLayout.compact，见 interaction/runtime/setup.ts）：代理是
   .list-row 的完整克隆，天生带着跟本体一模一样的 grid-template-columns。紧凑/展开
   的列宽切换完全交给 Visual.ts 用内联样式驱动（跟本体保持同一套 6 列定义，只把日期/
   操作两列的宽度在 0px 和真实值之间过渡），这里不需要另起一套布局规则去重排字段位置。
   唯一要补的是：日期/操作两列宽度收到 0px 时，它们自己的文字/按钮内容不会跟着缩小，
   不加 overflow:hidden 会从 0 宽的列格里溢出来。按位置而不是类名选择这两列——文件行
   第 5、6 个直接子元素固定是 date/actions，文件夹行是占位/actions，两种行位置一致，
   比 .lr-text 这种文件行/文件夹行共用、大小和日期又共用的类名更准确。 */
.list-row[data-runtime-proxy-content][data-runtime-compact="true"] > :nth-child(n+5) { overflow: hidden; }
</style>
