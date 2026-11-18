<template>
  <div class="skills-page">
    <section class="skills-panel glass-card">
      <SkillsHome />
    </section>
  </div>
</template>

<script setup lang="ts">
import SkillsHome from './SkillsHome.vue'
</script>

<style scoped>
.skills-page { height:100%; font-family:var(--font-sans); }
.skills-panel { height:100%; box-sizing:border-box; display:flex; flex-direction:column; padding:0 24px; }
</style>
