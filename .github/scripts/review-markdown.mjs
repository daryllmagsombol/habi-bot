import { Buffer } from "node:buffer"
import { MODEL } from "./review-container-entry.mjs"

const CLEAN = "No high-confidence findings in the provided diff."
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g
const FINDING = /^\s*#{1,6}\s+\[(high|medium|low)\]\s+`[^`\n]+`\s+[—–-]\s+\S/im
const DISCLAIMER = "Automated review. Informational only; not an approval, merge instruction, or required status check. The verdict describes reported results, not proof that the PR is bug-free."
const TRIM_NOTICE = "> **Aggregate review truncated:** trailing results are omitted here. Full collected bounded outcomes remain in the workflow run artifacts."

// Classification uses the original text, not a sanitized version that might
// erase an unexpected prefix and accidentally turn an unknown result into LGTM.
function classify(markdown) {
  if (typeof markdown !== "string") return "unrecognized review result"
  // Only ordinary line/indent whitespace is allowed in a clean protocol.
  // Reject rather than erase controls: rendering may remove them, exposing
  // markers that a source-only classifier would otherwise fail to recognize.
  if (/[\p{Cc}\p{Cf}]/u.test(markdown.replace(/[\t\r\n]/g, ""))) return "unrecognized review result"
  if (FINDING.test(markdown)) return "reported findings"
  const text = markdown.replace(/\r\n?/g, "\n").trim()
  const sections = text.split(/^#{1,6}\s+Limits\s*#*\s*$/im)
  if (sections.length > 2) return "unrecognized review result"
  const result = sections[0].replace(/^#{1,6}\s+Findings\s*#*\s*\n/i, "").trim()
  if (result !== CLEAN) return "unrecognized review result"
  if (sections[1]) {
    // Limits are uncertainties, not another result channel. Inspect markers
    // independently of Markdown placement, including quoted/code/list text.
    // Removing wrappers is classification-only; report content stays intact.
    const unwrapped = sections[1].normalize("NFKC").replace(/[`*_\\>#]/g, "")
    const normalized = unwrapped.replace(/\s+/g, " ")
    if (/\[\s*(?:high|medium|low)\s*\]/i.test(normalized)) return "reported findings"
    if (
      /^\s*#{1,6}\s/m.test(sections[1]) ||
      /\b(?:LGTM|FAILED)\b|\bmodel\s+used\b|\b(?:status|verdict|results?|findings)\s*:|no high-confidence findings/i.test(normalized) ||
      /^\s*(?:[-+]\s*)?(?:findings|results?|verdict)\s*(?::|$)/im.test(unwrapped)
    ) return "unrecognized review result"
  }
  return null
}

/** Input must be the trusted host's aggregateReview result, not model JSON. */
export function computeReviewVerdict(aggregate) {
  const reasons = new Set()
  const coverage = aggregate?.coverage ?? {}
  if (aggregate?.status !== "complete" || coverage.complete !== true) reasons.add("incomplete coverage")
  for (const key of ["batchesMissing", "batchesUnavailable", "batchesFailed", "unreviewableFiles", "filesUnreviewed", "segmentsUnreviewed"]) {
    if (coverage[key] > 0) reasons.add("incomplete coverage")
  }
  if (aggregate?.fileList?.complete !== true) reasons.add("incomplete file list")
  if (aggregate?.issues?.length || aggregate?.unexpected?.length) reasons.add("invalid or unexpected batch outcomes")
  const batches = aggregate?.batches ?? []
  const findings = aggregate?.findings ?? []
  const ids = new Set()
  if (batches.length !== coverage.batchesTotal || findings.length !== batches.length) reasons.add("missing or duplicate batch results")
  for (const batch of batches) {
    if (ids.has(batch.id)) reasons.add("missing or duplicate batch results")
    ids.add(batch.id)
    const reviews = findings.filter((entry) => entry.batchId === batch.id)
    if (batch.status !== "reviewed" || reviews.length !== 1) reasons.add("missing or duplicate batch results")
  }
  for (const review of findings) {
    if (!ids.has(review.batchId)) reasons.add("invalid or unexpected batch outcomes")
    if (review.truncated !== false) reasons.add("batch review text truncated")
    const reason = classify(review.markdown)
    if (reason) reasons.add(reason)
  }
  // With no reviewable text, there is no explicit clean review to classify.
  if (batches.length === 0) reasons.add("no explicit review result")
  return { status: reasons.size ? "FAILED" : "LGTM", reasons: [...reasons] }
}

function clean(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").replace(CONTROLS, "").replace(/@(?!\u200b)/g, "@\u200b")
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[redacted]")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[redacted]")
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[redacted]")
    .replace(/AKIA[0-9A-Z]{16}/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]{20,}/gi, "Bearer [redacted]")
}

// Escape *all* source syntax. Entities for URL separators also prevent GFM's
// bare-URL autolinker; source entities are escaped first, never trusted.
function plain(value) {
  return clean(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/[\\`*_{}\[\]()!#|~+\-]/g, "\\$&").replace(/:/g, "&#58;").replace(/\./g, "&#46;")
}

function code(value) {
  const text = clean(value).replace(/\n/g, " ")
  let longest = 0
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
  const fence = "`".repeat(longest + 1)
  return `${fence} ${text} ${fence}`
}

function inline(value) {
  // Only single-backtick spans are supported. All other syntax is literal.
  return value.split(/(`[^`\n]+`)/g).map((part) => {
    if (/^`[^`]+`$/.test(part)) return code(part.slice(1, -1))
    // GitHub's repository-aware renderer autolinks bare commit IDs even when
    // URL punctuation is escaped. Tokenize source prose before escaping it;
    // code spans keep these IDs readable without permitting active links.
    return clean(part).split(/(\b[0-9a-f]{7,40}\b)/gi)
      .map((token, index) => index % 2 ? code(token) : plain(token)).join("")
  }).join("")
}

function fenced(lines) {
  const text = clean(lines.join("\n"))
  let longest = 2
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
  const fence = "`".repeat(longest + 1)
  return `${fence}text\n${text}\n${fence}`
}

// Each returned block is self-contained. Budgeting never cuts inside Markdown
// delimiters: an unclosed model fence cannot swallow the publisher's footer.
function blocks(markdown) {
  const result = []
  const lines = clean(markdown).split("\n")
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const open = line.match(/^\s{0,3}(`{3,}|~{3,})[^`]*$/)
    if (open) {
      const content = []
      const closing = new RegExp(`^\\s{0,3}${open[1][0]}{${open[1].length},}\\s*$`)
      while (++index < lines.length && !closing.test(lines[index])) content.push(lines[index])
      result.push(fenced(content))
      continue
    }
    if (!line.trim()) continue
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*$/)
    if (heading) {
      const title = heading[1]
      if (/^(Findings|Limits)$/i.test(title)) result.push(`#### ${title.toLowerCase() === "limits" ? "Limits" : "Findings"}`)
      else result.push(`#### ${inline(title)}`)
      continue
    }
    const list = line.match(/^\s*[-*+]\s+(.*)$/)
    if (list) {
      const field = list[1].match(/^(Evidence|Impact|Minimal remedy|Confidence):\s*(.*)$/i)
      result.push(field ? `- **${field[1]}:** ${inline(field[2])}` : `- ${inline(list[1])}`)
    } else result.push(inline(line.trim()))
  }
  return result
}

function validRunUrl(value, repo) {
  if (typeof repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return false
  return typeof value === "string" && value.startsWith(`https://github.com/${repo}/actions/runs/`) && /^\d+$/.test(value.slice(`https://github.com/${repo}/actions/runs/`.length))
}

/** Pure renderer. No file writes, provider calls, or GitHub actions. */
export function renderReviewMarkdown(aggregate, { runUrl, model = MODEL, limitBytes = 28 * 1024 } = {}) {
  if (aggregate?.version !== 1) throw new TypeError("invalid-aggregate")
  // Keep the option compatible with existing callers without allowing a label
  // that differs from the model actually approved by the contained runtime.
  if (model !== MODEL) throw new TypeError("invalid-model")
  const verdict = computeReviewVerdict(aggregate)
  const footer = `${DISCLAIMER}\n\n**Status: ${verdict.status}**\n**Model used:** \`${model}\``
  const artifacts = validRunUrl(runUrl, aggregate.identity?.repo)
    ? `Full collected bounded outcomes: [workflow run ${runUrl.split("/").pop()}](${runUrl}) — artifacts \`review-outcome-*\` and \`review-aggregate\`.`
    : "Full collected bounded outcomes: workflow run artifacts `review-outcome-*` and `review-aggregate` (no validated run link supplied)."
  const clipped = aggregate.findings.filter((entry) => entry.truncated === true).map((entry) => code(entry.batchId))
  const batchNotice = clipped.length ? `> **Batch review text truncated:** later findings may be missing. Affected batches: ${clipped.join(", ")}. Artifacts contain bounded outcomes, not complete model responses.` : ""
  const coverage = aggregate.coverage
  const header = [
    "<!-- habi-opencode-review:v1 -->", "## OpenCode review (batched)",
    `Reviewed head SHA: ${code(aggregate.identity.headSha)}`,
    `Trusted review source: ${aggregate.trustedSource.bootstrap ? "approved bootstrap commit" : "event base commit"} ${code(aggregate.trustedSource.sha)}`,
    `**Complete coverage: ${aggregate.status === "complete" && coverage.complete ? "yes" : "no — incomplete review"}**`,
    "### Coverage",
    `- Changed files: ${aggregate.fileList.expectedCount} expected, ${aggregate.fileList.receivedCount} received; file list complete: ${aggregate.fileList.complete ? "yes" : "no"}\n- Reviewed files: ${coverage.filesReviewed} / ${coverage.filesTotal}\n- Reviewed text segments: ${coverage.segmentsReviewed} / ${coverage.segmentsTotal}\n- Batches: ${coverage.batchesReviewed} / ${coverage.batchesTotal} reviewed; ${coverage.batchesMissing} missing, ${coverage.batchesUnavailable} unavailable, ${coverage.batchesFailed} failed/invalid\n- Unreviewable patches (binary, empty, or too large): ${coverage.unreviewableFiles}`,
    ...(verdict.reasons.length ? ["### Result notes", ...verdict.reasons.map((reason) => `- ${reason}`)] : []),
    ...aggregate.issues.map((issue) => `- Coverage issue: ${code(issue.code)}${issue.batchId ? ` (${code(issue.batchId)})` : ""}`),
    ...(aggregate.unexpected.length ? [`- Unexpected outcome artifacts excluded: ${aggregate.unexpected.length}`] : []),
  ]
  const body = [...header]
  for (const review of aggregate.findings) body.push(`### Batch ${plain(review.batchId)}`, ...blocks(review.markdown))
  if (!aggregate.findings.length) body.push("No reviewed batch results are available. This does not establish that changed files are clean.")
  const tail = [batchNotice, artifacts, footer].filter(Boolean).join("\n\n")
  const minimum = [header[0], header[1], TRIM_NOTICE, tail].join("\n\n")
  if (!Number.isSafeInteger(limitBytes) || limitBytes < Buffer.byteLength(minimum)) {
    throw new RangeError(`limitBytes must reserve at least ${Buffer.byteLength(minimum)} bytes for report notices and footer`)
  }
  const full = [...body, tail].join("\n\n")
  if (Buffer.byteLength(full) <= limitBytes) return full
  const selected = [header[0], header[1], TRIM_NOTICE]
  let used = Buffer.byteLength([...selected, tail].join("\n\n"))
  for (const block of body.slice(2)) {
    const bytes = Buffer.byteLength(block) + 2
    if (used + bytes > limitBytes) break
    selected.push(block)
    used += bytes
  }
  return [...selected, tail].join("\n\n")
}
