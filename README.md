Hole — P2P SSH over HyperDHT
============================

**Hole** is a small agent + CLI that gives you a P2P access layer for your machines over the Holepunch / HyperDHT stack — no open ports, no VPN, no accounts. It supports:

- Direct P2P tunnels over HyperDHT (no port forwarding).
- Optional relay mode for CGNAT / mobile hotspots.
- Named devices and multi-service forwards (SSH, RDP, HTTP, …).
- One-shot SSH, remote exec, and file copy (`hole ssh`, `hole exec`, `hole copy`).
- ACLs to restrict which client keys may connect.
- Audit log and reachability checks (`hole audit`, `hole ping`).
- A local web dashboard for fleet management and browser SSH (`hole dashboard`).
- Single, self-contained binaries for Linux, Windows, and macOS.

> All state lives in `~/.hole/` (keypair, devices, ACL).

## Network requirements

- **Direct mode (no relay)**:
  - Both **client** and **agent** must have **outbound TCP and UDP** to the internet.
  - No inbound ports or router port forwarding are required.
  - Works best when at least one side is on a “normal” home/office network (not behind very strict CGNAT or locked-down corporate egress).

- **Relay mode**:
  - You run `hole relay --host <public-ip> --port 49737` on a small VPS or server with:
    - A **public IPv4 address**.
    - Firewall/security group allowing **inbound UDP** on the relay port (default `49737`).
  - Both **client** and **agent** only need **outbound UDP** to `<relay-ip>:<port>`; they do **not** need any inbound ports.
  - The agent’s SSH daemon still only needs to listen on `127.0.0.1:22` (or another local port) — it is never exposed directly.

On cloud providers (GCP, AWS, etc.), make sure:

- The relay instance’s security group / firewall allows **UDP `<port>` from the internet** (or from the networks you care about).
- The `vpn`/backend instances you act as agents from allow **outbound UDP** to the relay host and port.

## Install

### From source (dev workflow)

```bash
git clone <this-repo> hole
cd hole
npm install
npm link        # installs `hole` on your PATH
```

Now you can run `hole` directly:

```bash
hole help
```

### Prebuilt binaries

You can either **download ready-made binaries from GitHub Releases** or build them yourself.

- Releases: see the “Releases” page on the GitHub repo (`Annatar3/Hole`) and grab the binary for your OS.
- Manual build:

  ```bash
  cd hole
  npm run build
  ls dist/
  # hole-linux-x64, hole-linux-arm64, hole-win-x64.exe, hole-macos-*, bundle.cjs
  ```

After you have a binary, copy it to the host and rename it to `hole` / `hole.exe`, then:

```bash
chmod +x hole
./hole help
```

## Quick start: Linux → Linux (no relay)

We’ll call the machine you’re sitting at **client** and the machine you want to reach **agent**.

### 1. On the agent host

Requirements:

- Linux with `sshd` listening on `127.0.0.1:22`.
- The `hole` binary placed somewhere on disk and marked executable.

Steps:

1. Open a shell on the agent host (however you normally do: console, SSH, cloud shell, etc.).
2. Run:

   ```bash
   ./hole agent --name my-remote
   ```

3. Note the printed key:

   ```text
   Key    : 9320641058af2f76abd1...
   ```

4. Leave this process running.

### 2. On the client host

Requirements:

- The `hole` binary installed or on your `PATH`.
- A way to SSH into the agent normally (so you know the username).

Steps:

1. Register the agent’s key under a friendly name (optionally with a default user/relay):

   ```bash
   # simplest
   hole add my-remote 9320641058af2f76abd1...

   # or with defaults
   hole add my-remote 9320641058af2f76abd1... \
     --user alice \
     --relay 203.0.113.10:49737 \
     --identity ~/.ssh/id_ed25519_my_remote
   ```

2. SSH in — one command, one terminal:

   ```bash
   hole ssh my-remote <agent-username>
   ```

   Hole opens the P2P tunnel and drops you straight into an SSH session. When you exit, the tunnel closes automatically.

If you’re logged in to the agent host, the P2P tunnel over HyperDHT is working with **no port forwarding**.

## Relay mode (for CGNAT / mobile hotspot)

When one or both sides are behind strict NAT and direct hole punching fails, run a relay on a small VPS.

### 1. On the VPS

```bash
./hole relay         # uses UDP 49737 by default
```

### 2. On the remote host (agent)

```bash
./hole agent --name windows-pc --relay <vps-ip>:49737
```

### 3. On your client machine

```bash
hole add windows-pc <printed-key>
hole ssh windows-pc <user> --relay <vps-ip>:49737
```

Traffic flows: `client ↔ relay ↔ agent`, still end-to-end encrypted.

## Multiple services per host

You can forward multiple local services from the same host. Each service gets its own deterministic public key derived from the master agent key.

On the host:

```bash
./hole agent --name my-pc \
  --forward rdp:3389 \
  --forward web:127.0.0.1:3000
```

`hole list` will then show:

```text
NAME       KEY (16)          HOST     SERVICES
my-pc      62994c58c749d79d  debian   ssh, rdp, web
```

On the client:

```bash
# Default SSH (one command)
hole ssh my-pc user

# Open a proxy port for RDP (use hole client for non-SSH protocols)
hole client my-pc rdp
# then connect your RDP client to localhost:<printed-port>

# Open a proxy port for a web service
hole client my-pc web --port 8080
curl http://localhost:8080
```

## ACLs (who is allowed to connect)

By default, **any client** that knows a service key can connect.

To restrict it to specific client keys, use `hole acl` (works on the agent host; uses `~/.hole/acl.json`):

```bash
# On your laptop, get your client public key (example)
ssh-keygen -lf ~/.ssh/id_ed25519.pub

# On the agent host
hole acl add laptop <64-char-client-public-key>
hole acl list
```

Once the ACL has entries, only those client keys are accepted.

Remove entries:

```bash
hole acl remove laptop
```

Empty ACL = open mode (any client allowed).

## Install as a service

### Linux (systemd user service)

On the agent host:

```bash
hole install-service --name my-linux
systemctl --user status hole-agent
```

This creates and enables `~/.config/systemd/user/hole-agent.service`. The agent starts on login and restarts on failure.

Uninstall:

```bash
hole uninstall-service
```

### Windows (Task Scheduler)

Run (from PowerShell / CMD):

```powershell
hole.exe install-service --name windows-pc
```

This creates a “Hole Agent” scheduled task that runs on logon:

```powershell
hole.exe agent --name windows-pc
```

Remove it:

```powershell
hole.exe uninstall-service
```

## Diagnostics

Use `hole doctor` and `hole ping` to quickly verify your environment:

```bash
hole doctor
hole ping my-remote
```

It checks:

- Outbound TCP to port 443.
- Ability to bind a local UDP socket.
- HyperDHT bootstrap (DHT `ready()`).

If `doctor` is **OK** and `hole ping my-remote` shows the device as **UP** with reasonable latency, Hole should work; otherwise it prints hints (e.g. “try relay mode” if UDP/DHT is blocked).

## Web dashboard & fleet management

Hole ships with a local web dashboard that lets you manage fleet access without bouncing between multiple terminal sessions.

- **Run it:** start from the same machine where your `~/.hole` registry lives:

  ```bash
  hole dashboard
  # auto-opens http://localhost:4321/?token=<your-token>
  ```

  A secret token is generated once and stored in `~/.hole/dashboard-token`. The URL printed on start includes the token, and the browser is auto-opened with it. The token is required for all API calls, so the dashboard is only accessible to processes that know it.

- **Fleet view:** the left sidebar lists devices from `~/.hole/devices.json`, with search and tag filtering.
  - Click **+ Add device** to register a new device from the browser (no CLI needed).
  - Click **Remove** in any device's Details tab to delete it from the registry.

- **Details tab:** inspect and edit per-device registry settings:
  - default `user`, `relay`, `identity`
  - tags
  - service-key mappings (`ssh`, `web`, etc.)

- **Terminal tab:** open an interactive SSH session in-browser (xterm.js + node-pty), with optional SSH key override.

- **Tunnels tab:** open and stop local tunnels from the UI. Tunnels are persisted across dashboard restarts.
  - Quick presets for common ports/services (HTTP/SSH/RDP/MySQL/Postgres/Redis).
  - If a service key is missing, Hole can fall back to SSH local port forwarding for common services so you can still tunnel immediately.

- **Exec tab:** run a shell command on one or more devices simultaneously.
  - Scope: current device, all devices, or filter by tag.
  - Results are shown in-browser with per-device output and timing.

- **Files tab:** browse and transfer files over the same secure path. Operations timeout after 15 s.

- **ACL tab (per host):** manages `~/.hole/acl.json` on the selected remote host (not a global ACL on your laptop).

- **Audit tab:** view recent connection events and export to CSV.

The dashboard is a local control plane; transport remains HyperDHT-based and end-to-end encrypted.

## Commands overview

- `hole agent [--name <device>] [--relay host:port] [--port n] [--forward svc:port]`
- `hole ssh <device|key> [user] [--relay host:port] [-- extra-ssh-args]`
- `hole exec <device|key> <user> [--relay host:port] -- <command>`
- `hole copy <src> <dest> [user]` (remote paths use `device:/path`)
- `hole ping <device|key> [--count n] [--relay host:port]`
- `hole client <device|key> [service] [--port n] [--relay host:port]`
- `hole relay [--port n]`
- `hole dashboard`
- `hole install-service [--name <device>] [--relay host:port]`
- `hole uninstall-service`
- `hole list / add / remove / status`
- `hole audit [--tail n]`
- `hole acl list / add / remove`
- `hole doctor`
