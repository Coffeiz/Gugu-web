<script setup lang="ts">
import ActionButton from '@/components/common/controls/ActionButton.vue'
import type { ClientRow } from '@desktop/bridge/bridge'

defineProps<{ clients: ClientRow[]; busy: boolean }>()
const clientName = defineModel<string>('clientName', { required: true })
const editingClient = defineModel<ClientRow | null>('editingClient', { required: true })
const editedClientName = defineModel<string>('editedClientName', { required: true })
const emit = defineEmits<{ create: []; rename: []; remove: [client: ClientRow] }>()
</script>

<template>
  <section id="desktop-clients" class="desktop-panel glass-card desktop-clients-panel" aria-labelledby="desktop-clients-title">
    <h2 id="desktop-clients-title" class="section-title">联系人 <span>{{ clients.length }}</span></h2>
    <form @submit.prevent="emit('create')">
      <span id="client-name-title" class="sr-only">联系人名称</span>
      <input id="client-name" v-model="clientName" class="form-input" aria-labelledby="client-name-title" maxlength="200" placeholder="添加一位联系人" required :disabled="busy" />
      <ActionButton fit type="submit" :disabled="busy">添加联系人</ActionButton>
    </form>
    <ul v-if="clients.length"><li v-for="client in clients" :key="client.id">
      <form v-if="editingClient?.id === client.id" @submit.prevent="emit('rename')"><input v-model="editedClientName" class="form-input" aria-label="联系人名称" maxlength="200" required :disabled="busy" /><ActionButton fit type="submit" :disabled="busy">保存</ActionButton><ActionButton fit variant="secondary" type="button" :disabled="busy" @click="editingClient = null">取消</ActionButton></form>
      <template v-else><span>{{ client.name }}</span><ActionButton fit variant="secondary" :disabled="busy" @click="editingClient = client; editedClientName = client.name">重命名</ActionButton><ActionButton fit variant="secondary" :disabled="busy" @click="emit('remove', client)">删除</ActionButton></template>
    </li></ul>
    <p v-else class="desktop-empty">这里会保存你的联系人。</p>
  </section>
</template>

<style scoped>
.desktop-panel { min-width: 0; padding: 22px 24px; --glass-card-background-hover: var(--glass-card-background); --glass-card-border-hover: var(--glass-card-border); --glass-card-shadow-hover: var(--glass-card-shadow); }
.desktop-clients-panel { margin-top: 20px; }
.desktop-panel > h2 { margin: 0 0 18px; }
.desktop-panel h2 span { margin-left: 8px; color: var(--text-secondary); font-size: 12px; font-weight: 500; }
.desktop-panel form { display: flex; gap: 10px; }
.desktop-panel form > .form-input { min-width: 0; width: 100%; }
.desktop-panel ul { margin: 20px 0 0; padding: 0; list-style: none; }
.desktop-panel li { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 0; border-bottom: 1px solid var(--content-divider); }
.desktop-panel li > span { min-width: 0; overflow-wrap: anywhere; }
.desktop-empty { color: var(--text-secondary); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); }
</style>
