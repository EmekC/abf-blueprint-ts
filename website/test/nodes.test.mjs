// The node reference: page slugs, the node list built from every stub function, generated snippets and notes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildNodes, generatedSnippet, nodeSlug, receiverName } from "../lib/nodes.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const descriptions = JSON.parse(readFileSync(join(root, "packages", "stubgen", "data", "descriptions.json"), "utf8"));
const signatures = JSON.parse(readFileSync(join(root, "website", "data", "node-signatures.json"), "utf8"));
const BASE = "/abf-blueprint-ts";
const nodes = buildNodes(descriptions, signatures, BASE);
const byKey = (key) => nodes.find((n) => n.key === key);

const sig = (over) => ({ owner: "KismetSystemLibrary", module: "/Script/Engine", kind: "static", tsName: "Foo", params: [], returns: { type: "void", fields: null }, latent: false, ...over });
const param = (name, type, optional = false) => ({ name, type, optional, default: null });

describe("node reference", () => {
  it("builds the page slug from owner and function", () => {
    assert.equal(nodeSlug("/Script/Engine.KismetSystemLibrary:PrintString"), "reference/nodes/kismetsystemlibrary-printstring");
    assert.equal(nodeSlug("/Script/Engine.KismetSystemLibrary:K2_SetTimerDelegate"), "reference/nodes/kismetsystemlibrary-k2-settimerdelegate");
    assert.throws(() => nodeSlug("PrintString"), /not a function key/);
  });

  it("lists every stub function and every curated function", () => {
    assert.equal(nodes.length, Object.keys(signatures.functions).length);
    assert.ok(nodes.length > 3000);
    for (const key of Object.keys(descriptions.functions)) assert.equal(byKey(key)?.curated, true, key);
    const print = byKey("/Script/Engine.KismetSystemLibrary:PrintString");
    assert.equal(print.title, "Print String");
    assert.equal(print.qualified, "KismetSystemLibrary.PrintString");
    assert.equal(print.worldContext, true);
    assert.ok(print.snippet.length > 0);
    assert.equal(byKey("/Script/Engine.KismetSystemLibrary:Delay").latent, true);
  });

  it("names game-module nodes by their reflected display name", () => {
    const node = byKey("/Script/AbioticFactor.AbioticCharacter:Aim");
    assert.equal(node.title, "Activate Jetpack");
    assert.equal(node.qualified, "AbioticCharacter.Aim");
    assert.equal(node.slug, "reference/nodes/abioticcharacter-aim");
  });

  it("explains the delegate pin and never labels it unsupported", () => {
    const node = byKey("/Script/Engine.KismetSystemLibrary:K2_SetTimerDelegate");
    const text = JSON.stringify([node.badges, node.notes]);
    assert.ok(node.notes.some((n) => n.html.includes("this.&lt;EventName&gt;") && n.html.includes("#abfc2054")));
    assert.ok(!/unsupported/i.test(text));
  });

  it("marks a blocked function and leaves out its example", () => {
    const node = nodes.find((n) => n.blocked !== null);
    assert.ok(node);
    assert.equal(node.snippet, null);
    assert.ok(node.badges.some((b) => b.label === "Blocked"));
    assert.ok(node.notes.some((n) => n.type === "caution" && n.html.includes("#abfc7011")));
  });

  it("rejects an entry without a snippet", () => {
    const bad = { version: 1, functions: { "/Script/Engine.Actor:Foo": { text: "Does a thing" } } };
    assert.throws(() => buildNodes(bad, signatures, BASE), /no snippet/);
  });

  it("generates a snippet from a latent static function", () => {
    const lines = generatedSnippet(sig({ tsName: "Delay", latent: true, params: [param("Duration", "float")] }));
    assert.equal(lines.length, 4);
    assert.ok(lines[2].includes("inside an @event"));
    assert.equal(lines[3], "KismetSystemLibrary.Delay(0.0);");
  });

  it("generates a snippet from a method", () => {
    const lines = generatedSnippet(sig({ owner: "TextBlock", module: "/Script/UMG", kind: "method", tsName: "SetText", params: [param("InText", "text")] }));
    assert.ok(lines.includes("// textBlock: a TextBlock (or this, in a class that extends TextBlock)"));
    assert.ok(lines.includes('textBlock.SetText("Text");'));
  });

  it("passes this.OnEvent for a delegate and keeps optional parameters out", () => {
    const lines = generatedSnippet(
      sig({
        tsName: "K2_SetTimerDelegate",
        params: [param("Delegate", "DelegateRef"), param("Time", "float"), param("bLooping", "boolean"), param("bMaxOncePerFrame", "boolean", true)],
        returns: { type: "TimerHandle", fields: null },
      }),
    );
    assert.ok(lines.includes("const timerHandle = KismetSystemLibrary.K2_SetTimerDelegate(this.OnEvent, 0.0, true);"));
    assert.ok(lines.some((l) => l.includes("OnEvent is an @event method")));
  });

  it("destructures a multi-output return", () => {
    const lines = generatedSnippet(sig({ returns: { type: "{ OutValue: string; ReturnValue: boolean }", fields: ["OutValue", "ReturnValue"] } }));
    assert.ok(lines[lines.length - 1].startsWith("const { OutValue, ReturnValue } = "));
  });

  it("names placeholders after the parameter or the first literal", () => {
    assert.ok(generatedSnippet(sig({ params: [param("TargetActor", "Actor | null")] })).pop().includes("(targetActor)"));
    assert.ok(generatedSnippet(sig({ params: [param("Style", '"Plain" | "Fancy"')] })).pop().includes('("Plain")'));
  });

  it("lowercases the receiver name", () => {
    assert.equal(receiverName("TextBlock"), "textBlock");
    assert.equal(receiverName("HUD"), "hud");
    assert.equal(receiverName("AIController"), "aiController");
    assert.equal(receiverName("UObject"), "uObject");
  });
});
