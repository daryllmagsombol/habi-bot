import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import path from "node:path"

export const MODEL = "opencode/deepseek-v4.1-flash-free"
export const REVIEW_MARKER = "<!-- habi-opencode-review:v1 -->"
export const INPUT_LIMIT_BYTES = 120_000
export const OUTPUT_LIMIT_BYTES = 24_000
export const RAW_LIMIT_BYTES = 2 * 1024 * 1024
export const COMMENT_LIMIT_BYTES = 60_000
export const AGGREGATE_COMMENT_LIMIT_BYTES = 28 * 1024
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

export const MANIFEST_VERSION = 2
export const MAX_BATCHES = 256
export const MAX_OUTCOME_FILE_BYTES = 64 * 1024
export const AGGREGATE_TRUNCATION_NOTICE =
  "> **Aggregate review truncated:** the collected findings exceeded the comment budget. The full bounded per-batch outcomes remain available in the linked workflow run artifacts; trailing findings may be omitted here."
export const BATCH_TRUNCATION_NOTICE =
  "> **Batch review text truncated:** input coverage can be complete while one or more model outputs were clipped at the review output limit, so later findings in those batches may be missing. The linked workflow artifacts contain the collected bounded outcomes, not the complete model response."

const HEX64 = /^[0-9a-f]{64}$/
const FILE_ID = /^f[0-9]{4,}$/
const SEGMENT_ID = /^s[0-9]{6,}$/

export function isBatchId(value) {
  return typeof value === "string" && /^b[0-9]{4}$/.test(value)
}

function isFileId(value) {
  return typeof value === "string" && FILE_ID.test(value)
}

function isSegmentId(value) {
  return typeof value === "string" && SEGMENT_ID.test(value)
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0
}

function isHex64(value) {
  return typeof value === "string" && HEX64.test(value)
}

function isOptionalPosition(value) {
  return value === null || (Number.isInteger(value) && value >= 0)
}

export function isRunUrl(value, repo) {
  if (typeof value !== "string" || !isRepo(repo)) return false
  const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`^https://github\\.com/${escaped}/actions/runs/[0-9]+$`).test(value)
}

export function sameIdentity(left, right) {
  return (
    normalizedRepo(left?.repo) === normalizedRepo(right?.repo) &&
    Number(left?.pr) === Number(right?.pr) &&
    String(left?.baseSha).toLowerCase() === String(right?.baseSha).toLowerCase() &&
    String(left?.headSha).toLowerCase() === String(right?.headSha).toLowerCase()
  )
}

export function sameTrustedSource(left, right) {
  return (
    Boolean(left) &&
    Boolean(right) &&
    isLowerSha(left.sha) &&
    isLowerSha(right.sha) &&
    left.sha === right.sha &&
    left.bootstrap === right.bootstrap
  )
}

/**
 * Validate the trusted preparation manifest v2 shape and internal ID
 * cross-references. The manifest is a same-run trusted artifact; this is a
 * strict schema/identity check, not an independent security signature.
 */
export function validateReviewManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) fail("invalid-manifest")
  if (manifest.version !== MANIFEST_VERSION) fail("invalid-manifest")
  const identity = manifest.identity
  if (
    !identity ||
    !isRepo(identity.repo) ||
    !isPr(identity.pr) ||
    !isSha(identity.baseSha) ||
    !isSha(identity.headSha)
  ) {
    fail("invalid-manifest")
  }
  const trusted = manifest.trustedSource
  if (!trusted || !isLowerSha(trusted.sha) || typeof trusted.bootstrap !== "boolean") {
    fail("invalid-manifest")
  }
  if (trusted.bootstrap === false && trusted.sha !== String(identity.baseSha).toLowerCase()) {
    fail("invalid-manifest")
  }
  const list = manifest.fileList
  if (
    !list ||
    !Number.isInteger(list.expectedCount) ||
    list.expectedCount < 0 ||
    !Number.isInteger(list.receivedCount) ||
    list.receivedCount < 0 ||
    typeof list.complete !== "boolean"
  ) {
    fail("invalid-manifest")
  }
  if (list.complete === true && list.expectedCount !== list.receivedCount) fail("invalid-manifest")
  if (
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.unreviewableFiles) ||
    !Array.isArray(manifest.batches)
  ) {
    fail("invalid-manifest")
  }
  if (manifest.batches.length > MAX_BATCHES) fail("too-many-batches")

  const files = new Map()
  for (const file of manifest.files) {
    if (
      !file ||
      !isFileId(file.id) ||
      !isNonEmptyString(file.filename) ||
      !isNonEmptyString(file.status) ||
      !Number.isInteger(file.patchBytes) ||
      file.patchBytes < 0 ||
      !isHex64(file.patchSha256) ||
      !Number.isInteger(file.segmentCount) ||
      file.segmentCount < 0
    ) {
      fail("invalid-manifest")
    }
    if (files.has(file.id)) fail("invalid-manifest")
    files.set(file.id, file)
  }

  const unreviewable = new Set()
  for (const file of manifest.unreviewableFiles) {
    if (
      !file ||
      !isFileId(file.fileId) ||
      !isNonEmptyString(file.filename) ||
      !isNonEmptyString(file.reason)
    ) {
      fail("invalid-manifest")
    }
    if (unreviewable.has(file.fileId)) fail("invalid-manifest")
    unreviewable.add(file.fileId)
    const known = files.get(file.fileId)
    if (known) {
      if (known.segmentCount !== 0) fail("invalid-manifest")
      if (known.filename !== file.filename) fail("invalid-manifest")
    }
  }
  for (const file of manifest.files) {
    if (file.segmentCount === 0 && !unreviewable.has(file.id)) fail("invalid-manifest")
    if (file.segmentCount > 0 && unreviewable.has(file.id)) fail("invalid-manifest")
  }
  const allFileIds = new Set([...files.keys(), ...unreviewable])
  if (list.receivedCount !== allFileIds.size) fail("invalid-manifest")

  const batchIds = new Set()
  const segmentIds = new Set()
  const segmentCounts = new Map()
  for (const batch of manifest.batches) {
    if (
      !batch ||
      !isBatchId(batch.id) ||
      !isHex64(batch.promptSha256) ||
      !Number.isInteger(batch.inputBytes) ||
      batch.inputBytes < 0 ||
      batch.inputBytes > INPUT_LIMIT_BYTES ||
      !Array.isArray(batch.segments)
    ) {
      fail("invalid-manifest")
    }
    if (batchIds.has(batch.id)) fail("invalid-manifest")
    batchIds.add(batch.id)
    for (const segment of batch.segments) {
      if (
        !segment ||
        !isSegmentId(segment.id) ||
        !isFileId(segment.fileId) ||
        !isNonEmptyString(segment.filename) ||
        (segment.hunkId !== null && !isNonEmptyString(segment.hunkId)) ||
        !Number.isInteger(segment.fragmentIndex) ||
        !Number.isInteger(segment.fragmentCount) ||
        segment.fragmentIndex < 1 ||
        segment.fragmentIndex > segment.fragmentCount ||
        !isOptionalPosition(segment.oldStart) ||
        !isOptionalPosition(segment.newStart) ||
        !isHex64(segment.textSha256) ||
        !Number.isInteger(segment.textBytes) ||
        segment.textBytes < 0
      ) {
        fail("invalid-manifest")
      }
      if (segmentIds.has(segment.id)) fail("invalid-manifest")
      segmentIds.add(segment.id)
      const file = files.get(segment.fileId)
      if (!file || file.filename !== segment.filename) fail("invalid-manifest")
      segmentCounts.set(segment.fileId, (segmentCounts.get(segment.fileId) ?? 0) + 1)
    }
  }
  for (const file of manifest.files) {
    if ((segmentCounts.get(file.id) ?? 0) !== file.segmentCount) fail("invalid-manifest")
  }
  return manifest
}

export function findManifestBatch(manifest, batchId) {
  if (!isBatchId(batchId)) fail("invalid-batch")
  const matches = manifest.batches.filter((batch) => batch.id === batchId)
  if (matches.length === 0) fail("batch-not-found")
  if (matches.length > 1) fail("batch-duplicate")
  return matches[0]
}

function validOutcomeForBatch(outcome, batch, manifest) {
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) {
    return { ok: false, code: "invalid-outcome" }
  }
  if (outcome.version !== 1) return { ok: false, code: "invalid-outcome" }
  if (outcome.batchId !== batch.id) return { ok: false, code: "batch-mismatch" }
  if (outcome.promptSha256 !== batch.promptSha256) return { ok: false, code: "prompt-hash-mismatch" }
  if (!sameIdentity(outcome, manifest.identity)) return { ok: false, code: "identity-mismatch" }
  if (!sameTrustedSource(outcome.trustedSource, manifest.trustedSource)) {
    return { ok: false, code: "trusted-source-mismatch" }
  }
  if (outcome.model !== MODEL) return { ok: false, code: "model-mismatch" }
  if (outcome.status === "reviewed") {
    if (
      !outcome.review ||
      typeof outcome.review.markdown !== "string" ||
      outcome.review.markdown.trim().length === 0 ||
      !Number.isInteger(outcome.review.bytes) ||
      typeof outcome.review.truncated !== "boolean"
    ) {
      return { ok: false, code: "invalid-outcome" }
    }
    return { ok: true, status: "reviewed" }
  }
  if (outcome.status === "unavailable" || outcome.status === "error") {
    if (!outcome.diagnostic || typeof outcome.diagnostic.code !== "string") {
      return { ok: false, code: "invalid-outcome" }
    }
    return { ok: true, status: outcome.status, diagnostic: outcome.diagnostic }
  }
  return { ok: false, code: "invalid-outcome" }
}

function aggregateIssue(issues, code, batchId, extra = {}) {
  issues.push({ code: safeCode(code), ...(batchId ? { batchId } : {}), ...extra })
}

/**
 * Deterministically aggregate bounded per-batch outcomes against the trusted
 * preparation manifest. Outcomes are untrusted data and never define expected
 * coverage, identity, hashes, or completeness.
 */
export function aggregateReview(manifest, outcomes = []) {
  validateReviewManifest(manifest)
  const expected = new Map(manifest.batches.map((batch) => [batch.id, batch]))
  const byBatch = new Map()
  const unexpected = []
  const issues = []

  for (const entry of Array.isArray(outcomes) ? outcomes : []) {
    if (entry && entry.malformed === true) {
      const batchId = isBatchId(entry.batchId) ? entry.batchId : null
      if (batchId && expected.has(batchId)) {
        if (!byBatch.has(batchId)) byBatch.set(batchId, [])
        byBatch.get(batchId).push(entry)
      } else {
        unexpected.push({ source: entry.source ?? null, code: safeCode(entry.code ?? "malformed-outcome") })
      }
      continue
    }
    const batchId = entry?.batchId
    if (!isBatchId(batchId) || !expected.has(batchId)) {
      unexpected.push({
        source: typeof entry?.source === "string" ? entry.source : null,
        batchId: typeof batchId === "string" ? safeCode(batchId) : null,
        code: "unexpected-batch",
      })
      continue
    }
    if (!byBatch.has(batchId)) byBatch.set(batchId, [])
    byBatch.get(batchId).push(entry)
  }

  const batches = []
  const findings = []
  let reviewed = 0
  let unavailable = 0
  let failed = 0
  let missing = 0
  for (const expectedBatch of manifest.batches) {
    const entries = byBatch.get(expectedBatch.id) ?? []
    if (entries.length === 0) {
      missing += 1
      batches.push({ id: expectedBatch.id, status: "missing", promptSha256: expectedBatch.promptSha256 })
      aggregateIssue(issues, "missing-batch", expectedBatch.id)
      continue
    }
    if (entries.length > 1) {
      failed += 1
      batches.push({ id: expectedBatch.id, status: "invalid", promptSha256: expectedBatch.promptSha256 })
      aggregateIssue(issues, "duplicate-batch", expectedBatch.id, { count: entries.length })
      continue
    }
    const entry = entries[0]
    if (entry.malformed === true) {
      failed += 1
      batches.push({ id: expectedBatch.id, status: "invalid", promptSha256: expectedBatch.promptSha256 })
      aggregateIssue(issues, entry.code ?? "malformed-outcome", expectedBatch.id)
      continue
    }
    const valid = validOutcomeForBatch(entry, expectedBatch, manifest)
    if (!valid.ok) {
      failed += 1
      batches.push({ id: expectedBatch.id, status: "invalid", promptSha256: expectedBatch.promptSha256 })
      aggregateIssue(issues, valid.code, expectedBatch.id)
      continue
    }
    if (valid.status === "reviewed") {
      reviewed += 1
      batches.push({ id: expectedBatch.id, status: "reviewed", promptSha256: expectedBatch.promptSha256 })
      findings.push({
        batchId: expectedBatch.id,
        promptSha256: expectedBatch.promptSha256,
        markdown: entry.review.markdown,
        truncated: entry.review.truncated === true,
      })
      continue
    }
    if (valid.status === "unavailable") {
      unavailable += 1
      batches.push({
        id: expectedBatch.id,
        status: "unavailable",
        promptSha256: expectedBatch.promptSha256,
        diagnostic: valid.diagnostic,
      })
      aggregateIssue(issues, "unavailable-batch", expectedBatch.id, {
        diagnostic: safeCode(valid.diagnostic.code),
      })
      continue
    }
    failed += 1
    batches.push({
      id: expectedBatch.id,
      status: "error",
      promptSha256: expectedBatch.promptSha256,
      diagnostic: valid.diagnostic,
    })
    aggregateIssue(issues, "error-batch", expectedBatch.id, { diagnostic: safeCode(valid.diagnostic.code) })
  }

  const reviewedBatchIds = new Set(batches.filter((batch) => batch.status === "reviewed").map((batch) => batch.id))
  const reviewedSegmentIds = new Set()
  for (const batch of manifest.batches) {
    if (reviewedBatchIds.has(batch.id)) {
      for (const segment of batch.segments) reviewedSegmentIds.add(segment.id)
    }
  }

  const fileSegmentIds = new Map()
  for (const batch of manifest.batches) {
    for (const segment of batch.segments) {
      if (!fileSegmentIds.has(segment.fileId)) fileSegmentIds.set(segment.fileId, [])
      fileSegmentIds.get(segment.fileId).push(segment.id)
    }
  }

  const files = manifest.files.map((file) => {
    const segmentIds = fileSegmentIds.get(file.id) ?? []
    const fileReviewed =
      file.segmentCount > 0 &&
      segmentIds.length === file.segmentCount &&
      segmentIds.every((id) => reviewedSegmentIds.has(id))
    return {
      id: file.id,
      filename: file.filename,
      status: file.status,
      segmentCount: file.segmentCount,
      reviewed: fileReviewed,
    }
  })
  const filesReviewed = files.filter((file) => file.reviewed).length
  const segmentsTotal = manifest.batches.reduce((total, batch) => total + batch.segments.length, 0)
  const segmentsReviewed = reviewedSegmentIds.size
  const fileListComplete =
    manifest.fileList.complete === true && manifest.fileList.expectedCount === manifest.fileList.receivedCount
  const complete =
    fileListComplete &&
    manifest.unreviewableFiles.length === 0 &&
    unexpected.length === 0 &&
    issues.length === 0 &&
    manifest.batches.length === reviewed &&
    segmentsReviewed === segmentsTotal &&
    filesReviewed === manifest.files.length &&
    manifest.files.every((file) => file.segmentCount > 0)

  return {
    version: 1,
    status: complete ? "complete" : "incomplete",
    identity: manifest.identity,
    trustedSource: manifest.trustedSource,
    fileList: manifest.fileList,
    files,
    batches,
    findings,
    issues,
    unexpected,
    coverage: {
      filesTotal: manifest.files.length + manifest.unreviewableFiles.filter((file) => !manifest.files.some((known) => known.id === file.fileId)).length,
      filesReviewed,
      filesUnreviewed:
        manifest.files.length +
        manifest.unreviewableFiles.filter((file) => !manifest.files.some((known) => known.id === file.fileId)).length -
        filesReviewed,
      segmentsTotal,
      segmentsReviewed,
      segmentsUnreviewed: segmentsTotal - segmentsReviewed,
      unreviewableFiles: manifest.unreviewableFiles.length,
      batchesTotal: manifest.batches.length,
      batchesReviewed: reviewed,
      batchesUnavailable: unavailable,
      batchesFailed: failed,
      batchesMissing: missing,
      complete,
    },
  }
}

export function renderAggregateComment(aggregate, { runUrl } = {}) {
  if (!aggregate || aggregate.version !== 1) fail("invalid-aggregate")
  if (!isRunUrl(runUrl, aggregate.identity?.repo)) fail("invalid-run-url")
  const coverage = aggregate.coverage
  const complete = aggregate.status === "complete" && coverage.complete === true
  const statusLine = complete
    ? "Complete coverage: yes"
    : "Complete coverage: no — this report is incomplete and is not evidence that the diff is clean."
  const lines = [
    REVIEW_MARKER,
    "## OpenCode review (batched)",
    "",
    `Reviewed head SHA: \`${aggregate.identity.headSha}\``,
    `Trusted review source: ${aggregate.trustedSource.bootstrap ? "approved bootstrap commit" : "event base commit"} \`${aggregate.trustedSource.sha}\``,
    "",
    statusLine,
    "",
    "<details><summary>Review coverage</summary>",
    "",
    `- Changed files: ${aggregate.fileList.expectedCount} expected, ${aggregate.fileList.receivedCount} received; file list complete: ${aggregate.fileList.complete ? "yes" : "no"}`,
    `- Reviewed files: ${coverage.filesReviewed} / ${coverage.filesTotal}`,
    `- Reviewed text segments: ${coverage.segmentsReviewed} / ${coverage.segmentsTotal}`,
    `- Batches: ${coverage.batchesReviewed} reviewed, ${coverage.batchesMissing} missing, ${coverage.batchesUnavailable} unavailable, ${coverage.batchesFailed} failed/invalid`,
    `- Unreviewable patches (binary, empty, or too large): ${coverage.unreviewableFiles}`,
    "",
    "</details>",
    "",
  ]

  if (aggregate.issues.length > 0 || aggregate.unexpected.length > 0) {
    lines.push("Incomplete coverage details:")
    lines.push("")
    const counts = new Map()
    for (const issue of aggregate.issues) counts.set(issue.code, (counts.get(issue.code) ?? 0) + 1)
    for (const [code, count] of counts) lines.push(`- ${safeCode(code)}: ${count}`)
    if (aggregate.unexpected.length > 0) {
      lines.push(`- unexpected outcome artifacts excluded: ${aggregate.unexpected.length}`)
    }
    lines.push("")
  }

  const findingsBody = aggregate.findings
    .map((finding) => `### Batch ${finding.batchId}\n\n${finding.markdown}`)
    .join("\n\n")
  const truncatedBatchIds = aggregate.findings
    .filter((finding) => finding.truncated === true)
    .map((finding) => finding.batchId)
  const noFindings =
    coverage.segmentsTotal === 0
      ? "No reviewable text was available in this run. This does not establish that changed files are clean."
      : complete
        ? "No high-confidence findings in the provided diff."
        : "No high-confidence findings in the reviewed batches. Missing, unavailable, or failed batches were not reviewed."

  const tail = [
    "",
    "<details><summary>Full results</summary>",
    "",
    `Full bounded per-batch outcomes: [workflow run ${runUrl.split("/").pop()}](${runUrl}) (artifacts \`review-outcome-*\` and \`review-aggregate\`).`,
    "",
    "</details>",
    "",
    `<sub>Automated review. Informational only; not an approval, merge instruction, or required status check.${coverage.complete ? "" : " Coverage is incomplete as disclosed above."}</sub>`,
  ]

  const assemble = (markdown, truncated) => {
    const bodyLines = [...lines]
    if (truncated) bodyLines.push(AGGREGATE_TRUNCATION_NOTICE, "")
    if (truncatedBatchIds.length > 0) {
      bodyLines.push(`${BATCH_TRUNCATION_NOTICE} Affected batches: ${truncatedBatchIds.join(", ")}.`, "")
    }
    if (markdown.length > 0) bodyLines.push(renderInertFence(markdown))
    else bodyLines.push(noFindings)
    bodyLines.push(...tail)
    return bodyLines.join("\n")
  }

  if (findingsBody.length === 0) {
    return truncateUtf8(assemble("", false), AGGREGATE_COMMENT_LIMIT_BYTES).text
  }

  let markdown = findingsBody
  let truncated = false
  let body = assemble(markdown, truncated)
  while (Buffer.byteLength(body) > AGGREGATE_COMMENT_LIMIT_BYTES && markdown.length > 0) {
    truncated = true
    const currentBytes = Buffer.byteLength(markdown)
    const nextLimit = Math.max(0, currentBytes - Math.max(1, Math.ceil(currentBytes * 0.2)))
    markdown = truncateUtf8(markdown, nextLimit).text
    body = assemble(markdown, true)
  }
  if (truncated) body = assemble(markdown, true)
  return truncateUtf8(body, AGGREGATE_COMMENT_LIMIT_BYTES).text
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
  let longestRun = 0
  for (const match of text.matchAll(/`+/g)) {
    if (match[0].length > longestRun) longestRun = match[0].length
  }
  const fence = "`".repeat(Math.max(3, longestRun + 1))
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
