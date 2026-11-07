// Ambient API for abfc TypeScript sources. Types only: the emitted JavaScript is empty.
// Branded numbers and strings use "flavoring": literals assign to any flavor, flavors do not mix.

export type int = number & { readonly __bpNumber?: "int" };
export type int64 = number & { readonly __bpNumber?: "int64" };
export type byte = number & { readonly __bpNumber?: "byte" };
export type float = number & { readonly __bpNumber?: "float" };
export type double = number & { readonly __bpNumber?: "double" };

export type name = string & { readonly __bpString?: "name" };
/**
 * Localizable text. A template literal where a `text` is expected (`` `Hunger ${hunger}` ``) becomes a Format Text node: each
 * substitution is an argument named after its identifier or property, and literal `{`, `}` are escaped for you. An object literal
 * where a stub struct is expected (`{ Size: 12 }`) becomes a Make Struct node; spreads and computed names are not supported.
 */
export type text = string & { readonly __bpString?: "text" };

export type TSubclassOf<T> = { readonly __bpClassOf?: T };
export type TSoftObjectPtr<T> = { readonly __bpSoftObjectOf?: T };
export type TSoftClassPtr<T> = { readonly __bpSoftClassOf?: T };

/** Enum value as its T3D text (for example `"Collapsed"`); `P` is the enum path. */
export type EnumText<P extends string> = string & { readonly __bpEnum?: P };

/** A delegate argument: a reference to an own `@event` method (`this.ScanPlayers`). */
export type DelegateRef = { readonly __bpDelegate?: true } | ((...a: any[]) => void);

export interface SpawnOptions {
  owner?: object | null;
  instigator?: object | null;
  collisionHandlingOverride?: EnumText<"/Script/Engine.ESpawnActorCollisionHandlingMethod">;
  transformScaleMethod?: EnumText<"/Script/Engine.ESpawnActorScaleMethod">;
}

export interface BlueprintOptions {
  path: string;
  parent?: string;
  replicates?: boolean;
  alwaysRelevant?: boolean;
  onlyRelevantToOwner?: boolean;
  netUpdateFrequency?: number;
  minNetUpdateFrequency?: number;
  tickInterval?: number;
  /** Not supported yet (ABFC2063): writing the saved bStartWithTickEnabled is unverified. */
  tickEnabled?: boolean;
  /** row asset path, verified (Phase 2) */
  classManagerRow?: string;
  /** The asset is a Widget Blueprint; the class must extend a UserWidget. The designer layout (WidgetTree) stays hand-made; designer widgets are read-only members of the `_Manual` stub. */
  kind?: "widget";
}

export interface StructOptions {
  /** Package path of the struct asset under the mod, e.g. `/ExampleMod/Structs/S_Entry` (the object path is `<path>.<AssetName>`). */
  path: string;
}

export declare function blueprint(o: BlueprintOptions): <T extends abstract new (...a: any) => any>(c: T, ctx: ClassDecoratorContext<T>) => void;
/**
 * A mod-defined struct (UserDefinedStruct) created by abfc. Declare the fields as `Name!: Type;` (no initializer, no methods, no
 * `extends`, no containers). Use the class as a type: an object literal where it is expected becomes a Make Struct node and
 * reading a member of a value of it becomes a Break Struct node. Changing the fields after the struct was created is not supported yet.
 */
export declare function struct(o: StructOptions): <T extends abstract new (...a: any) => any>(c: T, ctx: ClassDecoratorContext<T>) => void;
export declare function event(m: (this: any, ...a: any[]) => void, ctx: ClassMethodDecoratorContext): void;
export declare function override(m: (this: any, ...a: any[]) => void, ctx: ClassMethodDecoratorContext): void;
export declare function createWidget<T>(cls: abstract new (...a: never[]) => T, owningPlayer: object | null): T;
export declare function spawnActor<T>(cls: abstract new (...a: never[]) => T, opts?: SpawnOptions): T;
export declare function nameOf(text: string): name;
export declare function cast<T>(value: object | null | undefined, cls: abstract new (...a: never[]) => T): T | null;
export declare function isValid<T>(value: T | null | undefined): value is T;
/** Integer division (truncates toward zero), Blueprint "Divide_IntInt". */
export declare function idiv(a: int, b: int): int;
