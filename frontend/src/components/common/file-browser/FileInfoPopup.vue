<template>
  <Teleport to="body">
    <Transition name="info-pop">
      <div v-if="show && file" ref="el" class="fp-info-win card-close-anchor"
        :style="{ left: posX + 'px', top: posY + 'px', zIndex: myZ }"
        @mousedown.stop
      >
        <div class="fp-info-title" @mousedown.prevent="startDrag">
          <span>{{ t('files.info') }}</span>
          <CloseButton card-corner :title="t('common.actions.close')" @click="$emit('close')" />
        </div>
        <div class="fp-info-body">
          <div class="fp-info-row">
            <span class="fp-info-label">{{ t('files.name') }}</span>
            <span class="fp-info-val">{{ infoFile.displayName }}.{{ infoFile.ext?.toLowerCase() }}</span>
          </div>
          <div class="fp-info-row">
            <span class="fp-info-label">{{ t('files.format') }}</span>
            <span class="fp-info-val">{{ infoFile.ext?.toUpperCase() }}</span>
          </div>
          <div v-if="resolution" class="fp-info-row">
            <span class="fp-info-label">{{ t('sharedUi.resolution') }}</span>
            <span class="fp-info-val">{{ resolution }}</span>
          </div>
          <div v-if="infoFile.sizeBytes != null || infoFile.size" class="fp-info-row">
            <span class="fp-info-label">{{ t('files.size') }}</span>
            <span class="fp-info-val">{{ infoFile.sizeBytes != null ? fmtBytes(infoFile.sizeBytes) : infoFile.size }}</span>
          </div>
          <div v-if="infoFile.createdAt" class="fp-info-row">
            <span class="fp-info-label">{{ t('files.createdAt') }}</span>
            <span class="fp-info-val">{{ formatFileCreatedDate(infoFile.createdAt) }}</span>
          </div>
          <div v-if="infoFile.projectName" class="fp-info-row">
            <span class="fp-info-label">{{ t('files.project') }}</span>
            <span class="fp-info-val">{{ infoFile.projectName }}</span>
          </div>
          <div v-if="folderPath || pathLoading || infoFile.folderName || infoFile.id" class="fp-info-row">
            <span class="fp-info-label">{{ t('files.folderLocation') }}</span>
            <button class="fp-info-path" :disabled="!canNavigate" @click="$emit('navigate', infoFile)">
              {{ folderPath || (pathLoading ? t('files.loading') : infoFile.folderName || '—') }}
            </button>
          </div>
          <div v-if="infoFile.stageName" class="fp-info-row">
            <span class="fp-info-label">{{ t('files.stage') }}</span>
            <span class="fp-info-val">{{ infoFile.stageName }}</span>
          </div>
          <div v-if="infoFile.mimeType" class="fp-info-row">
            <span class="fp-info-label">MIME</span>
            <span class="fp-info-val fp-info-mono">{{ infoFile.mimeType }}</span>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
import { computed, ref, watch, nextTick, type PropType } from 'vue'
import { useWindowDrag } from '@/composables/core/useWindowDrag'
import { nextZ } from '@/composables/core/windowz'
import CloseButton from '@/components/common/overlays/CloseButton.vue'
import { fmtBytes } from '@/utils/fileSize'
import { formatFileCreatedDate } from '@/utils/fileDate'
import { filesApi, workspaceDirectoriesApi } from '@/services/api'
import type { FileMeta } from '@/stores/filesCache'
import { accountBoundaryEpoch, getAccountBoundaryEpoch } from '@/utils/accountBoundary'
const props = defineProps({
  show: Boolean,
  file: { type: Object as PropType<Partial<FileMeta> | undefined>, default: undefined },
  x:    { type: Number, default: 0 },
  y:    { type: Number, default: 0 },
  zIndex: { type: Number, default: 0 },
  resolution: { type: String, default: '' },
})
const emit = defineEmits(['close', 'navigate', 'update:x', 'update:y'])

const el   = ref<HTMLElement | null>(null)
const posX = ref(0)
const posY = ref(0)
const myZ  = ref(0)   // 每次弹出领新 z,盖当前最顶窗口
const detailFile = ref<Partial<FileMeta> | null>(null)
const folderNames = ref<string[]>([])
const workspaceName = ref('')
const pathLoading = ref(false)
let detailLoadSequence = 0
const infoFile = computed<Partial<FileMeta>>(() => {
  const file = props.file ?? {}
  return detailFile.value && String(detailFile.value.id) === String(file.id)
    ? { ...file, ...detailFile.value }
    : file
})
const folderPath = computed(() => {
  if (infoFile.value.attach_id) return ''
  const root = infoFile.value.projectName
    || (infoFile.value.workspaceDirectoryId != null ? (workspaceName.value || t('files.workspace')) : t('files.all'))
  const folders = [...folderNames.value]
  if (!folders.length && infoFile.value.folderName) folders.push(infoFile.value.folderName)
  return [root, ...folders].filter(Boolean).join(' / ')
})
const canNavigate = computed(() => !infoFile.value.attach_id && Number.isSafeInteger(Number(infoFile.value.id)))

watch(() => [props.show, props.x, props.y, props.zIndex], async ([v]) => {
  if (!v) return
  myZ.value = props.zIndex || nextZ()
  posX.value = props.x
  posY.value = props.y
  await nextTick()
  if (el.value) {
    const r = el.value.getBoundingClientRect()
    if (r.right  > window.innerWidth  - 8) posX.value = props.x - r.width  - 4
    if (r.bottom > window.innerHeight - 8) posY.value = props.y - r.height - 4
    posX.value = Math.max(8, posX.value)
    posY.value = Math.max(8, posY.value)
  }
}, { immediate: false })

watch(() => [props.show, props.file?.id, accountBoundaryEpoch.value], ([show]) => {
  const sequence = ++detailLoadSequence
  detailFile.value = null
  folderNames.value = []
  workspaceName.value = ''
  pathLoading.value = false
  const file = props.file
  if (!show || !file || file.attach_id || typeof file.id !== 'number') return
  const fileId = file.id
  const accountEpoch = getAccountBoundaryEpoch()
  pathLoading.value = true
  void (async () => {
    try {
      const location = await filesApi.location(fileId)
      if (sequence !== detailLoadSequence || accountEpoch !== getAccountBoundaryEpoch()) return
      detailFile.value = location.file as Partial<FileMeta>
      folderNames.value = location.folderPath.map(folder => folder.name)
      const workspaceDirectoryId = detailFile.value.workspaceDirectoryId
      if (workspaceDirectoryId != null) {
        const directories = await workspaceDirectoriesApi.list()
        if (sequence !== detailLoadSequence || accountEpoch !== getAccountBoundaryEpoch()) return
        workspaceName.value = directories.find(item => item.id === workspaceDirectoryId)?.name || ''
      }
    } catch {
      // 详情接口失败时继续展示调用方已持有的元数据。
    } finally {
      if (sequence === detailLoadSequence) pathLoading.value = false
    }
  })()
}, { immediate: true })

// ── 拖动 ──────────────────────────────────────────────
const { startDrag } = useWindowDrag(posX, posY, (x, y) => {
  const next = { x: Math.max(0, x), y: Math.max(0, y) }
  emit('update:x', next.x)
  emit('update:y', next.y)
  return next
})
</script>

<style scoped>
.fp-info-win {
  position: fixed;
  width: 220px;
  border-radius: 12px;
  overflow: hidden;
  background: var(--popup-surface-bg);
  backdrop-filter: var(--popup-surface-blur);
  -webkit-backdrop-filter: var(--popup-surface-blur);
  border: 1px solid var(--popup-surface-border);
  box-shadow: var(--popup-surface-shadow);
  user-select: none;
  /* z-index 由 :style 动态(每次弹出盖当前最顶窗口) */
}
.fp-info-title {
  box-sizing: border-box;
  min-height: 44px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px 6px 14px;
  background: var(--surface-glass);
  border-bottom: 1px solid var(--panel-divider);
  cursor: grab;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}
.fp-info-title:active { cursor: grabbing; }
.fp-info-body {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 70vh;
  overflow-y: auto;
}
.fp-info-row { display: flex; flex-direction: column; gap: 2px; }
.fp-info-label {
  font-size: 10px; font-weight: 600;
  color: var(--text-secondary); opacity: .6;
  text-transform: uppercase; letter-spacing: 0.04em;
}
.fp-info-val {
  font-size: 12px; color: var(--text-primary);
  word-break: break-all; line-height: 1.4;
}
.fp-info-path { min-width:0; padding:0; border:0; background:transparent; color:var(--text-primary); font:inherit; font-size:12px; line-height:1.4; text-align:left; text-decoration:underline; text-decoration-style:dotted; text-underline-offset:2px; overflow-wrap:anywhere; cursor:pointer; }
.fp-info-path:disabled { color:var(--text-secondary); cursor:default; text-decoration:none; }
.fp-info-mono { font-family: var(--font-family-mono); font-size: 11px; }

.info-pop-enter-active,
.info-pop-leave-active { transition: opacity 0.12s ease, transform 0.12s ease; }
.info-pop-enter-from,
.info-pop-leave-to     { opacity: 0; transform: scale(0.95); }
</style>
