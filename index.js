/**
 * Host half of the skill nudge.
 *
 * Counts tool calls per session and, once a threshold is crossed, prepends one
 * `<system-reminder data-role="skill-nudge">` message to the entering step so
 * the model remembers to distill the finished workflow into a reusable skill.
 * This is the DSH counterpart of WorkBuddy's `memory_and_skills_reminder`,
 * minus the framework: the skill catalog, hot reload and on-demand loading all
 * already exist (`dsh-skill-filesystem` + `dsh-tool-skill`), so the only thing
 * missing was the reminder itself.
 *
 * Design notes:
 * - No service injection: both listeners are plain events, so the plugin keeps
 *   working even when tools or agents are replaced by another composition.
 * - `next()` is always called first, and a non-`enter` decision is returned
 *   untouched — this adds a message, it never overrides someone else's gate.
 * - All failure paths log and return the original decision; a broken nudge
 *   must never break a turn.
 *
 * @module dsh-skill-nudge
 */
import { randomUUID } from 'node:crypto'
import { emptyState, isFailure, recordCall, renderNudge, resolveConfig, shouldNudge } from './lib/nudge.js'

export const name = 'skill-nudge'

/** Event-only plugin: no services are read, so nothing to inject. */
export const inject = []

/** Plugin tag used in log lines. */
const TAG = '[skill-nudge]'

/** Upper bound on tracked sessions; the least recently used entry is evicted past this. */
const MAX_STATES = 2000

/**
 * Build one injected user message.
 *
 * Hand-built (like `dsh-memory` does) instead of importing `createUserMessage`,
 * so the plugin can be installed by copying the directory alone. Session format
 * v4 requires a **producer-owned** source kind: a third-party plugin owns the
 * `plugin:<package-name>` namespace and must not emit the retired `plugin`
 * wrapper.
 * @param {string} text - the reminder body.
 * @returns {{id: string, role: 'user', content: Array<{type: 'text', text: string}>, source: {kind: string, form: string}}}
 */
function contextMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin:dsh-skill-nudge', form: 'nudge' },
  }
}

/**
 * True when the session belongs to a delegated child agent rather than the
 * human's own chat. Mirrors what `dsh-memory` does.
 * @param {{header?: Record<string, unknown>}|undefined} session - the agent's session.
 * @returns {boolean}
 */
function isSubagentSession(session) {
  try {
    const header = session?.header ?? {}
    return header.origin === 'subagent' || Number(header.delegationDepth ?? 0) > 0
  } catch {
    return false
  }
}

/**
 * Stable session id of an agent, or undefined.
 * @param {{session?: {id?: unknown}}|undefined} agent - the calling agent.
 * @returns {string|undefined}
 */
function sessionIdOf(agent) {
  try {
    const id = agent?.session?.id
    return typeof id === 'string' && id !== '' ? id : undefined
  } catch {
    return undefined
  }
}

/**
 * Mount the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Record<string, unknown>} [config] - loader row config.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config)
  /** @param {'debug'|'info'|'warn'} level @param {string} message */
  const log = (level, message) => {
    try {
      ctx.logger?.[level]?.(`${TAG} ${message}`)
    } catch {
      /* logging must never throw */
    }
  }

  if (!cfg.enabled) {
    log('info', 'disabled by config')
    return
  }

  /** @type {Map<string, ReturnType<typeof emptyState>>} */
  const states = new Map()

  /**
   * Counters for one session, refreshing its LRU position.
   * @param {string} sessionId - session key.
   * @returns {ReturnType<typeof emptyState>}
   */
  function stateOf(sessionId) {
    let state = states.get(sessionId)
    if (state === undefined) {
      if (states.size >= MAX_STATES) {
        const oldest = states.keys().next().value
        if (oldest !== undefined) states.delete(oldest)
      }
      state = emptyState()
    } else {
      states.delete(sessionId)
    }
    states.set(sessionId, state)
    return state
  }

  // ── Count finished tool calls ────────────────────────────────────────────
  ctx.on('tools/result', (exec, result) => {
    try {
      const agent = exec?.agent
      if (cfg.trackSubagents !== true && isSubagentSession(agent?.session)) return
      const sessionId = sessionIdOf(agent)
      if (sessionId === undefined) return
      recordCall(stateOf(sessionId), { failed: isFailure(result) })
    } catch (error) {
      log('debug', `count failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  // ── Decide whether this step carries the reminder ────────────────────────
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      if (decision?.kind !== 'enter') return decision
      if (payload?.signal?.aborted === true) return decision
      const session = payload?.agent?.session
      if (session === undefined) return decision
      if (cfg.trackSubagents !== true && isSubagentSession(session)) return decision
      const sessionId = sessionIdOf(payload.agent)
      if (sessionId === undefined) return decision

      const state = stateOf(sessionId)
      if (!shouldNudge(state, cfg)) return decision

      state.nudges += 1
      state.lastCallCount = state.calls
      log('info', `nudge #${state.nudges} at ${state.calls} calls (${state.errors} failed)`)
      return { ...decision, messages: [...decision.messages, contextMessage(renderNudge(state, cfg))] }
    } catch (error) {
      log('warn', `nudge failed: ${error instanceof Error ? error.message : String(error)}`)
      return decision
    }
  })

  log('info', `mounted (threshold=${cfg.threshold}, recheckEvery=${cfg.recheckEvery}, maxNudges=${cfg.maxNudges})`)
}
