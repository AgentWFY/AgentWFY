# AgentWFY Mobile

Tauri v2 mobile shell for the remote-only AgentWFY client. No npm — all
tooling comes from the project's `vendor/` directory, populated by
`./scripts/setup` at the repo root.

The current implementation roadmap is tracked in
[`MOBILE_APP_PLAN.md`](../MOBILE_APP_PLAN.md).

## Prerequisites

- Xcode installed at `/Applications/Xcode.app`
- iOS simulator runtime installed in Xcode
- Rust installed through rustup, not only Homebrew
- Tauri mobile dependencies installed system-wide: `cocoapods`, `ios-deploy`,
  `xcodegen`

## First setup

```sh
./scripts/setup                    # installs tauri-cli to vendor/
./scripts/mobile-run ios init      # one-time iOS scaffolding (already done in this checkout)
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
```

## Run

```sh
./scripts/mobile-run ios dev                       # default sim
./scripts/mobile-run ios dev "iPhone 16 Pro"       # specific sim
./scripts/mobile-run dev                           # desktop window (non-mobile)
./scripts/mobile-run build                         # release build, no bundling
```

`mobile-run` rebuilds the mobile frontend through `scripts/build-mobile`
first (mobile only — fast), then invokes the vendored tauri CLI with
whatever args you pass.

For Android:

```sh
./scripts/mobile-run android init
./scripts/mobile-run android dev
./scripts/mobile-run android build
```

## Diagnostics

```sh
./scripts/mobile-doctor
```

Lists `rustc`, Xcode, and available iOS simulators. The `mobile-tauri`
wrapper (which `mobile-run` calls) forces
`PATH="$HOME/.cargo/bin:..."` and `DEVELOPER_DIR=/Applications/Xcode.app/...`
so Xcode picks rustup's toolchain over Homebrew's `rustc`.

## Common failure

If the build says it cannot find crate `core` for `aarch64-apple-ios-sim`,
Xcode is using the wrong Rust. Run `./scripts/mobile-doctor` and confirm
`rustc` resolves under `~/.cargo/bin`; if not, fix the shell PATH so
rustup is ahead of Homebrew.
