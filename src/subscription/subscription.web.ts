import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import z from 'zod';

import { httpStatus } from '@/utils/http.js';
import { OpenApiTag } from '@/utils/openapi.js';

import type { SubscriptionService } from './subscription.service.js';
import { HtmlResponseScheme, SubscribeInputSchema } from './subscription.schema.js';
import {
  renderConfirmError,
  renderConfirmSuccess,
  renderHomeForm,
  renderSubscribeError,
  renderSubscribeSuccess,
  renderUnsubscribeError,
  renderUnsubscribeSuccess,
} from './templates.js';

type Deps = {
  subscriptionService: SubscriptionService;
};

export function createSubscriptionWeb({ subscriptionService }: Deps): FastifyPluginCallbackZod {
  return function subscriptionWebRoutes(fastify, _opts, done) {
    fastify.get(
      '/',
      {
        schema: {
          tags: [OpenApiTag.Web],
          consumes: [],
          produces: ['text/html'],
          response: {
            [httpStatus.Ok]: HtmlResponseScheme.meta({ description: 'Home page' }),
          },
        },
      },
      async (_req, reply) => {
        return reply.type('text/html').send(renderHomeForm());
      },
    );

    fastify.post(
      '/subscribe',
      {
        schema: {
          tags: [OpenApiTag.Web],
          body: SubscribeInputSchema,
          consumes: ['multipart/form-data', 'application/x-www-form-urlencoded'],
          produces: ['text/html'],
          response: {
            [httpStatus.Ok]: HtmlResponseScheme.meta({ description: 'Subscribe form' }),
            [httpStatus.BadRequest]: HtmlResponseScheme.meta({ description: 'Invalid inputs' }),
            [httpStatus.NotFound]: HtmlResponseScheme.meta({ description: 'Repo not found' }),
            [httpStatus.Conflict]: HtmlResponseScheme.meta({
              description: 'Active subscription for email+repo already exists',
            }),
            [httpStatus.InternalServerError]: HtmlResponseScheme.meta({
              description: 'Server error',
            }),
            [httpStatus.Unavailable]: HtmlResponseScheme.meta({ description: 'Upstream error' }),
          },
        },
      },
      async (req, reply) => {
        reply.type('text/html');
        await subscriptionService.subscribe(req.body).match(
          () => {
            return reply.code(httpStatus.Ok).send(renderSubscribeSuccess());
          },
          (error) => {
            req.log.error({ error: error });

            if (error.type === 'GH_NOT_FOUND') {
              return reply.code(httpStatus.NotFound).send(renderSubscribeError('Not found'));
            }

            if (error.type === 'ALREADY_SUBSCRIBED') {
              return reply
                .code(httpStatus.Conflict)
                .send(renderSubscribeError('Already subscribed'));
            }

            if (error.type === 'GH_ERROR' || error.type === 'GH_RATE_LIMITED') {
              return reply
                .code(httpStatus.Unavailable)
                .send(renderSubscribeError('Error. Please try again later'));
            }

            return reply
              .code(httpStatus.InternalServerError)
              .send(renderSubscribeError('Internal server error. Please try again later'));
          },
        );
      },
    );

    fastify.get(
      '/confirm/:token',
      {
        schema: {
          tags: [OpenApiTag.Web],
          params: z.object({
            token: z.string().min(10),
          }),
          consumes: [],
          produces: ['text/html'],
          response: {
            [httpStatus.Ok]: HtmlResponseScheme.meta({ description: 'Subscription confirmed' }),
            [httpStatus.BadRequest]: HtmlResponseScheme.meta({ description: 'Invalid token' }),
            [httpStatus.InternalServerError]: HtmlResponseScheme.meta({
              description: 'Server error',
            }),
          },
        },
      },
      async (req, reply) => {
        const { token } = req.params;
        reply.type('text/html');
        await subscriptionService.confirm(token).match(
          () => {
            return reply.code(httpStatus.Ok).send(renderConfirmSuccess());
          },
          (error) => {
            req.log.error({ error });

            if (error.type === 'DBNotFound') {
              return reply
                .code(httpStatus.BadRequest)
                .send(renderConfirmError('Invalid or expired confirmation link'));
            }

            return reply
              .code(httpStatus.InternalServerError)
              .send(renderConfirmError('Internal server error. Please try again later'));
          },
        );
      },
    );

    fastify.get(
      '/unsubscribe/:token',
      {
        schema: {
          tags: [OpenApiTag.Web],
          params: z.object({
            token: z.string().min(10),
          }),
          consumes: [],
          produces: ['text/html'],
          response: {
            [httpStatus.Ok]: HtmlResponseScheme.meta({ description: 'Unsubscribed' }),
            [httpStatus.BadRequest]: HtmlResponseScheme.meta({ description: 'Invalid token' }),
            [httpStatus.InternalServerError]: HtmlResponseScheme.meta({
              description: 'Server error',
            }),
          },
        },
      },
      async (req, reply) => {
        const { token } = req.params;
        reply.type('text/html');
        await subscriptionService.unsubscribe(token).match(
          () => {
            return reply.code(httpStatus.Ok).send(renderUnsubscribeSuccess());
          },
          (error) => {
            req.log.error({ error });

            if (error.type === 'DBNotFound') {
              return reply
                .code(httpStatus.BadRequest)
                .send(renderUnsubscribeError('Invalid or expired link'));
            }

            return reply
              .code(httpStatus.InternalServerError)
              .send(renderUnsubscribeError('Internal server error. Please try again later'));
          },
        );
      },
    );

    done();
  };
}
