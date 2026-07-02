# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # install deps (also runs postinstall to fix into-stream for pkg)
npm link             # put `hole` on PATH for local dev

# Tests
npm run test:unit    # unit tests: args parser, registry, identity
npm run test:cli     # CLI smoke tests with isolated HOME dirs
npm run test:e2e     # E2E: tunnel, invite/accept, ssh/exec/copy flows (needs OpenSSH in PATH)
npm test             # all three suites in sequence

# Run a single test file
node --test test/unit/utils.test.js

# Build standalone binaries
npm run build        # outputs to dist/hole-{platform}-{arch}[.exe]
```

E2E tests skip SSH-related cases if `ssh`/`scp` are not in `PATH`. Each suite is run sequentially (not in parallel) to avoid flakiness.

## Architecture

**Entry point:** `hole.js` — monolithic CLI dispatcher. Parses args with the custom `parseArgs()` in `lib/utils.js` (no external deps), resolves `up`→`agent` and `tunnel`→`client` aliases, then dynamically `import()`s the relevant `lib/*.js` module.

**Transport:** All tunnels go over [HyperDHT](https://holepunch.to). Both sides connect to DHT; the server side calls `dht.createServer()`, the client calls `dht.connect(serverPublicKey)`. When direct hole-punching fails (CGNAT), a relay node (`lib/relay.js`) runs `DHT.bootstrapper()` on a VPS and both sides pass `{ bootstrap: [relay] }` to their DHT constructors.

**Key data flow:**

- `hole up` (`lib/agent.js`): loads/creates `~/.hole/keypair` (96-byte Ed25519, HyperDHT format), creates one DHT server per service. The SSH forward always uses the master keypair; additional `--forward` services each get a derived keypair via `crypto.createHash('sha256').update(masterSecretKey).update(':serviceName').digest()` → `DHT.keyPair(seed)`. With `--proxy` it also announces a dynamic `proxy` service (derived key) whose connections carry a `{host,port}\n` JSON header the agent dials on demand; targets are guarded by `isPrivateAddress()` unless `--proxy-allow-lan`. HyperDHT self-heals on network change / sleep-wake, so the agent only logs those events rather than rebuilding.

- `hole tunnel/ssh/exec/copy` (`lib/client.js`): resolves device name → hex public key via `lib/registry.js`, then `openProxy()` starts a local TCP proxy on a free port that pipes each accepted connection through a DHT tunnel. `ssh`/`exec`/`copy` spawn the OS `ssh`/`scp` binary pointing at the local proxy port. `connectWithRetry()` retries transient DHT errors (`isRetryable()`) with exponential+jitter backoff (`backoffDelay()`).

- `hole proxy` (`lib/proxy.js`): runs a local SOCKS5 server (parser in `lib/socks5.js`, CONNECT-only). Each CONNECT opens a DHT tunnel to a peer running `hole up --proxy`, sends the `{host,port}\n` header, and splices the sockets once the agent confirms. Reuses `resolveTarget`/`connectWithRetry`/`findFreePort` from `client.js`.

- `hole invite/accept` (`lib/invite.js`): derives a temporary DHT keypair from the invite code string (via SHA-256). The inviting side listens on that keypair and sends a JSON payload; the accepting side connects, receives it, and calls `addDevice()`.

- `hole relay` (`lib/relay.js`): just `DHT.bootstrapper(port, host)` — a UDP relay/bootstrap node.

- `hole dashboard` (`lib/dashboard.js`): HTTP + WebSocket server (default :4321). Uses `openProxy()` from `client.js` for tunnels and `node-pty` (optional) for web SSH terminals. Tunnel state persists across restarts in `~/.hole/tunnels.json`.

**State storage** (`lib/registry.js`):
- `~/.hole/keypair` — 96-byte binary (32 public + 64 secret), mode 0600
- `~/.hole/devices.json` — device registry: `{ name: { key, host, relay, user, identity, tags, services, addedAt, lastSeen } }`
- `~/.hole/acl.json` — ACL: `{ name: hex-key }` map; empty = all clients allowed
- `~/.hole/audit.log` — JSONL of connect/close events
- `~/.hole/dashboard-token` — one-time auth token for dashboard
- `~/.hole/tunnels.json` — persisted tunnel state for dashboard

**Testing helpers** (`test/helpers.js`): `makeTempHome()` creates an isolated `~/.hole` per test process via `HOME=<tmpdir>`. `spawnHole()` / `runHoleAsync()` spawn `node hole.js` with that HOME. `waitForOutput()` polls stdout/stderr for a regex pattern. All long-lived processes (`hole up`, relay) are tracked and stopped in `after()` hooks via `stopProcess()` (SIGINT, then SIGKILL after 2.5s).

**Build pipeline** (`scripts/build.js`): esbuild bundles to `dist/bundle.cjs` (sodium-native and udx-native left as external native requires), then `@yao-pkg/pkg` wraps it into five platform binaries. Node 22 is required for packaging (`.nvmrc`); Node ≥18 works for running from source.
