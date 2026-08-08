# Pi.CodingAgent

A runnable NuGet packaging of the [pi](https://github.com/earendil-works/pi) coding agent CLI,
built as a .NET global tool so it can be published to an Azure Artifacts feed and installed
anywhere `dotnet` is available.

The package carries the agent's built JavaScript payload. Node.js is **not** bundled — the
launcher uses the Node.js runtime found on the host.

## Requirements

- .NET 8 runtime or newer (the launcher rolls forward to the newest installed major)
- Node.js 22.19 or newer on `PATH`, or `PI_NODE` pointing at a node executable

Supported hosts: `win-x64` and `linux-x64` (the launcher is platform-neutral managed code,
so other platforms with .NET and Node.js work too).

## Install

```sh
dotnet tool install -g Pi.CodingAgent --add-source <feed-or-directory>
pi-fork --version
```

From an Azure Artifacts feed:

```sh
dotnet tool install -g Pi.CodingAgent --add-source https://pkgs.dev.azure.com/<org>/_packaging/<feed>/nuget/v3/index.json
```

## Use

```sh
pi-fork --help
pi-fork                 # interactive TUI
```

The command is `pi-fork` so it can be installed alongside an upstream `pi` without
colliding. All arguments are forwarded verbatim to the agent, and its exit code is
propagated; note that the agent's own help text still calls itself `pi`.

## Build the package

From the repository root:

```sh
npm install
npm run hydrate:model-data
node scripts/package-nuget.mjs
```

This builds the workspace (`build:offline`), packs every workspace package to a tarball,
installs them into `nuget/payload` with `file:` overrides so the payload is this checkout's
build rather than whatever the registry serves, prunes type-only files, and runs `dotnet pack`.
The `.nupkg` lands in `.artifacts/nuget`.

Useful flags: `--skip-build`, `--skip-stage`, `--skip-pack`, `--version <v>`, `--out <dir>`.

## Troubleshooting

- `pi-fork: install Node.js 22.19 or newer...` — Node is missing from `PATH`. Install it, or set
  `PI_NODE=/path/to/node`.
- `pi-fork: packaged payload is missing` — the package was built without staging the payload; run
  `node scripts/package-nuget.mjs` again without `--skip-stage`.
