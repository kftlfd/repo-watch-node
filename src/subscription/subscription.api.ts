import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import z from 'zod';

import { httpStatus } from '@/utils/http.js';
import { OpenApiTag } from '@/utils/openapi.js';

import type { SubscriptionService } from './subscription.service.js';
import { ApiErrorSchema, ApiOkScheme, SubscribeInputSchema } from './subscription.schema.js';

type Deps = {
  subscriptionService: SubscriptionService;
};

export function createSubscriptionApi({ subscriptionService }: Deps): FastifyPluginCallbackZod {
  return function subscriptionApiRoutes(fastify, _opts, done) {
    fastify.post(
      '/subscribe',
      {
        schema: {
          tags: [OpenApiTag.API],
          consumes: ['application/json', 'application/x-www-form-urlencoded'],
          body: SubscribeInputSchema,
          response: {
            [httpStatus.Ok]: ApiOkScheme.meta({
              description: 'Subscribed, confirmation email sent',
            }),
            [httpStatus.NotFound]: ApiErrorSchema.meta({ description: 'Repo not found' }),
            [httpStatus.Conflict]: ApiErrorSchema.meta({
              description: 'Active subscription for email+repo already exist',
            }),
            [httpStatus.InternalServerError]: ApiErrorSchema.meta({ description: 'Server error' }),
            [httpStatus.Unavailable]: ApiErrorSchema.meta({ description: 'Upstream error' }),
          },
        },
      },
      async (req, reply) => {
        await subscriptionService.subscribe(req.body).match(
          () => {
            return reply
              .code(httpStatus.Ok)
              .send({ message: 'Subscription successful. Confirmation email sent.' });
          },
          (error) => {
            req.log.error({ error }, 'Subscribe error');

            if (error.type === 'GH_NOT_FOUND') {
              return reply.code(httpStatus.NotFound).send({ message: 'Not found' });
            }

            if (error.type === 'ALREADY_SUBSCRIBED') {
              return reply.code(httpStatus.Conflict).send({ message: 'Already subscribed' });
            }

            if (error.type === 'GH_ERROR' || error.type === 'GH_RATE_LIMITED') {
              return reply
                .code(httpStatus.Unavailable)
                .send({ message: 'Error. Please try again later' });
            }

            return reply
              .code(httpStatus.InternalServerError)
              .send({ message: 'Internal server error. Please try again later' });
          },
        );
      },
    );

    fastify.get(
      '/confirm/:token',
      {
        schema: {
          tags: [OpenApiTag.API],
          params: z.object({
            token: z.string().min(10),
          }),
          response: {
            [httpStatus.Ok]: ApiOkScheme.meta({ description: 'Subscription confirmed' }),
            [httpStatus.BadRequest]: ApiErrorSchema.meta({ description: 'Invalid token' }),
            [httpStatus.InternalServerError]: ApiErrorSchema.meta({ description: 'Server error' }),
          },
        },
      },
      async (req, reply) => {
        const { token } = req.params;
        await subscriptionService.confirm(token).match(
          () => {
            return reply
              .code(httpStatus.Ok)
              .send({ message: 'Subscription confirmed successfully.' });
          },
          (error) => {
            req.log.error({ error }, 'Confirm sub error');

            if (error.type === 'DBNotFound') {
              return reply
                .code(httpStatus.BadRequest)
                .send({ message: 'Invalid or expired confirmation token' });
            }

            return reply
              .code(httpStatus.InternalServerError)
              .send({ message: 'Internal server error. Please try again later' });
          },
        );
      },
    );

    fastify.get(
      '/unsubscribe/:token',
      {
        schema: {
          tags: [OpenApiTag.API],
          params: z.object({
            token: z.string().min(10),
          }),
          response: {
            [httpStatus.Ok]: ApiOkScheme.meta({ description: 'Unsubscribed' }),
            [httpStatus.BadRequest]: ApiErrorSchema.meta({ description: 'Invalid token' }),
            [httpStatus.InternalServerError]: ApiErrorSchema.meta({ description: 'Server error' }),
          },
        },
      },
      async (req, reply) => {
        const { token } = req.params;
        await subscriptionService.unsubscribe(token).match(
          () => {
            return reply.code(200).send({ message: 'Unsubscribed successfully.' });
          },
          (error) => {
            req.log.error({ error }, 'Unsubscribe error');

            if (error.type === 'DBNotFound') {
              return reply
                .code(httpStatus.BadRequest)
                .send({ message: 'Invalid or expired token' });
            }

            return reply
              .code(httpStatus.InternalServerError)
              .send({ message: 'Internal server error. Please try again later' });
          },
        );
      },
    );

    fastify.get(
      '/subscriptions',
      {
        schema: {
          tags: [OpenApiTag.API],
          querystring: z.object({
            email: z.email().meta({ example: 'user@mail.com' }),
          }),
          response: {
            [httpStatus.Ok]: z
              .array(
                z.object({
                  email: z.string(),
                  repo: z.string(),
                  confirmed: z.boolean(),
                  last_seen_tag: z.string().nullable(),
                }),
              )
              .meta({ description: 'List of subscriptions for email' }),
            [httpStatus.InternalServerError]: ApiErrorSchema.meta({ description: 'Server error' }),
          },
        },
      },
      async (req, reply) => {
        const { email } = req.query;
        await subscriptionService.listSubscriptions(email).match(
          (subs) => {
            return reply.code(httpStatus.Ok).send(subs);
          },
          (error) => {
            req.log.error({ error }, 'List subscriptions error');

            return reply
              .code(httpStatus.InternalServerError)
              .send({ message: 'Internal server error' });
          },
        );
      },
    );

    done();
  };
}
