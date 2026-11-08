// Curated defaults for very common engine functions whose trailing inputs the engine gives no metadata default but which the
// Blueprint editor places with the K2 zero value (bool "false", int "0") and which modders almost always leave so.
//
// Keyed by `${classPath}:${functionName}`, exactly like the `@bpPath` the stub emitter writes. A value is used only when the
// backend reported no default for that pin (a backend default always wins), and the usual trailing-run rule still decides which
// parameters become optional. An omitted argument sets no pin, so the node keeps the value Unreal places on a new node: this table
// only changes what TypeScript accepts, never graph content, and a value that is not the K2 zero text for the pin type would be
// wrong (the unit test pins that invariant).
//
// Every entry was checked against the generated engine stubs: the function is in the stubs, not blocked by the Blueprint filter,
// the pin is an input without an `@bpDefault`, the neighbouring functions of the same class do carry `@bpDefault` lines (so the
// metadata read worked and found none), and the engine declares no default for it. There is deliberately no general rule such as
// "trailing bools are optional": `RandomIntegerInRange(Min, Max)` or `SetActorHiddenInGame(bNewHidden)` stay explicit because a
// silent 0 or false would hide mistakes.
const SWEEP_TELEPORT: Readonly<Record<string, string>> = { bSweep: "false", bTeleport: "false" };
const PLAYER_INDEX: Readonly<Record<string, string>> = { PlayerIndex: "0" };

export const CURATED_DEFAULTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "/Script/Engine.GameplayStatics:GetPlayerCharacter": PLAYER_INDEX,
  "/Script/Engine.GameplayStatics:GetPlayerController": PLAYER_INDEX,
  "/Script/Engine.GameplayStatics:GetPlayerPawn": PLAYER_INDEX,
  "/Script/Engine.GameplayStatics:GetPlayerCameraManager": PLAYER_INDEX,
  "/Script/Engine.Actor:K2_SetActorLocation": SWEEP_TELEPORT,
  "/Script/Engine.Actor:K2_SetActorLocationAndRotation": SWEEP_TELEPORT,
  "/Script/Engine.Actor:K2_AddActorWorldOffset": SWEEP_TELEPORT,
  "/Script/Engine.Actor:K2_AddActorLocalOffset": SWEEP_TELEPORT,
  "/Script/Engine.Actor:K2_SetActorRelativeLocation": SWEEP_TELEPORT,
  "/Script/Engine.Actor:K2_AddActorWorldRotation": SWEEP_TELEPORT,
  "/Script/Engine.Actor:K2_AddActorLocalRotation": SWEEP_TELEPORT,
  "/Script/Engine.Actor:K2_SetActorRotation": { bTeleportPhysics: "false" },
};
