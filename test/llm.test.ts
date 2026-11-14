import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnthropicPathDrafter, DraftingError, extractJson } from '../src/llm.ts';

function fakeFetch(body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const answer = {
  type: 'message',
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        title: 'Screen-printed bird study',
        description: 'Screen print on cream paper.',
        tags: ['screen print'],
        priceRange: { low: 18, high: 24 },
        shipping: [],
        originalOrVintage: true,
        confidence: 0.8,
      }),
    },
  ],
};

test('the drafter speaks the Anthropic Messages shape, with the image in the request', async () => {
  const { impl, calls } = fakeFetch(answer);
  const drafter = new AnthropicPathDrafter({
    baseUrl: 'http://litellm:4000',
    apiKey: 'test-key',
    model: 'anthropic/claude-sonnet-5',
    fetchImpl: impl,
  });

  const result = await drafter.propose({
    photos: [{ ref: 'YmFzZTY0', mediaType: 'image/jpeg' }],
    notes: 'a bird print',
    hints: [],
    marketplaces: ['ebay'],
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://litellm:4000/v1/messages');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer test-key');
  const payload = JSON.parse(String(calls[0].init.body)) as {
    model: string;
    messages: { content: Record<string, unknown>[] }[];
  };
  assert.equal(payload.model, 'anthropic/claude-sonnet-5');
  const content = payload.messages[0].content;
  assert.equal(content[0].type, 'image');
  assert.deepEqual(content[0].source, {
    type: 'base64',
    media_type: 'image/jpeg',
    data: 'YmFzZTY0',
  });
  assert.ok(String(content[content.length - 1].text).includes('a bird print'));
  assert.equal((result as { title: string }).title, 'Screen-printed bird study');
});

test('a url photo is passed through as a url source', async () => {
  const { impl, calls } = fakeFetch(answer);
  const drafter = new AnthropicPathDrafter({
    baseUrl: 'http://litellm:4000',
    apiKey: 'k',
    model: 'anthropic/claude-sonnet-5',
    fetchImpl: impl,
  });
  await drafter.propose({ photos: [{ ref: 'https://stoop.phatt.vip/photos/bird.jpg' }], notes: '', hints: [], marketplaces: [] });
  const payload = JSON.parse(String(calls[0].init.body)) as { messages: { content: Record<string, unknown>[] }[] };
  assert.deepEqual(payload.messages[0].content[0].source, {
    type: 'url',
    url: 'https://stoop.phatt.vip/photos/bird.jpg',
  });
});

test('drafting is Anthropic-path only: another provider is refused outright', () => {
  assert.throws(
    () => new AnthropicPathDrafter({ baseUrl: 'http://litellm:4000', apiKey: 'k', model: 'minimax/MiniMax-M3' }),
    /Anthropic-path only/,
  );
});

test('JSON wrapped in prose is still JSON; no JSON at all is an error', () => {
  assert.deepEqual(extractJson('Here you go:\n{"title":"Bird"}'), { title: 'Bird' });
  assert.deepEqual(extractJson('```json\n{"title":"Bird"}\n```'), { title: 'Bird' });
  assert.throws(() => extractJson('I cannot help with that.'), DraftingError);
});

test('a failed model call raises a drafting error, not a fake draft', async () => {
  const impl = (async () => new Response('upstream exploded', { status: 500 })) as unknown as typeof fetch;
  const drafter = new AnthropicPathDrafter({
    baseUrl: 'http://litellm:4000',
    apiKey: 'k',
    model: 'anthropic/claude-sonnet-5',
    fetchImpl: impl,
  });
  await assert.rejects(
    () => drafter.propose({ photos: [{ ref: 'YmFzZTY0' }], notes: '', hints: [], marketplaces: [] }),
    /returned 500/,
  );
});
