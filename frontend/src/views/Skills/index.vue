<template>
  <div class="skills-page">
    <section class="skills-panel glass-card">
      <div class="section-header">
        <ActionButton fit @click="skillCreateRequest++">
          <Icon name="action.add" :size="14" />{{ t('skills.create') }}
        </ActionButton>
      </div>
      <SkillsHome :create-request="skillCreateRequest" />
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import Icon from '@/components/common/icons/Icon.vue'
import SkillsHome from './SkillsHome.vue'

const { t } = useI18n()
const skillCreateRequest = ref(0)
</script>

<style scoped>
.skills-page { height:100%; font-family:var(--font-sans); }
.skills-panel { --glass-card-background:var(--column-bg); --glass-card-background-hover:var(--column-bg); height:100%; box-sizing:border-box; display:flex; flex-direction:column; padding:22px 24px; }
.section-header { display:flex; align-items:center; justify-content:flex-start; margin-bottom:16px; flex-shrink:0; }
</style>
