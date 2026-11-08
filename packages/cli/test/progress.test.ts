import { test } from "node:test";
import assert from "node:assert/strict";
import { Output, Progress, colorEnabled, formatCount, formatElapsed, main, makeStyler, progressMode, restoreTerminal } from "../src/index.js";
import type { ProgressClock, ProgressMode, Terminal } from "../src/index.js";
import { ALL_TOOLS, captureDeps, fakeEnvironmentFiles, fixInfo, scriptedBackend } from "./helpers.js";

const ESC = "\x1b";
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

interface FakeTerm extends Terminal {
  out: string;
}

function fakeTerm(isTTY: boolean, env: Record<string, string | undefined> = {}): FakeTerm {
  const t: FakeTerm = {
    out: "",
    write(chunk: string): void {
      t.out += chunk;
    },
    isTTY,
    stdoutIsTTY: isTTY,
    columns: 100,
    env,
  };
  return t;
}

interface FakeClock extends ProgressClock {
  advance(ms: number): void;
}

function fakeClock(): FakeClock {
  let now = 0;
  const timers = new Set<{ ms: number; fn: () => void }>();
  return {
    now: () => now,
    every(ms: number, fn: () => void): () => void {
      const timer = { ms, fn };
      timers.add(timer);
      return () => void timers.delete(timer);
    },
    advance(ms: number): void {
      now += ms;
      for (const timer of [...timers]) {
        for (let i = 0; i < Math.floor(ms / timer.ms); i++) timer.fn();
      }
    },
  };
}

function makeProgress(mode: ProgressMode, term: Terminal, clock: ProgressClock, notes = false): Progress {
  return new Progress({ mode, term, style: makeStyler(colorEnabled(term.env, term.isTTY)), clock, notes });
}

test("colorEnabled follows FORCE_COLOR, NO_COLOR, TERM=dumb and the stream", () => {
  assert.equal(colorEnabled({}, true), true);
  assert.equal(colorEnabled({}, false), false);
  assert.equal(colorEnabled({ NO_COLOR: "1" }, true), false);
  assert.equal(colorEnabled({ NO_COLOR: "" }, true), true);
  assert.equal(colorEnabled({ FORCE_COLOR: "1" }, false), true);
  assert.equal(colorEnabled({ FORCE_COLOR: "0" }, true), false);
  assert.equal(colorEnabled({ TERM: "dumb" }, true), false);
});

test("formatElapsed and formatCount", () => {
  assert.equal(formatElapsed(400), "0.4s");
  assert.equal(formatElapsed(12_340), "12.3s");
  assert.equal(formatElapsed(422_000), "7m 02s");
  assert.equal(formatElapsed(3_725_000), "1h 02m");
  assert.equal(formatCount(5600), "5,600");
});

test("plain mode: header, one line per finished step, summary, done in; no ANSI and no carriage return", async () => {
  const term = fakeTerm(false);
  const clock = fakeClock();
  const p = makeProgress("plain", term, clock);
  p.header("stubs", ["profile p", "mod M"]);
  await p.run("Read", async () => void clock.advance(1500), { done: () => "Read 3 assets" });
  p.summary(true, "Stubs ready", "C:\\x");
  p.finish();
  assert.deepEqual(term.out.split("\n").slice(0, -1), ["abfc stubs · profile p · mod M", "✔ Read 3 assets (1.5s)", "", "✔ Stubs ready  C:\\x", "done in 1.5s"]);
  assert.doesNotMatch(term.out, /\x1b/);
  assert.doesNotMatch(term.out, /\r/);
});

test("live mode with colors: hides the cursor, redraws the spinner line with the counter, ends with the cursor shown", () => {
  const term = fakeTerm(true, { FORCE_COLOR: "1" });
  const clock = fakeClock();
  const p = makeProgress("live", term, clock);
  const step = p.start("Reading mod assets", { total: 5600 });
  step.tick(2140);
  clock.advance(80);
  assert.ok(term.out.includes(`${ESC}[?25l`));
  assert.ok(term.out.includes(`\r${ESC}[2K`));
  assert.match(term.out, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  assert.ok(term.out.includes("2,140/5,600"));
  step.succeed();
  assert.ok(term.out.includes("✔"));
  assert.ok(term.out.endsWith(`${ESC}[?25h`));
  assert.match(term.out, /\x1b\[3\dm/);
  p.dispose();
});

test("live mode with NO_COLOR: the spinner still draws, but there are no color sequences", () => {
  const term = fakeTerm(true, { NO_COLOR: "1" });
  const clock = fakeClock();
  const p = makeProgress("live", term, clock);
  const step = p.start("Working", { total: 10 });
  step.tick(3);
  clock.advance(160);
  step.succeed();
  p.summary(true, "Done", "x");
  p.finish();
  assert.ok(term.out.includes("\r"));
  assert.match(term.out, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  assert.doesNotMatch(term.out, /\x1b\[\d+m/);
});

test("--json and --quiet turn progress off; off writes nothing except notes when asked", async () => {
  const tty = fakeTerm(true);
  assert.equal(progressMode({ json: true, quiet: false }, tty), "off");
  assert.equal(progressMode({ json: false, quiet: true }, tty), "off");
  assert.equal(progressMode({ json: false, quiet: false }, tty), "live");
  assert.equal(progressMode({ json: false, quiet: false }, fakeTerm(true, { TERM: "dumb" })), "plain");
  assert.equal(progressMode({ json: false, quiet: false }, fakeTerm(false)), "plain");

  const term = fakeTerm(true);
  const p = makeProgress("off", term, fakeClock());
  p.header("build", ["a"]);
  const r = await p.run("Step", () => 42);
  assert.equal(r, 42);
  p.start("Other").succeed();
  p.note("hidden");
  p.summary(true, "Done");
  p.finish();
  assert.equal(term.out, "");

  const noisy = fakeTerm(true);
  const q = makeProgress("off", noisy, fakeClock(), true);
  q.note("backend says hi");
  assert.equal(noisy.out, "    backend says hi\n");
});

test("Output in live mode clears the spinner line around its lines; span-less diagnostics are indented, span diagnostics are not", () => {
  const term = fakeTerm(true, { FORCE_COLOR: "1" });
  const clock = fakeClock();
  const p = makeProgress("live", term, clock);
  const style = makeStyler(true);
  const out = new Output({
    command: "build",
    json: false,
    projectDir: "C:\\proj",
    stdout: (l) => void (term.out += l + "\n"),
    stderr: (l) => void (term.out += l + "\n"),
    progress: p,
    stdoutStyle: makeStyler(false),
    stderrStyle: style,
  });
  p.start("Working");
  const before = term.out.length;
  out.info("x");
  const after = term.out.slice(before);
  assert.ok(after.startsWith(`\r${ESC}[2Kx\n`), JSON.stringify(after));
  assert.ok(after.indexOf(`\r${ESC}[2K`, 1) > 0, "the spinner line is redrawn after the line");

  const mark = term.out.length;
  out.diag({ severity: "warning", code: "ABFC1234", message: "no span here" });
  const plainDiag = stripAnsi(term.out.slice(mark));
  assert.ok(plainDiag.includes("  abfc: warning ABFC1234: no span here\n"), JSON.stringify(plainDiag));

  const mark2 = term.out.length;
  out.diag({ severity: "error", code: "ABFC2001", message: "bad thing", span: { file: "C:\\proj\\src\\a.ts", line: 3, col: 5, endLine: 3, endCol: 9 } });
  const spanText = stripAnsi(term.out.slice(mark2)).replace(/^\r/, "");
  const spanLine = spanText.split("\n").find((l) => l.includes("ABFC2001")) ?? "";
  assert.match(spanLine, /^(.*\.ts):(\d+):(\d+): (error|warning) (ABFC\d+): (.*)$/);
  p.dispose();
});

test("restoreTerminal clears the line, marks the active step interrupted and shows the cursor", () => {
  const term = fakeTerm(true);
  const p = makeProgress("live", term, fakeClock());
  p.start("Reflecting 12 class(es)");
  restoreTerminal();
  assert.ok(term.out.includes("✖ Reflecting 12 class(es) (interrupted)"));
  assert.ok(term.out.endsWith(`${ESC}[?25h`));
});

test("finish after an interrupt prints no done-in line", () => {
  const term = fakeTerm(true);
  const clock = fakeClock();
  const p = makeProgress("live", term, clock);
  p.start("Reflecting");
  clock.advance(1000);
  restoreTerminal();
  p.finish();
  assert.ok(term.out.includes("(interrupted)"));
  assert.ok(!term.out.includes("done in"), term.out);
});

test("main without a project prints the diagnostic and no done-in line", async () => {
  const fake = fakeEnvironmentFiles({ headlessDir: "C:\\abfc-headless" });
  const cap = captureDeps(fake, async () => scriptedBackend(ALL_TOOLS, { backend_info: fixInfo() }));
  const code = await main(["check", "--project", "C:\\no-such-project"], cap.deps);
  assert.notEqual(code, 0, cap.text());
  assert.ok(cap.lines.some((l) => / error ABFC\d+: /.test(l)), cap.text());
  assert.ok(!cap.lines.some((l) => l.startsWith("done in ")), cap.text());
});

test("main doctor: the plain progress line on stderr, nothing with --quiet, one JSON document with --json", async () => {
  const EXT = { extProtocol: 1, serverVersion: "fake-1", python: "3.11.9", features: ["reflect", "compile_node_refs", "bp_read_seconds"] };
  const CORE = ["staging_sync", "staging_status", "bp_apply", "bp_read", "bp_compile_report", "bp_game_test", "mod_audit"];

  const fake = fakeEnvironmentFiles({ headlessDir: "C:\\abfc-headless" });
  const cap = captureDeps(fake, async () => scriptedBackend(ALL_TOOLS, { backend_info: fixInfo(), abfc_extensions: EXT }));
  const code = await main(["doctor"], cap.deps);
  assert.equal(code, 0, cap.text());
  assert.ok(cap.lines.some((l) => l.startsWith("✔ Backend answered")), cap.text());
  assert.ok(cap.lines.some((l) => l.startsWith("done in ")));
  assert.doesNotMatch(cap.text(), /\x1b/);

  const quietFake = fakeEnvironmentFiles({ headlessDir: "C:\\abfc-headless" });
  const quiet = captureDeps(quietFake, async () => scriptedBackend(ALL_TOOLS, { backend_info: fixInfo(), abfc_extensions: EXT }));
  assert.equal(await main(["doctor", "--quiet"], quiet.deps), 0, quiet.text());
  assert.ok(!quiet.lines.some((l) => /^(✔|✖|done in )/.test(l)), quiet.text());
  assert.ok(quiet.lines.some((l) => l.includes("wildcard pin types")));

  const jsonFake = fakeEnvironmentFiles({ headlessDir: "C:\\abfc-headless" });
  const json = captureDeps(jsonFake, async () => scriptedBackend(CORE, {}));
  assert.equal(await main(["doctor", "--json"], json.deps), 0, json.text());
  assert.equal(json.lines.length, 1);
  assert.doesNotThrow(() => JSON.parse(json.lines[0]!));
});
