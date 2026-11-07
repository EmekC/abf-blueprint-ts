const isUpper = (c: string): boolean => c >= "A" && c <= "Z";
const isLower = (c: string): boolean => c >= "a" && c <= "z";
const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isLetter = (c: string): boolean => isUpper(c) || isLower(c);

/**
 * The name the Blueprint node editor shows for a function without a display-name override
 * (Unreal's name prettifier): `K2_GetPawn` -> `Get Pawn`, `GetHUDClass` -> `Get HUD Class`.
 */
export function displayNameOf(fn: string): string {
  const s = fn.startsWith("K2_") ? fn.slice(3) : fn;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "_") {
      out += " ";
      continue;
    }
    const prev = i > 0 ? s[i - 1]! : "";
    const next = i + 1 < s.length ? s[i + 1]! : "";
    let space = false;
    if (prev !== "") {
      if (isUpper(c)) {
        if (isLower(prev)) space = true;
        else if (isDigit(prev)) space = isLower(next);
        else if (isUpper(prev) && isLower(next)) space = true;
      } else if (isDigit(c) && isLetter(prev)) {
        space = true;
      }
    }
    if (space) out += " ";
    out += c;
  }
  return out.replace(/ +/g, " ").trim();
}
