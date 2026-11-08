// Entry point of abfc.exe (the CLI entry without top-level await, so esbuild can bundle it as CommonJS).
import { installSignalHandlers } from "@abfc/backend";
import { useTypeScriptLibDir } from "@abfc/compiler";
import { isExe, runtimeLayout } from "@abfc/env";
import { main } from "./main.js";

if (isExe()) {
  useTypeScriptLibDir(() => {
    const layout = runtimeLayout();
    if (layout === null) throw new Error("bundled runtime unavailable");
    return layout.tsLibDir;
  });
}
installSignalHandlers();
void main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
