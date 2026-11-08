import { styleText } from "node:util";

export type Tone = "ok" | "fail" | "warn" | "accent" | "dim" | "bold";

export interface Styler {
  readonly enabled: boolean;
  paint(tone: Tone, text: string): string;
}

/**
 * Whether to emit ANSI colors, following Node's precedence: `FORCE_COLOR` (on unless "0"/"false"), then `NO_COLOR`
 * (non-empty turns colors off), then `TERM=dumb` (off), then whether the stream is a terminal.
 */
export function colorEnabled(env: Record<string, string | undefined>, isTTY: boolean): boolean {
  const force = env.FORCE_COLOR;
  if (force !== undefined) return force !== "0" && force !== "false";
  const noColor = env.NO_COLOR;
  if (noColor !== undefined && noColor !== "") return false;
  if (env.TERM === "dumb") return false;
  return isTTY;
}

const FORMATS: Record<Tone, "green" | "red" | "yellow" | "cyan" | "dim" | "bold"> = {
  ok: "green",
  fail: "red",
  warn: "yellow",
  accent: "cyan",
  dim: "dim",
  bold: "bold",
};

export function makeStyler(enabled: boolean): Styler {
  return {
    enabled,
    paint(tone: Tone, text: string): string {
      if (!enabled || text === "") return text;
      return styleText(FORMATS[tone], text, { validateStream: false });
    },
  };
}

export const PLAIN: Styler = makeStyler(false);

/**
 * Colors the severity word and code of a formatted diagnostic and dims its `tried`/`fix` lines. The text is otherwise
 * identical (stripping ANSI gives `text` back); with colors off it is returned unchanged.
 */
export function paintDiagnostic(text: string, severity: "error" | "warning", style: Styler): string {
  if (!style.enabled) return text;
  const lines = text.split("\n");
  const first = lines[0] ?? "";
  const tone: Tone = severity === "error" ? "fail" : "warn";
  lines[0] = first.replace(
    /^(.*?)(error|warning)( ABFC\w*)(:)/,
    (_m, pre: string, sev: string, code: string, colon: string) => pre + style.paint(tone, sev + code) + colon,
  );
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("  tried:") || line.startsWith("    ") || line.startsWith("  fix:")) lines[i] = style.paint("dim", line);
  }
  return lines.join("\n");
}
