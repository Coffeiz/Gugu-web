<template>
  <div class="dev-home">
    <header class="dev-header">
      <div>
        <span class="dev-kicker">GUGU / DEVELOPMENT</span>
        <h1>Dev 工具</h1>
        <p>只在本地开发构建注册。工具入口使用当前设计令牌，不进入生产路由。</p>
      </div>
      <span class="dev-badge">DEV</span>
    </header>

    <section class="tool-grid">
      <article v-for="tool in devToolRegistry" :key="tool.path ?? tool.href" class="tool-card">
        <span class="tool-eyebrow">{{ tool.eyebrow ?? 'TOOL' }}</span>
        <div class="tool-row">
          <div>
            <h2>{{ tool.label }}</h2>
            <p>{{ tool.description }}</p>
          </div>
          <button v-if="tool.external" class="tool-open" @click="openExternal(tool)">↗</button>
          <router-link v-else-if="tool.path" class="tool-open" :to="tool.path">→</router-link>
        </div>
        <div class="tool-footer">
          <code>{{ tool.external ? tool.href : tool.path }}</code>
          <span>{{ tool.external ? 'Standalone' : 'Gugu Dev' }}</span>
        </div>
      </article>
    </section>

    <p class="dev-note">LoopScope 是独立应用。这里仅负责启动并通过 postMessage 传递当前开发会话连接信息。</p>
  </div>
</template>

<script setup lang="ts">
import { devToolRegistry, type DevToolEntry } from './devRegistry'

function absoluteApiBase() {
  // /dev 仅存在于 Vite 开发环境；始终借当前 Gugu dev origin 的 /api 代理，
  // 避免 LoopScope:4319 直接跨域命中 backend:8000 时额外要求后端开放 CORS。
  return new URL('/api/v1', window.location.origin).toString().replace(/\/$/, '')
}

function openExternal(tool: DevToolEntry) {
  if (!tool.href) return
  const target = window.open(tool.href, '_blank')
  if (!target) return
  const expectedOrigin = new URL(tool.href).origin
  const token = localStorage.getItem('user_token') ?? ''
  let timer: number | undefined

  const onMessage = (event: MessageEvent) => {
    if (event.source !== target || event.origin !== expectedOrigin) return
    if (event.data?.type !== 'loopscope:ready') return
    target.postMessage({
      type: 'loopscope:gugu-bootstrap',
      apiBase: absoluteApiBase(),
      token,
    }, expectedOrigin)
    window.removeEventListener('message', onMessage)
    if (timer !== undefined) window.clearInterval(timer)
  }
  window.addEventListener('message', onMessage)

  // ready 可能在 opener listener 建立前到达；短暂重复 ping 只传给精确 origin。
  let tries = 0
  timer = window.setInterval(() => {
    tries += 1
    if (target.closed || tries > 20) {
      if (timer !== undefined) window.clearInterval(timer)
      window.removeEventListener('message', onMessage)
      return
    }
    target.postMessage({ type: 'gugu:loopscope-bootstrap-request' }, expectedOrigin)
  }, 150)
}
</script>

<style scoped>
.dev-home {
  width: min(980px, calc(100% - var(--space-xl) * 2));
  margin: 0 auto;
  padding: calc(var(--space-xl) * 2) 0;
  color: var(--content-primary);
}
.dev-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-xl);
  padding-bottom: var(--space-xl);
  border-bottom: 1px solid var(--border-subtle);
}
.dev-kicker, .tool-eyebrow {
  font-size: var(--font-size-xs);
  letter-spacing: var(--tracking-label);
  color: var(--content-tertiary);
  font-weight: var(--font-weight-semibold);
}
.dev-header h1 {
  margin: var(--space-xs) 0 var(--space-sm);
  font-size: var(--font-size-xl);
  line-height: var(--line-height-tight);
}
.dev-header p, .tool-card p, .dev-note {
  margin: 0;
  color: var(--content-secondary);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-body);
}
.dev-header p { max-width: 580px; }
.dev-badge {
  padding: var(--space-xs) var(--space-sm);
  border-radius: var(--radius-pill);
  background: var(--status-warning-bg);
  color: var(--status-warning);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
}
.tool-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-md);
  margin-top: var(--space-xl);
}
.tool-card {
  min-height: 176px;
  padding: var(--space-lg);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--surface-card);
  box-shadow: var(--elevation-card);
  transition: transform .18s var(--motion-ease-standard), box-shadow .18s var(--motion-ease-standard), border-color .18s var(--motion-ease-standard);
}
.tool-card:hover {
  transform: translateY(-2px);
  border-color: var(--border-default);
  box-shadow: var(--elevation-card-hover);
}
.tool-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-md);
  align-items: start;
  margin-top: var(--space-sm);
}
.tool-card h2 { margin: 0 0 var(--space-sm); font-size: var(--font-size-lg); }
.tool-open {
  width: var(--control-height-md);
  height: var(--control-height-md);
  display: grid;
  place-items: center;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--surface-raised);
  color: var(--action-primary);
  text-decoration: none;
  font-size: var(--font-size-lg);
  cursor: pointer;
}
.tool-open:hover { background: var(--action-soft); border-color: var(--action-outline); }
.tool-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  margin-top: var(--space-lg);
  padding-top: var(--space-md);
  border-top: 1px solid var(--border-hairline);
  color: var(--content-tertiary);
  font-size: var(--font-size-xs);
}
.tool-footer code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dev-note { margin-top: var(--space-lg); }
@media (max-width: 720px) {
  .tool-grid { grid-template-columns: 1fr; }
}
</style>
