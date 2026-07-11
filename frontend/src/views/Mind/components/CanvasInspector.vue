<template>
  <aside v-if="item" class="canvas-inspector glass-card" @pointerdown.stop>
    <div class="ci-head">
      <span>便签详情</span>
      <button title="关闭详情" @click="emit('close')"><PhX :size="15" weight="bold" /></button>
    </div>
    <template v-if="item.node.kind === 'canvas_note'">
      <input v-model="draftTitle" class="ci-title-input" placeholder="便签标题" @change="save" />
      <textarea v-model="draftContent" class="ci-editor" placeholder="写点什么…" @change="save"></textarea>
    </template>
    <template v-else>
      <span v-if="item.node.kind === 'ref'" class="ci-kind">{{ refLabel }}</span>
      <h2>{{ title }}</h2>
      <div class="ci-content" v-html="preview"></div>
    </template>
    <div class="ci-meta">已关联 {{ relationCount }} 条</div>
    <div class="ci-actions">
      <button class="ci-link" :class="{ active: connecting }" @click="emit('connect')">
        <PhLinkSimple :size="15" weight="bold" />
        {{ connecting ? '选择另一张便签' : '建立关联' }}
      </button>
      <button class="ci-remove" title="从画布移除" @click="emit('remove')"><PhTrash :size="15" weight="bold" /></button>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref, type PropType, watch } from 'vue'
import { PhLinkSimple, PhTrash, PhX } from '@phosphor-icons/vue'
import type { MindCanvasItem } from '@/services/api'
import { mdToPreviewHtml, splitMindTitleBody } from '@/composables/useMindEditor'

const props = defineProps({
  item: { type: Object as PropType<MindCanvasItem | null>, default: null },
  relationCount: { type: Number, default: 0 },
  connecting: { type: Boolean, default: false },
})
const emit = defineEmits(['close', 'connect', 'remove', 'save'])

const split = computed(() => splitMindTitleBody(props.item?.node.contentMd))
const title = computed(() => split.value.titleRaw || props.item?.node.title || '未命名便签')
const preview = computed(() => mdToPreviewHtml(split.value.body || props.item?.node.contentMd || ''))
const refLabel = computed(() => ({ project: '项目', file: '文件', event: '活动' }[props.item?.node.refType || ''] || '对象'))
const draftTitle = ref('')
const draftContent = ref('')
watch(() => props.item, (item) => {
  draftTitle.value = item?.node.title || ''
  draftContent.value = item?.node.contentMd || ''
}, { immediate: true })

function save() {
  if (!props.item || props.item.node.kind !== 'canvas_note') return
  emit('save', { title: draftTitle.value, contentMd: draftContent.value })
}

</script>

<style scoped>
.canvas-inspector {
  position: absolute; top: 12px; right: 12px; z-index: 8;
  display: flex; flex-direction: column; width: 278px; min-height: 238px;
  padding: 16px; border-radius: 8px;
  background: rgba(249, 250, 255, .72); border: 1px solid rgba(255,255,255,.82);
}
.ci-head { display: flex; align-items: center; justify-content: space-between; color: var(--text-secondary); font-size: 12px; font-weight: 700; }
.ci-head button, .ci-remove { display: inline-flex; align-items: center; justify-content: center; border: 0; background: none; color: var(--text-secondary); cursor: pointer; }
.ci-head button { width: 25px; height: 25px; border-radius: 6px; }
.ci-head button:hover, .ci-remove:hover { background: rgba(88, 94, 134, .1); color: var(--color-primary); }
.ci-kind { align-self: flex-start; margin-top: 18px; padding: 2px 7px; border-radius: 4px; background: rgba(123,127,178,.12); color: var(--color-primary); font-size: 10px; font-weight: 700; }
h2 { margin: 11px 0 9px; font-size: 16px; line-height: 1.4; overflow-wrap: anywhere; }
.ci-title-input { width: 100%; box-sizing: border-box; margin: 18px 0 9px; padding: 0; border: 0; outline: 0; background: transparent; color: var(--text-primary); font: inherit; font-size: 16px; font-weight: 700; }
.ci-title-input::placeholder, .ci-editor::placeholder { color: var(--text-secondary); opacity: .58; }
.ci-editor { flex: 1; min-height: 120px; width: 100%; box-sizing: border-box; resize: vertical; border: 0; outline: 0; background: transparent; color: var(--text-secondary); font: inherit; font-size: 12.5px; line-height: 1.65; }
.ci-content { flex: 1; min-height: 82px; max-height: 290px; overflow: auto; color: var(--text-secondary); font-size: 12.5px; line-height: 1.65; overflow-wrap: anywhere; }
.ci-content :deep(*) { margin: 0; }
.ci-content :deep(* + *) { margin-top: .35em; }
.ci-meta { margin-top: 14px; color: var(--text-secondary); font-size: 11px; opacity: .78; }
.ci-actions { display: flex; align-items: center; gap: 7px; margin-top: 12px; }
.ci-link { display: inline-flex; flex: 1; align-items: center; justify-content: center; gap: 6px; height: 31px; border: 1px solid rgba(123,127,178,.2); border-radius: 6px; background: rgba(255,255,255,.58); color: var(--color-primary); font-size: 12px; font-weight: 650; cursor: pointer; }
.ci-link:hover, .ci-link.active { background: rgba(123,127,178,.13); }
.ci-remove { width: 31px; height: 31px; border: 1px solid rgba(123,127,178,.14); border-radius: 6px; }
</style>
