import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectErrAsync, expectOkAsync } from '@/test/utils/result.js';
import { sleep } from '@/utils/sleep.js';

import { createGithubClient, mapResponseToError } from './github.client.js';

describe('github.client abort signals', () => {
  const BASE_URL = 'http://localhost:8088';

  function createGhClient(timeoutMs: number) {
    return createGithubClient({
      config: {
        baseUrl: BASE_URL,
        authToken: undefined,
        cacheTtlSeconds: 600,
        timeoutMs,
      },
      metrics: {
        onError: vi.fn(),
        onRateLimitError: vi.fn(),
      },
    });
  }

  const owner = 'torvalds';
  const name = 'linux';
  const repo = {
    full_name: 'torvalds/linux',
    owner: { login: 'torvalds' },
    name: 'linux',
  };

  const msw = setupServer(
    http.get(`${BASE_URL}/repos/${owner}/${name}`, async () => {
      await sleep(1_000);
      return HttpResponse.json(repo);
    }),
  );

  beforeAll(() => {
    msw.listen();
    vi.useFakeTimers();
  });

  afterAll(() => {
    msw.close();
    vi.useRealTimers();
  });

  it('parses OK response', async () => {
    const gh = createGhClient(2_000);

    const result = gh.getRepo(owner, name);

    await vi.advanceTimersByTimeAsync(1_100);

    await expectOkAsync(result);
  });

  it('returns timeout error result', async () => {
    const gh = createGhClient(200);

    const result = gh.getRepo(owner, name);

    await vi.advanceTimersByTimeAsync(400);

    const error = await expectErrAsync(result);
    expect(error.type === 'TIMEOUT');
  });

  it('returns abort error result', async () => {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 300);

    const gh = createGhClient(1_000);

    const result = gh.getRepo(owner, name, controller.signal);

    await vi.advanceTimersByTimeAsync(400);

    const error = await expectErrAsync(result);
    expect(error.type === 'ABORTED');
  });

  it('returns first timeout/abort error result', async () => {
    const gh = createGhClient(300);

    const controller1 = new AbortController();
    setTimeout(() => {
      controller1.abort();
    }, 400);

    const result1 = gh.getRepo(owner, name, controller1.signal);

    await vi.advanceTimersByTimeAsync(500);

    const error1 = await expectErrAsync(result1);
    expect(error1.type === 'TIMEOUT');

    const controller2 = new AbortController();
    setTimeout(() => {
      controller2.abort();
    }, 200);

    const result2 = gh.getRepo(owner, name, controller1.signal);

    await vi.advanceTimersByTimeAsync(300);

    const error2 = await expectErrAsync(result2);
    expect(error2.type === 'ABORTED');
  });
});

function createResponse(body: string, init: ResponseInit): Response {
  return new Response(body, init);
}

describe('github.client utils', () => {
  const fixedNow = new Date('2026-04-12T12:00:00.000Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('maps 404 responses to NotFound', async () => {
    const error = await expectErrAsync(
      mapResponseToError(createResponse('', { status: 404, statusText: 'Not Found' })),
    );

    expect(error.type === 'HttpNotFound');
  });

  it('maps 429 responses to TooManyRequests using numeric Retry-After', async () => {
    const error = await expectErrAsync(
      mapResponseToError(
        createResponse('rate limit', {
          status: 429,
          statusText: 'Too Many Requests',
          headers: { 'retry-after': '42' },
        }),
      ),
    );

    expect(error.type === 'HttpTooManyRequests' && error.retryAfterSeconds === 42);
  });

  it('parses Retry-After HTTP date values for rate-limited responses', async () => {
    const retryAt = 'Sun, 12 Apr 2026 12:00:30 GMT';

    const error = await expectErrAsync(
      mapResponseToError(
        createResponse('secondary rate limit', {
          status: 403,
          statusText: 'Forbidden',
          headers: { 'retry-after': retryAt },
        }),
      ),
    );

    expect(error.type === 'HttpTooManyRequests' && error.retryAfterSeconds === 30);
  });

  it('uses x-ratelimit-reset as a fallback for rate-limited responses', async () => {
    const resetAtSeconds = Math.floor(fixedNow.getTime() / 1000) + 90;

    const error = await expectErrAsync(
      mapResponseToError(
        createResponse('API rate limit exceeded', {
          status: 403,
          statusText: 'Forbidden',
          headers: { 'x-ratelimit-reset': resetAtSeconds.toString() },
        }),
      ),
    );

    expect(error.type === 'HttpTooManyRequests' && error.retryAfterSeconds === 90);
  });

  it('treats 403 with x-ratelimit-remaining zero as TooManyRequests', async () => {
    const error = await expectErrAsync(
      mapResponseToError(
        createResponse('forbidden', {
          status: 403,
          statusText: 'Forbidden',
          headers: { 'x-ratelimit-remaining': '0' },
        }),
      ),
    );

    expect(error.type === 'HttpTooManyRequests' && error.retryAfterSeconds === null);
  });

  it('maps non-rate-limit 401 and 403 responses to Unauthorized', async () => {
    const unauthorized401 = await expectErrAsync(
      mapResponseToError(
        createResponse('auth failed', { status: 401, statusText: 'Unauthorized' }),
      ),
    );
    const unauthorized403 = await expectErrAsync(
      mapResponseToError(createResponse('forbidden', { status: 403, statusText: 'Forbidden' })),
    );

    expect(unauthorized401.type === 'HttpUnauthorized');
    expect(unauthorized403.type === 'HttpUnauthorized');
  });
});
