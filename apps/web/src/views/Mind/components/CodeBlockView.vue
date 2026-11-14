<!-- 代码块的自定义 NodeView：@tiptap/extension-code-block-lowlight 本身只挂语法高亮的
     decoration，不显示语言名——纯靠颜色猜不出自动识别到底生没生效。这里加一行语言标签
     （写了语言直接显示，没写就实时算 highlightAuto 猜的），跟只读预览的 .np-code-lang
     是同一个视觉语言（见 mind-content.css）。
     语言名的计算跟 decoration 插件是各算各的，两边都跑一遍 lowlight——重复算了，但代码块
     内容短、算得快，为了不去碰 decoration 插件内部状态，这个重复目前可以接受。 -->
<template>
  <NodeViewWrapper class="ne-codeblock">
    <div class="ne-codeblock-lang" contenteditable="false">{{ displayLang }}</div>
    <pre><NodeViewContent as="code" /></pre>
  </NodeViewWrapper>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { NodeViewContent, NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { resolveCodeLanguage } from '@/composables/mind/useMindEditor'

const props = defineProps(nodeViewProps)

const displayLang = computed(() => resolveCodeLanguage(props.node.attrs.language, props.node.textContent))
</script>
