<template>
  <div class="nf-page">
    <div class="bg-glow glow-1" />
    <div class="bg-glow glow-2" />

    <div class="nf-card">
      <div class="nf-brand">
        <div class="brand-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M16 7h.01"/>
            <path d="M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20"/>
            <path d="M20 7l2 .5-2 .5"/>
            <path d="M10 18v3"/>
            <path d="M14 17.75V21"/>
            <path d="M7 18a6 6 0 0 0 3.84-10.61"/>
          </svg>
        </div>
        <span class="brand-name">咕咕</span>
      </div>

      <div class="nf-code">404</div>
      <div class="nf-title">咕？这页面飞走了</div>
      <p class="nf-desc">你要找的页面不存在，或者已经被咕咕叼走了。<br>检查下网址，或者回首页重新出发。</p>

      <div class="nf-actions">
        <button class="btn-primary" @click="goHome">回到首页</button>
        <button class="btn-ghost" @click="goBack">返回上一页</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router'

const router = useRouter()
const goHome = () => router.push('/')
const goBack = () => (window.history.length > 1 ? router.back() : router.push('/'))
</script>

<style scoped>
.nf-page {
  min-height: 100vh;
  background: var(--bg-gradient, linear-gradient(160deg, #e8e9ee 0%, #d8dae4 35%, #bfc4d2 65%, #9aa2b8 100%));
  display: flex; align-items: center; justify-content: center;
  font-family: var(--font-sans); position: relative; overflow: hidden;
}

.bg-glow { position: absolute; border-radius: 50%; pointer-events: none; filter: blur(80px); }
.glow-1 {
  width: 500px; height: 500px; top: -120px; left: -100px;
  background: radial-gradient(circle, rgba(123,127,178,0.18) 0%, transparent 65%);
}
.glow-2 {
  width: 380px; height: 380px; bottom: -100px; right: -80px;
  background: radial-gradient(circle, rgba(196,175,200,0.14) 0%, transparent 65%);
}

.nf-card {
  width: 420px; max-width: calc(100vw - 40px); position: relative; z-index: 1;
  text-align: center;
  background: rgba(255,255,255,0.56);
  backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
  border: 1px solid rgba(255,255,255,0.76);
  border-radius: 20px; padding: 40px 36px;
  box-shadow:
    0 20px 60px rgba(80,90,110,0.12),
    inset 0 1px 0 rgba(255,255,255,0.95),
    inset 1px 0 0 rgba(255,255,255,0.55);
}

.nf-brand { display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 22px; }
.brand-icon {
  width: 40px; height: 40px; border-radius: 12px; flex-shrink: 0;
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 6px 18px rgba(123,127,178,0.35);
}
.brand-name { font-size: 17px; font-weight: 700; color: #1e2028; }

.nf-code {
  font-size: 84px; font-weight: 800; line-height: 1; letter-spacing: 0.02em;
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
  margin-bottom: 14px;
}
.nf-title { font-size: 19px; font-weight: 700; color: #1e2028; margin-bottom: 10px; }
.nf-desc { font-size: 13.5px; line-height: 1.7; color: #8a8fa8; margin: 0 0 26px; }

.nf-actions { display: flex; gap: 10px; justify-content: center; }
.btn-primary {
  padding: 10px 22px;
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
  border: none; border-radius: 11px;
  font-size: 14px; font-weight: 600; color: white;
  cursor: pointer; transition: opacity 0.15s, transform 0.15s;
  box-shadow: 0 4px 16px rgba(123,127,178,0.32);
}
.btn-primary:hover { opacity: 0.88; transform: translateY(-1px); }
.btn-ghost {
  padding: 10px 22px;
  background: rgba(255,255,255,0.6); border: 1px solid rgba(255,255,255,0.76);
  border-radius: 11px; font-size: 14px; font-weight: 600; color: #6b7088;
  cursor: pointer; transition: background 0.15s, transform 0.15s;
}
.btn-ghost:hover { background: rgba(255,255,255,0.85); transform: translateY(-1px); }
</style>
