<template>
  <!-- 底部停靠捕捉条：收起=单行占位；聚焦展开=编辑器+工具栏从条内长出来（不弹浮层）。
       外框单独做高度过渡，收起态和编辑态各自绝对定位在条底并交叉淡变，避免内容被上下裁切。
       浮在滚动的便签流之上：玻璃可以用，但内部交互元素克制（hover 只做 opacity/淡背景，
       不做 box-shadow 过渡——白带红线）；本组件自身/祖先不挂 opacity 动画（隔离组红线）。 -->
  <div ref="barRef" class="capture-bar" :class="{ expanded }" :style="{ height: (expanded ? expandedHeight : 50) + 'px' }">
    <div ref="bodyRef" class="cb-body">
      <div class="cb-pad">
          <input
            v-model="title" class="cb-title-input" :placeholder="t('mind.titleOptional')"
            @keydown.enter.exact.prevent="editorRef?.focus()"
            @keydown.enter.meta.prevent="save"
            @keydown.enter.ctrl.prevent="save"
          />
          <NoteEditor
            ref="editorRef"
            v-model="md"
            :placeholder="t('mind.placeholder')"
            compact
            @submit="save"
          />
          <div class="cb-foot">
            <!-- 补录：日期可以往回选，落进它「发生」的那天，而不是今天 -->
            <label class="cb-backfill" :class="{ on: backfill }">
              <input type="checkbox" v-model="backfill" />
              {{ t('mind.backfill') }}
            </label>
            <DatePicker v-if="backfill" class="cb-date" v-model="date" :max="todayIso" :show-clear="false" :placeholder="t('mind.chooseDateShort')" />
            <div class="cb-right">
              <span class="cb-hint">{{ t('mind.referenceHint') }}</span>
              <button class="cb-min" :title="t('mind.collapseKeep')" @click="collapse">
                <PhCaretDown :size="13" weight="bold" />
              </button>
              <button class="cb-save press-fx" :disabled="!canSave || saving" @click="save">
                {{ saving ? t('mind.recording') : t('mind.record') }}
              </button>
            </div>
          </div>
      </div>
    </div>

    <div class="cb-head">
      <div class="cb-collapsed" role="button" tabindex="0" @click="expand" @keydown.enter.prevent="expand" @keydown.space.prevent="expand">
        <PhPencilSimple :size="13" weight="bold" class="cb-pencil" />
        <div v-if="title.trim() || md.trim()" class="cb-placeholder md-preview" v-html="collapsedPreview"></div>
        <div v-else class="cb-placeholder">{{ t('mind.placeholder') }}</div>
        <span class="cb-kbd">{{ t('mind.quickNote') }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { PhCaretDown, PhPencilSimple } from '@phosphor-icons/vue'
import DatePicker from '@/components/common/controls/DatePicker.vue'
import { combineTitleBody, mdToPreviewHtml } from '@/composables/useMindEditor'
import NoteEditor from './NoteEditor.vue'
import { useI18n } from 'vue-i18n'

const emit = defineEmits<{ (e: 'created', md: string, capturedAt?: string): void }>()
const { t } = useI18n()

const expanded = ref(false)
const title    = ref('')
const md       = ref('')
const backfill = ref(false)
const localToday = () => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
const todayIso = localToday()
const date     = ref(todayIso)
const saving   = ref(false)
const barRef    = ref<HTMLElement | null>(null)
const bodyRef   = ref<HTMLElement | null>(null)
const editorRef = ref<InstanceType<typeof NoteEditor> | null>(null)
const expandedHeight = ref(50)
let resizeObserver: ResizeObserver | null = null

const canSave = computed(() => title.value.trim().length > 0 || md.value.trim().length > 0)
/** 收起时只取第一条有效 Markdown：药丸仍是一行，但粗体/待办/引用等行内样式不丢。 */
const collapsedPreview = computed(() => {
  const t = title.value.trim()
  const firstLine = md.value.split('\n').find(line => line.trim())?.trim() || ''
  return mdToPreviewHtml(t ? `# ${t}` : firstLine)
})

async function expand() {
  measureExpandedHeight()
  expanded.value = true
  await nextTick()
  measureExpandedHeight()
  editorRef.value?.focus()   // 编辑器常驻挂载（为了收起动画），不能用 autofocus，展开时手动聚焦
}
function collapse() { expanded.value = false }   // 草稿保留在 md 里，下次展开接着写

function measureExpandedHeight() {
  expandedHeight.value = Math.max(50, bodyRef.value?.scrollHeight ?? 50)
}

/** 点条外任意处收起。DatePicker 的日历 Teleport 到 body，得单独放行——选个日期不算
 *  "点外面"；`@` 对象补全同样 Teleport 到 body，选中条目也不能让草稿条收起。NoteEditor
 *  的「样式」「插入」抽屉则原地展开，是条本身的 DOM 后代。 */
function onDocDown(e: MouseEvent) {
  if (!expanded.value) return
  const t = e.target as HTMLElement
  if (barRef.value?.contains(t)) return
  if (t.closest?.('.dp-popup')) return
  if (t.closest?.('.reference-picker')) return
  collapse()
}
onMounted(() => {
  document.addEventListener('mousedown', onDocDown, true)
  if (bodyRef.value) {
    resizeObserver = new ResizeObserver(() => { if (expanded.value) measureExpandedHeight() })
    resizeObserver.observe(bodyRef.value)
  }
  measureExpandedHeight()
})
onUnmounted(() => {
  document.removeEventListener('mousedown', onDocDown, true)
  resizeObserver?.disconnect()
})

defineExpose({ expand })

async function save() {
  if (!canSave.value || saving.value) return
  saving.value = true
  try {
    // 补录给当天正午的时间戳：只关心落在哪一天，不用纠结时分
    const capturedAt = backfill.value ? `${date.value}T12:00:00` : undefined
    emit('created', combineTitleBody(title.value, md.value), capturedAt)
    title.value = ''
    md.value = ''
    editorRef.value?.clear()
    backfill.value = false
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.capture-bar {
  /* 收起/展开**同宽**（480），只有高度变；玻璃浓度随展开加深。圆角两态同值 25px（=收起高
     50/2）→ 收起全圆药丸、展开 25px 圆角矩形，角曲率一致（#1）。position:relative + 收起
     态最小高度 50，收起单行绝对定位贴底、条底由父级 bottom 锚定，故往上长（#3 收起 ui 不上移）。 */
  --cb-dur: 0.26s;
  --cb-ease: cubic-bezier(0.22, 1, 0.36, 1);   /* 快速缓出：展开收起都干脆，不拖尾 */
  position: relative;
  width: 480px; max-width: 100%; margin: 0 auto;
  height: 50px;
  border-radius: 25px;   /* =收起高 50/2，收起态是纯圆药丸 */
  corner-shape: round;   /* 收起展开全程用同一种 corner-shape：corner-shape 不能过渡，切换瞬间
                             会跳变；squircle 又不像 round 那样按盒子尺寸自动收窄半径，两者在高度
                             动画途中切换就会看起来"先缩小再放大"，所以两态都固定用 round */
  background: rgba(255,255,255,0.6);
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  border: 1px solid rgba(255,255,255,0.78);
  box-shadow: 0 8px 28px rgba(30,40,80,0.14), inset 0 1px 0 rgba(255,255,255,0.9);
  overflow: hidden;
  transition: height var(--cb-dur) var(--cb-ease),
              background-color var(--cb-dur) ease,
              backdrop-filter var(--cb-dur) ease, -webkit-backdrop-filter var(--cb-dur) ease;
}
.capture-bar.expanded {
  /* 与 .note-card.editing 保持同一底色，同时保留捕捉条悬浮于时间流上方的毛玻璃层次。 */
  background: rgba(255,255,255,0.9);
  backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
}

/* 两个内容层都固定在条底。外框改变高度时，内部不会跟着上下位移。 */
.cb-body, .cb-head {
  position: absolute; left: 0; right: 0; bottom: 0;
}
.cb-body { opacity: 0; pointer-events: none; transition: opacity 0.16s ease-out; }
.cb-head { height: 50px; opacity: 1; transition: opacity 0.16s ease-out; }
.capture-bar.expanded .cb-body { opacity: 1; pointer-events: auto; transition: opacity 0.16s ease-out; }
.capture-bar.expanded .cb-head { opacity: 0; pointer-events: none; transition: opacity 0.16s ease-out; }

/* 内容在各自固定位置只做交叉淡变：展开先收起、后露编辑器；收起反过来。 */
.cb-collapsed {
  display: flex; align-items: center; gap: 9px; width: 100%;
  height: 50px; box-sizing: border-box;   /* 收起高度 = 咕咕球 50px（#2） */
  padding: 0 18px; border: none;
  background: none; cursor: text; text-align: left;
  font-family: var(--font-sans);
}
.cb-pencil { flex-shrink: 0; color: var(--color-primary); opacity: 0.75; }
.cb-placeholder {
  flex: 1; min-width: 0; font-size: 13px; color: var(--text-secondary); opacity: 0.75;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.cb-placeholder :deep(> *) { display: inline; margin: 0; padding: 0; }
.cb-placeholder :deep(> * ~ *) { display: none; }
.cb-placeholder :deep(.np-tasks li),
.cb-placeholder :deep(.np-list li),
.cb-placeholder :deep(.np-ordered li) { display: inline; }
.cb-placeholder :deep(input) { display: none; }
.cb-placeholder :deep(.mind-dot) { margin-right: 3px; }
.cb-placeholder :deep(.np-quote) { padding-left: 6px; border-left-width: 2px; }
.cb-kbd {
  flex-shrink: 0; font-size: 10px; color: var(--text-secondary); opacity: 0.55;
  padding: 2px 7px; border-radius: 5px; border: 1px solid rgba(0,0,0,0.08);
}

.cb-pad { padding: 8px 14px 10px; }

/* 标题区，跟便签卡编辑态的 .nc-title-input 同款——按区域区分标题/正文，不靠段落文字样式。
   固定分割线常驻，不看有没有内容。上下各留 8px，跟卡片顶部/正文都拉开距离。 */
.cb-title-input {
  display: block; width: 100%;
  border: none; outline: none; background: none; padding: 0 0 7px; margin: 8px 0;
  border-bottom: 1px solid rgba(0,0,0,0.08);
  font-size: 14px; font-weight: 600; line-height: 1.35;
  color: var(--text-primary); font-family: var(--font-sans);
}
.cb-title-input::placeholder { color: var(--text-secondary); opacity: 0.5; font-weight: 400; }

/* 固定总高度而不是指望每个子元素都精确同高——补录出现/消失时这条行绝不跟着变 size，
   矮一点的子元素大不了在这个高度里居中（align-items:center），比"调到刚好一样高"更稳。
   40px = 8px padding-top + 1px border-top + 31px 内容区（够放最高的日期选择框 ~28.4px）。 */
.cb-foot {
  display: flex; align-items: center; gap: 8px;
  height: 40px; flex-shrink: 0;
  margin-top: 6px; padding-top: 8px;
  border-top: 1px solid rgba(0,0,0,0.05);
}
.cb-backfill {
  display: flex; align-items: center; gap: 6px; flex-shrink: 0;
  font-size: 12px; color: var(--text-secondary);
  cursor: pointer; user-select: none; white-space: nowrap;
}
.cb-backfill.on { color: var(--color-primary); }
.cb-date { width: 100px; }
/* DatePicker 默认触发器（.dp-input）比这一排其它元素（补录checkbox/收起/记录按钮）高，
   勾上补录后这条 foot 行整体变高，捕捉条展开高度跟着抖一下。缩小到跟这排其它元素齐平。 */
.cb-date :deep(.dp-input) { padding: 6px 10px; box-sizing: border-box; font-size: 12px; }

/* 提示文字 + 收起 + 记录三个一组贴右边——提示挪到这（原来在 NoteEditor 自己的工具栏里，
   现在紧挨着收起按钮）。这一行跟编辑器的「样式」「插入」抽屉不在同一行，抽屉展开也不用
   让位，常驻显示。 */
.cb-right { margin-left: auto; flex-shrink: 0; display: flex; align-items: center; gap: 8px; }
.cb-hint { font-size: 11px; color: var(--text-secondary); opacity: 0.65; white-space: nowrap; }
.cb-hint code {
  padding: 0 3px; border-radius: 3px;
  background: rgba(123,127,178,0.12); font-size: 10.5px;
}
.cb-min {
  flex-shrink: 0; display: inline-flex; padding: 5px;
  border: none; border-radius: 6px; background: none;
  color: var(--text-secondary); cursor: pointer;
}
.cb-min:hover { background: rgba(0,0,0,0.05); }

.cb-save {
  flex-shrink: 0;
  padding: 6px 16px; border: none; border-radius: var(--radius-sm);
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
  color: rgba(255,255,255,0.95);
  font-size: 12.5px; font-weight: 600; cursor: pointer;
  font-family: var(--font-sans);
}
.cb-save:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
