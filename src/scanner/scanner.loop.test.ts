import { errAsync, okAsync } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScannerConfig } from '@/config/config.js';
import type { MockLogger } from '@/test/mocks.js';
import { createRepository } from '@/test/factories.js';
import {
  createMockGithubClient,
  createMockLogger,
  createMockRepositoryRepo,
  createMockRepoSubscriptionsQueue,
} from '@/test/mocks.js';
import { expectErr, expectOk } from '@/test/utils/result.js';
import { httpErrors } from '@/utils/http.js';
import { sleep } from '@/utils/sleep.js';

import { createFetchWithRetryFn, createProcessRepositoryFn } from './scanner.loop.js';

vi.mock('@/utils/sleep.js', () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

describe('scanner.loop', () => {
  const scannerConfig: ScannerConfig = {
    scanIntervalMs: 60_000,
    batchSize: 10,
    pollDelayMs: 100,
    initialRetryDelay: 5_000,
    baseErrorDelayMs: 5_000,
    maxBackoffDelayMs: 30_000,
  };

  let logger: MockLogger;
  const mockedSleep = vi.mocked(sleep);

  beforeEach(() => {
    logger = createMockLogger();
    mockedSleep.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('fetch repo from GitHub', () => {
    it('retries on TooManyRequests using retryAfterSeconds (ms)', async () => {
      const githubClient = createMockGithubClient({
        getLatestRelease: vi
          .fn()
          .mockReturnValueOnce(
            errAsync({ type: 'HTTP_ERROR', error: httpErrors.TooManyRequests(7) }),
          )
          .mockReturnValueOnce(okAsync('v2.0.0')),
      });

      const fetchWithRetry = createFetchWithRetryFn({
        log: logger,
        config: scannerConfig,
        githubClient,
      });

      const result = await fetchWithRetry('owner', 'repo');

      expect(expectOk(result)).toBe('v2.0.0');
      expect(mockedSleep).toHaveBeenCalledWith(7_000, undefined);
    });

    it('uses exponential backoff with jitter when retryAfterSeconds is null', async () => {
      const githubClient = createMockGithubClient({
        getLatestRelease: vi
          .fn()
          .mockReturnValueOnce(
            errAsync({ type: 'HTTP_ERROR', error: httpErrors.TooManyRequests() }),
          )
          .mockReturnValueOnce(
            errAsync({ type: 'HTTP_ERROR', error: httpErrors.TooManyRequests() }),
          )
          .mockReturnValueOnce(okAsync('v2.0.0')),
      });

      const fetchWithRetry = createFetchWithRetryFn({
        log: logger,
        config: scannerConfig,
        githubClient,
      });

      const result = await fetchWithRetry('owner', 'repo');

      expectOk(result);
      expect(mockedSleep.mock.calls[0]?.[0]).toBeLessThanOrEqual(scannerConfig.initialRetryDelay);
      expect(mockedSleep.mock.calls[1]?.[0]).toBeLessThanOrEqual(
        scannerConfig.initialRetryDelay * 2,
      );
    });

    it('returns immediately on non-rate-limit errors', async () => {
      const githubClient = createMockGithubClient({
        getLatestRelease: vi
          .fn()
          .mockReturnValue(
            errAsync({ type: 'HTTP_ERROR', error: httpErrors.Unauthorized('fail') }),
          ),
      });

      const fetchWithRetry = createFetchWithRetryFn({
        log: logger,
        config: scannerConfig,
        githubClient,
      });

      const result = await fetchWithRetry('owner', 'repo');

      const error = expectErr(result);

      expect(error.type === 'HTTP_ERROR');
      expect(mockedSleep).not.toHaveBeenCalled();
    });

    it('returns ABORTED if signal is aborted', async () => {
      const githubClient = createMockGithubClient({
        getLatestRelease: vi.fn(),
      });

      const fetchWithRetry = createFetchWithRetryFn({
        log: logger,
        config: scannerConfig,
        githubClient,
      });

      const controller = new AbortController();
      controller.abort();

      const result = await fetchWithRetry('owner', 'repo', controller.signal);

      const error = expectErr(result);
      expect(error.type === 'ABORTED');
    });
  });

  describe('process repo', () => {
    it('baselines new repo without enqueue', async () => {
      const updateAfterScan = vi.fn().mockResolvedValue(undefined);
      const enqueue = vi.fn();

      const processRepository = createProcessRepositoryFn({
        log: logger,
        repositoryRepo: createMockRepositoryRepo({ updateAfterScan }),
        fetchWithRetry: vi.fn().mockResolvedValue(okAsync('v1.0.0')),
        repoSubscriptionsQueue: createMockRepoSubscriptionsQueue({
          enqueueRepoSubscriptions: enqueue,
        }),
        onNewRelease: vi.fn(),
      });

      await processRepository(createRepository({ lastSeenTag: null }));

      expect(updateAfterScan).toHaveBeenCalledWith(1, expect.any(Date), 'v1.0.0');
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('when tag is unchanged, updates timestamp only', async () => {
      const updateAfterScan = vi.fn().mockResolvedValue(undefined);
      const enqueue = vi.fn();

      const processRepository = createProcessRepositoryFn({
        log: logger,
        repositoryRepo: createMockRepositoryRepo({ updateAfterScan }),
        fetchWithRetry: vi.fn().mockResolvedValue(okAsync('v1.0.0')),
        repoSubscriptionsQueue: createMockRepoSubscriptionsQueue({
          enqueueRepoSubscriptions: enqueue,
        }),
        onNewRelease: vi.fn(),
      });

      const repo = createRepository({ lastSeenTag: 'v1.0.0' });
      await processRepository(repo);

      expect(updateAfterScan).toHaveBeenCalledWith(repo.id, expect.any(Date));
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('updates tag and enqueues when new release detected', async () => {
      const updateAfterScan = vi.fn().mockReturnValue(okAsync());
      const enqueue = vi.fn().mockResolvedValue(undefined);

      const processRepository = createProcessRepositoryFn({
        log: logger,
        repositoryRepo: createMockRepositoryRepo({ updateAfterScan }),
        fetchWithRetry: vi.fn().mockResolvedValue(okAsync('v2.0.0')),
        repoSubscriptionsQueue: createMockRepoSubscriptionsQueue({
          enqueueRepoSubscriptions: enqueue,
        }),
        onNewRelease: vi.fn(),
      });

      const repo = createRepository({ lastSeenTag: 'v1.0.0' });
      await processRepository(repo);

      expect(updateAfterScan).toHaveBeenCalledWith(repo.id, expect.any(Date), 'v2.0.0');
      expect(enqueue).toHaveBeenCalledWith({
        repoId: repo.id,
        repoName: 'owner/repo',
        latestTag: 'v2.0.0',
      });
    });

    it('handles fetch error and still updates timestamp', async () => {
      const updateAfterScan = vi.fn().mockResolvedValue(undefined);
      const enqueue = vi.fn();

      const processRepository = createProcessRepositoryFn({
        log: logger,
        repositoryRepo: createMockRepositoryRepo({ updateAfterScan }),
        fetchWithRetry: vi.fn().mockResolvedValue(errAsync(httpErrors.Unauthorized('fail'))),
        repoSubscriptionsQueue: createMockRepoSubscriptionsQueue({
          enqueueRepoSubscriptions: enqueue,
        }),
        onNewRelease: vi.fn(),
      });

      const repo = createRepository({ lastSeenTag: 'v1.0.0' });
      await processRepository(repo);

      expect(updateAfterScan).toHaveBeenCalledWith(repo.id, expect.any(Date));
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('propagates ABORTED from fetchWithRetry', async () => {
      const processRepository = createProcessRepositoryFn({
        log: logger,
        repositoryRepo: createMockRepositoryRepo(),
        fetchWithRetry: vi.fn().mockReturnValue(errAsync({ type: 'ABORTED' })),
        repoSubscriptionsQueue: createMockRepoSubscriptionsQueue(),
        onNewRelease: vi.fn(),
      });

      const result = await processRepository(createRepository({ lastSeenTag: 'v1.0.0' }));

      const error = expectErr(result);
      expect(error.type === 'ABORTED');
    });

    it('captures enqueue failure but does not fail the flow', async () => {
      const updateAfterScan = vi.fn().mockResolvedValue(undefined);
      const enqueueError = new Error('queue down');

      const processRepository = createProcessRepositoryFn({
        log: logger,
        repositoryRepo: createMockRepositoryRepo({ updateAfterScan }),
        fetchWithRetry: vi.fn().mockResolvedValue(okAsync('v2.0.0')),
        repoSubscriptionsQueue: createMockRepoSubscriptionsQueue({
          enqueueRepoSubscriptions: vi.fn().mockRejectedValue(enqueueError),
        }),
        onNewRelease: vi.fn(),
      });

      const result = await processRepository(createRepository({ lastSeenTag: 'v1.0.0' }));

      const error = expectErr(result);
      expect(error.type === 'PROCESS_ERROR' && error.processError.type === 'ENQUEUE_ERROR');
    });
  });

  describe('abort signal handling', () => {
    it('fetchWithRetry returns ABORTED if signal is already aborted', async () => {
      const getLatestRelease = vi.fn();

      const githubClient = createMockGithubClient({ getLatestRelease });

      const fetchWithRetry = createFetchWithRetryFn({
        log: logger,
        config: scannerConfig,
        githubClient,
      });

      const controller = new AbortController();
      controller.abort();

      const result = await fetchWithRetry('owner', 'repo', controller.signal);

      const error = expectErr(result);
      expect(error.type === 'ABORTED');
      expect(getLatestRelease).not.toHaveBeenCalled();
    });

    it('fetchWithRetry stops retry loop when aborted during sleep', async () => {
      const getLatestRelease = vi.fn(() =>
        errAsync({ type: 'HTTP_ERROR' as const, error: httpErrors.TooManyRequests(1) }),
      );

      const githubClient = createMockGithubClient({ getLatestRelease });

      const controller = new AbortController();

      mockedSleep.mockImplementationOnce(() => {
        controller.abort(); // simulate abort during sleep
        return Promise.resolve();
      });

      const fetchWithRetry = createFetchWithRetryFn({
        log: logger,
        config: scannerConfig,
        githubClient,
      });

      const result = await fetchWithRetry('owner', 'repo', controller.signal);

      const error = expectErr(result);
      expect(error.type === 'ABORTED');
      expect(getLatestRelease).toHaveBeenCalledTimes(1);
    });

    it('processRepository propagates ABORTED and stops early', async () => {
      const updateAfterScan = vi.fn();
      const enqueueRepoSubscriptions = vi.fn();

      const repositoryRepo = createMockRepositoryRepo({ updateAfterScan });
      const repoSubscriptionsQueue = createMockRepoSubscriptionsQueue({ enqueueRepoSubscriptions });

      const fetchWithRetry = vi.fn().mockResolvedValue(errAsync({ type: 'ABORTED' }));

      const processRepository = createProcessRepositoryFn({
        log: logger,
        repositoryRepo,
        fetchWithRetry,
        repoSubscriptionsQueue,
        onNewRelease: vi.fn(),
      });

      const result = await processRepository(createRepository({}));

      const error = expectErr(result);
      expect(error.type === 'ABORTED');
      expect(updateAfterScan).not.toHaveBeenCalled();
      expect(enqueueRepoSubscriptions).not.toHaveBeenCalled();
    });

    it('processRepository stops mid-processing when signal is aborted', async () => {
      const updateAfterScan = vi.fn().mockResolvedValue(undefined);
      const enqueueRepoSubscriptions = vi.fn().mockResolvedValue(undefined);

      const repositoryRepo = createMockRepositoryRepo({ updateAfterScan });

      const repoSubscriptionsQueue = createMockRepoSubscriptionsQueue({ enqueueRepoSubscriptions });

      const fetchWithRetry = vi.fn((_owner, _name, signal?: AbortSignal) =>
        signal?.aborted ? errAsync({ type: 'ABORTED' as const }) : okAsync('v1.0.0'),
      );

      const processRepository = createProcessRepositoryFn({
        log: logger,
        repositoryRepo,
        fetchWithRetry,
        repoSubscriptionsQueue,
        onNewRelease: vi.fn(),
      });

      const controller = new AbortController();
      controller.abort();

      const result = await processRepository(createRepository(), controller.signal);

      const error = expectErr(result);
      expect(error.type === 'ABORTED');
      expect(updateAfterScan).not.toHaveBeenCalled();
      expect(enqueueRepoSubscriptions).not.toHaveBeenCalled();
    });
  });
});
