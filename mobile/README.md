# AgentWFY Mobile

Tauri v2 mobile shell for the remote-only AgentWFY client. No npm — all
tooling comes from the project's `vendor/` directory, populated by
`./scripts/setup` at the repo root.

## Prerequisites

- Xcode installed at `/Applications/Xcode.app`
- iOS simulator runtime installed in Xcode
- Rust installed through rustup, not only Homebrew
- Tauri mobile dependencies installed system-wide: `cocoapods`, `ios-deploy`,
  `xcodegen`

## First setup

```sh
./scripts/setup                        # from repo root; installs tauri-cli to vendor/
./mobile/scripts/run ios init          # one-time iOS scaffolding (already done in this checkout)
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
```

## Run

```sh
./mobile/scripts/run ios dev                       # default sim
./mobile/scripts/run ios dev "iPhone 16 Pro"       # specific sim
./mobile/scripts/run dev                           # desktop window (non-mobile)
./mobile/scripts/run build                         # release build, no bundling
```

`run` rebuilds the mobile frontend through the root `scripts/build` first,
then invokes the vendored tauri CLI with whatever args you pass.

For Android:

```sh
./mobile/scripts/run android init
./mobile/scripts/run android dev
./mobile/scripts/run android build
```

## Diagnostics

```sh
./mobile/scripts/doctor
```

Lists `rustc`, Xcode, and available iOS simulators. The `run` script forces
`PATH="$HOME/.cargo/bin:..."` and `DEVELOPER_DIR=/Applications/Xcode.app/...`
so Xcode picks rustup's toolchain over Homebrew's `rustc`.

## Common failure

If the build says it cannot find crate `core` for `aarch64-apple-ios-sim`,
Xcode is using the wrong Rust. Run `./mobile/scripts/doctor` and confirm
`rustc` resolves under `~/.cargo/bin`; if not, fix the shell PATH so
rustup is ahead of Homebrew.
