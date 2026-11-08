import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { addDirectorTagFix } from "../src/index.js";

// The frontend side of the tag (literal / GameplayTag constants, ABFC2079-2081) is tested in packages/cli/test/director-tags.test.ts,
// which needs the generated .abfc/tags.d.ts of @abfc/stubgen.
const SOURCE = [
  'import { blueprint, director } from "@abfc/runtime";',
  "",
  '@director("RowLiteral", "ClassManager.EntityDirector.Literal")',
  "@blueprint()",
  "export class BPC_Literal {}",
  "",
  '@director("RowMissing")',
  "@blueprint()",
  "export class BPC_Missing {}",
  "",
].join("\n");

test("ABFC2079 quick fix: inserts the tag before the closing parenthesis; a decorator that already has a tag has no fix", () => {
  const sf = ts.createSourceFile("Tags.ts", SOURCE, ts.ScriptTarget.ES2022, true);
  const start = SOURCE.indexOf('@director("RowMissing")');
  const edits = addDirectorTagFix(sf, start, start + 5, "ClassManager.EntityDirector.RowMissing")!;
  assert.equal(edits.length, 1);
  const fixed = SOURCE.slice(0, edits[0]!.start) + edits[0]!.newText + SOURCE.slice(edits[0]!.start + edits[0]!.length);
  assert.match(fixed, /@director\("RowMissing", "ClassManager\.EntityDirector\.RowMissing"\)/);
  const withTag = SOURCE.indexOf('@director("RowLiteral"');
  assert.equal(addDirectorTagFix(sf, withTag, withTag + 5, "X.Y"), undefined);
});
