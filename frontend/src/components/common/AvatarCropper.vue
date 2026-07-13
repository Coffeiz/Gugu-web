<template>
  <BaseModal :show="show" width="380px" background="var(--panel-bg, rgba(255,255,255,0.86))" @close="$emit('close')">
    <div class="ac">
      <div class="ac-title">裁切头像</div>
      <p class="ac-hint">拖动调整位置，滚轮或滑块缩放</p>

      <!-- 方形裁切视口：圆形遮罩预览最终圆头像效果 -->
      <div
        ref="viewport"
        class="ac-viewport"
        :style="{ width: V + 'px', height: V + 'px' }"
        @pointerdown="onDown"
        @wheel.prevent="onWheel"
      >
        <img
          v-if="src"
          :src="src"
          class="ac-img"
          draggable="false"
          :style="imgStyle"
          @load="onImgLoad"
        />
        <!-- 裁切圆：外围压暗（outset 阴影），圆内透出原图；细白环标出裁切边界 -->
        <div class="ac-crop" :style="{ width: CROP + 'px', height: CROP + 'px' }" />
      </div>

      <div class="ac-zoom">
        <span class="ac-zoom-ico">−</span>
        <input type="range" min="1" max="4" step="0.01" :value="zoom" @input="onSlider" class="ac-zoom-range" />
        <span class="ac-zoom-ico">＋</span>
      </div>

      <div class="ac-actions">
        <button class="ac-btn ghost" @click="$emit('close')">取消</button>
        <button class="ac-btn primary" :disabled="!loaded || busy" @click="confirm">
          {{ busy ? '处理中…' : '确定' }}
        </button>
      </div>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onBeforeUnmount } from 'vue'
import BaseModal from './BaseModal.vue'

const props = defineProps<{ show: boolean; file: File | null }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'crop', f: File): void }>()

const V = 288          // 视口边长（CSS px）
const CROP = 240       // 裁切圆直径（CSS px）——视口是它的 120%，四周留一圈暗环预览整体
const MARGIN = (V - CROP) / 2   // 裁切区距视口边的留白
const OUT = 512        // 输出方图边长（px）——只存这个尺寸，原图不上传

const viewport = ref<HTMLElement | null>(null)
const src = ref<string | null>(null)   // objectURL
const loaded = ref(false)
const busy = ref(false)
const zoom = ref(1)
const natW = ref(0)
const natH = ref(0)
const offset = reactive({ x: 0, y: 0 })   // 图片左上角相对视口左上角（screen px）

// baseScale：让图片较短边恰好铺满**裁切圆**（cover 起点），zoom≥1 在此之上放大。
// 因视口比裁切区大 20%，min zoom 下裁切圆外自然露出一圈原图/背景，方便预览整体。
const baseScale = computed(() => {
  const m = Math.min(natW.value, natH.value)
  return m > 0 ? CROP / m : 1
})
const dispW = computed(() => natW.value * baseScale.value * zoom.value)
const dispH = computed(() => natH.value * baseScale.value * zoom.value)

const imgStyle = computed(() => ({
  width: dispW.value + 'px',
  height: dispH.value + 'px',
  transform: `translate(${offset.x}px, ${offset.y}px)`,
}))

// 钳制：图片必须始终盖满**裁切区** [MARGIN, MARGIN+CROP]（不让裁切圆露白）
function clamp() {
  offset.x = Math.min(MARGIN, Math.max(MARGIN + CROP - dispW.value, offset.x))
  offset.y = Math.min(MARGIN, Math.max(MARGIN + CROP - dispH.value, offset.y))
}

// 文件变化 → 载入图片，重置到居中 cover
watch(() => props.file, (f) => {
  if (src.value) { URL.revokeObjectURL(src.value); src.value = null }
  loaded.value = false
  if (f) src.value = URL.createObjectURL(f)
}, { immediate: true })

function onImgLoad(e: Event) {
  const img = e.target as HTMLImageElement
  natW.value = img.naturalWidth
  natH.value = img.naturalHeight
  zoom.value = 1
  // 居中：cover 后较长边溢出部分对半分
  offset.x = (V - dispW.value) / 2
  offset.y = (V - dispH.value) / 2
  clamp()
  loaded.value = true
}

// 缩放围绕视口中心，保持中心点对应的图像位置不动
function setZoom(next: number) {
  const z0 = zoom.value
  const z1 = Math.min(4, Math.max(1, next))
  if (z1 === z0) return
  const cx = V / 2, cy = V / 2
  // 中心下的图像坐标（screen px 空间，相对图片左上）
  const ix = (cx - offset.x) / z0
  const iy = (cy - offset.y) / z0
  zoom.value = z1
  offset.x = cx - ix * z1
  offset.y = cy - iy * z1
  clamp()
}
function onSlider(e: Event) { setZoom(parseFloat((e.target as HTMLInputElement).value)) }
function onWheel(e: WheelEvent) { setZoom(zoom.value * (e.deltaY < 0 ? 1.08 : 0.926)) }

// 拖动平移
let dragging = false
let startX = 0, startY = 0, baseOffX = 0, baseOffY = 0
function onDown(e: PointerEvent) {
  if (!loaded.value) return
  dragging = true
  startX = e.clientX; startY = e.clientY
  baseOffX = offset.x; baseOffY = offset.y
  ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}
function onMove(e: PointerEvent) {
  if (!dragging) return
  offset.x = baseOffX + (e.clientX - startX)
  offset.y = baseOffY + (e.clientY - startY)
  clamp()
}
function onUp() {
  dragging = false
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', onUp)
}

// 确定：把视口覆盖的源图方形区域画到 OUT×OUT canvas，导出 WebP（原图始终不出浏览器）
async function confirm() {
  if (!loaded.value || busy.value) return
  busy.value = true
  try {
    const s = baseScale.value * zoom.value          // 源→屏幕的缩放
    const srcSize = CROP / s                         // 裁切圆外接方在源图里的边长（源 px）
    const srcX = (MARGIN - offset.x) / s             // 裁切区左上角（视口内 MARGIN 处）映回源图
    const srcY = (MARGIN - offset.y) / s
    const img = viewport.value?.querySelector('img') as HTMLImageElement | null
    if (!img) throw new Error('图片未就绪')

    const canvas = document.createElement('canvas')
    canvas.width = OUT; canvas.height = OUT
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 不可用')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, srcX, srcY, srcSize, srcSize, 0, 0, OUT, OUT)

    const blob = await toBlob(canvas, 'image/webp', 0.9)
             ?? await toBlob(canvas, 'image/jpeg', 0.9)   // 老浏览器不支持 webp 时退回 jpeg
    if (!blob) throw new Error('导出失败')
    const ext = blob.type === 'image/webp' ? 'webp' : 'jpg'
    emit('crop', new File([blob], `avatar.${ext}`, { type: blob.type }))
  } finally {
    busy.value = false
  }
}
function toBlob(canvas: HTMLCanvasElement, type: string, q: number): Promise<Blob | null> {
  return new Promise(res => canvas.toBlob(b => res(b), type, q))
}

onBeforeUnmount(() => {
  if (src.value) URL.revokeObjectURL(src.value)
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', onUp)
})
</script>

<style scoped>
.ac { padding: 20px 22px 18px; display: flex; flex-direction: column; align-items: center; }
.ac-title { font-size: 15px; font-weight: 700; color: var(--text-primary); align-self: flex-start; }
.ac-hint { font-size: 12px; color: var(--text-secondary); margin: 4px 0 14px; align-self: flex-start; }

.ac-viewport {
  position: relative; overflow: hidden; border-radius: 12px;
  background: rgba(20,22,40,0.06); cursor: grab; touch-action: none;
  user-select: none; -webkit-user-select: none;
}
.ac-viewport:active { cursor: grabbing; }
.ac-img { position: absolute; top: 0; left: 0; max-width: none; pointer-events: none; }
/* 裁切圆：居中的圆，用**外扩**阴影压暗圆外（被视口 overflow:hidden 裁掉溢出部分），
   圆内透出原图；细白环标出裁切边界。 */
.ac-crop {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  border-radius: 50%; pointer-events: none;
  box-shadow: 0 0 0 1.5px rgba(255,255,255,0.85),
              0 0 0 9999px rgba(20,22,40,0.5);
}

.ac-zoom { display: flex; align-items: center; gap: 10px; width: 100%; margin: 16px 0 4px; }
.ac-zoom-ico { font-size: 15px; color: var(--text-secondary); width: 14px; text-align: center; }
.ac-zoom-range { flex: 1; accent-color: var(--color-primary); cursor: pointer; }

.ac-actions { display: flex; gap: 10px; width: 100%; margin-top: 16px; }
.ac-btn {
  flex: 1; height: 38px; border-radius: 10px; font-size: 14px; font-weight: 600;
  cursor: pointer; border: none; transition: opacity 0.15s, transform 0.1s;
}
.ac-btn:active { transform: translateY(1px); }
.ac-btn.ghost { background: rgba(123,127,178,0.12); color: var(--text-secondary); }
.ac-btn.primary { background: var(--color-primary); color: #fff; }
.ac-btn.primary:disabled { opacity: 0.5; cursor: default; }
</style>
