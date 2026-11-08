// Reflection JSON -> .d.ts stubs (design 5.1). Pure: no file or network access.
import type { Profile } from "@abfc/ir";
import { describeFunction, loadDescriptions } from "./describe.js";
import { classFilterTag, memberFilterTags } from "./filter.js";
import type { FilterRules } from "./filter.js";
import { FileBuilder, jsdoc } from "./imports.js";
import { emitManual, manualReferences, STUBGEN_VERSION } from "./manual.js";
import { widgetMember } from "./manual.js";
import type { ManualAsset } from "./manual.js";
import { IDENT_RE, UOBJECT_PATH, ident, memberKey, moduleSpecifier, stubFile, tsIdent } from "./names.js";
import { buildSignature } from "./signature.js";
import { SUPPLEMENTAL_PROPERTIES } from "./supplements.js";
import type { SigPin } from "./signature.js";
import type { ReflectClass, ReflectData, ReflectMember, ReflectPin } from "./types.js";
import { grammarOfPin, isUnsupported, refsOfGrammar, tsOfGrammar, unsupportedLabel } from "./typemap.js";
import type { TypeRef } from "./typemap.js";

export interface EmitInput {
  profile: Profile;
  reflect: ReflectData;
  filter: { rules: FilterRules; contentVersion: string | null };
  manual: ManualAsset[];
  /** `stubs.widgetMembers` of the config: class path -> { designer widget name -> widget class path }. */
  widgetMembers?: Record<string, Record<string, string>>;
  mod: string;
  /** Extra type paths to emit as opaque classes (referenced types that were not reflected are added automatically). */
  opaque: string[];
}

export interface StubIndex {
  files: string[];
  members: number;
  deprecated: string[];
  overridden: string[];
  missing: string[];
  opaque: string[];
}

const EMPTY_CLASS: ReflectClass = {
  meta: "/Script/CoreUObject.Class",
  ancestors: [],
  functions: [],
  properties: [],
  castPin: null,
};

const isExec = (p: ReflectPin): boolean => p.category === "exec";

/** Type paths mentioned by the members of the reflected classes and structs (not by the manual assets). */
export function reflectReferences(data: ReflectData): TypeRef[] {
  const refs: TypeRef[] = [];
  const addPin = (p: ReflectPin): void => void refs.push(...refsOfGrammar(grammarOfPin(p)));
  for (const c of Object.values(data.classes)) {
    for (const m of [...c.functions, ...c.properties]) for (const p of m.pins) if (!p.hidden) addPin(p);
  }
  for (const s of Object.values(data.structs)) for (const f of s.fields) if (!f.hidden) addPin(f);
  return refs;
}

/** Struct paths that pins mention but `data` has no fields for (drives the reflect closure). */
export function missingStructs(data: ReflectData, extra: TypeRef[] = []): string[] {
  const out = new Set<string>();
  for (const r of [...reflectReferences(data), ...extra]) {
    if (r.kind === "struct" && data.structs[r.path] === undefined) out.add(r.path);
  }
  return [...out].sort();
}

interface Item {
  path: string;
  render(fb: FileBuilder): string;
}

interface Counters {
  members: number;
  deprecated: string[];
  overridden: string[];
  missing: string[];
}

function pickProperty(m: ReflectMember): ReflectPin | undefined {
  return (
    m.pins.find((p) => p.dir === "out" && p.name === m.name) ??
    m.pins.find((p) => p.dir === "out" && !isExec(p) && p.name !== "self")
  );
}

function renderClass(
  path: string,
  c: ReflectClass,
  parentPath: string | null,
  input: EmitInput,
  counters: Counters,
  opaque: boolean,
  fb: FileBuilder,
): string {
  const { profile, filter } = input;
  const name = tsIdent(path);
  const tags = [`@bpPath ${path}`];
  if (c.meta) tags.push(`@bpMeta ${c.meta}`);
  if (c.castPin) tags.push(`@bpCastPin ${c.castPin}`);
  const cast = classFilterTag(profile, filter.rules, path);
  if (cast) tags.push(`@bpCastFilter ${cast}`);
  if (opaque) tags.push("@bpOpaque");

  const instance: string[] = [];
  const statics: string[] = [];
  const seen = new Set<string>();
  const descriptions = loadDescriptions();
  const callArrayShort = profile.nodeClasses.callArrayFunction.slice(profile.nodeClasses.callArrayFunction.lastIndexOf(".") + 1);

  for (const p of c.properties) {
    const pin = pickProperty(p);
    if (!pin || seen.has(`i:${p.name}`)) {
      counters.missing.push(`${path}:${p.name}`);
      continue;
    }
    seen.add(`i:${p.name}`);
    counters.members++;
    const g = grammarOfPin(pin);
    const mt = [`@bpPath ${path}:${p.name}`];
    const ft = memberFilterTags(profile, filter.rules, path, p.name);
    if (ft.deprecated) {
      mt.push(`@deprecated ${ft.deprecated}`);
      counters.deprecated.push(`${path}:${p.name}`);
    }
    if (ft.override) {
      mt.push(`@bpFilterOverride ${ft.override}`);
      counters.overridden.push(`${path}:${p.name}`);
    }
    mt.push(`@bpType ${g}`);
    if (isUnsupported(g)) mt.push(`@bpUnsupported ${unsupportedLabel(g)}`);
    instance.push(jsdoc(mt, "  ") + `  ${memberKey(p.name)}: ${tsOfGrammar(g, fb)};\n`);
  }

  if (!opaque) {
    for (const sp of SUPPLEMENTAL_PROPERTIES[path] ?? []) {
      if (seen.has(`i:${sp.name}`)) continue;
      seen.add(`i:${sp.name}`);
      counters.members++;
      // A supplement whose object class is not reflected is typed UObject.
      const objPath = sp.type.startsWith("object:") ? sp.type.slice("object:".length) : null;
      const g = objPath !== null && input.reflect.classes[objPath] === undefined ? `object:${UOBJECT_PATH}` : sp.type;
      const mt = [`@bpPath ${path}:${sp.name}`, `@bpType ${g}`];
      instance.push(jsdoc(mt, "  ") + `  ${sp.readonly ? "readonly " : ""}${memberKey(sp.name)}: ${tsOfGrammar(g, fb)};\n`);
    }
  }

  for (const [member, widgetCls] of Object.entries(input.widgetMembers?.[path] ?? {})) {
    if (seen.has(`i:${member}`)) continue;
    seen.add(`i:${member}`);
    counters.members++;
    // A widget class that was not reflected (no `scriptClasses` entry) is typed UObject; `abfc stubs` warns about it.
    const known = input.reflect.classes[widgetCls] !== undefined;
    instance.push(widgetMember(path, member, known ? widgetCls : UOBJECT_PATH, fb, widgetCls));
  }

  for (const f of c.functions) {
    const self = f.pins.find((p) => p.name === "self" && p.dir === "in");
    const isStatic = !(self && !self.hidden);
    const key = isStatic ? ident(f.name) : f.name;
    const dedupe = isStatic ? `s:${key}` : `i:${f.name}`;
    if (seen.has(dedupe)) {
      counters.missing.push(`${path}:${f.name}`);
      continue;
    }
    seen.add(dedupe);
    counters.members++;

    const execIn = f.pins.filter((p) => isExec(p) && p.dir === "in");
    const execOut = f.pins.filter((p) => isExec(p) && p.dir === "out");
    const extraExec = execOut.filter((p) => p.name !== profile.pins.then).map((p) => p.name);
    const mt = [`@bpPath ${path}:${f.name}`];
    const ft = memberFilterTags(profile, filter.rules, path, f.name);
    if (ft.deprecated) {
      mt.push(`@deprecated ${ft.deprecated}`);
      counters.deprecated.push(`${path}:${f.name}`);
    }
    if (ft.override) {
      mt.push(`@bpFilterOverride ${ft.override}`);
      counters.overridden.push(`${path}:${f.name}`);
    }
    if (execIn.length === 0 && execOut.length === 0) mt.push("@bpPure");
    if (f.pins.some((p) => p.category === "wildcard" && p.container === "Array") && path.endsWith(".KismetArrayLibrary")) {
      mt.push(`@bpNode ${callArrayShort}`);
    }
    if (extraExec.length > 0) mt.push(`@bpExecOutputs ${extraExec.join(",")}`);
    let latent = false;
    let worldContext = false;
    const ins: SigPin[] = [];
    const outs: SigPin[] = [];
    for (const p of f.pins) {
      if (isExec(p) || p.name === "self") continue;
      if (p.name === "LatentInfo") {
        latent = true;
        continue;
      }
      if (p.hidden) {
        if (/WorldContext/.test(p.name)) worldContext = true;
        continue;
      }
      const dflt = p.dir === "in" ? f.meta?.defaults?.[p.name] : undefined;
      (p.dir === "in" ? ins : outs).push({ pin: p.name, grammar: grammarOfPin(p), ...(dflt === undefined ? {} : { default: dflt }) });
    }
    if (latent) mt.push("@bpLatent");
    if (worldContext) mt.push("@bpWorldContext");
    const sig = buildSignature(ins, outs, extraExec, fb);
    mt.push(...sig.tags);
    const desc = describeFunction(descriptions, path, f.name, f.meta ?? undefined);
    if (isStatic) statics.push(jsdoc([desc, ...mt], "  ") + `  function ${key}(${sig.params}): ${sig.ret};\n`);
    else instance.push(jsdoc([desc, ...mt], "  ") + `  ${memberKey(key)}(${sig.params}): ${sig.ret};\n`);
  }

  const ext = parentPath === null ? "" : ` extends ${fb.ref(parentPath, "class")}`;
  let s = jsdoc(tags, "");
  const hasStaticsOnly = instance.length === 0 && statics.length > 0 && c.properties.length === 0;
  if (!hasStaticsOnly) {
    s += instance.length === 0 ? `export declare class ${name}${ext} {}\n` : `export declare class ${name}${ext} {\n${instance.join("")}}\n`;
  }
  if (statics.length > 0) {
    s += `${hasStaticsOnly ? "" : "\n"}export declare namespace ${name} {\n${statics.join("")}}\n`;
  }
  return s;
}

function renderStruct(path: string, fields: ReflectPin[] | null, fb: FileBuilder): string {
  const tags = [`@bpPath ${path}`, "@bpKind struct"];
  if (fields === null) tags.push("@bpOpaque");
  const body = (fields ?? [])
    .filter((f) => !f.hidden && !isExec(f))
    .map((f) => {
      const g = grammarOfPin(f);
      const ft = [`@bpType ${g}`];
      if (isUnsupported(g)) ft.push(`@bpUnsupported ${unsupportedLabel(g)}`);
      return jsdoc(ft, "  ") + `  ${IDENT_RE.test(f.name) ? f.name : JSON.stringify(f.name)}: ${tsOfGrammar(g, fb, "struct")};\n`;
    });
  return jsdoc(tags, "") + (body.length === 0 ? `export declare interface ${tsIdent(path)} {}\n` : `export declare interface ${tsIdent(path)} {\n${body.join("")}}\n`);
}

function renderEnum(path: string, fb: FileBuilder): string {
  return jsdoc([`@bpPath ${path}`, "@bpKind enum"], "") + `export type ${tsIdent(path)} = ${fb.runtime("byte")} & { readonly __bpEnum?: ${JSON.stringify(path)} };\n`;
}

/** Emits every stub file plus the `_index.json` data. */
export function emitStubsWithIndex(input: EmitInput): { files: Map<string, string>; index: StubIndex } {
  const { reflect } = input;
  const header = `// generated by abfc stubs ${STUBGEN_VERSION} for ${input.profile.id}; do not edit, never commit`;
  const classes = new Map<string, ReflectClass>(Object.entries(reflect.classes));
  if (!classes.has(UOBJECT_PATH)) classes.set(UOBJECT_PATH, EMPTY_CLASS);
  const structs = new Map(Object.entries(reflect.structs));
  const manualClassPaths = new Set(input.manual.map((m) => m.classPath));

  const defined = new Set<string>([...classes.keys(), ...structs.keys(), ...manualClassPaths]);
  const opaqueKinds = new Map<string, TypeRef["kind"]>();
  const manualRefs = input.manual.flatMap((m) => manualReferences(m));
  for (const r of [...reflectReferences(reflect), ...manualRefs]) {
    if (!defined.has(r.path) && !opaqueKinds.has(r.path)) opaqueKinds.set(r.path, r.kind);
  }
  for (const p of input.opaque) if (!defined.has(p) && !opaqueKinds.has(p)) opaqueKinds.set(p, "class");

  const counters: Counters = { members: 0, deprecated: [], overridden: [], missing: [] };
  const opaqueClassPaths = new Set([...opaqueKinds].filter(([, k]) => k === "class").map(([p]) => p));
  const parentOf = (path: string, c: ReflectClass): string | null => {
    if (path === UOBJECT_PATH) return null;
    for (const a of c.ancestors) {
      if (a !== path && (classes.has(a) || opaqueClassPaths.has(a))) return a;
    }
    return UOBJECT_PATH;
  };

  const groups = new Map<string, Item[]>();
  const add = (path: string, render: (fb: FileBuilder) => string): void => {
    const spec = moduleSpecifier(path);
    let g = groups.get(spec);
    if (!g) groups.set(spec, (g = []));
    g.push({ path, render });
  };
  for (const [path, c] of classes) add(path, (fb) => renderClass(path, c, parentOf(path, c), input, counters, false, fb));
  for (const [path, s] of structs) add(path, (fb) => renderStruct(path, s.fields, fb));
  for (const [path, kind] of opaqueKinds) {
    if (kind === "class") add(path, (fb) => renderClass(path, EMPTY_CLASS, UOBJECT_PATH, input, counters, true, fb));
    else if (kind === "struct") add(path, (fb) => renderStruct(path, null, fb));
    else add(path, (fb) => renderEnum(path, fb));
  }

  const files = new Map<string, string>();
  for (const spec of [...groups.keys()].sort()) {
    const items = (groups.get(spec) ?? []).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const fb = new FileBuilder(spec, items.map((i) => i.path));
    const bodies = items.map((i) => i.render(fb));
    const imports = fb.renderImports();
    files.set(stubFile(spec), [header, ...imports, "", bodies.join("\n")].join("\n"));
  }
  for (const m of input.manual) {
    const f = emitManual(m, header);
    files.set(f.file, f.text);
  }

  return {
    files,
    index: {
      files: [...files.keys()].sort(),
      members: counters.members,
      deprecated: counters.deprecated.sort(),
      overridden: counters.overridden.sort(),
      missing: counters.missing.sort(),
      opaque: [...opaqueKinds.keys()].sort(),
    },
  };
}

/** Relative file -> text (below `.abfc/stubs/<profile>/`). */
export function emitStubs(input: EmitInput): Map<string, string> {
  return emitStubsWithIndex(input).files;
}
