<template>
  <!-- 便签/画布便签共用的自定义颜色选择器——只是几个预设色点，不是完整取色器。四个色沿用
       "Caribbean" 配色（亮色、高饱和度：青绿/蓝/珊瑚橙/黄），色点本身就用饱和原色，
       整卡淡染的具体透明度在 NoteCard.vue 的 .tint-teal/blue/coral/amber 里定义。
       这里只提供"选哪个"的入口，选中的值原样存回 MindNode.color（后端/store 早就打通，
       只是一直没有 UI 写它）。 -->
  <span class="color-swatches" @pointerdown.stop @click.stop>
    <button
      v-for="c in options" :key="c || 'none'"
      class="cs-dot" :class="[c ? `cs-${c}` : 'cs-none', { active: (modelValue || null) === c }]"
      :title="c ? t(`mindUi.colors.${COLOR_LABEL[c]}`) : t('mindUi.defaultColor')"
      @click="emit('update:modelValue', c)"
    ></button>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

// 顺序：橙/红/蓝/青（用户指定的排序，底层类名/色值不变，只是显示顺序 + 中文叫法调整）。
const COLOR_ORDER: string[] = ['amber', 'coral', 'blue', 'teal']
const { t } = useI18n()
const COLOR_LABEL: Record<string, string> = { amber: 'amber', coral: 'coral', blue: 'blue', teal: 'teal' }

const props = defineProps<{
  modelValue: string | null
  // 画布便签不该有"默认无色"这个选项（NoteSticker.vue 传 false）——画布便签新建时就直接
  // 落了一个默认色（见 CanvasView.vue 的 createCanvasNote），去掉"无色"能一直选就没有能
  // 半路清空回纸色的入口，跟"画布便签必须有颜色"这个新约定一致。笔记页时间流的便签不传
  // 这个 prop，默认还是可以选"无色"退回纸色。
  allowNone?: boolean
}>()
const emit = defineEmits<{ (e: 'update:modelValue', color: string | null): void }>()

const options = computed<(string | null)[]>(() => props.allowNone === false ? COLOR_ORDER : [null, ...COLOR_ORDER])
</script>

<style scoped>
.color-swatches { display: inline-flex; align-items: center; gap: 4px; margin-right: 3px; }
.cs-dot {
  width: 12px; height: 12px; flex-shrink: 0; border-radius: 50%; padding: 0; cursor: pointer;
  border: 1px solid rgba(255,255,255,0.85); box-shadow: 0 1px 2px rgba(80,90,110,0.18);
  transition: transform 0.12s ease;
}
.cs-dot:hover { transform: scale(1.15); }
.cs-dot.active { box-shadow: 0 0 0 2px var(--color-primary), 0 1px 2px rgba(80,90,110,0.18); }
/* 棋盘格代表"不上色"，跟色板软件的透明色图标同一个约定，不会被误认成"白色" */
.cs-none { background: repeating-conic-gradient(#dcdce2 0% 25%, #fff 0% 50%) 0 0 / 6px 6px; }
/* "Caribbean" 配色，色点直接用饱和原色（不是淡染后的低饱和版本）——色点本身就该看着
   鲜亮，让用户一眼分清选的是哪个颜色；淡染到卡片背景上的透明度单独在 NoteCard.vue 里调。 */
.cs-teal  { background: #53D2DC; }
.cs-blue  { background: #3196E2; }
.cs-coral { background: #FF826C; }
.cs-amber { background: #FFC05F; }
</style>
