// Release allowlists (release/allowlist.json): glob matching and selection.
import { readFileSync } from "node:fs";

export function loadAllowlist(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** `**` any characters including `/`, `*` any characters except `/`, `?` one character except `/`; anchored, case-sensitive. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\\-/]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Splits `paths` by `patterns`: `selected` = matched by at least one pattern, `rejected` = matched by none,
 * `unmatchedPatterns` = patterns that matched nothing.
 */
export function selectAllowed(paths, patterns) {
  const regs = patterns.map((p) => ({ p, re: globToRegExp(p), hit: false }));
  const selected = [];
  const rejected = [];
  for (const path of paths) {
    let ok = false;
    for (const r of regs) {
      if (r.re.test(path)) {
        r.hit = true;
        ok = true;
      }
    }
    (ok ? selected : rejected).push(path);
  }
  return { selected, unmatchedPatterns: regs.filter((r) => !r.hit).map((r) => r.p), rejected };
}
