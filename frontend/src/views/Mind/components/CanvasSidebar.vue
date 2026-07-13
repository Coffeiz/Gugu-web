<template>
  <div
    ref="rootRef"
    class="canvas-drawer glass-card"
    :class="{ open: expanded, 'project-panel': panel === 'projects' }"
    :style="{ '--cd-target-width': panel === 'projects' ? '284px' : '190px' }"
    @pointerdown.stop
  >
    <div class="cd-head">
      <button class="cd-toggle" :class="{ active: panel === 'canvases' }" title="画布列表" @click="togglePanel('canvases')">
        <PhSquaresFour :size="16" weight="bold" />
      </button>
      <button class="cd-toggle" :class="{ active: panel === 'projects' }" title="项目素材" @click="togglePanel('projects')">
        <PhBriefcase :size="16" weight="bold" />
      </button>
      <span class="cd-title">{{ panel === 'canvases' ? '画布' : '项目' }}</span>
      <button v-if="panel === 'canvases'" title="新建画布" class="cd-add" @click="emit('create')"><PhPlus :size="15" weight="bold" /></button>
    </div>

    <!-- 两个面板始终挂载、各自在固定宽度下量高度。开关时只换目标尺寸与可见内容，
         不会再出现旧面板尺寸被新面板借用一帧的横向/纵向两段动画。 -->
    <div class="cd-collapse" :style="{ height: expanded ? `${targetHeight}px` : '0px' }">
      <div class="cd-stage">
        <section class="cd-content-panel canvas-panel" :class="{ visible: visiblePanel === 'canvases' && contentVisible }" :aria-hidden="visiblePanel !== 'canvases'">
          <div ref="canvasListRef" class="cd-list canvas-list">
            <div v-for="canvas in canvases" :key="canvas.id" class="canvas-item" :class="{ active: canvas.id === activeId }" @click="onOpen(canvas.id)">
              <span v-if="renamingId === canvas.id" class="rename-sizer" @click.stop>
                <span class="rename-ghost">{{ renameText || ' ' }}</span>
                <input
                  ref="renameInputRef"
                  v-model="renameText"
                  class="rename-input-inline"
                  v-enter="() => commitRename(canvas.id)"
                  @keydown.esc="cancelRename"
                  @blur="commitRename(canvas.id)"
                  @focus="($event.target as HTMLInputElement).select()"
                />
              </span>
              <span v-else class="ci-title">{{ canvas.title || '未命名画布' }}</span>
              <div class="ci-actions">
                <button :title="renamingId === canvas.id ? '确认' : '重命名'" class="ci-btn" @click.stop="renamingId === canvas.id ? commitRename(canvas.id) : startRename(canvas)">
                  <PhCheck v-if="renamingId === canvas.id" :size="11" weight="bold" />
                  <PhPencilSimple v-else :size="11" weight="bold" />
                </button>
                <button title="删除画布" class="ci-btn ci-delete" @click.stop="onDelete(canvas)"><PhTrash :size="11" weight="bold" /></button>
              </div>
            </div>
          </div>
        </section>

        <section class="cd-content-panel projects-panel" :class="{ visible: visiblePanel === 'projects' && contentVisible }" :aria-hidden="visiblePanel !== 'projects'">
          <div ref="projectListRef" class="cd-list project-list">
            <input v-model="projectQuery" class="project-search" placeholder="筛选项目" @pointerdown.stop />
            <div v-if="projectsLoading && !projects.length" class="project-skeletons" aria-hidden="true">
              <span v-for="index in 3" :key="index" class="project-skeleton"></span>
            </div>
            <template v-else>
              <section v-for="group in projectGroups" :key="group.status" v-show="group.items.length" class="project-group">
                <div class="project-group-title"><span class="project-status-dot" :class="`is-${group.status}`"></span>{{ group.label }}<span>{{ group.items.length }}</span></div>
                <ProjectDrawerCard
                  v-for="project in group.items"
                  :key="project.id"
                  :project="project"
                  :add-to-canvas="addProjectToCanvas"
                  @add="emit('addProject', project.id)"
                />
              </section>
              <div v-if="!projectsLoading && !filteredProjects.length" class="project-empty">没有匹配的项目</div>
            </template>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type PropType } from 'vue'
import { PhBriefcase, PhCheck, PhPencilSimple, PhPlus, PhSquaresFour, PhTrash } from '@phosphor-icons/vue'
import type { MindCanvas } from '@/services/api'
import type { Project } from '@/types/project'
import ProjectDrawerCard from './ProjectDrawerCard.vue'

const props = defineProps({
  canvases: { type: Array as PropType<MindCanvas[]>, required: true },
  activeId: { type: Number as PropType<number | null>, default: null },
  projects: { type: Array as PropType<Project[]>, required: true },
  canvasProjectIds: { type: Object as PropType<Set<number>>, required: true },
  projectsLoading: { type: Boolean, default: false },
  addProjectToCanvas: {
    type: Function as PropType<(projectId: number, center: { x: number; y: number }, size: { w: number; h: number }) => Promise<HTMLElement | null>>,
    required: true,
  },
})
const emit = defineEmits<{
  (e: 'create'): void
  (e: 'open', id: number): void
  (e: 'delete', id: number): void
  (e: 'rename', id: number, title: string): void
  (e: 'addProject', id: number): void
}>()

type Panel = 'canvases' | 'projects'
const expanded = ref(false)
const panel = ref<Panel>('canvases')
const visiblePanel = ref<Panel>('canvases')
const contentVisible = ref(false)
const rootRef = ref<HTMLElement | null>(null)
const canvasListRef = ref<HTMLElement | null>(null)
const projectListRef = ref<HTMLElement | null>(null)
const panelHeights = ref<Record<Panel, number>>({ canvases: 0, projects: 0 })
const targetHeight = computed(() => panelHeights.value[panel.value])
let canvasListObserver: ResizeObserver | null = null
let projectListObserver: ResizeObserver | null = null
let contentTimer: ReturnType<typeof setTimeout> | null = null

const projectQuery = ref('')
const filteredProjects = computed(() => {
  const query = projectQuery.value.trim().toLowerCase()
  const available = props.projects.filter(project => !props.canvasProjectIds.has(project.id))
  return query ? available.filter(project => `${project.name} ${project.client || ''}`.toLowerCase().includes(query)) : available
})
const projectGroups = computed(() => [
  { status: 'active', label: '进行中', items: filteredProjects.value.filter(project => project.status === 'active') },
  { status: 'pending', label: '待开始', items: filteredProjects.value.filter(project => project.status === 'pending') },
  { status: 'done', label: '已完成', items: filteredProjects.value.filter(project => project.status === 'done') },
])

function measurePanel(panelName: Panel) {
  const list = panelName === 'canvases' ? canvasListRef.value : projectListRef.value
  if (!list) return
  panelHeights.value = {
    ...panelHeights.value,
    [panelName]: Math.min(list.scrollHeight, window.innerHeight * 0.55),
  }
}
function measurePanels() {
  measurePanel('canvases')
  measurePanel('projects')
}
function clearContentTimer() {
  if (contentTimer) clearTimeout(contentTimer)
  contentTimer = null
}
function revealContent(delay: number) {
  clearContentTimer()
  contentTimer = setTimeout(() => { contentVisible.value = true }, delay)
}
async function togglePanel(nextPanel: Panel) {
  if (expanded.value && panel.value === nextPanel) {
    contentVisible.value = false
    clearContentTimer()
    contentTimer = setTimeout(() => { expanded.value = false }, 120)
    return
  }
  contentVisible.value = false
  panel.value = nextPanel
  visiblePanel.value = nextPanel
  await nextTick()
  measurePanels()
  expanded.value = true
  revealContent(90)
}

function onOutsidePointerDown(event: PointerEvent) {
  const root = rootRef.value
  if (expanded.value && root && !root.contains(event.target as Node)) togglePanel(panel.value)
}
watch(expanded, (open) => {
  if (open) window.addEventListener('pointerdown', onOutsidePointerDown)
  else window.removeEventListener('pointerdown', onOutsidePointerDown)
})

const renamingId = ref<number | null>(null)
const renameText = ref('')
const renameInputRef = ref<HTMLInputElement[] | HTMLInputElement | null>(null)
function onOpen(id: number) {
  if (renamingId.value == null) emit('open', id)
}
function onDelete(canvas: MindCanvas) {
  if (!window.confirm(`删除画布「${canvas.title || '未命名画布'}」？画布上的贴纸摆放将一并清空，此操作不可撤销。`)) return
  emit('delete', canvas.id)
}
function startRename(canvas: MindCanvas) {
  renamingId.value = canvas.id
  renameText.value = canvas.title || ''
  nextTick(() => {
    const input = Array.isArray(renameInputRef.value) ? renameInputRef.value[0] : renameInputRef.value
    input?.focus()
    input?.select()
  })
}
function cancelRename() {
  renamingId.value = null
  renameText.value = ''
}
function commitRename(id: number) {
  if (renamingId.value !== id) return
  const title = renameText.value.trim()
  renamingId.value = null
  if (title) emit('rename', id, title)
}

onMounted(() => {
  canvasListObserver = new ResizeObserver(() => measurePanel('canvases'))
  projectListObserver = new ResizeObserver(() => measurePanel('projects'))
  if (canvasListRef.value) canvasListObserver.observe(canvasListRef.value)
  if (projectListRef.value) projectListObserver.observe(projectListRef.value)
  measurePanels()
  window.addEventListener('resize', measurePanels)
})
onBeforeUnmount(() => {
  clearContentTimer()
  canvasListObserver?.disconnect()
  projectListObserver?.disconnect()
  window.removeEventListener('resize', measurePanels)
  window.removeEventListener('pointerdown', onOutsidePointerDown)
})
</script>

<style scoped>
.canvas-drawer {
  position: absolute; top: 50%; right: 12px; z-index: 8; transform: translateY(-50%);
  box-sizing: border-box; width: 36px; overflow: hidden;
  transition: width 0.28s cubic-bezier(0.34,1.2,0.64,1);
}
.canvas-drawer.open { width: 190px; }
.canvas-drawer.open.project-panel { width: 284px; }
.cd-head { display: flex; align-items: center; height: 34px; flex-shrink: 0; }
.cd-toggle { flex-shrink: 0; width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center; border: 0; background: none; color: var(--text-secondary); cursor: pointer; }
.cd-toggle:hover, .cd-toggle.active { color: var(--color-primary); }
.canvas-drawer:not(.open) .cd-head { height: 68px; flex-direction: column; }
.canvas-drawer:not(.open) .cd-title, .canvas-drawer:not(.open) .cd-add { display: none; }
.cd-title { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; color: var(--text-secondary); font-size: 12px; font-weight: 700; opacity: 0; transition: opacity .15s ease; }
.canvas-drawer.open .cd-title { opacity: 1; transition-delay: .08s; }
.cd-add { flex-shrink: 0; width: 25px; height: 25px; margin-right: 7px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 6px; background: none; color: var(--text-secondary); cursor: pointer; opacity: 0; pointer-events: none; transition: opacity .15s ease; }
.canvas-drawer.open .cd-add { opacity: 1; pointer-events: auto; transition-delay: .08s; }
.cd-add:hover { color: var(--color-primary); background: rgba(123,127,178,.11); }

.cd-collapse { position: relative; width: var(--cd-target-width); overflow: hidden; transition: height .28s cubic-bezier(0.34,1.2,0.64,1); }
.cd-stage { position: relative; width: 100%; height: 100%; }
.cd-content-panel { position: absolute; top: 0; left: 0; opacity: 0; filter: blur(4px); pointer-events: none; transition: opacity .14s ease-in-out, filter .14s ease-in-out; }
.cd-content-panel.visible { opacity: 1; filter: blur(0); pointer-events: auto; }
.canvas-panel { width: 190px; }
.projects-panel { width: 284px; }
.cd-list { box-sizing: border-box; max-height: 55vh; overflow-y: auto; padding: 0 9px 9px; }
.canvas-list { width: 190px; }
.project-list { display: flex; flex-direction: column; gap: 9px; width: 284px; min-height: 312px; }

.canvas-item { display: flex; align-items: center; gap: 6px; width: 100%; box-sizing: border-box; height: 32px; padding: 0 4px 0 8px; border-radius: 6px; background: none; color: var(--text-secondary); font-size: 12px; cursor: pointer; }
.ci-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.canvas-item:hover { background: rgba(255,255,255,.55); }
.canvas-item.active { background: rgba(255,255,255,.86); color: var(--color-primary); font-weight: 700; box-shadow: 0 1px 3px rgba(60,70,100,.08); }
.rename-sizer { flex: 1; min-width: 0; }
.ci-actions { display: flex; flex-shrink: 0; gap: 2px; opacity: 0; transition: opacity .15s; }
.canvas-item:hover .ci-actions, .canvas-item:has(.rename-input-inline) .ci-actions { opacity: 1; }
.ci-btn { display: inline-flex; align-items: center; justify-content: center; width: 19px; height: 19px; border: 0; border-radius: 5px; background: none; color: var(--text-secondary); cursor: pointer; }
.ci-btn:hover { background: rgba(123,127,178,.16); color: var(--color-primary); }
.ci-delete:hover { background: rgba(200,90,90,.14); color: #c85a5a; }

.project-search { width: 100%; height: 30px; box-sizing: border-box; padding: 0 9px; border: 1px solid rgba(123,127,178,.15); border-radius: 6px; outline: 0; background: rgba(255,255,255,.56); color: var(--text-primary); font: inherit; font-size: 11.5px; }
.project-search:focus { border-color: rgba(123,127,178,.45); background: rgba(255,255,255,.8); }
.project-group { display: flex; flex-direction: column; gap: 6px; }
.project-group-title { display: flex; align-items: center; gap: 5px; padding: 3px 3px 0; color: var(--text-secondary); font-size: 10px; font-weight: 700; }
.project-group-title > span:last-child { margin-left: auto; font-variant-numeric: tabular-nums; opacity: .6; }
.project-status-dot { width: 6px; height: 6px; border-radius: 50%; }
.project-status-dot.is-pending { background: #d46b6b; }
.project-status-dot.is-active { background: #c9943a; }
.project-status-dot.is-done { background: #5a9e88; }
.project-empty { padding: 18px 8px; color: var(--text-secondary); font-size: 11px; text-align: center; }
.project-skeletons { display: flex; flex-direction: column; gap: 9px; }
.project-skeleton { display: block; height: 104px; border-radius: var(--radius-md); background: rgba(255,255,255,.38); box-shadow: inset 0 1px 0 rgba(255,255,255,.55); }
</style>
