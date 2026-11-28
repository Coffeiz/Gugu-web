<template>
  <BaseModal :show="show" width="900px" height="600px" @close="$emit('close')">
    <div class="pm-layout">
      <div class="pm-nav panel-left">
        <div v-if="desktop" class="pm-user-block">
          <div class="pm-avatar avatar--fallback" aria-hidden="true"><Icon name="user.default" size="lg" /></div>
          <div class="pm-user-info"><div class="pm-name">{{ t('navigation.localUser') }}</div></div>
        </div>
        <div v-else class="pm-user-block">
          <div class="pm-avatar" :class="{ uploading: avatarUploading, 'avatar--fallback': !authStore.user?.avatarUrl }" @click="triggerAvatarUpload" :title="t('sharedUi.changeAvatar')">
            <img v-if="authStore.user?.avatarUrl" :src="authStore.user.avatarUrl" class="pm-avatar-img" />
            <template v-else>{{ initial }}</template>
            <div class="pm-avatar-overlay">
              <span v-if="avatarUploading" class="pm-avatar-spin"></span>
              <Icon v-else name="user.camera" size="sm" tone="inherit" />
            </div>
          </div>
          <input ref="avatarInput" type="file" accept="image/*" style="display:none" @change="onAvatarFile" />
          <div class="pm-user-info">
            <div class="pm-name">{{ authStore.user?.displayName || '—' }}</div>
            <div class="pm-email">{{ authStore.user?.email ?? '' }}</div>
          </div>
        </div>

        <div class="pm-nav-divider"></div>
        <template v-for="item in navItems" :key="item.key">
          <div v-if="item.divider" class="pm-nav-divider"></div>
          <button v-else class="pm-nav-item" :class="{ active: activeNav === item.key }" @click="item.key && (activeNav = item.key)">
            <Icon :name="item.icon || ''" size="sm" tone="inherit" />
            {{ navLabel(item) }}
          </button>
        </template>
        <div class="pm-nav-spacer"></div>
        <button v-if="!desktop" class="pm-logout pm-danger-nav" @click="openDeleteAccount">
          <Icon name="user.remove" size="sm" tone="inherit" />
          <span>{{ t('sharedUi.deleteAccount') }}</span>
        </button>
      </div>

      <div class="pm-content">
        <div class="pm-content-header card-close-anchor">
          <span class="pm-content-title">{{ currentNavLabel }}</span>
          <CloseButton card-corner :title="t('common.actions.close')" @click="$emit('close')" />
        </div>
        <div class="pm-content-body" ref="pmBodyRef">
          <slot v-if="desktop && activeNav === 'byok' && $slots['desktop-model']" name="desktop-model" />
          <slot v-else-if="desktop && activeNav === 'workspaces' && $slots['desktop-workspaces']" name="desktop-workspaces" />
          <slot v-else-if="desktop && activeNav === 'logs'" name="desktop-logs" />
          <template v-else>
            <div :inert="desktop && activeNav !== 'prefs' && activeNav !== 'im' && activeNav !== 'gugu' && activeNav !== 'tools' && activeNav !== 'data'">
              <KeepAlive>
                <ProfileInfoPane v-if="activeNav === 'info'" :external-message="infoMsg" :external-message-type="infoMsgType" />
                <ProfileAccountPane v-else-if="activeNav === 'account'" />
                <ProfileGuguPane v-else-if="activeNav === 'gugu'" />
                <ProfileByokPane v-else-if="activeNav === 'byok'" />
                <ProfileToolPermissionsPane v-else-if="activeNav === 'tools'" />
                <ProfileWorkspacesPane v-else-if="activeNav === 'workspaces'" />
                <ProfileDataPortabilityPane v-else-if="activeNav === 'data'" :refresh-imported-data="refreshImportedData" />
                <ProfileImPane v-else-if="activeNav === 'im'" :connect-telegram="connectTelegram" :desktop-im-adapter="desktopImAdapter">
                  <template #telegram-status="status"><slot name="telegram-status" v-bind="status" /></template>
                  <template #connection-notice><slot name="im-notice" /></template>
                </ProfileImPane>
                <ProfilePreferencesPane v-else-if="activeNav === 'prefs'">
                  <template #desktop-file-settings><slot name="desktop-file-settings" /></template>
                </ProfilePreferencesPane>
              </KeepAlive>
            </div>
            <template v-if="activeNav === 'info'">
              <div class="pm-sep" aria-hidden="true" />
              <slot name="device-info"><ProfileDevicePane v-if="!desktop" /></slot>
            </template>
            <template v-if="desktop && activeNav === 'info'">
              <slot name="local-status" />
              <slot name="remote" />
            </template>
          </template>
        </div>
      </div>
    </div>
  </BaseModal>

  <Teleport v-if="!desktop" to="body">
    <Transition name="pm-confirm">
    <div v-if="showDeleteAccount" class="pm-confirm-overlay modal-backdrop" :style="{ zIndex: TOP_Z }" @click.self="closeDeleteAccount">
      <div class="pm-confirm-box">
        <p class="pm-confirm-title">{{ t('sharedUi.confirmDeleteAccount') }}</p>
        <p class="pm-confirm-desc">{{ t('sharedUi.deleteAccountDescription') }}</p>
        <input v-model="deletePwd" type="password" class="form-input pm-confirm-input" :placeholder="t('sharedUi.passwordConfirmation')" @keyup.enter="doDeleteAccount" />
        <p v-if="deleteErr" class="pm-msg err">{{ deleteErr }}</p>
        <div class="pm-confirm-actions app-card-actions">
          <button class="btn-cancel" @click="closeDeleteAccount">{{ t('common.actions.cancel') }}</button>
          <button class="pm-danger-btn" :disabled="!deletePwd || deleting" @click="doDeleteAccount">{{ deleting ? t('sharedUi.deleting') : t('sharedUi.confirmDelete') }}</button>
        </div>
      </div>
    </div>
    </Transition>
  </Teleport>

  <AvatarCropper v-if="!desktop" :show="cropperShow" :file="cropFile" @close="closeCropper" @crop="onCropped" />
</template>

<script setup lang="ts">
import { computed, provide, ref, watch, type PropType } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import BaseModal from '@/components/common/overlays/BaseModal.vue'
import CloseButton from '@/components/common/overlays/CloseButton.vue'
import AvatarCropper from '@/components/common/profile/AvatarCropper.vue'
import { desktopProfileKey } from './desktopProfile'
import ProfileInfoPane from './ProfileInfoPane.vue'
import ProfileDevicePane from './ProfileDevicePane.vue'
import ProfileAccountPane from './ProfileAccountPane.vue'
import ProfilePreferencesPane from './ProfilePreferencesPane.vue'
import ProfileGuguPane from './ProfileGuguPane.vue'
import ProfileImPane from '@/im/connect/ImConnectPane.vue'
import ProfileToolPermissionsPane from './ProfileToolPermissionsPane.vue'
import ProfileWorkspacesPane from './ProfileWorkspacesPane.vue'
import ProfileByokPane from './ProfileByokPane.vue'
import ProfileDataPortabilityPane from './ProfileDataPortabilityPane.vue'
import { authApi } from '@/api/auth'
import { TOP_Z } from '@/composables/core/windowz'
import Icon from '@/components/common/icons/Icon.vue'
import { useI18n } from 'vue-i18n'
import type { DesktopImSettingsAdapter } from '@/im/connect/desktopAdapter'

const props = defineProps({ show: Boolean, desktop: Boolean, desktopImAdapter: Object as PropType<DesktopImSettingsAdapter>, connectTelegram: Function as PropType<(token: string) => Promise<void>>, initialNav: { type: String, default: 'info' }, refreshImportedData: Function as PropType<() => void> })
provide(desktopProfileKey, props.desktop)
const emit  = defineEmits(['close'])
const router = useRouter()
const authStore = useAuthStore()
const { t } = useI18n()
const displayLabel = computed(() => authStore.user?.displayName || authStore.user?.username || '—')
const initial = computed<string>(() => (displayLabel.value.charAt(0) || '?').toUpperCase())

type ProfileNavItem = { key?: string; label?: string; icon?: string; divider?: boolean }
const webNavItems: ProfileNavItem[] = [
  { key: 'info', label: 'sharedUi.personalInfo', icon: 'user.default' },
  { key: 'account', label: 'sharedUi.accountSecurity', icon: 'user.security' },
  { key: 'prefs', label: 'desktopSettings.general', icon: 'user.settings' },
  { key: 'data', label: 'profileDataUi.nav', icon: 'user.data' },
  { divider: true },
  { key: 'gugu', label: 'sharedUi.guguSettings', icon: 'user.gugu' },
  { key: 'im', label: 'sharedUi.connectGugu', icon: 'communication.chat' },
  { key: 'byok', label: 'sharedUi.modelConfigNav', icon: 'user.security' },
  { key: 'tools', label: 'sharedUi.capabilityConfig', icon: 'admin.wrench' },
  { key: 'workspaces', label: 'filesUi.workEnvironment', icon: 'admin.folder' },
]
const navItems = computed(() => props.desktop
  ? [...webNavItems, { key: 'logs', label: 'desktopSettings.logs', icon: 'admin.wrench' }]
  : webNavItems)
const activeNav = ref(props.initialNav || 'info')
function navLabel(item?: ProfileNavItem) {
  return item?.label ? t(item.label) : ''
}
const currentNavLabel = computed(() => navLabel(navItems.value.find(n => !n.divider && n.key === activeNav.value)))
const infoMsg = ref('')
const infoMsgType = ref('ok')

watch(() => props.show, value => {
  if (value) {
    activeNav.value = props.initialNav || 'info'
    infoMsg.value = ''
    showDeleteAccount.value = false
    deletePwd.value = ''
    deleteErr.value = ''
  }
})

const avatarInput = ref<HTMLInputElement | null>(null)
const avatarUploading = ref(false)
const cropperShow = ref(false)
const cropFile = ref<File | null>(null)
function triggerAvatarUpload() {
  if (avatarUploading.value) return
  avatarInput.value?.click()
}
function onAvatarFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  cropFile.value = file
  cropperShow.value = true
}
function closeCropper() {
  cropperShow.value = false
  cropFile.value = null
}
async function onCropped(cropped: File) {
  cropperShow.value = false
  cropFile.value = null
  avatarUploading.value = true
  try {
    await authStore.uploadAvatar(cropped)
    infoMsg.value = '头像已更新'
    infoMsgType.value = 'ok'
  } catch (err) {
    infoMsg.value = (err as Error).message || '头像上传失败'
    infoMsgType.value = 'err'
    activeNav.value = 'info'
  } finally {
    avatarUploading.value = false
  }
}

const showDeleteAccount = ref(false)
const deletePwd = ref('')
const deleteErr = ref('')
const deleting = ref(false)
function openDeleteAccount() { showDeleteAccount.value = true }
function closeDeleteAccount() {
  showDeleteAccount.value = false
  deletePwd.value = ''
  deleteErr.value = ''
}
function _onDeleteAccountKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') closeDeleteAccount()
}
watch(showDeleteAccount, v => {
  if (v) document.addEventListener('keydown', _onDeleteAccountKeydown, true)
  else document.removeEventListener('keydown', _onDeleteAccountKeydown, true)
})
async function doDeleteAccount() {
  if (!deletePwd.value || deleting.value) return
  deleting.value = true
  deleteErr.value = ''
  try {
    await authApi.deleteAccount(deletePwd.value)
    authStore.logout()
    router.push('/login')
    emit('close')
  } catch (e) {
    deleteErr.value = (e instanceof Error ? e.message : '') || '注销失败'
  } finally {
    deleting.value = false
  }
}
</script>

<style src="./profile-layout.css"></style>

<style>
.pm-avatar-img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; }
.pm-avatar-overlay {
  position: absolute; inset: 0; border-radius: 50%; background: rgba(0,0,0,.38);
  display: flex; align-items: center; justify-content: center; color: white; opacity: 0;
  transition: opacity var(--motion-hover-control) var(--motion-ease-standard);
}
.pm-avatar:hover .pm-avatar-overlay,
.pm-avatar.uploading .pm-avatar-overlay { opacity: 1; }
.pm-avatar-spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid rgba(255,255,255,.3); border-top-color: #fff; animation: spin .7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.pm-confirm-overlay {
  position: fixed; inset: 0;
  display: flex; align-items: center; justify-content: center; padding: var(--space-xl);
}
.pm-confirm-box {
  width: 100%; max-width: 380px; --card-actions-inset: 22px; padding: var(--space-xl) var(--card-actions-inset) 0; display: flex; flex-direction: column; gap: var(--space-md);
  background: var(--modal-card-bg); backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--modal-card-border); border-radius: var(--card-radius);
  box-shadow: var(--modal-card-shadow), inset 0 1px 0 var(--modal-card-highlight);
}
.pm-confirm-enter-active { transition: background-color var(--modal-enter-duration) var(--modal-enter-easing), --modal-overlay-blur-radius var(--modal-enter-duration) var(--modal-enter-easing); }
.pm-confirm-enter-from { background-color: transparent; --modal-overlay-blur-radius: 0px; }
.pm-confirm-enter-active .pm-confirm-box { transition: backdrop-filter var(--modal-enter-duration) var(--modal-enter-easing), -webkit-backdrop-filter var(--modal-enter-duration) var(--modal-enter-easing); }
.pm-confirm-enter-from .pm-confirm-box { backdrop-filter: blur(0) !important; -webkit-backdrop-filter: blur(0) !important; }
.pm-confirm-leave-active { transition: opacity var(--modal-leave-duration) var(--modal-leave-easing); }
.pm-confirm-leave-to { opacity: 0; }
.pm-confirm-title { font-size: 15px; font-weight: 700; color: var(--content-primary); margin: 0; }
.pm-confirm-desc { font-size: 12.5px; line-height: 1.6; color: var(--content-secondary); margin: 0; }
.pm-confirm-desc strong { color: var(--status-danger); }
.pm-confirm-input { width: 100%; box-sizing: border-box; }
.pm-confirm-actions { display: flex; justify-content: flex-end; gap: var(--space-sm); margin-top: var(--space-xs); }
.btn-cancel {
  padding: var(--space-sm) var(--space-lg); border-radius: var(--radius-xs); border: 1px solid var(--control-border);
  background: var(--control-bg); color: var(--control-fg); font: 13px var(--font-sans); cursor: pointer;
  transition: color var(--motion-hover-control) var(--motion-ease-standard), background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard);
}
.btn-cancel:hover { background: var(--control-bg-hover); border-color: var(--control-border-hover); color: var(--control-fg-strong); }

.pm-tool-locked { padding: var(--space-md) var(--space-md); border: 1px solid var(--line-subtle); border-radius: 8px; background: var(--surface-subtle); }
.pm-coming { font-size: 11px; font-weight: 600; color: var(--content-disabled); background: var(--surface-soft); padding: var(--space-xs) var(--space-sm); border-radius: var(--radius-pill); }

.pm-style-group { display: flex; align-items: center; gap: var(--space-xs); flex-shrink: 0; }
.pm-style-chip {
  border-radius: var(--choice-chip-radius); border: 1px solid var(--choice-chip-border);
  background: var(--choice-chip-bg); color: var(--choice-chip-fg); font: 500 12px var(--font-sans); cursor: pointer;
  transition: color var(--motion-hover-control) var(--motion-ease-standard), background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard);
}
.pm-style-chip:hover { background: var(--choice-chip-bg-hover); border-color: var(--choice-chip-border-hover); color: var(--choice-chip-fg-hover); }
.pm-style-chip:disabled { opacity: .45; cursor: not-allowed; }
.pm-style-chip:disabled:hover { background: var(--choice-chip-bg); border-color: var(--choice-chip-border); color: var(--choice-chip-fg); }
.pm-style-chip.active { background: var(--choice-chip-bg-active); border-color: var(--choice-chip-border-active); color: var(--choice-chip-fg-active); font-weight: 600; }
.pm-family-chip.active { background: var(--surface-raised); border-color: var(--border-default); color: var(--content-primary); }
.pm-bind-btn {
  flex: 0 0 auto; white-space: nowrap;
  padding: var(--space-xs) var(--space-lg); border-radius: var(--radius-xs); border: none; background: var(--action-primary-bg); color: var(--content-on-accent);
  font: 600 12px var(--font-sans); cursor: pointer; box-shadow: var(--elevation-card);
  transition: opacity var(--motion-hover-control) var(--motion-ease-standard);
}
.pm-bind-btn:hover:not(:disabled) { opacity: .9; }
.pm-bind-btn:disabled { opacity: .4; cursor: default; }
.pm-bind-btn.off { background: var(--control-bg); color: var(--control-fg); border: 1px solid var(--control-border); box-shadow: none; }
.pm-qr-box { margin-top: var(--space-md); display: flex; flex-direction: column; align-items: center; gap: var(--space-sm); padding: var(--space-lg); background: var(--subpanel-bg); border: 1px solid var(--subpanel-border); border-radius: var(--radius-sm); }
.pm-qr-canvas { border-radius: var(--radius-xs); background: #fff; }
.pm-qr-hint { font-size: 12px; color: var(--content-secondary); text-align: center; }
.pm-qr-hint a { color: var(--action-primary); font-weight: 600; }

.pm-bot-item { margin-top: var(--space-sm); display: flex; flex-direction: column; gap: var(--space-sm); padding: var(--space-sm) var(--space-md); border-radius: var(--radius-xs); background: var(--subpanel-bg); border: 1px solid var(--subpanel-border); }
.pm-bot-item-top { display: flex; align-items: center; gap: var(--space-sm); }
.pm-bot-group-row { display: flex; align-items: center; gap: var(--space-sm); margin-top: var(--space-sm); padding-top: var(--space-sm); border-top: 1px solid var(--panel-divider); }
.pm-bot-item > .pm-bot-group-row { margin-top: 0; }
.pm-bot-group-row .pm-field-desc { flex: 1; min-width: 0; }
.pm-bot-tools-row { align-items: center; }
.pm-tool-options { justify-content: flex-end; flex-wrap: wrap; max-width: 58%; }
.pm-bot-info { flex: 1; display: flex; flex-direction: column; gap: var(--space-xs); min-width: 0; }
.pm-bot-name { font-size: 13px; font-weight: 600; color: var(--content-primary); display: flex; align-items: center; gap: var(--space-xs); }
.pm-bot-tag { font-size: 10px; font-weight: 600; color: var(--status-warning); background: var(--status-warning-bg); padding: 1px var(--space-xs); border-radius: var(--radius-compact); }
.pm-bot-appid { font-size: 11px; color: var(--content-secondary); font-family: var(--font-family-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pm-switch-wrap { flex-shrink: 0; display: inline-flex; align-items: center; gap: var(--space-xs); }
.pm-switch-label { font-size: 11px; color: var(--content-secondary); }
.pm-switch-label.on { color: var(--action-primary); font-weight: 600; }
.pm-bot-del { flex-shrink: 0; font-size: 12px; color: var(--status-danger); background: none; border: none; cursor: pointer; }
.pm-add-bot { margin-top: var(--space-sm); width: 100%; padding: var(--space-sm); border-radius: var(--radius-xs); cursor: pointer; font-size: 13px; color: var(--content-secondary); border: 1px dashed var(--input-border); background: none; }
.pm-add-bot:hover { color: var(--action-primary); border-color: var(--action-outline); }
.pm-bot-form { margin-top: var(--space-sm); display: flex; flex-direction: column; gap: var(--space-sm); padding: var(--space-md); border-radius: var(--radius-xs); background: var(--subpanel-bg); border: 1px solid var(--subpanel-border); }
.pm-bot-input { width: 100%; padding: var(--space-sm) var(--space-md); border-radius: var(--input-radius); font-size: 13px; border: 1px solid var(--input-border); background: var(--input-bg); color: var(--input-fg); outline: none; box-shadow: var(--input-hover-shadow), 0 0 0 0 transparent; transition: background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard), box-shadow var(--motion-hover-control) var(--motion-ease-standard); }
.pm-bot-input:hover { background: var(--input-bg-hover); border-color: var(--input-border-hover); box-shadow: var(--input-hover-shadow), 0 0 0 0 transparent; }
.pm-bot-input:focus { border-color: var(--input-border-focus); box-shadow: var(--input-hover-shadow); }
.pm-bot-check { font-size: 12px; color: var(--content-secondary); display: flex; align-items: center; gap: var(--space-xs); cursor: pointer; }
.pm-bot-form-actions { display: flex; align-items: center; gap: var(--space-sm); }
.pm-text-link { margin-top: var(--space-sm); background: none; border: none; cursor: pointer; font-size: 12px; color: var(--content-secondary); text-decoration: underline; padding: 0; }
.pm-text-link:hover { color: var(--action-primary); }
.pm-qr-err { margin-top: var(--space-sm); font-size: 12px; color: var(--status-danger); }
.pm-quota-skeleton { display: flex; flex-direction: column; gap: var(--space-md); }
.pm-qs-pct { width: 30px; height: 13px; border-radius: 6px; background: linear-gradient(90deg,var(--surface-soft) 25%,var(--selection-bg) 50%,var(--surface-soft) 75%); background-size: 200% 100%; animation: pm-shimmer 1.4s ease-in-out infinite; }
.pm-qs-fill { height: 100%; width: 0%; border-radius: 99px; background: linear-gradient(90deg,var(--surface-soft) 25%,var(--selection-bg) 50%,var(--surface-soft) 75%); background-size: 200% 100%; animation: pm-shimmer 1.4s ease-in-out infinite; }
@keyframes pm-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
.pm-quota-item { display: flex; flex-direction: column; gap: var(--space-xs); }
.pm-quota-row { display: flex; align-items: center; justify-content: space-between; }
.pm-quota-label { font-size: 13px; font-weight: 600; color: var(--content-primary); }
.pm-quota-pct { font-size: 12px; font-weight: 600; color: var(--content-secondary); font-variant-numeric: tabular-nums; }
.pm-quota-pct.pct-warn { color: var(--status-warning); }
.pm-quota-pct.pct-danger { color: var(--status-danger); }
.pm-quota-bar { height: 6px; border-radius: 99px; background: var(--surface-soft); overflow: hidden; }
.pm-quota-fill { height: 100%; border-radius: 99px; transition: width .5s var(--motion-ease-enter); min-width: 2px; }
</style>
