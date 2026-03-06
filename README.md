Hole — P2P SSH over HyperDHT
============================

**Hole** is a small agent + CLI that gives you a P2P access layer for your machines over the Holepunch / HyperDHT stack — no open ports, no VPN, no accounts. It supports:

- Direct P2P tunnels over HyperDHT (no port forwarding).
- Optional relay mode for CGNAT / mobile hotspots.
- Named devices and multi-service forwards (SSH, RDP, HTTP, …).
- One-shot SSH, remote exec, and file copy (`hole ssh`, `hole exec`, `hole copy`).
- ACLs to restrict which client keys may connect.
- Audit log and reachability checks (`hole audit`, `hole ping`).
- Single, self-contained binaries for Linux, Windows, and macOS.

> All state lives in `~/.hole/` (keypair, devices, ACL).

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

Build all binaries:

```bash
cd hole
npm run build
ls dist/
# hole-linux-x64, hole-linux-arm64, hole-win-x64.exe, hole-macos-*, bundle.cjs
```

Copy the relevant binary to your host and rename it to `hole` / `hole.exe`, then:

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

1. Register the agent’s key under a friendly name:

   ```bash
   hole add my-remote 9320641058af2f76abd1...
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

## Commands overview

- `hole agent [--name <device>] [--relay host:port] [--port n] [--forward svc:port]`
- `hole ssh <device|key> [user] [--relay host:port] [-- extra-ssh-args]`
- `hole exec <device|key> <user> [--relay host:port] -- <command>`
- `hole copy <src> <dest> [user]` (remote paths use `device:/path`)
- `hole ping <device|key> [--count n] [--relay host:port]`
- `hole client <device|key> [service] [--port n] [--relay host:port]`
- `hole relay [--port n]`
- `hole install-service [--name <device>] [--relay host:port]`
- `hole uninstall-service`
- `hole list / add / remove / status`
- `hole audit [--tail n]`
- `hole acl list / add / remove`
- `hole doctor`
