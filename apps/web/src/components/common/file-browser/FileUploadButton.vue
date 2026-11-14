<template>
  <label class="fub" :class="[mode, { dragging }]">
    <template v-if="mode === 'list'">
      <span class="fub-name-cell">
        <Icon name="action.upload" :size="13" />
        <span class="fub-text">{{ t('common.actions.upload') }}</span>
      </span>
    </template>
    <template v-else>
      <Icon name="action.upload" :size="22" />
      <span class="fub-text">{{ t('common.actions.upload') }}</span>
    </template>
    <input type="file" hidden multiple @change="emit('select', $event)" />
  </label>
</template>

<script setup lang="ts">
import Icon from '@/components/common/icons/Icon.vue'
import { useI18n } from 'vue-i18n'
/**
 * 文件库网格/列表和项目文件区网格/列表共用的上传入口——之前四处各画一份（文件库列表甚至
 * 漏画了），图标大小、文字包裹方式、hover 颜色都不一致。上传拖拽悬停态（dragging）由调用方
 * 的上传流程管理，这里只负责按 mode 呈现网格卡片式还是列表行式外观；
 * dragover/dragleave/drop 走原生事件透传，调用方直接在 <FileUploadButton> 标签上绑定即可。
 */
defineProps({
  mode: { type: String as () => 'grid' | 'list', default: 'grid' },
  dragging: { type: Boolean, default: false },
})
const emit = defineEmits<{ select: [e: Event] }>()
const { t } = useI18n()
</script>

<style scoped>
.fub { cursor: pointer; font-family: var(--font-sans); }

.fub.grid {
  border: 1.5px dashed transparent;
  /* 文件/文件夹卡片的实际网格行高约为 132.86px（90px 内容区加标签区）。
     上传入口与卡片同属 Grid 行且参与 Runtime FLIP，低于行高会在底部拖拽时
     让 scrollHeight 少几个像素，浏览器随即把 scrollTop clamp 到更小的值。 */
  border-radius: 14px; corner-shape: round; overflow: hidden; min-height: 133px;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 8px;
  font-size: 11px; font-weight: 600;
  transition: color 0.18s, background-color 0.18s, border-color 0.18s;
}
.fub.grid .app-icon {
  width: 22px;
  height: 22px;
  font-size: 22px;
}

.fub.list {
  display: grid; grid-template-columns: 2fr 90px 1.2fr 80px 72px 56px;
  column-gap: 8px; align-items: center; padding: 9px 14px;
  min-height: 42px; box-sizing: border-box;
  font-size: 12px; border-radius: var(--radius-sm);
  border: 1px dashed transparent; transition: background 0.12s, border-color 0.12s, color 0.12s;
}
.fub.list .fub-name-cell { display: flex; align-items: center; gap: 7px; min-width: 0; }
.fub.list .app-icon { flex-shrink: 0; }
.fub.list .fub-text { font-weight: 600; }
</style>
