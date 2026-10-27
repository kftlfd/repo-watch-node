import { err, errAsync, ok, ResultAsync } from 'neverthrow';
import { z, ZodType } from 'zod';

import type { GithubClientConfig } from '@/config/config.js';
import type { GithubMetrics } from '@/metrics/metrics.js';
import type {
  HttpBadResponseError,
  HttpNetworkError,
  HttpNotFoundError,
  HttpTooManyRequestsError,
  HttpUnautorizedError,
  HttpUnknownError,
} from '@/utils/http.js';
import { httpErrors } from '@/utils/http.js';

import { ReleaseSchema, RepoResponseSchema, TagSchema, toRepo } from './github.schema.js';

function parseRetryAfterSeconds(header: string | null | undefined) {
  if (!header) return null;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds);
  }

  const timestamp = new Date(header).getTime();
  if (Number.isFinite(timestamp)) {
    return Math.max(0, Math.ceil((timestamp - Date.now()) / 1_000));
  }

  return null;
}

function parseRateLimitResetSeconds(header: string | null | undefined) {
  if (!header) return null;

  const resetAtSeconds = Number(header);
  if (Number.isFinite(resetAtSeconds)) {
    return Math.max(0, Math.ceil((resetAtSeconds * 1000 - Date.now()) / 1_000));
  }

  return null;
}

function getRetryAfterSeconds(response: Response) {
  return (
    parseRetryAfterSeconds(response.headers.get('retry-after')) ??
    parseRateLimitResetSeconds(response.headers.get('x-ratelimit-reset'))
  );
}

function isGithubRateLimitResponse(response: Response, bodyText: string) {
  const remaining = response.headers.get('x-ratelimit-remaining');
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  if (remaining === '0') return true;
  return bodyText.toLowerCase().includes('rate limit');
}

type ParseLimitResult =
  | { isRateLimitError: false }
  | { isRateLimitError: true; retryAfterSeconds: number | null };

function parseRateLimitResponse(response: Response, bodyText: string): ParseLimitResult {
  if (!isGithubRateLimitResponse(response, bodyText)) {
    return { isRateLimitError: false };
  }
  return { isRateLimitError: true, retryAfterSeconds: getRetryAfterSeconds(response) };
}

export type HttpRequestError =
  | HttpNotFoundError
  | HttpTooManyRequestsError
  | HttpUnautorizedError
  | HttpUnknownError;

export function mapResponseToError(response: Response): ResultAsync<never, HttpRequestError> {
  if (response.status === 404) {
    return errAsync(httpErrors.NotFound('Repo not found'));
  }

  const bodyTextResult = ResultAsync.fromSafePromise(response.text().catch(() => ''));

  return bodyTextResult.andThen((body) => {
    const res = parseRateLimitResponse(response, body);

    if (res.isRateLimitError) {
      return errAsync(httpErrors.TooManyRequests(res.retryAfterSeconds));
    }

    if (response.status === 401 || response.status === 403) {
      return errAsync(httpErrors.Unauthorized('Authentication failed'));
    }

    return errAsync(httpErrors.Unknown(response.status, response.statusText));
  });
}

export type GithubClient = ReturnType<typeof createGithubClient>;

type Deps = {
  config: GithubClientConfig;
  metrics: GithubMetrics;
};

export function createGithubClient({ config, metrics }: Deps) {
  function getHeaders() {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (config.authToken) {
      headers['Authorization'] = `Bearer ${config.authToken}`;
    }
    return headers;
  }

  function httpGet<TSchema extends ZodType>(
    url: string,
    bodySchema: TSchema,
    abortSignal?: AbortSignal,
  ): ResultAsync<
    z.infer<TSchema>,
    | { type: 'ABORTED' }
    | { type: 'TIMEOUT' }
    | { type: 'HTTP_ERROR'; error: HttpNetworkError | HttpRequestError | HttpBadResponseError }
  > {
    const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
    const signal = abortSignal ? AbortSignal.any([abortSignal, timeoutSignal]) : timeoutSignal;

    const request = fetch(url, { headers: getHeaders(), signal });

    const response = ResultAsync.fromPromise(request, (e) => {
      if (e instanceof Error && e.name === 'AbortError') {
        return { type: 'ABORTED' as const };
      }
      if (e instanceof Error && e.name === 'TimeoutError') {
        return { type: 'TIMEOUT' as const };
      }
      return httpErrors.NetworkError(e);
    });

    const checked = response.andThen((resp) => (resp.ok ? ok(resp) : mapResponseToError(resp)));

    const jsonData = checked.andThen((resp) =>
      ResultAsync.fromPromise(resp.json(), () => httpErrors.BadResponse('Failed to parse json')),
    );

    const parsedBody = jsonData.andThen((resp) => {
      const parsed = bodySchema.safeParse(resp);
      return parsed.success
        ? ok(parsed.data)
        : err(httpErrors.BadResponse('Failed to validate body'));
    });

    return parsedBody
      .orTee((error) => {
        metrics.onError();
        if (error.type === 'HttpTooManyRequests') {
          metrics.onRateLimitError();
        }
      })
      .mapErr((e) => {
        if (e.type !== 'ABORTED' && e.type !== 'TIMEOUT') {
          return { type: 'HTTP_ERROR', error: e };
        }
        return e;
      });
  }

  function getRepo(owner: string, repo: string, signal?: AbortSignal) {
    return httpGet(`${config.baseUrl}/repos/${owner}/${repo}`, RepoResponseSchema, signal).map(
      toRepo,
    );
  }

  function getLatestReleaseTag(owner: string, repo: string, signal?: AbortSignal) {
    return httpGet(
      `${config.baseUrl}/repos/${owner}/${repo}/releases/latest`,
      ReleaseSchema,
      signal,
    ).map((data) => data.tag_name);
  }

  function getLatestTag(owner: string, repo: string, signal?: AbortSignal) {
    return httpGet(
      `${config.baseUrl}/repos/${owner}/${repo}/tags`,
      z.array(TagSchema),
      signal,
    ).andThen((data) => {
      const tagValue = data[0]?.name;
      return tagValue ? ok(tagValue) : err({ type: 'NO_LATEST_TAG' as const });
    });
  }

  function getLatestRelease(owner: string, repo: string, signal?: AbortSignal) {
    return getLatestReleaseTag(owner, repo, signal).orElse((error) =>
      error.type === 'HTTP_ERROR' && error.error.type === 'HttpNotFound'
        ? getLatestTag(owner, repo, signal)
        : err(error),
    );
  }

  return {
    getRepo,
    getLatestRelease,
  };
}
