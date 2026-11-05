"""Minimal MCP stdio client: spawn a backend server.py, call one tool, write the result.

    python -I -X utf8 spike/mcp_call.py --server-dir <dir> --tool <name> (--args-json <file> | --args '<json>') --out <file>

Exit code 1 when the tool result has isError. Throwaway Phase 0 code.
A relative "spec_file" in the args is resolved against the repo root (the parent of spike/), so *.args.json files hold no machine paths.
"""

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--server-dir", required=True)
    ap.add_argument("--tool", required=True)
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--args-json")
    g.add_argument("--args")
    ap.add_argument("--out", required=True)
    ns = ap.parse_args()

    if ns.args_json:
        args = json.loads(Path(ns.args_json).read_text(encoding="utf-8"))
    elif ns.args:
        args = json.loads(ns.args)
    else:
        args = {}

    spec_file = args.get("spec_file")
    if isinstance(spec_file, str) and not Path(spec_file).is_absolute():
        args["spec_file"] = str((Path(__file__).resolve().parent.parent / spec_file).resolve())

    env = dict(os.environ)
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    server = Path(ns.server_dir) / "server.py"
    p = subprocess.Popen([sys.executable, "-I", "-X", "utf8", str(server)], env=env,
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr)
    state = {"id": 0}

    def send(msg):
        p.stdin.write((json.dumps(msg) + "\n").encode("utf-8"))
        p.stdin.flush()

    def request(method, params=None):
        state["id"] += 1
        msg = {"jsonrpc": "2.0", "id": state["id"], "method": method}
        if params is not None:
            msg["params"] = params
        send(msg)
        while True:
            line = p.stdout.readline()
            if not line:
                raise RuntimeError("server closed stdout")
            reply = json.loads(line)
            if reply.get("id") == state["id"]:
                break
        if "error" in reply:
            raise RuntimeError(reply["error"])
        return reply["result"]

    request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                           "clientInfo": {"name": "abfc-spike", "version": "0"}})
    send({"jsonrpc": "2.0", "method": "notifications/initialized"})
    t0 = time.time()
    res = request("tools/call", {"name": ns.tool, "arguments": args})
    wall = round(time.time() - t0, 2)
    p.stdin.close()
    try:
        p.wait(timeout=30)
    except subprocess.TimeoutExpired:
        p.kill()

    text = "\n".join(c.get("text", "<%s>" % c.get("type")) for c in res.get("content", []))
    out = {"tool": ns.tool, "args": args, "isError": bool(res.get("isError")), "wall_seconds": wall, "text": text}
    try:
        out["json"] = json.loads(text)
    except ValueError:
        pass
    Path(ns.out).parent.mkdir(parents=True, exist_ok=True)
    Path(ns.out).write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
    sys.exit(1 if out["isError"] else 0)


if __name__ == "__main__":
    main()
