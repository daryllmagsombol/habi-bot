import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import {
  CLI_TIMEOUT_MS,
  INPUT_LIMIT_BYTES,
  MODEL,
  OUTPUT_LIMIT_BYTES,
  RAW_LIMIT_BYTES,
  ReviewFailure,
  buildCliArgs,
  buildCliEnv,
  classifyProviderText,
  fail,
  isMain,
  isPr,
  isRepo,
  isSha,
  parseOpenCodeJsonl,
  safeCode,
  sanitizeReview,
  truncateUtf8,
  validateIdentity,
} from "./review-lib.mjs"

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
  if (expected) validateIdentity(expected, input, "input")
}

function validatePrompt(prompt) {
  if (typeof prompt !== "string" || prompt.length === 0) fail("missing-prompt")
  if (Buffer.byteLength(prompt) > INPUT_LIMIT_BYTES) fail("input-too-large")
  for (const marker of TRUSTED_PROMPT_MARKERS) {
    if (!prompt.includes(marker)) fail("prompt-missing-trusted-context")
  }
}

function ensureEmptyDirectory(directory) {
  if (fs.existsSync(directory)) {
    if (!fs.statSync(directory).isDirectory()) fail("workdir-invalid")
    if (fs.readdirSync(directory).length > 0) fail("workdir-not-empty")
  } else {
    fs.mkdirSync(directory, { recursive: true })
  }
  return directory
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

export async function runReview({
  inputPath,
  promptPath,
  outcomePath,
  workPath,
  cliPath,
  apiKey,
  expected,
  spawn = spawnSync,
  timeoutMs = CLI_TIMEOUT_MS,
} = {}) {
  let input
  let workDir
  let home
  try {
    input = readJson(inputPath)
    validateInput(input, expected)
    const prompt = fs.readFileSync(promptPath, "utf8")
    validatePrompt(prompt)

    if (typeof cliPath !== "string" || cliPath.length === 0) fail("missing-cli")
    workDir = ensureEmptyDirectory(workPath ?? fs.mkdtempSync(path.join(os.tmpdir(), "habi-review-work-")))
    home = fs.mkdtempSync(path.join(os.tmpdir(), "habi-review-home-"))
    const env = buildCliEnv({ home, workDir, apiKey })
    for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "TMPDIR"]) {
      fs.mkdirSync(env[key], { recursive: true })
    }

    let result
    try {
      result = spawn(cliPath, buildCliArgs(workDir), {
        cwd: workDir,
        env,
        input: prompt,
        encoding: "utf8",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: RAW_LIMIT_BYTES,
      })
    } catch {
      fail("cli-spawn")
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
      try {
        const parsed = parseOpenCodeJsonl(result.stdout, result.status)
        outcome =
          parsed.status === "unavailable"
            ? unavailableOutcome(input, parsed.code)
            : reviewedOutcome(input, parsed)
      } catch (error) {
        if (error instanceof ReviewFailure && error.code === "cli-exit") {
          const provider = classifyProviderText(result.stderr)
          if (provider) outcome = unavailableOutcome(input, provider)
          else throw error
        } else {
          throw error
        }
      }
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
  } finally {
    if (home) fs.rmSync(home, { recursive: true, force: true })
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true })
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
    workPath: option("--work"),
    cliPath: option("--cli"),
    apiKey: env.OPENCODE_API_KEY,
    expected,
  })

  if (result.status === "reviewed") console.log("opencode-review: reviewed")
  else if (result.status === "unavailable") console.log(`opencode-review: unavailable (${result.code})`)
  else console.error(`opencode-review: failed (${result.code})`)
  return result.exitCode
}

if (isMain(import.meta.url)) {
  process.exitCode = await main()
}
