// Linux network isolation for the OpenCode review container.
//
// Threat model and host assumptions:
// - The container is attached to one dedicated bridge network created here.
//   Callers must not attach it to any other Docker network.
// - DOCKER-USER does not cover traffic to host-local addresses, so this module
//   also installs an owned DROP chain at the front of the host INPUT chain.
// - The DOCKER-USER jump matches only `-i <bridge>`, so it sees outbound
//   container traffic, not replies arriving on an external interface. Special-
//   use destinations are therefore denied unconditionally before any allow rule.
//   Only TCP 443 (public destination) and UDP/TCP 53 to 1.1.1.1 are allowed for
//   conntrack NEW,ESTABLISHED; INVALID/UNTRACKED and everything else falls to
//   the default DROP.
// - 1.1.1.1 is an intentional public resolver. Callers must pass it as the
//   container DNS (`dns` in the returned object).
// - The Docker network has IPv6 disabled. Callers must also set the container
//   IPv6 sysctls returned in `ipv6.sysctls` by createIsolatedNetwork; this
//   module cannot enforce per-container sysctls without starting the container.
// - FORWARD policy and unrelated chains/rules are never modified. The module
//   requires Docker's DOCKER-USER chain to exist and verifies that the selected
//   iptables backend dispatches bridge traffic into it through the exact Docker
//   hook `-A FORWARD -j DOCKER-USER`. It never manufactures a replacement
//   FORWARD hook. Unknown earlier FORWARD jumps that could accept traffic, or a
//   missing/unsupported hook, fail closed and are reported as a backend
//   limitation.
// - All iptables calls use `sudo -n iptables --wait 5`. Chain names are derived
//   from a validated 8-character lowercase hex id, so they are unique to this
//   invocation and stay within iptables' 28-character limit.
// - The module never starts a container and never uses PR content in a command.
//   Every command is either a docker network operation or a fixed iptables
//   operation built from the id, bridge, DNS address, and static CIDRs.
//
// Runtime probe requirements (not provable by unit tests):
// - Run on Linux with a Docker daemon whose iptables backend exposes
//   DOCKER-USER, and verify a container on this network cannot reach host
//   loopback/private/metadata/IPv6 addresses while public HTTPS and DNS work.
// - Verify the container was started with --dns 1.1.1.1 and both IPv6 sysctls.
// - Verify no Kubernetes/GitHub runner private ranges or link-local metadata
//   endpoints are reachable. Unit tests only exercise the command contract.
// - Callers must stop/remove the container before cleanup; Docker refuses to
//   delete a network with active endpoints. Cleanup reports that failure so the
//   caller can retry after detaching.

import fs from "node:fs"
import { isIP } from "node:net"
import path from "node:path"

const REVIEW_DNS = "1.1.1.1"

const NETWORK_PREFIX = "habi-review-"
const BRIDGE_PREFIX = "hbrv"
const HOST_CHAIN_PREFIX = "HBRV-IN-"
const DOCKER_USER_CHAIN_PREFIX = "HBRV-DU-"
const MAX_CHAIN_LENGTH = 28
const MAX_BRIDGE_LENGTH = 15

export const IPV6_SYSCTLS = Object.freeze([
  "net.ipv6.conf.all.disable_ipv6=1",
  "net.ipv6.conf.default.disable_ipv6=1",
])

// RFC 6890 special-use ranges, link-local metadata, and Azure's platform
// address. These are denied for new outbound connections.
const SPECIAL_USE_IPV4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "168.63.129.16/32",
]

function fail(code, detail) {
  const error = new Error(detail ? `${code}: ${detail}` : code)
  error.code = code
  throw error
}

function validateId(id) {
  if (typeof id !== "string" || !/^[0-9a-f]{8}$/.test(id)) fail("invalid-id")
  return id
}

function validateRun(run) {
  if (typeof run !== "function") fail("invalid-run")
  return run
}

function validateDockerConfig(dockerConfig) {
  if (typeof dockerConfig !== "string" || !path.isAbsolute(dockerConfig)) {
    fail("invalid-docker-config")
  }

  let stat
  try {
    stat = fs.lstatSync(dockerConfig)
  } catch (error) {
    if (error?.code !== "ENOENT") fail("invalid-docker-config")
    try {
      fs.mkdirSync(dockerConfig, { recursive: true, mode: 0o700 })
      stat = fs.lstatSync(dockerConfig)
    } catch {
      fail("invalid-docker-config")
    }
  }

  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("invalid-docker-config")
  // A fresh, empty config directory prevents Docker from loading host
  // credentials/certificates. Callers should pass a newly created directory.
  try {
    if (fs.readdirSync(dockerConfig).length > 0) fail("docker-config-not-empty")
  } catch (error) {
    if (error?.code === "docker-config-not-empty") throw error
    fail("invalid-docker-config")
  }
  return dockerConfig
}

function isIpv4Cidr(value) {
  if (typeof value !== "string") return false
  const parts = value.split("/")
  if (parts.length !== 2) return false
  const [address, prefix] = parts
  if (isIP(address) !== 4) return false
  if (!/^(?:0|[1-9]\d?)$/.test(prefix)) return false
  const length = Number(prefix)
  return length >= 0 && length <= 32
}

function normalizeInspect(inspect) {
  if (Array.isArray(inspect)) return inspect
  if (inspect && typeof inspect === "object") return [inspect]
  return []
}

function networkNames(id) {
  return {
    name: `${NETWORK_PREFIX}${id}`,
    bridge: `${BRIDGE_PREFIX}${id}`,
    hostChain: `${HOST_CHAIN_PREFIX}${id}`,
    dockerUserChain: `${DOCKER_USER_CHAIN_PREFIX}${id}`,
  }
}

function assertQualifiedNames(names) {
  if (names.bridge.length > MAX_BRIDGE_LENGTH) fail("bridge-name-too-long")
  for (const chain of [names.hostChain, names.dockerUserChain]) {
    if (chain.length > MAX_CHAIN_LENGTH) fail("chain-name-too-long")
  }
}

function buildDockerUserRules(chain) {
  const rules = []
  for (const cidr of SPECIAL_USE_IPV4) {
    // Unconditional: this chain is reached only for outbound bridge traffic,
    // so there is no reply path here that would need private destinations.
    rules.push(["-A", chain, "-d", cidr, "-j", "DROP"])
  }

  const allowStates = ["-m", "conntrack", "--ctstate", "NEW,ESTABLISHED"]
  rules.push([
    "-A",
    chain,
    "-p",
    "udp",
    "-d",
    REVIEW_DNS,
    "--dport",
    "53",
    ...allowStates,
    "-j",
    "ACCEPT",
  ])
  rules.push([
    "-A",
    chain,
    "-p",
    "tcp",
    "-d",
    REVIEW_DNS,
    "--dport",
    "53",
    ...allowStates,
    "-j",
    "ACCEPT",
  ])

  // Destination-specific denials above mean this rule can only reach public
  // addresses. Explicit states keep INVALID/UNTRACKED on the default DROP path.
  rules.push(["-A", chain, "-p", "tcp", "--dport", "443", ...allowStates, "-j", "ACCEPT"])

  rules.push(["-A", chain, "-j", "DROP"])
  return rules
}

function buildPolicy(id) {
  const names = networkNames(id)
  assertQualifiedNames(names)
  return {
    ...names,
    dns: REVIEW_DNS,
    ipv6Sysctls: [...IPV6_SYSCTLS],
    hostInputRules: [["-A", names.hostChain, "-j", "DROP"]],
    hostInputJump: ["-I", "INPUT", "1", "-i", names.bridge, "-j", names.hostChain],
    dockerUserJump: ["-I", "DOCKER-USER", "1", "-i", names.bridge, "-j", names.dockerUserChain],
    dockerUserRules: buildDockerUserRules(names.dockerUserChain),
  }
}

function verificationArgs(chain, rule) {
  if (!rule || rule[0] !== "-A" || rule[1] !== chain) fail("invalid-rule")
  return ["-C", chain, ...rule.slice(2)]
}

// Validates Docker's network inspect output and returns the exact policy that
// createIsolatedNetwork installs. Exported so runtime checks can assert the
// same assumptions without creating another network.
export function assertNetworkIsolation({ id, inspect, subnet } = {}) {
  validateId(id)
  const entries = normalizeInspect(inspect)
  if (entries.length !== 1) fail("inspect-network-count")

  const network = entries[0]
  if (!network || typeof network !== "object") fail("inspect-network")
  const names = networkNames(id)
  assertQualifiedNames(names)

  if (network.Name !== names.name) fail("inspect-name")
  if (network.Driver !== "bridge") fail("inspect-driver")
  if (network.EnableIPv6 !== false) fail("inspect-ipv6")
  if (network.Internal === true) fail("inspect-internal")
  if (!network.Options || network.Options["com.docker.network.bridge.name"] !== names.bridge) {
    fail("inspect-bridge-option")
  }

  const configs = network.IPAM?.Config
  if (!Array.isArray(configs) || configs.length !== 1) fail("inspect-ipam")
  const config = configs[0]
  if (!config || !isIpv4Cidr(config.Subnet)) fail("inspect-subnet")
  if (subnet !== undefined && config.Subnet !== subnet) fail("inspect-subnet-mismatch")

  const policy = buildPolicy(id)
  return {
    name: names.name,
    bridge: names.bridge,
    dns: REVIEW_DNS,
    subnet: config.Subnet,
    ipv6: { networkEnabled: false, sysctls: [...IPV6_SYSCTLS] },
    policy: {
      hostInputChain: policy.hostChain,
      hostInputRules: policy.hostInputRules,
      hostInputJump: policy.hostInputJump,
      dockerUserChain: policy.dockerUserChain,
      dockerUserJump: policy.dockerUserJump,
      dockerUserRules: policy.dockerUserRules,
      verification: {
        hostInputJump: ["-C", "INPUT", "-i", names.bridge, "-j", names.hostChain],
        hostInputRules: policy.hostInputRules.map((rule) =>
          verificationArgs(policy.hostChain, rule),
        ),
        dockerUserJump: [
          "-C",
          "DOCKER-USER",
          "-i",
          names.bridge,
          "-j",
          names.dockerUserChain,
        ],
        dockerUserRules: policy.dockerUserRules.map((rule) =>
          verificationArgs(policy.dockerUserChain, rule),
        ),
      },
    },
  }
}

function describeCommand(command, args) {
  return `${command} ${args.join(" ")}`
}

async function dockerCall(ctx, args) {
  try {
    return await ctx.run("docker", ["--config", ctx.dockerConfig, ...args])
  } catch (cause) {
    const detail = cause instanceof Error && cause.message ? `: ${cause.message}` : ""
    const error = new Error(
      `docker-command-failed: ${describeCommand("docker", ["--config", ctx.dockerConfig, ...args])}${detail}`,
    )
    error.code = "docker-command-failed"
    error.cause = cause
    throw error
  }
}

async function iptablesCall(ctx, args) {
  try {
    return await ctx.run("sudo", ["-n", "iptables", "--wait", "5", ...args])
  } catch (cause) {
    const detail = cause instanceof Error && cause.message ? `: ${cause.message}` : ""
    const error = new Error(`iptables-command-failed: ${describeCommand("iptables", args)}${detail}`)
    error.code = "iptables-command-failed"
    error.cause = cause
    throw error
  }
}

function errorText(error) {
  const parts = []
  let current = error
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (typeof current === "string") {
      parts.push(current)
      break
    }
    parts.push(current.message, current.stderr, current.stdout)
    current = current.cause
  }
  return parts.filter((part) => typeof part === "string" && part.length > 0).join("\n").toLowerCase()
}

function isAbsent(error, kind) {
  const text = errorText(error)
  const patterns = {
    rule: [
      /bad rule/,
      /does a matching rule exist/,
      /no chain\/target\/match by that name/,
      /rule not found/,
    ],
    chain: [/no chain\/target\/match by that name/, /chain .*does not exist/, /chain not found/],
    network: [/no such network/, /no such object/, /network .*not found/],
  }
  return (patterns[kind] ?? []).some((pattern) => pattern.test(text))
}

async function iptablesExists(ctx, args) {
  try {
    await iptablesCall(ctx, args)
    return true
  } catch {
    return false
  }
}

function tokenizeRule(line) {
  const tokens = []
  let current = ""
  let quote = null
  let escaped = false
  for (const character of line) {
    if (escaped) {
      current += character
      escaped = false
      continue
    }
    if (character === "\\") {
      escaped = true
      continue
    }
    if (quote) {
      if (character === quote) quote = null
      else current += character
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (/\s/.test(character)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ""
      }
      continue
    }
    current += character
  }
  if (current.length > 0) tokens.push(current)
  return tokens
}

function meaningfulTokens(tokens) {
  const meaningful = []
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === "--comment") {
      index += 1
      continue
    }
    meaningful.push(tokens[index])
  }
  return meaningful
}

function interfaceMatches(pattern, value) {
  if (typeof pattern !== "string") return false
  if (pattern.endsWith("+")) return value.startsWith(pattern.slice(0, -1))
  return pattern === value
}

function forwardRuleCanMatchBridge(tokens, bridge) {
  const meaningful = meaningfulTokens(tokens)
  const positive = []
  const negative = []
  for (let index = 0; index < meaningful.length; index += 1) {
    if (meaningful[index] !== "-i" && meaningful[index] !== "--in-interface") continue
    const value = meaningful[index + 1]
    if (!value || value === "!") return true
    if (meaningful[index - 1] === "!") negative.push(value)
    else positive.push(value)
    index += 1
  }
  if (positive.some((value) => !interfaceMatches(value, bridge))) return false
  if (negative.some((value) => interfaceMatches(value, bridge))) return false
  return true
}

function jumpTarget(tokens) {
  const meaningful = meaningfulTokens(tokens)
  for (let index = 2; index < meaningful.length; index += 1) {
    if (meaningful[index] === "-j" || meaningful[index] === "--jump") {
      return meaningful[index + 1]
    }
  }
  return undefined
}

// The supported backend shape is Docker's exact `-A FORWARD -j DOCKER-USER`
// hook before anything that could accept bridge traffic. Earlier rules are
// ignored only when their input-interface match cannot include this bridge, or
// when they are an unconditional DROP. Unknown earlier jumps fail closed
// because this module cannot prove they do not accept. We never insert a
// replacement FORWARD hook; an unsupported backend must fail closed.
async function verifyForwardDispatch(ctx, bridge) {
  const result = await iptablesCall(ctx, ["-S", "FORWARD"])
  const stdout = Buffer.isBuffer(result?.stdout)
    ? result.stdout.toString("utf8")
    : String(result?.stdout ?? "")

  let found = false
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0) continue
    const tokens = tokenizeRule(line)
    if (tokens[0] !== "-A" || tokens[1] !== "FORWARD") continue
    if (!forwardRuleCanMatchBridge(tokens, bridge)) continue

    if (tokens.length === 4 && tokens[2] === "-j" && tokens[3] === "DOCKER-USER") {
      found = true
      break
    }

    const target = jumpTarget(tokens)
    if (target === "DOCKER-USER") {
      fail(
        "forward-hook-unsupported",
        `unsupported DOCKER-USER hook form from the selected iptables backend: ${line}`,
      )
    }
    if (target === "DROP") continue
    fail(
      "forward-hook-bypass",
      `earlier FORWARD rule can bypass DOCKER-USER for this bridge: ${line}`,
    )
  }

  if (!found) {
    fail(
      "forward-hook-missing",
      "selected iptables backend does not expose the exact `-A FORWARD -j DOCKER-USER` dispatch; refusing to insert a replacement hook",
    )
  }
}

function parseInspect(stdout) {
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch {
    fail("inspect-json")
  }
  return parsed
}

async function installHostInputPolicy(ctx, state, policy) {
  await iptablesCall(ctx, ["-N", policy.hostChain])
  state.hostChainCreated = true

  for (const rule of policy.hostInputRules) {
    await iptablesCall(ctx, rule)
  }

  // Refuse to duplicate an existing jump that we do not own. A collision is
  // left untouched by rollback.
  if (await iptablesExists(ctx, ["-C", "INPUT", "-i", policy.bridge, "-j", policy.hostChain])) {
    fail("iptables-jump-collision")
  }

  await iptablesCall(ctx, policy.hostInputJump)
  state.hostJumpInstalled = true

  if (!(await iptablesExists(ctx, ["-C", "INPUT", "-i", policy.bridge, "-j", policy.hostChain]))) {
    fail("iptables-verification-failed")
  }
  for (const rule of policy.hostInputRules) {
    if (!(await iptablesExists(ctx, verificationArgs(policy.hostChain, rule)))) {
      fail("iptables-verification-failed")
    }
  }
}

async function installDockerUserPolicy(ctx, state, policy) {
  // DOCKER-USER must be provided by the Docker daemon. Do not create it: on an
  // unexpected nft backend, silently creating a general chain would produce an
  // unverified policy. Fail closed instead.
  if (!(await iptablesExists(ctx, ["-S", "DOCKER-USER"]))) fail("docker-user-missing")

  // Existing DOCKER-USER rules are irrelevant if the selected iptables backend
  // never dispatches bridge traffic into that chain.
  await verifyForwardDispatch(ctx, policy.bridge)

  await iptablesCall(ctx, ["-N", policy.dockerUserChain])
  state.dockerUserChainCreated = true

  if (
    await iptablesExists(ctx, [
      "-C",
      "DOCKER-USER",
      "-i",
      policy.bridge,
      "-j",
      policy.dockerUserChain,
    ])
  ) {
    fail("iptables-jump-collision")
  }

  await iptablesCall(ctx, policy.dockerUserJump)
  state.dockerUserJumpInstalled = true

  for (const rule of policy.dockerUserRules) {
    await iptablesCall(ctx, rule)
  }

  if (
    !(await iptablesExists(ctx, [
      "-C",
      "DOCKER-USER",
      "-i",
      policy.bridge,
      "-j",
      policy.dockerUserChain,
    ]))
  ) {
    fail("iptables-verification-failed")
  }
  for (const rule of policy.dockerUserRules) {
    if (!(await iptablesExists(ctx, verificationArgs(policy.dockerUserChain, rule)))) {
      fail("iptables-verification-failed")
    }
  }
}

export async function createIsolatedNetwork({ id, dockerConfig, run } = {}) {
  validateId(id)
  validateRun(run)
  const config = validateDockerConfig(dockerConfig)
  const policy = buildPolicy(id)

  const ctx = { run, dockerConfig: config }
  const state = {
    networkCreated: false,
    hostChainCreated: false,
    hostJumpInstalled: false,
    dockerUserChainCreated: false,
    dockerUserJumpInstalled: false,
  }

  async function cleanup() {
    const errors = []

    const record = (step, error, { retained = false, hint } = {}) => {
      const entry = { step, message: error instanceof Error ? error.message : String(error) }
      if (retained) entry.retained = true
      if (hint) entry.hint = hint
      errors.push(entry)
    }

    // Network removal must happen first. If the container is still attached or
    // removal otherwise fails, every firewall jump/chain/rule stays in place so
    // a surviving container remains contained.
    if (state.networkCreated) {
      try {
        await dockerCall(ctx, ["network", "rm", policy.name])
        state.networkCreated = false
      } catch (error) {
        if (isAbsent(error, "network")) {
          state.networkCreated = false
        } else {
          record("delete-network", error, {
            retained: true,
            hint: "Network still exists or its removal failed, so all firewall jumps, chains, and rules were retained. Stop/remove the container, then retry cleanup before removing the network.",
          })
          return { ok: false, errors, retained: true }
        }
      }
    }

    // The network is gone (or was already absent). Remove owned jumps before
    // touching any chain. A chain whose jump cannot be removed must keep its
    // protective contents.
    const removeJump = async (installedKey, parentChain, targetChain, label) => {
      if (!state[installedKey]) return true
      try {
        await iptablesCall(ctx, ["-D", parentChain, "-i", policy.bridge, "-j", targetChain])
        state[installedKey] = false
        return true
      } catch (error) {
        if (isAbsent(error, "rule")) {
          state[installedKey] = false
          return true
        }
        record(`delete-${label}-jump`, error, {
          retained: true,
          hint: `The ${label} jump could not be removed, so its chain and protective rules were retained. Retry cleanup after resolving iptables access.`,
        })
        return false
      }
    }

    const dockerUserJumpGone = await removeJump(
      "dockerUserJumpInstalled",
      "DOCKER-USER",
      policy.dockerUserChain,
      "docker-user",
    )
    const hostJumpGone = await removeJump(
      "hostJumpInstalled",
      "INPUT",
      policy.hostChain,
      "host-input",
    )

    const removeChain = async (createdKey, chain, label, jumpGone) => {
      if (!state[createdKey] || !jumpGone) return

      try {
        await iptablesCall(ctx, ["-F", chain])
      } catch (error) {
        if (isAbsent(error, "chain")) {
          state[createdKey] = false
          return
        }
        record(`flush-${label}`, error, {
          retained: true,
          hint: `The ${label} chain could not be flushed and was retained. Retry cleanup after resolving iptables access.`,
        })
        return
      }

      try {
        await iptablesCall(ctx, ["-X", chain])
        state[createdKey] = false
      } catch (error) {
        if (isAbsent(error, "chain")) {
          state[createdKey] = false
          return
        }
        record(`delete-${label}`, error, {
          retained: true,
          hint: `The ${label} chain could not be deleted and was retained. Retry cleanup after resolving iptables access.`,
        })
      }
    }

    await removeChain(
      "dockerUserChainCreated",
      policy.dockerUserChain,
      "docker-user-chain",
      dockerUserJumpGone,
    )
    await removeChain(
      "hostChainCreated",
      policy.hostChain,
      "host-input-chain",
      hostJumpGone,
    )

    const retained = errors.some((entry) => entry.retained === true)
    if (errors.length === 0) return { ok: true, errors: [] }
    return retained ? { ok: false, errors, retained: true } : { ok: false, errors }
  }

  try {
    const createArgs = [
      "network",
      "create",
      "--driver",
      "bridge",
      "--opt",
      `com.docker.network.bridge.name=${policy.bridge}`,
      "--ipv6=false",
      policy.name,
    ]
    await dockerCall(ctx, createArgs)
    state.networkCreated = true

    const inspected = await dockerCall(ctx, ["network", "inspect", policy.name])
    const network = assertNetworkIsolation({
      id,
      inspect: parseInspect(inspected?.stdout),
    })

    // Install host protection before any caller is allowed to start a
    // container. This module never starts containers itself.
    await installHostInputPolicy(ctx, state, policy)
    await installDockerUserPolicy(ctx, state, policy)

    return {
      name: policy.name,
      bridge: policy.bridge,
      dns: policy.dns,
      subnet: network.subnet,
      ipv6: {
        networkEnabled: network.ipv6.networkEnabled,
        sysctls: [...network.ipv6.sysctls],
      },
      cleanup,
    }
  } catch (error) {
    const rolledBack = await cleanup()
    if (!rolledBack.ok) {
      error.cleanupErrors = rolledBack.errors
      error.retainedContainment = rolledBack.retained === true
      // Give the caller a retry handle once the container is stopped/removed.
      error.cleanup = cleanup
      if (error.retainedContainment) {
        error.message = `${error.message}; retained containment: stop/remove the container, then retry cleanup before removing network resources`
      }
    }
    throw error
  }
}
