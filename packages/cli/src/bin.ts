#!/usr/bin/env node
import { installSignalHandlers } from "@abfc/backend";
import { main } from "./main.js";
import { restoreTerminal } from "./progress.js";

installSignalHandlers({ onSignal: restoreTerminal });
process.once("exit", restoreTerminal);
process.exitCode = await main(process.argv.slice(2));
