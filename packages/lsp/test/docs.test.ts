import { test } from "node:test";
import assert from "node:assert/strict";
import { DOCS_SITE_URL, nodeDocsSlug, nodeDocsUrl } from "../src/docs.js";

test("docs: the page slug is owner and function, lowercase, runs of other characters become -", () => {
  assert.equal(nodeDocsSlug("/Script/Engine.KismetSystemLibrary:K2_SetTimerDelegate"), "reference/nodes/kismetsystemlibrary-k2-settimerdelegate");
  assert.equal(nodeDocsSlug("/Script/Engine.KismetSystemLibrary:PrintString"), "reference/nodes/kismetsystemlibrary-printstring");
  assert.equal(nodeDocsSlug("PrintString"), undefined);
});

test("docs: a /Script function has a full URL, other paths none", () => {
  assert.equal(
    nodeDocsUrl("/Script/Engine.KismetSystemLibrary:PrintString"),
    `${DOCS_SITE_URL}reference/nodes/kismetsystemlibrary-printstring/`,
  );
  assert.equal(DOCS_SITE_URL, "https://emekc.github.io/abf-blueprint-ts/");
  assert.equal(nodeDocsUrl("/Script/FakeEngine.FakeController:GetPawnThing"), `${DOCS_SITE_URL}reference/nodes/fakecontroller-getpawnthing/`);
  assert.equal(nodeDocsUrl("/Game/Fake/WBP_Show.WBP_Show_C:Show"), undefined);
  assert.equal(nodeDocsUrl("/Script/Engine.Actor"), undefined);
});
