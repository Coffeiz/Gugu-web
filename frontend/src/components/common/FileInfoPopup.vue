<template>
  <Teleport to="body">
    <Transition name="info-pop">
      <div v-if="show && file" ref="el" class="fp-info-win"
        :style="{ left: posX + 'px', top: posY + 'px' }"
        @mousedown.stop
      >
        <div class="fp-info-title" @mousedown.prevent="startDrag">
          <span>文件信息</span>
          <button class="fp-action-btn fp-close-btn" @click="$emit('close')">
            <PhX weight="bold" :size="15" />
          </button>
        </div>
        <div class="fp-info-body">
          <div class="fp-info-row">
            <span class="fp-info-label">文件名</span>
            <span class="fp-info-val">{{ file.displayName }}.{{ file.ext?.toLowerCase() }}</span>
          </div>
          <div class="fp-info-row">
            <span class="fp-info-label">格式</span>
            <span class="fp-info-val">{{ file.ext?.toUpperCase() }}</span>
          </div>
          <div v-if="file.size" class="fp-info-row">
            <span class="fp-info-label">大小</span>
            <span class="fp-info-val">{{ file.size }}</span>
          </div>
          <div v-if="file.createdAt" class="fp-info-row">
            <span class="fp-info-label">创建时间</span>
            <span class="fp-info-val">{{ file.createdAt }}</span>
          </div>
          <div v-if="file.projectName" class="fp-info-row">
            <span class="fp-info-label">所属项目</span>
            <span class="fp-info-val">{{ file.projectName }}</span>
          </div>
          <div v-if="file.folderName" class="fp-info-row">
            <span class="fp-info-label">所在文件夹</span>
            <span class="fp-info-val">{{ file.folderName }}</span>
          </div>
          <div v-if="file.stageName" class="fp-info-row">
            <span class="fp-info-label">阶段</span>
            <span class="fp-info-val">{{ file.stageName }}</span>
          </div>
          <div v-if="file.mimeType" class="fp-info-row">
            <span class="fp-info-label">MIME</span>
            <span class="fp-info-val fp-info-mono">{{ file.mimeType }}</span>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { ref, watch, nextTick, onUnmounted } from 'vue'
import { PhX } from '@phosphor-icons/vue'

const props = defineProps({
  show: Boolean,
  file: Object,
  x:    { type: Number, default: 0 },
  y:    { type: Number, default: 0 },
})
const emit = defineEmits(['close'])

const el   = ref(null)
const posX = ref(0)
const posY = ref(0)

watch(() => [props.show, props.x, props.y], async ([v]) => {
  if (!v) return
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

// ── 拖动 ──────────────────────────────────────────────
let dragOrig = null
function startDrag(e) {
  if (e.button !== 0) return
  dragOrig = { mx: e.clientX, my: e.clientY, x: posX.value, y: posY.value }
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup',   onDragUp)
}
function onDragMove(e) {
  if (!dragOrig) return
  posX.value = Math.max(0, dragOrig.x + e.clientX - dragOrig.mx)
  posY.value = Math.max(0, dragOrig.y + e.clientY - dragOrig.my)
}
function onDragUp() {
  dragOrig = null
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup',   onDragUp)
}
onUnmounted(() => {
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup',   onDragUp)
})
</script>

<style scoped>
.fp-info-win {
  position: fixed;
  width: 220px;
  border-radius: 12px;
  overflow: hidden;
  background: rgba(242, 243, 248, 0.97);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.7);
  box-shadow: 0 8px 32px rgba(20, 25, 60, 0.18), 0 2px 8px rgba(0, 0, 0, 0.07);
  user-select: none;
  z-index: 9999;
}
.fp-info-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 10px 9px 14px;
  background: rgba(255, 255, 255, 0.55);
  border-bottom: 1px solid rgba(0, 0, 0, 0.07);
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
.fp-info-mono { font-family: monospace; font-size: 11px; }

.fp-action-btn {
  width: 28px; height: 28px; border-radius: 7px; border: none;
  background: rgba(255, 255, 255, 0.6); color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: background 0.15s, color 0.15s;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
}
.fp-action-btn svg { display: block; }
.fp-close-btn:hover { background: rgba(200, 90, 90, 0.1); color: rgba(200, 90, 90, 0.9); }

.info-pop-enter-active,
.info-pop-leave-active { transition: opacity 0.12s ease, transform 0.12s ease; }
.info-pop-enter-from,
.info-pop-leave-to     { opacity: 0; transform: scale(0.95); }
</style>
