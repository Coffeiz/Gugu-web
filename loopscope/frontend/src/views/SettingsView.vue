<template>
  <div class="settings">
    <span class="eyebrow">{{ t('settings.connection') }}</span><h1>{{ t('nav.settings') }}</h1>
    <div class="ls-card form">
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
const stateKey=ref(old?'settings.connected':'settings.notConnected')
function save(){ saveBootstrap({apiBase:'/gugu-api'});stateKey.value='settings.saved' }
</script>
<style scoped>
.settings{max-width:720px;padding:42px}.eyebrow{font-size:9px;letter-spacing:.12em;color:var(--content-tertiary)}h1{margin:4px 0 22px}.form{padding:18px;display:grid;gap:15px}.actions{display:flex;align-items:center;gap:10px;font-size:10px;color:var(--content-tertiary)}.note{font-size:11px;line-height:1.7;color:var(--content-secondary)}
</style>
