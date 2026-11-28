<template>
  <ProjectModalShell
    :show="!!project" :inline="nativeWindow" :floating="desktop"
    :width="projectFilesEnabled ? undefined : '480px'"
    :height="projectFilesEnabled ? undefined : '660px'"
    :root-class="{ modal: true, 'stages-expanded': stagesExpanded, 'info-expanded': infoExpanded, 'pm-switching': pmSwitching, 'project-modal-native': nativeWindow, 'project-modal-no-files': !projectFilesEnabled }"
    @close="onModalClose"
  >
        <!-- 悬浮操作按钮：文件多选模式下让位给 .pm-selection-bar（同在右下角，多选栏内容多时会重叠，
             且两边都有删除按钮离太近容易误触），多选栏自己有取消/删除，先隐藏这组项目级按钮 -->
        <div v-if="!fileSelectionActive" class="float-actions">
          <button class="save-float-btn" @click="closeProjectModal" :title="$t('pageUi.saveClose')">
            <Icon name="status.success" :size="14" />
          </button>
          <button class="archive-float-btn" @click="handleArchive" :title="t('projects.archived')">
            <Icon name="action.archive" :size="14" />
          </button>
          <button class="del-float-btn" @click="handleDelete" :title="t('common.actions.delete')">
            <Icon name="action.delete" :size="14" />
          </button>
        </div>

        <!-- 左栏 -->
        <div class="modal-left panel-left" :class="{ 'desktop-project-left': desktop }">

          <!-- 标题保持在固定头部，避免随信息内容滚动 -->
          <div class="proj-header">
            <div class="header-main">
              <button class="status-ball" :class="'sb-' + localStatus" @click.stop="cycleStatus"
                :title="projectStore.kanbanColumns.find(c => c.key === localStatus)?.label ?? localStatus"></button>
              <input
                v-model="localName"
                class="header-name-input"
                :placeholder="t('projects.projectName')"
                @blur="saveName"
                v-enter="(e) => (e.target as HTMLElement).blur()"
                @keydown.esc="cancelName"
              />
            </div>
            <div class="header-progress-bar">
              <div class="header-progress-fill" :style="{ width: headerProgress + '%', background: localColor }"></div>
            </div>
          </div>

          <!-- 可滚动内容区 -->
          <div class="left-content scroll-surface scroll-surface--compact">
            <ProjectInfoPanel
              v-model:client="localClient"
              v-model:start-date="localStartDate"
              v-model:deadline="localDeadline"
              :color="localColor"
              :info-expanded="infoExpanded"
              :compact="!projectFilesEnabled"
              @set-color="setColor"
            />

            <hr class="col-divider" />

            <ProjectStagesPanel
              v-model:stages="localStages"
              v-model:current-stage="localCurrentStage"
              :stage-color="localColor"
              :on-save-stages="saveStages"
              :on-save-todos="saveTodos"
              :on-set-stage="setStage"
            />

          </div><!-- /left-content -->
        </div>

        <ProjectDiskFiles v-if="project && projectFilesEnabled" :key="project.id"
          :project-id="project.id" :project-directory-key="desktop ? JSON.stringify([project.name, project.startDate]) : undefined"
          :native-window="nativeWindow" :desktop="desktop"
          :stages-expanded="stagesExpanded"
          @close="closeProjectModal" @toggle-stages="togglePmStages"
          @selection-change="fileSelectionActive = $event" />
  </ProjectModalShell>

</template>

<script setup lang="ts">
import { useProjectAccess } from '@/api/projects'
import { ref, computed, watch, toRef, nextTick, type PropType } from 'vue'
import { useI18n } from 'vue-i18n'
import { useProjectStore } from '@/stores/projects'
import { usePreferencesStore } from '@/stores/preferences'
import type { Project } from '@/types/project'
import ProjectModalShell from '@/views/Projects/components/ProjectModalShell.vue'
import ProjectInfoPanel from '@/views/Projects/components/ProjectInfoPanel.vue'
import ProjectStagesPanel from '@/views/Projects/components/ProjectStagesPanel.vue'
import ProjectDiskFiles from '@/views/Projects/components/ProjectDiskFiles.vue'
import Icon from '@/components/common/icons/Icon.vue'
import { useProjectDraft } from '@/composables/projects/useProjectDraft'
import { useProjectStages } from '@/composables/projects/useProjectStages'
import { projectProgress } from '@/utils/projectProgress'
import { calculateStageProgress } from '@/composables/projects/useProjectProgress'
import { useProjectModalActions } from '@/composables/projects/useProjectModalActions'
import { useProjectModalLayout } from '@/composables/projects/useProjectModalLayout'

const props = defineProps({
  project: { type: Object as PropType<Project | null>, default: null },
  nativeWindow: Boolean,
})
const { t } = useI18n()
const emit = defineEmits<{ close: [] }>()
function closeProjectModal() { emit('close') }
function onModalClose() { closeProjectModal() }

const projectStore = useProjectStore()
const prefsStore       = usePreferencesStore()
const projectAccess = useProjectAccess()
const desktop = projectAccess.storesProjectsLocally
const projectFilesEnabled = projectAccess.projectFilesEnabled !== false
const fileSelectionActive = ref(false)
watch(() => props.project?.id, () => { fileSelectionActive.value = false })

const {
  localName,
  localStages,
  localStartDate,
  localDeadline,
  localClient,
  localColor,
  localCurrentStage,
  localStatus,
  reset: resetProjectDraft,
  syncExternal: syncProjectDraft,
} = useProjectDraft()
const projectStages = useProjectStages({
  stages: localStages,
  currentStage: localCurrentStage,
  status: localStatus,
})
const {
  saveName, cancelName, setColor, cycleStatus,
  saveStages, saveTodos, handleDelete, handleArchive,
} = useProjectModalActions({
  project: () => props.project,
  localName,
  localColor,
  localStatus,
  localStages,
  localCurrentStage,
  close: closeProjectModal,
})
const { stagesExpanded, infoExpanded, switching: pmSwitching, toggle: togglePmStages } = useProjectModalLayout({
  loaded: toRef(prefsStore, 'loaded'),
  pmStagesExpanded: toRef(prefsStore, 'pmStagesExpanded'),
  savePmStagesExpanded: prefsStore.savePmStagesExpanded,
})

const initializing = ref(false)
watch(() => props.project?.id, async (_id, _previous, onCleanup) => {
  let current = true
  onCleanup(() => { current = false })
  initializing.value = true
  resetProjectDraft(props.project)
  await nextTick()
  if (current) initializing.value = false
}, { immediate: true })

// 外部（Agent/IM）修改日期时同步本地状态（project?.id 不变，但日期值变了）
watch(() => props.project, async (p, previous, onCleanup) => {
  if (!p || p.id !== previous?.id) return
  let current = true
  onCleanup(() => { current = false })
  initializing.value = true
  syncProjectDraft(p)
  await nextTick()
  if (current) initializing.value = false
})

watch(localClient, v => {
  if (initializing.value) return
  const id = props.project?.id
  if (!id) return
  projectStore.updateProjectDebounced(id, { client: v || null })
})

watch(localStartDate, v => {
  if (initializing.value) return
  const id = props.project?.id
  if (!id) return
  projectStore.updateProject(id, { startDate: v || null })
})

watch(localDeadline, v => {
  if (initializing.value) return
  const id = props.project?.id
  if (!id) return
  projectStore.updateProject(id, { deadline: v || null })
})

const headerProgress = computed(() => {
  return projectProgress(
    { stages: localStages.value, currentStage: localCurrentStage.value },
    () => calculateStageProgress(localStages.value, localCurrentStage.value),
  )
})


function setStage(key: string) {
  const transition = projectStages.transitionStage(key)
  if (!transition) return
  if (props.project) projectStore.setStage(props.project.id, key, transition.progress)
}

</script>

<style scoped>
/* .drp-input 已由 DateSpanPicker.vue scoped 直接消费 --input-* token，不再需要 :deep 覆盖 */

.modal {
  display: flex;
  width: 100%; height: 100%;
  overflow: hidden;
}
.modal button { outline: none; }
.modal.project-modal-no-files .modal-left { width: 100%; flex: 1; }
.modal.project-modal-native .modal-left { width: var(--desktop-project-sidebar-width); }

/* ── 左栏 ── */
.modal-left {
  display: flex; flex-direction: column; overflow: hidden;
  width: 300px; flex-shrink: 0; will-change: width;
  /* 缓入保留，缓出尾巴拉长（P2=0.2,1）→ 到位是「沉降」而非「急停」，消除生硬停下。
     时长 0.36s 与 togglePmStages 的 LAYOUT_MS 联动，改一处两处一起改。 */
  transition: width 0.36s cubic-bezier(0.45, 0, 0.2, 1);
}
/* 与桌面工作台使用同一层半透明底色。 */
.project-modal-root .desktop-project-left.panel-left {
  background: var(--desktop-l0-surface);
}
/* 列宽由 stages-expanded 驱动 */
.modal.stages-expanded .modal-left { width: 50%; }

/* 信息区版面由 info-expanded 驱动，与列宽同时切换。
   版面1：竖排，每行之间横向分割线（沿用 .col-divider）。
   版面2：2×2 网格，十字分割线——联系人|周期、看板|颜色 竖线，上下两行之间横线（用 section 的 border 画）*/
.info-block { display: flex; flex-direction: column; }
.modal.info-expanded .info-block {
  display: grid; grid-template-columns: 1fr 1fr; gap: 0; align-items: stretch;
}
.modal.info-expanded .info-block > .col-divider { display: none; }
.modal.info-expanded .info-block > .section { padding: 11px 16px; position: relative; min-height: 56px; }
/* 3 区块：联系人 | 周期 同一行，颜色独占整行 */
.modal.info-expanded .info-block > .section:nth-of-type(3) { grid-column: 1 / -1; }
/* 横线：联系人/周期 与 颜色 之间，整条独立 */
.modal.info-expanded .info-block > .section:nth-of-type(1),
.modal.info-expanded .info-block > .section:nth-of-type(2) {
  border-bottom: 1px solid rgba(0,0,0,0.07);
}
/* 竖线：仅 联系人|周期 一条独立短线——固定 28px、居中，与横线不相交 */
.modal.info-expanded .info-block > .section:nth-of-type(1)::after {
  content: ''; position: absolute; right: 0; top: 50%; transform: translateY(-50%);
  width: 1px; height: 28px; background: rgba(0,0,0,0.07);
}

/* 标题 */
.proj-header {
  height: 52px; box-sizing: border-box;
  display: flex; flex-direction: column; flex-shrink: 0;
  position: relative;
}
.proj-header::after {
  content: '';
  position: absolute; inset: 0;
  pointer-events: none;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.85);
}
.header-main {
  flex: 1; display: flex; align-items: center; gap: 8px;
  padding: 0 16px; min-width: 0;
}
/* 状态球：项目名前的状态指示（点击循环状态，替代看板列）*/
.status-ball {
  width: 14px; height: 14px; border-radius: 50%; flex-shrink: 0;
  border: none; padding: 0; cursor: pointer; outline: none;
  transition: transform 0.15s, box-shadow 0.15s;
}
.status-ball:hover { transform: scale(1.2); }
.sb-pending { background: #d46b6b; box-shadow: 0 0 0 3px rgba(212,107,107,0.2); }
.sb-active  { background: #c9943a; box-shadow: 0 0 0 3px rgba(201,148,58,0.2); }
.sb-done    { background: #5a9e88; box-shadow: 0 0 0 3px rgba(90,158,136,0.2); }
/* 名称：默认像纯文本，悬停/聚焦才浮出编辑框（与定时任务卡 .title-input 同款样式+动画） */
.header-name-input {
  flex: 1; min-width: 0; box-sizing: border-box;
  font-size: 17px; font-weight: 700; color: var(--text-primary);
  font-family: var(--font-sans); line-height: 1.2; outline: none;
  padding: 7px 11px; margin: 0 -11px 0 0;
  border: 1px solid transparent; border-radius: 10px; corner-shape: round;
  background: transparent; caret-color: var(--input-caret-color);
  transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
}
.header-name-input::placeholder { color: var(--text-secondary); opacity: 0.45; font-weight: 700; }
.header-name-input:hover {
  border-color: var(--input-border-hover);
  background: var(--input-bg);
  box-shadow: var(--input-hover-shadow);
}
.header-progress-bar {
  height: 3px; background: rgba(0,0,0,0.07); flex-shrink: 0; position: relative;
}
.header-progress-fill { height: 100%; border-radius: 99px; transition: width 0.4s; }
.header-pct {
  position: absolute; right: 8px; bottom: 5px;
  font-size: 12px; font-weight: 700; line-height: 1;
}

/* 可滚动内容区 */
.left-content {
  flex: 1; overflow-y: auto; padding: 12px 16px 0;
  display: flex; flex-direction: column; gap: 0; min-height: 0;
  scrollbar-gutter: auto;
}

.section-label {
  font-size: 10px; font-weight: 600; color: var(--text-secondary);
  text-transform: uppercase; letter-spacing: 0.07em;
  display: flex; align-items: center; gap: 6px; flex-shrink: 0;
}
.label-hint {
  font-size: 9.5px; font-weight: 500; opacity: 0.6;
  text-transform: none; letter-spacing: 0;
}
.col-divider { border: none; height: 1px; background: linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.07) 20%, rgba(0,0,0,0.07) 80%, transparent 100%); margin: 0; }

.field-input {
  width: 100%; padding: 8px 11px; box-sizing: border-box;
  border: 1px solid var(--input-border); border-radius: var(--control-radius);
  background: var(--input-bg); font-size: 13px;
  font-family: var(--font-sans); color: var(--input-fg);
  outline: none; transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
}
.field-input:hover { border-color: var(--input-border-hover); background: var(--input-bg-hover); box-shadow: var(--input-hover-shadow); }
.field-input:focus { border-color: var(--input-border-focus); background: var(--input-bg-focus); }

/* 状态 */
.status-group { display: flex; gap: 4px; flex-wrap: wrap; justify-content: center; }
.status-btn {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 9px; border-radius: 20px;
  border: 1.5px solid transparent; font-size: 12px; font-weight: 600;
  cursor: pointer; font-family: var(--font-sans);
  background: rgba(0,0,0,0.10); color: #5a5f78;
  transition: background 0.15s, color 0.15s, border-color 0.15s; outline: none;
}
.status-btn:hover { background: rgba(0,0,0,0.15); color: var(--text-primary); }
.opt-dot { width: 6px; height: 6px; border-radius: 50%; }
.status-btn.s-pending .opt-dot { background: #d46b6b; }
.status-btn.s-active  .opt-dot { background: #c9943a; }
.status-btn.s-done    .opt-dot { background: #5a9e88; }
.status-btn.s-pending.active .opt-dot { background: #d46b6b; }
.status-btn.s-active.active  .opt-dot { background: #c9943a; }
.status-btn.s-done.active .opt-dot { background: #5a9e88; }
.status-btn.s-pending.active { background: rgba(212,107,107,0.12); border-color: rgba(212,107,107,0.5); color: #9e3e3e; }
.status-btn.s-active.active  { background: rgba(201,148,58,0.12);  border-color: rgba(201,148,58,0.5);  color: #8a5f18; }
.status-btn.s-done.active    { background: rgba(90,158,136,0.12);  border-color: rgba(90,158,136,0.4);  color: #2e6e5a; }

/* 配色 */
.color-grid { display: flex; gap: 6px; flex-wrap: wrap; justify-content: center; }
.color-chip {
  width: 22px; height: 22px; border-radius: 6px;   /* 方形（圆角）色块 */
  border: 2px solid rgba(255,255,255,0.5);
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  transition: border-color 0.15s; padding: 0; outline: none;
}
.color-chip:hover { border-color: rgba(255,255,255,0.9); }
.color-chip.active { border-color: #fff; box-shadow: 0 0 0 2px rgba(0,0,0,0.18); }

/* 阶段 */



/* 悬浮操作按钮 */
.float-actions {
  position: absolute; bottom: 14px; right: 14px; z-index: 10;
  display: flex; gap: 8px; align-items: center;
}
.save-float-btn {
  width: 36px; height: 36px; border-radius: 10px;
  background: rgba(90,158,136,0.1);
  border: 1px solid rgba(90,158,136,0.28);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; color: var(--color-success);
  box-shadow: 0 2px 10px rgba(90,158,136,0.12);
  transition: background 0.15s, box-shadow 0.15s;
}
.save-float-btn:hover {
  background: rgba(90,158,136,0.18);
  box-shadow: 0 4px 14px rgba(90,158,136,0.22);
}
.del-float-btn {
  width: 36px; height: 36px; border-radius: 10px;
  background: rgba(176,120,88,0.1);
  border: 1px solid rgba(176,120,88,0.25);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; color: var(--color-warning);
  box-shadow: 0 2px 10px rgba(176,120,88,0.15);
  transition: background 0.15s, box-shadow 0.15s;
}
.del-float-btn:hover {
  background: rgba(176,120,88,0.18);
  box-shadow: 0 4px 14px rgba(176,120,88,0.25);
}
.archive-float-btn {
  width: 36px; height: 36px; border-radius: 10px;
  background: color-mix(in srgb, var(--action-primary) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--action-primary) 25%, transparent);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; color: var(--color-primary, var(--action-primary));
  box-shadow: 0 2px 10px color-mix(in srgb, var(--action-primary) 12%, transparent);
  transition: background 0.15s, box-shadow 0.15s;
}
.archive-float-btn:hover {
  background: color-mix(in srgb, var(--action-primary) 18%, transparent);
  box-shadow: 0 4px 14px color-mix(in srgb, var(--action-primary) 22%, transparent);
}

</style>
