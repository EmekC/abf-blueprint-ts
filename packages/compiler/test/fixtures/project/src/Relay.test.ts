import { test } from "@abfc/testkit";
import { BP_Relay } from "./Relay.js";

test("update target clears without a pot", (t) => {
  const relay = t.spawn(BP_Relay);
  relay.call("UpdateTarget");
  t.expect(relay.get("Visible")).equals(false);
  const last = t.python("result=str(ctx['relay'].get_editor_property('LastTarget'))");
  t.expect(last).equals("None");
  t.wait(0.5);
});

test("assertion forms", async (t) => {
  const relay = t.spawn(BP_Relay);
  relay.set("Visible", true);
  const vis = relay.get("Visible");
  t.expect(vis).truthy();
  t.expect(relay.get("LastName")).contains("Row");
  t.expect(relay.call("HideAll")).notNone().knownIssue("pre-existing");
  const v = t.python("result=1.0", { knownIssue: "wrong name in this build" });
  t.expect(v).approx(1, 0.01);
  t.python("result=None");
});
