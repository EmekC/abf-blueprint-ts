// Text checks of the Inno Setup script (release/installer/abfc.iss). ISCC only runs in CI, so these tests pin the "abfc.exe is still
// open" check on the text: it runs before the files are copied and before the uninstall, and names the program that keeps abfc open.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const iss = readFileSync(join(root, "release", "installer", "abfc.iss"), "utf8").replace(/\r\n/g, "\n");

describe("abfc.iss running-process check", () => {
  it("checks before install and before uninstall", () => {
    assert.match(iss, /function PrepareToInstall\(var NeedsRestart: Boolean\): String;/);
    assert.match(iss, /function InitializeUninstall\(\): Boolean;/);
    assert.match(iss, /MB_RETRYCANCEL/);
  });

  it("finds processes through WMI and walks up to the owner", () => {
    assert.ok(iss.includes("WbemScripting.SWbemLocator"));
    assert.ok(iss.includes("Win32_Process"));
    assert.ok(iss.includes("ExecutablePath"));
    assert.ok(iss.includes("ParentProcessId"));
    assert.match(iss, /for Depth := 1 to 10 do/);
  });

  it("maps the owner program to a friendly name", () => {
    for (const exe of ["code.exe", "code - insiders.exe", "vscodium.exe", "cursor.exe", "windsurf.exe", "cmd.exe", "powershell.exe", "pwsh.exe", "windowsterminal.exe", "explorer.exe"]) {
      assert.ok(iss.includes(`'${exe}'`), `${exe} is not mapped`);
    }
    for (const name of ["Visual Studio Code", "Visual Studio Code Insiders", "VSCodium", "Cursor", "Windsurf"]) {
      assert.ok(iss.includes(`'${name}'`), `${name} has no friendly name`);
    }
    assert.ok(iss.includes("abfc.exe is still open, started by "));
  });

  it("never evaluates {srcexe} while uninstalling", () => {
    // ExpandConstant('{srcexe}') raises during uninstall; IsInsideApp runs there too.
    const m = /if not IsUninstaller then\n\s+if Key = PathKey\(ExpandConstant\('\{srcexe\}'\)\) then\n\s+Exit;/.exec(iss);
    assert.ok(m !== null, "the {srcexe} comparison must sit under `if not IsUninstaller then`");
    const uses = iss.split("\n").filter((l) => l.includes("{srcexe}") && !l.trim().startsWith("//"));
    assert.equal(uses.length, 1, "{srcexe} is used on more than the guarded line");
  });

  it("keeps walking past a shell to find an editor and falls back to the terminal", () => {
    assert.match(iss, /if OwnKind = 2 then\n\s+begin\n[^]*?SawTerminal := True;\n\s+Cur := Parent;\n\s+Continue;/);
    assert.match(iss, /if \(Kind <> 1\) and SawTerminal then\n\s+Kind := 2;/);
  });

  it("is silent-aware", () => {
    assert.ok(iss.includes("WizardSilent"));
    assert.ok(iss.includes("UninstallSilent"));
  });
});
