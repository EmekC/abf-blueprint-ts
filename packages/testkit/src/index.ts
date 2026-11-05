// Test API for `*.test.ts` files. abfc compiles these files statically (statements -> bp_game_test steps); nothing here
// runs in Node, so the runtime functions only exist to give a clear message when someone executes a test file.

export type Ctor = abstract new (...a: never[]) => unknown;

export interface Value<T> {
  readonly __value?: T;
}

export interface Assertion {
  /** Marks a pre-existing failure: a failing step becomes warning ABFC6102, a passing one ABFC6103. */
  knownIssue(reason: string): void;
}

export interface Expectation<T> {
  equals(v: T | null | boolean | number | string): Assertion;
  approx(v: number, tolerance?: number): Assertion;
  contains(s: string): Assertion;
  truthy(): Assertion;
  notNone(): Assertion;
}

export interface Handle<T> {
  call<K extends keyof T & string>(
    fn: K,
    ...args: T[K] extends (...a: infer A) => any ? A : never
  ): Value<T[K] extends (...a: any) => infer R ? R : never>;
  get<K extends keyof T & string>(prop: K): Value<T[K]>;
  set<K extends keyof T & string>(prop: K, value: T[K]): void;
}

export interface TestContext {
  spawn<C extends Ctor>(cls: C): Handle<InstanceType<C>>;
  widget<C extends Ctor>(cls: C): Handle<InstanceType<C>>;
  wait(seconds: number): void;
  python(code: string, o?: { knownIssue?: string }): Value<unknown>;
  expect<T>(v: Value<T>): Expectation<T>;
}

export function test(_name: string, _body: (t: TestContext) => void | Promise<void>): void {
  throw new Error("testkit files are compiled by abfc, not run");
}
