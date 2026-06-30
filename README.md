# Hole — P2P service access over HyperDHT

**Zero port-forwarding. Zero VPN. Zero accounts.**

Hole connects machines over the [Holepunch / HyperDHT](https://holepunch.to) stack. Run one binary to announce SSH, RDP, HTTP, or any TCP service; connect from another machine by name without port-forwarding, VPN setup, or accounts.

```
hole ssh/tunnel ──[HyperDHT]── hole up
                    (or)
hole ssh/tunnel ──[relay]──── hole up
```

**Upgrading from 0.3.x (0.4+):** Prefer `hole up` / `hole tunnel` (`agent` / `client` remain as aliases). Re-run `hole install-service --name …` so your unit runs `hole up` instead of `hole agent`.

---

## What you get

| Feature | Description |
|---|---|
| `hole ssh` | One-command interactive SSH through the tunnel |
| `hole exec` | Run a command remotely, get output, exit |
| `hole copy` | `scp`-style file transfer over P2P |
| `hole tunnel` | Expose any TCP service (RDP, HTTP, DB…) locally |
| `hole share` | Send a file to anyone with a short one-time code — no pre-registration |
| `hole key` | Show this machine's Hole public key for pairing/ACL setup |
| `hole services` | Inspect registered service keys |
| `hole dashboard` | Browser fleet UI — terminals, tunnels, exec, files, ACLs |
| `hole relay` | Self-hosted relay for CGNAT / mobile networks |
| `hole invite` | Pair a device with a short one-time invite code |
| `hole up` | Announce this machine's services on HyperDHT |

State lives in `~/.hole/` — keypair, device registry, ACL, audit log.

---

## Install

### From source

```bash
git clone https://github.com/Annatar3/Hole && cd Hole
nvm use            # optional: uses .nvmrc (Node 22) for dev / packaging
npm install
npm link          # puts `hole` on your PATH
hole help
```

### Prebuilt binary

Grab the binary for your OS from the [Releases page](https://github.com/Annatar3/Hole/releases), then:

```bash
chmod +x hole
./hole help
```

To build your own binaries:

```bash
npm run build     # outputs to dist/
```

**Release builds** need **Node 22+** (matching GitHub Actions and `.nvmrc`). Older Node can still run the CLI from source; `npm install` runs a small **postinstall** script so `@yao-pkg/pkg` always resolves a CommonJS-compatible `into-stream` when packaging.

---

## Testing

Tests run entirely on the local machine / CI runner. They do not use GCP instances or external SSH hosts. E2E exercises the real `node hole.js` code path (HyperDHT + local relay). The **packaged Linux binary** is smoke-tested in the release workflow after `npm run build`; it is not part of the regular test suite.

```bash
npm run test:unit  # pure helpers: args, registry, identity
npm run test:cli   # CLI command smoke tests with isolated HOME
npm run test:e2e   # P2P stacks: invite, tunnel, share, --forward, hole exec/ssh/copy (needs OpenSSH ssh+scp in PATH)
npm test           # all of the above
```

E2E runs test files one at a time to avoid flakiness. Every spawned `hole` subprocess and the in-test relay are stopped when the test finishes. `hole exec`, `hole ssh`, and `hole copy` use OpenSSH against a tiny in-process SSH/SFTP server (`ssh2`), not your real `sshd`.

If your machine has no `ssh`/`scp` binaries, those SSH-related E2E cases are skipped automatically.

---

## Quick start

### Easiest pairing — invite code

On the machine you want to reach:

```bash
hole invite --name my-server
# Invite code: blue-river-cedar-4821
```

On your laptop:

```bash
hole accept blue-river-cedar-4821
hole ssh my-server
```

The invite is short-lived, one-shot, and stores the remote device key in
`~/.hole/devices.json`. If you are using a relay, pass the same relay on both
sides:

```bash
hole invite --name my-server --relay <vps-ip>:49737
hole accept blue-river-cedar-4821 --relay <vps-ip>:49737
```

### Send a file without any setup — hole share

No registered device, no SSH key, no prior pairing needed. Works between any two machines that can reach the same relay (or the public DHT).

On the sender:

```bash
hole share report.pdf
# Share code: amber-stone-cedar-7823
# Waiting for one receiver...
```

On the receiver:

```bash
hole receive amber-stone-cedar-7823
# → Saved to report.pdf
```

The code is one-shot: after one successful download the sender exits. The file is transferred directly over the encrypted HyperDHT tunnel — no size limit, no intermediary. Use `--relay` on both sides if either machine is behind strict NAT:

```bash
hole share report.pdf --relay <vps-ip>:49737
hole receive amber-stone-cedar-7823 --relay <vps-ip>:49737
```

Save to a specific path with `--out`:

```bash
hole receive amber-stone-cedar-7823 --out ~/Downloads/report.pdf
```

### Manual pairing — copy the key

### Step 1 — bring the remote machine online

```bash
./hole up --name my-server
# Key : 9320641058af2f76abd1...  ← copy this
```

Leave it running. Optionally [install it as a service](#run-as-a-service).

### Step 2 — register the key (on your laptop)

```bash
hole add my-server 9320641058af2f76abd1... \
  --user alice \
  --identity ~/.ssh/id_ed25519   # optional
```

### Step 3 — connect

```bash
hole ssh my-server
```

That's it. Hole opens the HyperDHT/Holepunch tunnel and drops you into an SSH session. The tunnel closes when you exit.

---

## Relay mode (CGNAT / mobile)

When direct hole-punching fails, run a relay on any VPS with a public IP:

```bash
# On the VPS — open UDP 49737 inbound in your firewall first
hole relay --host <vps-public-ipv4> --port 49737

# Remote machine — use the same relay while announcing
./hole up --name my-server --relay <vps-ip>:49737

# Laptop — store the same relay with the device
hole add my-server <key> --relay <vps-ip>:49737
hole ssh my-server
```

`hole add ... --relay` stores the relay in your registry, so later `hole ssh`,
`hole exec`, `hole copy`, `hole tunnel`, and `hole ping` can use it without
repeating `--relay`. You can also pass `--relay <host:port>` per command to
override the stored value.

For an always-on remote behind CGNAT, install the service with the relay baked in:

```bash
hole install-service --name my-server --relay <vps-ip>:49737
```

Traffic is still end-to-end encrypted; the relay only shuffles UDP packets.

---

## Multiple services per host

Each forwarded service gets its own key derived from the machine's master key:

```bash
# Remote machine
./hole up --name my-pc \
  --forward rdp:3389 \
  --forward web:127.0.0.1:3000

# Laptop — SSH works as before
hole ssh my-pc

# Open a local port for RDP
hole tunnel my-pc rdp
# → connect your RDP client to localhost:<printed-port>

# Open a local port for the web service
hole tunnel my-pc web --port 8080
```

If a forwarded service isn't running yet, `hole up` warns and skips it instead of aborting — the remaining services are still announced.

---

## Web dashboard

```bash
hole dashboard
# → http://localhost:4321/?token=<auto-generated-token>
```

The token is generated once and stored in `~/.hole/dashboard-token`. It's embedded in the URL printed on start, so just open that link.

**What the dashboard gives you:**

- **Fleet sidebar** — all registered devices, online/offline status, latency, search and tag filter
  - **+ Add device** — register a new device from the browser, no CLI needed
  - **Remove** button in the Details tab to delete a device
- **Details tab** — edit per-device `user`, `relay`, `identity`, tags, and service-key mappings
- **Terminal tab** — full interactive SSH session in the browser (xterm.js + node-pty)
- **Tunnels tab** — open / close local tunnel ports from the UI; tunnels survive dashboard restarts
- **Exec tab** — run a shell command on the current device, all devices, or a tag-filtered subset; results shown per-device with timing
- **Files tab** — browse and transfer files (15 s timeout per operation)
- **ACL tab** — manage `~/.hole/acl.json` on the remote host directly from the browser
- **Audit tab** — recent connection events, exportable to CSV

---

## ACLs

By default any client that knows a service key can connect. To restrict access:

```bash
# On the machine running `hole up`
hole acl add laptop <64-char-client-public-key>
hole acl list
hole acl remove laptop
```

An empty ACL means open mode — any key is accepted.

---

## Run as a service

### Linux (systemd user service)

```bash
# On the machine you want to keep online
hole install-service --name my-server
systemctl --user status hole-agent

# Remove
hole uninstall-service
```

Creates `~/.config/systemd/user/hole-agent.service`. It runs `hole up`, starts on login, and restarts on failure.

### Windows (Task Scheduler)

```powershell
hole.exe install-service --name my-server
# Remove
hole.exe uninstall-service
```

---

## Diagnostics

```bash
hole doctor              # config, local SSH target, outbound TCP/UDP, DHT bootstrap
hole doctor --relay <vps-ip>:49737  # validate a custom relay bootstrap path
hole key                 # this machine's Hole public key
hole services my-server  # registered service keys for one device
hole ping my-server      # latency + reachability with relay/NAT hints
hole audit --tail 20     # recent connection events
```

If `doctor` passes and `ping` returns a latency, everything is working. If `ping` shows the device as offline, read the printed hint first; strict NAT/CGNAT usually means adding `--relay <host>:<port>` to both sides.

---

## Commands

| Command | What it does |
|---|---|
| `hole up [--name N] [--relay host:port] [--forward svc:port]` | Announce this machine's services on HyperDHT |
| `hole ssh <device> [user] [-- extra-ssh-args]` | Open an interactive SSH session |
| `hole exec <device> <user> -- <cmd>` | Run a command, capture output, exit |
| `hole copy <src> <dest> [user]` | Copy files (`device:/path` for remote side) |
| `hole tunnel <device> [service] [--port N]` | Expose a TCP service locally |
| `hole relay --host <ip> [--port N]` | Run a relay server |
| `hole invite [--name N] [--relay R]` | Create a short-lived pairing invite |
| `hole accept <code> [--relay R]` | Accept an invite and register the device |
| `hole share <file> [--relay R] [--ttl N]` | Send a file via a short one-time code |
| `hole receive <code> [--out path] [--relay R]` | Receive a file from a `hole share` sender |
| `hole dashboard` | Start the web dashboard |
| `hole add <name> <key> [--user U] [--relay R] [--identity I]` | Register a device |
| `hole remove <name>` | Remove a device |
| `hole list` | List registered devices |
| `hole key [--raw]` | Show this machine's Hole public key |
| `hole services [device]` | Inspect registered service keys |
| `hole ping <device>` | Check reachability |
| `hole status <device>` | Detailed device status |
| `hole install-service [--name N]` | Install `hole up` as a system service |
| `hole uninstall-service` | Remove the system service |
| `hole acl list \| add \| remove` | Manage connection ACL on this machine |
| `hole audit [--tail N]` | View audit log |
| `hole doctor` | Environment health check |

Legacy `hole agent` and `hole client` commands still work as aliases for `hole up` and `hole tunnel`.
