<script setup lang="ts">
import ProfileByokPane from '@/components/common/profile/ProfileByokPane.vue'
import { hasDesktopAuxiliaryModelBridge, requestDesktopAuxiliaryModel } from './agent-model-transport'
import type { DesktopAuxiliaryModelCommand } from '@gugu/core/byok/contracts'

type Input<Action extends DesktopAuxiliaryModelCommand['action']> =
  Extract<DesktopAuxiliaryModelCommand, { action: Action }> extends { input: infer T } ? T : never

async function test(command: Extract<DesktopAuxiliaryModelCommand, { action: 'test' | 'preview' }>) {
  const result = await requestDesktopAuxiliaryModel(command)
  if (result && 'ok' in result) return { ...result, status: result.ok ? 'ok' : 'error' }
  throw new Error('本机模型未返回测试结果')
}

const deviceApi = {
  async list() {
    const result = await requestDesktopAuxiliaryModel({ action: 'list' })
    if (result && 'items' in result) return result
    throw new Error('无法读取本机模型列表')
  },
  create: (input: Input<'create'>) => requestDesktopAuxiliaryModel({ action: 'create', input }),
  update: (id: number, input: Input<'update'>) => requestDesktopAuxiliaryModel({ action: 'update', id, input }),
  remove: (id: number) => requestDesktopAuxiliaryModel({ action: 'delete', id }),
  test: (id: number) => test({ action: 'test', id }),
  testPreview: (input: Input<'preview'>) => test({ action: 'preview', input }),
  async modelsPreview(input: Input<'models'>) {
    const result = await requestDesktopAuxiliaryModel({ action: 'models', input })
    if (result && 'models' in result) return result
    throw new Error('无法读取 Provider 模型列表')
  },
}
</script>

<template>
  <ProfileByokPane v-if="hasDesktopAuxiliaryModelBridge()" :device-api="deviceApi" />
</template>
