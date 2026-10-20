import fs from "node:fs"
import path from "node:path"
import {
  CLI_TIMEOUT_MS,
  INPUT_LIMIT_BYTES,
  MAX_REVIEW_ATTEMPTS,
  MODEL,
  OUTPUT_LIMIT_BYTES,
  RAW_LIMIT_BYTES,
  ReviewFailure,
  fail,
  findManifestBatch,
  isBatchId,
  isMain,
  isPr,
  isLowerSha,
  isRepo,
  isSha,
  parseOpenCodeJsonl,
  safeCode,
  safeDiagnostic,
  safeFinishReason,
  safeTokenCounts,
  sameTrustedSource,
  sanitizeReview,
  sha256,
  truncateUtf8,
  validateIdentity,
  validateReviewManifest,
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
  if (!isBatchId(input.batchId)) fail("invalid-batch")
  if (typeof input.promptSha256 !== "string" || !/^[0-9a-f]{64}$/.test(input.promptSha256)) {
    fail("invalid-input")
  }
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
    batchId: input.batchId,
    promptSha256: input.promptSha256,
    coverage: input.coverage,
    trustedSource: input.trustedSource ?? { sha: input.baseSha, bootstrap: false },
  }
}

function reviewedOutcome(input, parsed, attempts) {
  const cut = truncateUtf8(sanitizeReview(parsed.text), OUTPUT_LIMIT_BYTES)
  return {
    ...baseOutcome(input, "reviewed"),
    review: { markdown: cut.text, bytes: Buffer.byteLength(cut.text), truncated: cut.truncated || parsed.truncated === true },
    diagnostic: null,
    ...(attempts.length > 0 ? { attempts } : {}),
  }
}

function unavailableOutcome(input, code, { attempts = [], diagnostic } = {}) {
  return {
    ...baseOutcome(input, "unavailable"),
    review: null,
    diagnostic: safeDiagnostic(code, diagnostic),
    ...(attempts.length > 0 ? { attempts } : {}),
  }
}

/**
 * Build one bounded, sanitized attempt entry. Attempt entries are operator
 * evidence only; they never carry provider text or contribute findings.
 */
function attemptEntry(index, status, code, { finishReason, tokens, providerStatus } = {}) {
  const entry = { index, status, code: safeCode(code) }
  if (finishReason !== undefined) entry.finishReason = safeFinishReason(finishReason)
  const normalizedTokens = safeTokenCounts(tokens)
  if (normalizedTokens) entry.tokens = normalizedTokens
  if (Number.isInteger(providerStatus) && providerStatus >= 100 && providerStatus <= 599) {
    entry.providerStatus = providerStatus
  }
  return entry
}

/**
 * Keep exactly one attempt entry per actual runtime invocation. Replacing the
 * same index lets a late cancellation supersede that invocation's earlier
 * result without inventing a phantom invocation.
 */
function setAttempt(attempts, entry) {
  const position = attempts.findIndex((existing) => existing.index === entry.index)
  if (position === -1) attempts.push(entry)
  else attempts[position] = entry
  attempts.sort((left, right) => left.index - right.index)
  return attempts
}

function withAttempts(error, attempts) {
  if (attempts.length > 0) error.attempts = attempts
  return error
}

/**
 * Runtime cancellation is established by the explicit signal or by the
 * runtime's own signal cleanup (SIGINT 130 / SIGTERM 143). It is never cleared.
 */
function runtimeCancelled(signal) {
  return signal?.aborted === true || process.exitCode === 130 || process.exitCode === 143
}

function cancellationFailure(attempts, index) {
  if (index !== undefined) setAttempt(attempts, attemptEntry(index, "error", "cancelled"))
  return withAttempts(new ReviewFailure("cancelled"), attempts)
}

function errorOutcome({ manifest, batch, input, inputValidated, code, details, attempts }) {
  const diagnostic = safeDiagnostic(code, details)
  const attemptMeta = attempts.length > 0 ? { attempts } : {}
  if (manifest && batch) {
    return {
      version: 1,
      status: "error",
      repo: manifest.identity.repo,
      pr: manifest.identity.pr,
      baseSha: manifest.identity.baseSha,
      headSha: manifest.identity.headSha,
      model: MODEL,
      batchId: batch.id,
      promptSha256: batch.promptSha256,
      coverage: inputValidated ? input.coverage : null,
      trustedSource: manifest.trustedSource,
      review: null,
      diagnostic,
      ...attemptMeta,
    }
  }
  if (inputValidated) {
    return {
      ...baseOutcome(input, "error"),
      review: null,
      diagnostic,
      ...attemptMeta,
    }
  }
  return { version: 1, status: "error", review: null, diagnostic, ...attemptMeta }
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
  manifestPath,
  batchId,
  cliPath,
  expected,
  execute = runContainedCli,
  timeoutMs = CLI_TIMEOUT_MS,
  maxBuffer = RAW_LIMIT_BYTES,
  maxAttempts = MAX_REVIEW_ATTEMPTS,
  signal,
} = {}) {
  let input
  let manifest
  let batch
  let inputValidated = false
  let attempts = []
  try {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_REVIEW_ATTEMPTS) {
      fail("invalid-max-attempts")
    }

    if (typeof manifestPath !== "string" || manifestPath.length === 0) fail("missing-manifest")
    manifest = readJson(manifestPath)
    validateReviewManifest(manifest)
    if (expected) validateIdentity(expected, manifest.identity, "manifest")
    batch = findManifestBatch(manifest, batchId)

    input = readJson(inputPath)
    validateInput(input, expected)
    if (input.batchId !== batch.id) fail("batch-mismatch")
    if (input.promptSha256 !== batch.promptSha256) fail("prompt-hash-mismatch")
    const inputTrusted = input.trustedSource ?? { sha: input.baseSha, bootstrap: false }
    if (!sameTrustedSource(inputTrusted, manifest.trustedSource)) fail("trusted-source-mismatch")

    const prompt = fs.readFileSync(promptPath, "utf8")
    validatePrompt(prompt)
    // The actual prompt bytes must match both the untrusted batch input and the
    // trusted preparation manifest before any container execution.
    const actualPromptSha256 = sha256(prompt)
    if (actualPromptSha256 !== input.promptSha256 || actualPromptSha256 !== batch.promptSha256) {
      fail("prompt-hash-mismatch")
    }

    if (typeof cliPath !== "string" || cliPath.length === 0) fail("missing-cli")
    inputValidated = true

    // Every attempt reuses exactly the same validated batch, prompt bytes,
    // fixed keyless model configuration, and request shape. Only an explicit
    // structured output-length or provider-availability result is retried.
    const config = buildContainedConfig()
    let outcome
    let invocation = 0
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // Never start another runtime invocation after cancellation. If a prior
      // invocation exists, the cancellation supersedes that invocation's
      // terminal metadata in place rather than adding a phantom attempt.
      if (runtimeCancelled(signal)) {
        const lastIndex = attempts.length > 0 ? attempts[attempts.length - 1].index : undefined
        throw cancellationFailure(attempts, lastIndex)
      }

      invocation = attempt
      let result
      try {
        result = await execute({
          cliPath,
          prompt,
          config,
          timeoutMs,
          maxBuffer,
          signal,
        })
      } catch (error) {
        const code =
          error instanceof ReviewFailure
            ? error.code
            : typeof error?.code === "string"
              ? safeCode(error.code)
              : "container-failure"
        setAttempt(attempts, attemptEntry(invocation, "error", code))
        if (runtimeCancelled(signal)) throw cancellationFailure(attempts, invocation)
        throw withAttempts(error instanceof ReviewFailure ? error : new ReviewFailure(code), attempts)
      }

      // Late signal cleanup can set 130/143 after a result was produced. A
      // cancelled run must neither accept reviewed text nor retry the batch.
      if (runtimeCancelled(signal)) throw cancellationFailure(attempts, invocation)

      if (result?.error?.code === "ETIMEDOUT") {
        setAttempt(attempts, attemptEntry(invocation, "unavailable", "cli-timeout"))
        outcome = unavailableOutcome(input, "cli-timeout", { attempts })
        break
      }
      if (result?.error?.code === "ENOBUFS") {
        setAttempt(attempts, attemptEntry(invocation, "error", "raw-limit"))
        throw withAttempts(new ReviewFailure("raw-limit"), attempts)
      }
      if (result?.error) {
        setAttempt(attempts, attemptEntry(invocation, "error", "cli-spawn"))
        throw withAttempts(new ReviewFailure("cli-spawn"), attempts)
      }
      if (typeof result?.status !== "number") {
        setAttempt(attempts, attemptEntry(invocation, "error", "cli-signal"))
        throw withAttempts(new ReviewFailure("cli-signal"), attempts)
      }

      // Provider availability is derived only from structured JSONL events.
      // Unstructured stderr from Docker or the CLI is never trusted as a
      // provider signal: infrastructure failures must stay fatal.
      let parsed
      try {
        parsed = parseOpenCodeJsonl(result.stdout, result.status)
      } catch (error) {
        if (!(error instanceof ReviewFailure)) {
          setAttempt(attempts, attemptEntry(invocation, "error", "review-failure"))
          throw withAttempts(new ReviewFailure("review-failure"), attempts)
        }
        if (error.code === "output-length") {
          const details = error.details ?? {}
          setAttempt(
            attempts,
            attemptEntry(invocation, "error", "output-length", {
              finishReason: details.finishReason ?? "length",
              tokens: details.tokens,
            }),
          )
          if (invocation < maxAttempts) {
            if (runtimeCancelled(signal)) throw cancellationFailure(attempts, invocation)
            continue
          }
          throw withAttempts(new ReviewFailure("output-length", details), attempts)
        }
        // Every other parser/security failure is fatal on the first attempt.
        setAttempt(
          attempts,
          attemptEntry(invocation, "error", error.code, {
            finishReason: error.details?.finishReason,
            tokens: error.details?.tokens,
            providerStatus: error.details?.httpStatus,
          }),
        )
        throw withAttempts(error, attempts)
      }

      if (parsed.status === "unavailable") {
        setAttempt(
          attempts,
          attemptEntry(invocation, "unavailable", parsed.code, {
            finishReason: parsed.diagnostic?.finishReason,
            tokens: parsed.diagnostic?.tokens,
            providerStatus: parsed.diagnostic?.httpStatus,
          }),
        )
        if (parsed.retryable === true && invocation < maxAttempts) {
          if (runtimeCancelled(signal)) throw cancellationFailure(attempts, invocation)
          continue
        }
        outcome = unavailableOutcome(input, parsed.code, { attempts, diagnostic: parsed.diagnostic })
        break
      }

      setAttempt(
        attempts,
        attemptEntry(invocation, "reviewed", "reviewed", {
          finishReason: parsed.finishReason ?? "stop",
          tokens: parsed.tokens,
        }),
      )
      outcome = reviewedOutcome(input, parsed, attempts)
      break
    }

    if (!outcome) fail("review-failure")
    writeOutcome(outcomePath, outcome)
    return { exitCode: 0, status: outcome.status, code: outcome.diagnostic?.code ?? null }
  } catch (error) {
    const code = safeCode(error instanceof ReviewFailure ? error.code : "review-failure")
    const details = error instanceof ReviewFailure ? error.details : undefined
    const recordedAttempts = Array.isArray(error?.attempts) ? error.attempts : attempts
    const outcome = errorOutcome({
      manifest,
      batch,
      input,
      inputValidated,
      code,
      details,
      attempts: recordedAttempts,
    })
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
    manifestPath: option("--manifest"),
    batchId: option("--batch"),
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
