<template>
  <div class="pv-wrap">
    <iframe
      v-if="blobUrl"
      :src="pdfSrc"
      class="pv-iframe"
      title="PDF 预览"
    />
    <div v-else class="pv-status">
      <div class="pv-spinner" />
      <span>加载中…</span>
    </div>
  </div>
</template>

<script setup>
/**
 * PDF 预览：用 <iframe> 走浏览器原生 PDF 引擎（Chrome PDFium 等）。
 * 原生引擎是 native code，大文件 / 多页 / 缩放滚动都比自渲染 canvas 流畅得多；
 * 代价是用浏览器自带工具栏、UI 不可定制。曾用 pdfjs-dist 自渲染（tile + 双缓冲），
 * 性能一般，故换回 iframe；历史实现见 git 记录。
 */
import { computed } from 'vue'

const props = defineProps({
  blobUrl: { type: String, default: null },
})

// #view=FitH：默认按页面宽度适配（更适合阅读文档）
const pdfSrc = computed(() => (props.blobUrl ? props.blobUrl + '#view=FitH' : null))
</script>

<style scoped>
.pv-wrap {
  position: absolute;
  inset: 0;
  background: rgba(228, 230, 238, 0.6);
}

.pv-iframe {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
  background: #fff;
}

/* 加载态 */
.pv-status {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-secondary);
}

.pv-spinner {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 3px solid rgba(123, 127, 178, 0.2);
  border-top-color: rgba(123, 127, 178, 0.7);
  animation: pv-spin 0.7s linear infinite;
}

@keyframes pv-spin {
  to { transform: rotate(360deg); }
}
</style>
