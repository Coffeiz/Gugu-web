<template>
  <div class="settings">
    <span class="eyebrow">{{ t('settings.connection') }}</span><h1>{{ t('nav.settings') }}</h1>
    <div class="ls-card form">
      <label>{{ t('settings.guguApiBase') }}<input v-model="apiBase" placeholder="http://127.0.0.1:5173/api/v1" /></label>
      <div class="actions"><button class="ls-button primary" @click="save">{{ t('settings.saveTab') }}</button><span>{{ t(stateKey) }}</span></div>
    </div>
    <p class="note">{{ t('settings.note') }}</p>
  </div>
</template>
<script setup lang="ts">
import { ref } from 'vue'
import { loadBootstrap, saveBootstrap } from '../services/gugu'
import { useLoopScopeI18n } from '../i18n/index'
const { t } = useLoopScopeI18n()
const old=loadBootstrap()
const apiBase=ref(old?.apiBase ?? 'http://127.0.0.1:5173/api/v1')
const stateKey=ref(old?'settings.connected':'settings.notConnected')
function save(){ saveBootstrap({apiBase:apiBase.value});stateKey.value='settings.saved' }
</script>
<style scoped>
.settings{max-width:720px;padding:42px}.eyebrow{font-size:9px;letter-spacing:.12em;color:var(--content-tertiary)}h1{margin:4px 0 22px}.form{padding:18px;display:grid;gap:15px}label{display:grid;gap:6px;font-size:10px;color:var(--content-secondary)}input{height:38px;border:1px solid var(--border-subtle);border-radius:var(--radius-sm);background:var(--surface-raised);padding:0 10px}.actions{display:flex;align-items:center;gap:10px;font-size:10px;color:var(--content-tertiary)}.note{font-size:11px;line-height:1.7;color:var(--content-secondary)}
</style>
