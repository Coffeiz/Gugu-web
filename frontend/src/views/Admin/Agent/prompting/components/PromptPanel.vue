<template>
  <section class="config-card prompts-card">
    <div class="card-head">
      <div class="card-icon" style="--ic:rgba(122,184,200,0.14);--stroke:#7ab8c8"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 6h12M4 10h8M4 14h6"/></svg></div>
      <div class="card-title-block"><h3>系统提示词</h3><p>各 Profile 的 Prompt 模板，支持占位符，保存后热更新</p></div>
      <div class="profile-switcher">
        <button v-for="profile in profiles" :key="profile.profile" class="toggle-btn" :class="{ active: activeProfile === profile.profile }" :data-label="profile.profile" @click="switchProfile(profile.profile)">{{ profileLabels[profile.profile] || profile.profile }}</button>
      </div>
    </div>
    <div v-if="cautions[activeProfile]" class="persona-caution" :class="`persona-caution--${activeProfile}`">{{ cautions[activeProfile] }}</div>
    <div class="prompt-editor-wrap">
      <textarea ref="textarea" v-model="promptContent" class="prompt-textarea scroll-surface scroll-surface--editor" placeholder="输入系统提示词模板…" spellcheck="false" />
      <div class="placeholder-panel"><div class="placeholder-title">可用占位符</div><div v-for="placeholder in placeholders" :key="placeholder.key" class="placeholder-item" title="点击插入" @click="insertPlaceholder(placeholder.key, textarea)"><code>{{ placeholder.key }}</code><span>{{ placeholder.desc }}</span></div></div>
    </div>
    <div class="card-actions"><span class="save-hint" :class="{ error: !!promptError, muted: !promptSaved && !promptError }"><template v-if="promptSaved">✓ 已保存</template><template v-else-if="promptError">{{ promptError }}</template><template v-else>修改后点击保存即时生效，无需重启</template></span><button class="btn-primary" :class="{ loading: promptSaving }" :disabled="promptSaving" @click="savePrompt">{{ promptSaving ? '保存中…' : '保存提示词' }}</button></div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { usePromptConfig } from '../usePromptConfig'
const { activeProfile, profiles, placeholders, promptContent, promptSaving, promptSaved, promptError, refreshProfiles, switchProfile, insertPlaceholder, savePrompt } = usePromptConfig()
const textarea = ref<HTMLTextAreaElement | null>(null)
const profileLabels: Record<string, string> = { persona: '人格', skills: '工具准则', policy: '内容政策', reflection: '记忆反思', compress: '记忆压缩' }
const cautions: Record<string, string> = {
  persona: '⚠️ 这是咕咕的人格设定，所有对话共享。谨慎修改。',
  skills: '🛠️ 这是工具使用准则（Execution Policy），决定咕咕何时调用工具。',
  policy: '🚫 这是内容政策（红线），定义咕咕不参与的话题和专业免责。',
  reflection: '⚠️ 这是记忆反思提炼词，需保持 JSON 输出格式。',
  compress: '⚠️ 这是记忆压缩提炼词，决定近期记忆如何沉淀。',
}
onMounted(refreshProfiles)
</script>

<style scoped>
.config-card { background: rgba(255,255,255,.05); backdrop-filter: blur(24px); border: 1px solid rgba(255,255,255,.09); border-radius: 16px; padding: 22px 24px; color: rgba(255,255,255,.82); }
.card-head { display:flex; align-items:center; gap:13px; margin-bottom:20px; }.card-icon{width:38px;height:38px;border-radius:11px;background:var(--ic);display:flex;align-items:center;justify-content:center;flex-shrink:0}.card-icon svg{width:18px;height:18px;color:var(--stroke)}.card-title-block{flex:1}.card-title-block h3{font-size:14px;font-weight:700}.card-title-block p{font-size:12px;color:rgba(255,255,255,.38);margin-top:2px}.profile-switcher{display:flex;gap:6px;margin-left:auto}.toggle-btn{padding:6px 16px;border-radius:9px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.05);font-size:13px;color:rgba(255,255,255,.38);cursor:pointer}.toggle-btn.active{background:rgba(123,127,178,.2);border-color:rgba(123,127,178,.35);color:rgba(255,255,255,.88);font-weight:600}.persona-caution{margin:0 0 12px;padding:10px 14px;border-radius:10px;font-size:13px;line-height:1.6;background:rgba(214,138,90,.12);border:1px solid rgba(214,138,90,.3);color:#b07043}.persona-caution--skills{background:rgba(123,127,178,.12);border-color:rgba(123,127,178,.3);color:#8f93cc}.persona-caution--policy{background:rgba(214,90,90,.12);border-color:rgba(214,90,90,.3);color:#d08080}.prompt-editor-wrap{display:grid;grid-template-columns:1fr 200px;gap:14px;min-height:380px}.prompt-textarea{width:100%;min-height:380px;background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.09);border-radius:10px;padding:14px 16px;font-family:monospace;font-size:13px;line-height:1.7;color:rgba(255,255,255,.82);resize:vertical;outline:none;box-sizing:border-box}.prompt-textarea:focus{border-color:rgba(123,127,178,.4)}.placeholder-panel{display:flex;flex-direction:column;gap:6px}.placeholder-title{font-size:11px;color:rgba(255,255,255,.25);margin-bottom:2px}.placeholder-item{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:8px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);cursor:pointer}.placeholder-item:hover{background:rgba(123,127,178,.12)}.placeholder-item code{font-family:monospace;font-size:12px;color:rgba(149,144,196,.9)}.placeholder-item span{font-size:11px;color:rgba(255,255,255,.3)}.card-actions{display:flex;align-items:center;gap:10px;margin-top:18px;padding-top:16px;border-top:1px solid rgba(255,255,255,.07)}.save-hint{flex:1;font-size:12px;color:#5ab899}.save-hint.muted{color:rgba(255,255,255,.28)}.save-hint.error{color:#e07878}.btn-primary{padding:6px 16px;border:0;border-radius:9px;background:linear-gradient(135deg,#7b7fb2,#9590c4);color:#fff;font-size:13px;font-weight:600;cursor:pointer}.btn-primary:disabled{opacity:.5;cursor:default}@media(max-width:900px){.prompt-editor-wrap{grid-template-columns:1fr}.profile-switcher{flex-wrap:wrap;margin-left:0}}
</style>
