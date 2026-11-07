// tsserver plugin entry (CommonJS: tsserver `require`s plugins). The service itself is an ES module loaded with a dynamic import.
import type ts from "typescript";
import type { PluginInfo } from "./info";

type ServiceModule = typeof import("./service.mjs");
type Service = NonNullable<ReturnType<ServiceModule["createService"]>>;

let loading: Promise<ServiceModule> | undefined;
const pending: Array<Promise<void>> = [];

function loadServiceModule(): Promise<ServiceModule> {
  loading ??= import("./service.mjs");
  return loading;
}

function init(modules: { typescript: typeof ts }): {
  create(info: PluginInfo): ts.LanguageService;
  getExternalFiles?(): string[];
} {
  const tsMod = modules.typescript;
  return {
    create(info: PluginInfo): ts.LanguageService {
      const base = info.languageService;
      const log = (text: string): void => info.project.projectService.logger.info(`[abfc] ${text}`);
      let service: Service | null = null;

      const load = loadServiceModule()
        .then((mod) => {
          service = mod.createService(tsMod, info);
          if (service !== null) {
            // the first program was probably built from unfiltered stubs: rebuild it, then re-send the diagnostics
            info.project.markAsDirty?.();
            info.project.refreshDiagnostics?.();
          }
        })
        .catch((e: unknown) => {
          log(`could not start the language service: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
        });
      pending.push(load);

      // every method of the real service, bound to it; the four below add to the result
      const proxy: Record<string, unknown> = {};
      for (const key of Object.keys(base) as Array<keyof ts.LanguageService>) {
        const member = base[key];
        proxy[key] = typeof member === "function" ? (member as (...a: unknown[]) => unknown).bind(base) : member;
      }
      const guarded = <T>(what: string, fallback: T, run: (s: Service) => T): T => {
        if (service === null) return fallback;
        try {
          return run(service);
        } catch (e) {
          log(`${what} failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
          return fallback;
        }
      };

      proxy.getSemanticDiagnostics = (fileName: string): ts.Diagnostic[] => {
        guarded("sync", undefined, (s) => s.sync());
        const own = base.getSemanticDiagnostics(fileName);
        return guarded("diagnostics", own, (s) => [...own, ...s.diagnostics(fileName)]);
      };
      proxy.getQuickInfoAtPosition = (...args: Parameters<ts.LanguageService["getQuickInfoAtPosition"]>): ts.QuickInfo | undefined => {
        guarded("sync", undefined, (s) => s.sync());
        const own = base.getQuickInfoAtPosition(...args);
        return guarded("hover", own, (s) => s.quickInfo(args[0], args[1], own));
      };
      proxy.getCodeFixesAtPosition = (...args: Parameters<ts.LanguageService["getCodeFixesAtPosition"]>): readonly ts.CodeFixAction[] => {
        const own = base.getCodeFixesAtPosition(...args);
        return guarded("code fixes", own, (s) => s.codeFixes(args[0], args[1], args[2], args[3], own));
      };
      proxy.getSupportedCodeFixes = (...args: Parameters<ts.LanguageService["getSupportedCodeFixes"]>): readonly string[] => {
        const own = base.getSupportedCodeFixes(...args);
        return guarded("supported code fixes", own, (s) => s.supportedCodeFixes(own));
      };
      return proxy as unknown as ts.LanguageService;
    },
  };
}

const plugin = Object.assign(init, {
  /** Resolves when the service module of every `create` so far has loaded (used by tests and scripts). */
  whenReady: (): Promise<void> => Promise.all(pending).then(() => undefined),
});

export = plugin;
