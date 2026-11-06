import { blockedMemberHits, loadProgram, readManifest } from "@abfc/compiler";
import type { CliContext } from "../context.js";
import { uploadFileDiagnostics, walkFolder } from "../gate/uploadcheck.js";
import { BackendSession, Recorder, compileFrontend, emitAll, lockDiagnostics, since } from "./common.js";
import { runBuild } from "./build.js";
import { runCheck } from "./check.js";
import { runTests } from "./test.js";

/** Files below the helper folders of the headless route are never part of a publish. */
const isHelperFile = (f: string): boolean => /(^|[\\/])(_McpTest|_McpTmp)([\\/]|$)/.test(f);

/** A file below `Content/` of the mod folder. */
const isContentFile = (f: string): boolean => /^Content[\\/]/i.test(f);

/** `Content/Relay/BP_Relay.uasset` -> `relay/bp_relay` (lower case, no extension, no `Content/`). */
const contentKey = (f: string): string =>
  f
    .replaceAll("\\", "/")
    .replace(/^Content\//i, "")
    .replace(/\.[^./]+$/, "")
    .toLowerCase();

/** The backend's reason of an audit that did not pass (first text field it reports, else a cut of its JSON). */
function auditReason(raw: unknown): string {
  if (raw !== null && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    for (const k of ["error", "reason", "message", "detail", "note"]) {
      const v = o[k];
      if (typeof v === "string" && v.trim() !== "") return v.trim();
    }
  }
  const s = JSON.stringify(raw) ?? "";
  return s.length > 300 ? `${s.slice(0, 300)}...` : s;
}

/**
 * `abfc publish [--dry-run]`: the publish gate. Seven gates in this order, stopping at the first failure (fail closed):
 * 1 stubs fingerprint, 2 check (and Blueprint-filter hits), 3 build, 4 tests, 5 mod_audit of the staged copy,
 * 6 upload file check, 7 the would-publish list. This command never calls `bp_publish` and copies nothing into the mod.
 * Each gate's time goes to `.abfc/runs.jsonl` as `gate.<n>`.
 */
export async function publish(ctx: CliContext): Promise<number> {
  const { output, config, args, env } = ctx;
  const mod = config.mod.name;
  const rec = new Recorder(ctx);
  const session = new BackendSession(ctx, rec);
  const fail = (): number => output.exitCode() || 1;
  try {
    // gate 1: stubs fingerprint
    let t = performance.now();
    const lockOk = !emitAll(ctx, lockDiagnostics(ctx, "build"));
    rec.record("gate.1", since(t), lockOk);
    if (!lockOk) return fail();

    // gate 2: check, then members the Blueprint filter blocks
    t = performance.now();
    let ok = await runCheck(ctx, rec);
    if (ok) {
      const hits = blockedMemberHits(loadProgram(ctx.projectDir));
      ok = !emitAll(ctx, hits);
    }
    rec.record("gate.2", since(t), ok);
    if (!ok) return fail();

    // gate 3: build (no compile errors, drift clean); reads every owned asset so editor edits to unchanged units fail it (ABFC5001)
    t = performance.now();
    ok = await runBuild(ctx, session, rec, { readAll: true });
    rec.record("gate.3", since(t), ok);
    if (!ok) return fail();

    // gate 4: tests
    t = performance.now();
    ok = await runTests(ctx, session, rec, undefined);
    rec.record("gate.4", since(t), ok);
    if (!ok) {
      if (output.exitCode() === 0) output.diag({ severity: "error", code: "ABFC6104", message: "one or more tests failed; not publishing." });
      return output.exitCode();
    }

    // gate 5: mod_audit (the backend audits the staged copy when it reports the stageAudit capability)
    t = performance.now();
    const { backend, info } = await session.open();
    const stageAudit = info.capabilities.stageAudit === true;
    if (!stageAudit) {
      output.diag({
        severity: "warning",
        code: "ABFC7003",
        message: "mod_audit audits the real mod, not the staged copy; the audit below does not cover the staged changes.",
        fix: "audit the mod in the editor after the changes are published by hand.",
      });
    }
    const report = await backend.audit(mod);
    const copy = (report.raw as { audited_copy?: unknown } | null)?.audited_copy;
    const wrongCopy = report.ok && stageAudit && copy !== undefined && copy !== "stage";
    const auditOk = report.ok && !wrongCopy;
    rec.record("gate.5", since(t), auditOk);
    if (!auditOk) {
      output.diag({
        severity: "error",
        code: "ABFC7002",
        message: wrongCopy
          ? `mod_audit audited the ${String(copy)} copy of ${mod}, not the staged copy.`
          : `mod_audit did not pass for ${mod}: ${auditReason(report.raw)}`,
        fix: "run mod_audit in the editor for the details.",
      });
      return fail();
    }

    // gate 6: upload file check on the real mod folder and the stage folder (read-only)
    t = performance.now();
    const stage = await backend.stageStatus(mod);
    const list = ctx.deps.listFiles ?? walkFolder;
    const folders: Array<[string, string]> = [];
    if (env.modDir.value !== null) folders.push(["mod", env.modDir.value]);
    if (stage !== null && stage.stagingPath !== "") folders.push(["stage", stage.stagingPath]);
    let uploadOk = true;
    for (const [label, dir] of folders) {
      if (emitAll(ctx, uploadFileDiagnostics(label, list(dir)))) uploadOk = false;
    }
    rec.record("gate.6", since(t), uploadOk);
    if (!uploadOk) return fail();

    // gate 7: the would-publish list, limited to assets that hold owned units or adoptions
    t = performance.now();
    const fe = compileFrontend(ctx);
    const owned = new Set<string>();
    for (const a of fe.ir?.assets ?? []) {
      if (a.units.length > 0 || a.classDefaults !== undefined || a.classManagerRow !== undefined) owned.add(a.path);
    }
    for (const a of fe.ir?.assets ?? []) {
      const m = readManifest(ctx.projectDir, a.path);
      if (m !== null && m.units.length > 0) owned.add(a.path);
    }
    const ownedKeys = new Set([...owned].map((p) => p.split("/").slice(2).join("/").toLowerCase()));
    const mine = (f: string): boolean => isContentFile(f) && !isHelperFile(f) && ownedKeys.has(contentKey(f));
    const changed = (stage?.changed ?? []).filter(mine);
    const added = (stage?.added ?? []).filter(mine);
    output.info("would publish:");
    for (const f of changed) output.info(`  changed ${f}`);
    for (const f of added) output.info(`  added   ${f}`);
    if (changed.length + added.length === 0) output.info("  (nothing)");
    output.json({ changed, added, dryRun: args.flags.dryRun });
    rec.record("gate.7", since(t));

    if (args.flags.dryRun) return output.exitCode();
    output.diag({
      severity: "error",
      code: "ABFC7001",
      message: "publishing is disabled; nothing was copied into the mod.",
      fix: "use abfc publish --dry-run to see what would be published.",
    });
    return output.exitCode();
  } finally {
    await session.close();
    rec.print();
  }
}
