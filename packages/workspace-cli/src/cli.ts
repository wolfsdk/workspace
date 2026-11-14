#!/usr/bin/env bun
// The `wolfsdk-workspace` command line; the commands are in `run.ts`.
import { runCli } from "./run.ts";

process.exit(await runCli(Bun.argv.slice(2)));
