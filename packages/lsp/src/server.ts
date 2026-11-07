// The abfc language server: documents -> projects -> debounced checks -> published diagnostics.
import { dirname } from "node:path";
import { TextDocument } from "vscode-languageserver-textdocument";
import { ProposedFeatures, TextDocumentSyncKind, TextDocuments, createConnection } from "vscode-languageserver/node.js";
import { AbfcError, findProjectDir } from "@abfc/env";
import { ProjectState } from "./project.js";
import type { InitOptions } from "./project.js";
import { pathKey, uriToPath } from "./uri.js";

export interface ServerOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** Where log lines go (default: stderr). */
  log?: (line: string) => void;
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
      const created: ProjectState = new ProjectState(dir, (fileName) => {
        if (created.docs.size === 0) return undefined;
        const doc = created.docs.get(pathKey(fileName));
        return doc === undefined ? undefined : documents.get(doc.uri)?.getText();
      });
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

  connection.onInitialize((params) => {
    opts = { ...((params.initializationOptions ?? {}) as InitOptions) };
    return {
      capabilities: {
        textDocumentSync: { openClose: true, change: TextDocumentSyncKind.Incremental },
      },
      serverInfo: { name: "abfc", version: "0.1.0" },
    };
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
