import fs from "node:fs"
import path from "node:path"
import {
  CLI_TIMEOUT_MS,
  INPUT_LIMIT_BYTES,
  MODEL,
  OUTPUT_LIMIT_BYTES,
  RAW_LIMIT_BYTES,
  ReviewFailure,
  fail,
  isMain,
  isPr,
  isLowerSha,
  isRepo,
  isSha,
  parseOpenCodeJsonl,
  safeCode,
  sanitizeReview,
  truncateUtf8,
  validateIdentity,
} from "./review-lib.mjs"
import { buildContainedConfig, runContainedCli } from "./review-container.mjs"

const TRUSTED_PROMPT_MARKERS = [
  "# Habi review — trusted system context",
  "# Security review lens — Habi",
  "# Correctness review lens — Habi",
  "# Pull request data (untrusted)",
]

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
  } catch {
    fail("invalid-json")
  }
}

function writeOutcome(filePath, outcome) {
  if (typeof filePath !== "string" || filePath.length === 0) return
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(outcome, null, 2)}\n`)
}

function validateInput(input, expected) {
  if (!input || typeof input !== "object" || input.version !== 1) fail("invalid-input")
  if (!isRepo(input.repo) || !isPr(input.pr) || !isSha(input.baseSha) || !isSha(input.headSha)) {
    fail("invalid-input")
  }
  if (input.model !== MODEL) fail("model-mismatch")
  if (!Array.isArray(input.files)) fail("invalid-input")
  if (!input.coverage || typeof input.coverage !== "object") fail("invalid-coverage")
  if (input.trustedSource !== undefined) {
    if (
      !input.trustedSource ||
      !isLowerSha(input.trustedSource.sha) ||
      typeof input.trustedSource.bootstrap !== "boolean"
    ) {
      fail("invalid-input")
    }
    if (input.trustedSource.bootstrap === false && input.trustedSource.sha !== input.baseSha) {
      fail("invalid-input")
    }
  }
  if (expected) validateIdentity(expected, input, "input")
}

function validatePrompt(prompt) {
  if (typeof prompt !== "string" || prompt.length === 0) fail("missing-prompt")
  if (Buffer.byteLength(prompt) > INPUT_LIMIT_BYTES) fail("input-too-large")
  for (const marker of TRUSTED_PROMPT_MARKERS) {
    if (!prompt.includes(marker)) fail("prompt-missing-trusted-context")
  }
}

function baseOutcome(input, status) {
  return {
    version: 1,
    status,
    repo: input.repo,
    pr: input.pr,
    baseSha: input.baseSha,
    headSha: input.headSha,
    model: MODEL,
    coverage: input.coverage,
    trustedSource: input.trustedSource ?? { sha: input.baseSha, bootstrap: false },
  }
}

function reviewedOutcome(input, parsed) {
  const cut = truncateUtf8(sanitizeReview(parsed.text), OUTPUT_LIMIT_BYTES)
  return {
    ...baseOutcome(input, "reviewed"),
    review: { markdown: cut.text, bytes: Buffer.byteLength(cut.text), truncated: cut.truncated || parsed.truncated === true },
    diagnostic: null,
  }
}

function unavailableOutcome(input, code) {
  return {
    ...baseOutcome(input, "unavailable"),
    review: null,
    diagnostic: { code: safeCode(code) },
  }
}

/**
 * Run one review through the hardened container runtime.
 *
 * `execute` is the only production execution seam. It defaults to the
 * container runner, which is keyless and reads the fixed config built here.
 * There is deliberately no host-process fallback: if the container runtime
 * cannot be trusted or started, the review fails closed.
 */
export async function runReview({
  inputPath,
  promptPath,
  outcomePath,
  cliPath,
  expected,
  execute = runContainedCli,
  timeoutMs = CLI_TIMEOUT_MS,
  maxBuffer = RAW_LIMIT_BYTES,
  signal,
} = {}) {
  let input
  let result
  try {
    input = readJson(inputPath)
    validateInput(input, expected)
    const prompt = fs.readFileSync(promptPath, "utf8")
    validatePrompt(prompt)

    if (typeof cliPath !== "string" || cliPath.length === 0) fail("missing-cli")

    try {
      result = await execute({
        cliPath,
        prompt,
        config: buildContainedConfig(),
        timeoutMs,
        maxBuffer,
        signal,
      })
    } catch (error) {
      if (error instanceof ReviewFailure) throw error
      // A container/network/isolation failure is always fatal. It must never be
      // downgraded to a provider-unavailable outcome.
      fail(typeof error?.code === "string" ? safeCode(error.code) : "container-failure")
    }

    let outcome
    if (result?.error?.code === "ETIMEDOUT") {
      outcome = unavailableOutcome(input, "cli-timeout")
    } else if (result?.error?.code === "ENOBUFS") {
      fail("raw-limit")
    } else if (result?.error) {
      fail("cli-spawn")
    } else if (typeof result?.status !== "number") {
      fail("cli-signal")
    } else {
      // Provider availability is derived only from structured JSONL events.
      // Unstructured stderr from Docker or the CLI is never trusted as a
      // provider signal: infrastructure failures must stay fatal.
      const parsed = parseOpenCodeJsonl(result.stdout, result.status)
      outcome =
        parsed.status === "unavailable"
          ? unavailableOutcome(input, parsed.code)
          : reviewedOutcome(input, parsed)
    }

    writeOutcome(outcomePath, outcome)
    return { exitCode: 0, status: outcome.status, code: outcome.diagnostic?.code ?? null }
  } catch (error) {
    const code = safeCode(error instanceof ReviewFailure ? error.code : "review-failure")
    const outcome = input
      ? { ...baseOutcome(input, "error"), review: null, diagnostic: { code } }
      : { version: 1, status: "error", review: null, diagnostic: { code } }
    try {
      writeOutcome(outcomePath, outcome)
    } catch {
      // The outcome artifact is best-effort on failure paths.
    }
    console.error(`opencode-review: failed (${code})`)
    return { exitCode: 1, status: "error", code }
  }
}

function option(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

export async function main(env = process.env) {
  const expected = {
    repo: env.REVIEW_REPO,
    pr: Number(env.REVIEW_PR),
    baseSha: env.REVIEW_BASE_SHA,
    headSha: env.REVIEW_HEAD_SHA,
  }
  const result = await runReview({
    inputPath: option("--input"),
    promptPath: option("--prompt"),
    outcomePath: option("--outcome"),
    cliPath: option("--cli"),
    expected,
  })

  if (result.status === "reviewed") console.log("opencode-review: reviewed")
  else if (result.status === "unavailable") console.log(`opencode-review: unavailable (${result.code})`)
  else console.error(`opencode-review: failed (${result.code})`)
  return result.exitCode
}

/**
 * Hand the reviewed result to the process exit code without overwriting a
 * cancellation already recorded by the runtime cleanup (SIGINT 130, SIGTERM
 * 143). A late signal can arrive after a valid inference result; the signal
 * code must win.
 */
export function preserveSignalExitCode(exitCode) {
  if (process.exitCode !== 130 && process.exitCode !== 143) {
    process.exitCode = exitCode
  }
}

if (isMain(import.meta.url)) {
  preserveSignalExitCode(await main())
}
