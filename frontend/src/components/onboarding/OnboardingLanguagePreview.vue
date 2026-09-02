<template>
  <div class="language-preview">
    <OnboardingThemePreview mode="calendar" class="workspace-preview" />

    <div class="language-preview-window">
      <section class="language-preview-chat">
        <header class="language-preview-toolbar">
          <strong class="language-preview-title">{{ t('onboardingUi.brand') }}</strong>
          <span class="toolbar-status"><i />{{ t('onboardingUi.connected') }}</span>
          <div class="language-preview-header-actions"><button type="button" aria-hidden="true"><Icon name="action.expand" size="xs" /></button><button type="button" aria-hidden="true"><Icon name="action.close" size="xs" /></button></div>
        </header>
        <div class="language-preview-body">
          <span class="language-preview-day-label">{{ t('onboardingUi.demo.calendar') }}</span>
          <div class="language-preview-message-row"><div class="language-preview-message gugu-message">{{ t('onboardingUi.demo.locale.description') }}<strong>{{ t('onboardingUi.demo.locale.title') }}</strong></div><small>20:44</small></div>
          <div class="language-preview-message-row user-row"><div class="language-preview-message user-message">{{ t('onboardingUi.demo.locale.title') }}</div><small>20:45</small></div>
          <div class="language-preview-message-row"><div class="language-preview-message gugu-message">{{ t('onboardingUi.demo.locale.description') }}<div class="language-preview-tool-result"><span>✓</span><strong>{{ t('onboardingUi.demo.calendar') }}</strong></div></div><small>20:46</small></div>
        </div>
        <div class="language-preview-composer"><button type="button" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 7l-5.5 5.5a2.5 2.5 0 0 1-3.5-3.5L9 3.5a1.5 1.5 0 0 1 2 2L5.5 11" /></svg></button><button type="button" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="1.5" width="4" height="8" rx="2" /><path d="M3.5 7a4.5 4.5 0 0 0 9 0M8 11.5V14M5.5 14h5" /></svg></button><span>{{ t('onboardingUi.demo.locale.description') }}</span><button class="send" type="button" aria-hidden="true"><Icon name="action.next" size="xs" /></button></div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/icons/Icon.vue'
import OnboardingThemePreview from '@/components/onboarding/OnboardingThemePreview.vue'

const { t } = useI18n()
</script>

<style scoped>
.language-preview { position: relative; width: 100%; height: 100%; padding: 22px 46px 54px; box-sizing: border-box; -webkit-mask-image: linear-gradient(to bottom, #000 0%, #000 58%, transparent 100%); mask-image: linear-gradient(to bottom, #000 0%, #000 58%, transparent 100%); }
.workspace-preview { position: absolute; top: 22px; right: 46px; left: 46px; width: auto; height: 100%; box-sizing: border-box; }
.language-preview-window { position: absolute; z-index: 2; right: 18px; bottom: 12px; width: min(360px, calc(100% - 36px)); height: min(360px, calc(100% - 44px)); display: flex; overflow: hidden; border: 1px solid var(--gugu-chat-border, var(--glass-card-border)); border-radius: var(--gugu-chat-radius, 20px); background: var(--gugu-chat-bg, var(--panel-bg)); box-shadow: var(--gugu-chat-shadow, var(--elevation-window)); backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur); }
.language-preview-sidebar { position: relative; display: flex; flex: 0 0 154px; flex-direction: column; gap: 5px; padding: 18px 12px 14px; border-right: 1px solid var(--panel-divider); background: var(--surface-soft); }
.language-preview-brand { display: flex; align-items: center; gap: 7px; margin: 0 5px 18px; color: var(--content-primary); font-size: 12px; font-weight: 700; }
.brand-mark, .user-avatar, .gugu-avatar { display: inline-grid; place-items: center; border-radius: 9px; color: var(--content-on-accent); background: var(--action-primary); font-weight: 700; }
.brand-mark { width: 22px; height: 22px; font-size: 11px; }
.language-preview-nav-label { margin: 0 5px 5px; color: var(--content-tertiary); font-size: 9px; letter-spacing: .04em; text-transform: uppercase; }
.language-preview-nav-item { display: flex; align-items: center; gap: 8px; min-height: 27px; padding: 0 8px; border-radius: var(--control-radius); color: var(--content-secondary); font-size: 10px; }
.language-preview-nav-item.active { color: var(--action-primary); background: var(--action-soft); font-weight: 600; }
.language-preview-user { display: flex; align-items: center; gap: 7px; margin-top: auto; padding: 8px 5px 0; border-top: 1px solid var(--panel-divider); color: var(--content-tertiary); font-size: 9px; }
.user-avatar { width: 20px; height: 20px; border-radius: 50%; font-size: 9px; background: var(--control-bg-active); color: var(--action-primary); }
.language-preview-chat { display: flex; min-width: 0; flex: 1; flex-direction: column; background: var(--panel-bg); }
.language-preview-toolbar { display: flex; align-items: center; gap: var(--space-sm); padding: 18px 20px 14px; border-bottom: 1px solid var(--panel-divider); }
.language-preview-toolbar > div { display: grid; gap: 3px; min-width: 0; }
.toolbar-kicker { color: var(--content-tertiary); font-size: 9px; }
.language-preview-toolbar strong { overflow: hidden; color: var(--content-primary); font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.toolbar-status { display: inline-flex; align-items: center; gap: 5px; color: var(--status-success); font-size: 9px; }
.toolbar-status i { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.language-preview-body { display: flex; flex: 1; flex-direction: column; gap: 12px; padding: 20px; background: linear-gradient(180deg, var(--panel-bg), var(--surface-soft)); }
.language-preview-welcome { display: flex; align-items: center; gap: 9px; margin-bottom: auto; }
.gugu-avatar { width: 27px; height: 27px; flex: 0 0 27px; border-radius: 9px; font-size: 11px; }
.language-preview-welcome div { display: grid; gap: 3px; min-width: 0; }
.language-preview-welcome strong { color: var(--content-primary); font-size: 11px; }
.language-preview-welcome small { color: var(--content-tertiary); font-size: 9px; }
.language-preview-message { max-width: 78%; padding: 8px 10px; border-radius: 10px; color: var(--content-secondary); font-size: 10px; line-height: 1.45; }
.user-message { align-self: flex-end; color: var(--content-on-accent); background: var(--action-primary); }
.gugu-message { border: 1px solid var(--workspace-card-border); background: var(--workspace-card-bg); }
.language-preview-composer { display: flex; align-items: center; gap: 8px; margin: 0 16px 16px; padding: 8px 8px 8px 11px; border: 1px solid var(--control-border); border-radius: var(--control-radius); background: var(--control-bg); color: var(--content-tertiary); font-size: 9px; }
.language-preview-composer span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.language-preview-composer button { display: inline-grid; place-items: center; width: 21px; height: 21px; border: 0; border-radius: 7px; color: var(--content-on-accent); background: var(--action-primary); }
.language-preview-sidebar { flex-basis: 150px; background: var(--gugu-chat-sidebar-bg, var(--surface-soft)); border-right-color: var(--gugu-chat-sidebar-border, var(--panel-divider)); }
.language-preview-sidebar-divider { height: 1px; margin: 0 10px; background: var(--gugu-chat-header-border, var(--panel-divider)); }
.language-preview-session-list { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 3px; padding: 12px 8px; overflow: hidden; }
.language-preview-caption { padding: 3px 6px; color: var(--gugu-chat-caption, var(--content-tertiary)); font-size: 8px; font-weight: 600; letter-spacing: .04em; }
.language-preview-im-head { display: flex; align-items: center; gap: 5px; min-height: 25px; padding: 0 6px; border-radius: var(--radius-sm); color: var(--content-secondary); font-size: 9px; }
.language-preview-im-head strong { flex: 1; font-size: 9px; font-weight: 600; }
.language-preview-im-head span { color: var(--status-success); font-size: 7px; }
.language-preview-im-head:nth-of-type(5) span { color: var(--content-tertiary); }
.language-preview-im-head.active { color: var(--content-primary); background: var(--surface-soft); }
.language-preview-session { display: flex; align-items: center; gap: 5px; min-height: 29px; padding: 4px 6px; border: 1px solid transparent; border-radius: var(--radius-sm); color: var(--content-secondary); }
.language-preview-session.selected { color: var(--gugu-chat-session-active-fg, var(--content-primary)); background: var(--gugu-chat-session-active, var(--action-soft)); border-color: var(--sidebar-item-active-border); }
.language-preview-session span:last-child, .language-preview-session > span:not(.session-tag) { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 2px; }
.language-preview-session strong { overflow: hidden; font-size: 9px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.language-preview-session small { color: var(--content-tertiary); font-size: 7px; }
.session-tag { padding: 2px 4px; border-radius: var(--radius-xs); color: var(--selection-fg); background: var(--selection-bg); font-size: 7px; }
.language-preview-new-chat { display: flex; align-items: center; justify-content: center; gap: 4px; min-height: 34px; margin: 7px 8px; border: 1px solid var(--border-default); border-radius: var(--radius-sm); color: var(--action-primary); background: color-mix(in srgb, var(--surface-raised) 84%, transparent); font: 600 9px var(--font-sans); }
.language-preview-chat { background: var(--gugu-chat-main-bg, var(--panel-bg)); }
.language-preview-toolbar { min-height: 42px; padding: 0 14px; border-bottom-color: var(--gugu-chat-header-border, var(--panel-divider)); background: transparent; }
.language-preview-toolbar > .language-preview-title { font-size: 11px; }
.toolbar-status { margin-left: auto; }
.language-preview-toolbar > .language-preview-header-actions { display: flex; flex-shrink: 0; gap: var(--space-xs); margin-left: 0; }
.language-preview-header-actions button, .language-preview-composer > button:not(.send) { display: grid; place-items: center; width: 28px; height: 28px; border: 0; border-radius: var(--radius-sm); color: var(--content-secondary); background: transparent; }
.language-preview-header-actions button:hover, .language-preview-composer > button:not(.send):hover { background: var(--surface-soft-hover); }
.language-preview-body { gap: 10px; padding: 14px; background: var(--gugu-chat-main-bg, var(--panel-bg)); }
.language-preview-day-label { align-self: center; color: var(--content-tertiary); font-size: 8px; }
.language-preview-message-row { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; }
.language-preview-message-row.user-row { align-items: flex-end; }
.language-preview-message-row > small { padding: 0 4px; color: var(--content-tertiary); font-size: 7px; }
.language-preview-message { max-width: 82%; padding: 7px 9px; border-radius: var(--radius-md); font-size: 9px; line-height: 1.45; }
.language-preview-message strong { display: block; margin-top: 3px; }
.gugu-message { border-bottom-left-radius: var(--radius-xs); background: var(--gugu-chat-assistant-bg, var(--surface-soft)); box-shadow: var(--elevation-card); }
.user-message { border-bottom-right-radius: var(--radius-xs); background: var(--gugu-chat-user-bg, var(--action-primary-bg)); }
.language-preview-tool-result { display: flex; align-items: center; gap: 5px; margin-top: 6px; padding: 5px; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); background: var(--surface-soft); color: var(--content-secondary); }
.language-preview-tool-result span { color: var(--status-success); }
.language-preview-tool-result strong { margin: 0; font-size: 8px; }
.language-preview-composer { min-height: 38px; margin: 0; padding: 7px 9px; border: 0; border-top: 1px solid var(--gugu-chat-header-border, var(--panel-divider)); border-radius: 0; background: var(--gugu-chat-composer-bg, var(--surface-soft)); box-shadow: inset 0 1px 0 var(--border-highlight); }
.language-preview-composer .send { margin-left: auto; }
.language-preview-composer svg { width: 16px; height: 16px; }
@media (max-width: 720px) { .language-preview { min-width: 660px; padding: 18px 16px 44px; transform: scale(.72); transform-origin: top left; width: 138%; height: 138%; } }
</style>
