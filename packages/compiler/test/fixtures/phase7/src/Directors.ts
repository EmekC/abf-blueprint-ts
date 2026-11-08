import { blueprint, director, event, struct } from "@abfc/runtime";
import type { int } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";
import { UserWidget } from "/Script/UMG";

const ROW = "EntityDirector_Const";

@director("EntityDirector_Test")
@blueprint()
export class BPC_Dir extends Actor {
  @event
  Ping(): void {}
}

@director("EntityDirector_A")
@director("EntityDirector_B")
@blueprint()
export class BPC_DirTwo extends Actor {
  @event
  Ping(): void {}
}

@director("Bad-Row")
@blueprint()
export class BPC_BadRow extends Actor {
  @event
  Ping(): void {}
}

@director(ROW)
@blueprint()
export class BPC_NonLiteral extends Actor {
  @event
  Ping(): void {}
}

@director("EntityDirector_Widget")
@blueprint({ kind: "widget" })
export class W_Dir extends UserWidget {}

@director("EntityDirector_Struct")
@struct()
export class S_Dir {
  A!: int;
}

@director("entitydirector_test")
@blueprint()
export class BPC_DirDup extends Actor {
  @event
  Ping(): void {}
}

@director("EntityDirector_Both")
@blueprint({ classManagerRow: "/TestMod/DataTables/DT_ClassManager/EntityDirector_Both" })
export class BPC_Both extends Actor {
  @event
  Ping(): void {}
}

@blueprint({ classManagerRow: "/TestMod/DataTables/DT_ClassManager/EntityDirector_Old" })
export class BPC_OldRow extends Actor {
  @event
  Ping(): void {}
}
