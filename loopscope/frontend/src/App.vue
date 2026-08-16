<template>
  <div class="shell">
    <aside class="rail">
      <div class="brand">
        <div class="brand-mark">LS</div>
        <div><strong>LoopScope</strong><small>AgentLoop dev tool</small></div>
      </div>
      <nav class="nav">
        <RouterLink to="/">Conversation</RouterLink>
        <RouterLink to="/tokens">Design Tokens</RouterLink>
        <RouterLink to="/changelog">Changelog</RouterLink>
        <RouterLink to="/settings">Settings</RouterLink>
      </nav>
      <div class="rail-foot">
        <span class="dot" :class="{ on: connected }"></span>
        {{ connected ? 'Gugu connected' : 'Gugu not connected' }}
      </div>
    </aside>
    <main class="page"><RouterView /></main>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { loadBootstrap } from './services/gugu'
const connected = ref(!!loadBootstrap())
const update = () => connected.value = !!loadBootstrap()
onMounted(() => window.addEventListener('loopscope:bootstrap', update))
onUnmounted(() => window.removeEventListener('loopscope:bootstrap', update))
</script>

<style scoped>
.shell { display:grid; grid-template-columns: 190px minmax(0,1fr); min-height:100vh; }
.rail { position:sticky; top:0; height:100vh; padding:18px 14px; border-right:1px solid var(--border-subtle); background:rgba(247,245,248,.78); backdrop-filter:blur(22px); display:flex; flex-direction:column; gap:22px; }
.brand { display:flex; gap:10px; align-items:center; }
.brand-mark { width:34px; height:34px; display:grid; place-items:center; border-radius:11px; background:var(--action-primary); color:white; font-weight:700; font-size:12px; }
.brand small { display:block; color:var(--content-tertiary); font-size:10px; margin-top:2px; }
.nav { display:grid; gap:5px; }
.nav a { text-decoration:none; padding:9px 10px; border-radius:10px; color:var(--content-secondary); font-size:13px; }
.nav a.router-link-active { background:var(--action-soft); color:var(--action-primary); font-weight:600; }
.rail-foot { margin-top:auto; color:var(--content-tertiary); font-size:11px; display:flex; align-items:center; gap:7px; }
.dot { width:7px; height:7px; border-radius:50%; background:var(--status-danger); }
.dot.on { background:var(--status-success); }
.page { min-width:0; min-height:100vh; }
@media (max-width: 760px) { .shell { grid-template-columns:1fr; } .rail { position:static; height:auto; flex-direction:row; align-items:center; overflow:auto; } .nav { display:flex; } .rail-foot{display:none;} }
</style>
