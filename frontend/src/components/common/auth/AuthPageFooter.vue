<template>
  <div class="page-footer">
    <AuthLanguageSwitcher />
    <div class="footer-copy">
      <span>Create with agents and love</span>
      <template v-if="siteConfig.icpNumber">
        <span class="footer-sep">·</span>
        <a :href="siteConfig.icpUrl" target="_blank" rel="noopener">{{ siteConfig.icpNumber }}</a>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive } from 'vue'
import AuthLanguageSwitcher from '@/components/common/auth/AuthLanguageSwitcher.vue'
import { fetchSiteConfig } from '@/services/api'

const siteConfig = reactive({ icpNumber: '', icpUrl: '' })

onMounted(async () => {
  try {
    Object.assign(siteConfig, await fetchSiteConfig())
  } catch {
    // 公开配置不可用时保持默认隐藏，不影响认证页。
  }
})
</script>

<style scoped>
.page-footer {
  position: absolute; bottom: 24px; left: 0; right: 0;
  text-align: center; font-size: 11px; color: rgba(100,108,130,0.55);
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
  pointer-events: none;
}
.footer-copy { display: flex; align-items: center; justify-content: center; gap: 6px; }
.page-footer a {
  color: rgba(100,108,130,0.55); text-decoration: none; pointer-events: auto;
}
.page-footer a:hover { color: rgba(100,108,130,0.85); }
.footer-sep { opacity: 0.5; }
</style>
