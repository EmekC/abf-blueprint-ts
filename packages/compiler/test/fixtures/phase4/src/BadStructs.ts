import { struct } from "@abfc/runtime";
import type { int, name } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";

@struct({ path: "/TestMod/Phase4/S_Method" })
export class S_Method {
  A!: int;
  Run(): void {} // ABFC2046
}

@struct({ path: "/TestMod/Phase4/S_Init" })
export class S_Init {
  A: int = 1; // ABFC2046
}

@struct({ path: "/TestMod/Phase4/S_Arr" })
export class S_Arr {
  Items!: int[]; // ABFC2046
}

@struct({ path: "/TestMod/Phase4/S_Map" })
export class S_Map {
  M!: Map<name, int>; // ABFC2046
}

@struct({ path: "/TestMod/Phase4/S_Empty" })
export class S_Empty {} // ABFC2046

@struct({ path: "/TestMod/Phase4/S_Ext" })
export class S_Ext extends Actor { // ABFC2046
  A!: int;
}

@struct({ path: "/Other/Phase4/S_Elsewhere" }) // ABFC2046
export class S_Elsewhere {
  A!: int;
}
