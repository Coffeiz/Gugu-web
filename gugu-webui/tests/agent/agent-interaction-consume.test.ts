import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

import {
  consumeInteractionAction,
  type InteractionPromptRecord,
  type InteractionActionRecord,
  type InteractionConsumeTransaction,
  type InteractionCommandActionInput,
  type InteractionCommandActionResult,
} from '../../src/domains/agent-sessions/application/agent-interaction-consume.js'

const now = new Date('2026-11-13T00:00:00.000Z')
const tokenHash = createHash('sha256').update('token', 'utf8').digest('hex')

function state(overrides: {
  prompt?: Partial<InteractionPromptRecord>
  action?: Partial<InteractionActionRecord>
} = {}) {
  const prompt: InteractionPromptRecord = {
    id: 17,
    ownerId: 'owner-a',
    sessionId: 91,
    kind: 'choice',
    status: 'active',
    expiresAt: new Date(now.getTime() + 60_000),
    resolvedAt: null,
    schema: { options: [{ id: 'keep', label: '保留' }] },
  }
  const action: InteractionActionRecord = {
    id: 25,
    promptId: 17,
    tokenHash: '',
    actionType: 'choice',
    optionId: 'keep',
    context: { opaque: 'context' },
    status: 'pending',
    expiresAt: new Date(now.getTime() + 60_000),
    consumedAt: null,
    consumedEventId: null,
  }
  return {
    prompt: { ...prompt, ...overrides.prompt },
    action: { ...action, ...overrides.action },
    commits: 0,
    lookups: [] as string[],
    commandCalls: [] as InteractionCommandActionInput[],
    commandResult: { status: 'confirmed' as 'confirmed' | 'error', text: '业务操作已完成' },
    redeemCalls: [] as Array<{ ownerId: string; code: string }>,
    redeemResult: true,
  }
}

function portFor(data: ReturnType<typeof state>, omit?: 'command' | 'redeemer') {
  return {
    now: () => now,
    transaction: async <T>(run: (tx: InteractionConsumeTransaction) => Promise<T>) => {
      const tx: Partial<InteractionConsumeTransaction> = {
        getOwnedPrompt: async (ownerId: string, promptId: number) => {
          data.lookups.push(`prompt:${ownerId}:${promptId}`)
          return ownerId === data.prompt.ownerId && promptId === data.prompt.id ? data.prompt : null
        },
        lockAction: async (promptId: number, actionTokenHash: string) => {
          data.lookups.push(`action:${promptId}:${actionTokenHash}`)
          return promptId === data.action.promptId && actionTokenHash === data.action.tokenHash
            ? data.action
            : null
        },
        applyCommandAction: async (input: InteractionCommandActionInput): Promise<InteractionCommandActionResult> => {
          data.commandCalls.push(input)
          return data.commandResult
        },
        redeemConfirmation: async (ownerId: string, code: string) => {
          data.redeemCalls.push({ ownerId, code })
          return data.redeemResult
        },
        commit: async () => { data.commits += 1 },
      }
      if (omit === 'command') delete tx.applyCommandAction
      if (omit === 'redeemer') delete tx.redeemConfirmation
      return run(tx as InteractionConsumeTransaction)
    },
  }
}

function consume(data: ReturnType<typeof state>, options: Parameters<typeof consumeInteractionAction>[1]) {
  return consumeInteractionAction(portFor(data), options, () => now)
}

function consumeWithMissingHandler(
  data: ReturnType<typeof state>,
  options: Parameters<typeof consumeInteractionAction>[1],
  omit: 'command' | 'redeemer',
) {
  return consumeInteractionAction(portFor(data, omit), options, () => now)
}

test('consumes a valid action once and commits the resolved result', async () => {
  const data = state({ action: { tokenHash } })
  const result = await consume(data, {
    ownerId: 'owner-a', promptId: 17, token: 'token', eventId: 'event-1',
  })

  assert.equal(result.result.status, 'selected')
  assert.equal(result.result.option_id, 'keep')
  assert.equal(result.result.text, '保留')
  assert.equal(result.duplicate, undefined)
  assert.equal(data.action.status, 'consumed')
  assert.equal(data.action.consumedEventId, 'event-1')
  assert.equal(data.prompt.status, 'resolved')
  assert.equal((data.prompt.schema.resolved_result as Record<string, unknown> | undefined)?.status, 'selected')
  assert.equal(data.commits, 1)
})

test('replays a consumed action only for the same event when explicitly enabled', async () => {
  const resolved = { kind: 'choice', status: 'selected', prompt_id: 17, option_id: 'keep', value: 'keep', text: '保留' }
  const data = state({
    prompt: { status: 'resolved', schema: { resolved_result: resolved } },
    action: {
      tokenHash, status: 'consumed', consumedEventId: 'event-1',
    },
  })
  const result = await consume(data, {
    ownerId: 'owner-a', promptId: 17, token: 'token', eventId: 'event-1', allowDuplicateEvent: true,
  })

  assert.equal(result.duplicate, true)
  assert.deepEqual(result.result, resolved)
  assert.equal(data.commits, 0)
})

test('does not treat a different event or a default web retry as an idempotent replay', async () => {
  for (const options of [
    { eventId: 'event-2', allowDuplicateEvent: true },
    { eventId: 'event-1' },
  ]) {
    const data = state({
      prompt: { status: 'resolved' },
      action: { tokenHash, status: 'consumed', consumedEventId: 'event-1' },
    })
    await assert.rejects(consume(data, {
      ownerId: 'owner-a', promptId: 17, token: 'token', ...options,
    }), { code: 'interaction_ended' })
    assert.equal(data.commits, 0)
  }
})

test('wrong token and foreign owner do not mutate or commit', async () => {
  const badToken = state({ action: { tokenHash: 'another-token-hash' } })
  await assert.rejects(consume(badToken, {
    ownerId: 'owner-a', promptId: 17, token: 'token',
  }), { code: 'action_invalid' })
  assert.equal(badToken.action.status, 'pending')
  assert.equal(badToken.commits, 0)

  const foreignOwner = state()
  await assert.rejects(consume(foreignOwner, {
    ownerId: 'owner-b', promptId: 17, token: 'token',
  }), { code: 'interaction_not_found' })
  assert.deepEqual(foreignOwner.lookups, ['prompt:owner-b:17'])
  assert.equal(foreignOwner.commits, 0)
})

test('persists prompt expiry before returning the expired error', async () => {
  const data = state({ prompt: { expiresAt: new Date(now.getTime() - 1) }, action: { tokenHash } })
  await assert.rejects(consume(data, {
    ownerId: 'owner-a', promptId: 17, token: 'token',
  }), { code: 'interaction_expired' })
  assert.equal(data.prompt.status, 'expired')
  assert.equal(data.prompt.resolvedAt?.toISOString(), now.toISOString())
  assert.equal(data.action.status, 'pending')
  assert.equal(data.commits, 1)
})

test('cancelled interactions reject consumption without changing stored state', async () => {
  const data = state({ prompt: { status: 'cancelled' }, action: { tokenHash } })
  await assert.rejects(consume(data, {
    ownerId: 'owner-a', promptId: 17, token: 'token',
  }), { code: 'interaction_ended' })
  assert.equal(data.action.status, 'pending')
  assert.equal(data.commits, 0)
})

test('a confirm cancellation resolves as cancelled and commits the button result', async () => {
  const data = state({
    prompt: { kind: 'confirm', schema: { options: [{ id: 'cancel', label: '取消' }] } },
    action: { tokenHash, actionType: 'cancel', optionId: 'cancel' },
  })
  const result = await consume(data, { ownerId: 'owner-a', promptId: 17, token: 'token' })

  assert.equal(result.result.status, 'cancelled')
  assert.equal(result.result.confirm, false)
  assert.equal(result.result.text, '取消')
  assert.equal(data.commits, 1)
})

test('a permitted custom reply activates text input but leaves the prompt active', async () => {
  const data = state({
    prompt: { schema: { source: 'agent', allow_text_input: true } },
    action: { tokenHash, actionType: 'custom_reply', optionId: '__custom_reply__' },
  })
  const result = await consume(data, { ownerId: 'owner-a', promptId: 17, token: 'token' })

  assert.equal(result.result.status, 'awaiting_text')
  assert.equal(data.prompt.status, 'active')
  assert.equal(data.prompt.schema.custom_input_active, true)
  assert.equal(data.action.status, 'consumed')
  assert.equal(data.commits, 1)
})

test('workspace deletion delegates owner-scoped execution to the transaction port', async () => {
  const data = state({
    prompt: { kind: 'confirm' },
    action: {
      tokenHash,
      optionId: 'confirm',
      context: { command_action: 'workspace_delete', workspace_id: 702 },
    },
  })
  data.commandResult = {
    status: 'confirmed',
    text: '已删除工作区「合成工作区」（ID 702），项目和文件未受影响。',
  }

  const result = await consume(data, { ownerId: 'owner-a', promptId: 17, token: 'token' })

  assert.equal(data.commandCalls.length, 1)
  assert.deepEqual(data.commandCalls[0], {
    ownerId: 'owner-a',
    sessionId: 91,
    commandAction: 'workspace_delete',
    optionId: 'confirm',
    actionType: 'choice',
    context: { command_action: 'workspace_delete', workspace_id: 702 },
    toolName: undefined,
  })
  assert.equal(result.result.status, 'confirmed')
  assert.equal(result.result.text, data.commandResult.text)
  assert.equal(data.commits, 1)
})

test('workspace deletion preserves an owner-scoped not-found result instead of reporting success', async () => {
  const data = state({
    prompt: { kind: 'confirm' },
    action: {
      tokenHash,
      optionId: 'confirm',
      context: { command_action: 'workspace_delete', workspace_id: 702 },
    },
  })
  data.commandResult = { status: 'error', text: '工作区不存在，或已经被删除。' }

  const result = await consume(data, { ownerId: 'owner-a', promptId: 17, token: 'token' })

  assert.equal(result.result.status, 'error')
  assert.equal(result.result.text, '工作区不存在，或已经被删除。')
  assert.equal(result.result.confirm, undefined)
  assert.equal(data.commits, 1)
})

test('session filesystem authorization runs only for the confirm option and preserves ask_user origin', async () => {
  const data = state({
    prompt: { kind: 'confirm' },
    action: {
      tokenHash,
      optionId: 'confirm',
      context: { command_action: 'filesystem_authorization_grant', tool_name: 'ask_user' },
    },
  })

  const result = await consume(data, { ownerId: 'owner-a', promptId: 17, token: 'token' })

  assert.equal(data.commandCalls.length, 1)
  assert.deepEqual(data.commandCalls[0], {
    ownerId: 'owner-a',
    sessionId: 91,
    commandAction: 'filesystem_authorization_grant',
    optionId: 'confirm',
    actionType: 'choice',
    context: { command_action: 'filesystem_authorization_grant', tool_name: 'ask_user' },
    toolName: 'ask_user',
  })
  assert.equal(result.result.status, 'confirmed')
  assert.equal(result.result.text, data.commandResult.text)
})

test('cancelled command actions never call the side-effect port', async () => {
  const data = state({
    prompt: { kind: 'confirm' },
    action: {
      tokenHash,
      optionId: 'cancel',
      actionType: 'cancel',
      context: { command_action: 'workspace_delete', workspace_id: 702 },
    },
  })

  const result = await consume(data, { ownerId: 'owner-a', promptId: 17, token: 'token' })

  assert.equal(data.commandCalls.length, 0)
  assert.equal(result.result.status, 'cancelled')
  assert.equal(result.result.confirm, false)
})

test('cancelled filesystem grants do not call the side-effect port', async () => {
  const data = state({
    prompt: { kind: 'confirm' },
    action: {
      tokenHash,
      optionId: 'cancel',
      actionType: 'cancel',
      context: { command_action: 'filesystem_authorization_grant' },
    },
  })

  const result = await consume(data, { ownerId: 'owner-a', promptId: 17, token: 'token' })

  assert.equal(data.commandCalls.length, 0)
  assert.equal(result.result.status, 'cancelled')
  assert.equal(result.result.confirm, false)
  assert.equal(data.commits, 1)
})

test('an expired confirmation code converts the result to a safe error', async () => {
  const data = state({
    prompt: { kind: 'confirm' },
    action: {
      tokenHash,
      optionId: 'confirm',
      context: { confirm_code: 'opaque-confirm-code' },
    },
  })
  data.redeemResult = false

  const result = await consume(data, { ownerId: 'owner-a', promptId: 17, token: 'token' })

  assert.deepEqual(data.redeemCalls, [{ ownerId: 'owner-a', code: 'opaque-confirm-code' }])
  assert.equal(result.result.status, 'error')
  assert.equal(result.result.confirm, false)
  assert.equal(result.result.text, '确认已过期，请让助手重新发起操作。')
  assert.equal(data.commits, 1)
})

test('a valid confirmation code keeps the confirmed result and its action text', async () => {
  const data = state({
    prompt: { kind: 'confirm' },
    action: {
      tokenHash,
      optionId: 'confirm',
      context: { confirm_code: 'opaque-confirm-code' },
    },
  })

  const result = await consume(data, { ownerId: 'owner-a', promptId: 17, token: 'token' })

  assert.deepEqual(data.redeemCalls, [{ ownerId: 'owner-a', code: 'opaque-confirm-code' }])
  assert.equal(result.result.status, 'confirmed')
  assert.equal(result.result.confirm, true)
  assert.equal(result.result.text, 'confirm')
  assert.equal(data.commits, 1)
})

test('a command with no transaction handler is rejected before consuming the action', async () => {
  const data = state({
    prompt: { kind: 'confirm' },
    action: {
      tokenHash,
      optionId: 'confirm',
      context: { command_action: 'workspace_delete', workspace_id: 702 },
    },
  })

  await assert.rejects(consumeWithMissingHandler(data, {
    ownerId: 'owner-a', promptId: 17, token: 'token',
  }, 'command'), { code: 'command_action_handler_unavailable' })
  assert.equal(data.action.status, 'pending')
  assert.equal(data.prompt.status, 'active')
  assert.equal(data.commits, 0)
})

test('a confirmation code with no redeemer is rejected before consuming the action', async () => {
  const data = state({
    prompt: { kind: 'confirm' },
    action: { tokenHash, optionId: 'confirm', context: { confirm_code: 'opaque-confirm-code' } },
  })

  await assert.rejects(consumeWithMissingHandler(data, {
    ownerId: 'owner-a', promptId: 17, token: 'token',
  }, 'redeemer'), { code: 'confirmation_redeemer_unavailable' })
  assert.equal(data.action.status, 'pending')
  assert.equal(data.prompt.status, 'active')
  assert.equal(data.commits, 0)
})
