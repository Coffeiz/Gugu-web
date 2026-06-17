<template>
  <Transition name="drawer">
    <div v-if="project" class="drawer-wrap">
      <!-- 半透明遮罩 -->
      <div class="drawer-overlay" @click="$emit('close')" />

      <!-- 抽屉主体 -->
      <div class="drawer">
        <!-- 头部 -->
        <div class="drawer-header">
          <div class="proj-color-bar" :style="{ background: project.color }"></div>
          <div class="header-info">
            <h2>{{ project.name }}</h2>
            <span class="client-tag">{{ project.client }}</span>
          </div>
          <button class="close-btn" @click="$emit('close')">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
              <path d="M3 3l10 10M13 3L3 13"/>
            </svg>
          </button>
        </div>

        <!-- 内容 -->
        <div class="drawer-body">
          <!-- 进度 & 阶段 -->
          <section class="section">
            <div class="section-row">
              <div class="meta-item">
                <span class="meta-label">当前阶段</span>
                <span class="stage-badge" :style="{ color: stageColor, background: stageColorBg }">
                  {{ stageLabel }}
                </span>
              </div>
              <div class="meta-item">
                <span class="meta-label">截止日期</span>
                <span class="meta-value" :class="{ urgent: isUrgent }">{{ project.deadline }}</span>
              </div>
              <div class="meta-item">
                <span class="meta-label">完成进度</span>
                <span class="meta-value">{{ project.progress }}%</span>
              </div>
            </div>

            <!-- 大进度条 -->
            <div class="big-progress">
              <div class="big-progress-fill"
                :style="{ width: project.progress + '%', background: project.color }">
              </div>
            </div>
          </section>

          <!-- 阶段流转 -->
          <section class="section">
            <div class="section-label">流转阶段</div>
            <div class="stage-flow">
              <button
                v-for="stage in projectStore.stages"
                :key="stage.key"
                class="stage-btn"
                :class="{ active: project.stage === stage.key }"
                @click="setStage(stage.key)"
              >
                {{ stage.label }}
              </button>
            </div>
          </section>

          <!-- 任务列表（Mock） -->
          <section class="section">
            <div class="section-label">任务清单
              <span class="task-count">{{ mockTasks.filter(t=>t.done).length }}/{{ mockTasks.length }}</span>
            </div>
            <div class="task-list">
              <div
                v-for="task in mockTasks"
                :key="task.id"
                class="task-item"
                @click="task.done = !task.done"
              >
                <div class="task-check" :class="{ done: task.done }">
                  <svg v-if="task.done" width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="white" stroke-width="2" stroke-linecap="round">
                    <path d="M2 6l3 3 5-5"/>
                  </svg>
                </div>
                <span :class="{ 'task-done': task.done }">{{ task.name }}</span>
              </div>
            </div>
          </section>

          <!-- 文件（Mock） -->
          <section class="section">
            <div class="section-label">相关文件</div>
            <div class="file-list">
              <div v-for="file in mockFiles" :key="file.name" class="file-item">
                <div class="file-icon" :style="{ background: file.color }">{{ file.ext }}</div>
                <div class="file-info">
                  <div class="file-name">{{ file.name }}</div>
                  <div class="file-meta">{{ file.size }} · {{ file.date }}</div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useProjectStore } from '@/stores/projects'

const props = defineProps({
  project: { type: Object, default: null },
})
defineEmits(['close'])

const projectStore = useProjectStore()

const stageColors = {
  draft:    { color: '#8a8fa8', bg: 'rgba(138,143,168,0.1)' },
  sketch:   { color: '#7b7fb2', bg: 'rgba(123,127,178,0.1)' },
  coloring: { color: '#b07090', bg: 'rgba(196,175,200,0.12)' },
  final:    { color: '#7ab8c8', bg: 'rgba(122,184,200,0.1)' },
  delivery: { color: '#5a9e88', bg: 'rgba(90,158,136,0.1)' },
}

const stageColor   = computed(() => stageColors[props.project?.stage]?.color   ?? '#8a8fa8')
const stageColorBg = computed(() => stageColors[props.project?.stage]?.bg      ?? 'rgba(0,0,0,0.05)')
const stageLabel   = computed(() =>
  projectStore.stages.find(s => s.key === props.project?.stage)?.label ?? ''
)

const daysLeft = computed(() => {
  if (!props.project) return 0
  return Math.ceil((new Date(props.project.deadline) - new Date()) / 86400000)
})
const isUrgent = computed(() => daysLeft.value <= 3)

function setStage(key) {
  if (props.project) projectStore.moveProject(props.project.id, key)
}

// Mock 任务
const mockTasks = ref([
  { id: 1, name: '确认项目需求与参考图', done: true },
  { id: 2, name: '绘制草图并发送审稿', done: true },
  { id: 3, name: '线稿细化', done: false },
  { id: 4, name: '配色方案确认', done: false },
  { id: 5, name: '最终交付文件整理', done: false },
])

// 切换项目时重置任务
watch(() => props.project?.id, () => {
  mockTasks.value.forEach(t => { t.done = t.id <= 2 })
})

// Mock 文件
const mockFiles = [
  { name: '参考图集.zip',  ext: 'ZIP', size: '12.4 MB', date: '06/10', color: 'linear-gradient(135deg,#9e9fc4,#7b7fb2)' },
  { name: '草图_v2.psd',  ext: 'PSD', size: '84 MB',   date: '06/12', color: 'linear-gradient(135deg,#7ab8c8,#5a9e88)' },
  { name: '合同扫描.pdf', ext: 'PDF', size: '2.1 MB',  date: '06/08', color: 'linear-gradient(135deg,#c4afc8,#b07858)' },
]
</script>

<style scoped>
/* 整体容器 */
.drawer-wrap {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  justify-content: flex-end;
}

/* 遮罩 */
.drawer-overlay {
  position: absolute;
  inset: 0;
  background: rgba(30,32,40,0.22);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
}

/* 抽屉主体 */
.drawer {
  position: relative;
  width: 380px;
  height: 100%;
  background: rgba(240,241,246,0.88);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  border-left: 1px solid rgba(255,255,255,0.65);
  box-shadow: -8px 0 40px rgba(80,90,110,0.14);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 头部 */
.drawer-header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 24px 20px 18px;
  border-bottom: 1px solid rgba(0,0,0,0.06);
  flex-shrink: 0;
}

.proj-color-bar {
  width: 4px;
  height: 44px;
  border-radius: 99px;
  flex-shrink: 0;
  margin-top: 2px;
}

.header-info {
  flex: 1;
  min-width: 0;
}

.header-info h2 {
  font-size: 16px;
  font-weight: 700;
  line-height: 1.3;
  color: var(--text-primary);
}

.client-tag {
  display: inline-block;
  margin-top: 5px;
  font-size: 11px;
  color: var(--text-secondary);
  background: rgba(0,0,0,0.05);
  border-radius: 20px;
  padding: 2px 9px;
}

.close-btn {
  background: rgba(0,0,0,0.05);
  border: none;
  border-radius: 8px;
  width: 30px; height: 30px;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer;
  color: var(--text-secondary);
  transition: background 0.15s;
  flex-shrink: 0;
}
.close-btn:hover { background: rgba(0,0,0,0.1); }

/* 内容区 */
.drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

/* 通用分区 */
.section { display: flex; flex-direction: column; gap: 10px; }

.section-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.07em;
  display: flex;
  align-items: center;
  gap: 8px;
}

/* meta 行 */
.section-row {
  display: flex;
  gap: 16px;
}

.meta-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.meta-label {
  font-size: 10px;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.meta-value {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.meta-value.urgent { color: var(--color-warning); }

.stage-badge {
  font-size: 12px;
  font-weight: 600;
  padding: 2px 9px;
  border-radius: 20px;
  display: inline-block;
}

/* 大进度条 */
.big-progress {
  height: 5px;
  background: rgba(0,0,0,0.08);
  border-radius: 99px;
  overflow: hidden;
}

.big-progress-fill {
  height: 100%;
  border-radius: 99px;
  transition: width 0.4s cubic-bezier(.34,1.2,.64,1);
}

/* 阶段流转 */
.stage-flow {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.stage-btn {
  padding: 5px 12px;
  border-radius: 20px;
  border: 1px solid rgba(0,0,0,0.1);
  background: rgba(255,255,255,0.72);
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s;
  font-family: var(--font-sans);
}

.stage-btn:hover {
  background: rgba(255,255,255,0.8);
  color: var(--text-primary);
}

.stage-btn.active {
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
  color: white;
  border-color: transparent;
  box-shadow: 0 2px 8px rgba(123,127,178,0.3);
}

/* 任务 */
.task-count {
  font-size: 10px;
  color: var(--text-secondary);
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
}

.task-list { display: flex; flex-direction: column; gap: 6px; }

.task-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  background: rgba(255,255,255,0.68);
  border: 1px solid rgba(255,255,255,0.65);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background 0.15s;
  font-size: 13px;
  color: var(--text-primary);
}

.task-item:hover { background: rgba(255,255,255,0.65); }

.task-check {
  width: 16px; height: 16px;
  border-radius: 5px;
  border: 1.5px solid rgba(0,0,0,0.18);
  flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.15s;
}

.task-check.done {
  background: var(--color-success);
  border-color: var(--color-success);
}

.task-done {
  text-decoration: line-through;
  color: var(--text-secondary);
}

/* 文件 */
.file-list { display: flex; flex-direction: column; gap: 6px; }

.file-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  background: rgba(255,255,255,0.68);
  border: 1px solid rgba(255,255,255,0.65);
  border-radius: var(--radius-sm);
}

.file-icon {
  width: 32px; height: 32px;
  border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  font-size: 9px;
  font-weight: 700;
  color: white;
  letter-spacing: 0.04em;
  flex-shrink: 0;
}

.file-info { flex: 1; min-width: 0; }
.file-name { font-size: 13px; font-weight: 500; color: var(--text-primary); }
.file-meta { font-size: 11px; color: var(--text-secondary); margin-top: 2px; }

/* 抽屉动画 */
.drawer-enter-active,
.drawer-leave-active {
  transition: opacity 0.22s;
}
.drawer-enter-active .drawer,
.drawer-leave-active .drawer {
  transition: transform 0.28s cubic-bezier(.34,1.1,.64,1);
}
.drawer-enter-from,
.drawer-leave-to {
  opacity: 0;
}
.drawer-enter-from .drawer,
.drawer-leave-to .drawer {
  transform: translateX(100%);
}
</style>
