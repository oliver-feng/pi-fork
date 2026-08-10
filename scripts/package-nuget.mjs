#!/usr/bin/env node

// Builds the workspace packages, stages an isolated production install of the
// coding agent, and packs it as a runnable .NET global tool NuGet package.
//
// The staged install is produced exactly the way scripts/local-release.mjs
// produces its isolated npm install: every workspace package is packed to a
// tarball and installed with file: overrides, so the payload contains this
// checkout's build rather than whatever the registry happens to serve.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const packages = [
	{ directory: "packages/telemetry", name: "@earendil-works/pi-telemetry" },
	{ directory: "packages/ai", name: "@earendil-works/pi-ai" },
	{ directory: "packages/tui", name: "@earendil-works/pi-tui" },
	{ directory: "packages/agent", name: "@earendil-works/pi-agent-core" },
	{ directory: "packages/protocol", name: "@earendil-works/pi-protocol" },
	{ directory: "packages/client", name: "@earendil-works/pi-client" },
	{ directory: "packages/session-backends/sqlite-node", name: "@earendil-works/pi-session-backend-sqlite-node" },
	{ directory: "packages/server", name: "@earendil-works/pi-server" },
	{ directory: "packages/coding-agent", name: "@earendil-works/pi-coding-agent" },
];

function printUsage() {
	console.log(`Usage: node scripts/package-nuget.mjs [options]

Builds the workspace, stages the coding agent payload under nuget/payload, and
runs dotnet pack to produce a runnable .NET global tool package.

Options:
  --skip-build    Reuse the existing dist output instead of rebuilding
  --skip-stage    Reuse the existing nuget/payload staging directory
  --skip-pack     Stage the payload but do not run dotnet pack
  --version <v>   Package version (defaults to PACKAGE_VERSION in this script)
  --out <dir>     Output directory for the .nupkg (default .artifacts/nuget)
  --help          Show this help
`);
}

function parseArgs() {
	const options = { out: undefined, skipBuild: false, skipPack: false, skipStage: false, version: undefined };
	const args = process.argv.slice(2);

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help") {
			printUsage();
			process.exit(0);
		} else if (arg === "--skip-build") {
			options.skipBuild = true;
		} else if (arg === "--skip-stage") {
			options.skipStage = true;
		} else if (arg === "--skip-pack") {
			options.skipPack = true;
		} else if (arg === "--version") {
			options.version = args[++i];
			if (!options.version) throw new Error("--version requires a value");
		} else if (arg === "--out") {
			options.out = args[++i];
			if (!options.out) throw new Error("--out requires a directory");
		} else {
			throw new Error(`Unknown option: ${arg}`);
		}
	}

	return options;
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		shell: process.platform === "win32",
		stdio: options.capture ? ["inherit", "pipe", "inherit"] : "inherit",
	});

	if (result.status !== 0) {
		throw new Error(`Command failed: ${[command, ...args].join(" ")}`);
	}

	return result.stdout ?? "";
}

function readPackageJson(directory) {
	return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

function fileSpecifier(fromDirectory, file) {
	const relativePath = relative(fromDirectory, file).replaceAll("\\", "/");
	return `file:${relativePath.startsWith(".") ? relativePath : `./${relativePath}`}`;
}

/**
 * Stamp the packaged version onto the staged agent so `pi-fork --version` reports it.
 *
 * config.ts derives VERSION by reading the agent's own package.json at runtime, which carries
 * upstream pi's number. Left alone, a package built as 0.84.1-beta.2 would still report 0.84.1,
 * so the running binary could not be told apart from any other build of the same upstream
 * release.
 *
 * Rewriting the staged copy rather than packages/coding-agent/package.json keeps this a
 * packaging concern: the checkout stays at upstream's version, so merges do not conflict over
 * it, and nothing but the artifact changes.
 */
function stampPayloadVersion(payloadDirectory, packageVersion) {
	const agentDirectory = join(payloadDirectory, "node_modules", "@earendil-works", "pi-coding-agent");
	const manifestPath = join(agentDirectory, "package.json");
	if (!existsSync(manifestPath)) {
		throw new Error(`Staged payload is missing the agent manifest: ${manifestPath}`);
	}

	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	manifest.version = packageVersion;
	writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, "\t")}\n`);
	console.log(`Stamped payload version ${packageVersion}`);
}

function packPackage(pkg, tarballDirectory) {
	const packageJson = readPackageJson(pkg.directory);
	if (packageJson.name !== pkg.name) {
		throw new Error(`${pkg.directory}/package.json has name ${packageJson.name}, expected ${pkg.name}`);
	}

	const output = run("npm", ["pack", "--json", "--pack-destination", tarballDirectory], {
		capture: true,
		cwd: pkg.directory,
	});
	// npm <11.6 returns an array; newer npm returns an object keyed by package name.
	const parsed = JSON.parse(output);
	const packed = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
	return join(tarballDirectory, packed.filename);
}

// Type declarations, source maps and the type-only dist-types trees are never
// loaded at runtime; dropping them roughly halves the payload. The workspace
// packages keep theirs so TypeScript extensions still typecheck against them.
function prunePayload(directory) {
	const typeOnlyDirectories = new Set(["dist-types"]);
	const droppedSuffixes = [".d.ts", ".d.mts", ".d.cts", ".map"];
	let files = 0;
	let bytes = 0;

	const walk = (current, insideWorkspacePackage) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const entryPath = join(current, entry.name);
			if (entry.isDirectory()) {
				const isWorkspaceScope = entry.name === "@earendil-works";
				if (!insideWorkspacePackage && typeOnlyDirectories.has(entry.name)) {
					const removed = measure(entryPath);
					files += removed.files;
					bytes += removed.bytes;
					rmSync(entryPath, { force: true, recursive: true });
					continue;
				}
				walk(entryPath, insideWorkspacePackage || isWorkspaceScope);
			} else if (!insideWorkspacePackage && droppedSuffixes.some((suffix) => entry.name.endsWith(suffix))) {
				bytes += statSync(entryPath).size;
				files++;
				rmSync(entryPath, { force: true });
			}
		}
	};

	const measure = (target) => {
		let measuredFiles = 0;
		let measuredBytes = 0;
		for (const entry of readdirSync(target, { recursive: true, withFileTypes: true })) {
			if (entry.isFile()) {
				measuredFiles++;
				measuredBytes += statSync(join(entry.parentPath, entry.name)).size;
			}
		}
		return { bytes: measuredBytes, files: measuredFiles };
	};

	walk(directory, false);
	console.log(`Pruned ${files} type-only files (${(bytes / 1024 / 1024).toFixed(1)} MB) from the payload`);
}

const options = parseArgs();
const repoRoot = process.cwd();

if (readPackageJson(repoRoot).name !== "pi-monorepo") {
	throw new Error("Run this script from the repository root");
}

// The published version of this fork. Bump the prerelease label here for each
// build that goes to the feed -- beta.1, beta.2, and so on.
//
// Deliberately not read from packages/coding-agent/package.json: that number is
// upstream pi's, so merging upstream would silently change what this package
// claims to be, and two builds of the same upstream version could not be told
// apart. The prerelease label needs its SemVer hyphen (0.84.1-beta.1, not
// 0.84.1.beta.1) -- NuGet requires a numeric fourth component, so the dotted
// form is rejected outright.
const PACKAGE_VERSION = "0.84.1-beta.2";

const version = options.version ?? PACKAGE_VERSION;
const projectDirectory = join(repoRoot, "nuget");
const payloadDirectory = join(projectDirectory, "payload");
const artifactDirectory = resolve(options.out ?? join(repoRoot, ".artifacts", "nuget"));
const tarballDirectory = join(artifactDirectory, "tarballs");

if (!options.skipBuild) {
	// build:offline keeps the model catalog as checked out instead of regenerating
	// it from the network, which is what release payloads want.
	run("npm", ["run", "build:offline"], { cwd: repoRoot });
}

if (!options.skipStage) {
	rmSync(payloadDirectory, { force: true, recursive: true });
	rmSync(tarballDirectory, { force: true, recursive: true });
	mkdirSync(tarballDirectory, { recursive: true });
	mkdirSync(payloadDirectory, { recursive: true });

	const tarballs = new Map();
	for (const pkg of packages) {
		tarballs.set(pkg.name, packPackage(pkg, tarballDirectory));
	}

	const dependencies = Object.fromEntries(
		packages.map((pkg) => [pkg.name, fileSpecifier(payloadDirectory, tarballs.get(pkg.name))]),
	);
	writeFileSync(
		join(payloadDirectory, "package.json"),
		`${JSON.stringify({ private: true, dependencies, overrides: dependencies }, undefined, "\t")}\n`,
	);

	run("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: payloadDirectory });

	// The lockfile and the file: tarball paths are meaningless once the payload is
	// packed into the nupkg, and package.json only exists to drive the install.
	rmSync(join(payloadDirectory, "package-lock.json"), { force: true });

	prunePayload(join(payloadDirectory, "node_modules"));
	stampPayloadVersion(payloadDirectory, version);
}

const entryPoint = join(payloadDirectory, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
if (!existsSync(entryPoint)) {
	throw new Error(`Staged payload is missing the CLI entry point: ${entryPoint}`);
}

if (!options.skipPack) {
	mkdirSync(artifactDirectory, { recursive: true });
	run("dotnet", [
		"pack",
		join(projectDirectory, "Pi.CodingAgent.Contained.csproj"),
		"--configuration",
		"Release",
		`-p:Version=${version}`,
		"--output",
		artifactDirectory,
	]);
	console.log(`\nPacked ${join(artifactDirectory, `Pi.CodingAgent.Contained.${version}.nupkg`)}`);
	console.log("\nInstall it with:");
	console.log(`  dotnet tool install -g Pi.CodingAgent.Contained --version ${version} --add-source ${artifactDirectory}`);
	console.log("  pi-fork --version");
} else {
	console.log(`\nStaged payload at ${payloadDirectory}`);
}
