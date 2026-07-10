<template>
  <div class="md-view" v-html="rendered" />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { renderMarkdown, sanitizeHtml } from '@/utils/markdown'

// 全站通用的 markdown 展示组件，统一 GuguChat 聊天 / 通知气泡 / 侧边栏通知中心的 md 输出样式。
// - text：原始 markdown 文本，用轻量 renderMarkdown 渲染；
// - html：已预渲染好的 HTML（如 GuguChat 的 hljs 代码高亮 / 流式渲染产物），优先使用。
// 字号用 em 相对父容器，各处只需在外层设 font-size，元素排版（间距/配色/代码块）保持一致。
const props = defineProps({
  text: { type: String, default: '' },
  html: { type: String, default: null },
})
// html 预渲染 prop 同样不可信（来自后端/流式），也必须消毒——不能因「已是 HTML」就跳过
const rendered = computed(() => (props.html != null ? sanitizeHtml(props.html) : renderMarkdown(props.text)))
</script>

<style scoped>
.md-view { font-size: inherit; line-height: 1.6; word-break: break-word; overflow-wrap: break-word; }
.md-view :deep(> :first-child) { margin-top: 0; }
.md-view :deep(> :last-child)  { margin-bottom: 0; }

.md-view :deep(p) { margin: 0 0 7px; line-height: 1.6; }

.md-view :deep(h1), .md-view :deep(h2), .md-view :deep(h3),
.md-view :deep(h4), .md-view :deep(h5), .md-view :deep(h6) {
  margin: 9px 0 5px; font-weight: 700; line-height: 1.3; color: var(--text-primary);
}
.md-view :deep(h1) { font-size: 1.18em; }
.md-view :deep(h2) { font-size: 1.1em; }
.md-view :deep(h3) { font-size: 1.04em; }
.md-view :deep(h4), .md-view :deep(h5), .md-view :deep(h6) { font-size: 1em; }

.md-view :deep(strong) { font-weight: 700; color: var(--text-primary); }
.md-view :deep(em) { font-style: italic; }
.md-view :deep(del) { text-decoration: line-through; opacity: 0.6; }
.md-view :deep(a) { color: var(--color-primary); text-decoration: underline; text-underline-offset: 2px; }
.md-view :deep(a:hover) { opacity: 0.8; }

.md-view :deep(ul), .md-view :deep(ol) { margin: 4px 0 7px; padding-left: 18px; }
.md-view :deep(ul) { list-style: disc; }
.md-view :deep(ol) { list-style: decimal; }
.md-view :deep(li) { margin: 3px 0; line-height: 1.6; display: list-item; }
.md-view :deep(li > p) { margin: 0; }
.md-view :deep(li > ul), .md-view :deep(li > ol) { margin: 2px 0; }

.md-view :deep(code) {
  font-family: var(--font-mono, 'JetBrains Mono', ui-monospace, monospace);
  font-size: 0.88em; background: rgba(123,127,178,0.12);
  color: var(--color-primary); border-radius: 5px; padding: 1px 5px;
}
.md-view :deep(blockquote) {
  margin: 7px 0; padding: 2px 0 2px 10px;
  border-left: 2.5px solid var(--color-primary); color: var(--text-secondary);
}
.md-view :deep(hr) { border: none; border-top: 1px solid rgba(0,0,0,0.1); margin: 9px 0; }

.md-view :deep(table) { border-collapse: collapse; margin: 7px 0; width: 100%; font-size: 0.9em; }
.md-view :deep(th), .md-view :deep(td) { border: 1px solid rgba(0,0,0,0.12); padding: 4px 7px; text-align: left; }
.md-view :deep(th) { background: rgba(123,127,178,0.1); font-weight: 600; }
.md-view :deep(tr:nth-child(even) td) { background: rgba(0,0,0,0.02); }

.md-view :deep(img) { max-width: 100%; max-height: 240px; border-radius: 8px; object-fit: contain; display: block; margin: 4px 0; }

/* 代码块：GuguChat 的 hljs 渲染产物（.md-code-block + 头部语言标签 + 复制按钮 + token 配色）。
   轻量 renderMarkdown 产出的是裸 <pre><code>，由下面的 pre 兜底样式接管。 */
.md-view :deep(pre) { margin: 7px 0; padding: 9px 12px; overflow-x: auto; background: rgba(20,22,40,0.05); border-radius: 8px; }
.md-view :deep(pre code) { background: none; color: var(--text-primary); padding: 0; border-radius: 0; font-size: 0.95em; line-height: 1.6; }
.md-view :deep(.md-code-block) { margin: 8px 0; border-radius: 8px; overflow: hidden; background: rgba(123,127,178,0.04); font-size: 0.9em; }
.md-view :deep(.md-code-block pre) { margin: 0; background: none; border-radius: 0; }
.md-view :deep(.md-code-header) { display: flex; align-items: center; justify-content: space-between; padding: 5px 12px; background: rgba(123,127,178,0.12); border-bottom: 1px solid rgba(123,127,178,0.2); }
.md-view :deep(.md-code-lang) { font-size: 10px; font-weight: 600; color: var(--color-primary); opacity: 0.85; text-transform: lowercase; letter-spacing: 0.04em; }
.md-view :deep(.md-copy-btn) { font-size: 10px; font-weight: 600; color: var(--color-primary); background: none; border: none; cursor: pointer; padding: 0; opacity: 0.7; transition: opacity 0.15s; }
.md-view :deep(.md-copy-btn:hover) { opacity: 1; }
.md-view :deep(.hljs-keyword) { color: #7b5cf0; }
.md-view :deep(.hljs-string) { color: #2d7a4f; }
.md-view :deep(.hljs-comment) { color: #9a9a9a; font-style: italic; }
.md-view :deep(.hljs-number) { color: #b07858; }
.md-view :deep(.hljs-function) { color: #4a7fb5; }
.md-view :deep(.hljs-title) { color: #4a7fb5; font-weight: 600; }
.md-view :deep(.hljs-attr) { color: #b07858; }
.md-view :deep(.hljs-built_in) { color: #5a9e88; }
.md-view :deep(.hljs-variable) { color: #1e2028; }
</style>
