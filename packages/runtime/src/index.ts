// Ambient API for abfc TypeScript sources. Types only: the emitted JavaScript is empty.
// Branded numbers and strings use "flavoring": literals assign to any flavor, flavors do not mix.

export type int = number & { readonly __bpNumber?: "int" };
export type int64 = number & { readonly __bpNumber?: "int64" };
export type byte = number & { readonly __bpNumber?: "byte" };
export type float = number & { readonly __bpNumber?: "float" };
export type double = number & { readonly __bpNumber?: "double" };

export type name = string & { readonly __bpString?: "name" };
export type text = string & { readonly __bpString?: "text" };

export type TSubclassOf<T> = { readonly __bpClassOf?: T };
export type TSoftObjectPtr<T> = { readonly __bpSoftObjectOf?: T };
export type TSoftClassPtr<T> = { readonly __bpSoftClassOf?: T };

// Only `path` and `parent` are honored in Phase 1; the other design 4.1 options are Phase 2 (the frontend warns ABFC2099 if used).
export interface BlueprintOptions {
  path: string;
  parent?: string;
  replicates?: boolean;
  alwaysRelevant?: boolean;
  onlyRelevantToOwner?: boolean;
  netUpdateFrequency?: number;
  minNetUpdateFrequency?: number;
  tickInterval?: number;
  tickEnabled?: boolean;
  classManagerRow?: string;
  kind?: "widget";
}

export declare function blueprint(o: BlueprintOptions): <T extends abstract new (...a: any) => any>(c: T, ctx: ClassDecoratorContext<T>) => void;
export declare function event(m: (this: any, ...a: any[]) => void, ctx: ClassMethodDecoratorContext): void;
export declare function cast<T>(value: object | null | undefined, cls: abstract new (...a: never[]) => T): T | null;
export declare function isValid<T>(value: T | null | undefined): value is T;
