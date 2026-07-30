#!/usr/bin/env node
import { dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentsUiServices } from "./cli/services.ts";
import { runCli } from "./cli/run.ts";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const candidateRoot = resolve(moduleDirectory, "..");
const sourceRoot =
	basename(candidateRoot) === "dist" ? resolve(candidateRoot, "..") : candidateRoot;

const exitCode = await runCli(process.argv.slice(2), {
	services: createAgentsUiServices(),
	sourceRoot,
});
process.exitCode = exitCode;
