import { test } from "@abfc/testkit";
import { WBP_ExampleInfo } from "./Widget.js";

test.liveHud("HUD shows the example panel", ["Start Play In Editor", "Look at the example item; the panel appears", "Look away; the panel hides"], (t) => {
  const w = t.widget(WBP_ExampleInfo);
  w.call("Join", "x");
  t.wait(0.5);
});

test("hidden test next to a live one", (t) => {
  t.wait(0.1);
});
