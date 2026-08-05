<template>
  <BaseModal :show="show" width="900px" height="600px" @close="$emit('close')">
    <div class="pm-layout">

      <!-- 左侧导航栏 -->
      <div class="pm-nav panel-left">
        <div class="pm-user-block">
          <div class="pm-avatar" :class="{ uploading: avatarUploading }" @click="triggerAvatarUpload" title="点击更换头像">
            <img v-if="authStore.user?.avatarUrl" :src="authStore.user.avatarUrl" class="pm-avatar-img" />
            <template v-else>{{ initial }}</template>
            <div class="pm-avatar-overlay">
              <span v-if="avatarUploading" class="pm-avatar-spin"></span>
              <PhCamera v-else :size="13" weight="bold" />
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
          <button
            v-else
            class="pm-nav-item"
            :class="{ active: activeNav === item.key }"
            @click="item.key && (activeNav = item.key)"
          >
            <component :is="item.icon" :size="14" weight="bold" />
            {{ item.label }}
          </button>
        </template>

        <div class="pm-nav-spacer"></div>

        <button class="pm-logout pm-danger-nav" @click="openDeleteAccount">
          <PhUserMinus :size="13" weight="bold" />
          注销账号
        </button>
      </div>

      <!-- 右侧内容区 -->
      <div class="pm-content">
        <div class="pm-content-header">
          <span class="pm-content-title">{{ currentNavLabel }}</span>
          <button class="popup-close-btn" @click="$emit('close')">
            <PhX :size="13" weight="bold" />
          </button>
        </div>

        <div class="pm-content-body" ref="pmBodyRef">

          <KeepAlive>
            <ProfileInfoPane
              v-if="activeNav === 'info'"
              :external-message="infoMsg"
              :external-message-type="infoMsgType"
            />
            <ProfileAccountPane v-else-if="activeNav === 'account'" />
            <ProfileGuguPane v-else-if="activeNav === 'gugu'" />
            <ProfileImPane v-else-if="activeNav === 'im'" />
            <ProfilePreferencesPane v-else-if="activeNav === 'prefs'" />
          </KeepAlive>



        </div>
      </div>
    </div>

  </BaseModal>

  <!-- 注销账号二次确认弹窗：不用 BaseModal——BaseModal 的卡片是「点哪个哪个置顶」(mousedown 领新 z)，
       两个 BaseModal 叠着开会互相抢最顶层，点一下父面板就把它的 z 顶到这个弹窗之上（不是关闭，只是
       盖住+蒙层还留着），得多点一次才能真正关掉。这里直接钉在 TOP_Z（跟 toast/拖拽克隆一个band，
       "永远最顶层"），不参与常规窗口的抢位——不管父面板怎么点/怎么重新领 z，这层永远在最上面。 -->
  <Teleport to="body">
    <Transition name="pm-confirm">
    <div v-if="showDeleteAccount" class="pm-confirm-overlay" :style="{ zIndex: TOP_Z }" @click.self="closeDeleteAccount">
      <div class="pm-confirm-box">
        <p class="pm-confirm-title">确认注销账号？</p>
        <p class="pm-confirm-desc">
          账号及全部数据（项目、文件、日历、聊天记录、咕咕记忆等）将被<strong>永久删除</strong>，此操作不可恢复。
        </p>
        <input
          v-model="deletePwd" type="password" class="form-input pm-confirm-input"
          placeholder="输入密码确认" @keyup.enter="doDeleteAccount"
        />
        <p v-if="deleteErr" class="pm-msg err">{{ deleteErr }}</p>
        <div class="pm-confirm-actions">
          <button class="btn-cancel" @click="closeDeleteAccount">取消</button>
          <button class="pm-danger-btn" :disabled="!deletePwd || deleting" @click="doDeleteAccount">
            {{ deleting ? '注销中…' : '确认注销' }}
          </button>
        </div>
      </div>
    </div>
    </Transition>
  </Teleport>

  <!-- 头像裁切：选图后先方形裁切 + 降采样，只上传裁切结果（原图不出浏览器） -->
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
import { authApi } from '@/services/api'
import { TOP_Z } from '@/composables/windowz'
import { PhX, PhUserMinus, PhUser, PhShieldCheck, PhSliders, PhCamera, PhBird, PhChatsCircle } from '@phosphor-icons/vue'

const props = defineProps({ show: Boolean })
const emit  = defineEmits(['close'])

const router     = useRouter()
const authStore  = useAuthStore()

const displayLabel = computed(() => authStore.user?.displayName || authStore.user?.username || '—')
const initial = computed(() => (displayLabel.value[0] ?? '?').toUpperCase())

const navItems = [
  { key: 'info',    label: '个人信息', icon: PhUser },
  { key: 'account', label: '账号设置', icon: PhShieldCheck },
  { key: 'prefs',   label: '偏好设置', icon: PhSliders },
  { divider: true },
  { key: 'gugu',    label: '咕咕设置', icon: PhBird },
  { key: 'im',      label: '接入咕咕', icon: PhChatsCircle },
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

// 头像上传：选图 → 方形裁切/降采样弹窗 → 只上传裁切结果
const avatarInput    = ref<HTMLInputElement | null>(null)
const avatarUploading = ref(false)
const cropperShow = ref(false)
const cropFile    = ref<File | null>(null)
function triggerAvatarUpload() {
  if (avatarUploading.value) return
  avatarInput.value?.click()
}
function onAvatarFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''   // 允许连续选同一文件再次触发 change
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
    infoMsg.value     = '头像已更新'
    infoMsgType.value = 'ok'
  } catch (err) {
    infoMsg.value     = (err as Error).message || '头像上传失败'
    infoMsgType.value = 'err'
    activeNav.value   = 'info'
  } finally {
    avatarUploading.value = false
  }
}

// 注销账号：需要密码二次确认，成功后清会话跳登录页（跟退出登录一样，但数据已经删了）
const showDeleteAccount = ref(false)
const deletePwd = ref('')
const deleteErr = ref('')
const deleting = ref(false)

function openDeleteAccount() {
  showDeleteAccount.value = true
}

function closeDeleteAccount() {
  showDeleteAccount.value = false
  deletePwd.value = ''
  deleteErr.value = ''
}

// ESC 关闭：本弹窗钉在 TOP_Z，开着时必然是最顶层，不用像 BaseModal 那样跟别的窗口比 z 才决定谁接 ESC
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

.pm-layout {
  display: grid;
  grid-template-columns: 210px 1fr;
  height: 100%;
}

/* 左侧导航 — 与 AppSidebar 同风格 */
.pm-nav {
  display: flex; flex-direction: column;
  padding: 20px 14px;
  gap: 2px;
}

.pm-user-block {
  display: flex; align-items: center; gap: 10px;
  padding: 4px 6px 12px;
}
.pm-avatar {
  width: 42px; height: 42px; border-radius: 50%; flex-shrink: 0;
  background: linear-gradient(135deg, #7b7fb2, #7ab8c8);
  display: flex; align-items: center; justify-content: center;
  font-size: 16px; font-weight: 700; color: white;
  position: relative; cursor: pointer; overflow: hidden;
  box-shadow: 0 2px 8px rgba(123,127,178,0.35);
}
.pm-avatar-img {
  width: 100%; height: 100%; object-fit: cover; border-radius: 50%;
}
.pm-avatar-overlay {
  position: absolute; inset: 0; border-radius: 50%;
  background: rgba(0,0,0,0.38);
  display: flex; align-items: center; justify-content: center;
  color: white; opacity: 0; transition: opacity 0.15s;
}
.pm-avatar:hover .pm-avatar-overlay,
.pm-avatar.uploading .pm-avatar-overlay { opacity: 1; }
.pm-avatar-spin {
  width: 14px; height: 14px; border-radius: 50%;
  border: 2px solid rgba(255,255,255,0.3);
  border-top-color: #fff;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.pm-user-info { min-width: 0; }
.pm-name  { font-size: 13px; font-weight: 700; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pm-email { font-size: 11px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.pm-nav-divider {
  height: 1px;
  background: linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.07) 20%, rgba(0,0,0,0.07) 80%, transparent 100%);
  margin: 6px 4px;
}

.pm-nav-item {
  display: flex; align-items: center; gap: 9px;
  width: 100%; padding: 10px 12px; border-radius: var(--radius-sm);
  border: 1px solid transparent; background: none;
  font-size: 14px; font-family: var(--font-sans);
  color: #767980; cursor: pointer; text-align: left;
  transition: all 0.15s;
}
.pm-nav-item:hover { background: rgba(123,127,178,0.08); color: var(--text-primary); }
.pm-nav-item.active {
  background: rgba(255,255,255,0.38); color: #6b6fa0;
  font-weight: 700; border-color: rgba(255,255,255,0.62);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.85);
}

.pm-nav-spacer { flex: 1; }

.pm-logout {
  display: flex; align-items: center; gap: 9px;
  padding: 10px 12px; border-radius: var(--radius-sm); border: 1px solid transparent;
  cursor: pointer; font-size: 14px; font-family: var(--font-sans);
  color: #767980; background: none; width: 100%;
  transition: all 0.15s;
}
.pm-logout:hover,
.pm-logout.pm-danger-nav:hover { background: rgba(196,80,80,0.08); color: #c45050; border-color: rgba(196,80,80,0.18); }

/* 注销账号二次确认弹窗——视觉上照抄 BaseModal 的 .bm-overlay/.bm-card（背景/模糊/边框/阴影），
   但不用 BaseModal 本体：BaseModal 卡片自带「点击置顶」，两个 BaseModal 叠着会抢 z，见上方模板注释 */
.pm-confirm-overlay {
  position: fixed; inset: 0;
  background: rgba(20, 22, 30, 0.3);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
}
.pm-confirm-box {
  width: 100%; max-width: 380px; padding: 22px;
  background: var(--panel-bg);
  backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid rgba(255,255,255,0.72); border-radius: 20px;
  box-shadow: 0 24px 64px rgba(20,25,50,0.2), inset 0 1px 0 rgba(255,255,255,0.95);
  display: flex; flex-direction: column; gap: 12px;
}

/* 进场淡入淡出——照抄 BaseModal 的「玻璃 ramp」原理（机制见 BaseModal.vue 过渡段注释）：
   进场绝不能动 opacity（会形成半透明隔离组，backdrop-filter 在动画期间采不到身后内容，
   看起来像「淡入完才突然糊上」），改成遮罩的压暗/模糊、卡片的模糊半径本身从 0 ramp 到满值；
   离场简单得多、直接 opacity 淡出即可（关闭瞬间模糊失效会被同步的淡出盖住，肉眼不可察）。
   这里不用像 BaseModal 那样借 global.css——overlay 和 card 都在本组件同一个 scope 里，
   scoped 的后代选择器直接够得到，不用全局规则。 */
.pm-confirm-enter-active {
  transition: background-color var(--modal-enter-duration) var(--modal-enter-easing),
              backdrop-filter var(--modal-enter-duration) var(--modal-enter-easing),
              -webkit-backdrop-filter var(--modal-enter-duration) var(--modal-enter-easing);
}
.pm-confirm-enter-from { background-color: rgba(20,22,30,0); backdrop-filter: blur(0px); -webkit-backdrop-filter: blur(0px); }
.pm-confirm-enter-active .pm-confirm-box {
  transition: backdrop-filter var(--modal-enter-duration) var(--modal-enter-easing),
              -webkit-backdrop-filter var(--modal-enter-duration) var(--modal-enter-easing);
}
.pm-confirm-enter-from .pm-confirm-box { backdrop-filter: blur(0px) !important; -webkit-backdrop-filter: blur(0px) !important; }
.pm-confirm-leave-active { transition: opacity var(--modal-leave-duration) var(--modal-leave-easing); }
.pm-confirm-leave-to { opacity: 0; }

.pm-confirm-title { font-size: 15px; font-weight: 700; color: var(--text-primary); margin: 0; }
.pm-confirm-desc { font-size: 12.5px; line-height: 1.6; color: var(--text-secondary); margin: 0; }
.pm-confirm-desc strong { color: #c45050; }
.pm-confirm-input { width: 100%; box-sizing: border-box; }
.pm-confirm-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 4px; }
.btn-cancel {
  padding: 7px 16px; border-radius: 8px; border: 1px solid rgba(0,0,0,0.1);
  background: none; color: var(--text-secondary); font-size: 13px;
  font-family: var(--font-sans); cursor: pointer; transition: all 0.15s;
}
.btn-cancel:hover { background: rgba(0,0,0,0.04); color: var(--text-primary); }

/* 右侧内容 */
.pm-content {
  display: flex; flex-direction: column; min-height: 0;
  background: var(--panel-bg);
  backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur);
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.98);
}

.pm-content-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 20px 26px 16px;
  border-bottom: 1px solid rgba(0,0,0,0.06); flex-shrink: 0;
}
.pm-content-title { font-size: 16px; font-weight: 700; color: var(--text-primary); }

.pm-content-body { flex: 1; overflow-y: auto; padding: 6px 0; scrollbar-gutter: stable; }

.pm-section { padding: 20px 26px; display: flex; flex-direction: column; gap: 14px; }
.pm-section-label {
  font-size: 11px; font-weight: 700; color: var(--text-secondary);
  text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 2px;
}
.pm-sep { height: 1px; background: rgba(0,0,0,0.06); margin: 0 26px; }

.pm-field {
  display: grid; grid-template-columns: 80px 1fr; align-items: center; gap: 14px;
}
.pm-field label { font-size: 13px; font-weight: 600; color: var(--text-primary); }

.pm-field-row {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
}
.pm-field-desc { display: flex; flex-direction: column; gap: 2px; }
.pm-field-name { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.pm-field-hint { font-size: 12px; color: var(--text-secondary); }

.form-input.modified { border-color: rgba(123,127,178,0.4); }
.pm-uid { color: var(--text-secondary); }
.pm-static {
  font-size: 13px; color: var(--text-secondary); padding: 7px 2px;
}
.pm-coming {
  font-size: 11px; font-weight: 600; color: rgba(30,32,40,0.3);
  background: rgba(0,0,0,0.05); padding: 3px 10px; border-radius: 20px;
}

.pm-style-group {
  display: flex; gap: 4px; flex-shrink: 0;
}
.pm-style-chip {
  padding: 4px 11px; border-radius: 20px; border: 1px solid rgba(0,0,0,0.1);
  background: transparent; font-size: 12px; font-weight: 500;
  color: var(--text-secondary); cursor: pointer; font-family: var(--font-sans);
  transition: background 0.12s, border-color 0.12s, color 0.12s;
}
.pm-style-chip:hover { background: rgba(123,127,178,0.08); color: var(--text-primary); }
.pm-style-chip.active {
  background: rgba(123,127,178,0.14); border-color: rgba(123,127,178,0.4);
  color: var(--color-primary); font-weight: 600;
}

/* 飞书绑定 */
.pm-bind-btn {
  padding: 6px 16px; border-radius: 8px; border: none;
  background: linear-gradient(135deg, #7b7fb2, #9590c4); color: #fff;
  font-size: 12px; font-weight: 600; font-family: var(--font-sans); cursor: pointer;
  box-shadow: 0 2px 8px rgba(123,127,178,0.25); transition: opacity 0.15s, transform 0.15s;
}
.pm-bind-btn:hover:not(:disabled) { opacity: 0.9; transform: translateY(-1px); }
.pm-bind-btn:disabled { opacity: 0.4; cursor: default; }
.pm-danger-btn {
  padding: 6px 16px; border-radius: 8px; border: none;
  background: linear-gradient(135deg, #b25a5a, #c47070); color: #fff;
  font-size: 12px; font-weight: 600; font-family: var(--font-sans); cursor: pointer;
  box-shadow: 0 2px 8px rgba(178,90,90,0.25); transition: opacity 0.15s, transform 0.15s;
}
.pm-danger-btn:hover:not(:disabled) { opacity: 0.9; transform: translateY(-1px); }
.pm-danger-btn:disabled { opacity: 0.4; cursor: default; }
.pm-bind-btn.off {
  background: transparent; color: var(--text-secondary);
  border: 1px solid rgba(0,0,0,0.12); box-shadow: none;
}
.pm-qr-box {
  margin-top: 12px; display: flex; flex-direction: column; align-items: center; gap: 8px;
  padding: 16px; background: rgba(0,0,0,0.02); border: 1px solid rgba(0,0,0,0.06); border-radius: 12px;
}
.pm-qr-canvas { border-radius: 8px; background: #fff; }
.pm-qr-hint { font-size: 12px; color: var(--text-secondary); text-align: center; }
.pm-qr-hint a { color: #7b7fb2; font-weight: 600; }

/* QQ BYO：机器人列表 + 表单 */
.pm-bot-item {
  margin-top: 8px; display: flex; flex-direction: column; gap: 8px;
  padding: 9px 12px; border-radius: 10px;
  background: rgba(0,0,0,0.02); border: 1px solid rgba(0,0,0,0.06);
}
.pm-bot-item-top { display: flex; align-items: center; gap: 10px; }
.pm-bot-group-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid rgba(120, 125, 160, 0.12);
}
.pm-bot-group-row .pm-field-desc { flex: 1; min-width: 0; }
.pm-bot-tools-row { align-items: center; }
.pm-tool-options {
  justify-content: flex-end;
  flex-wrap: wrap;
  max-width: 58%;
}
.pm-bot-info { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.pm-bot-name { font-size: 13px; font-weight: 600; color: var(--text-primary); display: flex; align-items: center; gap: 6px; }
.pm-bot-tag { font-size: 10px; font-weight: 600; color: #b8860b; background: rgba(212,160,23,0.14); padding: 1px 6px; border-radius: 5px; }
.pm-bot-appid { font-size: 11px; color: var(--text-secondary); font-family: 'SF Mono','Consolas',monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 开关按钮：和「定时任务」页同一套 .switch/.slider（checkbox 原生开关，样式统一）——
   之前自己另起一套纯色文字块（.pm-mini-toggle）没有 hover 反馈，看起来像静态标签，
   是用户反馈"看不出能点"的根因；现在跟全站已验证过的开关视觉保持一致 */
.pm-switch-wrap { flex-shrink: 0; display: inline-flex; align-items: center; gap: 6px; }
.pm-switch-label { font-size: 11px; color: var(--text-secondary); }
.pm-switch-label.on { color: var(--color-primary); font-weight: 600; }

.switch { position: relative; display: inline-block; width: 38px; height: 22px; flex-shrink: 0; }
.switch.sm { width: 32px; height: 19px; }
.switch input { opacity: 0; width: 0; height: 0; }
.switch .slider { position: absolute; inset: 0; background: rgba(0,0,0,0.18); border-radius: 22px; transition: 0.2s; cursor: pointer; }
.switch .slider::before { content: ''; position: absolute; height: 16px; width: 16px; left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: 0.2s; }
.switch.sm .slider::before { height: 13px; width: 13px; }
.switch input:checked + .slider { background: var(--color-primary); }
.switch input:checked + .slider::before { transform: translateX(16px); }
.switch.sm input:checked + .slider::before { transform: translateX(13px); }

.pm-bot-del { flex-shrink: 0; font-size: 12px; color: #c05050; background: none; border: none; cursor: pointer; }
.pm-add-bot {
  margin-top: 8px; width: 100%; padding: 8px; border-radius: 9px; cursor: pointer;
  font-size: 13px; color: var(--text-secondary);
  border: 1px dashed rgba(0,0,0,0.15); background: none;
}
.pm-add-bot:hover { color: #7b7fb2; border-color: rgba(123,127,178,0.4); }
.pm-bot-form {
  margin-top: 8px; display: flex; flex-direction: column; gap: 8px;
  padding: 12px; border-radius: 10px; background: rgba(0,0,0,0.02); border: 1px solid rgba(0,0,0,0.06);
}
.pm-bot-input {
  width: 100%; padding: 8px 11px; border-radius: 8px; font-size: 13px;
  border: 1px solid rgba(0,0,0,0.1); background: #fff; color: var(--text-primary); outline: none;
}
.pm-bot-input:focus { border-color: rgba(123,127,178,0.5); }
.pm-bot-check { font-size: 12px; color: var(--text-secondary); display: flex; align-items: center; gap: 6px; cursor: pointer; }
.pm-bot-form-actions { display: flex; align-items: center; gap: 8px; }
.pm-text-link {
  margin-top: 8px; background: none; border: none; cursor: pointer;
  font-size: 12px; color: var(--text-secondary); text-decoration: underline; padding: 0;
}
.pm-text-link:hover { color: #7b7fb2; }
.pm-qr-cancel {
  font-size: 12px; color: var(--text-secondary); background: none; border: none;
  cursor: pointer; text-decoration: underline;
}
.pm-qr-err { margin-top: 10px; font-size: 12px; color: #c85a5a; }

.pm-footer {
  display: flex; align-items: center; justify-content: flex-end;
  gap: 8px; padding-top: 4px;
}
.pm-msg { font-size: 12px; margin-right: auto; }
.pm-msg.ok  { color: #3a8870; }
.pm-msg.err { color: #c85a5a; }

.pm-save-btn {
  padding: 7px 22px; border-radius: 8px; border: none;
  background: linear-gradient(135deg, #7b7fb2, #9590c4);
  color: white; font-size: 13px; font-weight: 600;
  font-family: var(--font-sans); cursor: pointer;
  box-shadow: 0 2px 8px rgba(123,127,178,0.28);
  transition: opacity 0.15s, transform 0.15s;
}
.pm-save-btn:hover:not(:disabled) { opacity: 0.88; transform: translateY(-1px); }
.pm-save-btn:disabled { opacity: 0.35; cursor: default; transform: none; }

/* 精力值 */
.pm-quota-skeleton { display: flex; flex-direction: column; gap: 14px; }
.pm-qs-pct {
  width: 30px; height: 13px; border-radius: 6px;
  background: linear-gradient(90deg, rgba(123,127,178,0.10) 25%, rgba(123,127,178,0.22) 50%, rgba(123,127,178,0.10) 75%);
  background-size: 200% 100%;
  animation: pm-shimmer 1.4s ease-in-out infinite;
}
.pm-qs-fill {
  height: 100%; width: 0%; border-radius: 99px;
  background: linear-gradient(90deg, rgba(123,127,178,0.18) 25%, rgba(123,127,178,0.35) 50%, rgba(123,127,178,0.18) 75%);
  background-size: 200% 100%;
  animation: pm-shimmer 1.4s ease-in-out infinite;
}
@keyframes pm-shimmer {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
.pm-quota-item { display: flex; flex-direction: column; gap: 6px; }
.pm-quota-row { display: flex; align-items: center; justify-content: space-between; }
.pm-quota-label { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.pm-quota-pct { font-size: 12px; font-weight: 600; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.pm-quota-pct.pct-warn   { color: rgba(180,130,40,0.9); }
.pm-quota-pct.pct-danger { color: rgba(200,70,70,0.9); }
.pm-quota-bar {
  height: 6px; border-radius: 99px;
  background: rgba(0,0,0,0.07);
  overflow: hidden;
}
.pm-quota-fill {
  height: 100%; border-radius: 99px;
  transition: width 0.5s cubic-bezier(0.22,1,0.36,1);
  min-width: 2px;
}
</style>
