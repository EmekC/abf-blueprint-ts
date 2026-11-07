import { test } from "node:test";
import assert from "node:assert/strict";
import { AbfcError, checkNode, findBackendDir, findPython, layoutAt } from "../src/index.js";
import { fakeHost } from "./fakehost.js";

// abfc.exe: the bundled runtime is the only auto-discovered Python and backend (design 18.8).

const PY_VER = /print\('%d\.%d'/;
const layout = layoutAt("C:\\rt\\1.0.0-abcdef12", "1.0.0");
const isPathPython = (c: string): boolean => /^(py|python) /.test(c);

function exeHost(over: { env?: NodeJS.ProcessEnv; pythonVersion?: string | null; nodeVersion?: string; runtime?: boolean } = {}) {
  const host = fakeHost({
    env: over.env ?? {},
    files: { [layout.backendDir + "\\server.py"]: "# server", [layout.pythonExe]: "exe" },
    nodeVersion: over.nodeVersion ?? "v26.7.0",
    run: (cmd, args) => {
      if (cmd === layout.pythonExe && args.some((a) => PY_VER.test(a))) {
        return over.pythonVersion === null ? { status: 1 } : { status: 0, stdout: `${over.pythonVersion ?? "3.14"}\r\n` };
      }
      return { status: 0, stdout: "C:\\Py\\path\\python.exe\r\n" };
    },
  });
  host.isExe = true;
  host.bundledRuntime = () => (over.runtime === false ? null : layout);
  return host;
}

test("exe: python and backend folder resolve to the bundled runtime (source auto, tried label bundled runtime)", () => {
  const host = exeHost();
  const py = findPython(host);
  assert.deepEqual([py.value, py.source, py.version], [layout.pythonExe, "auto", "3.14"]);
  assert.deepEqual(py.tried.at(-1), { source: "bundled runtime", detail: layout.pythonExe });
  assert.equal(py.tried.filter((t) => t.source === "bundled runtime").length, 1);
  const be = findBackendDir(host);
  assert.deepEqual([be.value, be.source], [layout.backendDir, "auto"]);
  assert.deepEqual(be.tried.at(-1), { source: "bundled runtime", detail: layout.backendDir });
  assert.ok(host.calls.every((c) => !isPathPython(c)), host.calls.join("\n"));
});

test("exe: flags and env still win over the bundled runtime", () => {
  const host = exeHost({ env: { ABFC_PYTHON: "D:\\env\\python.exe", ABFC_BACKEND_DIR: "D:\\envmcp" } });
  host.files.set("d:\\envmcp\\server.py", "");
  host.files.set("d:\\flagmcp\\server.py", "");
  const base = host.run;
  const seen: string[] = [];
  host.run = (cmd, args) => {
    seen.push(cmd);
    return cmd === "D:\\env\\python.exe" || cmd === "D:\\flag\\python.exe" ? { status: 0, stdout: "3.12\r\n", stderr: "" } : base(cmd, args);
  };
  const envPy = findPython(host);
  assert.deepEqual([envPy.value, envPy.source], ["D:\\env\\python.exe", "env"]);
  assert.equal(findBackendDir(host).value, "D:\\envmcp");
  assert.equal(findPython(host, "D:\\flag\\python.exe").source, "flag");
  assert.equal(findBackendDir(host, "D:\\flagmcp").source, "flag");
  assert.ok(!seen.includes(layout.pythonExe), seen.join("\n"));
});

test("exe: an unusable bundled python or no runtime is ABFC1005 / ABFC1006, with no py or PATH fallback", () => {
  const broken = exeHost({ pythonVersion: null });
  assert.throws(
    () => findPython(broken),
    (e: unknown) =>
      e instanceof AbfcError && e.diagnostic.code === "ABFC1005" && e.diagnostic.tried!.some((t) => t.source === "bundled runtime" && /does not run/.test(t.detail)),
  );
  assert.ok(broken.calls.every((c) => !isPathPython(c)), broken.calls.join("\n"));
  const none = exeHost({ runtime: false });
  assert.throws(
    () => findPython(none),
    (e: unknown) => e instanceof AbfcError && e.diagnostic.code === "ABFC1005" && e.diagnostic.tried!.some((t) => t.detail === "not available"),
  );
  assert.throws(
    () => findBackendDir(none),
    (e: unknown) => e instanceof AbfcError && e.diagnostic.code === "ABFC1006" && e.diagnostic.tried!.some((t) => t.detail === "not available"),
  );
  assert.ok(none.calls.every((c) => !isPathPython(c)));
});

test("exe: no Node version warning; a source install on Node 26 still warns", () => {
  assert.equal(checkNode(exeHost({ nodeVersion: "v26.7.0" })), null);
  assert.equal(checkNode(fakeHost({ nodeVersion: "v26.7.0" }))?.code, "ABFC1030");
});
