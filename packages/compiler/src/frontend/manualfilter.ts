// Hides what abfc owns from the generated `<Asset>_Manual` stubs, so the TS class declaration is the only way to reach it.
import ts from "typescript";
import { bpTags, splitMemberPath } from "./tags.js";

/** Per asset path (`/Mod/a/X`): the unit ids (`event:Name`, `function:Name`) and variable names abfc owns, from the manifests. */
export type OwnedByAsset = Record<string, { units: string[]; variables: string[] }>;

/**
 * Removes from every `*_Manual` interface of the stub text the `@bpHandMade` members that the manifest says abfc owns now.
 * The stubs are generated before an event is adopted or built, so they still list it as hand-made; without this a call to an
 * event that the TS class no longer declares would type-check against the stale member. Returns `text` itself when nothing is removed.
 */
export function filterOwnedManual(fileName: string, text: string, owned: OwnedByAsset): string {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const cuts: Array<[number, number]> = [];
  for (const st of sf.statements) {
    if (!ts.isInterfaceDeclaration(st) || !st.name.text.endsWith("_Manual")) continue;
    for (const m of st.members) {
      const isMethod = ts.isMethodSignature(m);
      if (!isMethod && !ts.isPropertySignature(m)) continue;
      const tags = bpTags(m);
      const mp = splitMemberPath(tags.get("bpPath")?.[0] ?? "");
      if (!mp || !tags.has("bpHandMade")) continue;
      const dot = mp.owner.lastIndexOf(".");
      const set = owned[dot < 0 ? mp.owner : mp.owner.slice(0, dot)];
      if (!set) continue;
      const hit = isMethod
        ? set.units.includes(`event:${mp.name}`) || set.units.includes(`function:${mp.name}`)
        : set.variables.includes(mp.name);
      if (hit) cuts.push([m.getFullStart(), m.end]);
    }
  }
  if (cuts.length === 0) return text;
  let out = text;
  for (const [from, to] of cuts.sort((a, b) => b[0] - a[0])) out = out.slice(0, from) + out.slice(to);
  return out;
}
