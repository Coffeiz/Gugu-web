<template>
  <section class="workspace-files" :aria-busy="pending">
    <div v-if="error" class="workspace-error" role="alert">
      <span class="workspace-error-icon"><Icon name="file.folder" :size="22" /></span>
      <strong>{{ workspaceUnavailable ? t('filesUi.workspaceDisconnected') : error }}</strong>
      <p v-if="workspaceUnavailable">{{ t('filesUi.workspaceReconnectHint') }}</p>
      <ActionButton variant="secondary" fit @click="load">
        {{ t(workspaceUnavailable ? 'filesUi.workspaceReconnect' : 'common.actions.retry') }}
      </ActionButton>
    </div>
    <PageSkeleton v-else-if="loading" :variant="viewMode" :collection="viewMode === 'grid' ? 'files' : undefined" />
    <FileBrowserList ref="listBrowser" v-else-if="(!pending || loaded) && viewMode === 'list'" :layout-collection="runtimeSurfaceId" class="workspace-file-list" :class="{ 'has-system-file-open': fileOpenAccess }">
      <div class="list-head">
        <button v-for="key in sortColumns" :key="key" class="lh-sortable workspace-file-open"
          :class="{ active: sortKey === key }" type="button" @click="emit('sortSelect', key)">
          {{ t(`filesViewUi.${key}`) }}
          <span v-if="sortKey === key" aria-hidden="true">{{ sortDir === 'asc' ? '↑' : '↓' }}</span>
        </button>
        <span />
      </div>
      <PathFileTree :entries="sortedEntries" :children-by-path="treeChildren" :open-paths="openPaths" :depth="0">
        <template #default="{ entry, depth }">
          <RuntimeListRow class="list-row"
            :style="depth ? { '--path-tree-depth': depth } : undefined"
            :class="{ 'path-tree-nested': depth > 0, 'folder-row': entry.kind === 'directory', 'downloads-row': isDownloads(entry), cut: cutPaths?.has(entry.relativePath), selected: selected(entry), 'pre-selected': preSelected(entry) }"
            :data-path-file="entry.kind === 'file' ? entry.relativePath : undefined"
            :data-path-folder="entry.kind === 'directory' && !isDownloads(entry) ? entry.relativePath : undefined"
            :runtime-selected="selected(entry)"
            data-layout-role="card" :data-layout-key="entryObjectId(entry)" :runtime-id="entryObjectId(entry)"
            :runtime-type="entry.kind === 'directory' ? 'folder-item' : 'file-item'"
            :runtime-surface-id="runtimeSurfaceId"
            :runtime-abilities="isDownloads(entry) ? [] : ['move']"
            :runtime-target="entryDropTarget(entry)"
            @click.stop="openListEntry(entry, $event)" @contextmenu.prevent.stop="openContext(entry, $event)">
            <span class="lr-name-cell">
              <Icon v-if="entry.kind === 'directory' && openPaths.has(entry.relativePath)"
                name="file.folder-open" class="lr-folder-icon" :size="16" :style="{ color: directoryAccent }" />
              <Icon v-else-if="isDownloads(entry)" name="action.download" class="lr-folder-icon" :size="16" />
              <component v-else-if="entry.kind === 'directory'" :is="directoryIcon" class="lr-folder-icon" :size="16"
                :style="{ color: directoryAccent }" />
              <component v-else :is="fileListIcon(fileName(entry).ext)" class="lr-file-icon" :size="16"
                :style="{ color: fileIconColor(fileName(entry).ext) }" />
              <RenameInput v-if="renamingPath === entry.relativePath" v-model="renameName" @commit="commitRename(entry)" @cancel="cancelRename" />
              <button v-else type="button" class="lr-filename workspace-file-open" :title="entry.kind === 'directory' ? `${entryLabel(entry)} · ${folderCountLabel(entry)}` : entryLabel(entry)"
                :aria-expanded="entry.kind === 'directory' ? openPaths.has(entry.relativePath) : undefined"
                :aria-busy="treePending.has(entry.relativePath) || undefined"
                @click.stop="openListEntry(entry, $event)">
                {{ entryLabel(entry) }}
              </button>
            </span>
            <span class="lr-type-cell"><span v-if="entry.kind === 'file'" class="lr-ext">{{ fileName(entry).ext }}</span></span>
            <span class="lr-text">{{ entry.kind === 'file' ? fmtBytes(entry.size) : '—' }}</span>
            <span class="lr-actions">
              <span v-if="selectionMode && !isDownloads(entry)" class="sel-checkbox" :class="{ checked: selected(entry) }">
                <Icon v-if="selected(entry)" name="status.success" :size="12" />
              </span>
              <template v-else>
                <button v-if="!isDownloads(entry)" type="button" class="file-list-btn" :title="t('sharedUi.rename')"
                  :aria-label="t('sharedUi.rename')" @pointerdown.stop @click.stop="startRename(entry)"><Icon name="action.edit" :size="11" /></button>
                <button v-if="!fileOpenAccess && entry.kind === 'file'" type="button" class="file-list-btn"
                  :title="t('common.actions.download')" :aria-label="t('common.actions.download')" @pointerdown.stop @click.stop="download(entry)">
                  <Icon name="action.download" :size="11" />
                </button>
                <button v-if="!isDownloads(entry)" type="button" class="file-list-btn del" :title="t('sharedUi.moveToTrash')"
                  :aria-label="t('sharedUi.moveToTrash')" @pointerdown.stop @click.stop="emit('trash', entry)">
                  <Icon name="action.delete" :size="11" />
                </button>
              </template>
            </span>
          </RuntimeListRow>
        </template>
      </PathFileTree>
      <FileUploadGhostCard v-for="ghost in uploadingItems" :key="ghost.uid" mode="list" data-flip-target
        :name="ghost.name" :ext="ghost.ext" :progress="ghost.progress" :error="ghost.error" />
      <FileUploadButton :label="fileOpenAccess ? t('filesUi.addDesktopFile') : undefined" mode="list" data-flip-target @select="selectFiles" />
    </FileBrowserList>
    <FileBrowserGrid v-else-if="!pending || loaded" :layout-collection="runtimeSurfaceId">
      <template v-for="entry in sortedEntries" :key="entryObjectId(entry)">
        <RuntimeFolderCard v-if="entry.kind === 'directory'"
          :card-props="{ displayName: entryLabel(entry), accentColor: isDownloads(entry) ? 'var(--action-primary)' : directoryAccent, countLabel: folderCountLabel(entry), cut: cutPaths?.has(entry.relativePath), selected: selected(entry), preSelected: preSelected(entry), selectionMode: selectionMode && !isDownloads(entry) }"
          data-layout-role="card" :data-layout-key="entryObjectId(entry)"
          :runtime-id="entryObjectId(entry)" :runtime-surface-id="runtimeSurfaceId"
          :runtime-selected="selected(entry)" :data-path-folder="isDownloads(entry) ? undefined : entry.relativePath"
          :runtime-abilities="isDownloads(entry) ? [] : ['move']"
          :runtime-target="entryDropTarget(entry)"
          role="button" tabindex="0" @pointerdown="beginCardDrag(entry, $event)" @click.stop="openEntry(entry, $event)"
          @contextmenu.prevent.stop="openContext(entry, $event)"
          @keydown.enter.self.prevent="openEntry(entry, $event)" @keydown.space.self.prevent="openEntry(entry, $event)">
          <template #icon>
            <Icon v-if="isDownloads(entry)" name="action.download" class="fd-big-icon" :size="92" />
            <FolderMaterialPreview v-else :directory-id="directoryId" :relative-path="entry.relativePath" :reload="reload"
              :entry-count="entry.fileCount === undefined || entry.folderCount === undefined ? undefined : entry.fileCount + entry.folderCount">
              <component :is="directoryIcon" class="fd-big-icon" :size="92" />
            </FolderMaterialPreview>
          </template>
          <template #name>
            <RenameInput v-if="renamingPath === entry.relativePath" v-model="renameName" @commit="commitRename(entry)" @cancel="cancelRename" />
            <template v-else>{{ entryLabel(entry) }}</template>
          </template>
          <template #actions>
            <button v-if="!isDownloads(entry)" type="button" class="file-card-btn" :title="t('sharedUi.rename')"
              :aria-label="t('sharedUi.rename')" @pointerdown.stop @click.stop="startRename(entry)"><Icon name="action.edit" :size="11" /></button>
            <button v-if="!isDownloads(entry)" type="button" class="file-card-btn del" :title="t('sharedUi.moveToTrash')"
              :aria-label="t('sharedUi.moveToTrash')" @pointerdown.stop @click.stop="emit('trash', entry)">
              <Icon name="action.delete" :size="11" />
            </button>
          </template>
        </RuntimeFolderCard>
        <RuntimeFileCard v-else
          :card-props="{ ext: fileName(entry).ext, displayName: fileName(entry).base, hasThumb: !!thumbnailUrl(entry), cut: cutPaths?.has(entry.relativePath), selected: selected(entry), preSelected: preSelected(entry), selectionMode }"
          data-layout-role="card" :data-layout-key="entryObjectId(entry)"
          :runtime-id="entryObjectId(entry)" :runtime-surface-id="runtimeSurfaceId" :data-path-file="entry.relativePath" :runtime-selected="selected(entry)" role="group"
          @pointerdown="beginCardDrag(entry, $event)" @click.stop="openEntry(entry, $event)" @contextmenu.prevent.stop="openContext(entry, $event)">
          <template #name>
            <RenameInput v-if="renamingPath === entry.relativePath" v-model="renameName" @commit="commitRename(entry)" @cancel="cancelRename" />
            <button v-else type="button" class="workspace-file-open" :aria-label="entry.name"
              @click.stop="openEntry(entry, $event)">{{ fileName(entry).base }}</button>
          </template>
          <template #thumb>
            <img :src="thumbnailUrl(entry)" loading="lazy" decoding="async" draggable="false" alt=""
              @error="failedThumbnails.add(entry.relativePath)" />
          </template>
          <template #meta>{{ fmtBytes(entry.size) }}</template>
          <div v-if="!selectionMode" class="file-card-hover-actions">
            <button type="button" class="file-card-btn" :title="t('sharedUi.rename')"
              :aria-label="t('sharedUi.rename')" @pointerdown.stop @click.stop="startRename(entry)"><Icon name="action.edit" :size="11" /></button>
            <button v-if="!fileOpenAccess" type="button" class="file-card-btn" :title="t('common.actions.download')"
              :aria-label="t('common.actions.download')" @pointerdown.stop @click.stop="download(entry)">
              <Icon name="action.download" :size="11" />
            </button>
            <button type="button" class="file-card-btn del" :title="t('sharedUi.moveToTrash')"
              :aria-label="t('sharedUi.moveToTrash')" @pointerdown.stop @click.stop="emit('trash', entry)">
              <Icon name="action.delete" :size="11" />
            </button>
          </div>
        </RuntimeFileCard>
      </template>
      <FileUploadGhostCard v-for="ghost in uploadingItems" :key="ghost.uid" data-flip-target
        :name="ghost.name" :ext="ghost.ext" :progress="ghost.progress" :error="ghost.error" />
      <FileUploadButton :label="fileOpenAccess ? t('filesUi.addDesktopFile') : undefined" data-flip-target @select="selectFiles" />
    </FileBrowserGrid>
    <FileBrowserContextMenu :show="!!contextEntry" :x="contextX" :y="contextY" @close="contextEntry = null">
      <template v-if="contextEntry">
        <button v-if="contextEntry.kind === 'directory' && viewMode === 'list'" type="button" class="ctx-item popup-menu-item"
          @click="runContext(entry => emit('openDirectory', entry))"><Icon name="file.folder-open" :size="13" />{{ t('filesViewUi.enterFolder') }}</button>
        <template v-if="!isDownloads(contextEntry)">
          <button v-if="contextEntry.kind === 'file'" type="button" class="ctx-item popup-menu-item"
            @click="runContext(openInfo)"><Icon name="status.info" :size="13" />{{ t('sharedUi.info') }}</button>
          <template v-if="contextEntry.kind === 'file' && fileOpenAccess?.canOpenInSystem(fileTarget(contextEntry))">
            <button type="button" class="ctx-item popup-menu-item" @click="runContext(previewFile)">
              <Icon name="action.expand" :size="13" />{{ t('filesUi.previewInGugu') }}
            </button>
            <button type="button" class="ctx-item popup-menu-item" @click="runContext(entry => fileOpenAccess?.openInSystem(fileTarget(entry)))">
              <Icon name="file.folder-open" :size="13" />{{ t('filesUi.openInSystem') }}
            </button>
          </template>
          <button v-if="!fileOpenAccess && contextEntry.kind === 'file'" type="button" class="ctx-item popup-menu-item"
            @click="runContext(download)"><Icon name="action.download" :size="13" />{{ t('sharedUi.download') }}</button>
          <button v-if="pathFilesApi.extractArchive && isArchive(contextEntry)" type="button" class="ctx-item popup-menu-item"
            @click="runContext(openExtraction)"><Icon name="action.archive" :size="13" />{{ t('filesViewUi.extractTo') }}</button>
          <button v-if="pathFilesApi.compressArchive" type="button" class="ctx-item popup-menu-item"
            @click="runContext(openCompression)"><Icon name="action.archive" :size="13" />{{ t('filesUi.compress') }}</button>
          <button type="button" class="ctx-item popup-menu-item"
            @click="runContext(startRename)"><Icon name="action.edit" :size="13" />{{ t('sharedUi.rename') }}</button>
          <button type="button" class="ctx-item popup-menu-item"
            @click="runContext(entry => emit('cut', entry))"><Icon name="action.cut" :size="13" />{{ t('sharedUi.cut') }}</button>
          <button type="button" class="ctx-item popup-menu-item danger"
            @click="runContext(entry => emit('trash', entry))"><Icon name="action.delete" :size="13" />{{ t('sharedUi.moveToTrash') }}</button>
        </template>
      </template>
    </FileBrowserContextMenu>
    <ArchiveOperationDialog :show="!!archiveTarget" mode="extract" :initial-name="archiveName"
      :busy="extracting" :error="extractError" success="" @close="archiveTarget = null" @submit="submitExtraction" />
    <ArchiveOperationDialog :show="!!compressTarget" mode="compress" :initial-name="archiveName"
      :busy="extracting" :error="extractError" success="" @close="compressTarget = null" @submit="submitCompression" />
    <FileInfoPopup :show="!!fileInfo" :file="fileInfo?.file" :location="fileInfo?.location"
      :x="fileInfo?.x" :y="fileInfo?.y" @close="fileInfo = null" />
    <UploadConflictDialog ref="conflictDialog" />
  </section>
</template>

<script setup lang="ts">
import { useDelayedSkeleton } from '@/composables/core/useDelayedSkeleton'
import PageSkeleton from '@/components/common/feedback/skeleton/PageSkeleton.vue'

import { computed, nextTick, onScopeDispose, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import FileBrowserEmptyState from '@/components/common/file-browser/FileBrowserEmptyState.vue'
import FileBrowserContextMenu from '@/components/common/file-browser/FileBrowserContextMenu.vue'
import FileInfoPopup from '@/components/common/file-browser/FileInfoPopup.vue'
import FileBrowserGrid from '@/components/common/file-browser/FileBrowserGrid.vue'
import FileBrowserList from '@/components/common/file-browser/FileBrowserList.vue'
import RuntimeFileCard from '@/components/common/file-browser/RuntimeFileCard.vue'
import FolderMaterialPreview from '@/components/common/file-browser/FolderMaterialPreview.vue'
import RuntimeFolderCard from '@/components/common/file-browser/RuntimeFolderCard.vue'
import PathFileTree from './PathFileTree.vue'
import { runtime, type TargetItem } from '@/interaction/runtime'
import RuntimeListRow from '@/components/common/file-browser/RuntimeListRow.vue'
import FileUploadButton from '@/components/common/file-browser/FileUploadButton.vue'
import FileUploadGhostCard from '@/components/common/file-browser/FileUploadGhostCard.vue'
import RenameInput from '@/components/common/file-browser/RenameInput.vue'
import Icon from '@/components/common/icons/Icon.vue'
import UploadConflictDialog from '@/components/common/overlays/UploadConflictDialog.vue'
import { errorMessage, showAppError, showAppNotice } from '@/composables/core/useAppToast'
import { filesToItems, readDroppedEntries, uploadWorkspaceFile, type UploadItem } from '@/composables/files/useFileUploadCore'
import { useDesktopFileDrag } from '@/composables/files/useDesktopFileDrag'
import { useFileLibraryFolderPresentation } from '@/composables/files/useFileLibraryFolderPresentation'
import type { usePathFileSelection } from '@/composables/files/usePathFileSelection'
import { fileObjectId, folderSurfaceId } from '@/interaction/runtime/adapters/file/fileRuntimeAdapter'
import { useUploadQueue } from '@/composables/shared/useUploadQueue'
import { type PathDirectory, type PathFileEntry, type PathFileRef } from '@/services/api'
import ArchiveOperationDialog from './ArchiveOperationDialog.vue'
import { useFileWatch } from '@/composables/files/useFileWatch'
import { usePathFileAccess } from '@/services/pathFileAccess'
import { isPreviewable, usePreviewStore } from '@/stores/preview'
import { shouldOpenFileInSystem } from '@gugu/desktop-contracts/file-preview'
import { useFileOpenAccess } from '@/services/fileOpenAccess'
import { accountBoundaryEpoch } from '@/utils/accountBoundary'
import { fmtBytes } from '@/utils/fileSize'
import { splitName } from '@/utils/fileParse'
import { fileIconColor, fileListIcon } from '@/utils/fileTypes'

const pathFilesApi = usePathFileAccess()

const props = defineProps<{
  directoryId: PathDirectory
  runtimeSurfaceId: string
  relativePath: string
  viewMode: 'grid' | 'list'
  sortKey: string
  sortDir: 'asc' | 'desc'
  reload: number
  cutPaths?: ReadonlySet<string>
  selectionMode?: boolean
  nativeFileDrag?: boolean
  selectedPaths?: ReadonlySet<string>
  previewPaths?: ReadonlySet<string>
}>()
const emit = defineEmits<{
  openDirectory: [entry: PathFileEntry]
  sortSelect: [key: string]
  cut: [entry: PathFileEntry]
  trash: [entry: PathFileEntry]
  select: [entry: PathFileEntry, event: MouseEvent | KeyboardEvent]
  renamed: []
  compressed: []
}>()
const fileOpenAccess = useFileOpenAccess()
const { t } = useI18n()
const { folderListIcon, folderAccentColor } = useFileLibraryFolderPresentation()
const directoryIcon = folderListIcon({ type: 'folder' })
const directoryAccent = folderAccentColor({ type: 'folder' })
const previewStore = usePreviewStore()
const entries = ref<PathFileEntry[]>([])
const failedThumbnails = ref(new Set<string>())
watch(entries, () => failedThumbnails.value.clear())

function thumbnailUrl(entry: PathFileEntry) {
  if (!entry.mimeType?.startsWith('image/') || entry.size === 0 || entry.size > 8 * 1024 * 1024
    || failedThumbnails.value.has(entry.relativePath)) return undefined
  const url = pathFilesApi.thumbnailUrl(fileTarget(entry))
  return entry.revision ? `${url}&revision=${encodeURIComponent(entry.revision)}` : url
}
const pending = ref(false)
const loaded = ref(false)
const loading = useDelayedSkeleton(() => pending.value && !loaded.value)
let previousLocation: { directory: PathDirectory; path: string; epoch: number } | undefined
const error = ref('')
const workspaceUnavailable = ref(false)
const renamingPath = ref('')
const renameName = ref('')
const renaming = ref(false)
const contextEntry = ref<PathFileEntry | null>(null)
const fileInfo = ref<{
  file: { displayName: string; ext: string; sizeBytes: number; mimeType?: string }
  location: string
  x: number
  y: number
} | null>(null)
const contextX = ref(0)
const contextY = ref(0)
const { uploadingItems, createGhost, updateGhostProgress, removeGhost, failGhost } = useUploadQueue()
let request = 0
const downloadsPath = 'download'
const isPersonalRoot = computed(() => props.directoryId === 'personal' && props.relativePath === '')
function isDownloads(entry: PathFileEntry) {
  return isPersonalRoot.value && entry.kind === 'directory' && entry.relativePath === downloadsPath
}

function entryLabel(entry: PathFileEntry) {
  return isDownloads(entry) ? t('filesUi.downloadsFolder') : entry.name
}

function folderCountLabel(entry: PathFileEntry) {
  if (entry.fileCount === undefined || entry.folderCount === undefined) return '—'
  return t('filesViewUi.folderContents', { files: entry.fileCount, folders: entry.folderCount })
}

const sortColumns = ['name', 'type', 'size'] as const
function sortEntries(items: readonly PathFileEntry[]) {
  return [...items].sort((a, b) => {
    const pinned = Number(isDownloads(b)) - Number(isDownloads(a))
    if (pinned) return pinned
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
    const difference = props.sortKey === 'size' ? a.size - b.size
      : props.sortKey === 'type' && a.kind === 'file' ? fileName(a).ext.localeCompare(fileName(b).ext) : 0
    return (difference || a.name.localeCompare(b.name, undefined, { numeric: true })) * (props.sortDir === 'desc' ? -1 : 1)
  })
}
const sortedEntries = computed(() => sortEntries(entries.value))

const listBrowser = ref<InstanceType<typeof FileBrowserList> | null>(null)
const openPaths = ref(new Set<string>())
const treePending = ref(new Set<string>())
const treeEntries = ref(new Map<string, PathFileEntry[]>())
const treeChildren = computed(() => new Map([...treeEntries.value].map(([path, children]) => [path, sortEntries(children)])))
const visibleEntries = computed(() => {
  if (props.viewMode !== 'list') return sortedEntries.value
  const result: PathFileEntry[] = []
  function visit(items: readonly PathFileEntry[]) {
    for (const entry of items) {
      result.push(entry)
      if (openPaths.value.has(entry.relativePath)) visit(treeChildren.value.get(entry.relativePath) ?? [])
    }
  }
  visit(sortedEntries.value)
  return result
})

async function toggleFolder(entry: PathFileEntry) {
  const path = entry.relativePath
  if (treePending.value.has(path)) return
  const opening = !openPaths.value.has(path)
  const generation = request
  const pendingPaths = treePending.value
  pendingPaths.add(path)
  try {
    if (opening) {
      const children = await pathFilesApi.entries(props.directoryId, path)
      if (generation !== request) return
      treeEntries.value.set(path, children)
      await nextTick()
    }
    if (generation !== request) return
    const root = listBrowser.value?.$el as HTMLElement | undefined
    const content = root?.querySelector<HTMLElement>(`[data-tree-path="${CSS.escape(path)}"]`)
    if (!root || !content) return
    await runtime.runGroupToggle({
      root, content, opening,
      mutate: () => { if (opening) openPaths.value.add(path); else openPaths.value.delete(path) },
      waitForLayout: nextTick,
      duration: 250,
      easing: 'cubic-bezier(.22,1,.36,1)',
    })
  } catch (cause) {
    if (generation === request) showAppError(errorMessage(cause))
  } finally {
    pendingPaths.delete(path)
  }
}

async function refreshTree(items: readonly PathFileEntry[], directory: PathDirectory, generation: number) {
  await Promise.all(items.filter(entry => entry.kind === 'directory' && openPaths.value.has(entry.relativePath)).map(async entry => {
    const path = entry.relativePath
    try {
      const children = await pathFilesApi.entries(directory, path)
      if (generation !== request) return
      treeEntries.value.set(path, children)
      await refreshTree(children, directory, generation)
    } catch {
      if (generation !== request) return
      openPaths.value.delete(path)
      treeEntries.value.delete(path)
    }
  }))
}

async function load() {
  const generation = ++request
  const location = { directory: props.directoryId, path: props.relativePath, epoch: accountBoundaryEpoch.value }
  if (previousLocation?.directory !== location.directory || previousLocation.path !== location.path
    || previousLocation.epoch !== location.epoch) {
    openPaths.value.clear()
    treePending.value = new Set<string>()
    treeEntries.value.clear()
    entries.value = []
    loaded.value = false
  }
  previousLocation = location
  pending.value = true
  error.value = ''
  workspaceUnavailable.value = false
  try {
    let listed = await pathFilesApi.entries(location.directory, location.path)
    if (generation !== request) return
    if (isPersonalRoot.value && !listed.some(isDownloads)) {
      let creationError: unknown
      try {
        await pathFilesApi.createFolder({ directoryId: 'personal', relativePath: downloadsPath })
      } catch (cause) {
        creationError = cause
      }
      if (generation !== request) return
      // 另一标签页或下载工具也可能在此时创建同一目录。
      listed = await pathFilesApi.entries('personal')
      if (generation === request && creationError && !listed.some(isDownloads))
        showAppError(errorMessage(creationError))
    }
    if (generation === request) {
      if (JSON.stringify(entries.value) !== JSON.stringify(listed)) entries.value = listed
      loaded.value = true
      await refreshTree(listed, location.directory, generation)
    }
  } catch (cause) {
    if (generation === request) {
      workspaceUnavailable.value = !!cause && typeof cause === 'object' && 'code' in cause && cause.code === 'workspace_unavailable'
      error.value = errorMessage(cause)
    }
  } finally {
    if (generation === request) {
      pending.value = false
    }
  }
}

useFileWatch(() => pathFilesApi.watchDirectoryUrl?.({
  directoryId: props.directoryId,
  relativePath: props.relativePath,
}), () => load())

watch([() => props.directoryId, () => props.relativePath, () => props.reload, accountBoundaryEpoch], load, { immediate: true })
watch([() => props.directoryId, () => props.relativePath, accountBoundaryEpoch], () => {
  cancelRename()
  contextEntry.value = null
  fileInfo.value = null
})
onScopeDispose(() => { request++ })

function selected(entry: PathFileEntry) { return props.selectedPaths?.has(entry.relativePath) ?? false }
function preSelected(entry: PathFileEntry) { return props.previewPaths?.has(entry.relativePath) ?? false }
function selectableEntries() { return visibleEntries.value.filter(entry => !isDownloads(entry)) }
function selectedEntries() {
  if (props.viewMode !== 'list') return sortedEntries.value.filter(selected)
  const result: PathFileEntry[] = []
  function visit(items: readonly PathFileEntry[]) {
    for (const entry of items) {
      if (selected(entry)) result.push(entry)
      const children = treeEntries.value.get(entry.relativePath)
      if (children) visit(children)
    }
  }
  visit(sortedEntries.value)
  return result
}

function openContext(entry: PathFileEntry, event: MouseEvent) {
  if (isDownloads(entry) && props.viewMode !== 'list') return
  contextX.value = event.clientX
  contextY.value = event.clientY
  contextEntry.value = entry
}

function runContext(action: (entry: PathFileEntry) => void) {
  const entry = contextEntry.value
  contextEntry.value = null
  if (entry) action(entry)
}

const archiveTarget = ref<PathFileRef | null>(null)
const compressTarget = ref<PathFileRef | null>(null)
const compressPaths = ref<string[]>([])
const archiveName = ref('')
const extracting = ref(false)
const extractError = ref('')
const archiveSuffix = /\.(?:tar\.gz|tgz|tar|zip)$/iu

function openCompression(entry: PathFileEntry) {
  archiveName.value = entry.kind === 'file' ? fileName(entry).base : entry.name
  compressTarget.value = fileTarget(entry)
  compressPaths.value = [entry.relativePath]
  extractError.value = ''
}

function openSelectedCompression() {
  const entries = selectedEntries()
  if (!entries.length || !pathFilesApi.compressArchive) return
  const first = entries[0]!
  archiveName.value = first.kind === 'file' ? fileName(first).base : first.name
  compressTarget.value = fileTarget(entries[0]!)
  compressPaths.value = entries.map(entry => entry.relativePath)
  extractError.value = ''
}

async function submitCompression({ name }: { name: string }) {
  const target = compressTarget.value
  if (!target || extracting.value || !pathFilesApi.compressArchive) return
  const epoch = accountBoundaryEpoch.value
  extracting.value = true
  extractError.value = ''
  try {
    await pathFilesApi.compressArchive(target, compressPaths.value, name)
    if (epoch === accountBoundaryEpoch.value) {
      await load()
      emit('compressed')
    }
    compressTarget.value = null
  } catch (error) {
    if (epoch === accountBoundaryEpoch.value) extractError.value = errorMessage(error)
  } finally { extracting.value = false }
}

function isArchive(entry: PathFileEntry) {
  return entry.kind === 'file' && archiveSuffix.test(entry.name)
}

function openExtraction(entry: PathFileEntry) {
  archiveName.value = entry.name.replace(archiveSuffix, '')
  archiveTarget.value = fileTarget(entry)
  extractError.value = ''
}

async function submitExtraction({ name }: { name: string }) {
  const target = archiveTarget.value
  if (!target || extracting.value || !pathFilesApi.extractArchive) return
  const epoch = accountBoundaryEpoch.value
  extracting.value = true
  extractError.value = ''
  try {
    await pathFilesApi.extractArchive(target, name)
    if (epoch === accountBoundaryEpoch.value) await load()
    archiveTarget.value = null
  } catch (error) {
    if (epoch === accountBoundaryEpoch.value) extractError.value = errorMessage(error)
  } finally { extracting.value = false }
}

function openInfo(entry: PathFileEntry) {
  const { base, ext } = fileName(entry)
  fileInfo.value = {
    file: { displayName: base, ext, sizeBytes: entry.size, mimeType: entry.mimeType ?? undefined },
    location: props.relativePath || '/',
    x: contextX.value,
    y: contextY.value,
  }
}

function startRename(entry: PathFileEntry) {
  renamingPath.value = entry.relativePath
  renameName.value = entry.name
}

function cancelRename() { renamingPath.value = '' }

async function commitRename(entry: PathFileEntry) {
  if (renamingPath.value !== entry.relativePath || renaming.value) return
  const name = renameName.value.trim()
  if (!name || name === entry.name) { cancelRename(); return }
  if (/[\/\\]/.test(name)) { showAppError(t('projects.invalidName')); return }
  const directoryId = props.directoryId
  const slash = entry.relativePath.lastIndexOf('/')
  const destination = entry.relativePath.slice(0, slash + 1) + name
  renaming.value = true
  try {
    await pathFilesApi.move({ directoryId, relativePath: entry.relativePath }, destination)
    cancelRename()
    emit('renamed')
    void load()
  } catch (cause) {
    showAppError(errorMessage(cause))
  } finally {
    renaming.value = false
  }
}

const conflictDialog = ref<InstanceType<typeof UploadConflictDialog> | null>(null)

async function uploadItems(items: UploadItem[]) {
  const target = { directoryId: props.directoryId, relativePath: props.relativePath }
  const epoch = accountBoundaryEpoch.value
  for (const item of items) {
    if (epoch !== accountBoundaryEpoch.value) return
    const { base, ext } = splitName(item.file.name)
    const ghost = createGhost(base || item.file.name, ext)
    try {
      await uploadWorkspaceFile(target, item, progress => updateGhostProgress(ghost, progress),
        conflicts => conflictDialog.value?.show(conflicts) ?? Promise.resolve(new Map()),
        () => epoch === accountBoundaryEpoch.value, pathFilesApi)
      removeGhost(ghost)
    } catch (cause) {
      failGhost(ghost)
      showAppError(errorMessage(cause))
    }
  }
  if (items.length && epoch === accountBoundaryEpoch.value && target.directoryId === props.directoryId
    && target.relativePath === props.relativePath) void load()
}

function selectFiles(event: Event) {
  const input = event.target as HTMLInputElement
  const items = filesToItems(input.files ?? [])
  input.value = ''
  void uploadItems(items)
}

async function handleDrop(event: DragEvent) {
  if (!event.dataTransfer?.types.includes('Files')) return
  const target = { directoryId: props.directoryId, relativePath: props.relativePath }
  const epoch = accountBoundaryEpoch.value
  const folder = (event.target instanceof Element ? event.target : null)?.closest<HTMLElement>('[data-path-folder]')
  const { base, ext } = splitName(event.dataTransfer.files[0]?.name ?? '')
  let ghost: ReturnType<typeof createGhost> | undefined
  const move = pathFilesApi.moveDropped?.(target.directoryId, folder?.dataset.pathFolder ?? target.relativePath,
    async (filename, canOverwrite) => {
      if (epoch !== accountBoundaryEpoch.value) return 'skip'
      const choices = await conflictDialog.value?.show([{ filename, canOverwrite }])
      return epoch === accountBoundaryEpoch.value ? choices?.get(filename)?.action ?? 'skip' : 'skip'
    },
    percent => {
      if (epoch !== accountBoundaryEpoch.value) return
      if (ghost === undefined && percent === 100) return
      ghost ??= createGhost(base, ext)
      updateGhostProgress(ghost, percent)
    })
  if (!move) {
    await uploadItems(await readDroppedEntries(event.dataTransfer))
    return
  }
  try {
    if ((await move).retained) showAppNotice('已复制到目标文件夹')
  } catch (cause) {
    showAppError(errorMessage(cause))
  } finally {
    if (ghost !== undefined) removeGhost(ghost)
    if (epoch === accountBoundaryEpoch.value && target.directoryId === props.directoryId
      && target.relativePath === props.relativePath) void load()
  }
}

function entryObjectId(entry: PathFileEntry) {
  return fileObjectId(props.runtimeSurfaceId, entry.kind === 'directory' ? 'folder' : 'file', `${props.directoryId}:${entry.relativePath}`)
}

function directorySurfaceId(entry: PathFileEntry) {
  return folderSurfaceId(props.runtimeSurfaceId, `${props.directoryId}:${entry.relativePath}`)
}

function entryDropTarget(entry: PathFileEntry): Omit<TargetItem, 'id' | 'element' | 'generation'> | undefined {
  if (entry.kind !== 'directory') return
  return { surfaceId: directorySurfaceId(entry), accepts: ['file-item', 'folder-item'], priority: 2 }
}

async function handleMoveAction(
  objectIds: readonly string[],
  surfaceId: string,
  moveInto: ReturnType<typeof usePathFileSelection>['moveInto'],
  ancestorPath?: string,
) {
  const destination = ancestorPath ?? visibleEntries.value.find(entry => entry.kind === 'directory' && directorySurfaceId(entry) === surfaceId)?.relativePath
  if (destination === undefined || destination === props.relativePath) return
  const sources = visibleEntries.value.filter(entry => !isDownloads(entry) && objectIds.includes(entryObjectId(entry)))
  if (!sources.length || sources.some(entry => entry.relativePath === destination || destination.startsWith(`${entry.relativePath}/`))) return
  // 布局事务要在目录刷新并渲染后读取兄弟卡片和上传入口的最终位置。
  await moveInto(sources, destination, async () => {
    await load()
    await nextTick()
  })
}

defineExpose({ handleDrop, handleMoveAction, selectedEntries, selectableEntries, openSelectedCompression })

function download(entry: PathFileEntry) {
  void pathFilesApi.download({ directoryId: props.directoryId, relativePath: entry.relativePath }).catch(error => showAppError(errorMessage(error)))
}

function fileName(entry: PathFileEntry) {
  const { base, ext } = splitName(entry.name)
  return base ? { base, ext } : { base: entry.name, ext: '' }
}

function openListEntry(entry: PathFileEntry, event: MouseEvent) {
  if (entry.kind === 'directory' && (isDownloads(entry)
    || !(props.selectionMode || event.ctrlKey || event.metaKey || event.shiftKey))) {
    void toggleFolder(entry)
    return
  }
  openEntry(entry, event)
}

function openEntry(entry: PathFileEntry, event: MouseEvent | KeyboardEvent) {
  if (isDownloads(entry)) { emit('openDirectory', entry); return }
  if (props.selectionMode || event.ctrlKey || event.metaKey || event.shiftKey) {
    emit('select', entry, event)
    return
  }
  if (entry.kind === 'directory') emit('openDirectory', entry)
  else openFile(entry)
}

const trackDesktopDrag = useDesktopFileDrag()
function beginCardDrag(entry: PathFileEntry, event: PointerEvent) {
  const directoryId = props.directoryId
  const startNativeDrag = fileOpenAccess?.startNativeDrag
  if (!props.nativeFileDrag || !startNativeDrag || typeof directoryId !== 'string'
    || renamingPath.value === entry.relativePath || isDownloads(entry)) return
  trackDesktopDrag(event, entryObjectId(entry), preview => {
    void startNativeDrag(directoryId, entry.relativePath, preview)
      .catch(error => showAppError(errorMessage(error, t('filesUi.dragDesktopFileFailed'))))
  })
}

function fileTarget(entry: PathFileEntry) {
  return { directoryId: props.directoryId, relativePath: entry.relativePath }
}

function openFile(entry: PathFileEntry) {
  const file = fileTarget(entry)
  const { ext } = fileName(entry)
  if (fileOpenAccess) {
    if (!fileOpenAccess?.canOpenInSystem(file)) return previewFile(entry)
    if (shouldOpenFileInSystem(fileOpenAccess.getOpenPreference(), ext, entry.mimeType))
      return void fileOpenAccess?.openInSystem(file)
  } else if (!isPreviewable(ext, entry.mimeType)) return download(entry)
  previewFile(entry)
}

function previewFile(entry: PathFileEntry) {
  const toPreview = (item: PathFileEntry) => {
    const { base, ext } = fileName(item)
    return { displayName: base, ext, mimeType: item.mimeType, sizeBytes: item.size, workspaceFile: fileTarget(item) }
  }
  const parentPath = entry.relativePath.slice(0, Math.max(0, entry.relativePath.lastIndexOf('/')))
  const siblings = treeEntries.value.get(parentPath) ?? entries.value
  previewStore.open(toPreview(entry), siblings.filter(item => item.kind === 'file').map(toPreview), true)
}
</script>

<style scoped>
.workspace-file-list { --path-tree-indent: 18px; container-type: inline-size; }
.workspace-file-list .list-row.path-tree-nested {
  margin-inline-start: calc(8px + min(45cqi, var(--path-tree-depth) * var(--path-tree-indent)));
  padding-inline-start: 6px;
}

.downloads-row .lr-folder-icon { color: var(--action-primary); }
.workspace-error {
  display: grid;
  justify-items: center;
  gap: var(--space-sm);
  padding: clamp(36px, 12vh, 120px) var(--space-md) var(--space-lg);
  text-align: center;
  color: var(--content-primary);
}
.workspace-error-icon {
  display: grid;
  place-items: center;
  inline-size: 48px;
  block-size: 48px;
  border-radius: var(--radius-sm);
  background: var(--surface-soft);
  color: var(--content-secondary);
}
.workspace-error p { max-inline-size: 30em; margin: 0; color: var(--content-secondary); }


.workspace-file-list :is(.list-head, .list-row) {
  grid-template-columns: minmax(0, 1fr) 64px 72px var(--path-file-actions-width, 76px);
}
.workspace-file-list.has-system-file-open { --path-file-actions-width: 50px; }
.workspace-file-open {
  max-width: 100%; padding: 0; border: 0; background: none; color: inherit; font: inherit;
  text-align: start; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer;
}
.fc-card:focus-within .file-card-hover-actions { opacity: 1; pointer-events: auto; }
.folder-card:focus-within :deep(.file-card-hover-actions) { opacity: 1; pointer-events: auto; }
.list-row:focus-within .file-list-btn { opacity: 1; }
</style>
