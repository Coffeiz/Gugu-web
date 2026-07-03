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
            @click="activeNav = item.key"
          >
            <component :is="item.icon" :size="14" weight="bold" />
            {{ item.label }}
          </button>
        </template>

        <div class="pm-nav-spacer"></div>

        <button class="pm-logout" @click="handleLogout">
          <PhSignOut :size="13" weight="bold" />
          退出登录
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

          <!-- 个人信息 -->
          <template v-if="activeNav === 'info'">
            <div class="pm-section">
              <div class="pm-section-label">账号信息</div>
              <div class="pm-field">
                <label>昵称</label>
                <input v-model="displayName" class="form-input" :class="{ modified: displayName !== (authStore.user?.displayName ?? '') }" placeholder="填写昵称" />
              </div>
              <div class="pm-field">
                <label>用户名</label>
                <div class="pm-static">{{ authStore.user?.username ?? '—' }}</div>
              </div>
              <div class="pm-field">
                <label>邮箱</label>
                <div class="pm-static">{{ authStore.user?.email ?? '—' }}</div>
              </div>
              <div class="pm-field">
                <label>UID</label>
                <div class="pm-static pm-uid">{{ authStore.user?.id ?? '—' }}</div>
              </div>
              <div class="pm-field">
                <label>加入时间</label>
                <div class="pm-static">{{ authStore.user?.createdAt ?? '—' }}</div>
              </div>
              <div class="pm-footer">
                <span v-if="infoMsg" class="pm-msg" :class="infoMsgType">{{ infoMsg }}</span>
                <button class="pm-save-btn" :disabled="displayName === (authStore.user?.displayName ?? '') || infoSaving" @click="saveInfo">
                  {{ infoSaving ? '保存中…' : '保存' }}
                </button>
              </div>
            </div>
          </template>

          <!-- 账号设置 -->
          <template v-if="activeNav === 'account'">
            <div class="pm-section">
              <div class="pm-section-label">修改密码</div>
              <div class="pm-field">
                <label>当前密码</label>
                <input v-model="currentPwd" type="password" class="form-input" placeholder="••••••••" />
              </div>
              <div class="pm-field">
                <label>新密码</label>
                <input v-model="newPwd" type="password" class="form-input" placeholder="至少 6 位" />
              </div>
              <div class="pm-field">
                <label>确认密码</label>
                <input v-model="confirmPwd" type="password" class="form-input" placeholder="再次输入" />
              </div>
              <div class="pm-footer">
                <span v-if="pwdMsg" class="pm-msg" :class="pwdMsgType">{{ pwdMsg }}</span>
                <button class="pm-save-btn" :disabled="!currentPwd || !newPwd || !confirmPwd || pwdSaving" @click="savePwd">
                  {{ pwdSaving ? '保存中…' : '修改密码' }}
                </button>
              </div>
            </div>
          </template>

          <!-- 咕咕设置 -->
          <template v-if="activeNav === 'gugu'">
            <div class="pm-section">
              <div class="pm-section-label">精力</div>
              <div v-if="quotaLoading" class="pm-quota-skeleton">
                <div class="pm-quota-item">
                  <div class="pm-quota-row">
                    <span class="pm-quota-label">精力</span>
                    <div class="pm-qs-pct"></div>
                  </div>
                  <div class="pm-quota-bar"><div class="pm-qs-fill"></div></div>
                </div>
                <div class="pm-quota-item">
                  <div class="pm-quota-row">
                    <span class="pm-quota-label">本周</span>
                    <div class="pm-qs-pct"></div>
                  </div>
                  <div class="pm-quota-bar"><div class="pm-qs-fill"></div></div>
                </div>
              </div>
              <template v-else>
                <div class="pm-quota-item">
                  <div class="pm-quota-row">
                    <span class="pm-quota-label">{{ recoverLabel }}</span>
                    <span class="pm-quota-pct" :class="quotaPctClass(quota.used_6h, quota.limit_6h)">
                      {{ quota.limit_6h ? Math.round(quota.used_6h / quota.limit_6h * 100) + '%' : '不限' }}
                    </span>
                  </div>
                  <div class="pm-quota-bar">
                    <div class="pm-quota-fill" :style="quotaBarStyle(quota.used_6h, quota.limit_6h)" />
                  </div>
                </div>
                <div class="pm-quota-item">
                  <div class="pm-quota-row">
                    <span class="pm-quota-label">本周</span>
                    <span class="pm-quota-pct" :class="quotaPctClass(quota.used_weekly, quota.limit_weekly)">
                      {{ quota.limit_weekly ? Math.round(quota.used_weekly / quota.limit_weekly * 100) + '%' : '不限' }}
                    </span>
                  </div>
                  <div class="pm-quota-bar">
                    <div class="pm-quota-fill" :style="quotaBarStyle(quota.used_weekly, quota.limit_weekly)" />
                  </div>
                </div>
              </template>
            </div>

            <div class="pm-sep"></div>

            <div class="pm-section">
              <div class="pm-section-label">回复风格</div>
              <div class="pm-field-row">
                <div class="pm-field-desc">
                  <span class="pm-field-name">语气</span>
                  <span class="pm-field-hint">咕咕回复时的语气风格</span>
                </div>
                <div class="pm-style-group">
                  <button v-for="opt in TONE_OPTS" :key="opt.value"
                          class="pm-style-chip"
                          :class="{ active: (prefsStore.replyTone ?? 'natural') === opt.value }"
                          @click="prefsStore.saveStyle({ tone: opt.value === 'natural' ? null : opt.value })">
                    {{ opt.label }}
                  </button>
                </div>
              </div>
              <div class="pm-field-row">
                <div class="pm-field-desc">
                  <span class="pm-field-name">回复长度</span>
                  <span class="pm-field-hint">咕咕回复内容的详细程度</span>
                </div>
                <div class="pm-style-group">
                  <button v-for="opt in LENGTH_OPTS" :key="opt.value"
                          class="pm-style-chip"
                          :class="{ active: (prefsStore.replyLength ?? 'medium') === opt.value }"
                          @click="prefsStore.saveStyle({ length: opt.value === 'medium' ? null : opt.value })">
                    {{ opt.label }}
                  </button>
                </div>
              </div>
            </div>

            <div class="pm-sep"></div>

            <div class="pm-section">
              <div class="pm-section-label">对话</div>
              <div class="pm-field-row">
                <div class="pm-field-desc">
                  <span class="pm-field-name">重开浏览器时</span>
                  <span class="pm-field-hint">下次重新打开浏览器，是接着上次的对话、还是开一段新对话</span>
                </div>
                <div class="pm-style-group">
                  <button class="pm-style-chip" :class="{ active: reopenResume }" @click="setReopenResume(true)">接着上次</button>
                  <button class="pm-style-chip" :class="{ active: !reopenResume }" @click="setReopenResume(false)">开新对话</button>
                </div>
              </div>
            </div>

            <div class="pm-sep"></div>

            <div class="pm-section">
              <div class="pm-section-label">记忆</div>
              <div class="pm-field-row">
                <div class="pm-field-desc">
                  <span class="pm-field-name">删除所有记忆</span>
                  <span class="pm-field-hint">清除咕咕记住的关于你的所有事实和对话记录，不可恢复</span>
                </div>
                <button class="pm-danger-btn" :disabled="memoryClearing" @click="clearMemory">
                  {{ memoryClearing ? '清除中…' : '删除记忆' }}
                </button>
              </div>
              <div v-if="memoryMsg" class="pm-msg" :class="memoryMsgType">{{ memoryMsg }}</div>
              <div class="pm-field-row">
                <div class="pm-field-desc">
                  <span class="pm-field-name">删除临时文件</span>
                  <span class="pm-field-hint">清除发给咕咕但未存入文件库的聊天附件（图片、文件等），临时文件 7 天后自动过期</span>
                </div>
                <button class="pm-danger-btn" :disabled="attachClearing" @click="clearAttachments">
                  {{ attachClearing ? '清除中…' : '删除临时文件' }}
                </button>
              </div>
              <div v-if="attachMsg" class="pm-msg" :class="attachMsgType">{{ attachMsg }}</div>
            </div>

          </template>

          <!-- 接入咕咕（个人设置里单独一个面板，放咕咕设置下面）-->
          <template v-if="activeNav === 'im'">
            <div class="pm-section">
              <div class="pm-section-label">接入咕咕</div>

              <!-- 飞书 / QQ：都是自带机器人(BYO)，扫码自动创建+连接 -->
              <template v-for="p in IM_PLATFORMS" :key="p.key">
                <div class="pm-field-row">
                  <div class="pm-field-desc">
                    <span class="pm-field-name">{{ p.label }}</span>
                    <span class="pm-field-hint">{{ p.hint }}</span>
                  </div>
                  <button v-if="!botsOf(p.key).length" class="pm-bind-btn" :disabled="connecting === p.key" @click="startConnect(p.key)">
                    {{ connecting === p.key ? '生成中…' : '扫码连接' }}
                  </button>
                  <span v-else class="pm-field-hint pm-bound-tag">已连接 · 删除后可重连</span>
                </div>

                <div v-for="b in botsOf(p.key)" :key="b.id" class="pm-bot-item">
                  <div class="pm-bot-info">
                    <span class="pm-bot-name">{{ b.name }}<span v-if="b.sandbox" class="pm-bot-tag">沙箱</span></span>
                    <span class="pm-bot-appid">{{ b.app_id }}</span>
                  </div>
                  <button class="pm-mini-toggle" :class="{ on: b.enabled }" @click="toggleBot(b)">{{ b.enabled ? '已启用' : '已停用' }}</button>
                  <button class="pm-bot-del" @click="removeBot(b)">删除</button>
                </div>
              </template>

              <!-- 扫码连接二维码（飞书/QQ 共用，一次只连一个）-->
              <div v-if="connect" class="pm-qr-box">
                <canvas ref="connectCanvas" class="pm-qr-canvas"></canvas>
                <div class="pm-qr-hint">{{ connectHint }}</div>
                <button class="pm-qr-cancel" @click="cancelConnect">取消</button>
              </div>
              <div v-if="connectErr" class="pm-qr-err">{{ connectErr }}</div>
            </div>
          </template>

          <!-- 偏好设置 -->
          <template v-if="activeNav === 'prefs'">
            <div class="pm-section">
              <div class="pm-section-label">外观</div>
              <div class="pm-field-row">
                <div class="pm-field-desc">
                  <span class="pm-field-name">主题</span>
                  <span class="pm-field-hint">界面颜色风格</span>
                </div>
                <div class="pm-coming">咕了</div>
              </div>
              <div class="pm-field-row">
                <div class="pm-field-desc">
                  <span class="pm-field-name">语言</span>
                  <span class="pm-field-hint">界面显示语言</span>
                </div>
                <div class="pm-static">简体中文</div>
              </div>
            </div>

            <div class="pm-sep"></div>

            <div class="pm-section">
              <div class="pm-section-label">工作台</div>
              <div class="pm-field-row">
                <div class="pm-field-desc">
                  <span class="pm-field-name">默认视图</span>
                  <span class="pm-field-hint">打开应用时首先显示的页面</span>
                </div>
                <div class="pm-coming">咕了</div>
              </div>
              <div class="pm-field-row">
                <div class="pm-field-desc">
                  <span class="pm-field-name">项目排序</span>
                  <span class="pm-field-hint">项目列表的默认排序方式</span>
                </div>
                <div class="pm-coming">咕了</div>
              </div>
            </div>

            <div class="pm-sep"></div>

            <div class="pm-section">
              <div class="pm-section-label">日历</div>
              <div class="pm-field-row">
                <div class="pm-field-desc">
                  <span class="pm-field-name">一周起始日</span>
                  <span class="pm-field-hint">日历每周从哪天开始</span>
                </div>
                <div class="pm-coming">咕了</div>
              </div>
              <div class="pm-field-row">
                <div class="pm-field-desc">
                  <span class="pm-field-name">已完成项目显示</span>
                  <span class="pm-field-hint">日历中已完成项目的截止日期显示方式</span>
                </div>
                <div class="pm-style-group">
                  <button class="pm-style-chip" :class="{ active: prefsStore.calendarDoneMode === 'done' }" @click="prefsStore.saveCalendarDoneMode('done')">按完成日</button>
                  <button class="pm-style-chip" :class="{ active: prefsStore.calendarDoneMode === 'deadline' }" @click="prefsStore.saveCalendarDoneMode('deadline')">按截止日</button>
                </div>
              </div>
            </div>

            <div class="pm-sep"></div>

            <div class="pm-section">
              <div class="pm-section-label">通知</div>
              <div class="pm-field-row">
                <div class="pm-field-desc">
                  <span class="pm-field-name">项目截止提醒</span>
                  <span class="pm-field-hint">截止前 3 天发送通知</span>
                </div>
                <div class="pm-coming">咕了</div>
              </div>
            </div>
          </template>

        </div>
      </div>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onUnmounted } from 'vue'
import QRCode from 'qrcode'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { usePreferencesStore } from '@/stores/preferences'
import BaseModal from '@/components/common/BaseModal.vue'
import { authApi, agentApi, userBotsApi, qqConnectApi, feishuConnectApi, wechatConnectApi } from '@/services/api'
import { fireHint } from '@/composables/useOnboarding'
import { PhX, PhSignOut, PhUser, PhShieldCheck, PhSliders, PhCamera, PhBird, PhChatsCircle } from '@phosphor-icons/vue'

const TONE_OPTS   = [
  { value: 'natural', label: '自然' },
  { value: 'formal',  label: '正式' },
  { value: 'lively',  label: '活泼' },
]
const LENGTH_OPTS = [
  { value: 'medium',   label: '适中' },
  { value: 'short',    label: '简短' },
  { value: 'detailed', label: '详细' },
]

const props = defineProps({ show: Boolean })
const emit  = defineEmits(['close'])

const router     = useRouter()
const authStore  = useAuthStore()
const prefsStore = usePreferencesStore()

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

// 重开浏览器是否接续上次对话：存 localStorage『gugu_reopen_resume』，GuguChat onMounted 读它决定接续/新对话
const reopenResume = ref(localStorage.getItem('gugu_reopen_resume') === '1')
function setReopenResume(v) {
  reopenResume.value = v
  localStorage.setItem('gugu_reopen_resume', v ? '1' : '0')
}

// 打开时重置
watch(() => props.show, v => {
  if (v) {
    activeNav.value    = 'info'
    displayName.value  = authStore.user?.displayName ?? ''
    infoMsg.value      = ''
    pwdMsg.value       = ''
    currentPwd.value   = newPwd.value = confirmPwd.value = ''
    reopenResume.value = localStorage.getItem('gugu_reopen_resume') === '1'
  }
})

// 个人信息
const displayName = ref(authStore.user?.displayName ?? '')
const infoSaving  = ref(false)
const infoMsg     = ref('')
const infoMsgType = ref('ok')

watch(() => authStore.user?.displayName, v => { displayName.value = v ?? '' })

async function saveInfo() {
  infoSaving.value  = true
  infoMsg.value     = ''
  try {
    await authStore.updateProfile({ displayName: displayName.value })
    infoMsg.value     = '保存成功'
    infoMsgType.value = 'ok'
  } catch (e) {
    infoMsg.value     = e.message ?? '保存失败'
    infoMsgType.value = 'err'
  } finally {
    infoSaving.value = false
  }
}

// 账号设置
const currentPwd  = ref('')
const newPwd      = ref('')
const confirmPwd  = ref('')
const pwdSaving   = ref(false)
const pwdMsg      = ref('')
const pwdMsgType  = ref('ok')

async function savePwd() {
  pwdMsg.value = ''
  if (newPwd.value.length < 6)           { pwdMsg.value = '新密码至少 6 位'; pwdMsgType.value = 'err'; return }
  if (newPwd.value !== confirmPwd.value) { pwdMsg.value = '两次密码不一致';  pwdMsgType.value = 'err'; return }
  pwdSaving.value = true
  try {
    await authStore.updateProfile({ currentPassword: currentPwd.value, newPassword: newPwd.value })
    pwdMsg.value     = '密码已更新'
    pwdMsgType.value = 'ok'
    currentPwd.value = newPwd.value = confirmPwd.value = ''
  } catch (e) {
    pwdMsg.value     = e.message ?? '修改失败'
    pwdMsgType.value = 'err'
  } finally {
    pwdSaving.value = false
  }
}

// 头像上传
const avatarInput    = ref(null)
const avatarUploading = ref(false)
function triggerAvatarUpload() {
  if (avatarUploading.value) return
  avatarInput.value?.click()
}
async function onAvatarFile(e) {
  const file = e.target.files?.[0]
  if (!file) return
  avatarUploading.value = true
  try {
    await authStore.uploadAvatar(file)
    infoMsg.value     = '头像已更新'
    infoMsgType.value = 'ok'
  } catch (err) {
    infoMsg.value     = err.message || '头像上传失败'
    infoMsgType.value = 'err'
    activeNav.value   = 'info'
  } finally {
    avatarUploading.value = false
    e.target.value = ''
  }
}

// 精力值配额
const quota = ref({ used_6h: 0, limit_6h: null, reset_6h_at: null, used_weekly: 0, limit_weekly: null })
const quotaLoading = ref(false)
const quotaHasData = ref(false)

async function loadQuota() {
  if (!quotaHasData.value) quotaLoading.value = true
  try { quota.value = await authApi.getQuota(); quotaHasData.value = true } catch {}
  finally { quotaLoading.value = false }
}

// 记忆管理
const memoryClearing = ref(false)
const memoryMsg      = ref('')
const memoryMsgType  = ref('ok')

async function clearMemory() {
  if (!confirm('确定要删除咕咕的所有记忆吗？此操作不可恢复。')) return
  memoryClearing.value = true
  memoryMsg.value = ''
  try {
    await agentApi.clearMemory()
    memoryMsg.value    = '记忆已清除'
    memoryMsgType.value = 'ok'
  } catch (e) {
    memoryMsg.value    = e.message ?? '删除失败'
    memoryMsgType.value = 'err'
  } finally {
    memoryClearing.value = false
  }
}

// 临时文件清除
const attachClearing = ref(false)
const attachMsg      = ref('')
const attachMsgType  = ref('ok')

async function clearAttachments() {
  if (!confirm('确定要删除所有临时文件吗？')) return
  attachClearing.value = true
  attachMsg.value = ''
  try {
    const r = await agentApi.clearAttachments()
    attachMsg.value    = r.deleted > 0 ? `已删除 ${r.deleted} 个临时文件` : '没有可删除的临时文件'
    attachMsgType.value = 'ok'
  } catch (e) {
    attachMsg.value    = e.message ?? '删除失败'
    attachMsgType.value = 'err'
  } finally {
    attachClearing.value = false
  }
}

watch(activeNav, (v, old) => {
  if (v === 'gugu') { loadQuota(); loadBots(); memoryMsg.value = ''; attachMsg.value = '' }
  if (old === 'gugu') cancelConnect()
})

// ── 接入咕咕：飞书 / QQ 都是自带机器人(BYO) + 扫码自动连接 ──
const IM_PLATFORMS = [
  { key: 'feishu', label: '飞书（自带机器人）', api: feishuConnectApi,
    hint: '手机飞书扫码 → 授权创建机器人，咕咕自动连接，私聊它直接管项目/文件/日程' },
  { key: 'qqbot', label: 'QQ（自带机器人）', api: qqConnectApi,
    hint: '手机 QQ 扫码 → 选一个机器人授权，咕咕自动连接，私聊它直接管项目/文件/日程' },
  { key: 'wechat', label: '微信（个人微信）', api: wechatConnectApi,
    hint: '手机微信扫码 → 授权个人微信机器人（官方 iLink、无需企业资质），私聊它直接管项目/文件/日程' },
]

const bots = ref([])
const botsOf = (platform) => bots.value.filter(b => b.platform === platform)
async function loadBots() {
  try { const r = await userBotsApi.list(); bots.value = r.items || [] } catch {}
}

// 通用扫码连接（建任务 → 渲染二维码 → 轮询 → 自动写 user_bot）
const connecting = ref('')          // 正在生成二维码的平台 key
const connect = ref(null)           // { platform, id } 连接进行中
const connectHint = ref('')
const connectErr = ref('')
const connectCanvas = ref(null)
const pmBodyRef = ref(null)
let connectPoll = null

async function startConnect(platform) {
  const p = IM_PLATFORMS.find(x => x.key === platform)
  connecting.value = platform; connectErr.value = ''
  try {
    const r = await p.api.start()
    const id = r.poll_id || r.task_id       // 飞书 poll_id / QQ·微信 task_id
    connect.value = { platform, id }
    connectHint.value = platform === 'feishu'
      ? '手机飞书扫码 → 授权创建机器人，授权后自动连接'
      : platform === 'wechat'
      ? '手机微信扫码 → 授权个人微信机器人，授权后自动连接'
      : '手机 QQ 扫码 → 选一个机器人授权，授权后自动连接'
    await nextTick()
    await QRCode.toCanvas(connectCanvas.value, r.scan_url, { width: 180, margin: 1 })
    pmBodyRef.value?.scrollTo({ top: pmBodyRef.value.scrollHeight, behavior: 'smooth' })
    _startConnectPoll(p)
  } catch (e) {
    connectErr.value = e.message || '生成二维码失败'
    connect.value = null
  } finally {
    connecting.value = ''
  }
}

function _startConnectPoll(p) {
  _stopConnectPoll()
  let tries = 0
  connectPoll = setInterval(async () => {
    tries++
    try {
      const r = await p.api.poll(connect.value.id)
      if (r.status === 'success') { cancelConnect(); await loadBots(); fireHint('im_bind') }   // 新手引导：第一次绑定 IM
      else if (r.status === 'expired') { connectErr.value = '二维码已过期，请重新扫码连接'; cancelConnect() }
      else if (r.status === 'fail') { connectErr.value = '连接失败：' + (r.reason || '未知'); cancelConnect() }
    } catch {}
    if (tries > 100) cancelConnect()   // ~5 分钟超时
  }, 3000)
}
function _stopConnectPoll() { if (connectPoll) { clearInterval(connectPoll); connectPoll = null } }

function cancelConnect() {
  _stopConnectPoll()
  connect.value = null
}

async function toggleBot(b) {
  try { await userBotsApi.update(b.id, { enabled: !b.enabled }); await loadBots() }
  catch (e) { connectErr.value = e.message }
}

async function removeBot(b) {
  if (!confirm(`删除「${b.name}」？删除后这个机器人不再连咕咕。`)) return
  try { await userBotsApi.remove(b.id); await loadBots() }
  catch (e) { connectErr.value = e.message }
}

onUnmounted(_stopConnectPoll)

const recoverLabel = computed(() => {
  if (!quota.value.used_6h || !quota.value.reset_6h_at) return '精力充沛'
  const diffMs = new Date(quota.value.reset_6h_at).getTime() - Date.now()
  if (diffMs <= 0) return '精力充沛'
  const totalMin = Math.ceil(diffMs / 60000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  const timeStr = h > 0 ? `${h} 小时 ${m} 分钟` : `${m} 分钟`
  return `${timeStr}后恢复精力`
})

function quotaBarStyle(used, limit) {
  if (!limit) return { width: '8%', background: 'rgba(123,127,178,0.3)' }
  const pct = Math.min(100, (used / limit) * 100)
  const color = pct >= 90 ? 'rgba(200,80,80,0.7)'
              : pct >= 70 ? 'rgba(210,160,60,0.75)'
              : 'linear-gradient(90deg, rgba(123,127,178,0.6), rgba(149,144,196,0.75))'
  return { width: pct + '%', background: color }
}

function quotaPctClass(used, limit) {
  if (!limit) return ''
  const pct = (used / limit) * 100
  return pct >= 90 ? 'pct-danger' : pct >= 70 ? 'pct-warn' : ''
}

function handleLogout() {
  authStore.logout()
  router.push('/login')
  emit('close')
}
</script>

<style scoped>
/* 让 bm-card 背景透明，边缘倒角与 glass-card 一致 */
:deep(.bm-card) {
  background: transparent;
  box-shadow: 0 24px 64px rgba(20,25,50,0.2),
              inset 0 1px 0 rgba(255,255,255,0.95),
              inset 1px 0 0 rgba(255,255,255,0.55);
}

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
.pm-logout:hover { background: rgba(176,120,88,0.08); color: #b07858; border-color: rgba(176,120,88,0.15); }

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
  margin-top: 8px; display: flex; align-items: center; gap: 10px;
  padding: 9px 12px; border-radius: 10px;
  background: rgba(0,0,0,0.02); border: 1px solid rgba(0,0,0,0.06);
}
.pm-bot-info { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.pm-bot-name { font-size: 13px; font-weight: 600; color: var(--text-primary); display: flex; align-items: center; gap: 6px; }
.pm-bot-tag { font-size: 10px; font-weight: 600; color: #b8860b; background: rgba(212,160,23,0.14); padding: 1px 6px; border-radius: 5px; }
.pm-bot-appid { font-size: 11px; color: var(--text-secondary); font-family: 'SF Mono','Consolas',monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pm-mini-toggle {
  flex-shrink: 0; font-size: 11px; padding: 3px 9px; border-radius: 6px; cursor: pointer;
  border: 1px solid rgba(0,0,0,0.1); background: rgba(0,0,0,0.03); color: var(--text-secondary);
}
.pm-mini-toggle.on { color: #2a8c5a; border-color: rgba(42,140,90,0.3); background: rgba(42,140,90,0.08); }
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
