<template>
  <BaseModal :show="show" width="900px" height="600px" @close="$emit('close')">
    <div class="pm-layout">
      <div class="pm-nav panel-left">
        <div class="pm-user-block">
          <div class="pm-avatar" :class="{ uploading: avatarUploading }" @click="triggerAvatarUpload" title="点击更换头像">
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
            {{ item.label }}
          </button>
        </template>
        <div class="pm-nav-spacer"></div>
        <button class="pm-logout pm-danger-nav" @click="openDeleteAccount">
          <Icon name="user.remove" size="sm" tone="inherit" />
          注销账号
        </button>
      </div>

      <div class="pm-content">
        <div class="pm-content-header">
          <span class="pm-content-title">{{ currentNavLabel }}</span>
          <button class="popup-close-btn" @click="$emit('close')"><Icon name="action.close" size="sm" tone="inherit" /></button>
        </div>
        <div class="pm-content-body" ref="pmBodyRef">
          <KeepAlive>
            <ProfileInfoPane v-if="activeNav === 'info'" :external-message="infoMsg" :external-message-type="infoMsgType" />
            <ProfileAccountPane v-else-if="activeNav === 'account'" />
            <ProfileGuguPane v-else-if="activeNav === 'gugu'" />
            <ProfileToolPermissionsPane v-else-if="activeNav === 'tools'" />
            <ProfileWorkspacesPane v-else-if="activeNav === 'workspaces'" />
            <ProfileImPane v-else-if="activeNav === 'im'" />
            <ProfilePreferencesPane v-else-if="activeNav === 'prefs'" />
          </KeepAlive>
        </div>
      </div>
    </div>
  </BaseModal>

  <Teleport to="body">
    <Transition name="pm-confirm">
    <div v-if="showDeleteAccount" class="pm-confirm-overlay" :style="{ zIndex: TOP_Z }" @click.self="closeDeleteAccount">
      <div class="pm-confirm-box">
        <p class="pm-confirm-title">确认注销账号？</p>
        <p class="pm-confirm-desc">账号及全部数据（项目、文件、日历、聊天记录、咕咕记忆等）将被<strong>永久删除</strong>，此操作不可恢复。</p>
        <input v-model="deletePwd" type="password" class="form-input pm-confirm-input" placeholder="输入密码确认" @keyup.enter="doDeleteAccount" />
        <p v-if="deleteErr" class="pm-msg err">{{ deleteErr }}</p>
        <div class="pm-confirm-actions">
          <button class="btn-cancel" @click="closeDeleteAccount">取消</button>
          <button class="pm-danger-btn" :disabled="!deletePwd || deleting" @click="doDeleteAccount">{{ deleting ? '注销中…' : '确认注销' }}</button>
        </div>
      </div>
    </div>
    </Transition>
  </Teleport>

  <AvatarCropper :show="cropperShow" :file="cropFile" @close="closeCropper" @crop="onCropped" />
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import BaseModal from '@/components/common/BaseModal.vue'
import AvatarCropper from '@/components/common/AvatarCropper.vue'
import ProfileInfoPane from './ProfileModal/ProfileInfoPane.vue'
import ProfileAccountPane from './ProfileModal/ProfileAccountPane.vue'
import ProfilePreferencesPane from './ProfileModal/ProfilePreferencesPane.vue'
import ProfileGuguPane from './ProfileModal/ProfileGuguPane.vue'
import ProfileImPane from './ProfileModal/ProfileImPane.vue'
import ProfileToolPermissionsPane from './ProfileModal/ProfileToolPermissionsPane.vue'
import ProfileWorkspacesPane from './ProfileModal/ProfileWorkspacesPane.vue'
import { authApi } from '@/services/api'
import { TOP_Z } from '@/composables/windowz'
import Icon from '@/components/common/Icon.vue'

const props = defineProps({ show: Boolean })
const emit  = defineEmits(['close'])
const router = useRouter()
const authStore = useAuthStore()
const displayLabel = computed(() => authStore.user?.displayName || authStore.user?.username || '—')
const initial = computed<string>(() => (displayLabel.value.charAt(0) || '?').toUpperCase())

const navItems = [
  { key: 'info', label: '个人信息', icon: 'user.default' },
  { key: 'account', label: '账号设置', icon: 'user.security' },
  { key: 'prefs', label: '偏好设置', icon: 'user.settings' },
  { divider: true },
  { key: 'gugu', label: '咕咕设置', icon: 'user.gugu' },
  { key: 'im', label: '接入咕咕', icon: 'communication.chat' },
  { key: 'tools', label: '工具权限', icon: 'admin.wrench' },
  { key: 'workspaces', label: '工作区', icon: 'admin.folder' },
]
const activeNav = ref('info')
const currentNavLabel = computed(() => navItems.find(n => !n.divider && n.key === activeNav.value)?.label ?? '')
const infoMsg = ref('')
const infoMsgType = ref('ok')

watch(() => props.show, value => {
  if (value) {
    activeNav.value = 'info'
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

<style>
.pm-layout { display: grid; grid-template-columns: 210px 1fr; height: 100%; }
.pm-nav { display: flex; flex-direction: column; padding: 20px 14px; gap: 2px; }
.pm-user-block { display: flex; align-items: center; gap: 10px; padding: 4px 6px 12px; }
.pm-avatar {
  width: 42px; height: 42px; border-radius: 50%; flex-shrink: 0;
  background: linear-gradient(135deg,#7b7fb2,#7ab8c8); display: flex; align-items: center; justify-content: center;
  font-size: 16px; font-weight: 700; color: white; position: relative; cursor: pointer; overflow: hidden;
  box-shadow: 0 2px 8px rgba(123,127,178,.35);
}
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
.pm-user-info { min-width: 0; }
.pm-name { font-size: 13px; font-weight: 700; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pm-email { font-size: 11px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pm-nav-divider { height: 1px; background: var(--divider-line); margin: 6px 4px; }
.pm-nav-item {
  display: flex; align-items: center; gap: 9px; width: 100%; padding: 10px 12px;
  border-radius: var(--radius-sm); border: 1px solid transparent; background: none;
  font: 14px var(--font-sans); color: var(--content-secondary); cursor: pointer; text-align: left;
  transition: color var(--motion-hover-control) var(--motion-ease-standard), background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard), box-shadow var(--motion-hover-control) var(--motion-ease-standard);
}
.pm-nav-item:hover:not(.active) { background: var(--sidebar-item-hover); color: var(--content-primary); }
.pm-nav-item.active { background: var(--sidebar-item-active); color: var(--sidebar-item-active-fg); font-weight: 700; border-color: var(--sidebar-item-active-border); box-shadow: var(--sidebar-item-active-shadow); }
.pm-nav-spacer { flex: 1; }
.pm-logout {
  display: flex; align-items: center; gap: 9px; width: 100%; padding: 10px 12px;
  border-radius: var(--radius-sm); border: 1px solid transparent; background: none;
  font: 14px var(--font-sans); color: var(--content-secondary); cursor: pointer;
  transition: color var(--motion-hover-control) var(--motion-ease-standard), background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard);
}
.pm-logout:hover,
.pm-logout.pm-danger-nav:hover { background: var(--danger-button-bg); color: var(--danger-button-fg); border-color: var(--danger-button-border); }

.pm-confirm-overlay {
  position: fixed; inset: 0; background: var(--modal-overlay-bg); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  display: flex; align-items: center; justify-content: center; padding: 24px;
}
.pm-confirm-box {
  width: 100%; max-width: 380px; padding: 22px; display: flex; flex-direction: column; gap: 12px;
  background: var(--modal-card-bg); backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--modal-card-border); border-radius: var(--radius-lg);
  box-shadow: var(--modal-card-shadow), inset 0 1px 0 var(--modal-card-highlight);
}
.pm-confirm-enter-active { transition: background-color var(--modal-enter-duration) var(--modal-enter-easing), backdrop-filter var(--modal-enter-duration) var(--modal-enter-easing), -webkit-backdrop-filter var(--modal-enter-duration) var(--modal-enter-easing); }
.pm-confirm-enter-from { background-color: transparent; backdrop-filter: blur(0); -webkit-backdrop-filter: blur(0); }
.pm-confirm-enter-active .pm-confirm-box { transition: backdrop-filter var(--modal-enter-duration) var(--modal-enter-easing), -webkit-backdrop-filter var(--modal-enter-duration) var(--modal-enter-easing); }
.pm-confirm-enter-from .pm-confirm-box { backdrop-filter: blur(0) !important; -webkit-backdrop-filter: blur(0) !important; }
.pm-confirm-leave-active { transition: opacity var(--modal-leave-duration) var(--modal-leave-easing); }
.pm-confirm-leave-to { opacity: 0; }
.pm-confirm-title { font-size: 15px; font-weight: 700; color: var(--content-primary); margin: 0; }
.pm-confirm-desc { font-size: 12.5px; line-height: 1.6; color: var(--content-secondary); margin: 0; }
.pm-confirm-desc strong { color: var(--status-danger); }
.pm-confirm-input { width: 100%; box-sizing: border-box; }
.pm-confirm-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 4px; }
.btn-cancel {
  padding: 7px 16px; border-radius: var(--radius-sm); border: 1px solid var(--control-border);
  background: var(--control-bg); color: var(--control-fg); font: 13px var(--font-sans); cursor: pointer;
  transition: color var(--motion-hover-control) var(--motion-ease-standard), background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard);
}
.btn-cancel:hover { background: var(--control-bg-hover); border-color: var(--control-border-hover); color: var(--control-fg-strong); }

.pm-content { display: flex; flex-direction: column; min-height: 0; background: var(--panel-content-bg); backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur); box-shadow: inset 0 1px 0 var(--panel-glass-highlight); }
.pm-content-header { display: flex; align-items: center; justify-content: space-between; padding: 20px 26px 16px; border-bottom: 1px solid var(--panel-divider); flex-shrink: 0; }
.pm-content-title { font-size: 16px; font-weight: 700; color: var(--content-primary); }
.pm-content-body { flex: 1; overflow-y: auto; padding: 6px 0; scrollbar-gutter: auto; }
.pm-section { padding: 20px 26px; display: flex; flex-direction: column; gap: 14px; }
.pm-section-label { font-size: 11px; font-weight: 700; color: var(--content-secondary); text-transform: uppercase; letter-spacing: .07em; margin-bottom: 2px; }
.pm-sep { height: 1px; background: var(--panel-divider); margin: 0 26px; }
.pm-field { display: grid; grid-template-columns: 80px 1fr; align-items: center; gap: 14px; }
.pm-field label { font-size: 13px; font-weight: 600; color: var(--content-primary); }
.pm-field-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.pm-field-desc { display: flex; flex-direction: column; gap: 2px; }
.pm-field-name { font-size: 13px; font-weight: 600; color: var(--content-primary); }
.pm-field-hint { font-size: 12px; color: var(--content-secondary); }
.form-input.modified { border-color: var(--action-outline); }
.pm-uid { color: var(--content-secondary); }
.pm-static { font-size: 13px; color: var(--content-secondary); padding: 7px 2px; }
.pm-tool-locked { padding: 11px 12px; border: 1px solid var(--line-subtle); border-radius: 8px; background: var(--surface-subtle); }
.pm-coming { font-size: 11px; font-weight: 600; color: var(--content-disabled); background: var(--surface-soft); padding: 3px 10px; border-radius: var(--radius-pill); }

.pm-style-group { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.pm-style-chip {
  border-radius: var(--choice-chip-radius); border: 1px solid var(--choice-chip-border);
  background: var(--choice-chip-bg); color: var(--choice-chip-fg); font: 500 12px var(--font-sans); cursor: pointer;
  transition: color var(--motion-hover-control) var(--motion-ease-standard), background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard);
}
.pm-style-chip:hover { background: var(--choice-chip-bg-hover); border-color: var(--choice-chip-border-hover); color: var(--choice-chip-fg-hover); }
.pm-style-chip.active { background: var(--choice-chip-bg-active); border-color: var(--choice-chip-border-active); color: var(--choice-chip-fg-active); font-weight: 600; }

.pm-bind-btn {
  padding: 6px 16px; border-radius: var(--radius-sm); border: none; background: var(--action-primary-bg); color: var(--content-on-accent);
  font: 600 12px var(--font-sans); cursor: pointer; box-shadow: var(--elevation-card);
  transition: opacity var(--motion-hover-control) var(--motion-ease-standard), transform var(--motion-hover-control) var(--motion-ease-standard);
}
.pm-bind-btn:hover:not(:disabled) { opacity: .9; transform: translateY(-1px); }
.pm-bind-btn:disabled { opacity: .4; cursor: default; }
.pm-danger-btn {
  padding: 6px 16px; border-radius: var(--danger-button-radius); border: 1px solid var(--danger-button-border);
  background: var(--danger-button-bg); color: var(--danger-button-fg); box-shadow: var(--danger-button-shadow);
  font: 600 12px var(--font-sans); cursor: pointer;
  transition: color var(--motion-hover-control) var(--motion-ease-standard), background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard), opacity var(--motion-hover-control) var(--motion-ease-standard);
}
.pm-danger-btn:hover:not(:disabled) { background: var(--danger-button-bg-hover); border-color: var(--danger-button-border-hover); }
.pm-danger-btn:disabled { opacity: .4; cursor: default; }
.pm-bind-btn.off { background: var(--control-bg); color: var(--control-fg); border: 1px solid var(--control-border); box-shadow: none; }
.pm-qr-box { margin-top: 12px; display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 16px; background: var(--subpanel-bg); border: 1px solid var(--subpanel-border); border-radius: var(--radius-md); }
.pm-qr-canvas { border-radius: var(--radius-sm); background: #fff; }
.pm-qr-hint { font-size: 12px; color: var(--content-secondary); text-align: center; }
.pm-qr-hint a { color: var(--action-primary); font-weight: 600; }

.pm-bot-item { margin-top: 8px; display: flex; flex-direction: column; gap: 8px; padding: 9px 12px; border-radius: var(--radius-sm); background: var(--subpanel-bg); border: 1px solid var(--subpanel-border); }
.pm-bot-item-top { display: flex; align-items: center; gap: 10px; }
.pm-bot-group-row { display: flex; align-items: center; gap: 10px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--panel-divider); }
.pm-bot-group-row .pm-field-desc { flex: 1; min-width: 0; }
.pm-bot-tools-row { align-items: center; }
.pm-tool-options { justify-content: flex-end; flex-wrap: wrap; max-width: 58%; }
.pm-bot-info { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.pm-bot-name { font-size: 13px; font-weight: 600; color: var(--content-primary); display: flex; align-items: center; gap: 6px; }
.pm-bot-tag { font-size: 10px; font-weight: 600; color: var(--status-warning); background: var(--status-warning-bg); padding: 1px 6px; border-radius: var(--radius-xs); }
.pm-bot-appid { font-size: 11px; color: var(--content-secondary); font-family: var(--font-family-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pm-switch-wrap { flex-shrink: 0; display: inline-flex; align-items: center; gap: 6px; }
.pm-switch-label { font-size: 11px; color: var(--content-secondary); }
.pm-switch-label.on { color: var(--action-primary); font-weight: 600; }
.pm-bot-del { flex-shrink: 0; font-size: 12px; color: var(--status-danger); background: none; border: none; cursor: pointer; }
.pm-add-bot { margin-top: 8px; width: 100%; padding: 8px; border-radius: var(--radius-sm); cursor: pointer; font-size: 13px; color: var(--content-secondary); border: 1px dashed var(--input-border); background: none; }
.pm-add-bot:hover { color: var(--action-primary); border-color: var(--action-outline); }
.pm-bot-form { margin-top: 8px; display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: var(--radius-sm); background: var(--subpanel-bg); border: 1px solid var(--subpanel-border); }
.pm-bot-input { width: 100%; padding: 8px 11px; border-radius: var(--input-radius); font-size: 13px; border: 1px solid var(--input-border); background: var(--input-bg); color: var(--input-fg); outline: none; }
.pm-bot-input:focus { border-color: var(--input-border-focus); box-shadow: var(--input-focus-shadow); }
.pm-bot-check { font-size: 12px; color: var(--content-secondary); display: flex; align-items: center; gap: 6px; cursor: pointer; }
.pm-bot-form-actions { display: flex; align-items: center; gap: 8px; }
.pm-text-link { margin-top: 8px; background: none; border: none; cursor: pointer; font-size: 12px; color: var(--content-secondary); text-decoration: underline; padding: 0; }
.pm-text-link:hover { color: var(--action-primary); }
.pm-qr-cancel { font-size: 12px; color: var(--content-secondary); background: none; border: none; cursor: pointer; text-decoration: underline; }
.pm-qr-err { margin-top: 10px; font-size: 12px; color: var(--status-danger); }
.pm-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding-top: 4px; }
.pm-msg { font-size: 12px; margin-right: auto; }
.pm-msg.ok { color: var(--status-success); }
.pm-msg.err { color: var(--status-danger); }
.pm-save-btn { padding: 7px 22px; border-radius: var(--radius-sm); border: none; background: var(--action-primary-bg); color: var(--content-on-accent); font: 600 13px var(--font-sans); cursor: pointer; box-shadow: var(--elevation-card); transition: opacity var(--motion-hover-control) var(--motion-ease-standard), transform var(--motion-hover-control) var(--motion-ease-standard); }
.pm-save-btn:hover:not(:disabled) { opacity: .88; transform: translateY(-1px); }
.pm-save-btn:disabled { opacity: .35; cursor: default; transform: none; }

.pm-quota-skeleton { display: flex; flex-direction: column; gap: 14px; }
.pm-qs-pct { width: 30px; height: 13px; border-radius: 6px; background: linear-gradient(90deg,var(--surface-soft) 25%,var(--selection-bg) 50%,var(--surface-soft) 75%); background-size: 200% 100%; animation: pm-shimmer 1.4s ease-in-out infinite; }
.pm-qs-fill { height: 100%; width: 0%; border-radius: 99px; background: linear-gradient(90deg,var(--surface-soft) 25%,var(--selection-bg) 50%,var(--surface-soft) 75%); background-size: 200% 100%; animation: pm-shimmer 1.4s ease-in-out infinite; }
@keyframes pm-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
.pm-quota-item { display: flex; flex-direction: column; gap: 6px; }
.pm-quota-row { display: flex; align-items: center; justify-content: space-between; }
.pm-quota-label { font-size: 13px; font-weight: 600; color: var(--content-primary); }
.pm-quota-pct { font-size: 12px; font-weight: 600; color: var(--content-secondary); font-variant-numeric: tabular-nums; }
.pm-quota-pct.pct-warn { color: var(--status-warning); }
.pm-quota-pct.pct-danger { color: var(--status-danger); }
.pm-quota-bar { height: 6px; border-radius: 99px; background: var(--surface-soft); overflow: hidden; }
.pm-quota-fill { height: 100%; border-radius: 99px; transition: width .5s var(--motion-ease-enter); min-width: 2px; }
</style>
