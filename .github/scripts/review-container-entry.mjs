import fs from "node:fs"
import net from "node:net"
import dns from "node:dns/promises"
import https from "node:https"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

// This file runs inside the isolated review container. Keep it self-contained:
// only Node built-ins are available there.
export const MODEL = "opencode/deepseek-v4.1-flash-free"
export const INPUT_LIMIT_BYTES = 120_000
export const CONFIG_LIMIT_BYTES = 64 * 1024
export const ENVELOPE_LIMIT_BYTES = INPUT_LIMIT_BYTES + CONFIG_LIMIT_BYTES
export const PROBE_LIMIT_BYTES = 16 * 1024
export const CLI_PATH = "/opt/habi/opencode"
export const ENTRY_PATH = "/opt/habi/review-container-entry.mjs"
export const HOME_DIR = "/tmp/home"
export const WORK_DIR = "/tmp/work"
export const TMP_DIR = "/tmp/tmp"
export const PROBE_TIMEOUT_MS = 800

export const CLI_ARGS = Object.freeze([
  "run",
  "--dir",
  WORK_DIR,
  "--agent",
  "review",
  "--model",
  MODEL,
  "--title",
  "PR review",
  "--format",
  "json",
])

const SAFE_ENV_KEYS = Object.freeze([
  "PATH",
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "TMPDIR",
  "CI",
  "NO_COLOR",
  "LANG",
  "OPENCODE_DISABLE_PROJECT_CONFIG",
  "OPENCODE_PURE",
  "OPENCODE_DISABLE_DEFAULT_PLUGINS",
  "OPENCODE_DISABLE_EXTERNAL_SKILLS",
  "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_AUTOUPDATE",
  "OPENCODE_DISABLE_AUTOCOMPACT",
  "OPENCODE_DISABLE_PRUNE",
  "OPENCODE_DISABLE_LSP_DOWNLOAD",
])

const FORBIDDEN_ENV = /^(GITHUB|ACTIONS)_|^ACTIONS_RUNTIME_TOKEN$|^OPENCODE_API_KEY$|^(HTTPS?|ALL|NO|FTP|SOCKS)_PROXY$/i
const SECRET_KEY = /api[_-]?key|apikey|secret|token|password|credential|authorization|private[_-]?key/i
const TOOL_KEYS = new Set(["*", "read", "bash"])

function fail(code) {
  const error = new Error(code)
  error.code = code
  throw error
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function assertNoSecrets(value, depth = 0) {
  if (depth > 8 || value === null || typeof value !== "object") return
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecrets(item, depth + 1)
    return
  }
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) fail("config-secret")
    assertNoSecrets(item, depth + 1)
  }
}

function assertPermission(value, label) {
  if (!isPlainObject(value)) fail(`config-${label}`)
  for (const [tool, mode] of Object.entries(value)) {
    if (typeof mode !== "string") fail(`config-${label}`)
    if (tool === "*") {
      if (mode !== "deny") fail(`config-${label}`)
    } else if (tool === "read" || tool === "bash") {
      if (mode !== "allow") fail(`config-${label}`)
    } else if (mode !== "deny") {
      fail(`config-${label}`)
    }
  }
  if (value["*"] !== "deny" || value.read !== "allow" || value.bash !== "allow") fail(`config-${label}`)
}

export function validateReviewConfig(config) {
  if (!isPlainObject(config)) fail("invalid-config")
  assertNoSecrets(config)
  if (config.model !== MODEL || config.small_model !== MODEL) fail("config-model")
  if (config.default_agent !== "review") fail("config-agent")
  if (config.share !== "disabled") fail("config-share")
  if (config.autoupdate !== false || config.snapshot !== false) fail("config-flags")
  if (config.formatter !== false || config.lsp !== false) fail("config-flags")
  if (!Array.isArray(config.plugin) || config.plugin.length !== 0) fail("config-plugins")
  if (!Array.isArray(config.instructions) || config.instructions.length !== 0) fail("config-instructions")
  if (!isPlainObject(config.skills)) fail("config-skills")
  if (
    !Array.isArray(config.skills.paths) ||
    config.skills.paths.length !== 0 ||
    !Array.isArray(config.skills.urls) ||
    config.skills.urls.length !== 0
  ) {
    fail("config-skills")
  }
  if (config.enabled_providers !== undefined) {
    if (!Array.isArray(config.enabled_providers) || config.enabled_providers.length !== 1) fail("config-provider")
    if (config.enabled_providers[0] !== "opencode") fail("config-provider")
  }
  if (config.compaction !== undefined) {
    if (!isPlainObject(config.compaction)) fail("config-compaction")
    if (config.compaction.auto !== false || config.compaction.prune !== false) fail("config-compaction")
  }
  assertPermission(config.permission, "permission")
  if (!isPlainObject(config.agent) || !isPlainObject(config.agent.review)) fail("config-agent")
  const agent = config.agent.review
  if (agent.mode !== "primary" || agent.model !== MODEL || agent.steps !== 1) fail("config-agent")
  assertPermission(agent.permission, "agent-permission")
  for (const key of Object.keys(config)) {
    if (key === "apiKey" || key === "providers" || key === "provider") fail("config-secret")
  }
  return config
}

export function parseEnvelope(raw) {
  const text = String(raw ?? "")
  if (Buffer.byteLength(text) > ENVELOPE_LIMIT_BYTES) fail("input-too-large")
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    fail("invalid-envelope")
  }
  if (!isPlainObject(parsed) || parsed.version !== 1) fail("invalid-envelope")
  if (typeof parsed.prompt !== "string" || parsed.prompt.length === 0) fail("missing-prompt")
  if (Buffer.byteLength(parsed.prompt) > INPUT_LIMIT_BYTES) fail("input-too-large")
  validateReviewConfig(parsed.config)
  if (Buffer.byteLength(JSON.stringify(parsed.config)) > CONFIG_LIMIT_BYTES) fail("input-too-large")
  return { config: parsed.config, prompt: parsed.prompt }
}

export function buildCliEnv(base = process.env, config) {
  const env = {}
  for (const key of SAFE_ENV_KEYS) {
    if (typeof base[key] === "string" && !FORBIDDEN_ENV.test(key)) env[key] = base[key]
  }
  env.HOME = env.HOME ?? HOME_DIR
  env.TMPDIR = env.TMPDIR ?? TMP_DIR
  env.PATH = env.PATH ?? "/usr/local/bin:/usr/bin:/bin"
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config)
  env.OPENCODE_PERMISSION = JSON.stringify(config.permission)
  for (const key of Object.keys(env)) {
    if (FORBIDDEN_ENV.test(key)) fail("env-invalid")
  }
  return env
}

export function readBounded(stream, limitBytes, idleTimeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    let settled = false
    let timer = setTimeout(() => finish(), idleTimeoutMs)
    if (typeof timer.unref === "function") timer.unref()
    const touch = () => {
      clearTimeout(timer)
      timer = setTimeout(() => finish(), idleTimeoutMs)
      if (typeof timer.unref === "function") timer.unref()
    }
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(Buffer.concat(chunks).toString("utf8"))
    }
    const failRead = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stream.destroy()
      reject(Object.assign(new Error(code), { code }))
    }
    stream.on("data", (chunk) => {
      if (settled) return
      touch()
      bytes += chunk.length
      if (bytes > limitBytes) {
        failRead("input-too-large")
        return
      }
      chunks.push(chunk)
    })
    stream.on("end", finish)
    stream.on("error", () => failRead("stdin-error"))
  })
}

function ensureDirectories() {
  for (const directory of [
    HOME_DIR,
    path.join(HOME_DIR, ".config"),
    path.join(HOME_DIR, ".local", "share"),
    path.join(HOME_DIR, ".cache"),
    path.join(HOME_DIR, ".local", "state"),
    TMP_DIR,
    WORK_DIR,
  ]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
}

export async function runReviewEntry({ stdin = process.stdin, spawnImpl = spawn } = {}) {
  let config
  try {
    const raw = await readBounded(stdin, ENVELOPE_LIMIT_BYTES)
    const envelope = parseEnvelope(raw)
    config = envelope.config
    ensureDirectories()
    const env = buildCliEnv(process.env, config)
    const child = spawnImpl(CLI_PATH, CLI_ARGS, {
      cwd: WORK_DIR,
      env,
      shell: false,
      stdio: ["pipe", "inherit", "inherit"],
    })
    let exited = false
    const forward = (signal) => {
      if (!exited) {
        try {
          child.kill(signal)
        } catch {
          // The CLI may already be gone.
        }
      }
    }
    process.on("SIGTERM", () => forward("SIGTERM"))
    process.on("SIGINT", () => forward("SIGINT"))
    child.on("error", () => {
      process.stderr.write("review-entry: cli-spawn failed\n")
    })
    child.stdin.on("error", () => {})
    child.stdin.end(envelope.prompt)
    const result = await new Promise((resolve) => {
      child.on("close", (code, signal) => {
        exited = true
        resolve({ code, signal })
      })
      child.on("error", (error) => {
        exited = true
        resolve({ code: null, signal: null, error })
      })
    })
    if (result.error || result.signal) return 1
    return Number.isInteger(result.code) ? result.code : 1
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "entry-failure"
    process.stderr.write(`review-entry: failed (${code})\n`)
    return 1
  }
}

function checkScratch() {
  const target = path.join(TMP_DIR, `selftest-${process.pid}-${Date.now()}`)
  fs.writeFileSync(target, "ok", { mode: 0o600 })
  fs.unlinkSync(target)
}

function checkRootReadOnly() {
  const candidates = ["/opt/habi/.selftest-write", "/.selftest-write"]
  for (const target of candidates) {
    let wrote = false
    try {
      fs.writeFileSync(target, "no", { flag: "wx" })
      wrote = true
    } catch (error) {
      if (error?.code !== "EROFS" && error?.code !== "EACCES" && error?.code !== "EPERM") {
        throw new Error(`rootfs-write-${error?.code ?? "unknown"}`)
      }
    }
    if (wrote) {
      try {
        fs.unlinkSync(target)
      } catch {
        // Best effort; a writable root is already a failure.
      }
      throw new Error("rootfs-writable")
    }
  }
}

function checkHostRepositoryAbsent() {
  for (const candidate of ["/workspace", "/github", "/src", "/repo", "/home/runner/work"]) {
    if (fs.existsSync(candidate)) throw new Error("host-repository-present")
  }
}

const ALLOWED_MOUNTS = new Set([
  "/",
  "/proc",
  "/proc/sys",
  "/proc/sysrq-trigger",
  "/proc/bus",
  "/proc/fs",
  "/proc/irq",
  "/proc/acpi",
  "/proc/interrupts",
  "/proc/kcore",
  "/proc/keys",
  "/proc/latency_stats",
  "/proc/timer_list",
  "/proc/timer_stats",
  "/proc/sched_debug",
  "/proc/scsi",
  "/sys",
  "/sys/fs/cgroup",
  "/sys/firmware",
  "/dev",
  "/dev/pts",
  "/dev/shm",
  "/dev/mqueue",
  "/tmp",
  "/etc/hosts",
  "/etc/hostname",
  "/etc/resolv.conf",
])

function checkMounts() {
  const mounts = fs.readFileSync("/proc/mounts", "utf8").trim().split("\n")
  let rootReadOnly = false
  for (const line of mounts) {
    const parts = line.split(" ")
    const destination = parts[1]
    const options = (parts[3] ?? "").split(",")
    if (destination === "/") rootReadOnly = options.includes("ro")
    if (destination === "/tmp" && (parts[2] !== "tmpfs" || !options.includes("rw"))) {
      throw new Error("tmpfs-invalid")
    }
    if (!ALLOWED_MOUNTS.has(destination)) throw new Error("unexpected-mount")
  }
  if (!rootReadOnly) throw new Error("rootfs-writable")
}

function statusValue(name) {
  const line = fs
    .readFileSync("/proc/self/status", "utf8")
    .split("\n")
    .find((entry) => entry.startsWith(`${name}:`))
  return line ? line.slice(name.length + 1).trim() : ""
}

function checkProcess() {
  if (typeof process.getuid === "function" && process.getuid() !== 65534) throw new Error("uid-mismatch")
  const capEff = BigInt(`0x${statusValue("CapEff") || "0"}`)
  if (capEff !== 0n) throw new Error("capabilities-present")
  if (statusValue("NoNewPrivs") !== "1") throw new Error("no-new-privileges-missing")
}

function readSysctl(file) {
  try {
    return fs.readFileSync(file, "utf8").trim()
  } catch {
    return null
  }
}

function checkIpv6Disabled() {
  for (const file of [
    "/proc/sys/net/ipv6/conf/all/disable_ipv6",
    "/proc/sys/net/ipv6/conf/default/disable_ipv6",
  ]) {
    const value = readSysctl(file)
    if (value !== null && value !== "1") throw new Error("ipv6-enabled")
  }
}

function checkRuntimeAssets() {
  for (const file of ["/bin/sh", "/usr/bin/bash", CLI_PATH, ENTRY_PATH]) {
    if (!fs.existsSync(file)) throw new Error("runtime-asset-missing")
  }
  if (!process.version.startsWith("v24.20.")) throw new Error("node-version-mismatch")
}

function tcpProbe(host, port, timeoutMs, family) {
  return new Promise((resolve) => {
    let settled = false
    const socket = net.createConnection({ host, port, family })
    const timer = setTimeout(() => done({ ok: false, code: "ETIMEDOUT" }), timeoutMs)
    if (typeof timer.unref === "function") timer.unref()
    const done = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }
    socket.on("connect", () => done({ ok: true }))
    socket.on("timeout", () => done({ ok: false, code: "ETIMEDOUT" }))
    socket.on("error", (error) => done({ ok: false, code: error?.code ?? "ERR" }))
    socket.setTimeout(timeoutMs)
  })
}

function dnsProbe(host, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => done({ ok: false, code: "ETIMEDOUT" }), timeoutMs)
    if (typeof timer.unref === "function") timer.unref()
    const done = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    dns
      .lookup(host)
      .then((entry) => done({ ok: true, address: entry.address }))
      .catch((error) => done({ ok: false, code: error?.code ?? "ERR" }))
  })
}

function httpsProbe(url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    let request
    const timer = setTimeout(() => {
      try {
        request?.destroy()
      } catch {
        // Best effort.
      }
      done({ ok: false, code: "ETIMEDOUT" })
    }, timeoutMs)
    if (typeof timer.unref === "function") timer.unref()
    const done = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    try {
      request = https.request(
        url,
        { method: "HEAD", timeout: timeoutMs, headers: { "user-agent": "habi-review-selftest" } },
        (response) => {
          response.resume()
          done({ ok: true, status: Number(response.statusCode) || 0 })
        },
      )
      request.on("timeout", () => {
        request.destroy()
        done({ ok: false, code: "ETIMEDOUT" })
      })
      request.on("error", (error) => done({ ok: false, code: error?.code ?? "ERR" }))
      request.end()
    } catch (error) {
      done({ ok: false, code: error?.code ?? "ERR" })
    }
  })
}

function normalizeProbes(value) {
  if (!isPlainObject(value)) return { tcp: [], dns: [], https: [], ipv6: [] }
  const limit = (items) => (Array.isArray(items) ? items.slice(0, 16) : [])
  return {
    tcp: limit(value.tcp),
    dns: limit(value.dns),
    https: limit(value.https),
    ipv6: limit(value.ipv6),
  }
}

export async function runProbes(rawProbes, timeoutMs = PROBE_TIMEOUT_MS) {
  const probes = normalizeProbes(rawProbes)
  const results = { tcp: [], dns: [], https: [], ipv6: [] }
  for (const probe of probes.tcp) {
    if (!isPlainObject(probe) || typeof probe.host !== "string" || !Number.isInteger(probe.port)) continue
    results.tcp.push({
      name: typeof probe.name === "string" ? probe.name : probe.host,
      ...(await tcpProbe(probe.host, probe.port, timeoutMs, 4)),
    })
  }
  for (const host of probes.dns) {
    if (typeof host !== "string" || host.length === 0) continue
    results.dns.push({ name: host, ...(await dnsProbe(host, timeoutMs)) })
  }
  for (const probe of probes.https) {
    if (!isPlainObject(probe) || typeof probe.url !== "string" || !probe.url.startsWith("https://")) continue
    results.https.push({
      name: typeof probe.name === "string" ? probe.name : probe.url,
      ...(await httpsProbe(probe.url, timeoutMs)),
    })
  }
  for (const probe of probes.ipv6) {
    if (!isPlainObject(probe) || typeof probe.host !== "string" || !Number.isInteger(probe.port)) continue
    results.ipv6.push({
      name: typeof probe.name === "string" ? probe.name : probe.host,
      ...(await tcpProbe(probe.host, probe.port, timeoutMs, 6)),
    })
  }
  return results
}

export async function runSelfTest({ stdin = process.stdin } = {}) {
  try {
    ensureDirectories()
  } catch (error) {
    return {
      ok: false,
      checks: { directories: false },
      probes: { tcp: [], dns: [], https: [], ipv6: [] },
      failures: [`directories:${error?.code ?? "failed"}`],
    }
  }
  const checks = {}
  const failures = []
  const record = (name, fn) => {
    try {
      fn()
      checks[name] = true
    } catch (error) {
      checks[name] = false
      failures.push(`${name}:${error?.message ?? "failed"}`)
    }
  }

  record("scratch-write", checkScratch)
  record("rootfs-read-only", () => {
    checkRootReadOnly()
    checkMounts()
  })
  record("host-repository-absent", checkHostRepositoryAbsent)
  record("process-identity", checkProcess)
  record("ipv6-disabled", checkIpv6Disabled)
  record("runtime-assets", checkRuntimeAssets)

  let probes = {}
  try {
    const raw = await readBounded(stdin, PROBE_LIMIT_BYTES, 1_500)
    if (raw.trim().length > 0) probes = JSON.parse(raw)
  } catch (error) {
    failures.push(`probes:${error?.code ?? "invalid"}`)
  }

  let probeResults = { tcp: [], dns: [], https: [], ipv6: [] }
  if (failures.length === 0) {
    try {
      probeResults = await runProbes(probes)
    } catch (error) {
      failures.push(`probes:${error?.code ?? "failed"}`)
    }
  }

  return { ok: failures.length === 0, checks, probes: probeResults, failures }
}

function isMain() {
  if (!process.argv[1]) return false
  return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

if (isMain()) {
  if (process.argv.includes("--self-test")) {
    const result = await runSelfTest()
    process.stdout.write(`${JSON.stringify(result)}\n`)
    process.exitCode = result.ok ? 0 : 1
  } else {
    process.exitCode = await runReviewEntry()
  }
}
