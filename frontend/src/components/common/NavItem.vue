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

// 复刻 router-link 默认的「包含式」匹配：当前路径等于 to 或在 to 之下即高亮
const isActive = computed(
  () => route.path === props.to || route.path.startsWith(props.to + '/'),
)
function go() {
  if (route.path !== props.to) router.push(props.to)
}
</script>

<style scoped>
.nav-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  font-size: 14px;
  color: #767980;   /* 比 --text-secondary(#8a8fa8) 饱和度更低、且更深的灰 */
  text-decoration: none;
  cursor: pointer;
  transition: all 0.15s;
  border: 1px solid transparent;
}
.nav-item:hover {
  background: rgba(123,127,178,0.08);
  color: var(--text-primary);
}
.nav-item.active {
  background: rgba(255,255,255,0.38);
  color: #6b6fa0;   /* 比 --color-primary(#7b7fb2) 更深一档，同色相 */
  font-weight: 700;
  border-color: rgba(255,255,255,0.62);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.85);
}
.nav-icon { width: 14px; height: 14px; flex-shrink: 0; }
.nav-label-text { flex: 1; }
.badge {
  background: rgba(123,127,178,0.42);
  color: white;
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 20px;
  min-width: 18px;
  text-align: center;
}
</style>
