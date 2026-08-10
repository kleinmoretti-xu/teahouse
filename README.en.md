<div align="center">

<p><a href="README.md">简体中文</a> · <b>English</b></p>

<img src="build/icons/pantry-logo-icon.png" alt="Teahouse logo" width="120" height="120" />

<h1>茶话间 &nbsp;·&nbsp; Teahouse</h1>

<p><b>Chat and transfer files across a LAN, with no Internet connection or server</b></p>

<p>
  <a href="https://github.com/skyjt/teahouse/releases/latest">
    <img src="https://img.shields.io/github/v/release/skyjt/teahouse?style=flat-square&label=latest&color=3D8B6B&logo=github&logoColor=white" alt="Latest release" />
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-GPL--3.0--only-3D8B6B?style=flat-square" alt="GPL-3.0-only" />
  </a>
  <a href="https://github.com/skyjt/teahouse/releases">
    <img src="https://img.shields.io/badge/platform-Windows%207%2B%20%7C%20Linux%20%7C%20macOS-0366d6?style=flat-square" alt="Supported platforms" />
  </a>
  <img src="https://img.shields.io/badge/Electron-22-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron 22" />
</p>

<p>
  <a href="#why-teahouse">Why Teahouse</a>
  &nbsp;·&nbsp;
  <a href="#features">Features</a>
  &nbsp;·&nbsp;
  <a href="#platform-support">Platforms</a>
  &nbsp;·&nbsp;
  <a href="#installation">Installation</a>
  &nbsp;·&nbsp;
  <a href="#usage">Usage</a>
  &nbsp;·&nbsp;
  <a href="#how-it-works">How it works</a>
  &nbsp;·&nbsp;
  <a href="#security">Security</a>
  &nbsp;·&nbsp;
  <a href="#development">Development</a>
</p>

</div>

---

Start Teahouse on computers connected to the same local network and they discover each other automatically. Open a peer to chat or transfer files directly. No cloud account, central server, telemetry, or Internet access is involved. Teahouse is designed for corporate intranets, isolated networks, and laboratories where external connectivity is limited or prohibited.

## Why Teahouse

Moving a file or sending a short message inside an office network should be effortless. Existing tools often miss at least one requirement: they may be commercial, Windows-only, difficult for non-technical users, or dependent on an Internet service. Teahouse aims for a straightforward experience across Windows 7, domestic UOS deployments, Linux, and macOS.

## Features

- **Zero-configuration peer discovery** — UDP broadcast discovers peers on the same subnet. Peers connect directly and no server address is required.
- **Messaging** — Private chats and discussion groups support text, images, emoji, pasted screenshots, window nudges, delivery status, offline retry, recall, forwarding, and mentions. History remains on the local computer and can be exported or migrated.
- **Fast file transfer** — TCP peer-to-peer transfer uses available LAN bandwidth. Send files, multiple selections, or whole folders; drag items into a chat; resume interrupted downloads; and review transfer history.
- **Shared file cabinet** — Publish a local folder with per-peer read/write permissions, browse colleagues' cabinets, and download or upload through the third main-window tab.
- **LAN-only operation** — Runtime communication stays on the local network. The app contains no telemetry, cloud synchronization, CDN assets, or Internet update check.
- **Legacy and domestic platform coverage** — The same codebase supports Windows 7 SP1, Debian 10, UOS 20, modern Linux distributions, and macOS.

## Platform support

| Platform | Supported versions | Architectures | Packages | Hardware-tested coverage |
|---|---|---|---|---|
| Windows | Windows 7 SP1 through Windows 11 | x64 / ia32 | NSIS installer, portable executable | Windows 7 x64; ia32 build verified |
| UnionTech UOS | UOS 20 and later | x64 / arm64 | `.deb` | UOS 20 x64; arm64 build verified |
| macOS | macOS 12 Monterey and later | Apple Silicon | `.dmg`, `.zip` | macOS 26 |
| Debian / Ubuntu and related distributions | Debian 10 Buster and later | x64 / arm64 | `.deb`, AppImage | Build verified |

The hardware-tested column distinguishes an installation and messaging test on the named operating system from CI-only package validation.

Electron is pinned to **22.3.27**, the final major release supporting Windows 7. This compatibility baseline is permanent. See [Contributing](CONTRIBUTING.en.md#hard-constraints) before changing dependencies or runtime code.

## Installation

Download the package for your platform from [GitHub Releases](https://github.com/skyjt/teahouse/releases).

**Windows** — Choose the x64 or ia32 NSIS installer for your system, or use the matching portable executable. Windows 7 requires SP1. If a signed build is used on an unpatched Windows 7 installation, install KB4474419 first.

**Linux** — Use the `.deb` package on Debian, Ubuntu, UOS, and compatible distributions. For other distributions, mark the AppImage executable and run it:

```bash
chmod +x Teahouse-*.AppImage
./Teahouse-*.AppImage
```

**macOS** — Open the `.dmg` and drag Teahouse into Applications. An unsigned or unnotarized intranet build may require approval under System Settings → Privacy & Security. You can also remove the quarantine attribute:

```bash
xattr -dr com.apple.quarantine /Applications/Teahouse.app
```

## Usage

1. Start Teahouse on each device connected to the LAN. Peers on the same subnet appear automatically.
2. Select a peer to start a private chat, create a discussion group, or drag files into the conversation.
3. For routed subnets where UDP broadcast does not cross the boundary, add a peer IP or a CIDR scan range in Settings. Saved ranges are shared at a low rate among online Teahouse peers. The refresh button in the navigation rail scans all saved ranges after confirmation.
4. Allow the application through the operating-system firewall when prompted. The default UDP and TCP ports are `17878` and `17879`.

## How it works

Each client is an equal peer:

```text
Renderer process (UI) — peers, chats, file cabinet, transfers
   │  IPC exposed only through the context-isolated preload bridge
Main process
   ├─ Network: UDP discovery and heartbeat, UDP+ACK/TCP messages, TCP file transfer
   ├─ Storage: SQLite history, contacts, groups, transfers, and local settings
   └─ Desktop integration: tray, notifications, global shortcuts, and auto-start
```

| Channel | Transport | Default ports | Purpose |
|---|---|---|---|
| Discovery | UDP broadcast and unicast | 17878 | Entry, exit, heartbeat, and peer exchange |
| Messaging | UDP with ACK/retry; TCP fallback | 17878 / 17879 | Messages and control events |
| Files | Direct TCP | 17879 | Chunked files and folders with integrity checks |

The discovery sequence takes inspiration from IP Messenger, while Teahouse uses its own UTF-8 JSON protocol and does not claim wire compatibility.

## Security

- **Network boundary** — Runtime communication is limited to the LAN. Teahouse performs no telemetry, cloud request, or Internet update check.
- **Small renderer attack surface** — Renderer processes load local resources only. `contextIsolation` and Chromium sandboxing are enabled, `nodeIntegration` is disabled, navigation and new windows are denied, and a strict CSP is applied.
- **Untrusted inbound data** — Network messages use allowlist validation, length limits, rate limits, and resource budgets. Unknown message types are ignored for forward compatibility.
- **Safe file destinations** — Incoming names are sanitized, destination paths are constrained to an approved directory, and existing files are not overwritten.
- **Plaintext transport** — The protocol assumes a trusted LAN boundary and does not provide transport encryption. Use Teahouse only on networks where this trust model is acceptable.

## Development

- [Contributing](CONTRIBUTING.en.md) covers setup, builds, tests, hard constraints, and release packaging.
- [Development guide](DEVELOPMENT.en.md) explains architecture, data flow, and extension points.
- [Documentation index](docs/en/README.md) links the English requirements, protocol, UI, technical design, handoff, compatibility, and optimization documents.

Please report bugs and feature requests through [GitHub Issues](https://github.com/skyjt/teahouse/issues).

## Related projects

- [IP Messenger](https://ipmsg.org/) — the original LAN messaging protocol that inspired the discovery model.
- [iptux](https://github.com/iptux-src/iptux) — an open-source IP Messenger-compatible client for Linux.
- FeiQ and Neiwangtong — popular Windows LAN messengers used as product references.

## Third-party resources

Standard renderer controls use [Naive UI](https://github.com/tusen-ai/naive-ui) 2.43.2. Built-in avatar and emoji compatibility rendering uses a locally bundled subset of [Twemoji](https://github.com/jdecked/twemoji). See [Third-party notices](THIRD_PARTY_NOTICES.en.md).

## License

Copyright © 2026 skyjt.

Starting with version 0.37.0, Teahouse source code and binary distributions are licensed under the [GNU General Public License v3.0 only](LICENSE), SPDX identifier `GPL-3.0-only`. MIT rights granted for version 0.36.8 and earlier remain valid. Third-party components and artwork retain the licenses listed in [Third-party notices](THIRD_PARTY_NOTICES.en.md).
