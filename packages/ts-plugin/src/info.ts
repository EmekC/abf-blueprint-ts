// The part of tsserver's plugin `info` that the plugin uses (a structural subset of `ts.server.PluginCreateInfo`).
import type ts from "typescript";

export interface PluginInfo {
  languageService: ts.LanguageService;
  languageServiceHost: ts.LanguageServiceHost;
  project: {
    getCurrentDirectory(): string;
    projectService: { logger: { info(text: string): void } };
    refreshDiagnostics?(): void;
    /** Makes tsserver rebuild the program (it skips this while `getProjectVersion()` is unchanged). */
    markAsDirty?(): void;
  };
  config?: unknown;
}
