import { errAsync, okAsync } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SubscriptionsMetrics } from '@/metrics/metrics.js';
import type { MockLogger } from '@/test/mocks.js';
import type { TokenUrls } from '@/token/token.service.js';
import { dbErrors } from '@/db/errors.js';
import {
  createGithubRepo,
  createRepository,
  createSubscription,
  createTokenRecord,
} from '@/test/factories.js';
import {
  createMockConfirmationEmailsQueue,
  createMockGithubClient,
  createMockLogger,
  createMockRepositoryRepo,
  createMockSubscriptionRepo,
  createMockTokenService,
} from '@/test/mocks.js';
import { expectErrAsync, expectOkAsync } from '@/test/utils/result.js';
import { httpErrors } from '@/utils/http.js';

import { createSubscriptionService } from './subscription.service.js';

function createMockMetrics() {
  return {
    recordAction: vi.fn(),
  } satisfies SubscriptionsMetrics;
}

describe('subscription.service', () => {
  const email = 'user@example.com';
  const repoInput = 'owner/repo';
  const confirmToken = 'confirm-token';
  const confirmUrls: TokenUrls = {
    htmlUrl: 'http://localhost:3000/confirm/confirm-token',
    apiUrl: 'http://localhost:3000/api/confirm/confirm-token',
  };

  let logger: MockLogger;

  beforeEach(() => {
    logger = createMockLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('subscribe creates repo, subscription, token, and confirmation email job', async () => {
    const githubRepo = createGithubRepo();
    const storedRepo = createRepository();
    const createdSubscription = createSubscription();

    const getRepo = vi.fn().mockReturnValue(okAsync(githubRepo));
    const findByFullName = vi.fn().mockReturnValue(errAsync(dbErrors.DBNotFound('repo')));
    const createRepo = vi.fn().mockReturnValue(okAsync(storedRepo));
    const findActiveByEmailAndRepoId = vi
      .fn()
      .mockReturnValue(errAsync(dbErrors.DBNotFound('sub')));
    const createSubscriptionRecord = vi.fn().mockReturnValue(okAsync(createdSubscription));
    const createToken = vi.fn().mockReturnValue(okAsync(confirmToken));
    const getTokenUrls = vi.fn().mockReturnValue(confirmUrls);
    const enqueueConfirmationEmail = vi.fn().mockResolvedValue(undefined);

    const service = createSubscriptionService({
      logger,
      githubClient: createMockGithubClient({ getRepo }),
      repositoryRepo: createMockRepositoryRepo({
        findByFullName,
        create: createRepo,
      }),
      subscriptionRepo: createMockSubscriptionRepo({
        findActiveByEmailAndRepoId,
        create: createSubscriptionRecord,
      }),
      tokenService: createMockTokenService({
        createToken,
        getTokenUrls,
      }),
      confirmationEmailsQueue: createMockConfirmationEmailsQueue({ enqueueConfirmationEmail }),
      metrics: createMockMetrics(),
    });

    const result = service.subscribe({ email, repo: repoInput });

    await expectOkAsync(result);
    expect(getRepo).toHaveBeenCalledWith('owner', 'repo');
    expect(findByFullName).toHaveBeenCalledWith(githubRepo.fullName);
    expect(createRepo).toHaveBeenCalledWith({
      fullName: 'owner/repo',
      owner: 'owner',
      name: 'repo',
      isActive: true,
    });
    expect(createSubscriptionRecord).toHaveBeenCalledWith({
      email,
      repositoryId: storedRepo.id,
    });
    expect(createToken).toHaveBeenCalledWith({
      email,
      repositoryId: storedRepo.id,
      type: 'confirm',
    });
    expect(getTokenUrls).toHaveBeenCalledWith(confirmToken, 'confirm');
    expect(enqueueConfirmationEmail).toHaveBeenCalledWith({
      email,
      repoName: githubRepo.fullName,
      confirmHtmlUrl: confirmUrls.htmlUrl,
      confirmApiUrl: confirmUrls.apiUrl,
    });
  });

  it('subscribe returns NotFound when GitHub says the repo does not exist', async () => {
    const getRepo = vi.fn().mockReturnValue(errAsync(httpErrors.NotFound()));
    const findByFullName = vi.fn();

    const service = createSubscriptionService({
      logger,
      githubClient: createMockGithubClient({ getRepo }),
      repositoryRepo: createMockRepositoryRepo({ findByFullName }),
      subscriptionRepo: createMockSubscriptionRepo(),
      tokenService: createMockTokenService(),
      confirmationEmailsQueue: createMockConfirmationEmailsQueue(),
      metrics: createMockMetrics(),
    });

    const result = service.subscribe({ email, repo: repoInput });

    const error = await expectErrAsync(result);
    expect(error.type === 'GH_NOT_FOUND');
    expect(findByFullName).not.toHaveBeenCalled();
  });

  it('subscribe maps GitHub rate limiting to RateLimited', async () => {
    const getRepo = vi.fn().mockReturnValue(errAsync(httpErrors.TooManyRequests(60)));

    const service = createSubscriptionService({
      logger,
      githubClient: createMockGithubClient({ getRepo }),
      repositoryRepo: createMockRepositoryRepo(),
      subscriptionRepo: createMockSubscriptionRepo(),
      tokenService: createMockTokenService(),
      confirmationEmailsQueue: createMockConfirmationEmailsQueue(),
      metrics: createMockMetrics(),
    });

    const result = service.subscribe({ email, repo: repoInput });

    const error = await expectErrAsync(result);
    expect(error.type === 'GH_RATE_LIMITED');
  });

  it('subscribe maps non-rate-limit GitHub failures to External', async () => {
    const getRepo = vi.fn().mockReturnValue(errAsync(httpErrors.Unauthorized()));

    const service = createSubscriptionService({
      logger,
      githubClient: createMockGithubClient({ getRepo }),
      repositoryRepo: createMockRepositoryRepo(),
      subscriptionRepo: createMockSubscriptionRepo(),
      tokenService: createMockTokenService(),
      confirmationEmailsQueue: createMockConfirmationEmailsQueue(),
      metrics: createMockMetrics(),
    });

    const result = service.subscribe({ email, repo: repoInput });

    const error = await expectErrAsync(result);
    expect(error.type === 'GH_ERROR');
  });

  it('subscribe updates an existing repo with canonical GitHub data and reactivates it', async () => {
    const githubRepo = createGithubRepo({
      fullName: 'canonical-owner/canonical-repo',
      owner: 'canonical-owner',
      name: 'canonical-repo',
    });
    const existingRepo = createRepository({
      id: 7,
      fullName: 'owner/repo',
      owner: 'old-owner',
      name: 'old-repo',
      isActive: false,
    });
    const updatedRepo = createRepository({
      id: 7,
      fullName: githubRepo.fullName,
      owner: githubRepo.owner,
      name: githubRepo.name,
      isActive: true,
    });
    const createdSubscription = createSubscription({ repositoryId: updatedRepo.id });

    const updateRepo = vi.fn().mockReturnValue(okAsync(updatedRepo));

    const service = createSubscriptionService({
      logger,
      githubClient: createMockGithubClient({
        getRepo: vi.fn().mockReturnValue(okAsync(githubRepo)),
      }),
      repositoryRepo: createMockRepositoryRepo({
        findByFullName: vi.fn().mockReturnValue(okAsync(existingRepo)),
        update: updateRepo,
      }),
      subscriptionRepo: createMockSubscriptionRepo({
        findActiveByEmailAndRepoId: vi.fn().mockReturnValue(errAsync(dbErrors.DBNotFound('sub'))),
        create: vi.fn().mockReturnValue(okAsync(createdSubscription)),
      }),
      tokenService: createMockTokenService({
        createToken: vi.fn().mockReturnValue(okAsync(confirmToken)),
        getTokenUrls: vi.fn().mockReturnValue(confirmUrls),
      }),
      confirmationEmailsQueue: createMockConfirmationEmailsQueue(),
      metrics: createMockMetrics(),
    });

    const result = service.subscribe({ email, repo: repoInput });

    await expectOkAsync(result);
    expect(updateRepo).toHaveBeenCalledWith(existingRepo.id, {
      fullName: githubRepo.fullName,
      owner: githubRepo.owner,
      name: githubRepo.name,
      isActive: true,
    });
  });

  it('subscribe returns Conflict for an already confirmed active subscription', async () => {
    const githubRepo = createGithubRepo();
    const storedRepo = createRepository();
    const existingSubscription = createSubscription({
      confirmedAt: new Date('2026-01-03T00:00:00.000Z'),
    });

    const createToken = vi.fn();
    const enqueueConfirmationEmail = vi.fn();

    const service = createSubscriptionService({
      logger,
      githubClient: createMockGithubClient({
        getRepo: vi.fn().mockReturnValue(okAsync(githubRepo)),
      }),
      repositoryRepo: createMockRepositoryRepo({
        findByFullName: vi.fn().mockReturnValue(okAsync(storedRepo)),
        update: vi.fn().mockReturnValue(okAsync(storedRepo)),
      }),
      subscriptionRepo: createMockSubscriptionRepo({
        findActiveByEmailAndRepoId: vi.fn().mockReturnValue(okAsync(existingSubscription)),
      }),
      tokenService: createMockTokenService({ createToken }),
      confirmationEmailsQueue: createMockConfirmationEmailsQueue({ enqueueConfirmationEmail }),
      metrics: createMockMetrics(),
    });

    const result = service.subscribe({ email, repo: repoInput });

    const error = await expectErrAsync(result);
    expect(error.type === 'ALREADY_SUBSCRIBED');
    expect(createToken).not.toHaveBeenCalled();
    expect(enqueueConfirmationEmail).not.toHaveBeenCalled();
  });

  it('subscribe reuses an existing unconfirmed subscription instead of creating a duplicate', async () => {
    const githubRepo = createGithubRepo();
    const storedRepo = createRepository();
    const existingSubscription = createSubscription({ id: 99, confirmedAt: null, removedAt: null });
    const updatedSubscription = createSubscription({ id: 99, confirmedAt: null, removedAt: null });

    const updateSubscription = vi.fn().mockResolvedValue(updatedSubscription);
    const createSubscriptionRecord = vi.fn();

    const service = createSubscriptionService({
      logger,
      githubClient: createMockGithubClient({
        getRepo: vi.fn().mockReturnValue(okAsync(githubRepo)),
      }),
      repositoryRepo: createMockRepositoryRepo({
        findByFullName: vi.fn().mockReturnValue(okAsync(storedRepo)),
        update: vi.fn().mockReturnValue(okAsync(storedRepo)),
      }),
      subscriptionRepo: createMockSubscriptionRepo({
        findActiveByEmailAndRepoId: vi.fn().mockReturnValue(okAsync(existingSubscription)),
        update: updateSubscription,
        create: createSubscriptionRecord,
      }),
      tokenService: createMockTokenService({
        createToken: vi.fn().mockReturnValue(okAsync(confirmToken)),
        getTokenUrls: vi.fn().mockReturnValue(confirmUrls),
      }),
      confirmationEmailsQueue: createMockConfirmationEmailsQueue(),
      metrics: createMockMetrics(),
    });

    const result = service.subscribe({ email, repo: repoInput });

    await expectOkAsync(result);
    expect(createSubscriptionRecord).not.toHaveBeenCalled();
  });

  it('subscribe returns Internal and does not queue email when token creation fails', async () => {
    const githubRepo = createGithubRepo();
    const storedRepo = createRepository();
    const createdSubscription = createSubscription();
    const enqueueConfirmationEmail = vi.fn();

    const service = createSubscriptionService({
      logger,
      githubClient: createMockGithubClient({
        getRepo: vi.fn().mockReturnValue(okAsync(githubRepo)),
      }),
      repositoryRepo: createMockRepositoryRepo({
        findByFullName: vi.fn().mockReturnValue(okAsync(storedRepo)),
        update: vi.fn().mockReturnValue(okAsync(storedRepo)),
      }),
      subscriptionRepo: createMockSubscriptionRepo({
        findActiveByEmailAndRepoId: vi.fn().mockReturnValue(errAsync(dbErrors.DBNotFound('sub'))),
        create: vi.fn().mockReturnValue(okAsync(createdSubscription)),
      }),
      tokenService: createMockTokenService({
        createToken: vi.fn().mockReturnValue(errAsync(dbErrors.DBError())),
      }),
      confirmationEmailsQueue: createMockConfirmationEmailsQueue({ enqueueConfirmationEmail }),
      metrics: createMockMetrics(),
    });

    const result = service.subscribe({ email, repo: repoInput });

    const error = await expectErrAsync(result);
    expect(typeof error === 'object');
    expect(enqueueConfirmationEmail).not.toHaveBeenCalled();
  });

  it('confirm confirms the subscription, reactivates the repo, and deletes the token', async () => {
    const tokenRecord = createTokenRecord();
    const subscription = createSubscription({ repositoryId: tokenRecord.repositoryId });
    const confirmedSubscription = createSubscription({
      id: subscription.id,
      repositoryId: subscription.repositoryId,
      confirmedAt: new Date('2026-01-03T00:00:00.000Z'),
      removedAt: null,
    });

    const updateSubscription = vi.fn().mockReturnValue(okAsync(confirmedSubscription));
    const updateRepo = vi
      .fn()
      .mockReturnValue(okAsync(createRepository({ id: tokenRecord.repositoryId })));
    const deleteToken = vi.fn().mockReturnValue(okAsync());

    const service = createSubscriptionService({
      logger,
      githubClient: createMockGithubClient(),
      repositoryRepo: createMockRepositoryRepo({ update: updateRepo }),
      subscriptionRepo: createMockSubscriptionRepo({
        findActiveByEmailAndRepoId: vi.fn().mockReturnValue(okAsync(subscription)),
        update: updateSubscription,
      }),
      tokenService: createMockTokenService({
        validateToken: vi.fn().mockReturnValue(okAsync(tokenRecord)),
        deleteToken,
      }),
      confirmationEmailsQueue: createMockConfirmationEmailsQueue(),
      metrics: createMockMetrics(),
    });

    await expectOkAsync(service.confirm(confirmToken));

    const updateCall = updateSubscription.mock.calls[0] as
      | [number, { confirmedAt?: Date; removedAt?: Date | null }]
      | undefined;

    expect(updateSubscription).toHaveBeenCalledTimes(1);
    expect(updateCall?.[0]).toBe(subscription.id);
    expect(updateCall?.[1].removedAt).toBeNull();
    expect(updateCall?.[1].confirmedAt).toBeInstanceOf(Date);
    expect(updateRepo).toHaveBeenCalledWith(tokenRecord.repositoryId, { isActive: true });
    expect(deleteToken).toHaveBeenCalledWith(tokenRecord.id);
  });

  it('confirm returns Internal if repository activation fails and does not delete the token', async () => {
    const tokenRecord = createTokenRecord();
    const subscription = createSubscription({ repositoryId: tokenRecord.repositoryId });
    const deleteToken = vi.fn();

    const service = createSubscriptionService({
      logger,
      githubClient: createMockGithubClient(),
      repositoryRepo: createMockRepositoryRepo({
        update: vi.fn().mockReturnValue(errAsync(dbErrors.DBNotFound('repo'))),
      }),
      subscriptionRepo: createMockSubscriptionRepo({
        findActiveByEmailAndRepoId: vi.fn().mockReturnValue(okAsync(subscription)),
        update: vi.fn().mockReturnValue(okAsync(subscription)),
      }),
      tokenService: createMockTokenService({
        validateToken: vi.fn().mockReturnValue(okAsync(tokenRecord)),
        deleteToken,
      }),
      confirmationEmailsQueue: createMockConfirmationEmailsQueue(),
      metrics: createMockMetrics(),
    });

    const result = service.confirm(confirmToken);

    const error = await expectErrAsync(result);
    expect(typeof error === 'object');
    expect(deleteToken).not.toHaveBeenCalled();
  });

  it('unsubscribe soft-deletes the subscription and deletes the token', async () => {
    const tokenRecord = createTokenRecord({ type: 'unsubscribe' });
    const subscription = createSubscription({ repositoryId: tokenRecord.repositoryId });
    const softDelete = vi.fn().mockReturnValue(okAsync(subscription));
    const deleteToken = vi.fn().mockReturnValue(okAsync());

    const service = createSubscriptionService({
      logger,
      githubClient: createMockGithubClient(),
      repositoryRepo: createMockRepositoryRepo(),
      subscriptionRepo: createMockSubscriptionRepo({
        findActiveByEmailAndRepoId: vi.fn().mockReturnValue(okAsync(subscription)),
        softDelete,
      }),
      tokenService: createMockTokenService({
        validateToken: vi.fn().mockReturnValue(okAsync(tokenRecord)),
        deleteToken,
      }),
      confirmationEmailsQueue: createMockConfirmationEmailsQueue(),
      metrics: createMockMetrics(),
    });

    await expectOkAsync(service.unsubscribe('unsubscribe-token'));

    expect(softDelete).toHaveBeenCalledWith(subscription.id);
    expect(deleteToken).toHaveBeenCalledWith(tokenRecord.id);
  });

  it('unsubscribe returns NotFound when the subscription is missing', async () => {
    const tokenRecord = createTokenRecord({ type: 'unsubscribe' });

    const service = createSubscriptionService({
      logger,
      githubClient: createMockGithubClient(),
      repositoryRepo: createMockRepositoryRepo(),
      subscriptionRepo: createMockSubscriptionRepo({
        findActiveByEmailAndRepoId: vi.fn().mockReturnValue(errAsync(dbErrors.DBNotFound('sub'))),
      }),
      tokenService: createMockTokenService({
        validateToken: vi.fn().mockReturnValue(okAsync(tokenRecord)),
      }),
      confirmationEmailsQueue: createMockConfirmationEmailsQueue(),
      metrics: createMockMetrics(),
    });

    const error = await expectErrAsync(service.unsubscribe('unsubscribe-token'));

    expect(error.type === 'DBNotFound');
  });

  it('confirm still succeeds when deleting the token fails', async () => {
    const tokenRecord = createTokenRecord();
    const subscription = createSubscription({ repositoryId: tokenRecord.repositoryId });

    const service = createSubscriptionService({
      logger,
      githubClient: createMockGithubClient(),
      repositoryRepo: createMockRepositoryRepo({
        update: vi
          .fn()
          .mockReturnValue(okAsync(createRepository({ id: tokenRecord.repositoryId }))),
      }),
      subscriptionRepo: createMockSubscriptionRepo({
        findActiveByEmailAndRepoId: vi.fn().mockReturnValue(okAsync(subscription)),
        update: vi.fn().mockReturnValue(okAsync(subscription)),
      }),
      tokenService: createMockTokenService({
        validateToken: vi.fn().mockReturnValue(okAsync(tokenRecord)),
        deleteToken: vi
          .fn()
          .mockReturnValue(errAsync(dbErrors.DBError(new Error('delete failed')))),
      }),
      confirmationEmailsQueue: createMockConfirmationEmailsQueue(),
      metrics: createMockMetrics(),
    });

    await expectOkAsync(service.confirm(confirmToken));
    await Promise.resolve();

    const logCall = logger.error.mock.calls[0] as [{ error: unknown }, string] | undefined;

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logCall?.[1]).toBe('DB Error: failed to delete token');
  });
});
