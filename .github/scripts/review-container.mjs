import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { createHash, randomBytes } from "node:crypto"
import { execFile, spawn as nodeSpawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  ENVELOPE_LIMIT_BYTES,
  INPUT_LIMIT_BYTES,
  MODEL,
  validateReviewConfig,
} from "./review-container-entry.mjs"

export const CLI_VERSION = "v1.19.3"
// Approved SHA-256 of the official opencode-linux-x64.tar.gz asset for v1.19.3.
// The workflow verifies this while downloading and extracting the single
// `opencode` member; this module separately verifies the extracted binary.
export const CLI_SHA256 = "13a8fb2978302071b86f9d7e00da9c8895f9cd846978379c3bdc6a5333536c9b"
// SHA-256 of the `opencode` executable extracted from that verified archive.
export const CLI_BINARY_SHA256 = "179ca421d61eefeadfa0c50e084a6e79c1623734732f0f4593f81ccfd3ab7ee9"
// linux/amd64 manifest selected from the node:24.20.0-bookworm-slim multi-arch
// index. The image has no declared volumes and includes glibc, /bin/sh, and
// /usr/bin/bash (checked by the container self-test).
export const BASE_IMAGE =
  "node:24.20.0-bookworm-slim@sha256:6642ef280aebc09c4541bee0b15c9f89f0f3f3c247ddee79ae1d37eddfdcbbaa"
export const BASE_IMAGE_DIGEST = "sha256:6642ef280aebc09c4541bee0b15c9f89f0f3f3c247ddee79ae1d37eddfdcbbaa"
export const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000
export const MAX_BUFFER_BYTES = 2 * 1024 * 1024
export const MAX_INPUT_BYTES = INPUT_LIMIT_BYTES
export const SELFTEST_TIMEOUT_MS = 120_000
export const ENTRY_FILE = "review-container-entry.mjs"
export const CONTAINER_ENTRY_PATH = "/opt/habi/review-container-entry.mjs"
export const CONTAINER_CLI_PATH = "/opt/habi/opencode"
export const ISOLATION_FAILED = "isolation-failed"
export const CLEANUP_FAILED = "cleanup-failed"
export const CONTAINER_CREATE_FAILED = "container-create-failed"
export const CONTAINER_CREATE_AMBIGUOUS = "container-create-ambiguous"
export const FORWARD_PROOF_FAILED = "forward-proof-failed"
export const OWNER_LABEL = "habi.review.owner"
const CONTAINER_REMOVE_ATTEMPTS = 3
const CONTAINER_REMOVE_RETRY_MS = 25

const TMPFS_ARGS = "/tmp:rw,nosuid,nodev,size=268435456"
const BLOCKED_CODES = new Set(["EACCES", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH"])
const PROVIDER_PROBE_URL = "https://opencode.ai/"
const PROVIDER_PROBE_HOST = "opencode.ai"
const PUBLIC_IPV6 = "2606:4700:4700::1111"
const METADATA_ADDRESS = "169.254.169.254"

export class ContainerFailure extends Error {
  constructor(code, options) {
    super(code, options)
    this.name = "ContainerFailure"
    this.code = code
  }
}

function fail(code, cause) {
  throw new ContainerFailure(code, cause ? { cause } : undefined)
}

function requireString(value, code) {
  if (typeof value !== "string" || value.length === 0) fail(code)
}

export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256")
    const stream = fs.createReadStream(filePath)
    stream.on("error", reject)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("end", () => resolve(hash.digest("hex")))
  })
}

export async function verifyCliFile(cliPath) {
  const stat = fs.statSync(cliPath)
  if (!stat.isFile()) fail("cli-integrity")
  const digest = await sha256File(cliPath)
  if (digest !== CLI_BINARY_SHA256) fail("cli-integrity")
}

export function buildDockerEnv({ dockerConfig, home }) {
  const env = {
    PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
    DOCKER_CONFIG: dockerConfig,
    TMPDIR: home,
  }
  for (const key of Object.keys(env)) {
    if (/^(GITHUB|ACTIONS)_|^ACTIONS_RUNTIME_TOKEN$|^OPENCODE_API_KEY$|_PROXY$/i.test(key)) fail("env-invalid")
  }
  return env
}

export function defaultRun(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        encoding: "utf8",
        timeout: options.timeout ?? 120_000,
        maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
        shell: false,
        signal: options.signal,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout
          error.stderr = stderr
          reject(error)
          return
        }
        resolve({ stdout, stderr })
      },
    )
  })
}

export function defaultSpawn(command, args, options) {
  return nodeSpawn(command, args, options)
}

export function buildContainerEnv() {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/tmp/home",
    XDG_CONFIG_HOME: "/tmp/home/.config",
    XDG_DATA_HOME: "/tmp/home/.local/share",
    XDG_CACHE_HOME: "/tmp/home/.cache",
    XDG_STATE_HOME: "/tmp/home/.local/state",
    TMPDIR: "/tmp/tmp",
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
  }
}

function assertContainerEnv(env) {
  const forbidden =
    /^(GITHUB|ACTIONS)_|^ACTIONS_RUNTIME_TOKEN$|^OPENCODE_API_KEY$|^(HTTPS?|ALL|NO|FTP|SOCKS)_PROXY$/i
  for (const key of Object.keys(env)) {
    if (forbidden.test(key)) fail("env-invalid")
    if (/(api[_-]?key|secret|token|password|credential)/i.test(key)) fail("env-invalid")
  }
}

export function buildContainedConfig() {
  const permission = { "*": "deny", read: "allow", bash: "allow" }
  return {
    $schema: "https://opencode.ai/config.json",
    model: MODEL,
    small_model: MODEL,
    default_agent: "review",
    enabled_providers: ["opencode"],
    share: "disabled",
    autoupdate: false,
    snapshot: false,
    formatter: false,
    lsp: false,
    plugin: [],
    instructions: [],
    skills: { paths: [], urls: [] },
    permission,
    compaction: { auto: false, prune: false },
    agent: {
      review: {
        mode: "primary",
        model: MODEL,
        permission,
        steps: 1,
        description: "Read-only pull request review",
      },
      title: { disable: true },
      summary: { disable: true },
      compaction: { disable: true },
    },
  }
}

export function validateConfig(config) {
  try {
    return validateReviewConfig(config)
  } catch (error) {
    fail(typeof error?.code === "string" ? error.code : "invalid-config", error)
  }
}

export function buildEnvelope(config, prompt) {
  const version = 1
  return JSON.stringify({ version, config, prompt })
}

export function buildHardenedCreateArgs({ name, network, image, env, owner }) {
  if (typeof owner !== "string" || owner.length === 0) fail("owner-missing")
  const args = [
    "create",
    "--name",
    name,
    "--network",
    network,
    "--platform",
    "linux/amd64",
    "--label",
    `${OWNER_LABEL}=${owner}`,
    "--log-driver",
    "none",
    "--interactive",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "65534:65534",
    "--pids-limit",
    "64",
    "--memory",
    "1g",
    "--cpus",
    "1",
    "--tmpfs",
    TMPFS_ARGS,
    "--sysctl",
    "net.ipv6.conf.all.disable_ipv6=1",
    "--sysctl",
    "net.ipv6.conf.default.disable_ipv6=1",
    "--ulimit",
    "core=0",
    "--dns",
    "1.1.1.1",
  ]
  for (const [key, value] of Object.entries(env)) args.push("--env", `${key}=${value}`)
  args.push(image)
  return args
}

export function assertContainerInfo(info, networkName) {
  if (!info || typeof info !== "object") fail("container-invalid")
  const config = info.Config
  const host = info.HostConfig
  if (!config || !host) fail("container-invalid")
  if (config.User !== "65534:65534") fail("container-invalid")
  if (host.ReadonlyRootfs !== true) fail("container-invalid")
  if (host.Privileged !== false) fail("container-invalid")
  if (host.LogConfig?.Type !== "none") fail("container-invalid")
  if (!Array.isArray(host.CapDrop) || !host.CapDrop.some((value) => String(value).toUpperCase() === "ALL")) {
    fail("container-invalid")
  }
  const security = Array.isArray(host.SecurityOpt) ? host.SecurityOpt : []
  if (!security.some((value) => /^no-new-privileges(:true)?$/.test(value))) fail("container-invalid")
  if (security.some((value) => /seccomp=unconfined/i.test(value))) fail("container-invalid")
  if (host.NetworkMode !== networkName) fail("container-invalid")
  if (Number(host.PidsLimit) !== 64) fail("container-invalid")
  if (Number(host.Memory) !== 1024 * 1024 * 1024) fail("container-invalid")
  if (Number(host.NanoCpus) !== 1_000_000_000) fail("container-invalid")
  if (host.IpcMode === "host" || host.PidMode === "host" || host.UTSMode === "host") fail("container-invalid")
  if (Array.isArray(host.Binds) && host.Binds.length > 0) fail("container-invalid")
  if (Array.isArray(host.VolumesFrom) && host.VolumesFrom.length > 0) fail("container-invalid")
  if (host.PortBindings && Object.keys(host.PortBindings).length > 0) fail("container-invalid")
  if (config.ExposedPorts && Object.keys(config.ExposedPorts).length > 0) fail("container-invalid")
  if (config.Volumes && Object.keys(config.Volumes).length > 0) fail("container-invalid")
  const envEntries = Array.isArray(config.Env) ? config.Env : []
  for (const entry of envEntries) {
    const key = String(entry).split("=")[0]
    if (/^(GITHUB|ACTIONS)_|^ACTIONS_RUNTIME_TOKEN$|^OPENCODE_API_KEY$|_PROXY$/i.test(key)) {
      fail("container-invalid")
    }
    if (key === "OPENCODE_CONFIG_CONTENT" || key === "OPENCODE_PERMISSION") fail("container-invalid")
  }
  if (!Array.isArray(host.Dns) || !host.Dns.includes("1.1.1.1")) fail("container-invalid")
  const ulimits = Array.isArray(host.Ulimits) ? host.Ulimits : []
  if (!ulimits.some((entry) => String(entry?.Name).toLowerCase() === "core" && Number(entry?.Soft) === 0)) {
    fail("container-invalid")
  }
  if (!host.Tmpfs || typeof host.Tmpfs["/tmp"] !== "string" || !host.Tmpfs["/tmp"].includes("size=268435456")) {
    fail("container-invalid")
  }
  if (host.Sysctls?.["net.ipv6.conf.all.disable_ipv6"] !== "1") fail("container-invalid")
  if (host.Sysctls?.["net.ipv6.conf.default.disable_ipv6"] !== "1") fail("container-invalid")
  const mounts = Array.isArray(info.Mounts) ? info.Mounts : []
  for (const mount of mounts) {
    if (mount?.Type !== "tmpfs" || mount?.Destination !== "/tmp") fail("container-invalid")
  }
  const attached = info.NetworkSettings?.Networks
  if (!attached || !attached[networkName]) fail("container-invalid")
  if (attached[networkName].GlobalIPv6Address) fail("container-invalid")
  if (info.State?.Running === true) fail("container-invalid")
}

function parseJson(value, code) {
  try {
    return JSON.parse(value)
  } catch {
    fail(code)
  }
}

function delay(ms) {
  // Keep this timer referenced: cleanup must finish even after the attached
  // client is gone and no other handles remain.
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorText(error) {
  if (!error) return ""
  const parts = [error.message, error.stderr, error.stdout]
  let current = error.cause
  for (let depth = 0; current && depth < 3; depth += 1) {
    parts.push(current.message, current.stderr, current.stdout)
    current = current.cause
  }
  return parts.filter((part) => typeof part === "string").join("\n")
}

function resourceAbsent(error) {
  return /no such (object|container|image)|not found|does not exist/i.test(errorText(error))
}

function parseIpv4(value) {
  if (typeof value !== "string") return null
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
  if (!match) return null
  const octets = match.slice(1, 5).map(Number)
  if (octets.some((octet) => octet > 255)) return null
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
}

function parseIpv4Cidr(value) {
  if (typeof value !== "string") return null
  const [address, prefixText] = value.split("/")
  const parsed = parseIpv4(address)
  if (parsed === null || typeof prefixText !== "string" || !/^\d{1,2}$/.test(prefixText)) return null
  const prefix = Number(prefixText)
  if (prefix > 32) return null
  return { address: parsed, prefix }
}

function ipv4InCidr(address, cidr) {
  const parsed = parseIpv4(address)
  const network = parseIpv4Cidr(cidr)
  if (parsed === null || !network) return false
  const mask = network.prefix === 0 ? 0 : (0xffffffff << (32 - network.prefix)) >>> 0
  return (parsed & mask) >>> 0 === (network.address & mask) >>> 0
}

function normalizeNetwork(network) {
  if (!network || typeof network !== "object") fail(ISOLATION_FAILED)
  requireString(network.name, ISOLATION_FAILED)
  if (typeof network.cleanup !== "function") fail(ISOLATION_FAILED)
  const dns = Array.isArray(network.dns) ? network.dns : typeof network.dns === "string" ? [network.dns] : null
  if (!dns || !dns.includes("1.1.1.1")) fail(ISOLATION_FAILED)
  if (typeof network.subnet !== "string" || network.subnet.length === 0) fail(ISOLATION_FAILED)
  return network
}

async function loadNetworkModule(provided) {
  if (provided !== undefined) {
    if (!provided || typeof provided.createIsolatedNetwork !== "function") fail(ISOLATION_FAILED)
    return provided
  }
  let module
  try {
    module = await import("./review-network.mjs")
  } catch (error) {
    fail(ISOLATION_FAILED, error)
  }
  if (!module || typeof module.createIsolatedNetwork !== "function") fail(ISOLATION_FAILED)
  return module
}

function normalizeImageInfo(value) {
  if (Array.isArray(value)) return value[0]
  return value
}

export function assertImageInfo(value) {
  const info = normalizeImageInfo(value)
  if (!info || typeof info !== "object") fail("image-invalid")
  if (info.Os !== "linux" || info.Architecture !== "amd64") fail("image-invalid")
  const volumes = info.Config?.Volumes
  if (volumes && typeof volumes === "object" && Object.keys(volumes).length > 0) fail("image-invalid")
}

async function inspectImage({ run, imageInspector }) {
  if (typeof imageInspector === "function") {
    const info = await imageInspector(BASE_IMAGE)
    assertImageInfo(info)
    return info
  }
  const { stdout } = await run("docker", ["image", "inspect", BASE_IMAGE])
  const info = parseJson(stdout, "image-invalid")
  assertImageInfo(info)
  return info
}

async function ensureBaseImage({ run, imageInspector }) {
  if (typeof imageInspector === "function") {
    await inspectImage({ run, imageInspector })
    return
  }
  await run("docker", ["pull", "--platform", "linux/amd64", BASE_IMAGE], { timeout: 5 * 60 * 1000 })
  await inspectImage({ run, imageInspector })
}

function dockerfile() {
  return [
    `FROM ${BASE_IMAGE}`,
    `COPY opencode ${CONTAINER_CLI_PATH}`,
    `COPY ${ENTRY_FILE} ${CONTAINER_ENTRY_PATH}`,
    `RUN chmod 0755 ${CONTAINER_CLI_PATH}`,
    "USER 65534:65534",
    `ENTRYPOINT ["node", "${CONTAINER_ENTRY_PATH}"]`,
    "",
  ].join("\n")
}

function prepareBuildContext({ root, cliPath }) {
  const buildDir = path.join(root, "build")
  fs.mkdirSync(buildDir, { recursive: true, mode: 0o700 })
  const entrySource = path.join(path.dirname(fileURLToPath(import.meta.url)), ENTRY_FILE)
  if (!fs.existsSync(entrySource)) fail("entry-missing")
  fs.copyFileSync(entrySource, path.join(buildDir, ENTRY_FILE))
  fs.copyFileSync(cliPath, path.join(buildDir, "opencode"))
  fs.chmodSync(path.join(buildDir, "opencode"), 0o755)
  fs.writeFileSync(path.join(buildDir, "Dockerfile"), dockerfile())
  const entries = fs.readdirSync(buildDir).sort()
  if (entries.join(",") !== ["Dockerfile", "opencode", ENTRY_FILE].sort().join(",")) fail("build-context-invalid")
  return buildDir
}

async function buildRuntimeImage({ run, cliPath, root, imageTag }) {
  const buildDir = prepareBuildContext({ root, cliPath })
  await run(
    "docker",
    ["build", "--platform", "linux/amd64", "--network=none", "--pull=false", "-t", imageTag, buildDir],
    { timeout: 5 * 60 * 1000 },
  )
  return imageTag
}

function firstHost(subnet) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(subnet)
  if (!match) return null
  const octets = match.slice(1, 5).map(Number)
  if (octets.some((octet) => octet > 255)) return null
  const prefix = Number(match[5])
  if (prefix > 32) return null
  const value = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  const host = ((value & mask) + 1) >>> 0
  return [host >>> 24, (host >>> 16) & 255, (host >>> 8) & 255, host & 255].join(".")
}

async function inspectGateway(run, network) {
  try {
    const { stdout } = await run("docker", ["network", "inspect", network.name])
    const parsed = parseJson(stdout, "isolation-failed")
    const inspected = Array.isArray(parsed) ? parsed[0] : parsed
    if (inspected?.EnableIPv6 === true) fail(ISOLATION_FAILED)
    const config = inspected?.IPAM?.Config?.[0]
    if (typeof config?.Gateway === "string" && /^\d{1,3}(\.\d{1,3}){3}$/.test(config.Gateway)) {
      return config.Gateway
    }
  } catch (error) {
    if (error instanceof ContainerFailure) throw error
  }
  const derived = firstHost(network.subnet)
  if (!derived) fail(ISOLATION_FAILED)
  return derived
}

function startProbeListener() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      response.writeHead(204)
      response.end()
    })
    server.on("error", reject)
    server.listen({ host: "0.0.0.0", port: 0 }, () => {
      const address = server.address()
      resolve({
        port: address.port,
        close: () =>
          new Promise((done) => {
            server.close(() => done())
          }),
      })
    })
  })
}

const PRIVATE_PROBE_CANDIDATES = [
  { cidr: "10.0.0.0/8", host: "10.255.255.254" },
  { cidr: "192.168.0.0/16", host: "192.168.255.254" },
  { cidr: "172.16.0.0/12", host: "172.31.255.254" },
]

async function loadNetworkPolicy({ module, run, id, network }) {
  if (typeof module?.assertNetworkIsolation !== "function") fail(ISOLATION_FAILED)
  let result
  try {
    result = await run("docker", ["network", "inspect", network.name])
  } catch {
    fail(ISOLATION_FAILED)
  }
  let policy
  try {
    policy = module.assertNetworkIsolation({
      id,
      inspect: parseJson(result.stdout, ISOLATION_FAILED),
      subnet: network.subnet,
    })
  } catch {
    fail(ISOLATION_FAILED)
  }
  const chain = policy?.policy?.dockerUserChain
  const rules = policy?.policy?.dockerUserRules
  if (typeof chain !== "string" || !/^[A-Za-z0-9_-]{1,28}$/.test(chain) || !Array.isArray(rules)) {
    fail(ISOLATION_FAILED)
  }
  return { chain, rules }
}

function ruleTargetsCidr(rule, cidr) {
  if (!Array.isArray(rule)) return false
  for (let index = 0; index < rule.length - 1; index += 1) {
    if (rule[index] === "-d" && rule[index + 1] === cidr) {
      return rule.includes("-j") && rule[rule.indexOf("-j") + 1] === "DROP"
    }
  }
  return false
}

function hostIpv4Addresses() {
  const addresses = new Set()
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry?.family === "IPv4" && typeof entry.address === "string") addresses.add(entry.address)
    }
  }
  return addresses
}

function choosePrivateProbe(policy, subnet, gateway) {
  const localAddresses = hostIpv4Addresses()
  for (const candidate of PRIVATE_PROBE_CANDIDATES) {
    if (!policy.rules.some((rule) => ruleTargetsCidr(rule, candidate.cidr))) continue
    if (candidate.host === gateway || localAddresses.has(candidate.host)) continue
    if (ipv4InCidr(candidate.host, subnet)) continue
    return candidate
  }
  fail(FORWARD_PROOF_FAILED)
}

async function readDropCounter({ run, chain, cidr }) {
  let result
  try {
    result = await run(
      "sudo",
      ["-n", "iptables", "--wait", "5", "-n", "-v", "-x", "-L", chain],
      { timeout: 10_000 },
    )
  } catch {
    fail(FORWARD_PROOF_FAILED)
  }
  let total = 0n
  let found = false
  for (const line of String(result.stdout).split(/\r?\n/)) {
    const tokens = line.trim().split(/\s+/)
    if (tokens.length < 3 || !/^\d+$/.test(tokens[0])) continue
    if (!tokens.includes(cidr) || !tokens.includes("DROP")) continue
    total += BigInt(tokens[0])
    found = true
  }
  if (!found) fail(FORWARD_PROOF_FAILED)
  return total
}

function buildProbes(gateway, hostPort, privateProbe) {
  return {
    tcp: [
      { name: "host-gateway", host: gateway, port: hostPort },
      { name: "host-metadata", host: METADATA_ADDRESS, port: 80 },
      { name: "private-443", host: privateProbe.host, port: 443 },
    ],
    dns: [PROVIDER_PROBE_HOST],
    https: [{ name: "provider", url: PROVIDER_PROBE_URL }],
    ipv6: [{ name: "public-ipv6", host: PUBLIC_IPV6, port: 443 }],
  }
}

function assertProbeOutcome(probes) {
  if (!probes || typeof probes !== "object") fail(ISOLATION_FAILED)
  const blocked = (entry) => entry && entry.ok === false && BLOCKED_CODES.has(entry.code)
  if (!Array.isArray(probes.tcp) || probes.tcp.length === 0 || !probes.tcp.every(blocked)) fail(ISOLATION_FAILED)
  if (!Array.isArray(probes.ipv6) || probes.ipv6.length === 0 || !probes.ipv6.every((entry) => entry.ok === false)) {
    fail(ISOLATION_FAILED)
  }
  if (!Array.isArray(probes.dns) || probes.dns.length === 0 || !probes.dns.every((entry) => entry.ok === true)) {
    fail(ISOLATION_FAILED)
  }
  if (
    !Array.isArray(probes.https) ||
    probes.https.length === 0 ||
    !probes.https.every((entry) => entry.ok === true && entry.status >= 200 && entry.status < 500)
  ) {
    fail(ISOLATION_FAILED)
  }
}

export async function streamAttached({
  run,
  spawn = defaultSpawn,
  containerId,
  env,
  input,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBuffer = MAX_BUFFER_BYTES,
  signal,
}) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ status: null, stdout: "", stderr: "", error: { code: "ECANCELED" } })
      return
    }
    let child
    try {
      child = spawn("docker", ["start", "--attach", "--interactive", containerId], {
        env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      })
    } catch (error) {
      resolve({ status: null, stdout: "", stderr: "", error: { code: error?.code ?? "spawn-failed" } })
      return
    }

    const out = []
    const err = []
    let bytes = 0
    let settled = false
    let timer

    const text = (chunks) => Buffer.concat(chunks).toString("utf8")
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.("abort", onAbort)
      resolve({ ...result, stdout: text(out), stderr: text(err) })
    }
    const killContainer = () => {
      Promise.resolve()
        .then(() => run("docker", ["kill", containerId]))
        .catch(() => {})
    }
    const stop = (code) => {
      try {
        child.kill("SIGKILL")
      } catch {
        // The client may already be gone.
      }
      killContainer()
      finish({ status: null, signal: "SIGKILL", error: { code } })
    }
    const append = (target, chunk) => {
      if (settled) return
      const remaining = maxBuffer - bytes
      if (remaining <= 0) {
        stop("ENOBUFS")
        return
      }
      if (chunk.length > remaining) {
        target.push(chunk.subarray(0, remaining))
        bytes = maxBuffer
        stop("ENOBUFS")
        return
      }
      target.push(chunk)
      bytes += chunk.length
    }
    const onAbort = () => stop("ECANCELED")

    child.stdout?.on("data", (chunk) => append(out, chunk))
    child.stderr?.on("data", (chunk) => append(err, chunk))
    child.on("error", (error) => {
      finish({ status: null, error: { code: error?.code ?? "spawn-failed" } })
    })
    child.on("close", (code, closeSignal) => {
      finish({ status: Number.isInteger(code) ? code : null, signal: closeSignal ?? undefined })
    })
    child.stdin?.on("error", () => {})
    if (signal) signal.addEventListener("abort", onAbort, { once: true })
    timer = setTimeout(() => stop("ETIMEDOUT"), timeoutMs)
    if (typeof timer.unref === "function") timer.unref()
    try {
      child.stdin.end(input)
    } catch {
      // Pipe failures surface through the child error/close events.
    }
  })
}

async function findOwnedContainer({ run, name, owner }) {
  let stdout
  try {
    const result = await run("docker", ["inspect", name])
    stdout = result.stdout
  } catch (error) {
    if (resourceAbsent(error)) return null
    return null
  }
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  const info = Array.isArray(parsed) ? parsed[0] : parsed
  if (!info || typeof info.Id !== "string") return null
  const inspectedName = String(info.Name ?? "").replace(/^\//, "")
  if (inspectedName !== name) return null
  if (info.Config?.Labels?.[OWNER_LABEL] !== owner) return null
  return info.Id
}

async function createContainer({ run, cleanupRun, onOwned, owner, name, network, image, env, command }) {
  const args = buildHardenedCreateArgs({ name, network, image, env, owner })
  if (command) args.push(...command)
  let stdout
  try {
    const result = await run("docker", args)
    stdout = result.stdout
  } catch (error) {
    const recovered = await findOwnedContainer({ run: cleanupRun, name, owner })
    if (recovered) {
      onOwned?.(recovered)
      fail(CONTAINER_CREATE_AMBIGUOUS, error)
    }
    fail(CONTAINER_CREATE_FAILED, error)
  }
  const id = String(stdout).trim()
  if (!/^[a-f0-9]{12,64}$/i.test(id)) {
    const recovered = await findOwnedContainer({ run: cleanupRun, name, owner })
    if (recovered) {
      onOwned?.(recovered)
      fail(CONTAINER_CREATE_AMBIGUOUS)
    }
    fail(CONTAINER_CREATE_FAILED)
  }
  return id
}

async function inspectContainer({ run, id, network, owner }) {
  const { stdout } = await run("docker", ["inspect", id])
  const parsed = parseJson(stdout, "container-invalid")
  const info = Array.isArray(parsed) ? parsed[0] : parsed
  assertContainerInfo(info, network)
  if (info.Config?.Labels?.[OWNER_LABEL] !== owner) fail("container-invalid")
  return info
}

async function containerPresent({ run, id }) {
  try {
    await run("docker", ["inspect", "--format", "{{.Id}}", id])
    return true
  } catch (error) {
    return !resourceAbsent(error)
  }
}

async function removeContainerConfirmed({ run, id }) {
  for (let attempt = 0; attempt < CONTAINER_REMOVE_ATTEMPTS; attempt += 1) {
    try {
      await run("docker", ["rm", "-f", id])
    } catch {
      // Confirmation below decides whether this is actually gone.
    }
    if (!(await containerPresent({ run, id }))) return true
    if (attempt + 1 < CONTAINER_REMOVE_ATTEMPTS) await delay(CONTAINER_REMOVE_RETRY_MS)
  }
  return !(await containerPresent({ run, id }))
}

async function imagePresent({ run, tag }) {
  try {
    await run("docker", ["image", "inspect", tag])
    return true
  } catch (error) {
    return !resourceAbsent(error)
  }
}

async function removeImageConfirmed({ run, tag }) {
  try {
    await run("docker", ["image", "rm", "-f", tag])
  } catch {
    // Confirmation below decides whether this is actually gone.
  }
  return !(await imagePresent({ run, tag }))
}

async function inspectOom({ run, id }) {
  try {
    const { stdout } = await run("docker", ["inspect", "--format", "{{json .State.OOMKilled}}", id])
    return String(stdout).trim() === "true"
  } catch {
    return false
  }
}

async function runSelfTestStage({
  run,
  cleanupRun,
  containers,
  spawn,
  network,
  policy,
  image,
  env,
  id,
  owner,
  timeoutMs,
  maxBuffer,
  signal,
}) {
  if (signal?.aborted) return { cancelled: true }
  const listener = await startProbeListener()
  try {
    const gateway = await inspectGateway(run, network)
    if (signal?.aborted) return { cancelled: true }
    const privateProbe = choosePrivateProbe(policy, network.subnet, gateway)
    const probes = buildProbes(gateway, listener.port, privateProbe)
    const before = await readDropCounter({ run: cleanupRun, chain: policy.chain, cidr: privateProbe.cidr })
    const containerId = await createContainer({
      run,
      cleanupRun,
      onOwned: (id) => containers?.add(id),
      owner,
      name: `habi-review-selftest-${id}`,
      network: network.name,
      image,
      env,
      command: ["--self-test"],
    })
    containers?.add(containerId)
    let result
    try {
      await inspectContainer({ run, id: containerId, network: network.name, owner })
      result = await streamAttached({
        run: cleanupRun,
        spawn,
        containerId,
        env,
        input: JSON.stringify(probes),
        timeoutMs,
        maxBuffer,
        signal,
      })
      if (result.error?.code === "ECANCELED") return { cancelled: true }
      if (result.error) fail(ISOLATION_FAILED)
      if (result.status !== 0) fail(ISOLATION_FAILED)
      const parsed = parseJson(result.stdout.trim(), ISOLATION_FAILED)
      if (parsed.ok !== true) fail(ISOLATION_FAILED)
      assertProbeOutcome(parsed.probes)
      if (signal?.aborted) return { cancelled: true }
      const after = await readDropCounter({ run: cleanupRun, chain: policy.chain, cidr: privateProbe.cidr })
      if (after <= before) fail(FORWARD_PROOF_FAILED)
    } finally {
      const removed = await removeContainerConfirmed({ run: cleanupRun, id: containerId })
      if (removed) containers?.delete(containerId)
      else fail(CLEANUP_FAILED)
    }
  } finally {
    await listener.close()
  }
  return { cancelled: false }
}

function assertEnvelopeLimit(envelope) {
  if (Buffer.byteLength(envelope) > ENVELOPE_LIMIT_BYTES) fail("input-too-large")
}

export async function runContainedCli({
  cliPath,
  prompt,
  config,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBuffer = MAX_BUFFER_BYTES,
  signal,
  run = defaultRun,
  spawn = defaultSpawn,
  networkModule,
  imageInspector,
  verifyCli = verifyCliFile,
} = {}) {
  requireString(cliPath, "missing-cli")
  if (typeof prompt !== "string" || prompt.length === 0) fail("missing-prompt")
  if (Buffer.byteLength(prompt) > MAX_INPUT_BYTES) fail("input-too-large")
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) fail("invalid-timeout")
  if (!Number.isInteger(maxBuffer) || maxBuffer <= 0) fail("invalid-buffer")
  validateConfig(config)
  if (signal?.aborted) {
    return { status: null, stdout: "", stderr: "", error: { code: "ECANCELED" } }
  }

  const controller = new AbortController()
  let terminationSignal = null
  const onAbort = () => controller.abort()
  const onSignal = (name) => {
    if (terminationSignal === null) terminationSignal = name
    controller.abort()
  }
  const signalHandlers = {
    SIGINT: () => onSignal("SIGINT"),
    SIGTERM: () => onSignal("SIGTERM"),
  }
  const activeSignal = controller.signal

  const id = randomBytes(4).toString("hex")
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "habi-review-container-"))
  const home = path.join(root, "home")
  const dockerConfig = path.join(root, "docker")
  const dirs = [root]
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  fs.mkdirSync(dockerConfig, { recursive: true, mode: 0o700 })
  const env = buildDockerEnv({ dockerConfig, home })
  const containerEnv = buildContainerEnv()
  assertContainerEnv(containerEnv)
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener("abort", onAbort, { once: true })
  }
  process.on("SIGINT", signalHandlers.SIGINT)
  process.on("SIGTERM", signalHandlers.SIGTERM)
  const runDocker = (command, args, options = {}) =>
    run(command, args, { ...options, env: options.env ?? env })
  const runSignal = (command, args, options = {}) =>
    runDocker(command, args, { ...options, signal: options.signal ?? activeSignal })

  const containers = new Set()
  const directories = new Set(dirs)
  let network
  let networkResolved = false
  let imageTag
  let imageResolved = false
  const cleanup = async () => {
    const unresolved = []
    // Network contract: remove every owned container before asking the network
    // module to clean up. If a container cannot be removed, the module keeps the
    // firewall policy in place; we never flush or rewrite its rules ourselves.
    for (const containerId of [...containers]) {
      if (await removeContainerConfirmed({ run: runDocker, id: containerId })) {
        containers.delete(containerId)
      } else {
        unresolved.push("container")
      }
    }
    if (network && !networkResolved) {
      let result
      try {
        result = await network.cleanup()
      } catch {
        result = { ok: false }
      }
      if (result && result.ok === true) networkResolved = true
      else unresolved.push("network")
    }
    if (imageTag && !imageResolved) {
      if (await removeImageConfirmed({ run: runDocker, tag: imageTag })) imageResolved = true
      else unresolved.push("image")
    }
    for (const directory of [...directories]) {
      try {
        fs.rmSync(directory, { recursive: true, force: true })
        directories.delete(directory)
      } catch {
        unresolved.push("temp")
      }
    }
    if (unresolved.length > 0) throw new ContainerFailure(CLEANUP_FAILED)
  }

  try {
    try {
      await verifyCli(cliPath)
    } catch (error) {
      if (error instanceof ContainerFailure) throw error
      fail("cli-integrity", error)
    }
    const module = await loadNetworkModule(networkModule)
    try {
      network = await module.createIsolatedNetwork({ id, dockerConfig, run: runDocker })
      normalizeNetwork(network)
    } catch (error) {
      if (error instanceof ContainerFailure) throw error
      fail(ISOLATION_FAILED, error)
    }
    if (containsHostDockerConfig(network)) fail(ISOLATION_FAILED)
    const policy = await loadNetworkPolicy({ module, run: runSignal, id, network })

    await ensureBaseImage({ run: runSignal, imageInspector })
    imageTag = `habi-review-runtime:${id}`
    await buildRuntimeImage({ run: runSignal, cliPath, root, imageTag })

    const selfTestOwner = randomBytes(8).toString("hex")
    const selfTest = await runSelfTestStage({
      run: runSignal,
      cleanupRun: runDocker,
      containers,
      spawn,
      network,
      policy,
      image: imageTag,
      env,
      id,
      owner: selfTestOwner,
      timeoutMs: Math.min(timeoutMs, SELFTEST_TIMEOUT_MS),
      maxBuffer,
      signal: activeSignal,
    })
    if (selfTest.cancelled) {
      return { status: null, stdout: "", stderr: "", error: { code: "ECANCELED" } }
    }

    const envelope = buildEnvelope(config, prompt)
    assertEnvelopeLimit(envelope)
    const reviewOwner = randomBytes(8).toString("hex")
    const containerId = await createContainer({
      run: runSignal,
      cleanupRun: runDocker,
      onOwned: (ownedId) => containers.add(ownedId),
      owner: reviewOwner,
      name: `habi-review-${id}`,
      network: network.name,
      image: imageTag,
      env: containerEnv,
    })
    containers.add(containerId)
    await inspectContainer({ run: runSignal, id: containerId, network: network.name, owner: reviewOwner })

    const result = await streamAttached({
      run: runDocker,
      spawn,
      containerId,
      env,
      input: envelope,
      timeoutMs,
      maxBuffer,
      signal: activeSignal,
    })
    if (result.status !== 0 && !result.error) {
      if (await inspectOom({ run: runDocker, id: containerId })) result.error = { code: "oom" }
    }
    return result
  } catch (error) {
    if (activeSignal.aborted) {
      return { status: null, stdout: "", stderr: "", error: { code: "ECANCELED" } }
    }
    throw error
  } finally {
    let cleanupError
    try {
      await cleanup()
    } catch (error) {
      cleanupError = error
    }
    signal?.removeEventListener?.("abort", onAbort)
    process.removeListener("SIGINT", signalHandlers.SIGINT)
    process.removeListener("SIGTERM", signalHandlers.SIGTERM)
    if (terminationSignal === "SIGINT") process.exitCode = 130
    else if (terminationSignal === "SIGTERM") process.exitCode = 143
    if (cleanupError) throw cleanupError
  }
}

function containsHostDockerConfig(network) {
  if (["host", "bridge", "none", "default"].includes(network.name)) return true
  const values = [network.name, network.bridge, network.subnet]
  return values.some((value) => typeof value === "string" && /docker\.sock|\/var\/run\/docker/i.test(value))
}

export { MODEL }
