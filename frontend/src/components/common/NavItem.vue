<template>
  <router-link :to="to" class="nav-item" active-class="active">
    <component :is="icon" class="nav-icon" :size="15" />
    <span class="nav-label-text"><slot /></span>
    <span v-if="$slots.badge" class="badge"><slot name="badge" /></span>
  </router-link>
</template>

<script setup>
defineProps({ to: String, icon: Object })
</script>

<style scoped>
.nav-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 10px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: rgba(30,32,40,0.62);
  text-decoration: none;
  transition: all 0.15s;
  border: 1px solid transparent;
}
.nav-item:hover {
  background: rgba(123,127,178,0.08);
  color: rgba(30,32,40,0.82);
}
.nav-item.active {
  background: rgba(255,255,255,0.38);
  color: var(--color-primary);
  font-weight: 600;
  border-color: rgba(255,255,255,0.62);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.85);
}
.nav-icon { width: 15px; height: 15px; flex-shrink: 0; }
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
