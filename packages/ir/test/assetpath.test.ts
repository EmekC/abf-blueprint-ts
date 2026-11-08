import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CLASS_MANAGER_TABLE,
  DEFAULT_SOURCE_ROOT,
  MAX_PACKAGE_PATH,
  MAX_SEGMENT,
  classNameProblem,
  joinModPath,
  modRelativeProblem,
  packagePathProblem,
  segmentProblem,
  toModRelative,
} from "../src/index.js";

test("constants", () => {
  assert.equal(MAX_PACKAGE_PATH, 160);
  assert.equal(MAX_SEGMENT, 64);
  assert.equal(DEFAULT_SOURCE_ROOT, "src");
  assert.equal(DEFAULT_CLASS_MANAGER_TABLE, "DataTables/DT_ClassManager");
});

test("segmentProblem accepts letters, digits and underscore", () => {
  assert.equal(segmentProblem("BP_Relay2"), null);
  assert.equal(segmentProblem("a"), null);
  assert.equal(segmentProblem("x".repeat(64)), null);
});

test("segmentProblem reasons", () => {
  assert.equal(segmentProblem(""), "is empty");
  assert.equal(segmentProblem("x".repeat(65)), "is longer than 64 characters");
  assert.equal(segmentProblem("My Relays"), 'contains " " (Unreal allows only A-Z, a-z, 0-9 and _ in asset paths)');
  assert.equal(segmentProblem("bad-dir"), 'contains "-" (Unreal allows only A-Z, a-z, 0-9 and _ in asset paths)');
  assert.match(segmentProblem("a.b-c") ?? "", /^contains "\."/);
  assert.match(segmentProblem("Ünï") ?? "", /^contains "Ü"/);
  for (const n of ["CON", "prn", "Aux", "NUL", "com0", "COM9", "lpt1", "LPT9"]) {
    assert.equal(segmentProblem(n), "is a reserved Windows name", n);
  }
  assert.equal(segmentProblem("COM10"), null);
  assert.equal(segmentProblem("CONSOLE"), null);
});

test("classNameProblem adds the _C rule", () => {
  assert.equal(classNameProblem("BP_X"), null);
  assert.equal(classNameProblem("BP_X_C"), "ends in _C (reserved for generated classes)");
  assert.equal(classNameProblem("_C"), "ends in _C (reserved for generated classes)");
  assert.equal(classNameProblem("Bad Name"), 'contains " " (Unreal allows only A-Z, a-z, 0-9 and _ in asset paths)');
  assert.equal(classNameProblem("NUL"), "is a reserved Windows name");
  assert.equal(classNameProblem("CLASS"), null);
});

test("modRelativeProblem", () => {
  assert.equal(modRelativeProblem("Relays/BP_X"), null);
  assert.equal(modRelativeProblem("DataTables/DT_ClassManager"), null);
  assert.equal(modRelativeProblem("X"), null);
  assert.equal(modRelativeProblem("/Relays/BP_X"), "must not start with /");
  assert.equal(modRelativeProblem("Relays/"), "must not end with /");
  assert.equal(modRelativeProblem("Relays\\BP_X"), "must use / as the separator, not \\");
  assert.equal(modRelativeProblem("Relays//BP_X"), "must not contain //");
  assert.equal(modRelativeProblem("My Relays/BP_X"), '"My Relays" contains " " (Unreal allows only A-Z, a-z, 0-9 and _ in asset paths)');
  assert.equal(modRelativeProblem("Relays/CON"), '"CON" is a reserved Windows name');
  assert.equal(modRelativeProblem(""), '"" is empty');
});

test("packagePathProblem", () => {
  assert.equal(packagePathProblem("/TestMod/" + "x".repeat(MAX_PACKAGE_PATH - 9)), null);
  assert.equal(packagePathProblem("/TestMod/" + "x".repeat(MAX_PACKAGE_PATH - 8)), "is longer than 160 characters");
});

test("joinModPath and toModRelative", () => {
  assert.equal(joinModPath("TestMod", "Relays/BP_X"), "/TestMod/Relays/BP_X");
  assert.equal(toModRelative("TestMod", "/TestMod/Relays/BP_X"), "Relays/BP_X");
  assert.equal(toModRelative("TestMod", "/testmod/Relays/BP_X"), "Relays/BP_X");
  assert.equal(toModRelative("testmod", "/TESTMOD/Relays/BP_x"), "Relays/BP_x");
  assert.equal(toModRelative("TestMod", "/OtherMod/Relays/BP_X"), null);
  assert.equal(toModRelative("TestMod", "/TestModX/BP_X"), null);
  assert.equal(toModRelative("TestMod", "/TestMod"), null);
  assert.equal(toModRelative("TestMod", "Relays/BP_X"), null);
});
