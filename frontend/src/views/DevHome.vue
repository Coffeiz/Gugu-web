<template>
  <div class="dev-home glass-card">
    <section class="tool-grid">
      <article v-for="tool in devToolRegistry" :key="tool.path ?? tool.href" class="tool-card glass-card">
        <span class="tool-eyebrow">{{ t(tool.eyebrowKey ?? 'devHome.tool') }}</span>
        <div class="tool-row">
          <div>
            <h2>{{ t(tool.labelKey) }}</h2>
            <p>{{ t(tool.descriptionKey) }}</p>
          </div>
          <button v-if="tool.external" class="tool-open" @click="openExternal(tool)"><Icon name="action.next" :size="16" /></button>
          <router-link v-else-if="tool.path" class="tool-open" :to="tool.path"><Icon name="action.next" :size="16" /></router-link>
        </div>
        <div class="tool-footer">
          <code>{{ tool.external ? tool.href : tool.path }}</code>
          <span>{{ t(tool.external ? 'devHome.standalone' : 'devHome.guguDev') }}</span>
        </div>
      </article>
    </section>

    <p class="dev-note">{{ t('devHome.note') }}</p>
  </div>
</template>

<script setup lang="ts">
import { devToolRegistry, type DevToolEntry } from './devRegistry'
import Icon from '@/components/common/icons/Icon.vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

function absoluteApiBase() {
  // 让 LoopScope 通过自己的 Vite 代理访问 Gugu，避免 4319 -> 5173/8000 的跨源 CORS。
  const loopScopeUrl = new URL(toolHref())
  return new URL('/gugu-api', loopScopeUrl).toString().replace(/\/$/, '')
}

function toolHref() {
  const configured = import.meta.env.VITE_LOOPSCOPE_URL
  return configured || `${window.location.protocol}//${window.location.hostname}:4319`
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
  --dev-divider: color-mix(in srgb, var(--content-secondary) 22%, transparent);
  --glass-card-background: var(--column-bg);
  --glass-card-background-hover: var(--column-bg);
  --glass-card-border: var(--border-default);
  --glass-card-border-hover: var(--border-default);
  --glass-card-shadow: var(--elevation-card);
  --glass-card-shadow-hover: var(--elevation-card-hover);
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 22px 24px;
  color: var(--content-primary);
  box-sizing: border-box;
}
.tool-eyebrow {
  font-size: var(--font-size-xs);
  letter-spacing: var(--tracking-label);
  color: var(--content-tertiary);
  font-weight: var(--font-weight-semibold);
}
.tool-card p, .dev-note {
  margin: 0;
  color: var(--content-secondary);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-body);
}
.tool-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-md);
  margin-top: 0;
}
.tool-card {
  min-height: 176px;
  padding: var(--space-lg);
  --glass-card-background: var(--surface-glass);
  --glass-card-background-hover: var(--surface-glass-hover);
  --glass-card-border: var(--dev-divider);
  --glass-card-border-hover: var(--border-default);
  --glass-card-shadow: var(--elevation-card);
  --glass-card-shadow-hover: var(--elevation-card-hover);
  border-radius: var(--radius-md);
  transition: var(--card-motion), background var(--glass-card-transition);
}
.tool-card:hover {
  transform: translateY(-2px);
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
  cursor: pointer;
  transition: background var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard), transform var(--motion-hover-control) var(--motion-ease-standard);
}
.tool-open:hover { background: var(--action-soft-hover); border-color: var(--action-outline); transform: translateY(-1px); }
.tool-open:active { transform: translateY(1px); }
.tool-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  margin-top: var(--space-lg);
  padding-top: var(--space-md);
  border-top: 1px solid var(--dev-divider);
  color: var(--content-tertiary);
  font-size: var(--font-size-xs);
}
.tool-footer code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dev-note { margin-top: var(--space-lg); }
@media (max-width: 720px) {
  .dev-home { padding: var(--space-lg); }
  .tool-grid { grid-template-columns: 1fr; }
}
</style>
