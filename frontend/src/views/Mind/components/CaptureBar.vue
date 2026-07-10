<template>
  <!-- 底部停靠捕捉条：收起=单行占位；聚焦展开=编辑器+工具栏从条内长出来（不弹浮层）。
       展开/收起走 grid-template-rows 0fr↔1fr 的弹性过渡（同项目卡的 spring 曲线），
       两段（单行头/编辑区）反向伸缩，总高度连续变化；编辑器常驻挂载，收起方向才有内容可缩。
       浮在滚动的便签流之上：玻璃可以用，但内部交互元素克制（hover 只做 opacity/淡背景，
       不做 box-shadow 过渡——白带红线）；本组件自身/祖先不挂 opacity 动画（隔离组红线）。 -->
  <div ref="barRef" class="capture-bar" :class="{ expanded }">
    <!-- 展开内容：grid 0fr↔1fr 提供高度，条底固定（bottom 锚定）向上长 -->
    <div class="cb-body">
      <div class="cb-clip">
        <div class="cb-pad">
          <NoteEditor
            ref="editorRef"
            v-model="md"
            placeholder="记点什么…（Cmd/Ctrl + Enter 记录）"
            compact
            @submit="save"
          />
          <div class="cb-foot">
            <!-- 补录：日期可以往回选，落进它「发生」的那天，而不是今天 -->
            <label class="cb-backfill" :class="{ on: backfill }">
              <input type="checkbox" v-model="backfill" />
              补录到
            </label>
            <DatePicker v-if="backfill" class="cb-date" v-model="date" placeholder="选择日期" />
            <button class="cb-min" title="收起（内容保留）" @click="collapse">
              <PhCaretDown :size="13" weight="bold" />
            </button>
            <button class="cb-save press-fx" :disabled="!canSave || saving" @click="save">
              {{ saving ? '记录中…' : '记录' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 收起单行：绝对定位贴在条底，展开时**原地淡出、不随高度上移**（#3 图标/文字不上蹿）-->
    <button class="cb-collapsed" tabindex="-1" @click="expand">
      <PhPencilSimple :size="13" weight="bold" class="cb-pencil" />
      <span class="cb-placeholder">{{ md.trim() ? plainPreview : '记点什么…' }}</span>
      <span class="cb-kbd">随手记</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { PhCaretDown, PhPencilSimple } from '@phosphor-icons/vue'
import DatePicker from '@/components/common/DatePicker.vue'
import NoteEditor from './NoteEditor.vue'

const emit = defineEmits<{ (e: 'created', md: string, capturedAt?: string): void }>()

const expanded = ref(false)
const md       = ref('')
const backfill = ref(false)
const date     = ref(new Date().toISOString().slice(0, 10))
const saving   = ref(false)
const barRef    = ref<HTMLElement | null>(null)
const editorRef = ref<InstanceType<typeof NoteEditor> | null>(null)

const canSave = computed(() => md.value.trim().length > 0)
/** 收起时草稿没丢：单行里露一眼开头，提醒"这里还有没记完的" */
const plainPreview = computed(() =>
  md.value.replace(/\[\[[a-z_]+:\d+\|([^\]]*)\]\]/g, '$1').replace(/^#+\s*|-\s\[[ xX]\]\s?|-\s+/gm, '').split('\n')[0].slice(0, 40))

async function expand() {
  expanded.value = true
  await nextTick()
  editorRef.value?.focus()   // 编辑器常驻挂载（为了收起动画），不能用 autofocus，展开时手动聚焦
}
function collapse() { expanded.value = false }   // 草稿保留在 md 里，下次展开接着写

/** 点条外任意处收起。DatePicker 的日历 Teleport 到 body，得单独放行，选个日期不算"点外面" */
function onDocDown(e: MouseEvent) {
  if (!expanded.value) return
  const t = e.target as HTMLElement
  if (barRef.value?.contains(t)) return
  if (t.closest?.('.dp-popup')) return
  collapse()
}
onMounted(() => document.addEventListener('mousedown', onDocDown, true))
onUnmounted(() => document.removeEventListener('mousedown', onDocDown, true))

async function save() {
  if (!canSave.value || saving.value) return
  saving.value = true
  try {
    // 补录给当天正午的时间戳：只关心落在哪一天，不用纠结时分
    const capturedAt = backfill.value ? `${date.value}T12:00:00` : undefined
    emit('created', md.value, capturedAt)
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
  --cb-dur: 0.4s;   /* 缓出放慢些（#3） */
  --cb-ease: cubic-bezier(0.22, 1, 0.36, 1);
  position: relative;
  width: 480px; max-width: 100%; margin: 0 auto;
  min-height: 50px;   /* 收起态高度 = 咕咕球 50px（#2） */
  border-radius: 25px;
  background: rgba(255,255,255,0.6);
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  border: 1px solid rgba(255,255,255,0.78);
  box-shadow: 0 8px 28px rgba(30,40,80,0.14), inset 0 1px 0 rgba(255,255,255,0.9);
  overflow: hidden;
  transition: background-color var(--cb-dur) ease,
              backdrop-filter var(--cb-dur) ease, -webkit-backdrop-filter var(--cb-dur) ease;
}
.capture-bar.expanded {
  background: rgba(255,255,255,0.72);
  backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
}

/* 高度靠 cb-body 的 grid-rows 0fr↔1fr（放慢的缓出）。展开内容在满尺寸就地模糊淡入（延迟略
   小于高度、不再等太久，#3），收起元素动画一开始快淡出——因为收起是绝对定位贴底、不参与
   高度，展开时它原地淡出、图标文字不上蹿。 */
.cb-body {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--cb-dur) var(--cb-ease);
}
.capture-bar.expanded .cb-body { grid-template-rows: 1fr; }
.cb-clip { overflow: hidden; min-height: 0; }

/* 收起元素：绝对定位贴条底（不随高度上移）。收起态=高度收完后淡入(delay 0.16)；展开态=快淡出 */
.cb-collapsed {
  position: absolute; left: 0; right: 0; bottom: 0;
  display: flex; align-items: center; gap: 9px;
  height: 50px; box-sizing: border-box;
  padding: 0 18px; border: none;
  background: none; cursor: text; text-align: left;
  font-family: var(--font-sans); z-index: 1;
  transition: opacity 0.22s ease 0.16s, filter 0.22s ease 0.16s;
}
.capture-bar.expanded .cb-collapsed {
  opacity: 0; filter: blur(8px); pointer-events: none;
  transition: opacity 0.16s ease 0s, filter 0.16s ease 0s;
}
/* 展开元素：收起态=立刻快淡出；展开态=就地慢淡入（delay 0.14、时长 0.3，比之前少等）*/
.cb-pad {
  opacity: 0; filter: blur(8px);
  transition: opacity 0.18s ease 0s, filter 0.18s ease 0s;
}
.capture-bar.expanded .cb-pad {
  opacity: 1; filter: blur(0);
  transition: opacity 0.3s ease 0.14s, filter 0.3s ease 0.14s;
}
.cb-pencil { flex-shrink: 0; color: var(--color-primary); opacity: 0.75; }
.cb-placeholder {
  flex: 1; min-width: 0; font-size: 13px; color: var(--text-secondary); opacity: 0.75;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.cb-kbd {
  flex-shrink: 0; font-size: 10px; color: var(--text-secondary); opacity: 0.55;
  padding: 2px 7px; border-radius: 5px; border: 1px solid rgba(0,0,0,0.08);
}

.cb-pad { padding: 8px 14px 10px; }

.cb-foot {
  display: flex; align-items: center; gap: 8px;
  margin-top: 6px; padding-top: 8px;
  border-top: 1px solid rgba(0,0,0,0.05);
}
.cb-backfill {
  display: flex; align-items: center; gap: 6px; flex-shrink: 0;
  font-size: 12px; color: var(--text-secondary);
  cursor: pointer; user-select: none; white-space: nowrap;
}
.cb-backfill.on { color: var(--color-primary); }
.cb-date { width: 150px; }

.cb-min {
  margin-left: auto; flex-shrink: 0; display: inline-flex; padding: 5px;
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
