#!/usr/bin/env bun
// The `wolfsdk-workspace` command line; the commands are in `run.ts`, and the two of a hosted deployment's control
// plane (`backup-registry` and `restore-host`) in `backup.ts`.
import { isHostCommand, runHostCli } from "./backup.ts";
import { runCli } from "./run.ts";

const argv = Bun.argv.slice(2);
process.exit(await (isHostCommand(argv[0]) ? runHostCli(argv) : runCli(argv)));
