// One reflect call for everything (the measured fast path); when it throws, the classes are retried in chunks and a failing chunk
// is halved until the single classes that break the backend are known. The cost is paid only when something breaks.
import type { Backend, ReflectRequest, ReflectResult } from "@abfc/backend";

/** Classes per call in the fallback. */
export const REFLECT_CHUNK = 500;

/** Single classes that may fail before the first success for the retry to give up and rethrow the first error. */
const MAX_LEAF_FAILURES_WITHOUT_SUCCESS = 4;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Adds `add` to `into` without overwriting: records are merged key by key (a key already there stays), arrays are concatenated and
 * scalars are taken when `into` has none. Generic on purpose: a field a newer backend adds to the reflect data survives.
 */
function mergeGeneric(into: Record<string, unknown>, add: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(add)) {
    const cur = into[k];
    if (cur === undefined || cur === null) {
      into[k] = Array.isArray(v) ? [...v] : isRecord(v) ? { ...v } : v;
    } else if (Array.isArray(cur) && Array.isArray(v)) {
      cur.push(...v);
    } else if (isRecord(cur) && isRecord(v)) {
      for (const [kk, vv] of Object.entries(v)) if (cur[kk] === undefined) cur[kk] = vv;
    }
  }
}

/** The predicate `abfc generate` uses to merge rounds: Blueprint classes were reflected (not just cast targets) but the cooked-class reader did not run. */
export function lacksCookedClass(data: Pick<ReflectResult["data"], "classes" | "memberSources">): boolean {
  const reflectedGame = Object.entries(data.classes).some(([p, c]) => p.startsWith("/Game/") && c.castOnly !== true);
  return reflectedGame && !(data.memberSources ?? []).includes("cookedClass");
}

const halves = <T>(xs: T[]): [T[], T[]] => {
  const mid = Math.ceil(xs.length / 2);
  return [xs.slice(0, mid), xs.slice(mid)];
};

export async function reflectAll(
  backend: Backend,
  req: ReflectRequest,
  report: (line: string) => void,
): Promise<{ result: ReflectResult; failed: string[] }> {
  try {
    return { result: await backend.reflect(req), failed: [] };
  } catch (e) {
    if (req.classes.length <= 1) throw e;
    return await reflectInParts(backend, req, report, e);
  }
}

async function reflectInParts(
  backend: Backend,
  req: ReflectRequest,
  report: (line: string) => void,
  firstError: unknown,
): Promise<{ result: ReflectResult; failed: string[] }> {
  const chunks: string[][] = [];
  if (req.classes.length > REFLECT_CHUNK) {
    for (let i = 0; i < req.classes.length; i += REFLECT_CHUNK) chunks.push(req.classes.slice(i, i + REFLECT_CHUNK));
  } else {
    chunks.push(...halves(req.classes)); // the whole list just failed: splitting it is the first retry
  }
  const targets = new Set(req.castTargets);
  const failed: string[] = [];
  const st: { data: Record<string, unknown> | null; head: ReflectResult | null; seconds: number } = { data: null, head: null, seconds: 0 };
  let tagsSent = false;
  let leafFailures = 0;
  let cookedMissing = false;

  const call = async (classes: string[], label: string): Promise<boolean> => {
    report(`stubs: reflect ${label} (${classes.length} classes)`);
    const part: ReflectRequest = {
      ...req,
      classes,
      castTargets: classes.filter((c) => targets.has(c)),
    };
    if (tagsSent) {
      delete part.gameplayTags;
      part.structs = [];
    }
    try {
      const r = await backend.reflect(part);
      tagsSent = true;
      st.seconds += r.seconds;
      st.head ??= r;
      if (lacksCookedClass(r.data)) cookedMissing = true;
      st.data ??= {};
      mergeGeneric(st.data, r.data as unknown as Record<string, unknown>);
      return true;
    } catch (e) {
      if (classes.length <= 1) {
        failed.push(...classes);
        leafFailures++;
        // Nothing has worked yet and single classes keep failing: the cause is not a class (the editor does not start, a timeout), so stop.
        if (st.data === null && leafFailures >= MAX_LEAF_FAILURES_WITHOUT_SUCCESS) throw firstError;
        return false;
      }
      const [a, b] = halves(classes);
      const okA = await call(a, `${label} (first half)`);
      const okB = await call(b, `${label} (second half)`);
      return okA || okB;
    }
  };

  let any = false;
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i]!.length === 0) continue;
    if (await call(chunks[i]!, `chunk ${i + 1}/${chunks.length}`)) any = true;
  }
  if (!any || st.head === null || st.data === null) throw firstError;
  // The union of the chunks' member sources must not hide a chunk whose cooked-class reader failed (ABFC3014 reads the gap).
  if (Array.isArray(st.data.memberSources)) {
    const sources = (st.data.memberSources as unknown[]).filter((s) => !(cookedMissing && s === "cookedClass"));
    st.data.memberSources = [...new Set(sources)];
  }
  const first = st.head;
  return { result: { ...first, seconds: st.seconds, data: st.data as unknown as ReflectResult["data"], filter: first.filter }, failed: [...new Set(failed)].sort() };
}
