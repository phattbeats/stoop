/**
 * Stoop — the listing drafter's model call.
 *
 * Constraint (Brandon, PHA-5089): drafting routes through the LiteLLM
 * Anthropic path only. So this module speaks the Anthropic Messages shape
 * (`/v1/messages`, image content blocks, `anthropic/*` models) against
 * LiteLLM. If the configured model is not an Anthropic model, this refuses
 * to run rather than quietly drafting on some other provider.
 *
 * The model proposes; it never decides. Everything it returns comes back
 * through src/draft.ts, which clamps and checks it.
 */

export interface DraftPhoto {
  /** A URL the model can fetch, or a data: URL / raw base64. */
  ref: string;
  mediaType?: string;
}

export interface DraftRequest {
  photos: DraftPhoto[];
  /** Voice-note transcript or typed hints from Emily. */
  notes: string;
  /** Condition and provenance facts Emily already knows. */
  hints: string[];
  /** Which marketplaces she wants this for. */
  marketplaces: string[];
  /** What Emily said the price should be, if anything. */
  priceHint?: string;
}

export interface AnthropicPathOptions {
  /** LiteLLM base URL, e.g. http://litellm:4000 */
  baseUrl: string;
  apiKey: string;
  /** Must start with 'anthropic/'. */
  model: string;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class DraftingError extends Error {
  readonly detail: string;

  constructor(message: string, detail = '') {
    super(message);
    this.name = 'DraftingError';
    this.detail = detail;
  }
}

const SYSTEM_PROMPT = [
  'You draft marketplace listings for a small seller of art and odds and ends.',
  "Look at the photographs and the seller's notes, then propose ONE listing.",
  'Rules you must follow:',
  '- title: plain text, no markup, no emoji, no ALL CAPS, no "vintage" unless it really is old.',
  '- description: factual. Say what is visible and what the seller said. Never invent a brand,',
  '  a material, a measurement, a year or a provenance. If it is not knowable, leave it out.',
  '- tags: lowercase, short, single words or short phrases, no duplicates, at most 13.',
  '- priceRange: a low and a high in DOLLARS (numbers, e.g. 18 and 24). Only if the notes or the',
  '  photographs support a price. If there is no basis for a price, say so with low/high = 0.',
  '- shipping: at most 3 realistic options for the seller (for example USPS Ground Advantage with a',
  '  price in DOLLARS). Use 0 for free local pickup when it makes sense.',
  '- originalOrVintage: true only if the item is an original work or genuinely vintage, false if you',
  '  know it is not, and null (null) if you cannot tell.',
  '- confidence: 0 to 1.',
  '- flags: short snake_case strings for anything a human must check, such as needs_measurement,',
  '  price_unverified, possible_damage, condition_unclear.',
  'Answer with one JSON object and nothing else. No prose, no code fence.',
].join('\n');

interface AnthropicResponse {
  content?: { type: string; text?: string }[];
  error?: { message?: string };
}

function isAnthropicModel(model: string): boolean {
  return /^anthropic\/claude-/i.test(model.trim());
}

/**
 * Turn a photo reference into an Anthropic image content block.
 * http(s) URLs are passed through as url sources; everything else is treated
 * as base64 (a data: URL carries its own media type).
 */
function imageBlock(photo: DraftPhoto): Record<string, unknown> {
  const ref = photo.ref.trim();
  if (/^https?:\/\//i.test(ref)) {
    return { type: 'image', source: { type: 'url', url: ref } };
  }
  const dataUrl = /^data:([^;,]+);base64,(.*)$/i.exec(ref);
  if (dataUrl) {
    return {
      type: 'image',
      source: { type: 'base64', media_type: dataUrl[1], data: dataUrl[2] },
    };
  }
  return {
    type: 'image',
    source: { type: 'base64', media_type: photo.mediaType ?? 'image/jpeg', data: ref },
  };
}

/**
 * Pull a JSON object out of the model's answer.
 *
 * Claude occasionally wraps JSON in prose; the object is still there. We look
 * for the first balanced {...} block. If there is no JSON at all, we fail
 * loudly: a draft made of nothing is worse than no draft.
 */
export function extractJson(raw: string): unknown {
  const text = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1].trim() : text;
  try {
    return JSON.parse(candidate);
  } catch {
    // fall through to the brace scan
  }
  const start = candidate.indexOf('{');
  if (start === -1) {
    throw new DraftingError('the model did not return JSON', raw.slice(0, 400));
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i += 1) {
    const ch = candidate[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const slice = candidate.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch (error) {
          throw new DraftingError('the model returned malformed JSON', String((error as Error).message ?? error));
        }
      }
    }
  }
  throw new DraftingError('the model returned malformed JSON', raw.slice(0, 400));
}

export class AnthropicPathDrafter {
  private readonly options: AnthropicPathOptions;

  constructor(options: AnthropicPathOptions) {
    if (!isAnthropicModel(options.model)) {
      throw new DraftingError(
        `drafting is Anthropic-path only; "${options.model}" is not an Anthropic model`,
        'set STOOP_LLM_MODEL to anthropic/claude-*',
      );
    }
    this.options = options;
  }

  /** The model name in use — surfaced on the health endpoint. */
  get model(): string {
    return this.options.model;
  }

  async propose(request: DraftRequest): Promise<unknown> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const url = `${this.options.baseUrl.replace(/\/$/, '')}/v1/messages`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 45_000);

    const content: Record<string, unknown>[] = [];
    for (const photo of request.photos.slice(0, 6)) {
      content.push(imageBlock(photo));
    }

    const facts = [
      request.notes ? `Seller's notes (verbatim, may be a voice-note transcript): ${request.notes}` : '',
      request.hints.length ? `Known facts: ${request.hints.join('; ')}` : '',
      request.priceHint ? `Price the seller has in mind: ${request.priceHint}` : '',
      request.marketplaces.length ? `Marketplaces: ${request.marketplaces.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    content.push({
      type: 'text',
      text: facts
        ? `${facts}\n\nDescribe what you see in the photographs, then propose the listing as JSON.`
        : 'Describe what you see in the photographs, then propose the listing as JSON.',
    });

    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.apiKey}`,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.options.model,
          max_tokens: 1200,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content }],
        }),
        signal: controller.signal,
      });

      const text = await response.text();
      if (!response.ok) {
        throw new DraftingError(`the drafting model returned ${response.status}`, text.slice(0, 400));
      }
      let payload: AnthropicResponse;
      try {
        payload = JSON.parse(text) as AnthropicResponse;
      } catch {
        throw new DraftingError('the drafting model returned a non-JSON response', text.slice(0, 400));
      }
      const answer = (payload.content ?? [])
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text as string)
        .join('\n');
      if (!answer.trim()) {
        throw new DraftingError('the drafting model returned no text', text.slice(0, 400));
      }
      return extractJson(answer);
    } catch (error) {
      if (error instanceof DraftingError) throw error;
      const message = String((error as Error).message ?? error);
      throw new DraftingError('the drafting model could not be reached', message);
    } finally {
      clearTimeout(timeout);
    }
  }
}
