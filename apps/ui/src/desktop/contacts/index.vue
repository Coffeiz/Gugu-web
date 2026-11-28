<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ContactRelated from './components/ContactRelated.vue'
import { RiArrowLeftLine, RiEditLine, RiStarFill, RiStarLine, RiUser3Line, RiUserAddLine, RiDeleteBinLine } from '@remixicon/vue'
import FirstUseEmptyState from '@/components/common/layout/FirstUseEmptyState.vue'
import SearchInput from '@/components/common/controls/SearchInput.vue'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import { pinyin } from 'pinyin-pro'
import type { DesktopClientFields } from '@gugu/core/desktop'
import FileListSortArrow from '@/views/Files/components/FileListSortArrow.vue'
import ContactInformation from './components/ContactInformation.vue'
import type { ClientRow } from '@desktop/bridge/bridge'

const props = defineProps<{
  clients: ClientRow[]
  busy: boolean
  saveContact: (fields: DesktopClientFields, id?: number) => Promise<ClientRow | undefined>
}>()
const emit = defineEmits<{ remove: [client: ClientRow] }>()
const route = useRoute()
const router = useRouter()
const editingId = ref<number>()
const draft = ref<DesktopClientFields>({ name: '' })
const nameInput = ref<HTMLInputElement>()
const descending = ref(false)
const collator = new Intl.Collator('zh-CN', { sensitivity: 'base', numeric: true })
const nameKeys = computed(() => new Map(props.clients.map(client => [
  client.id, pinyin(client.name.trim().normalize('NFKD').replace(/\p{Mark}/gu, ''), { toneType: 'none' }),
])))

function readIds(key: string): number[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(value) ? value.filter(id => typeof id === 'number' && Number.isSafeInteger(id)) : []
  } catch { return [] }
}

const starredKey = 'gugu.desktop.contacts.starred'
const starred = ref(readIds(starredKey))
watch(starred, favorites => {
  try {
    localStorage.setItem(starredKey, JSON.stringify(favorites))
  } catch { /* 当前窗口仍可保留筛选状态。 */ }
})

const filters = [
  { id: 'all', label: 'pageUi.allContacts', icon: RiUser3Line },
  { id: 'starred', label: 'pageUi.starredContacts', icon: RiStarLine },
] as const
const filter = ref<typeof filters[number]['id']>('all')
const query = ref('')
const selectedId = ref<number>()
const reading = ref(false)
const creating = ref(false)
const favoriteIds = computed(() => new Set(starred.value))
const starredClients = computed(() => props.clients.filter(client => favoriteIds.value.has(client.id)))
const counts = computed(() => ({ all: props.clients.length, starred: starredClients.value.length }))
const filtered = computed(() => {
  const term = query.value.trim().toLocaleLowerCase()
  const source = filter.value === 'starred' ? starredClients.value : props.clients
  return source.filter(client => [client.name, client.email, client.phone, client.address, nameKeys.value.get(client.id)]
    .some(value => value?.toLocaleLowerCase().includes(term)))
    .sort((left, right) => {
      const order = collator.compare(nameKeys.value.get(left.id) ?? '', nameKeys.value.get(right.id) ?? '')
      return (descending.value ? -order : order) || left.id - right.id
    })
})
const groups = computed(() => {
  const grouped = new Map<string, ClientRow[]>()
  for (const client of filtered.value) {
    const initial = nameKeys.value.get(client.id)?.[0]?.toUpperCase() ?? ''
    const label = /^[A-Z]$/.test(initial) ? initial : '#'
    const group = grouped.get(label)
    if (group) group.push(client)
    else grouped.set(label, [client])
  }
  const symbols = grouped.get('#')
  grouped.delete('#')
  return [...Array.from(grouped, ([label, clients]) => ({ label, clients })),
    ...(symbols ? [{ label: '#', clients: symbols }] : [])]
})
const selected = computed(() => filtered.value.find(client => client.id === selectedId.value) ?? filtered.value[0])

function select(client: ClientRow) {
  selectedId.value = client.id
  reading.value = true
  creating.value = false
  editingId.value = undefined
}

watch([() => route.query.object_id, () => props.clients], ([target, clients]) => {
  const client = clients.find(row => row.id === Number(target))
  if (!client) return
  query.value = ''
  filter.value = 'all'
  select(client)
  void router.replace({ query: { ...route.query, object_id: undefined } })
}, { immediate: true })

function startCreate() {
  creating.value = true
  reading.value = true
  editingId.value = undefined
  draft.value = { name: '' }
  void nextTick(() => nameInput.value?.focus())
}

function startEdit({ id, name, email, phone, address, notes }: ClientRow) {
  selectedId.value = id
  editingId.value = id
  draft.value = { name, email, phone, address, notes }
  void nextTick(() => nameInput.value?.focus())
}

function cancelEdit() {
  if (creating.value) reading.value = false
  creating.value = false
  editingId.value = undefined
}

async function save() {
  const fields = draft.value
  if (props.busy || !fields.name.trim()) return
  const isNew = creating.value
  const saved = await props.saveContact({
    name: fields.name.trim(),
    email: fields.email?.trim() || null,
    phone: fields.phone?.trim() || null,
    address: fields.address?.trim() || null,
    notes: fields.notes ?? '',
  }, editingId.value)
  if (!saved || draft.value !== fields || (isNew ? !creating.value : editingId.value !== saved.id)) return
  if (isNew) {
    filter.value = 'all'
    query.value = ''
  }
  select(saved)
}

function toggleStar(id: number) {
  starred.value = favoriteIds.value.has(id) ? starred.value.filter(value => value !== id) : [...starred.value, id]
}

watch(selected, client => {
  if (editingId.value !== undefined && editingId.value !== client?.id) editingId.value = undefined
})
</script>

<template>
  <section id="desktop-clients" class="mail-page contacts-page" :aria-label="$t('pageUi.contacts')">
    <div class="mail-columns" :class="{ 'show-reading': reading }">
      <nav class="glass-card mail-folders" data-overlay-scrollbar-owner :aria-label="$t('pageUi.contactCategories')">
        <header class="mail-pane-toolbar contacts-toolbar">
          <h2>{{ $t('pageUi.contacts') }}</h2>
          <ActionButton fit :aria-label="$t('pageUi.newContact')" :title="$t('pageUi.newContact')" :disabled="busy" @click="startCreate"><RiUserAddLine size="16px" aria-hidden="true" /></ActionButton>
        </header>
        <div class="mail-pane-scroll scroll-surface">
          <button v-for="item in filters" :key="item.id" type="button" class="mail-nav-row"
            :aria-pressed="filter === item.id" @click="filter = item.id; reading = false; cancelEdit()">
            <component :is="item.icon" class="mail-nav-icon" size="15px" aria-hidden="true" />
            <span>{{ $t(item.label) }}</span><span class="mail-nav-count">{{ counts[item.id] }}</span>
          </button>
        </div>
      </nav>

      <section class="glass-card mail-list" data-overlay-scrollbar-owner :aria-label="$t('pageUi.contactList')">
        <header class="mail-pane-toolbar contacts-toolbar contacts-list-toolbar">
          <SearchInput v-model="query" class="contacts-search" :placeholder="$t('pageUi.searchContacts')" clearable />
          <ActionButton class="contacts-sort" fit variant="secondary"
            :aria-label="descending ? $t('pageUi.sortContactDescending') : $t('pageUi.sortContactAscending')"
            @click="descending = !descending">
            <span>{{ $t('pageUi.name') }}</span>
            <FileListSortArrow :descending="descending" />
          </ActionButton>
        </header>
        <div class="contacts-scroll scroll-surface" :class="{ 'empty-state-viewport': !filtered.length }">
          <section v-for="group in groups" :key="group.label">
            <h3 v-if="group.label" class="contacts-group-label">{{ group.label }}</h3>
            <div v-for="client in group.clients" :key="client.id" class="contacts-row" :class="{ selected: selected?.id === client.id }">
              <button type="button" class="contacts-person" :aria-pressed="selected?.id === client.id" @click="select(client)">
                <span class="contacts-avatar" aria-hidden="true">{{ Array.from(client.name.trim())[0] }}</span>
                <span class="contacts-person-copy">
                  <strong>{{ client.name }}</strong>
                  <small v-if="client.email?.trim()">{{ client.email.trim() }}</small>
                </span>
              </button>
              <button type="button" class="contacts-star" :aria-label="$t(favoriteIds.has(client.id) ? 'pageUi.unstarNamed' : 'pageUi.starNamed', { name: client.name })"
                :aria-pressed="favoriteIds.has(client.id)" @click="toggleStar(client.id)">
                <RiStarFill v-if="favoriteIds.has(client.id)" size="18px" aria-hidden="true" />
                <RiStarLine v-else size="18px" aria-hidden="true" />
              </button>
            </div>
          </section>
          <FirstUseEmptyState v-if="!filtered.length"
            :title="query.trim() ? $t('pageUi.noContactMatch') : $t('pageUi.noContacts')"
            :description="query.trim() ? $t('pageUi.tryAnother') : filter === 'starred' ? $t('pageUi.starredContactsHint') : $t('pageUi.newContactHint')">
            <template #icon><RiUser3Line size="22px" /></template>
          </FirstUseEmptyState>
        </div>
      </section>

      <section class="glass-card mail-content contacts-detail" data-overlay-scrollbar-owner :aria-label="$t('pageUi.contactDetails')">
        <div class="contacts-scroll scroll-surface" :class="{ 'empty-state-viewport': !creating && !selected }">
          <ActionButton class="contacts-back" fit variant="secondary" @click="reading = false; cancelEdit()">
            <RiArrowLeftLine size="16px" aria-hidden="true" /> {{ $t('pageUi.backToList') }}
          </ActionButton>
          <template v-if="creating || selected">
            <div class="contacts-profile">
              <span v-if="!creating && selected" class="contacts-avatar contacts-avatar--large" aria-hidden="true">{{ Array.from(selected.name.trim())[0] }}</span>
              <div class="contacts-identity">
                <input v-if="creating || editingId === selected?.id" ref="nameInput" v-model="draft.name"
                  class="form-input contact-name-input" form="contact-details-form" :aria-label="$t('pageUi.contactName')"
                  :placeholder="$t('pageUi.enterContactName')" required maxlength="200" :disabled="busy" />
                <h2 v-else>{{ selected?.name }}</h2>
              </div>
              <div v-if="!creating && selected" class="contacts-profile-actions">
                <ActionButton fit variant="secondary" :aria-label="favoriteIds.has(selected.id) ? $t('pageUi.unstar') : $t('pageUi.star')" :aria-pressed="favoriteIds.has(selected.id)" @click="toggleStar(selected.id)">
                  <RiStarFill v-if="favoriteIds.has(selected.id)" size="18px" aria-hidden="true" />
                  <RiStarLine v-else size="18px" aria-hidden="true" />
                </ActionButton>
                <ActionButton fit variant="secondary" :aria-label="$t('pageUi.editContact')" :title="$t('pageUi.editContact')" :disabled="busy" @click="startEdit(selected)"><RiEditLine size="18px" aria-hidden="true" /></ActionButton>
                <ActionButton fit variant="secondary" :aria-label="$t('pageUi.deleteContact')" :disabled="busy" @click="emit('remove', selected)"><RiDeleteBinLine size="18px" aria-hidden="true" /></ActionButton>
              </div>
            </div>
            <ContactInformation v-if="creating || editingId === selected?.id" v-model="draft" editing :busy="busy" @save="save" @cancel="cancelEdit" />
            <ContactInformation v-else-if="selected" :model-value="selected" :editing="false" :busy="busy" />
            <ContactRelated v-if="selected && !creating && editingId !== selected.id" :key="selected.id" :contact-id="selected.id" />
          </template>
          <FirstUseEmptyState v-else :title="$t('pageUi.contactDetails')" :description="$t('pageUi.chooseContact')">
            <template #icon><RiUser3Line size="22px" /></template>
          </FirstUseEmptyState>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped src="../../shared/views/Mail/mail-layout.css"></style>
<style scoped>
.contacts-toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-xs); }
.contacts-toolbar h2, .contacts-profile h2 { margin: 0; font-size: var(--font-size-title); overflow-wrap: anywhere; }
.contacts-scroll { min-height: 0; padding: var(--page-content-inset); }
.contacts-scroll { flex: 1; overflow: auto; }
.contacts-person, .contacts-star {
  border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer;
}
.contacts-row {
  display: flex; align-items: center; gap: var(--space-sm); min-width: 0;
  padding: var(--space-sm); border-radius: var(--radius-sm);
}
.contacts-list-toolbar { flex-wrap: nowrap; }
.contacts-search { flex: 1; min-width: 0; }
.contacts-sort.app-action-button {
  flex: none;
  height: var(--control-height-md);
  min-height: var(--control-height-md);
  padding-inline: var(--space-sm);
}
.contacts-sort :deep(.lh-arrow) { flex: none; }
.contacts-sort :deep(.lh-arrow.desc) { transform: rotate(180deg); }
.contacts-group-label { margin: var(--space-xs) var(--space-sm); color: var(--content-secondary); font-size: var(--font-size-sm); }
.contacts-row {
  margin-block-end: var(--space-xs);
  border: 1px solid transparent;
  background: var(--mind-notes-list-card-bg);
  box-shadow: var(--elevation-card);
  transition: var(--card-motion);
}
.contacts-row:hover { border-color: var(--border-hover); box-shadow: var(--elevation-card-hover); }
.contacts-row.selected { border-color: var(--sidebar-item-active-border); background: var(--sidebar-item-active); color: var(--sidebar-item-active-fg); }
.contacts-person {
  flex: 1; display: flex; align-items: center; gap: var(--space-sm);
  text-align: start; padding: 0; min-width: 0; overflow-wrap: anywhere;
}
.contacts-avatar {
  display: grid; place-items: center; flex: none; inline-size: 38px; block-size: 38px;
  border-radius: 50%; background: var(--action-soft); color: var(--action-primary); font-weight: var(--font-weight-semibold);
}
.contacts-avatar--large { inline-size: 64px; block-size: 64px; font-size: var(--font-size-title); }
.contacts-star { flex: none; display: grid; place-items: center; padding: var(--space-xs); border-radius: var(--radius-xs); color: var(--content-secondary); }
.contacts-star[aria-pressed='true'], .contacts-profile-actions [aria-pressed='true'] { color: var(--action-primary); }
.contacts-person:focus-visible, .contacts-star:focus-visible { outline: 2px solid var(--border-focus); outline-offset: -2px; }
.contacts-profile { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-md); }
.contacts-identity { flex: 1 1 7rem; min-width: 0; }
.contacts-identity :is(h2, .contact-name-input) { font-size: var(--font-size-display); line-height: 1.2; }
.contact-name-input { width: 100%; min-width: 0; font-weight: var(--font-weight-bold); }
.contacts-person-copy { min-width: 0; display: grid; }
.contacts-person-copy > * { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: var(--line-height-body); }
.contacts-person-copy small { color: var(--content-secondary); font-size: var(--font-size-sm); }
.contacts-profile-actions { display: flex; flex-wrap: wrap; gap: var(--space-xs); }
.contacts-back { display: none; margin-block-end: var(--space-md); }
@container (max-width: 740px) {
  .contacts-page .mail-columns:not(.show-reading) { grid-template-rows: auto minmax(0, 1fr); }
  .contacts-back { display: inline-flex; }
}
</style>
