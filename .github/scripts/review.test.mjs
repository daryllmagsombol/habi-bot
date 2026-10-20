import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  AGGREGATE_COMMENT_LIMIT_BYTES,
  AGGREGATE_TRUNCATION_NOTICE,
  BATCH_TRUNCATION_NOTICE,
  GITHUB_ACTIONS_BOT_ID,
  GITHUB_ACTIONS_BOT_LOGIN,
  INPUT_LIMIT_BYTES,
  MAX_BATCHES,
  MODEL,
  OUTPUT_TRUNCATION_NOTICE,
  REVIEW_MARKER,
  aggregateReview,
  classifyProviderError,
  escapeMentions,
  findBotComment,
  parseOpenCodeJsonl,
  renderAggregateComment,
  renderComment,
  renderInertFence,
  sanitizeReview,
  sha256,
  truncateUtf8,
  validateReviewManifest,
} from "./review-lib.mjs"
import { runReview } from "./review-model.mjs"
import { publishAggregate, publishOutcome, readOutcomeEntries } from "./review-publish.mjs"
import { buildReviewBatches } from "./review-batches.mjs"
import { ContainerFailure, buildContainedConfig } from "./review-container.mjs"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const REPO = "daryllmagsombol/habi-bot"
const BASE = "a".repeat(40)
const HEAD = "b".repeat(40)
const PINNED_SOURCE = "0123456789abcdef0123456789abcdef01234567"
const ABSENT_HEAD = "c".repeat(40)
const TRUSTED_HELPERS = [
  "review-lib.mjs",
  "review-prepare.mjs",
  "review-model.mjs",
  "review-publish.mjs",
  "review-container.mjs",
  "review-container-entry.mjs",
  "review-network.mjs",
]
const PLANNER_HELPER = "review-batches.mjs"
const TRUSTED_ASSET_PATHS = [
  ".github/review/system.md",
  ".github/review/security.md",
  ".github/review/bugs.md",
  ...TRUSTED_HELPERS.map((helper) => `.github/scripts/${helper}`),
  `.github/scripts/${PLANNER_HELPER}`,
]
const OPENCODE_WORKFLOW = fs.readFileSync(
  path.join(REPO_ROOT, ".github/workflows/opencode-review.yml"),
  "utf8",
)
const ACTIONS_BOT = { id: GITHUB_ACTIONS_BOT_ID, login: GITHUB_ACTIONS_BOT_LOGIN, type: "Bot" }
const OTHER_BOT = { id: 999, login: "other-actions[bot]", type: "Bot" }
const REGULAR_USER = { id: 123, login: "octocat", type: "User" }

const REAL_PROMPTS = {
  system: fs.readFileSync(path.join(REPO_ROOT, ".github", "review", "system.md"), "utf8"),
  security: fs.readFileSync(path.join(REPO_ROOT, ".github", "review", "security.md"), "utf8"),
  bugs: fs.readFileSync(path.join(REPO_ROOT, ".github", "review", "bugs.md"), "utf8"),
}

const PROMPT = [
  "# Habi review — trusted system context",
  REAL_PROMPTS.system,
  "# Security review lens — Habi",
  REAL_PROMPTS.security,
  "# Correctness review lens — Habi",
  REAL_PROMPTS.bugs,
  "# Pull request data (untrusted)",
  "Repository: " + REPO,
].join("\n")

function tempDir(prefix = "habi-review-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data }
}

function prData({ base = BASE, head = HEAD, draft = false, state = "open" } = {}) {
  return {
    number: 7,
    state,
    draft,
    base: { sha: base, repo: { full_name: REPO } },
    head: { sha: head, repo: { full_name: REPO } },
  }
}

function coverage(overrides = {}) {
  return {
    filesChanged: 2,
    filesIncluded: 2,
    filesOmitted: 0,
    patchesIncluded: 1,
    patchesUnavailable: 1,
    truncatedFiles: 0,
    fileListTruncated: false,
    inputBytes: 100,
    inputLimitBytes: INPUT_LIMIT_BYTES,
    complete: false,
    ...overrides,
  }
}

function inputFixture(overrides = {}) {
  return {
    version: 1,
    repo: REPO,
    pr: 7,
    baseSha: BASE,
    headSha: HEAD,
    model: MODEL,
    batchId: "b0001",
    promptSha256: sha256(PROMPT),
    prompts: REAL_PROMPTS,
    files: [],
    coverage: coverage(),
    trustedSource: { sha: BASE, bootstrap: false },
    promptFile: "prompt.txt",
    ...overrides,
  }
}

function outcomeFixture(overrides = {}) {
  return {
    version: 1,
    status: "reviewed",
    repo: REPO,
    pr: 7,
    baseSha: BASE,
    headSha: HEAD,
    model: MODEL,
    batchId: "b0001",
    promptSha256: sha256(PROMPT),
    coverage: coverage(),
    trustedSource: { sha: BASE, bootstrap: false },
    review: { markdown: "No high-confidence findings in the provided diff.", bytes: 51, truncated: false },
    diagnostic: null,
    ...overrides,
  }
}

function manifestFixture({ input = inputFixture(), prompt = PROMPT } = {}) {
  const text = "+new\n"
  const batchId = input.batchId ?? "b0001"
  return {
    version: 2,
    identity: { repo: input.repo, pr: input.pr, baseSha: input.baseSha, headSha: input.headSha },
    trustedSource: input.trustedSource ?? { sha: input.baseSha, bootstrap: false },
    fileList: { expectedCount: 1, receivedCount: 1, complete: true },
    files: [
      {
        id: "f0001",
        filename: "apps/web/page.tsx",
        status: "modified",
        sha: "c".repeat(40),
        patchBytes: Buffer.byteLength(text),
        patchSha256: sha256(text),
        segmentCount: 1,
      },
    ],
    unreviewableFiles: [],
    batches: [
      {
        id: batchId,
        promptSha256: sha256(prompt),
        inputBytes: Buffer.byteLength(prompt),
        segments: [
          {
            id: "s000001",
            fileId: "f0001",
            filename: "apps/web/page.tsx",
            hunkId: "h0001",
            fragmentIndex: 1,
            fragmentCount: 1,
            oldStart: 1,
            newStart: 1,
            textSha256: sha256(text),
            textBytes: Buffer.byteLength(text),
          },
        ],
      },
    ],
  }
}

function modelFixture({ input = inputFixture(), prompt = PROMPT, manifest } = {}) {
  const root = tempDir("habi-review-model-")
  const inputPath = path.join(root, "input.json")
  const promptPath = path.join(root, "prompt.txt")
  const manifestPath = path.join(root, "manifest.json")
  const batchId = input.batchId ?? "b0001"
  writeFile(inputPath, JSON.stringify(input))
  writeFile(promptPath, prompt)
  writeFile(manifestPath, JSON.stringify(manifest ?? manifestFixture({ input, prompt })))
  return {
    root,
    inputPath,
    promptPath,
    manifestPath,
    batchId,
    outcomePath: path.join(root, `${batchId}.json`),
  }
}

function twoBatchManifest({ fileList = { expectedCount: 2, receivedCount: 2, complete: true }, unreviewableFiles = [] } = {}) {
  const text1 = "@@ -1 +1 @@\n-old\n+new\n"
  const text2 = "@@ -2 +2 @@\n-old2\n+new2\n"
  const prompt1 = `${PROMPT}\n\nBatch b0001`
  const prompt2 = `${PROMPT}\n\nBatch b0002`
  return {
    version: 2,
    identity: { repo: REPO, pr: 7, baseSha: BASE, headSha: HEAD },
    trustedSource: { sha: BASE, bootstrap: false },
    fileList,
    files: [
      {
        id: "f0001",
        filename: "apps/web/a.ts",
        status: "modified",
        sha: "c".repeat(40),
        patchBytes: Buffer.byteLength(text1),
        patchSha256: sha256(text1),
        segmentCount: 1,
      },
      {
        id: "f0002",
        filename: "apps/web/b.ts",
        status: "modified",
        sha: "d".repeat(40),
        patchBytes: Buffer.byteLength(text2),
        patchSha256: sha256(text2),
        segmentCount: 1,
      },
    ],
    unreviewableFiles,
    batches: [
      {
        id: "b0001",
        promptSha256: sha256(prompt1),
        inputBytes: Buffer.byteLength(prompt1),
        segments: [
          {
            id: "s000001",
            fileId: "f0001",
            filename: "apps/web/a.ts",
            hunkId: "h0001",
            fragmentIndex: 1,
            fragmentCount: 1,
            oldStart: 1,
            newStart: 1,
            textSha256: sha256(text1),
            textBytes: Buffer.byteLength(text1),
          },
        ],
      },
      {
        id: "b0002",
        promptSha256: sha256(prompt2),
        inputBytes: Buffer.byteLength(prompt2),
        segments: [
          {
            id: "s000002",
            fileId: "f0002",
            filename: "apps/web/b.ts",
            hunkId: "h0002",
            fragmentIndex: 1,
            fragmentCount: 1,
            oldStart: 2,
            newStart: 2,
            textSha256: sha256(text2),
            textBytes: Buffer.byteLength(text2),
          },
        ],
      },
    ],
  }
}

function manyBatchManifest(count) {
  const files = []
  const batches = []
  for (let index = 1; index <= count; index += 1) {
    const batchId = `b${String(index).padStart(4, "0")}`
    const fileId = `f${String(index).padStart(4, "0")}`
    const segmentId = `s${String(index).padStart(6, "0")}`
    const text = `@@ -${index} +${index} @@\n-old${index}\n+new${index}\n`
    const prompt = `${PROMPT}\n\nBatch ${batchId}`
    const filename = `apps/web/file-${index}.ts`
    files.push({
      id: fileId,
      filename,
      status: "modified",
      sha: "c".repeat(40),
      patchBytes: Buffer.byteLength(text),
      patchSha256: sha256(text),
      segmentCount: 1,
    })
    batches.push({
      id: batchId,
      promptSha256: sha256(prompt),
      inputBytes: Buffer.byteLength(prompt),
      segments: [
        {
          id: segmentId,
          fileId,
          filename,
          hunkId: `h${String(index).padStart(4, "0")}`,
          fragmentIndex: 1,
          fragmentCount: 1,
          oldStart: index,
          newStart: index,
          textSha256: sha256(text),
          textBytes: Buffer.byteLength(text),
        },
      ],
    })
  }
  return {
    version: 2,
    identity: { repo: REPO, pr: 7, baseSha: BASE, headSha: HEAD },
    trustedSource: { sha: BASE, bootstrap: false },
    fileList: { expectedCount: count, receivedCount: count, complete: true },
    files,
    unreviewableFiles: [],
    batches,
  }
}

function batchOutcome(batchId, manifest, overrides = {}) {
  const batch = manifest.batches.find((entry) => entry.id === batchId)
  assert.ok(batch, `missing fixture batch ${batchId}`)
  const markdown = overrides.review?.markdown ?? `Finding for ${batchId}`
  return outcomeFixture({
    batchId,
    promptSha256: batch.promptSha256,
    review: { markdown, bytes: Buffer.byteLength(markdown), truncated: false },
    ...overrides,
  })
}

const RUN_ID = "12345"

function artifactFixture(name, id) {
  return { id, name, sizeInBytes: 256, expired: false }
}

function artifactMetadataFixture(artifacts, overrides = {}) {
  return {
    version: 1,
    runId: RUN_ID,
    repository: REPO,
    complete: true,
    artifactCount: artifacts.length,
    artifacts,
    ...overrides,
  }
}

function workflowStepScript(stepName) {
  const step = OPENCODE_WORKFLOW.indexOf(`- name: ${stepName}`)
  assert.notEqual(step, -1, `Missing workflow step: ${stepName}`)
  const marker = "node - <<'NODE'"
  const start = OPENCODE_WORKFLOW.indexOf(marker, step)
  assert.notEqual(start, -1, `Missing inline script for: ${stepName}`)
  const after = OPENCODE_WORKFLOW.slice(start + marker.length)
  const end = after.search(/\n\s*NODE\s*(?:\n|$)/)
  assert.notEqual(end, -1, `Missing inline script terminator for: ${stepName}`)
  const lines = after.slice(0, end).split("\n")
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.match(/^ */)[0].length)
  const common = indents.length > 0 ? Math.min(...indents) : 0
  return lines.map((line) => line.slice(Math.min(common, line.match(/^ */)[0].length))).join("\n")
}

function bootstrapSelectorScript() {
  return workflowStepScript("Select trusted review source")
}

function runBootstrapSelector({
  baseAssets = false,
  bootstrapSha = "",
  baseSha = BASE,
  headSha = HEAD,
  omitAsset,
} = {}) {
  const root = tempDir("habi-review-bootstrap-")
  if (baseAssets) {
    for (const relative of TRUSTED_ASSET_PATHS) {
      if (relative === omitAsset) continue
      writeFile(path.join(root, "base", relative), `// fixture ${relative}\n`)
    }
  }
  const scriptPath = path.join(root, "selector.cjs")
  const outputPath = path.join(root, "github-output")
  writeFile(scriptPath, bootstrapSelectorScript())
  writeFile(outputPath, "")
  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_OUTPUT: outputPath,
      WORKSPACE: root,
      BASE_SHA: baseSha,
      BOOTSTRAP_SHA: bootstrapSha,
      HEAD_SHA: headSha,
    },
  })
  const outputText = fs.readFileSync(outputPath, "utf8")
  const outputs = {}
  for (const line of outputText.split("\n")) {
    if (line.length === 0) continue
    const separator = line.indexOf("=")
    outputs[line.slice(0, separator)] = line.slice(separator + 1)
  }
  return { result, outputs }
}

function runBatchMatrix(matrix) {
  const root = tempDir("habi-review-matrix-")
  const scriptPath = path.join(root, "matrix.cjs")
  const outputPath = path.join(root, "output")
  const matrixPath = path.join(root, "matrix.json")
  writeFile(scriptPath, workflowStepScript("Build batch matrix"))
  writeFile(matrixPath, JSON.stringify(matrix))
  writeFile(outputPath, "")
  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_OUTPUT: outputPath,
      MATRIX_PATH: matrixPath,
    },
  })
  const outputs = {}
  for (const line of fs.readFileSync(outputPath, "utf8").split("\n")) {
    if (line.length === 0) continue
    const separator = line.indexOf("=")
    outputs[line.slice(0, separator)] = line.slice(separator + 1)
  }
  return { result, outputs }
}

function jsonl(events) {
  return events.map((event) => JSON.stringify(event)).join("\n")
}

const VALID_JSONL = jsonl([
  { type: "step_start", part: {} },
  { type: "text", part: { type: "text", text: "intermediate", time: { end: 1 } } },
  { type: "text", part: { type: "text", text: "final review", time: { end: 2 } } },
  { type: "step_finish", part: { reason: "stop" } },
])

function spawnResult({ status = 0, stdout = "", stderr = "", error } = {}) {
  return { status, stdout, stderr, error }
}

test("contained config is keyless, single-model, and limits tools to the container", () => {
  const config = buildContainedConfig()
  const permission = { "*": "deny", read: "allow", bash: "allow" }
  assert.equal(config.model, MODEL)
  assert.equal(config.small_model, MODEL)
  assert.equal(config.default_agent, "review")
  assert.deepEqual(config.enabled_providers, ["opencode"])
  assert.equal(config.share, "disabled")
  assert.equal(config.autoupdate, false)
  assert.equal(config.snapshot, false)
  assert.equal(config.formatter, false)
  assert.equal(config.lsp, false)
  assert.deepEqual(config.plugin, [])
  assert.deepEqual(config.instructions, [])
  assert.deepEqual(config.skills, { paths: [], urls: [] })
  assert.deepEqual(config.permission, permission)
  assert.deepEqual(config.compaction, { auto: false, prune: false })
  assert.deepEqual(config.agent.review, {
    mode: "primary",
    model: MODEL,
    permission,
    steps: 1,
    description: "Read-only pull request review",
  })
  assert.deepEqual(config.agent.title, { disable: true })
  assert.deepEqual(config.agent.summary, { disable: true })
  assert.deepEqual(config.agent.compaction, { disable: true })
  assert.equal(JSON.stringify(config).includes("apiKey"), false)
  assert.equal(JSON.stringify(config).includes("OPENCODE_API_KEY"), false)
})

test("JSONL parser accepts only a clean stop with final text", () => {
  const parsed = parseOpenCodeJsonl(VALID_JSONL, 0)
  assert.equal(parsed.status, "reviewed")
  assert.equal(parsed.text, "final review")
  assert.equal(parsed.truncated, false)

  assert.throws(() => parseOpenCodeJsonl("not-json\n", 0), (error) => error.code === "malformed-jsonl")
  assert.throws(() => parseOpenCodeJsonl('{"foo":1}\n', 0), (error) => error.code === "malformed-event")
  assert.throws(() => parseOpenCodeJsonl("", 0), (error) => error.code === "missing-step-finish")
  assert.throws(
    () => parseOpenCodeJsonl(jsonl([{ type: "text", part: { type: "text", text: "only", time: { end: 1 } } }]), 0),
    (error) => error.code === "missing-step-finish",
  )
  assert.throws(
    () =>
      parseOpenCodeJsonl(
        jsonl([
          { type: "text", part: { type: "text", text: "only", time: { end: 1 } } },
          { type: "step_finish", part: { reason: "length" } },
        ]),
        0,
      ),
    (error) => error.code === "output-length",
  )
  assert.throws(
    () =>
      parseOpenCodeJsonl(
        jsonl([{ type: "tool_use", part: { tool: "bash", state: { status: "completed" } } }]),
        0,
      ),
    (error) => error.code === "tool-use",
  )
  assert.throws(
    () =>
      parseOpenCodeJsonl(
        jsonl([{ type: "step_finish", part: { reason: "stop" } }]),
        0,
      ),
    (error) => error.code === "missing-text",
  )
})

test("JSONL parser separates provider limits from parser failures", () => {
  const limited = jsonl([
    { type: "error", error: { name: "APIError", data: { statusCode: 429, message: "rate limit" } } },
  ])
  assert.deepEqual(parseOpenCodeJsonl(limited, 1), { status: "unavailable", code: "provider-rate-limited" })

  const unavailable = jsonl([
    { type: "error", error: { data: { status: 503, message: "service unavailable" } } },
  ])
  assert.deepEqual(parseOpenCodeJsonl(unavailable, 1), { status: "unavailable", code: "provider-unavailable" })

  const fatal = jsonl([{ type: "error", error: { data: { message: "tool schema invalid" } } }])
  assert.throws(() => parseOpenCodeJsonl(fatal, 1), (error) => error.code === "cli-error")
  assert.equal(classifyProviderError({ data: { message: "tool schema invalid" } }), null)
})

test("review output is bounded and control characters are removed", () => {
  const huge = jsonl([
    { type: "text", part: { type: "text", text: "x".repeat(40_000), time: { end: 1 } } },
    { type: "step_finish", part: { reason: "stop" } },
  ])
  const parsed = parseOpenCodeJsonl(huge, 0)
  assert.equal(parsed.truncated, true)
  assert.ok(Buffer.byteLength(parsed.text) <= 24_000)
  assert.equal(sanitizeReview("a\u202eb\u0000c"), "abc")
  assert.equal(truncateUtf8("éé", 3).text, "é")
})

test("runReview delegates to the contained runtime with the fixed keyless config", async () => {
  const fixture = modelFixture()
  let captured
  const execute = async (request) => {
    captured = request
    return spawnResult({ stdout: VALID_JSONL })
  }
  const result = await runReview({
    ...fixture,
    cliPath: "/fake/opencode",
    // A caller-supplied key is ignored: the contained runtime is keyless only.
    apiKey: "provider-key",
    expected: { repo: REPO, pr: 7, baseSha: BASE, headSha: HEAD },
    execute,
  })

  assert.equal(result.exitCode, 0)
  assert.equal(captured.cliPath, "/fake/opencode")
  assert.equal(captured.prompt, PROMPT)
  assert.deepEqual(captured.config, buildContainedConfig())
  assert.equal(Object.hasOwn(captured, "apiKey"), false)
  assert.equal(Object.hasOwn(captured, "spawn"), false)
  assert.equal(Object.hasOwn(captured, "spawnSync"), false)
  assert.equal(JSON.stringify(captured).includes("provider-key"), false)
  assert.equal(JSON.stringify(captured).includes("OPENCODE_API_KEY"), false)
  assert.equal(Object.keys(captured).some((key) => /^(GITHUB|ACTIONS)_/.test(key)), false)
  assert.ok(Number.isInteger(captured.timeoutMs) && captured.timeoutMs > 0)
  assert.ok(Number.isInteger(captured.maxBuffer) && captured.maxBuffer > 0)
  assert.equal(Object.hasOwn(captured, "manifestPath"), false)
  assert.equal(Object.hasOwn(captured, "batchId"), false)
  const written = JSON.parse(fs.readFileSync(fixture.outcomePath, "utf8"))
  assert.equal(written.status, "reviewed")
  assert.equal(written.batchId, "b0001")
  assert.equal(written.promptSha256, sha256(PROMPT))
})

test("runReview validates the trusted manifest batch and prompt hash before executing the container", async () => {
  const expected = { repo: REPO, pr: 7, baseSha: BASE, headSha: HEAD }
  const cases = []

  {
    const fixture = modelFixture({
      input: inputFixture(),
      prompt: `${PROMPT}\nchanged after hashing`,
      manifest: manifestFixture(),
    })
    cases.push({ fixture, code: "prompt-hash-mismatch" })
  }
  {
    const input = inputFixture({ batchId: "b0002" })
    const fixture = modelFixture({ input, manifest: manifestFixture({ input: inputFixture() }) })
    cases.push({ fixture, code: "batch-not-found" })
  }
  {
    const manifest = manifestFixture()
    manifest.identity.headSha = "f".repeat(40)
    cases.push({ fixture: modelFixture({ manifest }), code: "identity-mismatch" })
  }
  {
    const manifest = manifestFixture({ input: inputFixture() })
    const input = inputFixture({ trustedSource: { sha: BASE, bootstrap: true } })
    cases.push({ fixture: modelFixture({ input, manifest }), code: "trusted-source-mismatch" })
  }

  for (const { fixture, code } of cases) {
    let executed = false
    const result = await runReview({
      ...fixture,
      cliPath: "/fake/opencode",
      expected,
      execute: async () => {
        executed = true
        return spawnResult({ stdout: VALID_JSONL })
      },
    })
    assert.equal(executed, false, code)
    assert.equal(result.exitCode, 1, code)
    assert.equal(result.code, code, code)
    const written = JSON.parse(fs.readFileSync(fixture.outcomePath, "utf8"))
    assert.equal(written.status, "error", code)
    assert.equal(written.diagnostic.code, code, code)
  }

  const noManifest = await runReview({
    inputPath: "/missing/input.json",
    promptPath: "/missing/prompt.txt",
    outcomePath: path.join(tempDir("habi-review-no-manifest-"), "outcome.json"),
    cliPath: "/fake/opencode",
    batchId: "b0001",
    expected,
    execute: async () => {
      throw new Error("must not execute")
    },
  })
  assert.equal(noManifest.exitCode, 1)
  assert.equal(noManifest.code, "missing-manifest")
})

test("structured provider 429 and 503 events are informational while parser defects fail", async () => {
  for (const [event, code] of [
    [{ data: { statusCode: 429, message: "too many requests" } }, "provider-rate-limited"],
    [{ data: { status: 503, message: "service unavailable" } }, "provider-unavailable"],
  ]) {
    const limited = modelFixture()
    const limitedResult = await runReview({
      ...limited,
      cliPath: "/fake/opencode",
      expected: { repo: REPO, pr: 7, baseSha: BASE, headSha: HEAD },
      execute: async () => spawnResult({ status: 1, stdout: jsonl([{ type: "error", error: event }]) }),
    })
    assert.equal(limitedResult.exitCode, 0, code)
    assert.equal(limitedResult.status, "unavailable", code)
    assert.equal(limitedResult.code, code, code)
    const limitedOutcome = JSON.parse(fs.readFileSync(limited.outcomePath, "utf8"))
    assert.equal(limitedOutcome.status, "unavailable", code)
  }

  const broken = modelFixture()
  const brokenResult = await runReview({
    ...broken,
    cliPath: "/fake/opencode",
    expected: { repo: REPO, pr: 7, baseSha: BASE, headSha: HEAD },
    execute: async () => spawnResult({ status: 0, stdout: "not-json\n" }),
  })
  assert.equal(brokenResult.exitCode, 1)
  assert.equal(brokenResult.status, "error")
  const brokenOutcome = JSON.parse(fs.readFileSync(broken.outcomePath, "utf8"))
  assert.equal(brokenOutcome.status, "error")
  assert.equal(brokenOutcome.diagnostic.code, "malformed-jsonl")
  const serialized = JSON.stringify(brokenOutcome)
  assert.equal(serialized.includes("not-json"), false)
  assert.equal(Object.hasOwn(brokenOutcome, "stdout"), false)
  assert.equal(Object.hasOwn(brokenOutcome, "stderr"), false)
})

test("accepted tool-use output is fatal, not review evidence", async () => {
  const fixture = modelFixture()
  const result = await runReview({
    ...fixture,
    cliPath: "/fake/opencode",
    expected: { repo: REPO, pr: 7, baseSha: BASE, headSha: HEAD },
    execute: async () =>
      spawnResult({
        stdout: jsonl([
          { type: "tool_use", part: { tool: "bash", state: { status: "completed" } } },
          { type: "step_finish", part: { reason: "stop" } },
        ]),
      }),
  })
  assert.equal(result.exitCode, 1)
  assert.equal(result.status, "error")
  assert.equal(result.code, "tool-use")
})

test("contained runtime timeouts are informational while overflow and malformed results fail", async () => {
  const timedOut = modelFixture()
  const timeoutResult = await runReview({
    ...timedOut,
    cliPath: "/fake/opencode",
    expected: { repo: REPO, pr: 7, baseSha: BASE, headSha: HEAD },
    execute: async () => spawnResult({ status: null, error: { code: "ETIMEDOUT" } }),
  })
  assert.equal(timeoutResult.exitCode, 0)
  assert.equal(timeoutResult.code, "cli-timeout")

  const overflow = modelFixture()
  const overflowResult = await runReview({
    ...overflow,
    cliPath: "/fake/opencode",
    expected: { repo: REPO, pr: 7, baseSha: BASE, headSha: HEAD },
    execute: async () => spawnResult({ status: null, error: { code: "ENOBUFS" } }),
  })
  assert.equal(overflowResult.exitCode, 1)
  assert.equal(overflowResult.code, "raw-limit")

  const malformed = modelFixture()
  const malformedResult = await runReview({
    ...malformed,
    cliPath: "/fake/opencode",
    expected: { repo: REPO, pr: 7, baseSha: BASE, headSha: HEAD },
    execute: async () => spawnResult({ status: "0" }),
  })
  assert.equal(malformedResult.exitCode, 1)
  assert.equal(malformedResult.code, "cli-signal")
})

test("unstructured stderr is never trusted as a provider signal", async () => {
  for (const stderr of [
    "docker: Error response from daemon: disk quota exceeded",
    "HTTP 429 Too Many Requests",
    "unexpected parser failure",
  ]) {
    const fixture = modelFixture()
    const result = await runReview({
      ...fixture,
      cliPath: "/fake/opencode",
      expected: { repo: REPO, pr: 7, baseSha: BASE, headSha: HEAD },
      execute: async () => spawnResult({ status: 1, stdout: "", stderr }),
    })
    assert.equal(result.exitCode, 1, stderr)
    assert.equal(result.status, "error", stderr)
    assert.equal(result.code, "cli-exit", stderr)
    const outcome = JSON.parse(fs.readFileSync(fixture.outcomePath, "utf8"))
    assert.equal(outcome.status, "error", stderr)
    assert.equal(outcome.diagnostic.code, "cli-exit", stderr)
    assert.equal(outcome.diagnostic.code === "provider-rate-limited", false, stderr)
  }
})

test("every ContainerFailure is fatal and never classified unavailable", async () => {
  for (const code of ["isolation-failed", "iptables-command-failed", "container-invalid", "provider-rate-limited"]) {
    const fixture = modelFixture()
    const result = await runReview({
      ...fixture,
      cliPath: "/fake/opencode",
      expected: { repo: REPO, pr: 7, baseSha: BASE, headSha: HEAD },
      execute: async () => {
        throw new ContainerFailure(code)
      },
    })
    assert.equal(result.exitCode, 1, code)
    assert.equal(result.status, "error", code)
    assert.equal(result.code, code, code)
    const outcome = JSON.parse(fs.readFileSync(fixture.outcomePath, "utf8"))
    assert.equal(outcome.status, "error", code)
    assert.equal(outcome.diagnostic.code, code, code)
  }

  const broken = modelFixture()
  const brokenResult = await runReview({
    ...broken,
    cliPath: "/fake/opencode",
    expected: { repo: REPO, pr: 7, baseSha: BASE, headSha: HEAD },
    execute: async () => {
      throw new Error("unexpected runtime failure")
    },
  })
  assert.equal(brokenResult.exitCode, 1)
  assert.equal(brokenResult.status, "error")
  assert.equal(brokenResult.code, "container-failure")
})

test("aggregateReview completes only when every trusted batch and segment is reviewed", () => {
  const manifest = twoBatchManifest()
  validateReviewManifest(manifest)
  const aggregate = aggregateReview(manifest, [
    batchOutcome("b0001", manifest),
    batchOutcome("b0002", manifest),
  ])
  assert.equal(aggregate.status, "complete")
  assert.equal(aggregate.coverage.complete, true)
  assert.equal(aggregate.coverage.batchesReviewed, 2)
  assert.equal(aggregate.coverage.filesReviewed, 2)
  assert.equal(aggregate.coverage.segmentsReviewed, 2)
  assert.equal(aggregate.coverage.segmentsTotal, 2)
  assert.equal(aggregate.findings.length, 2)
  assert.deepEqual(aggregate.findings.map((finding) => finding.batchId), ["b0001", "b0002"])
  assert.deepEqual(aggregate.files.map((file) => [file.id, file.reviewed]), [
    ["f0001", true],
    ["f0002", true],
  ])
})

test("aggregate accepts the actual planner manifest shape and reports patch gaps honestly", () => {
  const identity = { repo: REPO, pr: 7, baseSha: BASE, headSha: HEAD }
  const trustedSource = { sha: BASE, bootstrap: false }
  const codeFile = {
    filename: "apps/web/page.tsx",
    status: "modified",
    additions: 1,
    deletions: 1,
    changes: 2,
    sha: "c".repeat(40),
    patch: "@@ -1 +1 @@\n-old\n+new\n",
  }
  const built = buildReviewBatches({
    identity,
    trustedSource,
    prompts: REAL_PROMPTS,
    files: [codeFile],
    expectedFileCount: 1,
  })
  validateReviewManifest(built.manifest)
  const outcomes = built.manifest.batches.map((batch) =>
    outcomeFixture({
      batchId: batch.id,
      promptSha256: batch.promptSha256,
      review: { markdown: `Reviewed ${batch.id}`, bytes: 12, truncated: false },
    }),
  )
  assert.equal(aggregateReview(built.manifest, outcomes).status, "complete")

  const withBinary = buildReviewBatches({
    identity,
    trustedSource,
    prompts: REAL_PROMPTS,
    files: [
      codeFile,
      {
        filename: "assets/logo.png",
        status: "added",
        additions: 0,
        deletions: 0,
        changes: 0,
        sha: null,
        patch: null,
      },
    ],
    expectedFileCount: 2,
  })
  validateReviewManifest(withBinary.manifest)
  const binaryOutcomes = withBinary.manifest.batches.map((batch) =>
    outcomeFixture({
      batchId: batch.id,
      promptSha256: batch.promptSha256,
      review: { markdown: `Reviewed ${batch.id}`, bytes: 12, truncated: false },
    }),
  )
  const gapAggregate = aggregateReview(withBinary.manifest, binaryOutcomes)
  assert.equal(gapAggregate.status, "incomplete")
  assert.equal(gapAggregate.coverage.unreviewableFiles, 1)
})

test("missing, duplicate, swapped, stale, unavailable, error, and malformed outcomes never complete", () => {
  const manifest = twoBatchManifest()
  const good1 = batchOutcome("b0001", manifest)
  const good2 = batchOutcome("b0002", manifest)
  const variants = [
    { name: "missing", outcomes: [good1], code: "missing-batch" },
    { name: "duplicate", outcomes: [good1, good1, good2], code: "duplicate-batch" },
    {
      name: "swapped hash",
      outcomes: [good1, batchOutcome("b0002", manifest, { promptSha256: manifest.batches[0].promptSha256 })],
      code: "prompt-hash-mismatch",
    },
    {
      name: "stale identity",
      outcomes: [good1, batchOutcome("b0002", manifest, { headSha: "f".repeat(40) })],
      code: "identity-mismatch",
    },
    {
      name: "stale trusted source",
      outcomes: [good1, batchOutcome("b0002", manifest, { trustedSource: { sha: BASE, bootstrap: true } })],
      code: "trusted-source-mismatch",
    },
    {
      name: "unavailable",
      outcomes: [
        good1,
        batchOutcome("b0002", manifest, {
          status: "unavailable",
          review: null,
          diagnostic: { code: "provider-rate-limited" },
        }),
      ],
      code: "unavailable-batch",
    },
    {
      name: "error",
      outcomes: [
        good1,
        batchOutcome("b0002", manifest, { status: "error", review: null, diagnostic: { code: "cli-exit" } }),
      ],
      code: "error-batch",
    },
    {
      name: "malformed",
      outcomes: [good1, { malformed: true, batchId: "b0002", source: "b0002.json", code: "invalid-outcome-json" }],
      code: "invalid-outcome-json",
    },
    {
      name: "wrong model",
      outcomes: [good1, batchOutcome("b0002", manifest, { model: "other/model" })],
      code: "model-mismatch",
    },
  ]

  for (const variant of variants) {
    const aggregate = aggregateReview(manifest, variant.outcomes)
    assert.equal(aggregate.status, "incomplete", variant.name)
    assert.equal(aggregate.coverage.complete, false, variant.name)
    assert.ok(
      aggregate.issues.some((issue) => issue.code === variant.code),
      `${variant.name}: ${JSON.stringify(aggregate.issues)}`,
    )
  }
})

test("aggregateReview excludes unexpected artifacts and reports enumeration and patch gaps", () => {
  const manifest = twoBatchManifest()
  const good1 = batchOutcome("b0001", manifest)
  const good2 = batchOutcome("b0002", manifest)
  const unexpectedOutcome = {
    ...good2,
    batchId: "b9999",
    review: { markdown: "UNEXPECTED FINDING", bytes: 18, truncated: false },
  }
  const withUnexpected = aggregateReview(manifest, [good1, good2, unexpectedOutcome])
  assert.equal(withUnexpected.status, "incomplete")
  assert.equal(withUnexpected.unexpected.length, 1)
  assert.equal(
    withUnexpected.findings.some((finding) => finding.markdown.includes("UNEXPECTED FINDING")),
    false,
  )
  assert.equal(withUnexpected.findings.length, 2)

  const truncatedList = twoBatchManifest({ fileList: { expectedCount: 3, receivedCount: 2, complete: false } })
  const truncatedAggregate = aggregateReview(truncatedList, [good1, good2])
  assert.equal(truncatedAggregate.status, "incomplete")
  assert.equal(truncatedAggregate.coverage.filesReviewed, 2)

  const gapManifest = twoBatchManifest({
    fileList: { expectedCount: 3, receivedCount: 3, complete: true },
    unreviewableFiles: [{ fileId: "f0003", filename: "assets/logo.png", reason: "patch-unavailable" }],
  })
  const gapAggregate = aggregateReview(gapManifest, [good1, good2])
  assert.equal(gapAggregate.status, "incomplete")
  assert.equal(gapAggregate.coverage.unreviewableFiles, 1)
  assert.equal(gapAggregate.coverage.filesTotal, 3)
  assert.equal(gapAggregate.coverage.filesReviewed, 2)

  const emptyManifest = {
    ...twoBatchManifest(),
    fileList: { expectedCount: 0, receivedCount: 0, complete: true },
    files: [],
    unreviewableFiles: [],
    batches: [],
  }
  assert.equal(aggregateReview(emptyManifest, []).status, "complete")

  const binaryOnly = {
    ...twoBatchManifest(),
    fileList: { expectedCount: 1, receivedCount: 1, complete: true },
    files: [],
    unreviewableFiles: [{ fileId: "f0001", filename: "assets/logo.png", reason: "patch-unavailable" }],
    batches: [],
  }
  assert.equal(aggregateReview(binaryOnly, []).status, "incomplete")

  const tooMany = {
    ...twoBatchManifest(),
    batches: Array.from({ length: MAX_BATCHES + 1 }, (_value, index) => ({
      ...twoBatchManifest().batches[0],
      id: `b${String(index + 1).padStart(4, "0")}`,
    })),
  }
  assert.throws(() => validateReviewManifest(tooMany), (error) => error.code === "too-many-batches")
})

test("aggregate comment is inert, discloses incomplete coverage, and links full artifacts", () => {
  const manifest = twoBatchManifest()
  const runUrl = `https://github.com/${REPO}/actions/runs/12345`
  const complete = aggregateReview(manifest, [
    batchOutcome("b0001", manifest),
    batchOutcome("b0002", manifest),
  ])
  const body = renderAggregateComment(complete, { runUrl })
  assert.ok(body.startsWith(REVIEW_MARKER))
  assert.match(body, /Complete coverage: yes/)
  assert.ok(body.includes(runUrl))
  assert.ok(body.includes("```text"))
  assert.ok(body.includes("review-outcome-*"))

  const hostile = aggregateReview(manifest, [
    batchOutcome("b0001", manifest, {
      review: { markdown: "@octocat\n````\n<script>alert(1)</script>", bytes: 40, truncated: false },
    }),
    batchOutcome("b0002", manifest),
  ])
  const hostileBody = renderAggregateComment(hostile, { runUrl })
  assert.ok(hostileBody.includes("@\u200boctocat"))
  assert.ok(hostileBody.includes("`````text"))

  const incomplete = aggregateReview(manifest, [batchOutcome("b0001", manifest)])
  const incompleteBody = renderAggregateComment(incomplete, { runUrl })
  assert.match(incompleteBody, /Complete coverage: no/)
  assert.match(incompleteBody, /missing-batch/)
  assert.ok(incompleteBody.includes(runUrl))

  const zeroManifest = {
    ...twoBatchManifest(),
    fileList: { expectedCount: 0, receivedCount: 0, complete: true },
    files: [],
    unreviewableFiles: [],
    batches: [],
  }
  const zeroBody = renderAggregateComment(aggregateReview(zeroManifest, []), { runUrl })
  assert.match(zeroBody, /No reviewable text was available/)
  assert.match(zeroBody, /does not establish that changed files are clean/)

  const huge = aggregateReview(manifest, [
    batchOutcome("b0001", manifest, {
      review: { markdown: "y".repeat(40_000), bytes: 40_000, truncated: false },
    }),
    batchOutcome("b0002", manifest, {
      review: { markdown: "z".repeat(40_000), bytes: 40_000, truncated: false },
    }),
  ])
  const hugeBody = renderAggregateComment(huge, { runUrl })
  assert.ok(Buffer.byteLength(hugeBody) <= AGGREGATE_COMMENT_LIMIT_BYTES)
  assert.ok(hugeBody.includes(AGGREGATE_TRUNCATION_NOTICE))
  assert.ok(hugeBody.includes(runUrl))

  assert.throws(
    () => renderAggregateComment(complete, { runUrl: "https://evil.test/actions/runs/1" }),
    (error) => error.code === "invalid-run-url",
  )
})

test("publishAggregate posts partial reports, preserves ownership/stale guards, and saves bounded aggregate JSON", async () => {
  const manifest = twoBatchManifest()
  const outcomesDir = tempDir("habi-review-outcomes-")
  writeFile(path.join(outcomesDir, "b0001.json"), JSON.stringify(batchOutcome("b0001", manifest)))
  const artifactMetadata = artifactMetadataFixture([artifactFixture("review-outcome-b0001", 1)])
  const runUrl = `https://github.com/${REPO}/actions/runs/${RUN_ID}`
  const token = "token"

  const calls = []
  const fetchImpl = async (url, options = {}) => {
    const method = options.method ?? "GET"
    calls.push({ url, method, body: options.body })
    if (method === "GET" && url.includes("/pulls/")) return response(prData())
    if (method === "GET" && url.includes("/comments")) return response([])
    if (method === "POST") return response({ id: 20 }, 201)
    throw new Error("unexpected mutation")
  }
  const aggregatePath = path.join(tempDir("habi-review-aggregate-"), "aggregate.json")
  const posted = await publishAggregate({
    token,
    repo: REPO,
    pr: 7,
    baseSha: BASE,
    headSha: HEAD,
    manifest,
    outcomesDir,
    artifactMetadata,
    runId: RUN_ID,
    runUrl,
    aggregatePath,
    fetchImpl,
  })
  assert.equal(posted.status, "posted")
  assert.equal(posted.aggregate.status, "incomplete")
  const post = calls.find((call) => call.method === "POST")
  assert.match(post.body, /Complete coverage: no/)
  assert.match(post.body, /missing-batch/)
  assert.ok(post.body.includes(runUrl))
  const saved = JSON.parse(fs.readFileSync(aggregatePath, "utf8"))
  assert.equal(saved.status, "incomplete")
  assert.equal(saved.coverage.batchesMissing, 1)
  assert.equal(saved.findings.length, 1)
  assert.equal(saved.runUrl, runUrl)

  const updateCalls = []
  const updateFetchImpl = async (url, options = {}) => {
    const method = options.method ?? "GET"
    updateCalls.push({ url, method })
    if (method === "GET" && url.includes("/pulls/")) return response(prData())
    if (method === "GET" && url.includes("/comments")) {
      return response([{ id: 9, body: `${REVIEW_MARKER}\nold`, user: ACTIONS_BOT }])
    }
    if (method === "PATCH") return response({ id: 9 })
    throw new Error("unexpected mutation")
  }
  const updated = await publishAggregate({
    token,
    repo: REPO,
    pr: 7,
    baseSha: BASE,
    headSha: HEAD,
    manifest,
    outcomesDir,
    artifactMetadata,
    runId: RUN_ID,
    runUrl,
    fetchImpl: updateFetchImpl,
  })
  assert.equal(updated.status, "updated")
  assert.equal(updateCalls.filter((call) => call.method !== "GET").length, 1)
  assert.match(updateCalls.find((call) => call.method === "PATCH").url, /\/issues\/comments\/9$/)

  const staleCalls = []
  const staleFetchImpl = async (url, options = {}) => {
    const method = options.method ?? "GET"
    staleCalls.push(method)
    if (method === "GET" && url.includes("/pulls/")) return response(prData({ head: "f".repeat(40) }))
    throw new Error("unexpected fetch")
  }
  const stale = await publishAggregate({
    token,
    repo: REPO,
    pr: 7,
    baseSha: BASE,
    headSha: HEAD,
    manifest,
    outcomesDir,
    artifactMetadata,
    runId: RUN_ID,
    runUrl,
    fetchImpl: staleFetchImpl,
  })
  assert.equal(stale.status, "stale")
  assert.equal(staleCalls.some((method) => method !== "GET"), false)

  const malformedDir = tempDir("habi-review-outcomes-malformed-")
  writeFile(path.join(malformedDir, "b0002.json"), "{not-json")
  const malformed = await publishAggregate({
    token,
    repo: REPO,
    pr: 7,
    baseSha: BASE,
    headSha: HEAD,
    manifest,
    outcomesDir: malformedDir,
    artifactMetadata: artifactMetadataFixture([artifactFixture("review-outcome-b0002", 2)]),
    runId: RUN_ID,
    runUrl,
    fetchImpl,
  })
  assert.equal(malformed.aggregate.status, "incomplete")
  assert.ok(malformed.aggregate.issues.some((issue) => issue.code === "invalid-outcome-json"))
})

test("aggregate rendering discloses per-batch output truncation even when the comment fits", () => {
  const manifest = manifestFixture()
  const markdown = "x".repeat(24_000)
  const aggregate = aggregateReview(manifest, [
    batchOutcome("b0001", manifest, {
      review: { markdown, bytes: Buffer.byteLength(markdown), truncated: true },
    }),
  ])
  assert.equal(aggregate.status, "complete")
  const runUrl = `https://github.com/${REPO}/actions/runs/${RUN_ID}`
  const body = renderAggregateComment(aggregate, { runUrl })
  assert.ok(Buffer.byteLength(body) <= AGGREGATE_COMMENT_LIMIT_BYTES)
  assert.match(body, /Complete coverage: yes/)
  assert.ok(body.includes(BATCH_TRUNCATION_NOTICE))
  assert.match(body, /Affected batches: b0001/)
  assert.ok(body.indexOf(BATCH_TRUNCATION_NOTICE) < body.indexOf("```text"))
  assert.equal(body.includes(AGGREGATE_TRUNCATION_NOTICE), false)
  assert.ok(body.includes(runUrl))
})

test("aggregate rendering handles 32 large tick-heavy batches without argument spreading", () => {
  const manifest = manyBatchManifest(32)
  const outcomes = manifest.batches.map((batch) =>
    batchOutcome(batch.id, manifest, {
      review: { markdown: "`x".repeat(12_000), bytes: 24_000, truncated: false },
    }),
  )
  const aggregate = aggregateReview(manifest, outcomes)
  assert.equal(aggregate.status, "complete")
  const runUrl = `https://github.com/${REPO}/actions/runs/${RUN_ID}`
  const body = renderAggregateComment(aggregate, { runUrl })
  assert.ok(Buffer.byteLength(body) <= AGGREGATE_COMMENT_LIMIT_BYTES)
  assert.ok(body.includes(AGGREGATE_TRUNCATION_NOTICE))
  assert.ok(body.includes(runUrl))
  assert.ok(body.includes("review-outcome-*"))
  assert.equal(body.includes("\ufffd"), false)

  const fenced = renderInertFence("`x".repeat(400_000))
  assert.ok(fenced.startsWith("```text\n"))
})

test("outcome ingestion trusts actual single-artifact metadata for the flat download layout", () => {
  const manifest = twoBatchManifest()
  const outcomesDir = tempDir("habi-review-flat-")
  writeFile(path.join(outcomesDir, "b0001.json"), JSON.stringify(batchOutcome("b0001", manifest)))
  const metadata = artifactMetadataFixture([artifactFixture("review-outcome-b0001", 1)])
  const entries = readOutcomeEntries(outcomesDir, metadata, { runId: RUN_ID, repo: REPO })
  assert.equal(entries.length, 1)
  assert.equal(entries[0].batchId, "b0001")
  assert.equal(aggregateReview(manifest, entries).findings[0].batchId, "b0001")

  assert.throws(
    () => readOutcomeEntries(outcomesDir, { ...metadata, runId: "999" }, { runId: RUN_ID, repo: REPO }),
    (error) => error.code === "artifacts-run-mismatch",
  )
  assert.throws(
    () =>
      readOutcomeEntries(
        outcomesDir,
        { ...metadata, repository: "other/repo" },
        { runId: RUN_ID, repo: REPO },
      ),
    (error) => error.code === "artifacts-repo-mismatch",
  )

  const wrongNameDir = tempDir("habi-review-flat-wrong-")
  writeFile(path.join(wrongNameDir, "b0002.json"), JSON.stringify(batchOutcome("b0002", manifest)))
  const wrongEntries = readOutcomeEntries(wrongNameDir, metadata, { runId: RUN_ID, repo: REPO })
  assert.equal(wrongEntries.length, 1)
  assert.equal(wrongEntries[0].malformed, true)
  assert.equal(wrongEntries[0].code, "artifact-filename-mismatch")
  const wrongAggregate = aggregateReview(manifest, wrongEntries)
  assert.equal(wrongAggregate.status, "incomplete")
  assert.equal(wrongAggregate.findings.length, 0)
})

test("outcome ingestion rejects extra files even when they carry an expected batch id", () => {
  const manifest = twoBatchManifest()
  const outcomesDir = tempDir("habi-review-extra-")
  writeFile(path.join(outcomesDir, "b0001.json"), JSON.stringify(batchOutcome("b0001", manifest)))
  writeFile(
    path.join(outcomesDir, "extra.json"),
    JSON.stringify(
      batchOutcome("b0001", manifest, {
        review: { markdown: "EXTRA FINDING", bytes: 13, truncated: false },
      }),
    ),
  )
  const metadata = artifactMetadataFixture([artifactFixture("review-outcome-b0001", 1)])
  const entries = readOutcomeEntries(outcomesDir, metadata, { runId: RUN_ID, repo: REPO })
  assert.ok(entries.some((entry) => entry.malformed === true && entry.code === "unexpected-artifact"))
  const aggregate = aggregateReview(manifest, entries)
  assert.equal(aggregate.status, "incomplete")
  assert.equal(
    aggregate.findings.some((finding) => finding.markdown.includes("EXTRA FINDING")),
    false,
  )
})

test("outcome ingestion never reads an unexpected artifact that carries an expected id", () => {
  const manifest = twoBatchManifest()
  const outcomesDir = tempDir("habi-review-unexpected-artifact-")
  writeFile(
    path.join(outcomesDir, "review-outcome-b0001", "b0001.json"),
    JSON.stringify(batchOutcome("b0001", manifest)),
  )
  writeFile(
    path.join(outcomesDir, "review-outcome-b0001-extra", "b0001.json"),
    JSON.stringify(
      batchOutcome("b0001", manifest, {
        review: { markdown: "UNEXPECTED FINDING", bytes: 18, truncated: false },
      }),
    ),
  )
  const metadata = artifactMetadataFixture([
    artifactFixture("review-outcome-b0001", 1),
    artifactFixture("review-outcome-b0001-extra", 2),
  ])
  const entries = readOutcomeEntries(outcomesDir, metadata, { runId: RUN_ID, repo: REPO })
  assert.ok(
    entries.some(
      (entry) =>
        entry.malformed === true &&
        entry.code === "unexpected-artifact" &&
        entry.source === "review-outcome-b0001-extra",
    ),
  )
  const aggregate = aggregateReview(manifest, entries)
  assert.equal(aggregate.status, "incomplete")
  assert.equal(
    aggregate.findings.some((finding) => finding.markdown.includes("UNEXPECTED FINDING")),
    false,
  )
})

test("duplicate outcome filenames across artifact directories stay visible and incomplete", () => {
  const manifest = twoBatchManifest()
  const outcomesDir = tempDir("habi-review-duplicate-files-")
  writeFile(
    path.join(outcomesDir, "review-outcome-b0001", "b0001.json"),
    JSON.stringify(batchOutcome("b0001", manifest)),
  )
  writeFile(
    path.join(outcomesDir, "review-outcome-b0002", "b0001.json"),
    JSON.stringify(batchOutcome("b0001", manifest)),
  )
  const metadata = artifactMetadataFixture([
    artifactFixture("review-outcome-b0001", 1),
    artifactFixture("review-outcome-b0002", 2),
  ])
  const entries = readOutcomeEntries(outcomesDir, metadata, { runId: RUN_ID, repo: REPO })
  assert.equal(entries.length, 2)
  const aggregate = aggregateReview(manifest, entries)
  assert.equal(aggregate.status, "incomplete")
  assert.equal(aggregate.findings.length, 0)
  assert.ok(aggregate.issues.some((issue) => issue.code === "duplicate-batch" && issue.batchId === "b0001"))
  assert.ok(aggregate.issues.some((issue) => issue.code === "missing-batch" && issue.batchId === "b0002"))
})

test("zero outcome artifacts aggregate as missing batches instead of a clean report", () => {
  const manifest = twoBatchManifest()
  const outcomesDir = path.join(tempDir("habi-review-zero-artifacts-"), "review-outcomes")
  const metadata = artifactMetadataFixture([])
  const entries = readOutcomeEntries(outcomesDir, metadata, { runId: RUN_ID, repo: REPO })
  assert.deepEqual(entries, [])
  const aggregate = aggregateReview(manifest, entries)
  assert.equal(aggregate.status, "incomplete")
  assert.equal(aggregate.coverage.batchesMissing, 2)
  const body = renderAggregateComment(aggregate, {
    runUrl: `https://github.com/${REPO}/actions/runs/${RUN_ID}`,
  })
  assert.match(body, /Complete coverage: no/)
  assert.match(body, /missing-batch/)
})

test("workflow artifact listing is run-scoped, paginated, and fails closed without context", () => {
  const script = workflowStepScript("List review outcome artifacts")
  assert.match(script, /actions\/runs\/\$\{runId\}\/artifacts/)
  assert.match(script, /per_page=100/)
  assert.match(script, /maxArtifacts = 288/)
  assert.match(script, /complete: true/)
  assert.match(script, /Artifact listing did not complete/)
  assert.match(script, /process\.exit\(1\)/)

  const root = tempDir("habi-review-artifact-listing-")
  const scriptPath = path.join(root, "listing.cjs")
  writeFile(scriptPath, script)
  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_TOKEN: "",
      REVIEW_REPO: "",
      REVIEW_RUN_ID: "",
      ARTIFACT_METADATA_PATH: "",
    },
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Artifact listing context is incomplete/)
})

test("batched workflow uses a trusted generated matrix with bounded parallelism and always publishes", () => {
  assert.match(OPENCODE_WORKFLOW, /fail-fast: false/)
  assert.match(OPENCODE_WORKFLOW, /max-parallel: 4/)
  assert.match(OPENCODE_WORKFLOW, /batch: \$\{\{ fromJSON\(needs\.prepare\.outputs\.batches\) \}\}/)
  assert.match(OPENCODE_WORKFLOW, /needs\.prepare\.outputs\.batch_count != '0'/)
  assert.match(OPENCODE_WORKFLOW, /name: review-outcome-\$\{\{ matrix\.batch \}\}/)
  assert.match(OPENCODE_WORKFLOW, /pattern: review-outcome-\*/)
  assert.match(OPENCODE_WORKFLOW, /merge-multiple: false/)
  assert.match(OPENCODE_WORKFLOW, /List review outcome artifacts/)
  assert.match(OPENCODE_WORKFLOW, /--artifacts/)
  assert.match(OPENCODE_WORKFLOW, /actions: read/)
  assert.match(OPENCODE_WORKFLOW, /--manifest/)
  assert.match(OPENCODE_WORKFLOW, /--batch/)
  assert.match(OPENCODE_WORKFLOW, /--outcomes/)
  assert.match(OPENCODE_WORKFLOW, /--run-url/)
  assert.match(OPENCODE_WORKFLOW, /always\(\) && needs\.prepare\.result == 'success'/)
  assert.doesNotMatch(OPENCODE_WORKFLOW, /continue-on-error/)
  assert.doesNotMatch(OPENCODE_WORKFLOW, /OPENCODE_API_KEY/)
  assert.ok(OPENCODE_WORKFLOW.split("review-batches.mjs").length - 1 >= 2)

  const matrixScript = workflowStepScript("Build batch matrix")
  assert.match(matrixScript, /b\[0-9\]\{4\}/)
  assert.match(matrixScript, /256/)
  assert.doesNotMatch(matrixScript, /filename|pull_request|head\.sha/)

  const ci = fs.readFileSync(path.join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8")
  assert.match(ci, /review-batches\.test\.mjs/)
})

test("batch matrix output contains only generated IDs and fails closed above 256", () => {
  const twoBatches = runBatchMatrix({ batchIds: ["b0001", "b0002"], count: 2 })
  assert.equal(twoBatches.result.status, 0)
  assert.equal(twoBatches.outputs.count, "2")
  assert.deepEqual(JSON.parse(twoBatches.outputs.batches), ["b0001", "b0002"])

  const empty = runBatchMatrix({ batchIds: [], count: 0 })
  assert.equal(empty.result.status, 0)
  assert.equal(empty.outputs.count, "0")
  assert.deepEqual(JSON.parse(empty.outputs.batches), [])

  const manyIds = Array.from({ length: MAX_BATCHES + 1 }, (_value, index) =>
    `b${String(index + 1).padStart(4, "0")}`,
  )
  const over = runBatchMatrix({ batchIds: manyIds, count: manyIds.length })
  assert.equal(over.result.status, 1)
  assert.match(over.result.stderr, /256/)

  const invalid = runBatchMatrix({ batchIds: ["batch1"], count: 1 })
  assert.equal(invalid.result.status, 1)

  const duplicate = runBatchMatrix({ batchIds: ["b0001", "b0001"], count: 2 })
  assert.equal(duplicate.result.status, 1)

  const mismatch = runBatchMatrix({ batchIds: ["b0001"], count: 2 })
  assert.equal(mismatch.result.status, 1)
})

test("model entrypoint preserves SIGINT/SIGTERM cleanup after a valid review result", () => {
  const root = tempDir("habi-review-exit-handoff-")
  const modelUrl = pathToFileURL(path.join(REPO_ROOT, ".github", "scripts", "review-model.mjs")).href
  const scriptPath = path.join(root, "handoff.mjs")
  writeFile(
    scriptPath,
    [
      `import { preserveSignalExitCode } from ${JSON.stringify(modelUrl)}`,
      "const initial = process.env.INITIAL_EXIT",
      "if (initial !== undefined) process.exitCode = Number(initial)",
      "preserveSignalExitCode(Number(process.env.RESULT_EXIT))",
      "",
    ].join("\n"),
  )

  for (const [initial, result, expected] of [
    [130, 0, 130],
    [143, 0, 143],
    [130, 1, 130],
    [143, 1, 143],
    [undefined, 0, 0],
    [undefined, 1, 1],
  ]) {
    const child = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        ...(initial === undefined ? {} : { INITIAL_EXIT: String(initial) }),
        RESULT_EXIT: String(result),
      },
    })
    assert.equal(child.status, expected, `initial=${initial} result=${result}`)
  }
})

test("model entrypoint uses the shared signal-preserving exit handoff", () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, ".github", "scripts", "review-model.mjs"), "utf8")
  assert.match(source, /preserveSignalExitCode\(await main\(\)\)/)
  assert.doesNotMatch(source, /process\.exitCode = await main\(\)/)
})

test("artifact identity must match the event and outcome must be valid", async () => {
  const input = inputFixture({ headSha: "f".repeat(40) })
  await assert.rejects(
    publishOutcome({
      token: "token",
      repo: REPO,
      pr: 7,
      baseSha: BASE,
      headSha: HEAD,
      input,
      outcome: outcomeFixture(),
      fetchImpl: async () => response(prData()),
    }),
    (error) => error.code === "identity-mismatch",
  )

  await assert.rejects(
    publishOutcome({
      token: "token",
      repo: REPO,
      pr: 7,
      baseSha: BASE,
      headSha: HEAD,
      input: inputFixture(),
      outcome: outcomeFixture({ status: "error" }),
      fetchImpl: async () => response(prData()),
    }),
    (error) => error.code === "invalid-outcome",
  )
})

test("stale head never mutates comments", async () => {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? "GET" })
    if (url.includes("/pulls/")) return response(prData({ head: "f".repeat(40) }))
    return response([])
  }
  const result = await publishOutcome({
    token: "token",
    repo: REPO,
    pr: 7,
    baseSha: BASE,
    headSha: HEAD,
    input: inputFixture(),
    outcome: outcomeFixture(),
    fetchImpl,
  })
  assert.equal(result.status, "stale")
  assert.equal(calls.some((call) => call.method === "POST" || call.method === "PATCH"), false)
})

test("publisher updates one marker comment instead of duplicating it", async () => {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? "GET", body: options.body })
    if ((options.method ?? "GET") === "GET" && url.includes("/pulls/")) return response(prData())
    if ((options.method ?? "GET") === "GET" && url.includes("/comments")) {
      return response([{ id: 9, body: `${REVIEW_MARKER}\nold`, user: ACTIONS_BOT }])
    }
    if (options.method === "PATCH") return response({ id: 9 })
    throw new Error("unexpected mutation")
  }
  const result = await publishOutcome({
    token: "token",
    repo: REPO,
    pr: 7,
    baseSha: BASE,
    headSha: HEAD,
    input: inputFixture(),
    outcome: outcomeFixture(),
    fetchImpl,
  })
  assert.equal(result.status, "updated")
  const mutations = calls.filter((call) => call.method !== "GET")
  assert.equal(mutations.length, 1)
  assert.equal(mutations[0].method, "PATCH")
  assert.match(mutations[0].url, /\/issues\/comments\/9$/)
})

test("publisher ignores marker comments from non-owner authors", async () => {
  const mutations = []
  const fetchImpl = async (url, options = {}) => {
    const method = options.method ?? "GET"
    if (method === "GET" && url.includes("/pulls/")) return response(prData())
    if (method === "GET" && url.includes("/comments")) {
      return response([
        { id: 10, body: `${REVIEW_MARKER}\nother bot`, user: OTHER_BOT },
        { id: 11, body: `${REVIEW_MARKER}\nmissing author` },
        { id: 12, body: `${REVIEW_MARKER}\nuser copy`, user: REGULAR_USER },
        { id: 13, body: `${REVIEW_MARKER}\nwrong id`, user: { ...ACTIONS_BOT, id: 123 } },
      ])
    }
    mutations.push(method)
    if (method === "POST") return response({ id: 20 }, 201)
    if (method === "PATCH") return response({ id: 20 })
    throw new Error("unexpected mutation")
  }
  const result = await publishOutcome({
    token: "token",
    repo: REPO,
    pr: 7,
    baseSha: BASE,
    headSha: HEAD,
    input: inputFixture(),
    outcome: outcomeFixture(),
    fetchImpl,
  })
  assert.equal(result.status, "posted")
  assert.deepEqual(mutations, ["POST"])
})

test("comment rendering is inert and escapes mentions and controls", () => {
  const hostile = `@octocat \u202e <img src=x> ![x](https://example.test/x) \`\`\`\n<script>alert(1)</script>`
  const body = renderComment(
    outcomeFixture({
      review: { markdown: hostile, bytes: 1, truncated: false },
    }),
  )
  assert.ok(body.startsWith(REVIEW_MARKER))
  assert.ok(body.includes("@\u200boctocat"))
  assert.equal(body.includes("\u202e"), false)
  assert.ok(body.includes("````text"))
  assert.ok(body.includes("````\n"))
  assert.ok(body.length <= 60_000)
  assert.equal(renderInertFence("```").startsWith("````"), true)
  assert.equal(escapeMentions("@team"), "@\u200bteam")
  assert.equal(sanitizeReview("a\u0000b\u202ec"), "abc")

  const backticks = renderComment(
    outcomeFixture({ review: { markdown: "`".repeat(24_000), bytes: 24_000, truncated: false } }),
  )
  assert.ok(Buffer.byteLength(backticks) <= 60_000)
  assert.ok(backticks.includes("</details>"))
})

test("parser and renderer truncation add a notice outside the fence", () => {
  const parserTruncated = renderComment(
    outcomeFixture({
      coverage: coverage({ complete: true }),
      review: { markdown: "x".repeat(30_000), bytes: 30_000, truncated: true },
    }),
  )
  assert.ok(parserTruncated.includes(OUTPUT_TRUNCATION_NOTICE))
  assert.ok(parserTruncated.indexOf(OUTPUT_TRUNCATION_NOTICE) < parserTruncated.indexOf("```text"))
  assert.match(parserTruncated, /Complete diff included: yes/)
  assert.ok(parserTruncated.includes("</details>"))

  const delimiterExpanded = renderComment(
    outcomeFixture({ review: { markdown: "`".repeat(24_000), bytes: 24_000, truncated: false } }),
  )
  assert.ok(delimiterExpanded.includes(OUTPUT_TRUNCATION_NOTICE))
  assert.ok(delimiterExpanded.indexOf(OUTPUT_TRUNCATION_NOTICE) < delimiterExpanded.indexOf("```text"))
  assert.ok(Buffer.byteLength(delimiterExpanded) <= 60_000)
  assert.ok(delimiterExpanded.includes("</details>"))
  const openingFence = delimiterExpanded.match(/(`{3,})text\n/)
  assert.ok(openingFence)
  assert.ok(delimiterExpanded.includes(`\n${openingFence[1]}\n\n<details>`))

  const multibyte = renderComment(
    outcomeFixture({ review: { markdown: "é".repeat(35_000), bytes: 70_000, truncated: true } }),
  )
  assert.ok(multibyte.includes(OUTPUT_TRUNCATION_NOTICE))
  assert.ok(Buffer.byteLength(multibyte) <= 60_000)
  assert.equal(multibyte.includes("\ufffd"), false)
})

test("comment records the approved bootstrap source without altering event identity", () => {
  const bootstrapBody = renderComment(
    outcomeFixture({ trustedSource: { sha: PINNED_SOURCE, bootstrap: true } }),
  )
  assert.match(bootstrapBody, /Trusted review source: approved bootstrap commit/)
  assert.match(bootstrapBody, new RegExp(PINNED_SOURCE))

  const baseBody = renderComment(
    outcomeFixture({ trustedSource: { sha: BASE, bootstrap: false } }),
  )
  assert.match(baseBody, /Trusted review source: event base commit/)
})

test("publisher posts an informational unavailable outcome", async () => {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? "GET", body: options.body })
    if ((options.method ?? "GET") === "GET" && url.includes("/pulls/")) return response(prData())
    if ((options.method ?? "GET") === "GET" && url.includes("/comments")) return response([])
    if (options.method === "POST") return response({ id: 10 }, 201)
    throw new Error("unexpected mutation")
  }
  const outcome = outcomeFixture({
    status: "unavailable",
    review: null,
    diagnostic: { code: "provider-rate-limited" },
  })
  const result = await publishOutcome({
    token: "token",
    repo: REPO,
    pr: 7,
    baseSha: BASE,
    headSha: HEAD,
    input: inputFixture(),
    outcome,
    fetchImpl,
  })
  assert.equal(result.status, "posted")
  const post = calls.find((call) => call.method === "POST")
  assert.ok(post)
  assert.match(post.body, /provider-rate-limited/)
  assert.match(post.body, /informational/i)
  assert.equal(post.body.includes("```text"), false)
})

test("end-to-end batched model and aggregate publish are stubbed and never contact providers", async () => {
  const manifest = manifestFixture()
  const fixture = modelFixture({ manifest })
  const modelResult = await runReview({
    ...fixture,
    cliPath: "/fake/opencode",
    expected: { repo: REPO, pr: 7, baseSha: BASE, headSha: HEAD },
    execute: async () => spawnResult({ stdout: VALID_JSONL }),
  })
  assert.equal(modelResult.status, "reviewed")
  const outcome = JSON.parse(fs.readFileSync(fixture.outcomePath, "utf8"))
  assert.equal(outcome.batchId, "b0001")
  assert.equal(outcome.promptSha256, sha256(PROMPT))

  const outcomesDir = tempDir("habi-review-e2e-outcomes-")
  writeFile(path.join(outcomesDir, `${outcome.batchId}.json`), JSON.stringify(outcome))

  const calls = []
  const publishFetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? "GET", body: options.body })
    if ((options.method ?? "GET") === "GET" && url.includes("/pulls/")) return response(prData())
    if ((options.method ?? "GET") === "GET" && url.includes("/comments")) return response([])
    if (options.method === "POST") return response({ id: 11 }, 201)
    throw new Error("unexpected mutation")
  }
  const runUrl = `https://github.com/${REPO}/actions/runs/12345`
  const published = await publishAggregate({
    token: "token",
    repo: REPO,
    pr: 7,
    baseSha: BASE,
    headSha: HEAD,
    manifest,
    outcomesDir,
    artifactMetadata: artifactMetadataFixture([artifactFixture("review-outcome-b0001", 1)]),
    runId: RUN_ID,
    runUrl,
    fetchImpl: publishFetchImpl,
  })
  assert.equal(published.status, "posted")
  assert.equal(published.aggregate.status, "complete")
  const mutation = calls.find((call) => call.method !== "GET")
  assert.equal(mutation.method, "POST")
  assert.match(mutation.body, new RegExp(REVIEW_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  assert.match(mutation.body, /Complete coverage: yes/)
  assert.match(mutation.body, /final review/)
  assert.ok(mutation.body.includes(runUrl))
  assert.equal(calls.some((call) => call.method === "DELETE"), false)
})

test("bot comment lookup requires the exact Actions bot identity", () => {
  const found = findBotComment([
    { id: 5, body: `${REVIEW_MARKER}\nother bot`, user: OTHER_BOT },
    { id: 2, body: `${REVIEW_MARKER}\nolder`, user: ACTIONS_BOT },
    { id: 3, body: `${REVIEW_MARKER}\nuser copy`, user: REGULAR_USER },
    { id: 4, body: `${REVIEW_MARKER}\nmissing author` },
    { id: 6, body: `${REVIEW_MARKER}\nwrong id`, user: { ...ACTIONS_BOT, id: 123 } },
    { id: 1, body: "unrelated" },
  ])
  assert.equal(found.id, 2)
  assert.equal(
    findBotComment([
      { id: 5, body: `${REVIEW_MARKER}\nother bot`, user: OTHER_BOT },
      { id: 3, body: `${REVIEW_MARKER}\nuser copy`, user: REGULAR_USER },
      { id: 4, body: `${REVIEW_MARKER}\nmissing author` },
    ]),
    null,
  )
  assert.equal(findBotComment([]), null)
})

test("comment pagination exhaustion skips instead of creating a duplicate", async () => {
  const commentPages = []
  const mutations = []
  const logs = []
  const fetchImpl = async (url, options = {}) => {
    const method = options.method ?? "GET"
    if (method === "GET" && url.includes("/pulls/")) return response(prData())
    if (method === "GET" && url.includes("/comments")) {
      const page = Number(new URL(url).searchParams.get("page"))
      commentPages.push(page)
      if (page <= 5) {
        return response(
          Array.from({ length: 100 }, (_value, index) => ({
            id: page * 1_000 + index,
            body: `${REVIEW_MARKER}\nuser copy`,
            user: REGULAR_USER,
          })),
        )
      }
      return response([{ id: 9_000, body: `${REVIEW_MARKER}\nowned`, user: ACTIONS_BOT }])
    }
    mutations.push(method)
    return response({ id: 1 }, method === "POST" ? 201 : 200)
  }
  const result = await publishOutcome({
    token: "token",
    repo: REPO,
    pr: 7,
    baseSha: BASE,
    headSha: HEAD,
    input: inputFixture(),
    outcome: outcomeFixture(),
    fetchImpl,
    log: (message) => logs.push(message),
  })
  assert.equal(result.status, "incomplete")
  assert.equal(result.code, "comment-window-exhausted")
  assert.deepEqual(commentPages, [1, 2, 3, 4, 5])
  assert.deepEqual(mutations, [])
  assert.ok(logs.some((message) => message.includes("first 500 comments")))
})

test("a full early comment page still posts when pagination completes", async () => {
  const commentPages = []
  const fetchImpl = async (url, options = {}) => {
    const method = options.method ?? "GET"
    if (method === "GET" && url.includes("/pulls/")) return response(prData())
    if (method === "GET" && url.includes("/comments")) {
      const page = Number(new URL(url).searchParams.get("page"))
      commentPages.push(page)
      if (page === 1) {
        return response(
          Array.from({ length: 100 }, (_value, index) => ({
            id: 1_000 + index,
            body: `${REVIEW_MARKER}\nuser copy`,
            user: REGULAR_USER,
          })),
        )
      }
      return response([])
    }
    if (method === "POST") return response({ id: 30 }, 201)
    throw new Error("unexpected mutation")
  }
  const result = await publishOutcome({
    token: "token",
    repo: REPO,
    pr: 7,
    baseSha: BASE,
    headSha: HEAD,
    input: inputFixture(),
    outcome: outcomeFixture(),
    fetchImpl,
  })
  assert.equal(result.status, "posted")
  assert.deepEqual(commentPages, [1, 2])
})

test("bootstrap selector skips when base assets and pin are absent", () => {
  const { result, outputs } = runBootstrapSelector()
  assert.equal(result.status, 0)
  assert.equal(outputs.ready, "false")
  assert.equal(outputs.source, "missing")
  assert.equal(outputs.bootstrap, "false")
  assert.match(result.stdout, /OPENCODE_REVIEW_BOOTSTRAP_SHA is not configured/)
})

test("bootstrap selector uses only an exact approved full SHA", () => {
  const { result, outputs } = runBootstrapSelector({ bootstrapSha: PINNED_SOURCE })
  assert.equal(result.status, 0)
  assert.equal(outputs.ready, "true")
  assert.equal(outputs.bootstrap, "true")
  assert.equal(outputs.source, "trusted")
  assert.equal(outputs.source_sha, PINNED_SOURCE)
})

test("bootstrap selector rejects malformed and unpinned refs", () => {
  for (const pin of [
    "main",
    "17b90ac",
    "refs/heads/main",
    PINNED_SOURCE.toUpperCase(),
    `${PINNED_SOURCE} `,
    "0".repeat(39),
    "0".repeat(41),
  ]) {
    const { result, outputs } = runBootstrapSelector({ bootstrapSha: pin })
    assert.equal(result.status, 1, pin)
    assert.equal(outputs.ready, undefined, pin)
    assert.match(result.stderr, /exact 40-character lowercase commit SHA/, pin)
  }
})

test("bootstrap selector never substitutes the PR head", () => {
  const { result, outputs } = runBootstrapSelector({
    bootstrapSha: PINNED_SOURCE,
    headSha: ABSENT_HEAD,
  })
  assert.equal(result.status, 0)
  assert.equal(outputs.source_sha, PINNED_SOURCE)
  assert.notEqual(outputs.source_sha, ABSENT_HEAD)
})

test("base assets always win over any configured bootstrap pin", () => {
  for (const pin of ["", "main", PINNED_SOURCE]) {
    const { result, outputs } = runBootstrapSelector({ baseAssets: true, bootstrapSha: pin })
    assert.equal(result.status, 0, pin)
    assert.equal(outputs.ready, "true", pin)
    assert.equal(outputs.bootstrap, "false", pin)
    assert.equal(outputs.source, "base", pin)
    assert.equal(outputs.source_sha, BASE, pin)
  }
})

test("missing container modules do not fall back to the PR head", () => {
  const selector = bootstrapSelectorScript()
  for (const helper of ["review-container.mjs", "review-container-entry.mjs", "review-network.mjs"]) {
    assert.ok(selector.includes(helper), helper)
    // The selector probe and the post-checkout verification must both list the module.
    const path = `.github/scripts/${helper}`
    assert.ok(OPENCODE_WORKFLOW.split(path).length - 1 >= 2, path)
  }

  const missing = ".github/scripts/review-container.mjs"
  const withoutPin = runBootstrapSelector({ baseAssets: true, omitAsset: missing })
  assert.equal(withoutPin.result.status, 0)
  assert.equal(withoutPin.outputs.ready, "false")
  assert.equal(withoutPin.outputs.source, "missing")
  assert.notEqual(withoutPin.outputs.source_sha, HEAD)

  const withPin = runBootstrapSelector({
    baseAssets: true,
    omitAsset: missing,
    bootstrapSha: PINNED_SOURCE,
    headSha: ABSENT_HEAD,
  })
  assert.equal(withPin.result.status, 0)
  assert.equal(withPin.outputs.ready, "true")
  assert.equal(withPin.outputs.bootstrap, "true")
  assert.equal(withPin.outputs.source_sha, PINNED_SOURCE)
  assert.notEqual(withPin.outputs.source_sha, ABSENT_HEAD)
})

test("workflow prepends the reviewed head SHA to a reviewed outcome", () => {
  const root = tempDir("habi-review-head-sha-")
  const scriptPath = path.join(root, "head-sha.cjs")
  writeFile(scriptPath, workflowStepScript("Record reviewed head SHA in outcome"))

  const reviewedPath = path.join(root, "reviewed.json")
  writeFile(
    reviewedPath,
    JSON.stringify(
      outcomeFixture({
        headSha: HEAD,
        review: { markdown: "No high-confidence findings in the provided diff.", bytes: 1, truncated: false },
      }),
    ),
  )
  const reviewedResult = spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    env: { ...process.env, REVIEW_HEAD_SHA: HEAD, OUTCOME_PATH: reviewedPath },
  })
  assert.equal(reviewedResult.status, 0)
  const reviewed = JSON.parse(fs.readFileSync(reviewedPath, "utf8"))
  assert.ok(reviewed.review.markdown.startsWith(`Reviewed head SHA: ${HEAD}`))
  assert.match(reviewed.review.markdown, /No high-confidence findings/)
  assert.equal(reviewed.review.bytes, Buffer.byteLength(reviewed.review.markdown))

  const unavailablePath = path.join(root, "unavailable.json")
  writeFile(
    unavailablePath,
    JSON.stringify(
      outcomeFixture({
        status: "unavailable",
        review: null,
        diagnostic: { code: "provider-rate-limited" },
      }),
    ),
  )
  const unavailableResult = spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    env: { ...process.env, REVIEW_HEAD_SHA: HEAD, OUTCOME_PATH: unavailablePath },
  })
  assert.equal(unavailableResult.status, 0)
  const unavailable = JSON.parse(fs.readFileSync(unavailablePath, "utf8"))
  assert.equal(unavailable.status, "unavailable")
  assert.equal(unavailable.review, null)
})

test("workflow records trusted source metadata without replacing event identity", () => {
  const root = tempDir("habi-review-source-metadata-")
  const scriptPath = path.join(root, "metadata.cjs")
  const outputDir = path.join(root, "review-input")
  writeFile(scriptPath, workflowStepScript("Record trusted source metadata"))
  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      OUTPUT_DIR: outputDir,
      SOURCE_SHA: PINNED_SOURCE,
      BOOTSTRAP: "true",
      EVENT_BASE_SHA: BASE,
      EVENT_HEAD_SHA: HEAD,
    },
  })
  assert.equal(result.status, 0)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outputDir, "trusted-source.json"), "utf8")), {
    sha: PINNED_SOURCE,
    bootstrap: true,
    eventBaseSha: BASE,
    eventHeadSha: HEAD,
  })
})

test("workflow bootstrap path preserves fork and draft gates", () => {
  assert.match(
    OPENCODE_WORKFLOW,
    /HEAD_REPO: \$\{\{ github\.event\.pull_request\.head\.repo\.full_name \}\}/,
  )
  assert.match(OPENCODE_WORKFLOW, /if \[ "\$HEAD_REPO" != "\$BASE_REPO" \]/)
  assert.match(OPENCODE_WORKFLOW, /if: \$\{\{ github\.event\.pull_request\.draft == false \}\}/)
  const selector = bootstrapSelectorScript()
  assert.doesNotMatch(selector, /head\.sha|pull_request|HEAD_SHA/)
  assert.match(OPENCODE_WORKFLOW, /if: steps\.source\.outputs\.bootstrap == 'true'/)
  assert.match(OPENCODE_WORKFLOW, /ref: \$\{\{ steps\.source\.outputs\.source_sha \}\}/)
  assert.match(
    OPENCODE_WORKFLOW,
    /REVIEW_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/,
  )
  assert.match(
    OPENCODE_WORKFLOW,
    /REVIEW_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/,
  )
  assert.doesNotMatch(
    OPENCODE_WORKFLOW,
    /REVIEW_BASE_SHA: \$\{\{ steps\.source\.outputs\.source_sha \}\}/,
  )
  assert.match(OPENCODE_WORKFLOW, /trusted-source\.json/)
})
