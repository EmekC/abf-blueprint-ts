// The abfc VS Code extension (docs/design.md 18.7): starts `abfc lsp` and runs the abfc commands as tasks.
import { statSync } from "node:fs";
import * as vscode from "vscode";
import { LanguageClient, TransportKind } from "vscode-languageclient/node";
import { CONFIG_FILE_NAME, findAbfc, projectDirOf, type AbfcLaunch } from "./discover";

const INSTALL_DOCS = "https://github.com/EmekC/abf-blueprint-ts/blob/main/docs/install.md";

let client: LanguageClient | undefined;
let output: vscode.OutputChannel | undefined;

function isFile(p: string): boolean {
  try {
    return statSync(p, { throwIfNoEntry: false })?.isFile() === true;
  } catch {
    return false;
  }
}

function log(line: string): void {
  output?.appendLine(line);
}

/** Looks for abfc with the current settings; logs what was tried when nothing is found. */
function locate(): AbfcLaunch | null {
  const cfg = vscode.workspace.getConfiguration("abfc");
  const found = findAbfc({
    abfcPath: cfg.get<string>("path"),
    cliPath: cfg.get<string>("cliPath"),
    env: process.env,
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    platform: process.platform,
    isFile,
  });
  if (found.launch === null) {
    log("abfc was not found. Paths checked:");
    for (const t of found.tried) log(`  ${t}`);
  } else {
    log(`abfc found (${found.launch.source}): ${[found.launch.command, ...found.launch.args].join(" ")}`);
  }
  return found.launch;
}

function notFound(): void {
  void vscode.window.showErrorMessage("abfc was not found. Install abfc or set abfc.path.", "Open install docs").then((choice) => {
    if (choice === "Open install docs") void vscode.env.openExternal(vscode.Uri.parse(INSTALL_DOCS));
  });
}

async function start(): Promise<void> {
  const launch = locate();
  if (launch === null) {
    notFound();
    return;
  }
  const next = new LanguageClient(
    "abfc",
    "abfc",
    {
      command: launch.command,
      args: [...launch.args, "lsp"],
      transport: TransportKind.stdio,
      options: { env: process.env },
    },
    {
      documentSelector: [{ scheme: "file", language: "typescript" }],
      initializationOptions: { tsDiagnostics: false, tsHover: false },
      ...(output === undefined ? {} : { outputChannel: output }),
    },
  );
  client = next;
  try {
    await next.start();
  } catch (e) {
    client = undefined;
    const message = e instanceof Error ? e.message : String(e);
    log(`The abfc language server did not start: ${message}`);
    void vscode.window.showErrorMessage(`The abfc language server did not start: ${message}`);
  }
}

async function stop(): Promise<void> {
  const current = client;
  client = undefined;
  if (current === undefined) return;
  try {
    await current.stop();
  } catch (e) {
    log(`Stopping the abfc language server failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function restart(): Promise<void> {
  await stop();
  await start();
}

/** The project folder for a CLI task: the active file's project, else the only (or a chosen) project of the workspace. */
async function pickProjectDir(): Promise<string | null> {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active !== undefined && active.scheme === "file") {
    const dir = projectDirOf(active.fsPath, isFile, process.platform);
    if (dir !== null) return dir;
  }
  const configs = await vscode.workspace.findFiles(`**/${CONFIG_FILE_NAME}`, "**/node_modules/**", 20);
  const dirs = [...new Set(configs.map((u) => vscode.Uri.joinPath(u, "..").fsPath))];
  if (dirs.length === 0) {
    void vscode.window.showErrorMessage(`No ${CONFIG_FILE_NAME} was found in the workspace.`);
    return null;
  }
  if (dirs.length === 1) return dirs[0] ?? null;
  return (await vscode.window.showQuickPick(dirs, { placeHolder: "Choose the abfc project" })) ?? null;
}

async function runCliTask(args: string[]): Promise<void> {
  const projectDir = await pickProjectDir();
  if (projectDir === null) return;
  const launch = locate();
  if (launch === null) {
    notFound();
    return;
  }
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(projectDir));
  const task = new vscode.Task(
    { type: "abfc", command: args[0] },
    folder ?? vscode.TaskScope.Workspace,
    `abfc ${args.join(" ")}`,
    "abfc",
    new vscode.ProcessExecution(launch.command, [...launch.args, ...args], { cwd: projectDir }),
    "$abfc",
  );
  await vscode.tasks.executeTask(task);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel("abfc");
  context.subscriptions.push(output);

  const commands: [string, string[]][] = [
    ["abfc.build", ["build"]],
    ["abfc.test", ["test"]],
    ["abfc.publishDryRun", ["publish", "--dry-run"]],
    ["abfc.doctor", ["doctor"]],
  ];
  for (const [id, args] of commands) {
    context.subscriptions.push(vscode.commands.registerCommand(id, () => runCliTask(args)));
  }
  context.subscriptions.push(vscode.commands.registerCommand("abfc.restartServer", () => restart()));
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("abfc.path") || e.affectsConfiguration("abfc.cliPath")) void restart();
    }),
  );

  await start();
}

export async function deactivate(): Promise<void> {
  await stop();
}
