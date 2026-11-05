// Per-unit IR builder: lowers the statements and expressions of one HIR event into nodes and wires.
import { pinObjectText, unitHash } from "@abfc/ir";
import type { IrNode, IrUnit, IrVariable, IrWire, Profile, SemanticTag, Span } from "@abfc/ir";
import type { HirEvent, HirExpr, HirStmt, LocalId } from "../hir.js";
import { assignPositions } from "./layout.js";

/** `"<node>.<pin>"` */
type Exit = string;

interface LocalInfo {
  /** Value source pin. */
  pin?: string;
  /** Name of the temp variable holding the value (each use reads it again). */
  temp?: string;
  /** Exec exits taken when a cast (or optional chain) that produced this local failed. */
  pendingNull?: Exit[];
  execOuts?: Record<string, Exit[]>;
  /** Value is a literal (its default text). */
  lit?: string;
}

interface Value {
  pin: string;
  nulls: Exit[];
  execOuts?: Record<string, Exit[]>;
  pendingNull?: Exit[];
}

interface Operand {
  pin?: string;
  lit?: string;
  nulls: Exit[];
}

interface Extra {
  pinDefaults?: Record<string, string>;
  pinObjects?: Record<string, string>;
  pinTypes?: Record<string, string>;
}

const REAL_TYPES = new Set(["float", "double", "real"]);

/** Default text of a literal for a pin of the given type (undefined for null). */
export function formatLiteral(value: string | number | boolean | null, type: string): string | undefined {
  if (value === null) return undefined;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (REAL_TYPES.has(type)) return Number.isInteger(value) ? value.toFixed(1) : String(value);
    return String(value);
  }
  return value;
}

/** Whether control never leaves the statement list normally: it ends in a `return`, or an `if` whose branches both do. */
function exits(list: HirStmt[]): boolean {
  return list.some((s) => s.k === "return" || (s.k === "if" && exits(s.then) && exits(s.else)));
}

const idOf = (pin: string): string => pin.slice(0, pin.indexOf("."));
const wire = (a: string, b: string): IrWire => [a as `${string}.${string}`, b as `${string}.${string}`];
const shortName = (path: string): string => path.slice(path.lastIndexOf(".") + 1);

export class UnitBuilder {
  readonly vars: IrVariable[] = [];
  private readonly nodes: IrNode[] = [];
  private readonly wires: IrWire[] = [];
  private cur: Exit[] = [];
  private readonly locals = new Map<LocalId, LocalInfo>();
  private readonly roleCount = new Map<string, number>();
  private readonly getMemo = new Map<string, string>();
  private readonly brkMemo = new Map<string, string>();
  private readonly holes: string[] = [];
  /** Cast guards consumed by the condition being lowered (see the `if` statement). */
  private readonly guards: Array<{ info: LocalInfo; nulls: Exit[] }> = [];
  private params = new Map<string, string>();
  private entryId = "";
  private tempCount = 0;
  private loopCount = 0;

  constructor(
    private readonly profile: Profile,
    private readonly classMeta: Record<string, string>,
    private readonly event: HirEvent,
  ) {}

  build(): IrUnit {
    const P = this.profile.pins;
    const ev = this.event;
    const evSem: Extract<SemanticTag, { k: "event" }> = { k: "event", name: ev.name };
    if (ev.params.length > 0) evSem.params = ev.params.map((p) => ({ name: p.name, type: p.type }));
    this.entryId = this.emit("ev", this.profile.nodeClasses.customEvent, [`CustomFunctionName="${ev.name}"`], evSem, ev.span);
    for (const p of ev.params) this.params.set(p.name, `${this.entryId}.${p.name}`);
    this.cur = [`${this.entryId}.${P.then}`];
    this.stmts(ev.body);
    const unit: IrUnit = {
      id: `event:${ev.name}`,
      kind: "event",
      name: ev.name,
      graph: "EventGraph",
      signature: { inputs: ev.params.map((p) => ({ name: p.name, type: p.type })), outputs: [] },
      locals: [],
      nodes: this.nodes,
      wires: this.wires,
      origin: ev.span,
      hash: "",
    };
    assignPositions(unit, P.execute);
    unit.hash = unitHash(unit);
    return unit;
  }

  // ---- emission helpers ----

  private emit(role: string, cls: string, props: string[], sem: SemanticTag | undefined, origin: Span, extra?: Extra): string {
    const n = this.roleCount.get(role) ?? 0;
    this.roleCount.set(role, n + 1);
    const node: IrNode = { id: `${role}${n}`, t3d: { class: cls, props }, pos: [0, 0], origin };
    if (sem) node.sem = sem;
    if (extra?.pinDefaults && Object.keys(extra.pinDefaults).length > 0) node.pinDefaults = extra.pinDefaults;
    if (extra?.pinObjects && Object.keys(extra.pinObjects).length > 0) node.pinObjects = extra.pinObjects;
    if (extra?.pinTypes && Object.keys(extra.pinTypes).length > 0) node.pinTypes = extra.pinTypes;
    this.nodes.push(node);
    return node.id;
  }

  private link(from: string, to: string): void {
    this.wires.push(wire(from, to));
  }

  private execInto(id: string): void {
    const P = this.profile.pins;
    for (const x of this.cur) this.link(x, `${id}.${P.execute}`);
    this.cur = [`${id}.${P.then}`];
  }

  private funcRef(owner: string | null, name: string): string {
    return owner === null
      ? `FunctionReference=(MemberName="${name}",bSelfContext=True)`
      : `FunctionReference=(MemberParent="${pinObjectText("class", owner, this.classMeta)}",MemberName="${name}")`;
  }

  private varRef(name: string, owner?: string): string {
    return owner === undefined
      ? `VariableReference=(MemberName="${name}",bSelfContext=True)`
      : `VariableReference=(MemberParent="${pinObjectText("class", owner, this.classMeta)}",MemberName="${name}")`;
  }

  private getVar(name: string, origin: Span): string {
    const id = this.emit("get", this.profile.nodeClasses.variableGet, [this.varRef(name)], { k: "get", name }, origin);
    return `${id}.${name}`;
  }

  private setVar(name: string, origin: Span, extra?: Extra): string {
    return this.emit("set", this.profile.nodeClasses.variableSet, [this.varRef(name)], { k: "set", name }, origin, extra);
  }

  private pureCall(owner: string, name: string, origin: Span, extra?: Extra): string {
    return this.emit(
      "call",
      this.profile.nodeClasses.callFunction,
      ["bIsPureFunc=True", this.funcRef(owner, name)],
      { k: "call", class: owner, function: name },
      origin,
      extra,
    );
  }

  private isValidCall(objectPin: string, origin: Span): string {
    const f = this.profile.functions.isValid;
    const id = this.pureCall(f.class, f.name, origin);
    this.link(objectPin, `${id}.${this.profile.pins.isValidObject}`);
    return `${id}.${this.profile.pins.returnValue}`;
  }

  private branch(condPin: string | undefined, condLit: string | undefined, origin: Span): string {
    const id = this.emit("br", this.profile.nodeClasses.branch, [], { k: "branch" }, origin,
      condLit !== undefined ? { pinDefaults: { [this.profile.pins.condition]: condLit } } : undefined);
    this.execInto(id);
    if (condPin !== undefined) this.link(condPin, `${id}.${this.profile.pins.condition}`);
    return id;
  }

  private local(id: LocalId): LocalInfo {
    const l = this.locals.get(id);
    if (!l) throw new Error(`lowering: unknown local #${id}`);
    return l;
  }

  private unsupported(what: string, span: Span): never {
    throw new Error(`ABFC2099: ${span.file}:${span.line}:${span.col}: ${what} is not supported in lowering`);
  }

  // ---- expressions ----

  private operand(e: HirExpr, asType?: string): Operand {
    if (e.k === "lit") {
      const lit = formatLiteral(e.value, asType ?? e.type);
      if (lit === undefined) return this.unsupported("a null literal here", e.span);
      return { lit, nulls: [] };
    }
    if (e.k === "local") {
      const l = this.local(e.id);
      if (l.lit !== undefined) return { lit: l.lit, nulls: [] };
    }
    const v = this.value(e);
    return { pin: v.pin, nulls: v.nulls };
  }

  /** Wires an operand into `<id>.<pin>` (pin or default). */
  private feed(o: Operand, id: string, pin: string, defaults: Record<string, string>): void {
    if (o.pin !== undefined) this.link(o.pin, `${id}.${pin}`);
    else if (o.lit !== undefined) defaults[pin] = o.lit;
  }

  private value(e: HirExpr): Value {
    const P = this.profile.pins;
    switch (e.k) {
      case "self": {
        const id = this.emit("self", "/Script/BlueprintGraph.K2Node_Self", [], { k: "self" }, e.span);
        return { pin: `${id}.${P.self}`, nulls: [] };
      }
      case "param": {
        const pin = this.params.get(e.name);
        if (pin === undefined) return this.unsupported(`parameter ${e.name}`, e.span);
        return { pin, nulls: [] };
      }
      case "local": {
        const l = this.local(e.id);
        if (l.temp !== undefined) return { pin: this.getVar(l.temp, e.span), nulls: [] };
        if (l.pin === undefined) return this.unsupported("a local without a value", e.span);
        return { pin: l.pin, nulls: [] };
      }
      case "lit":
        return this.unsupported("a literal in this position", e.span);
      case "getSelf":
        return { pin: this.getVar(e.name, e.span), nulls: [] };
      case "getOn": {
        const src = this.value(e.obj);
        const key = `${src.pin}|${e.owner}|${e.name}`;
        let id = this.getMemo.get(key);
        if (id === undefined) {
          id = this.emit("get", this.profile.nodeClasses.variableGet, [this.varRef(e.name, e.owner)],
            { k: "get", name: e.name, class: e.owner }, e.span);
          this.getMemo.set(key, id);
          this.link(src.pin, `${id}.${P.self}`);
        }
        return { pin: `${id}.${e.name}`, nulls: src.nulls };
      }
      case "field": {
        const src = this.value(e.obj);
        let id = this.brkMemo.get(src.pin);
        if (id === undefined) {
          id = this.emit("brk", this.profile.nodeClasses.breakStruct,
            ["bMadeAfterOverridePinRemoval=True", `StructType="${pinObjectText("struct", e.struct, this.classMeta)}"`], undefined, e.span);
          this.brkMemo.set(src.pin, id);
          this.link(src.pin, `${id}.${shortName(e.struct)}`);
        }
        return { pin: `${id}.${e.name}`, nulls: src.nulls };
      }
      case "out": {
        const v = this.value(e.call);
        return { pin: `${idOf(v.pin)}.${e.pin}`, nulls: v.nulls };
      }
      case "call":
        return this.call(e);
      case "cast": {
        const v = this.value(e.value);
        const id = this.emit("cast", this.profile.nodeClasses.dynamicCast,
          [`TargetType="${pinObjectText("class", e.target, this.classMeta)}"`], { k: "cast", target: e.target }, e.span,
          { pinTypes: { [P.castObject]: this.profile.castObjectPinType } });
        this.execInto(id);
        this.link(v.pin, `${id}.${P.castObject}`);
        return { pin: `${id}.${e.castPin}`, nulls: [], pendingNull: [...v.nulls, `${id}.${P.castFailed}`] };
      }
      case "optional": {
        const v = this.value(e.value);
        const nulls = [...v.nulls];
        const info = e.value.k === "local" ? this.local(e.value.id) : undefined;
        if (info?.pendingNull !== undefined) {
          nulls.push(...info.pendingNull);
          // the null exits rejoin the main path through `nulls`, so a later use must check validity again
          delete info.pendingNull;
        } else {
          const valid = this.isValidCall(v.pin, e.span);
          const br = this.branch(valid, undefined, e.span);
          this.cur = [`${br}.${P.then}`];
          nulls.push(`${br}.${P.else}`);
        }
        this.holes.push(v.pin);
        const t = this.value(e.then);
        this.holes.pop();
        return { pin: t.pin, nulls: [...nulls, ...t.nulls] };
      }
      case "hole": {
        const pin = this.holes[this.holes.length - 1];
        if (pin === undefined) return this.unsupported("a stray optional-chain hole", e.span);
        return { pin, nulls: [] };
      }
      case "isValid": {
        const v = this.value(e.value);
        return { pin: this.isValidCall(v.pin, e.span), nulls: v.nulls };
      }
      case "eq": {
        const kindType = e.kind === "real" ? "real" : e.kind;
        let a = this.operand(e.a, kindType);
        let b = this.operand(e.b, kindType);
        if (a.lit !== undefined && b.lit === undefined) [a, b] = [b, a];
        const fn = this.profile.functions[e.negate ? "notEqual" : "equal"][e.kind];
        const defaults: Record<string, string> = {};
        const id = this.pureCall(fn.class, fn.name, e.span);
        this.feed(a, id, P.opA, defaults);
        this.feed(b, id, P.opB, defaults);
        if (Object.keys(defaults).length > 0) this.nodes.find((n) => n.id === id)!.pinDefaults = defaults;
        return { pin: `${id}.${P.returnValue}`, nulls: [...a.nulls, ...b.nulls] };
      }
      case "length": {
        const arr = this.value(e.array);
        const f = this.profile.functions.arrayLength;
        const id = this.emit("arr", this.profile.nodeClasses.callArrayFunction,
          ["bIsPureFunc=True", this.funcRef(f.class, f.name)], undefined, e.span,
          { pinTypes: { [P.arrayLengthArray]: e.arrayType } });
        this.link(arr.pin, `${id}.${P.arrayLengthArray}`);
        return { pin: `${id}.${P.returnValue}`, nulls: arr.nulls };
      }
      case "not":
      case "and":
      case "or":
      case "execIs":
        return this.unsupported(`'${e.k}' as a value`, e.span);
    }
  }

  private call(e: Extract<HirExpr, { k: "call" }>): Value {
    const P = this.profile.pins;
    const nulls: Exit[] = [];
    const target = e.target ? this.value(e.target) : null;
    if (target) nulls.push(...target.nulls);
    const defaults: Record<string, string> = {};
    const fed: Array<{ pin: string; o: Operand }> = [];
    for (const a of e.args) {
      if (a.value.k === "lit" && a.value.value === null) continue;
      const o = this.operand(a.value);
      nulls.push(...o.nulls);
      fed.push({ pin: a.pin, o });
    }
    const props = e.pure ? ["bIsPureFunc=True"] : [];
    props.push(this.funcRef(e.owner, e.name));
    const sem: SemanticTag = e.owner === null
      ? { k: "call", function: e.name }
      : { k: "call", class: e.owner, function: e.name };
    const id = this.emit("call", this.profile.nodeClasses.callFunction, props, sem, e.span);
    if (!e.pure) this.execInto(id);
    if (target) this.link(target.pin, `${id}.${P.self}`);
    for (const f of fed) this.feed(f.o, id, f.pin, defaults);
    if (Object.keys(defaults).length > 0) this.nodes.find((n) => n.id === id)!.pinDefaults = defaults;
    const result: Value = { pin: `${id}.${P.returnValue}`, nulls };
    if (e.execOutputs) {
      this.cur = [];
      result.execOuts = Object.fromEntries(e.execOutputs.map((p) => [p, [`${id}.${p}`]]));
    }
    return result;
  }

  // ---- conditions ----

  private cond(e: HirExpr, from: Exit[]): { t: Exit[]; f: Exit[] } {
    const P = this.profile.pins;
    this.cur = from;
    switch (e.k) {
      case "and": {
        const a = this.cond(e.a, from);
        const b = this.cond(e.b, a.t);
        return { t: b.t, f: [...a.f, ...b.f] };
      }
      case "or": {
        const a = this.cond(e.a, from);
        const b = this.cond(e.b, a.f);
        return { t: [...a.t, ...b.t], f: b.f };
      }
      case "not": {
        const r = this.cond(e.e, from);
        return { t: r.f, f: r.t };
      }
      case "local": {
        const l = this.local(e.id);
        if (l.pendingNull !== undefined) {
          const f = l.pendingNull;
          // stays an (empty) guard for now: `if` drops it again when the null path can rejoin
          l.pendingNull = [];
          this.guards.push({ info: l, nulls: f });
          return { t: from, f };
        }
        break;
      }
      case "execIs": {
        const outs = this.local(e.local).execOuts ?? {};
        const t = outs[e.pin] ?? [];
        const f = Object.entries(outs).filter(([k]) => k !== e.pin).flatMap(([, v]) => v);
        return e.negate ? { t: f, f: t } : { t, f };
      }
      case "isValid": {
        const v = this.value(e.value);
        const br = this.branch(this.isValidCall(v.pin, e.span), undefined, e.span);
        return { t: [`${br}.${P.then}`], f: [...v.nulls, `${br}.${P.else}`] };
      }
      default:
        break;
    }
    const o = this.operand(e);
    let condPin = o.pin;
    if (condPin !== undefined && e.type.startsWith("object:")) condPin = this.isValidCall(condPin, e.span);
    const br = this.branch(condPin, condPin === undefined ? o.lit : undefined, e.span);
    return { t: [`${br}.${P.then}`], f: [...o.nulls, `${br}.${P.else}`] };
  }

  // ---- statements ----

  private stmts(list: HirStmt[]): void {
    for (const s of list) this.stmt(s);
  }

  private stmt(s: HirStmt): void {
    const P = this.profile.pins;
    switch (s.k) {
      case "expr": {
        const v = this.value(s.e);
        if (v.nulls.length > 0) this.cur = [...this.cur, ...v.nulls];
        return;
      }
      case "setSelf": {
        const defaults: Record<string, string> = {};
        let o: Operand | null = null;
        if (!(s.value.k === "lit" && s.value.value === null)) o = this.operand(s.value, s.type);
        const id = this.setVar(s.name, s.span);
        this.execInto(id);
        if (o) this.feed(o, id, s.name, defaults);
        if (Object.keys(defaults).length > 0) this.nodes.find((n) => n.id === id)!.pinDefaults = defaults;
        if (o && o.nulls.length > 0) this.cur = [...this.cur, ...o.nulls];
        return;
      }
      case "const": {
        const init = s.init;
        if (init.k === "lit") {
          const lit = formatLiteral(init.value, init.type);
          this.locals.set(s.local, lit === undefined ? {} : { lit });
          return;
        }
        const v = this.value(init);
        if (init.k === "call" && init.pure && s.uses >= 2) {
          const name = `abfc_${this.event.name}_t${this.tempCount++}`;
          this.vars.push({ name, type: init.type === "void" || init.type === "null" ? "name" : init.type, flags: ["transient"], origin: s.span, temp: true });
          const set = this.setVar(name, s.span);
          this.execInto(set);
          this.link(v.pin, `${set}.${name}`);
          this.locals.set(s.local, { temp: name });
          return;
        }
        if (v.nulls.length > 0) this.unsupported("an optional chain bound to a constant", s.span);
        const info: LocalInfo = { pin: v.pin };
        if (v.execOuts) info.execOuts = v.execOuts;
        if (v.pendingNull) info.pendingNull = v.pendingNull;
        this.locals.set(s.local, info);
        return;
      }
      case "if": {
        const mark = this.guards.length;
        const c = this.cond(s.cond, this.cur);
        const consumed = this.guards.splice(mark);
        // a branch entered from a failed cast may mix in other exits where the local is still nullable: `?.` must check validity there
        const enter = (side: Exit[], body: HirStmt[]): void => {
          const hit = consumed.filter((g) => g.nulls.some((x) => side.includes(x)));
          const saved = hit.map((g) => g.info.pendingNull);
          for (const g of hit) delete g.info.pendingNull;
          this.stmts(body);
          hit.forEach((g, i) => {
            if (saved[i] !== undefined) g.info.pendingNull = saved[i];
          });
        };
        this.cur = c.t;
        enter(c.t, s.then);
        const endThen = this.cur;
        this.cur = c.f;
        enter(c.f, s.else);
        this.cur = [...endThen, ...this.cur];
        // a cast local stays known-valid after the `if` only when every branch the failed cast went into ends in an exit
        for (const g of consumed) {
          const rejoins = (side: Exit[], body: HirStmt[]): boolean => g.nulls.some((x) => side.includes(x)) && !exits(body);
          if (rejoins(c.t, s.then) || rejoins(c.f, s.else)) delete g.info.pendingNull;
        }
        return;
      }
      case "return":
        this.cur = [];
        return;
      case "forOf": {
        const arr = this.value(s.array);
        const counter = `abfc_${this.event.name}_i${this.loopCount++}`;
        this.vars.push({ name: counter, type: "int", flags: ["transient"], origin: s.span, temp: true });
        const init = this.setVar(counter, s.span, { pinDefaults: { [counter]: "0" } });
        this.execInto(init);
        const head = this.branch(undefined, undefined, s.span);
        const getI = this.getVar(counter, s.span);
        const f = this.profile.functions.arrayLength;
        const len = this.emit("arr", this.profile.nodeClasses.callArrayFunction,
          ["bIsPureFunc=True", this.funcRef(f.class, f.name)], undefined, s.span,
          { pinTypes: { [P.arrayLengthArray]: s.array.type } });
        this.link(arr.pin, `${len}.${P.arrayLengthArray}`);
        const less = this.pureCall(this.profile.functions.lessInt.class, this.profile.functions.lessInt.name, s.span);
        this.link(getI, `${less}.${P.opA}`);
        this.link(`${len}.${P.returnValue}`, `${less}.${P.opB}`);
        this.link(`${less}.${P.returnValue}`, `${head}.${P.condition}`);
        this.cur = [`${head}.${P.then}`];
        const getI2 = this.getVar(counter, s.span);
        const item = this.emit("item", this.profile.nodeClasses.getArrayItem, ["bReturnByRefDesired=False"], undefined, s.span,
          { pinTypes: { [P.getItemArray]: s.array.type, [P.getItemOutput]: s.elem } });
        this.link(arr.pin, `${item}.${P.getItemArray}`);
        this.link(getI2, `${item}.${P.getItemIndex}`);
        this.locals.set(s.local, { pin: `${item}.${P.getItemOutput}` });
        this.stmts(s.body);
        const getI3 = this.getVar(counter, s.span);
        const add = this.pureCall(this.profile.functions.addInt.class, this.profile.functions.addInt.name, s.span,
          { pinDefaults: { [P.opB]: "1" } });
        this.link(getI3, `${add}.${P.opA}`);
        const inc = this.setVar(counter, s.span);
        this.execInto(inc);
        this.link(`${add}.${P.returnValue}`, `${inc}.${counter}`);
        this.link(`${inc}.${P.then}`, `${head}.${P.execute}`);
        this.cur = [`${head}.${P.else}`];
        return;
      }
    }
  }
}
