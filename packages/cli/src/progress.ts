import type { Styler, Tone } from "./style.js";

export interface Terminal {
  write(chunk: string): void;
  isTTY: boolean;
  stdoutIsTTY: boolean;
  columns: number;
  env: Record<string, string | undefined>;
}

export interface ProgressClock {
  /** Monotonic time in milliseconds. */
  now(): number;
  /** Calls `fn` every `ms` milliseconds; returns the cancel function. */
  every(ms: number, fn: () => void): () => void;
}

export type ProgressMode = "off" | "plain" | "live";

export interface ProgressOptions {
  mode: ProgressMode;
  term: Terminal;
  style: Styler;
  clock: ProgressClock;
  notes: boolean;
}

export interface StepOptions {
  total?: number | undefined;
  slowHint?: string | undefined;
}

export interface Step {
  readonly label: string;
  readonly active: boolean;
  tick(count: number, total?: number): void;
  detail(text: string): void;
  succeed(label?: string): void;
  fail(label?: string): void;
  dismiss(): void;
}

export const SLOW_BACKEND_HINT = "the first backend call starts the Mod Editor in the background; this can take a few minutes";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const CLEAR_LINE = "\r\x1b[2K";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const SLOW_HINT_AFTER_MS = 15_000;
const BAR_CELLS = 20;

/** Live Progress instances, so a signal handler can put the terminal back. */
const registry = new Set<Progress>();

export function realClock(): ProgressClock {
  return {
    now: () => performance.now(),
    every(ms: number, fn: () => void): () => void {
      const timer = setInterval(fn, ms);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}

/** The real terminal: progress goes to stderr; `stdoutIsReal` is false when the caller injected its own stdout writer. */
export function processTerminal(stdoutIsReal: boolean): Terminal {
  return {
    write: (chunk: string): void => void process.stderr.write(chunk),
    isTTY: process.stderr.isTTY === true,
    stdoutIsTTY: stdoutIsReal && process.stdout.isTTY === true,
    get columns(): number {
      return process.stderr.columns || 80;
    },
    env: process.env,
  };
}

/** A non-terminal sink: collects chunks and hands every complete line (without its newline) to `writeLine`. */
export function lineTerminal(writeLine: (line: string) => void): Terminal {
  let buffer = "";
  return {
    write(chunk: string): void {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        writeLine(line);
        nl = buffer.indexOf("\n");
      }
    },
    isTTY: false,
    stdoutIsTTY: false,
    columns: 80,
    env: {},
  };
}

export function progressMode(flags: { json: boolean; quiet: boolean }, term: Terminal): ProgressMode {
  if (flags.json || flags.quiet) return "off";
  if (term.isTTY && term.env.TERM !== "dumb") return "live";
  return "plain";
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function formatElapsed(ms: number): string {
  const t = Math.max(0, ms);
  if (t < 59_950) return `${(t / 1000).toFixed(1)}s`;
  const s = Math.round(t / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad2(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${pad2(Math.floor((s % 3600) / 60))}m`;
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** Interrupts every registered live Progress: clears the spinner line, marks the active step interrupted, shows the cursor. */
export function restoreTerminal(): void {
  for (const p of [...registry]) p.interrupt();
}

interface Segment {
  text: string;
  tone?: Tone;
}

/** Cuts the unpainted text to `max` characters, then paints each segment. */
function clipAndPaint(segments: Segment[], max: number, style: Styler): string {
  let left = Math.max(0, max);
  let out = "";
  for (const seg of segments) {
    if (left <= 0) break;
    const text = seg.text.length > left ? seg.text.slice(0, left) : seg.text;
    left -= text.length;
    out += seg.tone !== undefined ? style.paint(seg.tone, text) : text;
  }
  return out;
}

class InertStep implements Step {
  readonly active = false;
  constructor(readonly label: string) {}
  tick(): void {}
  detail(): void {}
  succeed(): void {}
  fail(): void {}
  dismiss(): void {}
}

/** @internal A step owned by a `Progress`; use the `Step` interface. */
export class ActiveStep implements Step {
  active = true;
  count = 0;
  total: number | undefined;
  detailText = "";
  frame = 0;
  readonly startedAt: number;
  private cancel: (() => void) | null = null;

  constructor(
    private readonly owner: Progress,
    readonly label: string,
    readonly slowHint: string | undefined,
    total: number | undefined,
    startedAt: number,
  ) {
    this.total = total;
    this.startedAt = startedAt;
  }

  setTimer(cancel: () => void): void {
    this.cancel = cancel;
  }

  stopTimer(): void {
    if (this.cancel !== null) this.cancel();
    this.cancel = null;
  }

  tick(count: number, total?: number): void {
    if (!this.active) return;
    this.count = count;
    if (total !== undefined) this.total = total;
    this.owner.redrawStep(this);
  }

  detail(text: string): void {
    if (!this.active) return;
    this.detailText = text;
    this.owner.redrawStep(this);
  }

  succeed(label?: string): void {
    this.owner.endStep(this, "succeed", label);
  }

  fail(label?: string): void {
    this.owner.endStep(this, "fail", label);
  }

  dismiss(): void {
    this.owner.endStep(this, "dismiss", undefined);
  }
}

/**
 * Step progress on a terminal (normally stderr). `live` redraws a spinner line, `plain` prints one line per finished step,
 * `off` prints nothing. Output that must share the terminal goes through `write` so the spinner line is cleared and redrawn.
 */
export class Progress {
  readonly mode: ProgressMode;
  readonly notes: boolean;
  private readonly term: Terminal;
  private readonly style: Styler;
  private readonly clock: ProgressClock;
  private readonly createdAt: number;
  private current: ActiveStep | null = null;
  private cursorHidden = false;
  private disposed = false;
  private finished = false;

  constructor(o: ProgressOptions) {
    this.mode = o.mode;
    this.notes = o.notes;
    this.term = o.term;
    this.style = o.style;
    this.clock = o.clock;
    this.createdAt = o.clock.now();
  }

  get live(): boolean {
    return this.mode === "live";
  }

  get activeStep(): Step | null {
    return this.current;
  }

  header(command: string, facts: string[]): void {
    if (this.mode === "off") return;
    const tail = facts.length > 0 ? ` · ${facts.join(" · ")}` : "";
    if (this.mode === "plain") {
      this.term.write(`abfc ${command}${tail}\n`);
      return;
    }
    this.write(() => this.term.write(`${this.style.paint("bold", `abfc ${command}`)}${tail === "" ? "" : this.style.paint("dim", tail)}\n`));
  }

  start(label: string, o?: StepOptions): Step {
    if (this.mode === "off" || this.disposed) return new InertStep(label);
    if (this.current !== null) this.current.succeed();
    const step = new ActiveStep(this, label, o?.slowHint, o?.total, this.clock.now());
    this.current = step;
    if (this.mode === "live") {
      registry.add(this);
      if (!this.cursorHidden) {
        this.term.write(HIDE_CURSOR);
        this.cursorHidden = true;
      }
      this.draw(step);
      step.setTimer(
        this.clock.every(80, () => {
          step.frame += 1;
          this.draw(step);
        }),
      );
    }
    return step;
  }

  async run<T>(label: string, fn: (s: Step) => T | Promise<T>, o?: StepOptions & { done?: ((r: T) => string) | undefined }): Promise<T> {
    const step = this.start(label, o);
    let result: T;
    try {
      result = await fn(step);
    } catch (e) {
      if (step.active) step.fail();
      throw e;
    }
    if (step.active) step.succeed(o?.done !== undefined ? o.done(result) : label);
    return result;
  }

  /** Runs `fn` (which prints a line on the terminal) without garbling a live spinner line. */
  write(fn: () => void): void {
    const step = this.current;
    if (this.mode !== "live" || step === null) {
      fn();
      return;
    }
    this.term.write(CLEAR_LINE);
    fn();
    this.draw(step);
  }

  /** A dimmed, indented backend log line (only when `notes` is on). */
  note(line: string): void {
    if (!this.notes) return;
    if (this.mode === "live") {
      this.write(() => this.term.write(`    ${this.style.paint("dim", line)}\n`));
      return;
    }
    this.term.write(`    ${line}\n`);
  }

  summary(ok: boolean, title: string, detail?: string): void {
    if (this.mode === "off") return;
    if (this.current !== null) this.current.succeed();
    if (this.mode === "plain") {
      this.term.write(`\n${ok ? "✔" : "✖"} ${title}${detail !== undefined ? `  ${detail}` : ""}\n`);
      return;
    }
    const glyph = this.style.paint(ok ? "ok" : "fail", ok ? "✔" : "✖");
    const tail = detail !== undefined ? `  ${this.style.paint("accent", detail)}` : "";
    this.term.write(`\n${glyph} ${this.style.paint("bold", title)}${tail}\n`);
  }

  /** Ends progress and prints `done in <time since construction>`. */
  finish(): void {
    this.dispose();
    if (this.mode === "off" || this.finished) return;
    this.finished = true;
    const text = `done in ${formatElapsed(this.clock.now() - this.createdAt)}`;
    this.term.write(`${this.mode === "live" ? this.style.paint("dim", text) : text}\n`);
  }

  /** Idempotent: fails an active step, stops its timer, shows the cursor and unregisters. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.current !== null) this.current.fail();
    if (this.mode === "live" && this.cursorHidden) {
      this.term.write(SHOW_CURSOR);
      this.cursorHidden = false;
    }
    registry.delete(this);
  }

  /** Synchronous, signal-safe teardown used by `restoreTerminal`. */
  interrupt(): void {
    const step = this.current;
    if (step !== null) {
      step.stopTimer();
      step.active = false;
      this.current = null;
    }
    this.term.write(CLEAR_LINE);
    if (step !== null) this.term.write(`✖ ${step.label} (interrupted)\n`);
    this.term.write(SHOW_CURSOR);
    this.cursorHidden = false;
    this.disposed = true;
    this.finished = true;
    registry.delete(this);
  }

  /** @internal Redraws the spinner line when `step` is the live active step. */
  redrawStep(step: ActiveStep): void {
    if (this.mode === "live" && this.current === step) this.draw(step);
  }

  /** @internal Ends `step`: prints its result line (plain/live) and clears the active slot. */
  endStep(step: ActiveStep, how: "succeed" | "fail" | "dismiss", label: string | undefined): void {
    if (!step.active) return;
    step.active = false;
    step.stopTimer();
    if (this.current === step) this.current = null;
    if (this.mode === "off") return;
    const elapsedMs = this.clock.now() - step.startedAt;
    const text = label ?? step.label;
    if (this.mode === "plain") {
      if (how !== "dismiss") this.term.write(`${how === "succeed" ? "✔" : "✖"} ${text} (${formatElapsed(elapsedMs)})\n`);
      return;
    }
    if (how === "dismiss") {
      this.term.write(`${CLEAR_LINE}${SHOW_CURSOR}`);
      this.cursorHidden = false;
      return;
    }
    const elapsed = formatElapsed(elapsedMs);
    const width = Math.min(this.term.columns, 100) - 1;
    const room = Math.max(1, width - 2 - elapsed.length - 2);
    const shown = text.length > room ? text.slice(0, room) : text;
    const gap = Math.max(2, width - (2 + shown.length) - elapsed.length);
    const glyph = this.style.paint(how === "succeed" ? "ok" : "fail", how === "succeed" ? "✔" : "✖");
    this.term.write(`${CLEAR_LINE}${glyph} ${shown}${" ".repeat(gap)}${this.style.paint("dim", elapsed)}\n${SHOW_CURSOR}`);
    this.cursorHidden = false;
  }

  private draw(step: ActiveStep): void {
    if (!step.active) return;
    const elapsedMs = this.clock.now() - step.startedAt;
    const segments: Segment[] = [
      { text: FRAMES[step.frame % FRAMES.length] ?? "⠋", tone: "accent" },
      { text: ` ${step.label}` },
    ];
    if (step.detailText !== "") segments.push({ text: ` · ${step.detailText}` });
    const total = step.total;
    if (total !== undefined && total > 0) {
      if (this.term.columns >= 60) {
        const filled = Math.max(0, Math.min(BAR_CELLS, Math.floor((step.count / total) * BAR_CELLS)));
        segments.push({ text: "  " }, { text: "█".repeat(filled), tone: "accent" }, { text: "░".repeat(BAR_CELLS - filled), tone: "dim" });
      }
      segments.push({ text: " " }, { text: `${formatCount(step.count)}/${formatCount(total)}`, tone: "accent" });
    }
    if (elapsedMs >= 1000) segments.push({ text: "  " }, { text: formatElapsed(elapsedMs), tone: "dim" });
    if (step.slowHint !== undefined && elapsedMs >= SLOW_HINT_AFTER_MS) segments.push({ text: " " }, { text: `· ${step.slowHint}`, tone: "dim" });
    this.term.write(CLEAR_LINE + clipAndPaint(segments, this.term.columns - 1, this.style));
  }
}
