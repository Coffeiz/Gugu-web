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
        </div>
        <div ref="localeRoot" class="locale-control" @keydown.esc="localeOpen = false">
          <button class="locale-trigger" :aria-label="t('nav.language')" :aria-expanded="localeOpen" @click="localeOpen = !localeOpen">
            <span>{{ locale === 'zh-CN' ? '中' : 'EN' }}</span>
            <FlipChevron :open="localeOpen" :size="9" />
          </button>
          <div v-if="localeOpen" class="locale-popup" role="menu" :aria-label="t('nav.language')">
            <button v-for="option in localeOptions" :key="option.value" class="locale-option" :class="{ active: locale === option.value }" role="menuitemradio" :aria-checked="locale === option.value" @click="chooseLocale(option.value)">
              <span>{{ t(option.key) }}</span><span v-if="locale === option.value" class="locale-check">✓</span>
            </button>
          </div>
        </div>
      </div>
    </aside>
    <main class="page"><RouterView /></main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { loadBootstrap } from './services/gugu'
import { setLocale, useLoopScopeI18n, type Locale } from './i18n/index'
import FlipChevron from './components/FlipChevron.vue'
const connected = ref(!!loadBootstrap())
const bootstrap = ref(loadBootstrap())
const update = () => {
  bootstrap.value = loadBootstrap()
  connected.value = !!bootstrap.value
}
const accountName = computed(() => bootstrap.value?.accountName ?? '')
const accountInitial = computed(() => accountName.value.trim().slice(0, 1).toLocaleUpperCase() || 'G')
const localeOpen = ref(false)
const localeRoot = ref<HTMLElement | null>(null)
const { locale, t } = useLoopScopeI18n()
const localeOptions = [
  { value: 'zh-CN' as const, key: 'locale.chinese' },
  { value: 'en-US' as const, key: 'locale.english' },
]
function chooseLocale(value: Locale) {
  setLocale(value)
  localeOpen.value = false
}
function onDocumentPointerDown(event: PointerEvent) {
  if (!localeRoot.value?.contains(event.target as Node)) localeOpen.value = false
}
onMounted(() => {
  window.addEventListener('loopscope:bootstrap', update)
  document.addEventListener('pointerdown', onDocumentPointerDown)
})
onUnmounted(() => {
  window.removeEventListener('loopscope:bootstrap', update)
  document.removeEventListener('pointerdown', onDocumentPointerDown)
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
.rail-footer { margin-top:auto; display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:8px; }
.account-card { min-width:0; display:flex; align-items:center; gap:9px; padding:8px; border:1px solid var(--border-subtle); border-radius:var(--radius-md); background:var(--surface-card); }
.account-avatar { width:30px; height:30px; flex:0 0 30px; display:grid; place-items:center; border-radius:50%; background:var(--action-soft); color:var(--action-primary); font-size:12px; font-weight:var(--font-weight-semibold); }
.account-info { min-width:0; display:grid; gap:3px; }
.account-info strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; font-weight:var(--font-weight-medium); }
.account-info small { display:flex; align-items:center; gap:5px; color:var(--content-tertiary); font-size:9px; }
.dot { width:6px; height:6px; flex:0 0 6px; border-radius:50%; background:var(--status-danger); }
.dot.on { background:var(--status-success); }
.locale-control { position:relative; }
.locale-trigger { height:36px; min-width:42px; display:flex; align-items:center; justify-content:center; gap:5px; border:1px solid var(--border-subtle); border-radius:var(--radius-sm); background:var(--surface-raised); color:var(--content-secondary); font-size:10px; }
.locale-trigger:hover { background:var(--surface-list-option-hover); }
.locale-popup { position:absolute; right:0; bottom:calc(100% + 8px); z-index:20; width:158px; padding:5px; border:1px solid var(--border-list-overlay); border-radius:var(--radius-list-overlay); background:var(--surface-list-overlay); box-shadow:var(--elevation-list-overlay); backdrop-filter:blur(20px); }
.locale-option { width:100%; min-height:34px; display:flex; align-items:center; justify-content:space-between; padding:0 9px; border:0; border-radius:var(--radius-xs); background:transparent; color:var(--content-secondary); text-align:left; font-size:11px; }
.locale-option:hover,.locale-option.active { background:var(--surface-list-option-hover); color:var(--content-primary); }
.locale-check { color:var(--action-primary); font-size:12px; }
.page { min-width:0; min-height:100vh; }
@media (max-width: 760px) { .shell { grid-template-columns:1fr; } .rail { position:static; height:auto; flex-direction:row; align-items:center; overflow:visible; } .nav { display:flex; } .rail-footer { margin:0 0 0 auto; grid-template-columns:minmax(100px,1fr) auto; } .account-info small { display:none; } }
</style>
