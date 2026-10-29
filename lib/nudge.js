/**
 * Pure decision logic for the skill nudge: no `ctx`, no I/O, no imports.
 *
 * The host half counts tool calls and asks this module whether the moment has
 * come to remind the model to distill the work into a reusable skill. Keeping
 * the state machine here makes it testable with plain `node --test`.
 *
 * @module dsh-skill-nudge/lib/nudge
 */

/** Defaults; every one of them is overridable from the loader row config. */
export const DEFAULTS = {
  /** Master switch. */
  enabled: true,
  /** Tool calls in one session before the first nudge. */
  threshold: 8,
  /** Failed tool calls that also earn a nudge (a fixed-tricky-error signal). */
  errorThreshold: 2,
  /** Never nudge on errors alone before this many calls. */
  minCallsWithErrors: 4,
  /** Extra tool calls required between two nudges. */
  recheckEvery: 12,
  /** Hard cap per session. */
  maxNudges: 3,
  /** Count delegated child agents too. */
  trackSubagents: false,
  /** Skill root quoted in the reminder text. */
  skillHome: '~/.dsh/skills',
}

/**
 * Read one positive integer from raw config, falling back to the default.
 * @param {unknown} value - candidate.
 * @param {number} fallback - default when the candidate is not a positive integer.
 * @returns {number}
 */
function positiveInt(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1) return Math.floor(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim())
    if (Number.isFinite(n) && n >= 1) return Math.floor(n)
  }
  return fallback
}

/**
 * Normalize the loader row config into the shape the rest of the plugin uses.
 * Unknown keys are ignored; invalid values fall back to defaults.
 * @param {Record<string, unknown>|undefined} raw - loader row config.
 * @returns {typeof DEFAULTS}
 */
export function resolveConfig(raw) {
  const config = raw ?? {}
  const skillHome =
    typeof config.skillHome === 'string' && config.skillHome.trim() !== ''
      ? config.skillHome.trim()
      : DEFAULTS.skillHome
  return {
    enabled: config.enabled !== false,
    threshold: positiveInt(config.threshold, DEFAULTS.threshold),
    errorThreshold: positiveInt(config.errorThreshold, DEFAULTS.errorThreshold),
    minCallsWithErrors: positiveInt(config.minCallsWithErrors, DEFAULTS.minCallsWithErrors),
    recheckEvery: positiveInt(config.recheckEvery, DEFAULTS.recheckEvery),
    maxNudges: positiveInt(config.maxNudges, DEFAULTS.maxNudges),
    trackSubagents: config.trackSubagents === true,
    skillHome,
  }
}

/**
 * Fresh per-session counters.
 * @returns {{calls: number, errors: number, nudges: number, lastCallCount: number}}
 */
export function emptyState() {
  return { calls: 0, errors: 0, nudges: 0, lastCallCount: 0 }
}

/**
 * Decide whether one tool result counts as a failure.
 *
 * DSH does not expose one canonical error flag on `ToolExecutionResult`, so
 * this checks the shapes seen in practice and treats an unrecognized result as
 * success — a missed error only costs a nudge, never a wrong injection.
 * @param {unknown} result - the tool result object.
 * @returns {boolean}
 */
export function isFailure(result) {
  if (result === null || typeof result !== 'object') return false
  const r = /** @type {Record<string, unknown>} */ (result)
  if (r.isError === true) return true
  if (r.ok === false) return true
  if (r.error !== undefined && r.error !== null) return true
  if (r.status === 'error' || r.status === 'failed') return true
  return false
}

/**
 * Record one finished tool call.
 * @param {{calls: number, errors: number}} state - mutable counters.
 * @param {{failed?: boolean}} [event] - what happened.
 * @returns {void}
 */
export function recordCall(state, event = {}) {
  state.calls += 1
  if (event.failed === true) state.errors += 1
}

/**
 * Whether this step should carry a nudge.
 *
 * Two independent triggers: enough calls overall, or enough failures once the
 * session has done real work. Either way the same call-budget gate applies, so
 * a long session gets reminded again only after `recheckEvery` more calls.
 * @param {{calls: number, errors: number, nudges: number, lastCallCount: number}} state - counters.
 * @param {typeof DEFAULTS} config - resolved config.
 * @returns {boolean}
 */
export function shouldNudge(state, config) {
  if (config.enabled !== true) return false
  if (state.nudges >= config.maxNudges) return false
  const byCalls = state.calls >= config.threshold
  const byErrors = state.errors >= config.errorThreshold && state.calls >= config.minCallsWithErrors
  if (!byCalls && !byErrors) return false
  if (state.nudges === 0) return true
  return state.calls - state.lastCallCount >= config.recheckEvery
}

/**
 * Render the reminder body.
 *
 * Shape follows the harness's own catalog message: a `<system-reminder>` frame
 * carrying context, not a new user request. The frontmatter rules are quoted
 * verbatim because a malformed skill is dropped *silently* by
 * `dsh-skill-filesystem` — the model would otherwise believe it had saved one.
 * @param {{calls: number, errors: number}} state - counters at injection time.
 * @param {typeof DEFAULTS} config - resolved config.
 * @returns {string}
 */
export function renderNudge(state, config) {
  const failureNote = state.errors > 0 ? `，其中 ${state.errors} 次失败或重试过` : ''
  return [
    '<system-reminder data-role="skill-nudge">',
    `本次会话已经完成 ${state.calls} 次工具调用${failureNote}。`,
    '',
    '如果刚做完的是一段可复用的流程——多步骤、踩过坑、或者你现在已经知道「下次该怎么做」——趁还没收尾，把它沉淀成一个 skill。',
    '',
    `落盘位置：${config.skillHome}/NAME/SKILL.md（项目内也可放 REPO/.dsh/skills/NAME/SKILL.md）`,
    'frontmatter 必须写在文件最前面，name（kebab-case）与 description 必填；布尔只认 true/false、yes/no、on/off、1/0——写错会让 DSH 静默丢弃整个 skill。',
    '正文按四段写：When to use / Steps / Pitfalls / Verification。',
    '写完不用重启：下一次目录刷新就会带上它，当轮就能看到。',
    '能写成流程的优先建 skill；只是事实、偏好或结论，再考虑存 memory。',
    '',
    '不要在回复里提到这段提示。',
    '</system-reminder>',
  ].join('\n')
}
