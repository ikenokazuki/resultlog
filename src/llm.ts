import { settings } from "./options.js";
import { als, type Store } from "./state.js";

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Tokens served from the provider's prompt cache. */
  cachedTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface LlmCall extends LlmUsage {
  model?: string;
  finishReason?: string;
  /** Time to the first chunk of a stream (ms). */
  ttftMs?: number;
}

export interface LlmTotals extends Required<LlmUsage> {
  calls: number;
  models: Record<string, { calls: number; inputTokens: number; outputTokens: number }>;
  finishReasons: Record<string, number>;
  truncated: number;
  blocked: number;
  interrupted: number;
  unrecognized: number;
  ttftMs?: number;
  cost?: number;
}

const TOKEN_FIELDS = ["inputTokens", "outputTokens", "totalTokens", "cachedTokens", "cacheWriteTokens", "reasoningTokens"] as const;

const MAX_MODELS = 10;

// The vocabulary providers share, not a list of providers. A key that names a token count says what it counts.
const MODEL_KEY = /^model(_?id|_?version)?$/i;

const FINISH_KEY = /^(finish|stop)_?reason$/i;

const USAGE_KEY = /usage/i;

const OUT_OF_ROOM = /length|max.?tokens|context.?window/i;

const WITHHELD = /filter|safety|refus|block|prohibit|recitation|spii/i;

/** Breadth-first over objects and the first items of arrays, so that what is near the top is found first. */
function* walk(root: unknown, maxDepth: number): Generator<[key: string, value: unknown, depth: number]> {
  let level: unknown[] = [root];
  let visited = 0;
  for (let depth = 0; depth <= maxDepth; depth++) {
    const next: unknown[] = [];
    for (const node of level) {
      if (typeof node !== "object" || node === null) continue;
      const entries: [string, unknown][] = Array.isArray(node)
        ? node.slice(0, 3).map((value, index) => [String(index), value])
        : Object.entries(node);
      for (const [key, value] of entries) {
        if (++visited > 300) return;
        yield [key, value, depth];
        next.push(value);
      }
    }
    level = next;
  }
}

function tokenField(key: string): (typeof TOKEN_FIELDS)[number] | undefined {
  if (!/token/i.test(key)) return undefined;
  if (/cach/i.test(key)) return /creat|writ/i.test(key) ? "cacheWriteTokens" : "cachedTokens";
  if (/reason|thought|think/i.test(key)) return "reasoningTokens";
  if (/total/i.test(key)) return "totalTokens";
  if (/input|prompt/i.test(key)) return "inputTokens";
  if (/output|completion|candidate|generat/i.test(key)) return "outputTokens";
  return undefined;
}

/** What an LLM response, or one chunk of a stream, says about itself. The first match for each field wins. */
function scanLlm(response: unknown): LlmCall {
  const call: LlmCall = {};
  try {
    let usage: unknown;
    for (const [key, value, depth] of walk(response, 3)) {
      if (typeof value === "string" && call.model === undefined && depth <= 2 && MODEL_KEY.test(key)) call.model = value;
      else if (typeof value === "string" && call.finishReason === undefined && FINISH_KEY.test(key)) call.finishReason = value;
      else if (usage === undefined && USAGE_KEY.test(key) && typeof value === "object" && value !== null && !Array.isArray(value)) {
        usage = value;
      }
    }
    for (const [key, value] of walk(usage ?? response, 2)) {
      const field = tokenField(key);
      if (field && call[field] === undefined && typeof value === "number" && Number.isFinite(value) && value >= 0) call[field] = value;
    }
  } catch {} // a response whose properties throw is simply not recognized
  return call;
}

function addLlmCall(store: Store, call: LlmCall, interrupted = false): void {
  const totals = (store.llm ??= {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    models: {},
    finishReasons: {},
    truncated: 0,
    blocked: 0,
    interrupted: 0,
    unrecognized: 0,
  });
  totals.calls++;
  for (const field of TOKEN_FIELDS) totals[field] += call[field] ?? 0;
  const model = call.model;
  if (model !== undefined && (model in totals.models || Object.keys(totals.models).length < MAX_MODELS)) {
    const perModel = (totals.models[model] ??= { calls: 0, inputTokens: 0, outputTokens: 0 });
    perModel.calls++;
    perModel.inputTokens += call.inputTokens ?? 0;
    perModel.outputTokens += call.outputTokens ?? 0;
  }
  if (call.finishReason !== undefined) {
    totals.finishReasons[call.finishReason] = (totals.finishReasons[call.finishReason] ?? 0) + 1;
    if (OUT_OF_ROOM.test(call.finishReason)) totals.truncated++;
    else if (WITHHELD.test(call.finishReason)) totals.blocked++;
  }
  if (interrupted) totals.interrupted++;
  else if (TOKEN_FIELDS.every((field) => call[field] === undefined)) totals.unrecognized++;
  if (call.ttftMs !== undefined) totals.ttftMs = Math.max(totals.ttftMs ?? 0, call.ttftMs);
  try {
    const cost = settings.price?.(call);
    if (typeof cost === "number" && Number.isFinite(cost)) totals.cost = (totals.cost ?? 0) + cost;
  } catch {} // a broken price function must not break logging
}

/** The entry's `llm` field: only what is non-zero. */
export function summarizeLlm(store: Store): { llm?: Record<string, unknown> } {
  const totals = store.llm;
  if (!totals) return {};
  const summary: Record<string, unknown> = { calls: totals.calls };
  for (const field of TOKEN_FIELDS) if (totals[field] > 0) summary[field] = totals[field];
  if (Object.keys(totals.models).length > 0) summary.models = totals.models;
  if (Object.keys(totals.finishReasons).length > 0) summary.finishReasons = totals.finishReasons;
  for (const flag of ["truncated", "blocked", "interrupted", "unrecognized"] as const) if (totals[flag] > 0) summary[flag] = totals[flag];
  if (totals.ttftMs !== undefined) summary.ttftMs = Math.round(totals.ttftMs);
  if (totals.cost !== undefined) summary.cost = Math.round(totals.cost * 1e9) / 1e9; // a call costs a fraction of a cent: keep the digits
  return { llm: summary };
}

/** Passes the chunks through. Providers report running totals, so the largest figure seen is the final one. */
async function* observeStream(store: Store | undefined, stream: AsyncIterable<unknown>, explicit: LlmCall): AsyncGenerator<unknown, void, undefined> {
  const started = performance.now();
  const seen: LlmCall = {};
  let chunks = 0;
  let finished = false;
  try {
    for await (const chunk of stream) {
      if (chunks++ === 0) seen.ttftMs = performance.now() - started;
      const from = scanLlm(chunk);
      for (const field of TOKEN_FIELDS) if (from[field] !== undefined) seen[field] = Math.max(seen[field] ?? 0, from[field]);
      seen.model ??= from.model;
      seen.finishReason = from.finishReason ?? seen.finishReason; // the last chunk has the final reason
      yield chunk;
    }
    finished = true;
  } finally {
    // Runs when the stream fails and when the consumer stops early too.
    if (store) addLlmCall(store, { ...seen, ...explicit }, !finished);
  }
}

export function llm<C>(stream: AsyncIterable<C>, explicit?: LlmCall): AsyncGenerator<C, void, undefined>;

export function llm<T>(response: T, explicit?: LlmCall): T;

export function llm(response: unknown, explicit: LlmCall = {}): unknown {
  const store = als.getStore();
  const given = Object.fromEntries(Object.entries(explicit).filter(([, value]) => value !== undefined));
  if (typeof response === "object" && response !== null && Symbol.asyncIterator in response) {
    return observeStream(store, response as AsyncIterable<unknown>, given);
  }
  if (store) addLlmCall(store, { ...scanLlm(response), ...given });
  return response;
}
