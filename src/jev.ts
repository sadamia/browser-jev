import { TypeSafeClient, choice } from "@typesafe-ai/sdk";
import type { ChoiceCriteria, Questions, SystemOneRequest, SystemOneResult } from "@typesafe-ai/sdk";
import { BjError } from "./errors.ts";
import { describe } from "./snapshot.ts";
import type { El } from "./snapshot.ts";

export interface JevStats {
  calls: number;
  inputTokens: number;
  ms: number;
  slowestMs: number;
  /** Calls where a backup request was sent because the first was slow. */
  hedged: number;
}

export class Jev {
  readonly stats: JevStats = { calls: 0, inputTokens: 0, ms: 0, slowestMs: 0, hedged: 0 };
  #client: TypeSafeClient | undefined;

  get available(): boolean {
    return Boolean(process.env.TYPESAFE_API_KEY?.trim());
  }

  /** One System One request: independent typed questions over the same state, answered in parallel. */
  async ask<const Q extends Questions>(request: SystemOneRequest<Q>): Promise<SystemOneResult<Q>["answers"]> {
    if (!this.available) throw new BjError("config", "TYPESAFE_API_KEY is not set; Jev-backed calls (find/check/rate/choose/ask) are unavailable");
    const client = (this.#client ??= new TypeSafeClient({ timeout: 6_000, retry: { maxRetries: 2, backoffInitialMs: 150 } }));
    const started = performance.now();
    // Typical latency is 0.3-0.6s but single requests occasionally stall for seconds, so a backup
    // request goes out after HEDGE_MS and the first answer wins. Requests are idempotent and cheap.
    const abort = new AbortController();
    let hedge: ReturnType<typeof setTimeout> | undefined;
    const attempt = () => client.systemOne(request, { signal: abort.signal });
    const backup = new Promise<Awaited<ReturnType<typeof attempt>>>((resolve, reject) => {
      hedge = setTimeout(() => {
        this.stats.hedged++;
        attempt().then(resolve, reject);
      }, HEDGE_MS);
    });
    let result: Awaited<ReturnType<typeof attempt>>;
    try {
      result = await Promise.any([attempt(), backup]);
    } catch (err) {
      throw err instanceof AggregateError ? err.errors[0] : err;
    } finally {
      clearTimeout(hedge);
      abort.abort();
    }
    const ms = Math.round(performance.now() - started);
    this.stats.calls++;
    this.stats.inputTokens += result.usage.input_tokens;
    this.stats.ms += ms;
    this.stats.slowestMs = Math.max(this.stats.slowestMs, ms);
    return result.answers;
  }
}

export interface Candidate {
  ref: string;
  element: string;
  probability: number;
}

export interface Pick {
  el: El;
  confidence: number;
  candidates: Candidate[];
}

// The API rejects a Choice with more than 255 options.
const CHUNK = 250;
const NONE = "none";
const HEDGE_MS = 1_500;

export interface PageInfo {
  url: string;
  title: string;
  /** Rendered page content, so Jev can relate a description ("the overdue invoice") to what is on screen. */
  screen: string;
}

type Ranked = Record<string, { choice: string; confidence: number; probabilities: Record<string, number> }>;

/** One request: a Choice per described target, all over the same candidate list. */
async function rank(jev: Jev, targets: Record<string, string>, page: PageInfo, els: El[], hints: Map<string, string>): Promise<Ranked> {
  const criteria: ChoiceCriteria = {};
  for (const el of els) criteria[el.ref] = describe(el) + (hints.has(el.ref) ? ` — html: ${hints.get(el.ref)}` : "");
  criteria[NONE] = "No listed element is the described target";
  const questions: Questions = {};
  for (const [key, description] of Object.entries(targets)) {
    questions[key] = choice(
      `A user is operating the web page whose content is in \`page.screen\`. Which listed element is this one: "${description}"? Use the page content to work out which item the description refers to, then choose the element itself, not a nearby one. Choose none when no listed element fits.`,
      criteria,
    );
  }
  return (await jev.ask({ state: { page: { ...page } }, questions })) as Ranked;
}

/** Resolve several natural-language descriptions to elements at once. Each value is a Pick or the error for that target. */
export async function pickElements(
  jev: Jev,
  targets: Record<string, string>,
  page: PageInfo,
  elements: El[],
  opts: { minConfidence: number; hints?: Map<string, string> },
): Promise<Record<string, Pick | BjError>> {
  const hints = opts.hints ?? new Map();
  const keys = Object.keys(targets);
  if (elements.length === 0) return Object.fromEntries(keys.map((k) => [k, new BjError("not_found", `no candidate elements on the page for "${targets[k]}"`)]));
  const byRef = new Map(elements.map((el) => [el.ref, el]));

  let answers: Ranked;
  if (elements.length <= CHUNK) {
    answers = await rank(jev, targets, page, elements, hints);
  } else {
    const chunks: El[][] = [];
    for (let i = 0; i < elements.length; i += CHUNK) chunks.push(elements.slice(i, i + CHUNK));
    const ranked = await Promise.all(chunks.map((c) => rank(jev, targets, page, c, hints)));
    const finals = await Promise.all(
      keys.map((key) => {
        const finalists = new Set<string>();
        for (const r of ranked) {
          const top = Object.entries(r[key]!.probabilities).filter(([ref]) => ref !== NONE).sort((a, b) => b[1] - a[1]).slice(0, 3);
          for (const [ref] of top) finalists.add(ref);
        }
        return rank(jev, { [key]: targets[key]! }, page, elements.filter((el) => finalists.has(el.ref)), hints);
      }),
    );
    answers = Object.assign({}, ...finals);
  }

  const out: Record<string, Pick | BjError> = {};
  for (const key of keys) {
    const answer = answers[key]!;
    const candidates: Candidate[] = Object.entries(answer.probabilities)
      .filter(([ref]) => ref !== NONE)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([ref, probability]) => ({ ref: `@${ref}`, element: describe(byRef.get(ref)!), probability: Number(probability.toFixed(3)) }));
    if (answer.choice === NONE) {
      out[key] = new BjError("not_found", `Jev found no element matching "${targets[key]}"`, { target: key, confidence: answer.confidence, candidates });
    } else if (answer.confidence < opts.minConfidence) {
      out[key] = new BjError("low_confidence", `Jev is unsure which element is "${targets[key]}" (confidence ${answer.confidence.toFixed(2)} < ${opts.minConfidence})`, { target: key, candidates });
    } else {
      out[key] = { el: byRef.get(answer.choice)!, confidence: answer.confidence, candidates };
    }
  }
  return out;
}
