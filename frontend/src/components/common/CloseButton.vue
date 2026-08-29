<template>
  <button class="app-close-button" type="button" :title="title" :aria-label="title" @click="$emit('click', $event)">
    <Icon name="action.close" :size="14" />
  </button>
</template>

<script setup lang="ts">
import Icon from './Icon.vue'
withDefaults(defineProps<{ title?: string }>(), { title: '关闭' })
defineEmits<{ (event: 'click', value: MouseEvent): void }>()
</script>

<style scoped>
.app-close-button { display:inline-flex; align-items:center; justify-content:center; flex:0 0 30px; width:30px; height:30px; padding:0; border:1px solid var(--control-border); border-radius:var(--radius-sm); background:var(--control-bg); color:var(--content-secondary); cursor:pointer; transition:background-color var(--motion-hover-control) var(--motion-ease-standard),border-color var(--motion-hover-control) var(--motion-ease-standard),color var(--motion-hover-control) var(--motion-ease-standard); }
.app-close-button:hover { background:var(--control-bg-hover); border-color:var(--control-border-hover); color:var(--content-primary); }
.app-close-button:focus-visible { outline:2px solid var(--action-primary); outline-offset:2px; }
</style>
