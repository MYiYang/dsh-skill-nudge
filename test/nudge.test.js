import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULTS, emptyState, isFailure, recordCall, renderNudge, resolveConfig, shouldNudge } from '../lib/nudge.js'
import { apply } from '../index.js'

/** A ctx that only records listeners, enough to drive the host wiring. */
function fakeCtx() {
  const handlers = new Map()
  const logs = []
  return {
    logs,
    handlers,
    ctx: {
      logger: {
        debug: (line) => logs.push(['debug', line]),
        info: (line) => logs.push(['info', line]),
        warn: (line) => logs.push(['warn', line]),
      },
      on(event, handler) {
        const list = handlers.get(event) ?? []
        list.push(handler)
        handlers.set(event, list)
        return () => {}
      },
    },
  }
}

/** Run every listener registered for one event, threading the decision through. */
async function firePreStep(handlers, payload, decision = { kind: 'enter', messages: [] }) {
  let current = decision
  for (const handler of handlers.get('agent/pre-step') ?? []) {
    current = await handler(payload, async () => current)
  }
  return current
}

/** Fire the tool-result listeners once. */
function fireToolResult(handlers, exec, result) {
  for (const handler of handlers.get('tools/result') ?? []) handler(exec, result)
}

const mainAgent = { session: { id: 's-1', header: {} } }
const subAgent = { session: { id: 's-2', header: { origin: 'subagent' } } }

test('resolveConfig keeps defaults and rejects junk', () => {
  assert.deepEqual(resolveConfig(undefined), DEFAULTS)
  assert.equal(resolveConfig({ threshold: 12 }).threshold, 12)
  assert.equal(resolveConfig({ threshold: 0 }).threshold, DEFAULTS.threshold)
  assert.equal(resolveConfig({ threshold: 'abc' }).threshold, DEFAULTS.threshold)
  assert.equal(resolveConfig({ enabled: false }).enabled, false)
  assert.equal(resolveConfig({ skillHome: '  ' }).skillHome, DEFAULTS.skillHome)
})

test('recordCall counts calls and failures separately', () => {
  const state = emptyState()
  recordCall(state, { failed: false })
  recordCall(state, { failed: true })
  assert.equal(state.calls, 2)
  assert.equal(state.errors, 1)
})

test('isFailure recognizes the shapes a tool result can take', () => {
  assert.equal(isFailure({ isError: true }), true)
  assert.equal(isFailure({ ok: false }), true)
  assert.equal(isFailure({ error: 'boom' }), true)
  assert.equal(isFailure({ status: 'failed' }), true)
  assert.equal(isFailure({ ok: true, content: 'fine' }), false)
  assert.equal(isFailure(undefined), false)
})

test('shouldNudge waits for the threshold, then respects the recheck interval', () => {
  const config = resolveConfig({ threshold: 8, recheckEvery: 5, maxNudges: 2 })
  const state = emptyState()

  for (let i = 0; i < 7; i += 1) recordCall(state)
  assert.equal(shouldNudge(state, config), false, 'below threshold')

  recordCall(state)
  assert.equal(shouldNudge(state, config), true, 'reaches threshold')

  state.nudges += 1
  state.lastCallCount = state.calls
  assert.equal(shouldNudge(state, config), false, 'just nudged')

  for (let i = 0; i < 4; i += 1) recordCall(state)
  assert.equal(shouldNudge(state, config), false, 'inside recheck window')

  recordCall(state)
  assert.equal(shouldNudge(state, config), true, 'recheck interval elapsed')

  state.nudges += 1
  state.lastCallCount = state.calls
  recordCall(state)
  assert.equal(shouldNudge(state, config), false, 'capped by maxNudges')
})

test('shouldNudge fires early on repeated failures', () => {
  const config = resolveConfig({ threshold: 99, errorThreshold: 2, minCallsWithErrors: 4 })
  const state = emptyState()
  recordCall(state, { failed: true })
  assert.equal(shouldNudge(state, config), false, 'one failure is not a signal')

  recordCall(state, { failed: true })
  recordCall(state, { failed: true })
  assert.equal(shouldNudge(state, config), false, 'below minCallsWithErrors')

  recordCall(state)
  assert.equal(shouldNudge(state, config), true, 'failures after real work')
})

test('shouldNudge stays silent when disabled', () => {
  const config = resolveConfig({ enabled: false })
  const state = emptyState()
  for (let i = 0; i < 50; i += 1) recordCall(state)
  assert.equal(shouldNudge(state, config), false)
})

test('renderNudge quotes the frontmatter rules and the counts', () => {
  const config = resolveConfig({})
  const text = renderNudge({ calls: 9, errors: 2 }, config)
  assert.match(text, /<system-reminder data-role="skill-nudge">/)
  assert.match(text, /9 次工具调用/)
  assert.match(text, /2 次失败/)
  assert.match(text, /kebab-case/)
  assert.match(text, /true\/false/)
  assert.match(text, /When to use \/ Steps \/ Pitfalls \/ Verification/)
  assert.match(text, new RegExp(config.skillHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.ok(text.trimEnd().endsWith('</system-reminder>'))
})

test('host wiring injects once after the threshold, once per recheck window', async () => {
  const { ctx, handlers } = fakeCtx()
  apply(ctx, { threshold: 3, recheckEvery: 4, maxNudges: 2 })

  const before = await firePreStep(handlers, { agent: mainAgent, messages: [], turn: 1, step: 1, signal: { aborted: false } })
  assert.equal(before.messages.length, 0, 'nothing before any work')

  for (let i = 0; i < 3; i += 1) fireToolResult(handlers, { agent: mainAgent }, { ok: true })
  const nudged = await firePreStep(handlers, { agent: mainAgent, messages: [], turn: 1, step: 6, signal: { aborted: false } })
  assert.equal(nudged.messages.length, 1)
  assert.equal(nudged.messages[0].source.kind, 'plugin:dsh-skill-nudge')
  assert.match(nudged.messages[0].content[0].text, /skill-nudge/)

  const again = await firePreStep(handlers, { agent: mainAgent, messages: [], turn: 1, step: 7, signal: { aborted: false } })
  assert.equal(again.messages.length, 0, 'no repeat inside the recheck window')

  for (let i = 0; i < 4; i += 1) fireToolResult(handlers, { agent: mainAgent }, { ok: false })
  const second = await firePreStep(handlers, { agent: mainAgent, messages: [], turn: 1, step: 9, signal: { aborted: false } })
  assert.equal(second.messages.length, 1, 'second nudge after recheck interval')
  assert.match(second.messages[0].content[0].text, /4 次失败/)

  for (let i = 0; i < 20; i += 1) fireToolResult(handlers, { agent: mainAgent }, { ok: true })
  const third = await firePreStep(handlers, { agent: mainAgent, messages: [], turn: 1, step: 20, signal: { aborted: false } })
  assert.equal(third.messages.length, 0, 'capped by maxNudges')
})

test('host wiring ignores sub-agents and aborted steps', async () => {
  const { ctx, handlers } = fakeCtx()
  apply(ctx, { threshold: 2 })

  for (let i = 0; i < 5; i += 1) fireToolResult(handlers, { agent: subAgent }, { ok: true })
  const sub = await firePreStep(handlers, { agent: subAgent, messages: [], turn: 1, step: 3, signal: { aborted: false } })
  assert.equal(sub.messages.length, 0, 'sub-agent sessions are not counted')

  for (let i = 0; i < 2; i += 1) fireToolResult(handlers, { agent: mainAgent }, { ok: true })
  const aborted = await firePreStep(handlers, { agent: mainAgent, messages: [], turn: 1, step: 4, signal: { aborted: true } })
  assert.equal(aborted.messages.length, 0, 'aborted step stays untouched')
})

test('host wiring passes a reject decision through unchanged', async () => {
  const { ctx, handlers } = fakeCtx()
  apply(ctx, { threshold: 1 })
  fireToolResult(handlers, { agent: mainAgent }, { ok: true })
  const rejected = await firePreStep(
    handlers,
    { agent: mainAgent, messages: [], turn: 1, step: 2, signal: { aborted: false } },
    { kind: 'reject' },
  )
  assert.deepEqual(rejected, { kind: 'reject' })
})
