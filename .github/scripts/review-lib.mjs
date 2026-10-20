import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import path from "node:path"

export const MODEL = "opencode/deepseek-v4.1-flash-free"
export const PROVIDER = "opencode"
export const REVIEW_MARKER = "<!-- habi-opencode-review:v1 -->"
export const INPUT_LIMIT_BYTES = 120_000
export const OUTPUT_LIMIT_BYTES = 24_000
export const RAW_LIMIT_BYTES = 2 * 1024 * 1024
export const COMMENT_LIMIT_BYTES = 60_000
export const CLI_TIMEOUT_MS = 8 * 60 * 1000
export const GITHUB_ACTIONS_BOT_LOGIN = "github-actions[bot]"
export const GITHUB_ACTIONS_BOT_ID = 41898282
export const OUTPUT_TRUNCATION_NOTICE =
  "> **Review text truncated:** the automated review exceeded the output or comment size limit. This review is incomplete; later findings may be missing."

const PROMPT_RESERVE_BYTES = 800

const UNSAFE_CONTROLS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g

export class ReviewFailure extends Error {
  constructor(code) {
    super(code)
    this.name = "ReviewFailure"
    this.code = code
  }
}

export function fail(code) {
  throw new ReviewFailure(code)
}

export function safeCode(value) {
  const code = typeof value === "string" ? value.toLowerCase() : ""
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(code) ? code : "unknown"
}

export function isMain(moduleUrl) {
  if (!process.argv[1]) return false
  return path.resolve(process.argv[1]) === fileURLToPath(moduleUrl)
}

export function isSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value)
}

export function isLowerSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value)
}

export function isRepo(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)
}

export function isPr(value) {
  return Number.isInteger(value) && value > 0
}

export function normalizedRepo(value) {
  return String(value ?? "").toLowerCase()
}

export function validateIdentity(expected, actual, label = "artifact") {
  if (!actual || typeof actual !== "object") fail(`${label}-identity-missing`)
  if (normalizedRepo(actual.repo) !== normalizedRepo(expected.repo)) fail("identity-mismatch")
  if (Number(actual.pr) !== Number(expected.pr)) fail("identity-mismatch")
  if (String(actual.baseSha).toLowerCase() !== String(expected.baseSha).toLowerCase()) fail("identity-mismatch")
  if (String(actual.headSha).toLowerCase() !== String(expected.headSha).toLowerCase()) fail("identity-mismatch")
}

export function buildOpenCodeConfig() {
  const model = MODEL
  return {
    $schema: "https://opencode.ai/config.json",
    model,
    small_model: model,
    default_agent: "review",
    enabled_providers: [PROVIDER],
    share: "disabled",
    autoupdate: false,
    snapshot: false,
    formatter: false,
    lsp: false,
    plugin: [],
    instructions: [],
    skills: { paths: [], urls: [] },
    permission: "deny",
    compaction: { auto: false, prune: false },
    agent: {
      review: {
        mode: "primary",
        model,
        permission: "deny",
        steps: 1,
        description: "Read-only pull request review",
      },
      title: { disable: true },
      summary: { disable: true },
      compaction: { disable: true },
    },
  }
}

export function buildCliEnv({ home, workDir, apiKey } = {}) {
  if (typeof home !== "string" || home.length === 0) fail("temp-missing")
  if (typeof workDir !== "string" || workDir.length === 0) fail("temp-missing")

  const env = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    TMPDIR: path.join(home, "tmp"),
    CI: "1",
    NO_COLOR: "1",
    LANG: "C.UTF-8",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_AUTOCOMPACT: "1",
    OPENCODE_DISABLE_PRUNE: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_PERMISSION: JSON.stringify({ "*": "deny" }),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(buildOpenCodeConfig()),
  }

  if (typeof apiKey === "string" && apiKey.length > 0) {
    env.OPENCODE_API_KEY = apiKey
  }

  for (const key of Object.keys(env)) {
    if (/^(GITHUB|ACTIONS)_/.test(key) || key === "ACTIONS_RUNTIME_TOKEN") fail("env-invalid")
  }

  return env
}

export function buildCliArgs(workDir) {
  return ["run", "--dir", workDir, "--agent", "review", "--model", MODEL, "--title", "PR review", "--format", "json"]
}

export function truncateUtf8(value, limitBytes) {
  const input = String(value ?? "")
  const limit = Math.max(0, Number(limitBytes) || 0)
  const bytes = Buffer.from(input, "utf8")
  if (bytes.length <= limit) return { text: input, truncated: false }
  let end = limit
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true }
}

export function sanitizeReview(value) {
  let text = String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(UNSAFE_CONTROLS, "")
  text = text
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[redacted]")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[redacted]")
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[redacted]")
    .replace(/AKIA[0-9A-Z]{16}/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]{20,}/gi, "Bearer [redacted]")
  return text.trim()
}

export function escapeMentions(value) {
  return String(value ?? "").replace(/@/g, "@\u200b")
}

export function renderInertFence(value) {
  const text = escapeMentions(sanitizeReview(value))
  const runs = [...text.matchAll(/`+/g)].map((match) => match[0].length)
  const fence = "`".repeat(Math.max(3, ...runs.map((length) => length + 1)))
  return `${fence}text\n${text}\n${fence}`
}

function safeStringify(value, limit = 8_000) {
  try {
    return JSON.stringify(value, (_key, item) => (typeof item === "string" ? item.slice(0, 2_000) : item)).slice(
      0,
      limit,
    )
  } catch {
    return ""
  }
}

function statusesFrom(value) {
  const found = new Set()
  const visit = (node, depth) => {
    if (!node || typeof node !== "object" || depth > 4) return
    for (const [key, item] of Object.entries(node)) {
      if (key === "status" || key === "statusCode" || key === "code") {
        const number = Number(item)
        if (Number.isInteger(number) && number >= 100 && number <= 599) found.add(number)
      }
      visit(item, depth + 1)
    }
  }
  visit(value, 0)
  return [...found]
}

export function classifyProviderError(error) {
  const statuses = statusesFrom(error)
  const text = safeStringify(error).toLowerCase()
  if (statuses.includes(429) || /too many requests|rate limit/.test(text)) return "provider-rate-limited"
  if (
    statuses.some((status) => [502, 503, 504, 529].includes(status)) ||
    /quota|usage limit|model .*unavailable|provider .*unavailable|no available model|overloaded|temporarily unavailable|service unavailable/.test(
      text,
    )
  ) {
    return "provider-unavailable"
  }
  return null
}

export function classifyProviderText(value) {
  const text = String(value ?? "").slice(0, 8_000).toLowerCase()
  if (/(^|[^0-9])429([^0-9]|$)|too many requests|rate limit/.test(text)) return "provider-rate-limited"
  if (
    /quota|usage limit|model .*unavailable|provider .*unavailable|no available model|overloaded|temporarily unavailable|service unavailable/.test(
      text,
    )
  ) {
    return "provider-unavailable"
  }
  return null
}

export function parseOpenCodeJsonl(raw, exitCode = 0) {
  const lines = String(raw ?? "").split(/\r?\n/)
  let sawStepFinish = false
  let stepReason
  let errorEvent
  const texts = []

  for (const line of lines) {
    if (line.trim().length === 0) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      fail("malformed-jsonl")
    }
    if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string") {
      fail("malformed-event")
    }

    switch (event.type) {
      case "step_start":
        break
      case "step_finish": {
        if (!event.part || typeof event.part.reason !== "string") fail("invalid-step-finish")
        sawStepFinish = true
        stepReason = event.part.reason
        break
      }
      case "text": {
        const part = event.part
        if (!part || part.type !== "text" || typeof part.text !== "string") fail("invalid-text")
        if (part.time?.end && part.text.trim().length > 0) texts.push(part.text)
        break
      }
      case "reasoning":
        break
      case "tool_use":
        fail("tool-use")
        break
      case "error":
        errorEvent = event.error ?? event.properties?.error ?? {}
        break
      default:
        fail("unexpected-event")
    }
  }

  if (errorEvent) {
    const code = classifyProviderError(errorEvent)
    if (code) return { status: "unavailable", code }
    fail("cli-error")
  }
  if (exitCode !== 0) fail("cli-exit")
  if (!sawStepFinish) fail("missing-step-finish")
  if (stepReason === "tool-calls") fail("tool-use")
  if (stepReason === "length") fail("output-length")
  if (stepReason === "content-filter") fail("content-filter")
  if (stepReason === "error") fail("step-error")
  if (stepReason !== "stop") fail("step-not-stop")
  if (texts.length === 0) fail("missing-text")

  const cut = truncateUtf8(sanitizeReview(texts[texts.length - 1]), OUTPUT_LIMIT_BYTES)
  if (cut.text.length === 0) fail("empty-text")
  return { status: "reviewed", text: cut.text, truncated: cut.truncated }
}

export function renderCoverage(coverage = {}, trustedSource) {
  const count = (value) => (Number.isInteger(value) && value >= 0 ? value : 0)
  const lines = [
    `- Changed files: ${count(coverage.filesChanged)}`,
    `- File list truncated by GitHub API: ${coverage.fileListTruncated === true ? "yes" : "no"}`,
    `- Files included in prompt: ${count(coverage.filesIncluded)}`,
    `- Files omitted by input limit: ${count(coverage.filesOmitted)}`,
    `- Patches unavailable (binary, empty, or too large): ${count(coverage.patchesUnavailable)}`,
    `- Patches truncated by input limit: ${count(coverage.truncatedFiles)}`,
    `- Complete diff included: ${coverage.complete === true ? "yes" : "no"}`,
    `- Prompt bytes: ${count(coverage.inputBytes)} / ${count(coverage.inputLimitBytes)}`,
  ]
  if (trustedSource && isSha(trustedSource.sha)) {
    lines.push(
      trustedSource.bootstrap === true
        ? `- Trusted review source: approved bootstrap commit \`${trustedSource.sha}\``
        : "- Trusted review source: event base commit",
    )
  }
  return lines
}

export function validateOutcome(outcome) {
  if (!outcome || typeof outcome !== "object") fail("invalid-outcome")
  if (outcome.version !== 1) fail("invalid-outcome")
  if (outcome.status !== "reviewed" && outcome.status !== "unavailable") fail("invalid-outcome")
  if (outcome.status === "reviewed") {
    if (!outcome.review || typeof outcome.review.markdown !== "string" || outcome.review.markdown.trim().length === 0) {
      fail("invalid-outcome")
    }
  } else if (!outcome.diagnostic || typeof outcome.diagnostic.code !== "string") {
    fail("invalid-outcome")
  }
  if (outcome.trustedSource !== undefined) {
    if (
      !outcome.trustedSource ||
      !isLowerSha(outcome.trustedSource.sha) ||
      typeof outcome.trustedSource.bootstrap !== "boolean"
    ) {
      fail("invalid-outcome")
    }
    if (outcome.trustedSource.bootstrap === false && outcome.trustedSource.sha !== outcome.baseSha) {
      fail("invalid-outcome")
    }
  }
}

export function renderComment(outcome) {
  validateOutcome(outcome)
  const tail = [
    "",
    "<details><summary>Review coverage</summary>",
    "",
    "Review scope is limited to the provided diff; omitted or unavailable changes cannot be assessed.",
    "",
    ...renderCoverage(outcome.coverage, outcome.trustedSource),
    "",
    "</details>",
    "",
    "<sub>Automated review. Informational only; not an approval, merge instruction, or required status check.</sub>",
  ]

  const assemble = (reviewFence, showNotice) => {
    const lines = [REVIEW_MARKER, "## OpenCode review", ""]
    if (outcome.status === "reviewed") {
      if (showNotice) lines.push(OUTPUT_TRUNCATION_NOTICE, "")
      lines.push(reviewFence)
    } else {
      lines.push("The automated review could not run because the model or provider was unavailable.")
      lines.push("")
      lines.push(`Diagnostic: \`${safeCode(outcome.diagnostic.code)}\``)
      lines.push("")
      lines.push("This is informational and does not fail required CI.")
    }
    lines.push(...tail)
    return lines.join("\n")
  }

  if (outcome.status !== "reviewed") {
    return truncateUtf8(assemble("", false), COMMENT_LIMIT_BYTES).text
  }

  let markdown = sanitizeReview(outcome.review.markdown)
  let truncated = outcome.review.truncated === true
  let fenced = renderInertFence(markdown)
  let body = assemble(fenced, truncated)

  while (Buffer.byteLength(body) > COMMENT_LIMIT_BYTES) {
    truncated = true
    const currentBytes = Buffer.byteLength(markdown)
    if (currentBytes === 0) break
    const nextLimit = Math.max(0, currentBytes - Math.max(1, Math.ceil(currentBytes * 0.2)))
    markdown = truncateUtf8(markdown, nextLimit).text
    fenced = renderInertFence(markdown)
    body = assemble(fenced, true)
  }

  if (truncated) body = assemble(fenced, true)
  return truncateUtf8(body, COMMENT_LIMIT_BYTES).text
}

export function findBotComment(comments) {
  if (!Array.isArray(comments)) return null
  return (
    comments
      .filter((comment) => {
        if (typeof comment?.body !== "string" || !comment.body.trimStart().startsWith(REVIEW_MARKER)) return false
        const author = comment.user
        if (!author || author.type !== "Bot" || author.login !== GITHUB_ACTIONS_BOT_LOGIN) return false
        // This lane targets GitHub.com. When an id is present, require the stable Actions bot id.
        if (author.id !== undefined && Number(author.id) !== GITHUB_ACTIONS_BOT_ID) return false
        return true
      })
      .sort((left, right) => Number(left.id) - Number(right.id))[0] ?? null
  )
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}
