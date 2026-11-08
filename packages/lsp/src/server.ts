// The abfc language server: documents -> projects -> debounced checks -> published diagnostics.
import { dirname } from "node:path";
import { TextDocument } from "vscode-languageserver-textdocument";
import { CodeActionKind, DidChangeWatchedFilesNotification, ProposedFeatures, TextDocumentSyncKind, TextDocuments, createConnection } from "vscode-languageserver/node.js";
import { AbfcError, findProjectDir } from "@abfc/env";
import { codeActionsFor } from "./actions.js";
import { GENERATE_STUBS_COMMAND, runGenerateStubs } from "./generate.js";
import type { CliLaunch, SpawnFn } from "./generate.js";
import { completionItemsAt } from "./completion.js";
import { compilerConfigOf } from "./environment.js";
import { hoverAt } from "./hover.js";
import { ProjectState } from "./project.js";
import type { InitOptions } from "./project.js";
import { isUnder, pathKey, uriToPath } from "./uri.js";

/** What the server asks the client to watch (when the client can register watchers). */
export const WATCHED_GLOBS = [
  "**/abf.config.json",
  "**/.abfc/manifest/*.json",
  "**/.abfc/stubs/**/stubs.lock.json",
  "**/.abfc/stubs/**/retired.json",
  "**/.abfc/stubs/**/*.d.ts",
  "**/.abfc/stubs/**/gameplay-tags.json",
  "**/.abfc/tags.d.ts",
  "**/.abfc/tsconfig.paths.json",
  "**/tsconfig*.json",
  "**/*.ts",
];

export interface ServerOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** Where log lines go (default: stderr). */
  log?: (line: string) => void;
  /**
   * How to start the abfc CLI. With it the server offers the "Generate stubs" quick fix and the `abfc.generateStubs` command
   * (the only thing that ever runs the Mod Editor from the language server); without it no fix is offered.
   */
  cliLaunch?: CliLaunch;
  /** Test hook: replaces `child_process.spawn` for the command. */
  spawnFn?: SpawnFn;
}

const DEFAULT_DEBOUNCE_MS = 300;

const describeError = (e: unknown): string => (e instanceof Error ? (e.stack ?? e.message) : String(e));

/**
 * Runs the server over `input`/`output` until the client sends `exit` (or the streams close).
 * Resolves with the exit code the protocol asks for (0 after `shutdown`, else 1).
 */
export function startServer(o: ServerOptions): Promise<number> {
  const log = o.log ?? ((line: string): void => void process.stderr.write(line + "\n"));
  if (o.output === process.stdout) {
    // stdout carries the protocol only; anything a library prints goes to the log.
    const toLog =
      (level: string) =>
      (...args: unknown[]): void =>
        log(`[${level}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`);
    console.log = toLog("log");
    console.info = toLog("info");
    console.debug = toLog("debug");
    console.warn = toLog("warn");
    console.error = toLog("error");
  }

  const connection = createConnection(ProposedFeatures.all, o.input, o.output);
  const documents = new TextDocuments(TextDocument);

  let opts: InitOptions = {};
  let shutdownReceived = false;
  const projects = new Map<string, ProjectState>();
  /** uri -> its project; null when the document lies outside every project. */
  const docProject = new Map<string, ProjectState | null>();
  const timers = new Map<ProjectState, NodeJS.Timeout>();

  const logError = (what: string, e: unknown): void => connection.console.error(`${what}: ${describeError(e)}`);

  const clearTimer = (project: ProjectState): void => {
    const t = timers.get(project);
    if (t !== undefined) clearTimeout(t);
    timers.delete(project);
  };

  /** Checks the project now and publishes the diagnostics of every open document and of the config. */
  const publishNow = (project: ProjectState): void => {
    clearTimer(project);
    if (projects.get(pathKey(project.dir)) !== project) return;
    try {
      for (const doc of project.docs.values()) {
        const version = documents.get(doc.uri)?.version;
        const diagnostics = project.fileDiagnostics(doc.path, opts);
        connection.sendDiagnostics(version !== undefined ? { uri: doc.uri, version, diagnostics } : { uri: doc.uri, diagnostics });
      }
      connection.sendDiagnostics({ uri: project.configUri, diagnostics: project.configDiagnostics() });
    } catch (e) {
      logError(`check of ${project.dir} failed`, e);
    }
  };

  const scheduleCheck = (project: ProjectState): void => {
    clearTimer(project);
    timers.set(
      project,
      setTimeout(() => publishNow(project), opts.debounceMs ?? DEFAULT_DEBOUNCE_MS),
    );
  };

  /** Brings a pending check forward so that results match the current text (hover and code actions use it). */
  const flush = (project: ProjectState): void => {
    if (timers.has(project)) publishNow(project);
  };

  const projectOf = (path: string): ProjectState | null => {
    let dir: string;
    try {
      dir = findProjectDir(dirname(path));
    } catch (e) {
      if (e instanceof AbfcError) return null;
      throw e;
    }
    const key = pathKey(dir);
    let project = projects.get(key);
    if (project === undefined) {
      const created: ProjectState = new ProjectState(
        dir,
        (fileName) => {
          if (created.docs.size === 0) return undefined;
          const doc = created.docs.get(pathKey(fileName));
          return doc === undefined ? undefined : documents.get(doc.uri)?.getText();
        },
        (message) => connection.console.error(message),
      );
      project = created;
      projects.set(key, project);
    }
    return project;
  };

  /** A document opened or changed: attach it to its project (once) and schedule a check. */
  const touch = (uri: string): void => {
    try {
      let project = docProject.get(uri);
      if (project === undefined) {
        const path = uriToPath(uri);
        project = path === null ? null : projectOf(path);
        docProject.set(uri, project);
        if (project !== null && path !== null) project.docs.set(pathKey(path), { uri, path });
      }
      if (project === null) return;
      project.markDirty();
      scheduleCheck(project);
    } catch (e) {
      logError(`document ${uri}`, e);
    }
  };

  const release = (uri: string): void => {
    const project = docProject.get(uri);
    docProject.delete(uri);
    if (project === undefined || project === null) return;
    const path = uriToPath(uri);
    if (path !== null) project.docs.delete(pathKey(path));
    void connection.sendDiagnostics({ uri, diagnostics: [] });
    if (project.docs.size === 0) {
      clearTimer(project);
      projects.delete(pathKey(project.dir));
      void connection.sendDiagnostics({ uri: project.configUri, diagnostics: [] });
    } else {
      project.markDirty();
      scheduleCheck(project);
    }
  };

  let canWatch = false;

  connection.onInitialize((params) => {
    opts = { ...((params.initializationOptions ?? {}) as InitOptions) };
    canWatch = params.capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration === true;
    return {
      capabilities: {
        textDocumentSync: { openClose: true, change: TextDocumentSyncKind.Incremental },
        hoverProvider: true,
        completionProvider: { resolveProvider: false },
        codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
        ...(o.cliLaunch !== undefined ? { executeCommandProvider: { commands: [GENERATE_STUBS_COMMAND] } } : {}),
      },
      serverInfo: { name: "abfc", version: "0.1.0" },
    };
  });

  connection.onInitialized(() => {
    if (!canWatch) return;
    connection.client
      .register(DidChangeWatchedFilesNotification.type, { watchers: WATCHED_GLOBS.map((globPattern) => ({ globPattern })) })
      .catch((e: unknown) => logError("registering file watchers", e));
  });

  // Something changed on disk (a build wrote manifests, the user edited a config or a stub): rebuild the affected projects.
  connection.onDidChangeWatchedFiles((params) => {
    try {
      for (const change of params.changes) {
        const path = uriToPath(change.uri);
        if (path === null) continue;
        const isConfig = /(^|[\\/])abf\.config\.json$/i.test(path);
        for (const project of projects.values()) {
          if (!isUnder(path, project.dir)) continue;
          project.markDirty(isConfig);
          scheduleCheck(project);
        }
      }
    } catch (e) {
      logError("file watcher notification", e);
    }
  });

  connection.onHover((params) => {
    try {
      const project = docProject.get(params.textDocument.uri);
      const path = uriToPath(params.textDocument.uri);
      if (project === undefined || project === null || path === null) return null;
      flush(project);
      const snap = project.snapshot();
      return snap === null ? null : hoverAt(project, snap, path, params.position, opts);
    } catch (e) {
      logError("hover", e);
      return null;
    }
  });

  connection.onCompletion((params) => {
    try {
      const project = docProject.get(params.textDocument.uri);
      const path = uriToPath(params.textDocument.uri);
      if (project === undefined || project === null || path === null) return [];
      flush(project);
      const snap = project.snapshot();
      if (snap === null) return [];
      const items = completionItemsAt(project, snap, path, params.position);
      // The compiler caps the library functions (100) and filters by the prefix on its side: the client must ask again as the word grows
      // instead of filtering the first answer, or everything after the cap would never show.
      return { isIncomplete: items.length > 0, items };
    } catch (e) {
      logError("completion", e);
      return [];
    }
  });

  connection.onCodeAction((params) => {
    try {
      const only = params.context.only;
      if (only !== undefined && !only.some((k) => k === CodeActionKind.QuickFix || k.startsWith(CodeActionKind.QuickFix + "."))) return [];
      const uri = params.textDocument.uri;
      const project = docProject.get(uri);
      const path = uriToPath(uri);
      if (project === undefined || project === null || path === null) return [];
      flush(project);
      const snap = project.snapshot();
      if (snap === null || project.env === null) return [];
      return codeActionsFor(project, snap, uri, path, params.range, compilerConfigOf(project.env.config), {
        canGenerate: o.cliLaunch !== undefined,
        projectDir: project.dir,
      });
    } catch (e) {
      logError("code action", e);
      return [];
    }
  });

  // The explicit "Generate stubs" command: the one place where the server starts the Mod Editor (through `abfc generate --add`).
  connection.onExecuteCommand(async (params) => {
    if (params.command !== GENERATE_STUBS_COMMAND) return null;
    const launch = o.cliLaunch;
    const arg = params.arguments?.[0] as { projectDir?: unknown; add?: unknown } | undefined;
    if (launch === undefined || arg === undefined || typeof arg.projectDir !== "string" || !Array.isArray(arg.add) || arg.add.length === 0 || !arg.add.every((a) => typeof a === "string" && a !== "")) {
      void connection.window.showErrorMessage("abfc: the generate stubs command needs a project folder and the names to generate");
      return { ok: false };
    }
    const projectDir = arg.projectDir;
    const add = arg.add as string[];
    const project = projects.get(pathKey(projectDir));
    if (project === undefined) {
      void connection.window.showErrorMessage(`abfc: ${projectDir} is not an open abfc project`);
      return { ok: false };
    }
    void connection.window.showInformationMessage(`abfc: generating stubs for ${add.join(", ")} (this starts the Mod Editor backend)`);
    let result: { ok: boolean; message: string };
    try {
      result = await runGenerateStubs(launch, project.dir, add, o.spawnFn);
    } catch (e) {
      result = { ok: false, message: `abfc: generating stubs failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (result.ok) void connection.window.showInformationMessage(result.message);
    else void connection.window.showErrorMessage(result.message.startsWith("abfc") ? result.message : `abfc: ${result.message}`);
    // The stubs (and their lock) changed on disk: rebuild the program and publish again.
    project.markDirty(true);
    scheduleCheck(project);
    return { ok: result.ok, message: result.message };
  });

  documents.onDidOpen((e) => touch(e.document.uri));
  documents.onDidChangeContent((e) => touch(e.document.uri));
  documents.onDidClose((e) => release(e.document.uri));

  const stopTimers = (): void => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  };

  connection.onShutdown(() => {
    shutdownReceived = true;
    stopTimers();
  });

  documents.listen(connection);
  connection.listen();

  return new Promise<number>((resolve) => {
    connection.onExit(() => {
      stopTimers();
      resolve(shutdownReceived ? 0 : 1);
    });
  });
}
