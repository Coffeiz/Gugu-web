<template>
  <div v-if="project.stages.length" class="seg-bar" @click.stop @mousedown.stop>
    <div
      v-for="(stage, i) in project.stages"
      :key="stage.key"
      class="seg"
      :title="stage.label"
      @click.stop="clickStage(i)"
    >
      <div class="seg-fill" :class="{ 'no-anim': !!animFills }" :style="segFillStyle(i)"></div>
    </div>
  </div>
  <div v-else class="progress-bar">
    <div class="progress-fill" :style="{ width: fallbackProgress + '%', background: project.color }"></div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onUnmounted, type PropType } from 'vue'
import { useProjectStore } from '@/stores/projects'
import type { Project } from '@/types/project'

const props = defineProps({ project: { type: Object as PropType<Project>, required: true } })
const projectStore = useProjectStore()

const curIdx = computed(() =>
  props.project.stages.findIndex(s => s.key === props.project.currentStage)
)

const fallbackProgress = computed(() => {
  const stages = props.project.stages
  let done = 0, total = 0
  for (const s of stages) {
    const todos = s.todos ?? []
    done += todos.filter(t => t.done).length
    total += todos.length
  }
  if (total > 0) return Math.round(done / total * 100)
  const idx = curIdx.value
  return idx < 0 ? 0 : Math.round((idx + 1) / stages.length * 100)
})

function segFill(i: number) {
  const todos = props.project.stages[i].todos ?? []
  if (todos.length) return Math.round(todos.filter(t => t.done).length / todos.length * 100)
  return i <= curIdx.value ? 100 : 0
}

function segFillStyle(i: number) {
  const n = props.project.stages.length
  const w = animFills.value ? animFills.value[i] : segFill(i)
  const pos = n <= 1 ? '0%' : `${(i / (n - 1)) * 100}%`
  return { width: w + '%', background: props.project.color, backgroundSize: `${n * 100}% 100%`, backgroundPosition: `${pos} 0%` }
}

const animFills = ref<number[] | null>(null)
let _rafId: number | null = null

function _animateStages(fromFills: number[], toFills: number[], isForward: boolean) {
  const slots = fromFills
    .map((f, j) => ({ j, from: f, to: toFills[j] }))
    .filter(x => Math.abs(x.to - x.from) > 0.5)
  if (!isForward) slots.reverse()
  const nc = slots.length
  if (nc === 0) { animFills.value = null; return }
  if (_rafId) cancelAnimationFrame(_rafId)
  const dur = Math.min(900, Math.max(200, nc * 220))
  const start = performance.now()
  function tick(now: number) {
    const raw = Math.min(1, (now - start) / dur)
    const t = 1 - (1 - raw) * (1 - raw)
    const fills = [...fromFills]
    slots.forEach(({ j, from, to }, k) => {
      fills[j] = from + (to - from) * Math.max(0, Math.min(1, t * nc - k))
    })
    animFills.value = fills
    if (raw < 1) { _rafId = requestAnimationFrame(tick) }
    else { animFills.value = null; _rafId = null }
  }
  _rafId = requestAnimationFrame(tick)
}

onUnmounted(() => { if (_rafId) cancelAnimationFrame(_rafId) })

async function clickStage(i: number) {
  const stages = props.project.stages
  const stage  = stages[i]
  const n      = stages.length
  const w      = 100 / n
  const todos  = stage.todos ?? []
  const withinProg = todos.length > 0 ? (todos.filter(t => t.done).length / todos.length) * w : w
  const newProgress = Math.round(i * w + withinProg)
  const withinSeg  = withinProg / w * 100
  const fromFills  = stages.map((_, j) => segFill(j))
  const cur = curIdx.value
  const isForward = i > cur

  if (!isForward && i < cur) {
    for (let k = i; k < cur; k++) {
      const kt = stages[k].todos ?? []
      if (kt.length > 0 && kt.every(t => t.done && !t.autoCompleted)) return
    }
  }

  const toFills = stages.map((s, j) => {
    const st = s.todos ?? []
    if (st.length > 0) {
      if (isForward && j >= cur && j < i) return 100
      if (!isForward && j >= i) {
        const done = st.filter(t => t.autoCompleted ? (t._savedDone ?? false) : t.done).length
        return Math.round(done / st.length * 100)
      }
      return fromFills[j]
    }
    if (j < i) return 100
    if (j === i) return withinSeg
    return 0
  })

  if (fromFills.some((f, j) => Math.abs(f - toFills[j]) > 0.5)) {
    animFills.value = [...fromFills]
    _animateStages(fromFills, toFills, isForward)
  }
  await projectStore.setStage(props.project.id, stage.key, newProgress)
}
</script>

<style scoped>
.seg-bar { display: flex; gap: 2px; height: 5px; position: relative; }
.seg {
  flex: 1; height: 100%; border-radius: 99px;
  background: rgba(0,0,0,0.07); cursor: pointer;
  transition: transform 0.18s ease, opacity 0.15s;
  transform-origin: center; position: relative;
}
.seg::before { content: ''; position: absolute; inset: -4px 0; }
.seg:hover { transform: scaleY(2.2); opacity: 0.8; }
.seg-fill { height: 100%; border-radius: 99px; transition: width 0.3s; }
.seg-fill.no-anim { transition: none; }
.progress-bar { height: 4px; background: rgba(0,0,0,0.07); border-radius: 99px; overflow: hidden; }
.progress-fill { height: 100%; border-radius: 99px; transition: width 0.3s; }
</style>
