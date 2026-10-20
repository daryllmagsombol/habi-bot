import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { assertNetworkIsolation, createIsolatedNetwork } from "./review-network.mjs"

const ID = "a1b2c3d4"
const SUBNET = "172.30.0.0/16"
const NAME = `habi-review-${ID}`
const BRIDGE = `hbrv${ID}`
const HOST_CHAIN = `HBRV-IN-${ID}`
const FORWARD_CHAIN = `HBRV-DU-${ID}`
const SPECIAL_USE = [
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

function tempConfig(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "habi-review-network-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function inspectFor(id = ID, overrides = {}) {
  return [
    {
      Name: `habi-review-${id}`,
      Driver: "bridge",
      EnableIPv6: false,
      Internal: false,
      Options: { "com.docker.network.bridge.name": `hbrv${id}` },
      IPAM: { Config: [{ Subnet: SUBNET, Gateway: "172.30.0.1" }] },
      ...overrides,
    },
  ]
}

function makeRunner({
  id = ID,
  inspect = inspectFor(id),
  dockerUser = true,
  networkExists = false,
  existingChains = [],
  forwardRules = ["-A FORWARD -j DOCKER-USER", "-A FORWARD -j DOCKER-FORWARD"],
  fail = null,
} = {}) {
  const calls = []
  const chains = new Map()
  for (const chain of ["INPUT", "FORWARD", "OUTPUT", ...(dockerUser ? ["DOCKER-USER"] : []), ...existingChains]) {
    chains.set(chain, [])
  }

  const state = {
    network: networkExists,
    inspect,
    fail,
    calls,
    chains,
    forwardRules,
  }

  const ensure = (name) => {
    if (!chains.has(name)) throw new Error(`mock: chain ${name} does not exist`)
    return chains.get(name)
  }

  const run = async (command, args) => {
    const call = { command, args: [...args] }
    calls.push(call)
    if (state.fail?.(call)) throw new Error(`mock failure: ${command} ${args.join(" ")}`)

    if (command === "docker") {
      if (args[0] !== "--config" || typeof args[1] !== "string") {
        throw new Error("mock: docker must use --config")
      }
      const rest = args.slice(2)
      if (rest[0] === "network" && rest[1] === "create") {
        if (state.network) throw new Error("mock: network exists")
        state.network = true
        return { stdout: "", stderr: "" }
      }
      if (rest[0] === "network" && rest[1] === "inspect") {
        if (!state.network) throw new Error("mock: network not found")
        return { stdout: JSON.stringify(state.inspect), stderr: "" }
      }
      if (rest[0] === "network" && rest[1] === "rm") {
        if (!state.network) throw new Error("mock: network not found")
        state.network = false
        return { stdout: "", stderr: "" }
      }
      throw new Error(`mock: unexpected docker args ${rest.join(" ")}`)
    }

    if (command === "sudo") {
      if (args[0] !== "-n" || args[1] !== "iptables" || args[2] !== "--wait" || args[3] !== "5") {
        throw new Error("mock: iptables must be sudo -n iptables --wait 5")
      }
      const op = args[4]
      const chain = args[5]
      if (op === "-S") {
        if (chain === "FORWARD") {
          ensure(chain)
          return {
            stdout: ["-P FORWARD DROP", ...state.forwardRules].join("\n"),
            stderr: "",
          }
        }
        ensure(chain)
        return { stdout: `-N ${chain}`, stderr: "" }
      }
      if (op === "-N") {
        if (chains.has(chain)) throw new Error("mock: chain exists")
        chains.set(chain, [])
        return { stdout: "", stderr: "" }
      }
      if (op === "-A") {
        ensure(chain).push(args.slice(6).join(" "))
        return { stdout: "", stderr: "" }
      }
      if (op === "-I") {
        const rules = ensure(chain)
        const position = Number(args[6])
        rules.splice(Math.max(0, position - 1), 0, args.slice(7).join(" "))
        return { stdout: "", stderr: "" }
      }
      if (op === "-C") {
        if (!ensure(chain).includes(args.slice(6).join(" "))) {
          throw new Error("mock: rule not found")
        }
        return { stdout: "", stderr: "" }
      }
      if (op === "-D") {
        const rules = ensure(chain)
        const index = rules.indexOf(args.slice(6).join(" "))
        if (index < 0) throw new Error("mock: rule not found")
        rules.splice(index, 1)
        return { stdout: "", stderr: "" }
      }
      if (op === "-F") {
        ensure(chain).length = 0
        return { stdout: "", stderr: "" }
      }
      if (op === "-X") {
        const rules = ensure(chain)
        if (rules.length > 0) throw new Error("mock: chain is not empty")
        for (const [other, otherRules] of chains) {
          if (other !== chain && otherRules.some((rule) => rule.endsWith(`-j ${chain}`))) {
            throw new Error("mock: chain is referenced")
          }
        }
        chains.delete(chain)
        return { stdout: "", stderr: "" }
      }
      throw new Error(`mock: unexpected iptables op ${op}`)
    }

    throw new Error(`mock: unexpected command ${command}`)
  }

  return { run, calls, chains, state }
}

function iptablesCalls(fake) {
  return fake.calls.filter((call) => call.command === "sudo")
}

function ruleText(rule) {
  return Array.isArray(rule) ? rule.join(" ") : String(rule)
}

function findCall(fake, command, predicate) {
  return fake.calls.find((call) => call.command === command && predicate(call.args))
}

test("creates a dedicated bridge network and installs the complete policy", async (t) => {
  const config = tempConfig(t)
  const fake = makeRunner()
  const result = await createIsolatedNetwork({ id: ID, dockerConfig: config, run: fake.run })

  assert.equal(result.name, NAME)
  assert.equal(result.bridge, BRIDGE)
  assert.equal(result.dns, "1.1.1.1")
  assert.equal(result.subnet, SUBNET)
  assert.equal(typeof result.cleanup, "function")
  assert.ok(result.bridge.length <= 15)
  assert.ok(HOST_CHAIN.length <= 28)
  assert.ok(FORWARD_CHAIN.length <= 28)

  const create = findCall(fake, "docker", (args) => args.includes("create"))
  assert.deepEqual(create.args, [
    "--config",
    config,
    "network",
    "create",
    "--driver",
    "bridge",
    "--opt",
    `com.docker.network.bridge.name=${BRIDGE}`,
    "--ipv6=false",
    NAME,
  ])
  assert.ok(!create.args.includes("--subnet"), "Docker must choose the subnet")

  for (const call of iptablesCalls(fake)) {
    assert.deepEqual(call.args.slice(0, 4), ["-n", "iptables", "--wait", "5"])
  }
  assert.deepEqual(fake.state.forwardRules, [
    "-A FORWARD -j DOCKER-USER",
    "-A FORWARD -j DOCKER-FORWARD",
  ])
  assert.ok(
    iptablesCalls(fake).some(
      (call) => call.args[4] === "-S" && call.args[5] === "FORWARD",
    ),
    "the selected backend's FORWARD dispatch must be verified",
  )
  for (const call of fake.calls.filter((entry) => entry.command === "docker")) {
    assert.equal(call.args[0], "--config")
    assert.equal(call.args[1], config)
    for (const forbidden of ["-v", "--volume", "--mount", "--env", "--privileged", "DOCKER_CONFIG"]) {
      assert.ok(!call.args.includes(forbidden), `docker command must not contain ${forbidden}`)
    }
    assert.ok(!call.args.some((arg) => arg.startsWith("HOME=")))
  }
  assert.deepEqual(fs.readdirSync(config), [])

  const cleaned = await result.cleanup()
  assert.deepEqual(cleaned, { ok: true, errors: [] })
  assert.equal(fake.state.network, false)
  assert.ok(!fake.chains.has(HOST_CHAIN))
  assert.ok(!fake.chains.has(FORWARD_CHAIN))
  assert.ok(fake.chains.has("DOCKER-USER"))
})

test("installs host protection before DOCKER-USER and never starts a container", async (t) => {
  const config = tempConfig(t)
  const fake = makeRunner()
  await createIsolatedNetwork({ id: ID, dockerConfig: config, run: fake.run })

  const networkCreate = fake.calls.findIndex(
    (call) => call.command === "docker" && call.args.includes("create"),
  )
  const hostJump = fake.calls.findIndex(
    (call) => call.command === "sudo" && call.args[4] === "-I" && call.args[5] === "INPUT",
  )
  const dockerUserCheck = fake.calls.findIndex(
    (call) => call.command === "sudo" && call.args[4] === "-S" && call.args[5] === "DOCKER-USER",
  )
  const dockerUserJump = fake.calls.findIndex(
    (call) => call.command === "sudo" && call.args[4] === "-I" && call.args[5] === "DOCKER-USER",
  )

  assert.ok(networkCreate >= 0)
  assert.ok(hostJump > networkCreate)
  assert.ok(dockerUserCheck > hostJump)
  assert.ok(dockerUserJump > dockerUserCheck)

  for (const call of fake.calls) {
    assert.ok(!call.args.includes("container"), "module must not manage containers")
    if (call.command === "docker") assert.equal(call.args[2], "network")
    assert.ok(!call.args.includes("run"))
    assert.ok(!call.args.includes("start"))
    assert.ok(!call.args.includes("exec"))
  }

  // Every advertised policy rule is verified with -C before create returns.
  const checks = iptablesCalls(fake).filter((call) => call.args[4] === "-C")
  assert.ok(checks.some((call) => call.args[5] === "INPUT"))
  assert.ok(checks.some((call) => call.args[5] === "DOCKER-USER"))
  assert.ok(checks.some((call) => call.args[5] === HOST_CHAIN && call.args.includes("DROP")))
  assert.ok(checks.some((call) => call.args[5] === FORWARD_CHAIN && call.args.includes("443")))
})

test("denies special-use destinations in every state before allowing DNS and public HTTPS", async (t) => {
  const config = tempConfig(t)
  const fake = makeRunner()
  await createIsolatedNetwork({ id: ID, dockerConfig: config, run: fake.run })

  const rules = fake.chains.get(FORWARD_CHAIN)
  assert.ok(rules)

  const dropIndexes = SPECIAL_USE.map((cidr) => {
    const index = rules.findIndex((rule) => rule.startsWith(`-d ${cidr} `))
    assert.ok(index >= 0, `missing deny for ${cidr}`)
    assert.equal(ruleText(rules[index]).includes("--ctstate"), false, cidr)
    assert.match(rules[index], /-j DROP$/)
    return index
  })

  const dnsUdp = rules.findIndex((rule) => rule.includes("-p udp -d 1.1.1.1 --dport 53"))
  const dnsTcp = rules.findIndex((rule) => rule.includes("-p tcp -d 1.1.1.1 --dport 53"))
  const https = rules.findIndex((rule) => rule.includes("-p tcp --dport 443"))

  assert.ok(dnsUdp >= 0 && dnsTcp >= 0 && https >= 0)
  for (const index of [...dropIndexes, dnsUdp, dnsTcp, https]) {
    assert.ok(index < rules.length - 1)
  }
  for (const drop of dropIndexes) {
    assert.ok(drop < dnsUdp)
    assert.ok(drop < dnsTcp)
    assert.ok(drop < https)
  }
  assert.ok(Math.max(...dropIndexes) < dnsUdp)
  assert.equal(rules.at(-1), "-j DROP")

  for (const index of [dnsUdp, dnsTcp, https]) {
    assert.match(rules[index], /-m conntrack --ctstate NEW,ESTABLISHED -j ACCEPT$/)
  }
  // No broad RELATED/ctorigdstport allow and no general port allow.
  for (const rule of rules) {
    const text = ruleText(rule)
    assert.equal(text.includes("RELATED"), false, text)
    assert.equal(text.includes("--ctorigdstport"), false, text)
    assert.equal(text.includes("INVALID"), false, text)
    assert.equal(text.includes("UNTRACKED"), false, text)
    if (text.includes("--dport")) {
      assert.ok(text.includes("--dport 53") || text.includes("--dport 443"), text)
    }
  }
})

test("rejects unsafe network inspection results and rolls back the network", async (t) => {
  const cases = [
    ["ipv6", inspectFor(ID, { EnableIPv6: true }), "inspect-ipv6"],
    ["driver", inspectFor(ID, { Driver: "overlay" }), "inspect-driver"],
    ["ipam-empty", inspectFor(ID, { IPAM: { Config: [] } }), "inspect-ipam"],
    [
      "ipv6-subnet",
      inspectFor(ID, { IPAM: { Config: [{ Subnet: "fd00::/64" }] } }),
      "inspect-subnet",
    ],
    ["bridge-option", inspectFor(ID, { Options: {} }), "inspect-bridge-option"],
    [
      "extra-network",
      [...inspectFor(ID), { ...inspectFor(ID)[0], Name: "other" }],
      "inspect-network-count",
    ],
  ]

  for (const [label, inspect, code] of cases) {
    await t.test(label, async () => {
      const config = tempConfig(t)
      const fake = makeRunner({ inspect })
      await assert.rejects(
        createIsolatedNetwork({ id: ID, dockerConfig: config, run: fake.run }),
        (error) => error.code === code,
      )
      assert.equal(fake.state.network, false, "network must be removed")
      assert.ok(!fake.chains.has(HOST_CHAIN))
      assert.ok(!fake.chains.has(FORWARD_CHAIN))
      assert.ok(fake.chains.has("DOCKER-USER"))
    })
  }
})

test("rolls back owned state when iptables installation fails", async (t) => {
  const config = tempConfig(t)
  const fake = makeRunner({
    fail: (call) =>
      call.command === "sudo" && call.args[4] === "-I" && call.args[5] === "DOCKER-USER",
  })

  await assert.rejects(
    createIsolatedNetwork({ id: ID, dockerConfig: config, run: fake.run }),
    (error) => error.code === "iptables-command-failed",
  )

  assert.equal(fake.state.network, false)
  assert.ok(!fake.chains.has(HOST_CHAIN))
  assert.ok(!fake.chains.has(FORWARD_CHAIN))
  assert.ok(fake.chains.has("DOCKER-USER"))
  assert.ok(
    !iptablesCalls(fake).some(
      (call) => call.args[5] === "DOCKER-USER" && ["-F", "-X"].includes(call.args[4]),
    ),
  )
})

test("rolls back when the first sudo iptables call fails", async (t) => {
  const config = tempConfig(t)
  const fake = makeRunner({
    fail: (call) => call.command === "sudo" && call.args[4] === "-N" && call.args[5] === HOST_CHAIN,
  })
  await assert.rejects(
    createIsolatedNetwork({ id: ID, dockerConfig: config, run: fake.run }),
    (error) => error.code === "iptables-command-failed",
  )
  assert.equal(fake.state.network, false)
  assert.ok(!fake.chains.has(HOST_CHAIN))
  assert.ok(!fake.chains.has(FORWARD_CHAIN))
})

test("rejects malformed network inspect output and rolls back", async (t) => {
  const config = tempConfig(t)
  const fake = makeRunner()
  fake.state.inspect = "not-an-array"
  await assert.rejects(
    createIsolatedNetwork({ id: ID, dockerConfig: config, run: fake.run }),
    (error) => error.code === "inspect-network-count",
  )
  assert.equal(fake.state.network, false)
  assert.ok(!fake.chains.has(HOST_CHAIN))
})

test("fails closed when DOCKER-USER is absent", async (t) => {
  const config = tempConfig(t)
  const fake = makeRunner({ dockerUser: false })
  await assert.rejects(
    createIsolatedNetwork({ id: ID, dockerConfig: config, run: fake.run }),
    (error) => error.code === "docker-user-missing",
  )

  assert.ok(!iptablesCalls(fake).some((call) => call.args[4] === "-N" && call.args[5] === "DOCKER-USER"))
  assert.ok(!iptablesCalls(fake).some((call) => call.args[4] === "-I" && call.args[5] === "DOCKER-USER"))
  assert.ok(!fake.chains.has(HOST_CHAIN))
  assert.ok(!fake.chains.has(FORWARD_CHAIN))
  assert.equal(fake.state.network, false)
})

test("fails closed when FORWARD does not dispatch into DOCKER-USER", async (t) => {
  const cases = [
    ["missing-hook", [], "forward-hook-missing"],
    ["docker-forward-only", ["-A FORWARD -j DOCKER-FORWARD"], "forward-hook-bypass"],
    [
      "earlier-accept",
      ["-A FORWARD -j ACCEPT", "-A FORWARD -j DOCKER-USER"],
      "forward-hook-bypass",
    ],
    [
      "earlier-return",
      ["-A FORWARD -j RETURN", "-A FORWARD -j DOCKER-USER"],
      "forward-hook-bypass",
    ],
    [
      "earlier-unknown-jump",
      ["-A FORWARD -j HBRV-UNKNOWN", "-A FORWARD -j DOCKER-USER"],
      "forward-hook-bypass",
    ],
    [
      "earlier-prefix-accept",
      ["-A FORWARD -i hbr+ -j ACCEPT", "-A FORWARD -j DOCKER-USER"],
      "forward-hook-bypass",
    ],
    [
      "conditional-hook",
      [`-A FORWARD -i ${BRIDGE} -j DOCKER-USER`],
      "forward-hook-unsupported",
    ],
  ]

  for (const [label, forwardRules, code] of cases) {
    await t.test(label, async () => {
      const config = tempConfig(t)
      const fake = makeRunner({ forwardRules })
      await assert.rejects(
        createIsolatedNetwork({ id: ID, dockerConfig: config, run: fake.run }),
        (error) => error.code === code,
      )
      assert.equal(fake.state.network, false)
      assert.ok(!fake.chains.has(HOST_CHAIN))
      assert.ok(!fake.chains.has(FORWARD_CHAIN))
      assert.ok(
        !iptablesCalls(fake).some(
          (call) => call.args[4] === "-N" && call.args[5] === FORWARD_CHAIN,
        ),
      )
    })
  }
})

test("accepts unrelated or DROP-only FORWARD rules before the exact hook", async (t) => {
  const cases = [
    ["other-interface-accept", ["-A FORWARD -i eth0 -j ACCEPT", "-A FORWARD -j DOCKER-USER"]],
    ["other-interface-prefix-accept", ["-A FORWARD -i eth+ -j ACCEPT", "-A FORWARD -j DOCKER-USER"]],
    ["global-drop", ["-A FORWARD -j DROP", "-A FORWARD -j DOCKER-USER"]],
    [
      "commented-drop",
      [
        '-A FORWARD -m comment --comment "safe -j ACCEPT" -j DROP',
        "-A FORWARD -j DOCKER-USER",
      ],
    ],
  ]

  for (const [label, forwardRules] of cases) {
    await t.test(label, async () => {
      const config = tempConfig(t)
      const fake = makeRunner({ forwardRules })
      const result = await createIsolatedNetwork({ id: ID, dockerConfig: config, run: fake.run })
      assert.equal(result.name, NAME)
      assert.ok(fake.chains.has(FORWARD_CHAIN))
      await result.cleanup()
    })
  }
})

test("does not delete an unrelated chain on collision", async (t) => {
  await t.test("host chain collision", async () => {
    const config = tempConfig(t)
    const fake = makeRunner({ existingChains: [HOST_CHAIN] })
    await assert.rejects(
      createIsolatedNetwork({ id: ID, dockerConfig: config, run: fake.run }),
      (error) => error.code === "iptables-command-failed",
    )
    assert.ok(fake.chains.has(HOST_CHAIN))
    assert.ok(!iptablesCalls(fake).some((call) => call.args[4] === "-X" && call.args[5] === HOST_CHAIN))
    assert.equal(fake.state.network, false)
  })

  await t.test("forward chain collision after host policy", async () => {
    const config = tempConfig(t)
    const fake = makeRunner({ existingChains: [FORWARD_CHAIN] })
    await assert.rejects(
      createIsolatedNetwork({ id: ID, dockerConfig: config, run: fake.run }),
      (error) => error.code === "iptables-command-failed",
    )
    assert.ok(fake.chains.has(FORWARD_CHAIN))
    assert.ok(!iptablesCalls(fake).some((call) => call.args[4] === "-X" && call.args[5] === FORWARD_CHAIN))
    assert.ok(!fake.chains.has(HOST_CHAIN))
    assert.equal(fake.state.network, false)
  })
})

test("cleanup is idempotent, best-effort, and preserves unrelated resources", async (t) => {
  const config = tempConfig(t)
  const fake = makeRunner({ existingChains: ["HBRV-UNRELATED"] })
  const result = await createIsolatedNetwork({ id: ID, dockerConfig: config, run: fake.run })

  const callsAfterCreate = fake.calls.length
  const first = await result.cleanup()
  assert.deepEqual(first, { ok: true, errors: [] })
  assert.equal(fake.state.network, false)
  assert.ok(fake.chains.has("HBRV-UNRELATED"))
  assert.ok(fake.chains.has("DOCKER-USER"))
  assert.ok(
    !iptablesCalls(fake).some(
      (call) => call.args[5] === "HBRV-UNRELATED" && ["-F", "-X", "-D"].includes(call.args[4]),
    ),
  )

  const callsAfterFirstCleanup = fake.calls.length
  const second = await result.cleanup()
  assert.deepEqual(second, { ok: true, errors: [] })
  assert.equal(fake.calls.length, callsAfterFirstCleanup)
  assert.ok(callsAfterFirstCleanup > callsAfterCreate)
})

test("cleanup removes the network before touching firewall state", async (t) => {
  const config = tempConfig(t)
  const fake = makeRunner()
  const result = await createIsolatedNetwork({ id: ID, dockerConfig: config, run: fake.run })
  fake.calls.length = 0

  const cleaned = await result.cleanup()
  assert.deepEqual(cleaned, { ok: true, errors: [] })
  const rmIndex = fake.calls.findIndex(
    (call) => call.command === "docker" && call.args.includes("rm"),
  )
  const firstFirewall = fake.calls.findIndex((call) => call.command === "sudo")
  assert.ok(rmIndex >= 0)
  assert.ok(firstFirewall > rmIndex, "network removal must precede firewall removal")
})

test("active endpoint network failure retains all firewall rules until retry", async (t) => {
  const config = tempConfig(t)
  const fake = makeRunner()
  const result = await createIsolatedNetwork({ id: ID, dockerConfig: config, run: fake.run })

  const hostRulesBefore = [...fake.chains.get(HOST_CHAIN)]
  const forwardRulesBefore = [...fake.chains.get(FORWARD_CHAIN)]
  assert.ok(fake.chains.get("INPUT").includes(`-i ${BRIDGE} -j ${HOST_CHAIN}`))
  assert.ok(fake.chains.get("DOCKER-USER").includes(`-i ${BRIDGE} -j ${FORWARD_CHAIN}`))

  fake.state.fail = (call) =>
    call.command === "docker" && call.args.includes("rm") && call.args.includes(NAME)
  const partial = await result.cleanup()

  assert.equal(partial.ok, false)
  assert.equal(partial.retained, true)
  assert.equal(partial.errors.some((entry) => entry.step === "delete-network"), true)
  assert.equal(
    partial.errors.some((entry) => /stop\/remove the container/i.test(entry.hint ?? "")),
    true,
  )
  assert.equal(fake.state.network, true, "network must remain")
  assert.deepEqual(fake.chains.get(HOST_CHAIN), hostRulesBefore)
  assert.deepEqual(fake.chains.get(FORWARD_CHAIN), forwardRulesBefore)
  assert.ok(fake.chains.get("INPUT").includes(`-i ${BRIDGE} -j ${HOST_CHAIN}`))
  assert.ok(fake.chains.get("DOCKER-USER").includes(`-i ${BRIDGE} -j ${FORWARD_CHAIN}`))
  assert.ok(
    !iptablesCalls(fake).some((call) => ["-D", "-F", "-X"].includes(call.args[4])),
    "no firewall state may be removed while the network survives",
  )

  fake.state.fail = null
  const retried = await result.cleanup()
  assert.deepEqual(retried, { ok: true, errors: [] })
  assert.equal(fake.state.network, false)
  assert.ok(!fake.chains.has(HOST_CHAIN))
  assert.ok(!fake.chains.has(FORWARD_CHAIN))
  assert.ok(fake.chains.has("DOCKER-USER"))
})

test("create failure with retained containment exposes a retry cleanup", async (t) => {
  const config = tempConfig(t)
  let phase = "create"
  const fake = makeRunner({
    fail: (call) => {
      if (phase !== "create") return false
      if (call.command === "sudo" && call.args[4] === "-N" && call.args[5] === FORWARD_CHAIN) {
        return true
      }
      return call.command === "docker" && call.args.includes("rm")
    },
  })

  let failure
  try {
    await createIsolatedNetwork({ id: ID, dockerConfig: config, run: fake.run })
  } catch (error) {
    failure = error
  }

  assert.ok(failure)
  assert.equal(failure.code, "iptables-command-failed")
  assert.equal(failure.retainedContainment, true)
  assert.match(failure.message, /retained containment/i)
  assert.equal(typeof failure.cleanup, "function")
  assert.equal(fake.state.network, true)
  assert.ok(fake.chains.has(HOST_CHAIN))
  assert.ok(fake.chains.get("INPUT").includes(`-i ${BRIDGE} -j ${HOST_CHAIN}`))

  phase = "retry"
  const retried = await failure.cleanup()
  assert.deepEqual(retried, { ok: true, errors: [] })
  assert.equal(fake.state.network, false)
  assert.ok(!fake.chains.has(HOST_CHAIN))
})

test("cleanup treats a confirmed-absent network as success and removes firewall state", async (t) => {
  const config = tempConfig(t)
  const fake = makeRunner()
  const result = await createIsolatedNetwork({ id: ID, dockerConfig: config, run: fake.run })

  // Simulate the network having been removed outside this cleanup.
  fake.state.network = false
  const cleaned = await result.cleanup()

  assert.deepEqual(cleaned, { ok: true, errors: [] })
  assert.ok(!fake.chains.has(HOST_CHAIN))
  assert.ok(!fake.chains.has(FORWARD_CHAIN))
  assert.ok(fake.chains.has("DOCKER-USER"))
})

test("a failed jump deletion retains that chain's protective contents", async (t) => {
  const config = tempConfig(t)
  const fake = makeRunner()
  const result = await createIsolatedNetwork({ id: ID, dockerConfig: config, run: fake.run })

  const hostRulesBefore = [...fake.chains.get(HOST_CHAIN)]
  fake.state.fail = (call) =>
    call.command === "sudo" && call.args[4] === "-D" && call.args[5] === "INPUT"
  const partial = await result.cleanup()

  assert.equal(partial.ok, false)
  assert.equal(partial.retained, true)
  assert.equal(partial.errors.some((entry) => entry.step === "delete-host-input-jump"), true)
  assert.equal(fake.state.network, false, "network cleanup must run first and succeed")
  assert.ok(!fake.chains.has(FORWARD_CHAIN), "unaffected forward chain is removed")
  assert.ok(fake.chains.has(HOST_CHAIN), "host chain is retained")
  assert.deepEqual(fake.chains.get(HOST_CHAIN), hostRulesBefore)
  assert.ok(fake.chains.get("INPUT").includes(`-i ${BRIDGE} -j ${HOST_CHAIN}`))
  assert.ok(
    !iptablesCalls(fake).some((call) => call.args[4] === "-F" && call.args[5] === HOST_CHAIN),
    "a referenced host chain must not be flushed",
  )
  assert.ok(fake.chains.has("DOCKER-USER"))

  fake.state.fail = null
  const retried = await result.cleanup()
  assert.deepEqual(retried, { ok: true, errors: [] })
  assert.ok(!fake.chains.has(HOST_CHAIN))
})

test("validates id, docker config, and runner before issuing commands", async (t) => {
  const config = tempConfig(t)
  const fake = makeRunner()

  for (const id of ["", "A1B2C3D4", "a1b2c3d", "a1b2c3d4e", "zzzzzzzz", 123]) {
    await assert.rejects(
      createIsolatedNetwork({ id, dockerConfig: config, run: fake.run }),
      (error) => error.code === "invalid-id",
    )
  }

  await assert.rejects(
    createIsolatedNetwork({ id: ID, dockerConfig: "relative/config", run: fake.run }),
    (error) => error.code === "invalid-docker-config",
  )
  await assert.rejects(
    createIsolatedNetwork({ id: ID, dockerConfig: config, run: "not a function" }),
    (error) => error.code === "invalid-run",
  )

  const nonEmpty = tempConfig(t)
  fs.writeFileSync(path.join(nonEmpty, "config.json"), "{}\n")
  await assert.rejects(
    createIsolatedNetwork({ id: ID, dockerConfig: nonEmpty, run: fake.run }),
    (error) => error.code === "docker-config-not-empty",
  )

  assert.equal(fake.calls.length, 0, "no commands may run before validation succeeds")
})

test("assertNetworkIsolation returns the validated policy and DNS", () => {
  const policy = assertNetworkIsolation({ id: ID, inspect: inspectFor() })

  assert.equal(policy.name, NAME)
  assert.equal(policy.bridge, BRIDGE)
  assert.equal(policy.dns, "1.1.1.1")
  assert.equal(policy.subnet, SUBNET)
  assert.equal(policy.ipv6.networkEnabled, false)
  assert.deepEqual(policy.ipv6.sysctls, [
    "net.ipv6.conf.all.disable_ipv6=1",
    "net.ipv6.conf.default.disable_ipv6=1",
  ])
  assert.deepEqual(policy.policy.hostInputJump, ["-I", "INPUT", "1", "-i", BRIDGE, "-j", HOST_CHAIN])
  assert.deepEqual(policy.policy.dockerUserJump, [
    "-I",
    "DOCKER-USER",
    "1",
    "-i",
    BRIDGE,
    "-j",
    FORWARD_CHAIN,
  ])
  assert.deepEqual(policy.policy.dockerUserRules.at(-1).slice(-2), ["-j", "DROP"])
  assert.ok(policy.policy.dockerUserRules.some((rule) => rule.join(" ").includes("--dport 443")))
  assert.ok(policy.policy.dockerUserRules.some((rule) => rule.join(" ").includes("--dport 53")))
  for (const rule of policy.policy.dockerUserRules) {
    const text = ruleText(rule)
    assert.equal(text.includes("RELATED"), false, text)
    assert.equal(text.includes("--ctorigdstport"), false, text)
    if (text.includes("-d ") && text.endsWith("-j DROP") && !text.includes("--dport")) {
      assert.equal(text.includes("--ctstate"), false, text)
    }
    if (text.endsWith("-j ACCEPT")) {
      assert.match(text, /--ctstate NEW,ESTABLISHED/)
    }
  }
  assert.deepEqual(policy.policy.verification.hostInputJump, [
    "-C",
    "INPUT",
    "-i",
    BRIDGE,
    "-j",
    HOST_CHAIN,
  ])
  assert.deepEqual(policy.policy.verification.dockerUserJump, [
    "-C",
    "DOCKER-USER",
    "-i",
    BRIDGE,
    "-j",
    FORWARD_CHAIN,
  ])
  assert.equal(
    policy.policy.verification.dockerUserRules.length,
    policy.policy.dockerUserRules.length,
  )
  assert.ok(policy.policy.hostInputChain.length <= 28)
  assert.ok(policy.policy.dockerUserChain.length <= 28)

  assert.throws(
    () => assertNetworkIsolation({ id: ID, inspect: inspectFor(ID, { EnableIPv6: true }) }),
    (error) => error.code === "inspect-ipv6",
  )
  assert.throws(
    () => assertNetworkIsolation({ id: ID, inspect: inspectFor(), subnet: "10.0.0.0/8" }),
    (error) => error.code === "inspect-subnet-mismatch",
  )
  assert.throws(
    () => assertNetworkIsolation({ id: "not-valid", inspect: inspectFor() }),
    (error) => error.code === "invalid-id",
  )
})

test("does not create a network when Docker create fails", async (t) => {
  const config = tempConfig(t)
  const fake = makeRunner({ networkExists: true })
  await assert.rejects(
    createIsolatedNetwork({ id: ID, dockerConfig: config, run: fake.run }),
    (error) => error.code === "docker-command-failed",
  )
  assert.ok(!fake.calls.some((call) => call.command === "sudo"), "no iptables before a network exists")
  assert.ok(!fake.calls.some((call) => call.command === "docker" && call.args.includes("rm")))
})
