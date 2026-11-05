export interface Resolved<T> {
  value: T | null;
  source: "flag" | "env" | "project" | "user" | "auto" | "none";
  tried: Array<{ source: string; detail: string }>;
}

export interface SettingSpec<T> {
  flag?: T | undefined;
  envNames: string[];
  project?: T | undefined;
  user?: T | undefined;
  auto: () => { value: T | null; tried: Resolved<T>["tried"] };
  /** Display names for the `tried` list. */
  labels?: { flag?: string; project?: string; user?: string };
}

/** Settings table of design 9.1: display names and env variables per setting. */
export const SETTING_INFO = {
  editorRoot: { flag: "--editor-root", env: ["ABFC_EDITOR_ROOT", "ABF_EDITOR_ROOT"], project: "editor.root" },
  modsDir: { flag: "--mods-dir", env: ["ABFC_MODS_DIR"], project: "modsDir" },
  modDir: { flag: "--mod-dir", env: ["ABFC_MOD_DIR"], project: "mod.dir" },
  backendDir: { flag: "--backend-dir", env: ["ABFC_BACKEND_DIR"], project: "backend.serverDir" },
  python: { flag: "--python", env: ["ABFC_PYTHON"], project: "backend.python" },
  headlessDir: { flag: "--headless-dir", env: ["ABF_HEADLESS_DIR"], project: "headlessDir" },
} as const;
export type SettingName = keyof typeof SETTING_INFO;

export const PROJECT_CONFIG_LABEL = "abf.config.json";
export const USER_CONFIG_LABEL = "%APPDATA%\\abfc\\config.json";

/** Precedence: flag > env > project > user > auto. Sources after the winner are not evaluated. */
export function resolveSetting<T>(spec: SettingSpec<T>, env: NodeJS.ProcessEnv): Resolved<T> {
  return resolveSettingValidated(spec, env, () => null);
}

/**
 * Like {@link resolveSetting}, but a candidate that `validate` rejects (it returns the reason) is recorded in
 * `tried` and the next source is consulted.
 */
export function resolveSettingValidated<T>(
  spec: SettingSpec<T>,
  env: NodeJS.ProcessEnv,
  validate: (value: T) => string | null,
): Resolved<T> {
  const tried: Resolved<T>["tried"] = [];
  const show = (v: T): string => (typeof v === "string" ? v : JSON.stringify(v));

  const flagLabel = spec.labels?.flag ?? "flag";
  if (spec.flag !== undefined && spec.flag !== null) {
    const bad = validate(spec.flag);
    if (bad === null) {
      tried.push({ source: flagLabel, detail: show(spec.flag) });
      return { value: spec.flag, source: "flag", tried };
    }
    tried.push({ source: flagLabel, detail: `${show(spec.flag)} (${bad})` });
  } else {
    tried.push({ source: flagLabel, detail: "not given" });
  }

  for (const name of spec.envNames) {
    const raw = env[name];
    if (raw !== undefined && raw !== "") {
      const bad = validate(raw as unknown as T);
      if (bad === null) {
        tried.push({ source: name, detail: raw });
        return { value: raw as unknown as T, source: "env", tried };
      }
      tried.push({ source: name, detail: `${raw} (${bad})` });
    } else {
      tried.push({ source: name, detail: "not set" });
    }
  }

  const projectLabel = spec.labels?.project ?? "value";
  if (spec.project !== undefined && spec.project !== null) {
    const bad = validate(spec.project);
    if (bad === null) {
      tried.push({ source: PROJECT_CONFIG_LABEL, detail: `${projectLabel} = ${show(spec.project)}` });
      return { value: spec.project, source: "project", tried };
    }
    tried.push({ source: PROJECT_CONFIG_LABEL, detail: `${projectLabel} = ${show(spec.project)} (${bad})` });
  } else {
    tried.push({ source: PROJECT_CONFIG_LABEL, detail: `${projectLabel} not set` });
  }

  const userLabel = spec.labels?.user ?? projectLabel;
  if (spec.user !== undefined && spec.user !== null) {
    const bad = validate(spec.user);
    if (bad === null) {
      tried.push({ source: USER_CONFIG_LABEL, detail: `${userLabel} = ${show(spec.user)}` });
      return { value: spec.user, source: "user", tried };
    }
    tried.push({ source: USER_CONFIG_LABEL, detail: `${userLabel} = ${show(spec.user)} (${bad})` });
  } else {
    tried.push({ source: USER_CONFIG_LABEL, detail: `${userLabel} not set` });
  }

  const auto = spec.auto();
  tried.push(...auto.tried);
  if (auto.value !== null && auto.value !== undefined) return { value: auto.value, source: "auto", tried };
  return { value: null, source: "none", tried };
}
