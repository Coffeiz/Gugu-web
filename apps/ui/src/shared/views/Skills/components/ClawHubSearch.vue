<script lang="ts">
import type { ClawHubPreview as CachedPreview, ClawHubSkill as CachedSkill, userSkillsApi as skillsApi } from '@/services/api'

type TrendingRequest = typeof skillsApi.trendingClawHub
type TrendingResult = Awaited<ReturnType<TrendingRequest>>
interface PopularCache {
  result?: TrendingResult
  expiresAt: number
  pending?: Promise<TrendingResult>
}

const popularCache = new WeakMap<TrendingRequest, PopularCache>()
const popularCacheTtl = 5 * 60_000
const previewCaches = new WeakMap<typeof skillsApi.previewClawHub, {
  results: Map<string, { value: CachedPreview; expiresAt: number }>
  pending: Map<string, Promise<CachedPreview>>
}>()
const previewCacheTtl = 5 * 60_000
const previewCacheLimit = 20

const popularStorageKey = 'gugu.clawhub.popular.v1'

function isCachedSkill(value: unknown): value is CachedSkill {
  if (!value || typeof value !== 'object') return false
  const { slug, name, description, version, owner, reference, url, downloads } = value as Record<string, unknown>
  return typeof slug === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(slug)
    && typeof owner === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/u.test(owner)
    && typeof name === 'string' && typeof description === 'string'
    && (version === null || typeof version === 'string')
    && reference === `${owner}/${slug}` && url === `https://clawhub.ai/${owner}/skills/${slug}`
    && (downloads == null || (typeof downloads === 'number' && Number.isFinite(downloads) && downloads >= 0))
}

function readPopularCache(): PopularCache {
  try {
    const raw = localStorage.getItem(popularStorageKey)
    if (raw && raw.length <= 512_000) {
      const { result, expiresAt } = JSON.parse(raw)
      if (Number.isSafeInteger(expiresAt) && Array.isArray(result?.skills)
        && result.skills.length <= 100 && result.skills.every(isCachedSkill)) {
        return { result, expiresAt: Math.min(expiresAt, Date.now() + popularCacheTtl) }
      }
    }
  } catch { /* 存储被禁用或记录损坏时继续在线加载。 */ }
  return { expiresAt: 0 }
}

function persistPopularCache(cache: PopularCache) {
  try {
    localStorage.setItem(popularStorageKey, JSON.stringify({ result: cache.result, expiresAt: cache.expiresAt }))
  } catch { /* 存储不可写时仍保留本次会话缓存。 */ }
}
</script>

<script setup lang="ts">
import { computed, inject, onMounted, ref, useId, watch } from 'vue'
import DOMPurify from 'dompurify'
import BaseModal from '@/components/common/overlays/BaseModal.vue'
import CloseButton from '@/components/common/overlays/CloseButton.vue'
import Icon from '@/components/common/icons/Icon.vue'
import { renderMarkdown } from '@/utils/markdown'
import { useI18n } from 'vue-i18n'
import { userSkillsApi, type ClawHubPreview, type ClawHubSkill } from '@/services/api'
import { skillAccessKey } from '@/services/resourceAccess'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import { showAppError, showAppSuccess } from '@/composables/core/useAppToast'
import { notifyResourceChanged } from '@/services/resourceRefreshEvents'

const props = defineProps<{ installedSlugs: ReadonlySet<string> }>()
const api = inject(skillAccessKey, null)?.api ?? userSkillsApi
const { t, d, n } = useI18n()
const cache = popularCache.get(api.trendingClawHub) ?? readPopularCache()
popularCache.set(api.trendingClawHub, cache)
const query = ref('')
const skills = ref<ClawHubSkill[]>([])
const popularSkills = ref<ClawHubSkill[]>(cache.result?.skills ?? [])
const loading = ref(false)
const loadingPopular = ref(false)
const popularError = ref('')
const searched = ref(false)
const error = ref('')
const installing = ref('')
const confirmedInstalls = ref(new Set<string>())
watch(() => props.installedSlugs, slugs => {
  for (const slug of slugs) confirmedInstalls.value.delete(slug)
})

function isInstalled(skill: ClawHubSkill) {
  return props.installedSlugs.has(skill.slug) || confirmedInstalls.value.has(skill.slug)
}
const selected = ref<ClawHubSkill | null>(null)
const detailTitleId = useId()
const preview = ref('')
const previewLoading = ref(false)
const previewFailed = ref(false)
const previewHtml = computed(() => DOMPurify.sanitize(renderMarkdown(preview.value, { allowHtml: false }), {
  FORBID_TAGS: ['img', 'audio', 'video', 'source', 'iframe', 'svg', 'style'],
  FORBID_ATTR: ['style'],
  ADD_ATTR: ['target'],
}))
const details = ref<ClawHubPreview['details']>()
let previewGeneration = 0

async function openDetails(skill: ClawHubSkill) {
  const current = ++previewGeneration
  selected.value = skill
  const key = JSON.stringify([skill.reference, skill.version])
  const cache = previewCaches.get(api.previewClawHub) ?? { results: new Map(), pending: new Map() }
  previewCaches.set(api.previewClawHub, cache)
  const cached = cache.results.get(key)
  cache.results.delete(key)
  const fresh = cached && Date.now() < cached.expiresAt ? cached : undefined
  preview.value = fresh?.value.body.trim() ?? ''
  details.value = fresh?.value.details
  previewFailed.value = false
  previewLoading.value = !fresh
  if (fresh) {
    cache.results.set(key, fresh)
    return
  }

  let request = cache.pending.get(key)
  if (!request) {
    request = Promise.resolve().then(() => api.previewClawHub(skill.reference)).then(result => {
      cache.results.set(key, { value: result, expiresAt: Date.now() + previewCacheTtl })
      if (cache.results.size > previewCacheLimit) {
        const oldest = cache.results.keys().next()
        if (!oldest.done) cache.results.delete(oldest.value)
      }
      return result
    }).finally(() => { cache.pending.delete(key) })
    cache.pending.set(key, request)
  }
  try {
    const result = await request
    if (current === previewGeneration) {
      preview.value = result.body.trim()
      details.value = result.details
    }
  } catch {
    if (current === previewGeneration) previewFailed.value = true
  } finally {
    if (current === previewGeneration) previewLoading.value = false
  }
}

function closeDetails() {
  previewGeneration++
  selected.value = null
}
let generation = 0
async function loadPopular() {
  if (cache.result) popularSkills.value = cache.result.skills
  if (Date.now() < cache.expiresAt) return

  loadingPopular.value = !cache.result
  popularError.value = ''
  cache.pending ??= Promise.resolve().then(() => api.trendingClawHub()).then(result => {
    cache.result = result
    cache.expiresAt = Date.now() + popularCacheTtl
    persistPopularCache(cache)
    return result
  }).finally(() => { cache.pending = undefined })
  try { popularSkills.value = (await cache.pending).skills }
  catch {
    if (!cache.result) popularError.value = t('clawhub.popularFailed')
  } finally { loadingPopular.value = false }
}
async function search() {
  const value = query.value.trim()
  if (!value || loading.value) return
  const current = ++generation
  loading.value = true
  error.value = ''
  skills.value = []
  searched.value = false
  try {
    const result = await api.searchClawHub(value)
    if (current === generation) { skills.value = result.skills; searched.value = true }
  } catch {
    if (current === generation) error.value = t('clawhub.searchFailed')
  } finally { if (current === generation) loading.value = false }
}
onMounted(() => { void loadPopular() })
async function install(skill: ClawHubSkill) {
  if (installing.value || isInstalled(skill)) return
  installing.value = skill.reference
  try {
    const { id } = await api.installClawHub(skill.reference)
    if (!props.installedSlugs.has(id)) confirmedInstalls.value.add(id)
    notifyResourceChanged('skills')
    showAppSuccess(t('clawhub.installed', { name: skill.name }))
  } catch (cause) {
    showAppError(cause instanceof Error ? cause.message : t('clawhub.installFailed'))
  } finally { installing.value = '' }
}
</script>

<template>
  <section class="clawhub" :aria-label="t('clawhub.searchSkills')">
    <form class="clawhub-search" @submit.prevent="search">
      <input v-model="query" class="form-input" :aria-label="t('clawhub.searchSkills')" :placeholder="t('clawhub.searchSkills')" maxlength="200" />
      <ActionButton fit type="submit" :disabled="loading || !query.trim()">{{ loading ? t('clawhub.searching') : t('clawhub.search') }}</ActionButton>
    </form>
    <p v-if="error" role="alert" class="clawhub-status">{{ error }}</p>
    <p v-else-if="searched && !skills.length" class="clawhub-status">{{ t('clawhub.noResults') }}</p>
    <div v-else-if="searched" class="clawhub-results">
      <article v-for="skill in skills" :key="skill.reference" class="clawhub-card">
        <div class="clawhub-card-head"><h3>{{ skill.name }}</h3><span>{{ skill.owner }}</span></div>
        <p>{{ skill.description }}</p>
        <footer class="clawhub-actions app-card-actions">
          <ActionButton fit variant="secondary" aria-haspopup="dialog" @click="openDetails(skill)">
            {{ t('clawhub.viewDetails') }} <Icon name="action.chevron-next" :size="14" />
          </ActionButton>
          <ActionButton fit :variant="isInstalled(skill) ? 'secondary' : 'primary'"
            :disabled="Boolean(installing) || isInstalled(skill)" @click="install(skill)">
            <Icon :name="isInstalled(skill) ? 'status.success' : 'action.download'" :size="14" />
            {{ isInstalled(skill) ? t('clawhub.alreadyInstalled') : installing === skill.reference ? t('clawhub.installing') : t('clawhub.install') }}
          </ActionButton>
        </footer>
      </article>
    </div>
    <section v-else class="clawhub-popular" :aria-label="t('clawhub.popularSkills')">
      <div class="clawhub-section-heading"><h2>{{ t('clawhub.popularSkills') }}</h2><span>{{ t('clawhub.popularHint') }}</span></div>
      <p v-if="loadingPopular" class="clawhub-status" aria-live="polite">{{ t('clawhub.searching') }}</p>
      <p v-else-if="popularError" role="status" class="clawhub-status">{{ popularError }}</p>
      <div v-else class="clawhub-results">
        <article v-for="(skill, index) in popularSkills" :key="skill.reference" class="clawhub-card">
          <div class="clawhub-card-head"><div class="clawhub-title"><span class="clawhub-rank">{{ index + 1 }}</span><h3>{{ skill.name }}</h3></div><span>{{ skill.owner }}</span></div>
          <p>{{ skill.description }}</p>
          <footer class="clawhub-actions app-card-actions">
            <span v-if="skill.downloads != null" class="clawhub-downloads">{{ t('clawhub.downloads', { count: skill.downloads.toLocaleString() }) }}</span>
            <ActionButton fit variant="secondary" aria-haspopup="dialog" @click="openDetails(skill)">
              {{ t('clawhub.viewDetails') }} <Icon name="action.chevron-next" :size="14" />
            </ActionButton>
            <ActionButton fit :variant="isInstalled(skill) ? 'secondary' : 'primary'"
              :disabled="Boolean(installing) || isInstalled(skill)" @click="install(skill)">
              <Icon :name="isInstalled(skill) ? 'status.success' : 'action.download'" :size="14" />
              {{ isInstalled(skill) ? t('clawhub.alreadyInstalled') : installing === skill.reference ? t('clawhub.installing') : t('clawhub.install') }}
            </ActionButton>
          </footer>
        </article>
      </div>
    </section>
    <BaseModal :show="Boolean(selected)" width="900px" background="var(--panel-bg)" teleport-to="body" @close="closeDetails">
      <section v-if="selected" class="clawhub-detail card-close-anchor" role="dialog" :aria-labelledby="detailTitleId">
        <header class="clawhub-detail-header">
          <span class="clawhub-detail-icon"><Icon name="resource.skill" :size="24" /></span>
          <div>
            <h2 :id="detailTitleId">{{ selected.name }}</h2>
            <p>{{ selected.owner }}</p>
          </div>
          <CloseButton card-corner @click="closeDetails" />
        </header>
        <div class="clawhub-detail-layout">
          <div class="clawhub-detail-body scroll-surface" :aria-busy="previewLoading">
            <p v-if="selected.description" class="clawhub-summary">{{ selected.description }}</p>
            <h3 class="clawhub-document-title">SKILL.md</h3>
            <div class="clawhub-document">
              <p v-if="previewLoading" class="clawhub-status" role="status">{{ t('clawhub.previewLoading') }}</p>
              <div v-else-if="previewFailed" class="clawhub-preview-error">
                <p class="clawhub-status" role="alert">{{ t('clawhub.previewFailed') }}</p>
                <ActionButton fit variant="secondary" @click="openDetails(selected)">{{ t('clawhub.retryPreview') }}</ActionButton>
              </div>
              <div v-else-if="preview" class="clawhub-markdown md-view" v-html="previewHtml" />
              <p v-else class="clawhub-status">{{ t('clawhub.previewEmpty') }}</p>
            </div>
          </div>
          <aside class="clawhub-detail-side">
            <dl class="clawhub-detail-meta">
              <div><dt>{{ t('clawhub.sourceLabel') }}</dt><dd>ClawHub · @{{ selected.owner }}</dd></div>
              <div v-if="details?.version || selected.version"><dt>{{ t('clawhub.versionLabel') }}</dt><dd>{{ details?.version || selected.version }}</dd></div>
              <div v-if="details?.updatedAt"><dt>{{ t('clawhub.updatedLabel') }}</dt><dd>{{ d(details.updatedAt, { dateStyle: 'medium' }) }}</dd></div>
              <div v-if="details?.license"><dt>{{ t('clawhub.licenseLabel') }}</dt><dd>{{ details.license }}</dd></div>
              <div v-if="(details?.downloads ?? selected.downloads) != null"><dt>{{ t('clawhub.downloadLabel') }}</dt><dd>{{ n((details?.downloads ?? selected.downloads)!) }}</dd></div>
              <div v-if="details?.installs != null"><dt>{{ t('clawhub.installLabel') }}</dt><dd>{{ n(details.installs) }}</dd></div>
              <div v-if="details?.stars != null"><dt>{{ t('clawhub.starsLabel') }}</dt><dd>{{ n(details.stars) }}</dd></div>
            </dl>
            <div class="clawhub-detail-actions">
              <ActionButton fit :variant="isInstalled(selected) ? 'secondary' : 'primary'"
                :disabled="Boolean(installing) || isInstalled(selected)" @click="install(selected)">
                <Icon :name="isInstalled(selected) ? 'status.success' : 'action.download'" :size="14" />
                {{ isInstalled(selected) ? t('clawhub.alreadyInstalled') : installing === selected.reference ? t('clawhub.installing') : t('clawhub.install') }}
              </ActionButton>
              <ActionButton fit variant="secondary" :href="selected.url" target="_blank" rel="noopener noreferrer">
                {{ t('clawhub.openWebsite') }} <Icon name="action.expand" :size="14" />
              </ActionButton>
            </div>
          </aside>
        </div>
      </section>
    </BaseModal>
  </section>
</template>

<style scoped>
.clawhub { display: grid; gap: var(--space-lg); }
.clawhub-search { display: flex; gap: var(--space-sm); }
.clawhub-search input { flex: 1; min-width: 0; }
.clawhub-results { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); gap: var(--space-xs); }
.clawhub-card { display: flex; flex-direction: column; min-width: 0; --card-actions-inset: var(--space-md); padding: var(--card-actions-inset) var(--card-actions-inset) 0; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: var(--file-card-bg); box-shadow: var(--card-shadow); }
.clawhub-card-head { display: flex; justify-content: space-between; gap: var(--space-sm); align-items: baseline; }
.clawhub-title { display:flex; align-items:center; gap:var(--space-sm); min-width:0; }
.clawhub-rank { display:grid; place-items:center; flex:0 0 24px; width:24px; height:24px; border-radius:var(--radius-full); color:var(--accent-fg); background:var(--accent-subtle); font-size:var(--font-size-xs); font-weight:700; }
.clawhub-card h3 { margin: 0; font-size: var(--font-size-body); overflow-wrap: anywhere; }
.clawhub-card-head span, .clawhub-card p, .clawhub-status { color: var(--content-secondary); font-size: var(--font-size-sm); line-height: var(--line-height-body); }
.clawhub-card-head span { overflow-wrap: anywhere; }
.clawhub-card p { margin: var(--space-xs) 0 var(--space-md); overflow-wrap: anywhere; }
.clawhub-actions {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-sm);
  margin-top: auto;
}
.clawhub-section-heading { display:flex; align-items:baseline; gap:var(--space-md); margin-bottom:var(--space-md); }
.clawhub-section-heading h2 { margin:0; color:var(--text-primary); font-size:var(--font-size-heading-sm); }
.clawhub-section-heading span, .clawhub-downloads { color:var(--content-secondary); font-size:var(--font-size-xs); }
.clawhub-downloads { margin-right:auto; }
.clawhub-detail {
  display: flex; flex-direction: column; min-width: 0; max-height: min(84dvh, 780px);
  container-type: inline-size;
}
.clawhub-detail-header {
  display: flex; align-items: center; gap: var(--space-md);
  padding: var(--space-lg) calc(2 * var(--space-xl)) var(--space-lg) var(--space-lg);
  border-bottom: 1px solid var(--border-strong);
}
.clawhub-detail-icon {
  display: grid; place-items: center; flex: 0 0 48px; height: 48px;
  border-radius: var(--radius-sm); background: var(--accent-subtle); color: var(--accent-fg);
}
.clawhub-detail-header h2 { margin: 0; font-size: 22px; line-height: 1.25; overflow-wrap: anywhere; }
.clawhub-detail-header p { margin: var(--space-xs) 0 0; color: var(--content-secondary); overflow-wrap: anywhere; }
.clawhub-detail-layout { display: grid; grid-template-columns: minmax(0, 1fr) 192px; min-height: 0; }
.clawhub-detail-body { min-height: 0; overflow: auto; padding: var(--space-lg); }
.clawhub-summary { margin: 0 0 var(--space-lg); color: var(--content-secondary); line-height: 1.65; overflow-wrap: anywhere; }
.clawhub-document-title { margin: 0 0 var(--space-sm); font-size: var(--font-size-sm); }
.clawhub-document {
  min-width: 0; padding: clamp(14px, 3cqi, 24px); border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm); background: var(--file-card-bg);
}
.clawhub-document > .clawhub-status { margin: 0; }
.clawhub-detail-side {
  display: flex; flex-direction: column; gap: var(--space-md); min-width: 0;
  padding: var(--space-lg); border-inline-start: 1px solid var(--border-strong);
}
.clawhub-detail-meta { display: grid; gap: var(--space-xs); color: var(--content-secondary); font-size: var(--font-size-sm); overflow-wrap: anywhere; }
.clawhub-detail-meta { margin: 0; }
.clawhub-detail-meta dt { font-size: var(--font-size-xs); }
.clawhub-detail-meta dd { margin: 0; color: var(--content-primary); font-weight: 600; }
.clawhub-detail-actions { display: flex; flex-direction: column; gap: var(--space-sm); }
.clawhub-preview-error { display: flex; flex-wrap: wrap; gap: var(--space-sm); align-items: center; }
.clawhub-markdown { color: var(--content-primary); font-size: 14px; line-height: 1.7; overflow-wrap: anywhere; }
.clawhub-markdown :deep(:is(h1, h2, h3, h4, h5, h6)) { margin: 1.35em 0 .45em; line-height: 1.3; font-weight: 650; }
.clawhub-markdown :deep(h1) { font-size: 1.6em; }
.clawhub-markdown :deep(h2) { font-size: 1.33em; }
.clawhub-markdown :deep(:is(h3, h4, h5, h6)) { font-size: 1.1em; }
.clawhub-markdown > :deep(:first-child) { margin-top: 0; }
.clawhub-markdown :deep(:is(p, ul, ol, pre, blockquote, table)) { margin: .75em 0; }
.clawhub-markdown > :deep(:last-child) { margin-bottom: 0; }
.clawhub-markdown :deep(:is(ul, ol)) { padding-inline-start: 1.5em; }
.clawhub-markdown :deep(ul) { list-style: disc; }
.clawhub-markdown :deep(ol) { list-style: decimal; }
.clawhub-markdown :deep(li + li) { margin-top: .25em; }
.clawhub-markdown :deep(blockquote) {
  border-inline-start: 3px solid var(--border-strong); padding: .3em .85em; color: var(--content-secondary);
}
.clawhub-markdown :deep(:is(pre, table)) { max-width: 100%; overflow-x: auto; }
.clawhub-markdown :deep(pre) {
  padding: .85em 1em; border: 1px solid var(--border-strong); border-radius: var(--radius-xs);
  background: var(--panel-bg); font-family: var(--font-mono, var(--font-family-mono)); white-space: pre;
}
.clawhub-markdown :deep(table) { display: block; border-collapse: collapse; }
.clawhub-markdown :deep(:is(th, td)) { padding: .35em .6em; border: 1px solid var(--border-strong); }
.clawhub-markdown :deep(a) { text-decoration: underline; }
@container (max-width: 620px) {
  .clawhub-detail-layout { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) auto; }
  .clawhub-detail-side { border-inline-start: 0; border-top: 1px solid var(--border-strong); gap: var(--space-sm); padding-block: var(--space-sm); }
  .clawhub-detail-meta { display: flex; flex-wrap: wrap; gap: var(--space-sm) var(--space-md); }
  .clawhub-detail-actions { flex-direction: row-reverse; justify-content: space-between; flex-wrap: wrap; }
}
</style>
