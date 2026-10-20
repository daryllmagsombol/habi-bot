import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  GITHUB_ACTIONS_BOT_ID,
  GITHUB_ACTIONS_BOT_LOGIN,
  INPUT_LIMIT_BYTES,
  MODEL,
  OUTPUT_TRUNCATION_NOTICE,
  REVIEW_MARKER,
  buildCliArgs,
  buildCliEnv,
  buildOpenCodeConfig,
  classifyProviderError,
  classifyProviderText,
  escapeMentions,
  findBotComment,
  parseOpenCodeJsonl,
  renderComment,
  renderInertFence,
  sanitizeReview,
  sha256,
  truncateUtf8,
} from "./review-lib.mjs"
import { buildPrompt, fetchFiles, loadTrustedPrompts, prepareReview } from "./review-prepare.mjs"
import { runReview } from "./review-model.mjs"
import { publishOutcome } from "./review-publish.mjs"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const REPO = "daryllmagsombol/habi-bot"
const BASE = "a".repeat(40)
const HEAD = "b".repeat(40)
const APPROVED_BOOTSTRAP = "17b90acd17bc70c212043e9c3cc4e09ab29b8a6b"
const ABSENT_HEAD = "c".repeat(40)
const TRUSTED_ASSET_PATHS = [
  ".github/review/system.md",
  ".github/review/security.md",
  ".github/review/bugs.md",
  ".github/scripts/review-lib.mjs",
  ".github/scripts/review-prepare.mjs",
  ".github/scripts/review-model.mjs",
  ".github/scripts/review-publish.mjs",
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

function baseFixture(prompts = REAL_PROMPTS) {
  const root = tempDir("habi-review-base-")
  for (const [name, content] of Object.entries(prompts)) {
    writeFile(path.join(root, ".github", "review", `${name}.md`), content)
  }
  for (const helper of ["review-lib.mjs", "review-prepare.mjs", "review-model.mjs", "review-publish.mjs"]) {
    writeFile(path.join(root, ".github", "scripts", helper), `// fixture ${helper}\n`)
  }
  return root
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

function prepareFetch({ files, pr = prData() }) {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options })
    if (url.includes("/files?")) return response(files)
    if (url.includes("/pulls/")) return response(pr)
    throw new Error("unexpected fetch")
  }
  return { fetchImpl, calls }
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
    prompts: REAL_PROMPTS,
    files: [],
    coverage: coverage(),
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
    coverage: coverage(),
    review: { markdown: "No high-confidence findings in the provided diff.", bytes: 51, truncated: false },
    diagnostic: null,
    ...overrides,
  }
}

function modelFixture({ input = inputFixture(), prompt = PROMPT } = {}) {
  const root = tempDir("habi-review-model-")
  const inputPath = path.join(root, "input.json")
  const promptPath = path.join(root, "prompt.txt")
  writeFile(inputPath, JSON.stringify(input))
  writeFile(promptPath, prompt)
  return {
    root,
    inputPath,
    promptPath,
    outcomePath: path.join(root, "outcome.json"),
    workPath: path.join(root, "work"),
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

function runBootstrapSelector({ baseAssets = false, bootstrapSha = "", baseSha = BASE, headSha = HEAD } = {}) {
  const root = tempDir("habi-review-bootstrap-")
  if (baseAssets) {
    for (const relative of TRUSTED_ASSET_PATHS) {
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

test("pinned config is read-only, single-model, and fully denied", () => {
  const config = buildOpenCodeConfig()
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
  assert.equal(config.permission, "deny")
  assert.deepEqual(config.compaction, { auto: false, prune: false })
  assert.deepEqual(config.agent.review, {
    mode: "primary",
    model: MODEL,
    permission: "deny",
    steps: 1,
    description: "Read-only pull request review",
  })
  assert.deepEqual(config.agent.title, { disable: true })
  assert.deepEqual(config.agent.summary, { disable: true })
  assert.deepEqual(config.agent.compaction, { disable: true })
})

test("CLI environment is allowlisted with and without a provider key", () => {
  const home = tempDir("habi-review-home-")
  const workDir = tempDir("habi-review-work-")
  const prior = {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
    ACTIONS_RUNTIME_TOKEN: process.env.ACTIONS_RUNTIME_TOKEN,
  }
  process.env.GITHUB_TOKEN = "ghs_test"
  process.env.GITHUB_ACTIONS = "true"
  process.env.ACTIONS_RUNTIME_TOKEN = "runtime"

  try {
    const env = buildCliEnv({ home, workDir })
    assert.equal(env.PATH, "/usr/local/bin:/usr/bin:/bin")
    assert.equal(env.HOME, home)
    assert.equal(env.OPENCODE_API_KEY, undefined)
    for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "TMPDIR"]) {
      assert.ok(env[key].startsWith(home))
    }
    assert.equal(Object.keys(env).some((key) => /^(GITHUB|ACTIONS)_/.test(key)), false)
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT)
    assert.equal(config.model, MODEL)
    assert.equal(config.permission, "deny")
    assert.equal(JSON.parse(env.OPENCODE_PERMISSION)["*"], "deny")

    const withKey = buildCliEnv({ home, workDir, apiKey: "provider-key" })
    assert.equal(withKey.OPENCODE_API_KEY, "provider-key")
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test("trusted prompts are loaded from the base root, not a changed PR copy", async () => {
  const base = baseFixture()
  const changed = baseFixture({ ...REAL_PROMPTS, system: "ALTERED PR SYSTEM" })
  const outputDir = tempDir("habi-review-output-")
  const { fetchImpl } = prepareFetch({
    files: [
      {
        filename: "apps/web/page.tsx",
        status: "modified",
        additions: 1,
        deletions: 1,
        changes: 2,
        sha: "c".repeat(40),
        patch: "@@ -1 +1 @@\n-old\n+new\n",
      },
    ],
  })

  const result = await prepareReview({
    repo: REPO,
    pr: 7,
    baseSha: BASE,
    headSha: HEAD,
    baseRoot: base,
    outputDir,
    token: "token",
    fetchImpl,
  })

  assert.equal(result.input.prompts.system, REAL_PROMPTS.system)
  assert.equal(result.input.prompts.system.includes("ALTERED PR SYSTEM"), false)
  assert.equal(result.prompt.includes("ALTERED PR SYSTEM"), false)
  assert.equal(fs.readFileSync(path.join(outputDir, "prompts", "system.md"), "utf8"), REAL_PROMPTS.system)
  assert.equal(loadTrustedPrompts(changed).system, "ALTERED PR SYSTEM")
})

test("prompt construction caps input and makes missing patches explicit", () => {
  const files = [
    {
      filename: "apps/web/a.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      changes: 2,
      sha: "c".repeat(40),
      patch: "@@ -1 +1 @@\n-a\n+b\n",
    },
    {
      filename: "assets/logo.png",
      status: "added",
      additions: 0,
      deletions: 0,
      changes: 0,
      sha: "d".repeat(40),
      patch: null,
    },
    {
      filename: "apps/web/huge.ts",
      status: "modified",
      additions: 999,
      deletions: 999,
      changes: 1998,
      sha: "e".repeat(40),
      patch: "x".repeat(5_000),
    },
  ]
  const built = buildPrompt({
    repo: REPO,
    pr: 7,
    baseSha: BASE,
    headSha: HEAD,
    prompts: { system: "S", security: "SEC", bugs: "BUG" },
    files,
    limitBytes: 2_400,
  })

  assert.ok(Buffer.byteLength(built.prompt) <= 2_400)
  assert.equal(built.coverage.complete, false)
  assert.equal(built.coverage.patchesUnavailable, 1)
  assert.ok(built.coverage.filesOmitted >= 1 || built.coverage.truncatedFiles >= 1)
  assert.match(built.prompt, /PATCH UNAVAILABLE/)
  assert.ok(built.coverage.inputBytes <= 2_400)
})

test("prepare records missing patches and bounds API file reads", async () => {
  const base = baseFixture()
  const outputDir = tempDir("habi-review-output-")
  const { fetchImpl, calls } = prepareFetch({
    files: [
      {
        filename: "assets/logo.png",
        status: "added",
        additions: 0,
        deletions: 0,
        changes: 0,
        sha: "d".repeat(40),
      },
    ],
  })

  const result = await prepareReview({
    repo: REPO,
    pr: 7,
    baseSha: BASE,
    headSha: HEAD,
    baseRoot: base,
    outputDir,
    token: "token",
    fetchImpl,
  })

  assert.equal(result.input.coverage.patchesUnavailable, 1)
  assert.equal(result.input.coverage.complete, false)
  assert.match(result.prompt, /PATCH UNAVAILABLE/)
  assert.match(result.prompt, /binary, empty, or too large/)
  assert.ok(calls.some((call) => call.url.includes("/files?")))
  // Producer bookkeeping check; the consumer trusts same-run artifact provenance instead.
  const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, "manifest.json"), "utf8"))
  assert.equal(manifest.baseSha, BASE)
  for (const [file, digest] of Object.entries(manifest.files)) {
    assert.equal(sha256(fs.readFileSync(path.join(outputDir, file))), digest)
  }
})

test("prepare rejects stale PR identity before writing input", async () => {
  const base = baseFixture()
  const outputDir = tempDir("habi-review-output-")
  const { fetchImpl } = prepareFetch({ files: [], pr: prData({ head: "f".repeat(40) }) })

  await assert.rejects(
    prepareReview({
      repo: REPO,
      pr: 7,
      baseSha: BASE,
      headSha: HEAD,
      baseRoot: base,
      outputDir,
      token: "token",
      fetchImpl,
    }),
    (error) => error.code === "identity-mismatch",
  )
  assert.equal(fs.existsSync(path.join(outputDir, "input.json")), false)
})

test("prepare permits no changed files but reports complete scope", async () => {
  const base = baseFixture()
  const outputDir = tempDir("habi-review-output-")
  const { fetchImpl } = prepareFetch({ files: [] })
  const result = await prepareReview({
    repo: REPO,
    pr: 7,
    baseSha: BASE,
    headSha: HEAD,
    baseRoot: base,
    outputDir,
    token: "token",
    fetchImpl,
  })
  assert.equal(result.input.coverage.filesChanged, 0)
  assert.equal(result.input.coverage.complete, true)
})

test("bootstrap trusted source is metadata only and leaves event identity unchanged", async () => {
  const base = baseFixture()
  const outputDir = tempDir("habi-review-output-")
  const { fetchImpl } = prepareFetch({ files: [] })
  const result = await prepareReview({
    repo: REPO,
    pr: 7,
    baseSha: BASE,
    headSha: HEAD,
    baseRoot: base,
    outputDir,
    token: "token",
    trustedSourceSha: APPROVED_BOOTSTRAP,
    bootstrap: true,
    fetchImpl,
  })

  assert.equal(result.input.baseSha, BASE)
  assert.equal(result.input.headSha, HEAD)
  assert.deepEqual(result.input.trustedSource, { sha: APPROVED_BOOTSTRAP, bootstrap: true })
  assert.deepEqual(result.manifest.trustedSource, { sha: APPROVED_BOOTSTRAP, bootstrap: true })
  assert.match(result.prompt, /approved immutable bootstrap commit/)
  assert.match(
    result.prompt,
    new RegExp(`Trusted instructions source: approved bootstrap commit ${APPROVED_BOOTSTRAP}`),
  )
  assert.match(result.prompt, new RegExp(`Base SHA: ${BASE}`))
  assert.match(result.prompt, new RegExp(`Head SHA: ${HEAD}`))
  assert.doesNotMatch(result.prompt, new RegExp(`Base SHA: ${APPROVED_BOOTSTRAP}`))
})

test("trusted bootstrap source must be exact and cannot masquerade as base", async () => {
  const base = baseFixture()
  const fetchImpl = async () => {
    throw new Error("trusted source validation must happen before fetching")
  }

  for (const [trustedSourceSha, bootstrap] of [
    ["main", true],
    ["17b90ac", true],
    ["refs/heads/main", true],
    [APPROVED_BOOTSTRAP.toUpperCase(), true],
    [APPROVED_BOOTSTRAP, false],
    ["", true],
  ]) {
    await assert.rejects(
      prepareReview({
        repo: REPO,
        pr: 7,
        baseSha: BASE,
        headSha: HEAD,
        baseRoot: base,
        outputDir: tempDir("habi-review-output-"),
        token: "token",
        trustedSourceSha,
        bootstrap,
        fetchImpl,
      }),
      (error) => error.code === "invalid-trusted-source",
      `${trustedSourceSha}/${bootstrap}`,
    )
  }
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
  assert.equal(classifyProviderText("unexpected parser failure"), null)
  assert.equal(classifyProviderText("HTTP 429 Too Many Requests"), "provider-rate-limited")
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

test("CLI invocation passes the prompt on stdin and strips host credentials", async () => {
  const fixture = modelFixture()
  let captured
  const spawn = (cli, args, options) => {
    captured = { cli, args, options }
    return spawnResult({ stdout: VALID_JSONL })
  }
  const result = await runReview({
    ...fixture,
    cliPath: "/fake/opencode",
    apiKey: "",
    expected: { repo: REPO, pr: 7, baseSha: BASE, headSha: HEAD },
    spawn,
  })

  assert.equal(result.exitCode, 0)
  assert.equal(captured.cli, "/fake/opencode")
  assert.deepEqual(captured.args, buildCliArgs(fixture.workPath))
  assert.equal(captured.options.input, PROMPT)
  assert.equal(captured.options.env.OPENCODE_API_KEY, undefined)
  assert.equal(Object.keys(captured.options.env).some((key) => /^(GITHUB|ACTIONS)_/.test(key)), false)
  assert.equal(captured.options.cwd, fixture.workPath)
  assert.equal(JSON.parse(fs.readFileSync(fixture.outcomePath, "utf8")).status, "reviewed")
})

test("provider key is passed directly when present", async () => {
  const fixture = modelFixture()
  let captured
  const spawn = (_cli, _args, options) => {
    captured = options
    return spawnResult({ stdout: VALID_JSONL })
  }
  await runReview({
    ...fixture,
    cliPath: "/fake/opencode",
    apiKey: "provider-key",
    expected: { repo: REPO, pr: 7, baseSha: BASE, headSha: HEAD },
    spawn,
  })
  assert.equal(captured.env.OPENCODE_API_KEY, "provider-key")
})

test("provider 429 is informational while parser defects fail", async () => {
  const limited = modelFixture()
  const limitedResult = await runReview({
    ...limited,
    cliPath: "/fake/opencode",
    expected: { repo: REPO, pr: 7, baseSha: BASE, headSha: HEAD },
    spawn: () =>
      spawnResult({
        status: 1,
        stdout: jsonl([
          { type: "error", error: { data: { statusCode: 429, message: "too many requests" } } },
        ]),
      }),
  })
  assert.equal(limitedResult.exitCode, 0)
  assert.equal(limitedResult.status, "unavailable")
  assert.equal(limitedResult.code, "provider-rate-limited")
  const limitedOutcome = JSON.parse(fs.readFileSync(limited.outcomePath, "utf8"))
  assert.equal(limitedOutcome.status, "unavailable")

  const broken = modelFixture()
  const brokenResult = await runReview({
    ...broken,
    cliPath: "/fake/opencode",
    expected: { repo: REPO, pr: 7, baseSha: BASE, headSha: HEAD },
    spawn: () => spawnResult({ status: 0, stdout: "not-json\n" }),
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

test("CLI timeout and stderr rate limits are informational", async () => {
  const timedOut = modelFixture()
  const timeoutResult = await runReview({
    ...timedOut,
    cliPath: "/fake/opencode",
    expected: { repo: REPO, pr: 7, baseSha: BASE, headSha: HEAD },
    spawn: () => spawnResult({ status: null, error: { code: "ETIMEDOUT" } }),
  })
  assert.equal(timeoutResult.exitCode, 0)
  assert.equal(timeoutResult.code, "cli-timeout")

  const limited = modelFixture()
  const limitedResult = await runReview({
    ...limited,
    cliPath: "/fake/opencode",
    expected: { repo: REPO, pr: 7, baseSha: BASE, headSha: HEAD },
    spawn: () => spawnResult({ status: 1, stdout: "", stderr: "HTTP 429 Too Many Requests" }),
  })
  assert.equal(limitedResult.exitCode, 0)
  assert.equal(limitedResult.code, "provider-rate-limited")

  const broken = modelFixture()
  const brokenResult = await runReview({
    ...broken,
    cliPath: "/fake/opencode",
    expected: { repo: REPO, pr: 7, baseSha: BASE, headSha: HEAD },
    spawn: () => spawnResult({ status: 1, stdout: "", stderr: "unexpected parser failure" }),
  })
  assert.equal(brokenResult.exitCode, 1)
  assert.equal(brokenResult.code, "cli-exit")
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
    outcomeFixture({ trustedSource: { sha: APPROVED_BOOTSTRAP, bootstrap: true } }),
  )
  assert.match(bootstrapBody, /Trusted review source: approved bootstrap commit/)
  assert.match(bootstrapBody, new RegExp(APPROVED_BOOTSTRAP))

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

test("end-to-end prepare, model, and publish are stubbed and never contact providers", async () => {
  const base = baseFixture()
  const outputDir = tempDir("habi-review-e2e-input-")
  const { fetchImpl: prepareFetchImpl } = prepareFetch({
    files: [
      {
        filename: "apps/web/page.tsx",
        status: "modified",
        additions: 1,
        deletions: 1,
        changes: 2,
        sha: "c".repeat(40),
        patch: "@@ -1 +1 @@\n-old\n+new\n",
      },
    ],
  })
  const prepared = await prepareReview({
    repo: REPO,
    pr: 7,
    baseSha: BASE,
    headSha: HEAD,
    baseRoot: base,
    outputDir,
    token: "token",
    fetchImpl: prepareFetchImpl,
  })
  assert.equal(prepared.input.coverage.complete, true)

  const fixture = modelFixture({ input: prepared.input, prompt: prepared.prompt })
  const modelResult = await runReview({
    ...fixture,
    cliPath: "/fake/opencode",
    expected: { repo: REPO, pr: 7, baseSha: BASE, headSha: HEAD },
    spawn: () => spawnResult({ stdout: VALID_JSONL }),
  })
  assert.equal(modelResult.status, "reviewed")
  const outcome = JSON.parse(fs.readFileSync(fixture.outcomePath, "utf8"))

  const calls = []
  const publishFetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? "GET", body: options.body })
    if ((options.method ?? "GET") === "GET" && url.includes("/pulls/")) return response(prData())
    if ((options.method ?? "GET") === "GET" && url.includes("/comments")) return response([])
    if (options.method === "POST") return response({ id: 11 }, 201)
    throw new Error("unexpected mutation")
  }
  const published = await publishOutcome({
    token: "token",
    repo: REPO,
    pr: 7,
    baseSha: BASE,
    headSha: HEAD,
    input: prepared.input,
    outcome,
    fetchImpl: publishFetchImpl,
  })
  assert.equal(published.status, "posted")
  const mutation = calls.find((call) => call.method !== "GET")
  assert.equal(mutation.method, "POST")
  assert.match(mutation.body, new RegExp(REVIEW_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  assert.match(mutation.body, /final review/)
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
  const { result, outputs } = runBootstrapSelector({ bootstrapSha: APPROVED_BOOTSTRAP })
  assert.equal(result.status, 0)
  assert.equal(outputs.ready, "true")
  assert.equal(outputs.bootstrap, "true")
  assert.equal(outputs.source, "trusted")
  assert.equal(outputs.source_sha, APPROVED_BOOTSTRAP)
})

test("bootstrap selector rejects malformed and unpinned refs", () => {
  for (const pin of [
    "main",
    "17b90ac",
    "refs/heads/main",
    APPROVED_BOOTSTRAP.toUpperCase(),
    `${APPROVED_BOOTSTRAP} `,
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
    bootstrapSha: APPROVED_BOOTSTRAP,
    headSha: ABSENT_HEAD,
  })
  assert.equal(result.status, 0)
  assert.equal(outputs.source_sha, APPROVED_BOOTSTRAP)
  assert.notEqual(outputs.source_sha, ABSENT_HEAD)
})

test("base assets always win over any configured bootstrap pin", () => {
  for (const pin of ["", "main", APPROVED_BOOTSTRAP]) {
    const { result, outputs } = runBootstrapSelector({ baseAssets: true, bootstrapSha: pin })
    assert.equal(result.status, 0, pin)
    assert.equal(outputs.ready, "true", pin)
    assert.equal(outputs.bootstrap, "false", pin)
    assert.equal(outputs.source, "base", pin)
    assert.equal(outputs.source_sha, BASE, pin)
  }
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
      SOURCE_SHA: APPROVED_BOOTSTRAP,
      BOOTSTRAP: "true",
      EVENT_BASE_SHA: BASE,
      EVENT_HEAD_SHA: HEAD,
    },
  })
  assert.equal(result.status, 0)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outputDir, "trusted-source.json"), "utf8")), {
    sha: APPROVED_BOOTSTRAP,
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

test("API file pagination is bounded and binary patches remain absent", async () => {
  const pages = []
  const fetchImpl = async (url) => {
    pages.push(url)
    const page = Number(new URL(url).searchParams.get("page"))
    if (page === 1) {
      return response(
        Array.from({ length: 100 }, (_value, index) => ({
          filename: `file-${index}.ts`,
          status: "modified",
          additions: 1,
          deletions: 0,
          changes: 1,
          sha: "c".repeat(40),
          patch: "@@ -1 +1 @@\n-a\n+b\n",
        })),
      )
    }
    return response([{ filename: "binary.png", status: "added", additions: 0, deletions: 0, changes: 0 }])
  }
  const result = await fetchFiles({ fetchImpl, apiUrl: "https://api.github.test", repo: REPO, pr: 7, token: "t" })
  assert.equal(result.files.length, 101)
  assert.equal(result.truncated, false)
  assert.equal("patch" in result.files[100], false)
  assert.equal(pages.length, 2)
})
