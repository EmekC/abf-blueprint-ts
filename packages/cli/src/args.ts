import { parseArgs } from "node:util";

export interface CliFlags {
  json: boolean;
  verbose: boolean;
  project: string | undefined;
  editorRoot: string | undefined;
  modsDir: string | undefined;
  modDir: string | undefined;
  backendDir: string | undefined;
  python: string | undefined;
  headlessDir: string | undefined;
  timings: boolean;
  resync: boolean;
  noBuild: boolean;
  yes: boolean;
  discardEditorChanges: boolean;
  dryRun: boolean;
  /** `--full`: `abfc publish` runs the release checks (tests, stage audit, upload file check) before the copy. */
  full: boolean;
  /** `--cold`: do not use the backend warm session (one editor start per operation). */
  cold: boolean;
  /** `--remove-node <name>` (repeatable): extra nodes `abfc adopt` removes with the unit. */
  removeNode: string[];
  /** `--watch`: `abfc check` stays running and checks again after every relevant file change. */
  watch: boolean;
}

export interface ParsedArgs {
  /** First positional, or null when none was given. */
  command: string | null;
  /** Positionals after the command. */
  positionals: string[];
  flags: CliFlags;
}

/** Thrown for a malformed command line (unknown option, missing value); `main` prints it and exits 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export function parseCliArgs(argv: string[]): ParsedArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: "boolean" },
        verbose: { type: "boolean" },
        project: { type: "string" },
        "editor-root": { type: "string" },
        "mods-dir": { type: "string" },
        "mod-dir": { type: "string" },
        "backend-dir": { type: "string" },
        python: { type: "string" },
        "headless-dir": { type: "string" },
        timings: { type: "boolean" },
        resync: { type: "boolean" },
        "no-build": { type: "boolean" },
        yes: { type: "boolean" },
        "discard-editor-changes": { type: "boolean" },
        "dry-run": { type: "boolean" },
        full: { type: "boolean" },
        cold: { type: "boolean" },
        "remove-node": { type: "string", multiple: true },
        watch: { type: "boolean" },
      },
    });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const v = parsed.values;
  const [command, ...positionals] = parsed.positionals;
  if (command === "check" && v.watch === true && v.json === true) throw new UsageError("--watch cannot be combined with --json");
  return {
    command: command ?? null,
    positionals,
    flags: {
      json: v.json === true,
      verbose: v.verbose === true,
      project: v.project,
      editorRoot: v["editor-root"],
      modsDir: v["mods-dir"],
      modDir: v["mod-dir"],
      backendDir: v["backend-dir"],
      python: v.python,
      headlessDir: v["headless-dir"],
      timings: v.timings === true,
      resync: v.resync === true,
      noBuild: v["no-build"] === true,
      yes: v.yes === true,
      discardEditorChanges: v["discard-editor-changes"] === true,
      dryRun: v["dry-run"] === true,
      full: v.full === true,
      cold: v.cold === true,
      removeNode: v["remove-node"] ?? [],
      watch: v.watch === true,
    },
  };
}
