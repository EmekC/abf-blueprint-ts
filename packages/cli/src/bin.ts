#!/usr/bin/env node
import { installSignalHandlers } from "@abfc/backend";
import { main } from "./main.js";

installSignalHandlers();
process.exitCode = await main(process.argv.slice(2));
