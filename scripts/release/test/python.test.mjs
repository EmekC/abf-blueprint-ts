import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { writeZip } from "@abfc/env";
import { embedPythonFiles } from "../lib/python.mjs";

function zipOf(entries) {
  return writeZip(entries.map(([name, text]) => ({ name, data: Buffer.from(text, "utf8") })));
}

describe("embedPythonFiles", () => {
  it("prefixes names and appends the backend path to the ._pth", () => {
    const m = embedPythonFiles(
      zipOf([
        ["python.exe", "MZ"],
        ["python314._pth", "python314.zip\r\n.\r\n"],
        ["LICENSE.txt", "license"],
      ]),
    );
    assert.deepEqual([...m.keys()].sort(), ["python/LICENSE.txt", "python/python.exe", "python/python314._pth"]);
    assert.equal(m.get("python/python314._pth").toString("utf8"), "python314.zip\r\n.\r\n..\\backend\r\n");
  });

  it("adds a line break first when the ._pth does not end with one", () => {
    const m = embedPythonFiles(zipOf([["python.exe", "MZ"], ["python314._pth", "python314.zip"], ["LICENSE.txt", "l"]]));
    assert.equal(m.get("python/python314._pth").toString("utf8"), "python314.zip\r\n..\\backend\r\n");
  });

  it("requires exactly one ._pth, python.exe and LICENSE.txt", () => {
    assert.throws(() => embedPythonFiles(zipOf([["python.exe", "MZ"], ["LICENSE.txt", "l"]])), /._pth/);
    assert.throws(
      () => embedPythonFiles(zipOf([["python.exe", "MZ"], ["LICENSE.txt", "l"], ["python313._pth", "a"], ["python314._pth", "b"]])),
      /exactly one/,
    );
    assert.throws(() => embedPythonFiles(zipOf([["python314._pth", "a"], ["LICENSE.txt", "l"]])), /python\.exe/);
    assert.throws(() => embedPythonFiles(zipOf([["python.exe", "MZ"], ["python314._pth", "a"]])), /LICENSE\.txt/);
  });
});
