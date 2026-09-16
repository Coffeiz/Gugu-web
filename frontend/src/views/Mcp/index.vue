<template>
  <div class="mcp-route-page">
    <section class="mcp-panel glass-card">
      <div class="section-header">
        <ActionButton fit @click="createRequest++">
          <Icon name="action.add" :size="14" />{{ t('skillsMcpUi.add') }}
        </ActionButton>
      </div>
      <McpServersView :create-request="createRequest" />
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import Icon from '@/components/common/icons/Icon.vue'
import McpServersView from '@/views/Skills/McpServersView.vue'

const { t } = useI18n()
const createRequest = ref(0)
</script>

<style scoped>
.mcp-route-page { height:100%; font-family:var(--font-sans); }
.mcp-panel { --glass-card-background:var(--column-bg); --glass-card-background-hover:var(--column-bg); height:100%; box-sizing:border-box; display:flex; flex-direction:column; padding:22px 24px; }
.section-header { display:flex; align-items:center; justify-content:flex-start; margin-bottom:16px; flex-shrink:0; }
</style>
