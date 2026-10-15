<template>
  <div class="settings">
    <span class="eyebrow">CONNECTION</span><h1>Settings</h1>
    <div class="ls-card form">
      <label>Gugu API base<input v-model="apiBase" placeholder="http://127.0.0.1:5173/api/v1" /></label>
      <div class="actions"><button class="ls-button primary" @click="save">Save for this tab</button><span>{{ state }}</span></div>
    </div>
    <p class="note">推荐从 Gugu <code>/dev</code> 点击进入。LoopScope 使用同站 HttpOnly Cookie 访问会话，不接收或保存登录 Token。</p>
  </div>
</template>
<script setup lang="ts">
import { ref } from 'vue'
import { loadBootstrap, saveBootstrap } from '../services/gugu'
const old=loadBootstrap()
const apiBase=ref(old?.apiBase ?? 'http://127.0.0.1:5173/api/v1')
const state=ref(old?'Connected':'Not connected')
function save(){ saveBootstrap({apiBase:apiBase.value});state.value='Saved in sessionStorage' }
</script>
<style scoped>
.settings{max-width:720px;padding:42px}.eyebrow{font-size:9px;letter-spacing:.12em;color:var(--content-tertiary)}h1{margin:4px 0 22px}.form{padding:18px;display:grid;gap:15px}label{display:grid;gap:6px;font-size:10px;color:var(--content-secondary)}input{height:38px;border:1px solid var(--border-subtle);border-radius:var(--radius-sm);background:var(--surface-raised);padding:0 10px}.actions{display:flex;align-items:center;gap:10px;font-size:10px;color:var(--content-tertiary)}.note{font-size:11px;line-height:1.7;color:var(--content-secondary)}
</style>
