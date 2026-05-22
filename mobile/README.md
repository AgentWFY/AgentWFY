# AgentWFY Mobile

Tauri v2 mobile shell for the future remote-only AgentWFY client. For now it runs an empty app and verifies that the iOS simulator path is working.

## Prerequisites

- Xcode installed at `/Applications/Xcode.app`
- iOS simulator runtime installed in Xcode
- Rust installed through rustup, not only Homebrew
- Tauri mobile dependencies installed (`cocoapods`, `ios-deploy`, `xcodegen`)
- Node dependencies installed with `npm install`

The repo scripts force the important iOS build environment:

- `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`
- `~/.cargo/bin` before Homebrew, so Xcode uses rustup's `rustc` and `cargo`

## First Setup

```sh
cd mobile
npm install
npm run ios:init
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
```

`ios:init` has already been run in this checkout, but keep it here for a fresh clone or regenerated mobile project.

## Run iOS Simulator

Run on the default simulator used during setup:

```sh
cd mobile
npm run ios:dev:sim
```

Run on a specific simulator:

```sh
cd mobile
npm run ios:dev -- "iPhone 16 Pro"
```

List available simulators:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun simctl list devices available
```

## Check The Environment

```sh
cd mobile
npm run ios:doctor
```

Expected signs:

- `rustc` resolves under `~/.cargo/bin`
- `rustc --print sysroot` points under `~/.rustup/toolchains`
- `xcodebuild -version` prints the full Xcode version
- the iOS simulator list includes the device you want to run

## Common Failure

If the build says it cannot find crate `core` for `aarch64-apple-ios-sim`, the build is using the wrong Rust toolchain. Use the npm scripts above instead of calling `tauri ios dev` directly, or make sure `~/.cargo/bin` is before `/opt/homebrew/bin`.

Fish shell is configured on this machine to set `DEVELOPER_DIR` and prefer rustup's Cargo/Rust, but the npm scripts also enforce it so the project is not shell-dependent.
