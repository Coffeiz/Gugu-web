<template>
  <!-- div + 编程式跳转：不渲染 <a href>，悬停时浏览器状态栏不暴露 URL -->
  <div
    class="nav-item"
    :class="{ active: isActive }"
    role="link"
    tabindex="0"
    @click="go"
    @keydown.enter="go"
  >
    <component :is="icon" class="nav-icon" :size="14" weight="bold" />
    <span class="nav-label-text"><slot /></span>
    <span v-if="$slots.badge" class="badge"><slot name="badge" /></span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'

const props = defineProps({ to: String, icon: Object })
const route = useRoute()
const router = useRouter()

const isActive = computed(
  () => route.path === props.to || route.path.startsWith(props.to + '/'),
)
function go() {
  if (props.to && route.path !== props.to) router.push(props.to)
}
</script>

<style scoped>
.nav-item {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-regular);
  line-height: var(--line-height-ui);
  color: var(--sidebar-item-fg);
  text-decoration: none;
  cursor: pointer;
  transition: background var(--motion-fast), color var(--motion-fast), border-color var(--motion-fast), box-shadow var(--motion-fast);
  border: 1px solid transparent;
}
.nav-item:hover {
  background: var(--sidebar-item-hover);
  color: var(--content-primary);
}
.nav-item.active {
  background: var(--sidebar-item-active);
  color: var(--sidebar-item-active-fg);
  font-weight: var(--font-weight-bold);
  border-color: var(--sidebar-item-active-border);
  box-shadow: var(--sidebar-item-active-shadow);
}
.nav-item:focus-visible {
  outline: none;
  box-shadow: var(--control-focus-shadow);
}
.nav-icon { width: 14px; height: 14px; flex-shrink: 0; }
.nav-label-text { flex: 1; }
.badge {
  background: color-mix(in srgb,var(--action-primary) 42%,transparent);
  color: var(--content-on-accent);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-bold);
  padding: 1px var(--space-xs);
  border-radius: var(--radius-pill);
  min-width: 18px;
  text-align: center;
}
</style>
