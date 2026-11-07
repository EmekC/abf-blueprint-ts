// File contents written by `abfc init` (docs/design.md 18.5 item 8). Pure text, no file access.
import { DEFAULT_CLASS_MANAGER_TABLE, DEFAULT_SOURCE_ROOT } from "@abfc/ir";

/** `abf.config.json` of a new project (schema 2). */
export function projectConfigText(mod: string, scriptClasses: readonly string[]): string {
  const config = {
    schemaVersion: 2,
    mod: { name: mod },
    sourceRoot: DEFAULT_SOURCE_ROOT,
    classManager: { table: DEFAULT_CLASS_MANAGER_TABLE },
    stubs: {
      classes: [] as string[],
      scriptClasses: [...scriptClasses],
      modAssets: "all",
      widgetMembers: {},
    },
    backend: { kind: "bp_apply", minProtocol: 1 },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** `tsconfig.json` of a new project: the strict options of design 4.2, no plugins. */
export const TSCONFIG_TEXT = `${JSON.stringify(
  {
    extends: "./.abfc/tsconfig.paths.json",
    compilerOptions: {
      target: "es2023",
      lib: ["es2023"],
      module: "nodenext",
      moduleResolution: "nodenext",
      strict: true,
      strictNullChecks: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      noImplicitOverride: true,
      useDefineForClassFields: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    },
    include: [DEFAULT_SOURCE_ROOT],
  },
  null,
  2,
)}\n`;

/** Lines `.gitignore` must contain (design 2.1). */
export const GITIGNORE_LINES: readonly string[] = [
  ".abfc/stubs/",
  ".abfc/cache/",
  ".abfc/sourcemap/",
  ".abfc/sourcemaps/",
  ".abfc/reports/",
  ".abfc/runs.jsonl",
  ".abfc/tsconfig.paths.json",
  "node_modules/",
];

/** The line format of CLI diagnostics with a span (design 2.4). */
const PROBLEM_MATCHER = {
  owner: "abfc",
  fileLocation: ["relative", "${workspaceFolder}"],
  pattern: {
    regexp: "^(.*\\.ts):(\\d+):(\\d+): (error|warning) (ABFC\\d+): (.*)$",
    file: 1,
    line: 2,
    column: 3,
    severity: 4,
    code: 5,
    message: 6,
  },
};

/** `.vscode/tasks.json`: `abfc: check` (watch), `abfc: build` and `abfc: test`. */
export function tasksJsonText(): string {
  const task = (label: string, command: string): Record<string, unknown> => ({
    label,
    type: "shell",
    command,
    problemMatcher: PROBLEM_MATCHER,
  });
  const tasks = {
    version: "2.0.0",
    tasks: [task("abfc: check", "abfc check --watch"), task("abfc: build", "abfc build"), task("abfc: test", "abfc test")],
  };
  return `${JSON.stringify(tasks, null, 2)}\n`;
}

/** `.vscode/extensions.json`: recommends the abfc extension. */
export function extensionsJsonText(): string {
  return `${JSON.stringify({ recommendations: ["abfc.abfc-vscode"] }, null, 2)}\n`;
}

/** `<sourceRoot>/Samples/BP_HelloAbfc.ts`: an Actor with a counter and one event. */
export const SAMPLE_CLASS_TEXT = `import { blueprint, event } from "@abfc/runtime";
import type { int } from "@abfc/runtime";
import { Actor } from "/Script/Engine";

// The asset path comes from the folder: this class builds to /<your mod>/Samples/BP_HelloAbfc.
@blueprint()
export class BP_HelloAbfc extends Actor {
  Count!: int;

  /** Adds one to Count. */
  @event
  Bump(): void {
    this.Count = this.Count + 1;
  }
}
`;

/** `<sourceRoot>/Samples/BP_HelloAbfc.test.ts`: spawns the sample, bumps it twice and expects 2. */
export const SAMPLE_TEST_TEXT = `import { test } from "@abfc/testkit";
import { BP_HelloAbfc } from "./BP_HelloAbfc.js";

test("Bump adds one each time", (t) => {
  const hello = t.spawn(BP_HelloAbfc);
  hello.call("Bump");
  hello.call("Bump");
  t.expect(hello.get("Count")).equals(2);
});
`;
