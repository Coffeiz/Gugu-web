<template>
  <div class="shell">
    <aside class="rail">
      <div class="brand">
        <div class="brand-mark">LS</div>
        <div><strong>LoopScope</strong><small>AgentLoop dev tool</small></div>
      </div>
      <nav class="nav">
        <RouterLink to="/">{{ t('nav.conversation') }}</RouterLink>
        <RouterLink to="/reflections">{{ t('nav.reflections') }}</RouterLink>
        <RouterLink to="/tokens">{{ t('nav.tokens') }}</RouterLink>
        <RouterLink to="/changelog">{{ t('nav.changelog') }}</RouterLink>
        <RouterLink to="/settings">{{ t('nav.settings') }}</RouterLink>
      </nav>
      <div class="rail-footer">
        <div class="account-card" :title="connected ? t('nav.accountHint') : t('nav.accountDisconnected')">
          <span class="account-avatar">{{ accountInitial }}</span>
          <span class="account-info">
            <strong>{{ accountName || t('nav.guguAccount') }}</strong>
            <small><i class="dot" :class="{ on: connected }"></i>{{ connected ? t('nav.connected') : t('nav.disconnected') }}</small>
          </span>
          <button
            class="locale-btn"
            :aria-label="t('nav.language')"
            :title="localeButtonTitle"
            @click="cycleLocale"
          >{{ locale === 'zh-CN' ? '中' : 'EN' }}</button>
        </div>
      </div>
    </aside>
    <main class="page"><RouterView /></main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { loadBootstrap } from './services/gugu'
import { setLocale, useLoopScopeI18n } from './i18n/index'
const connected = ref(!!loadBootstrap())
const bootstrap = ref(loadBootstrap())
const update = () => {
  bootstrap.value = loadBootstrap()
  connected.value = !!bootstrap.value
}
const accountName = computed(() => bootstrap.value?.accountName ?? '')
const accountInitial = computed(() => accountName.value.trim().slice(0, 1).toLocaleUpperCase() || 'G')
const { locale, t } = useLoopScopeI18n()
const localeButtonTitle = computed(() => `${t('nav.language')}: ${t(locale.value === 'zh-CN' ? 'locale.chinese' : 'locale.english')}`)
function cycleLocale() {
  setLocale(locale.value === 'zh-CN' ? 'en-US' : 'zh-CN')
}
onMounted(() => {
  window.addEventListener('loopscope:bootstrap', update)
})
onUnmounted(() => {
  window.removeEventListener('loopscope:bootstrap', update)
})
</script>

<style scoped>
.shell { display:grid; grid-template-columns: 190px minmax(0,1fr); min-height:100vh; }
.rail { position:sticky; top:0; height:100vh; padding:18px 14px; border-right:1px solid var(--border-subtle); background:var(--surface-panel); backdrop-filter:blur(22px); display:flex; flex-direction:column; gap:22px; }
.brand { display:flex; gap:10px; align-items:center; }
.brand-mark { width:34px; height:34px; display:grid; place-items:center; border-radius:11px; background:var(--action-primary); color:white; font-weight:700; font-size:12px; }
.brand small { display:block; color:var(--content-tertiary); font-size:10px; margin-top:2px; }
.nav { display:grid; gap:5px; }
.nav a { text-decoration:none; padding:9px 10px; border-radius:10px; color:var(--content-secondary); font-size:13px; }
.nav a.router-link-active { background:var(--action-soft); color:var(--action-primary); font-weight:600; }
.rail-footer { margin-top:auto; }
.account-card { min-width:0; display:grid; grid-template-columns:30px minmax(0,1fr) auto; align-items:center; gap:9px; padding:8px; border:1px solid var(--border-subtle); border-radius:var(--radius-md); background:var(--surface-card); }
.account-avatar { width:30px; height:30px; flex:0 0 30px; display:grid; place-items:center; border-radius:50%; background:var(--action-soft); color:var(--action-primary); font-size:12px; font-weight:var(--font-weight-semibold); }
.account-info { min-width:0; display:grid; gap:3px; }
.account-info strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; font-weight:var(--font-weight-medium); }
.account-info small { display:flex; align-items:center; gap:5px; color:var(--content-tertiary); font-size:9px; }
.dot { width:6px; height:6px; flex:0 0 6px; border-radius:50%; background:var(--status-danger); }
.dot.on { background:var(--status-success); }
.locale-btn { min-width:28px; height:28px; padding:0 5px; border:1px solid var(--border-subtle); border-radius:7px; background:var(--surface-raised); color:var(--content-secondary); font:inherit; font-size:10px; font-weight:var(--font-weight-semibold); cursor:pointer; transition:color var(--motion-fast),background var(--motion-fast),border-color var(--motion-fast); }
.locale-btn:hover,.locale-btn:focus-visible { color:var(--content-primary); background:var(--surface-list-option-hover); border-color:var(--border-default); }
.page { min-width:0; min-height:100vh; }
@media (max-width: 760px) { .shell { grid-template-columns:1fr; } .rail { position:static; height:auto; flex-direction:row; align-items:center; overflow:visible; } .nav { display:flex; } .rail-footer { margin:0 0 0 auto; } .account-info small { display:none; } }
</style>
