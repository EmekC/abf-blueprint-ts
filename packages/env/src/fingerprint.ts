import { win32 } from "node:path";
import { sha256 } from "@abfc/ir";
import type { Profile } from "@abfc/ir";
import { envError } from "./errors.js";
import type { Host } from "./discover.js";

/** `sha256(size|mtime|appVersion)` of the editor exe. */
export function editorFingerprint(host: Host, editorRoot: string, profile: Profile, appVersion: string | null): string {
  const exe = win32.join(editorRoot, profile.exeRelPath);
  const st = host.stat(exe);
  if (!st) {
    throw envError(
      1001,
      `${profile.editorDisplayName} executable not found.`,
      [{ source: "editor exe", detail: exe }],
      "reinstall the Mod Editor or fix the editor root.",
    );
  }
  return sha256(`${st.size}|${Math.trunc(st.mtimeMs)}|${appVersion ?? ""}`);
}
