import type { FastifyPluginCallback } from 'fastify';
import formbody from '@fastify/formbody';
import fastifySwagger from '@fastify/swagger';
import scalarApiReference from '@scalar/fastify-api-reference';
import Fastify from 'fastify';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';

import type { ServerConfig } from '@/config/config.js';
import type { RuntimeStatus } from '@/lib/runtime/runtime.js';
import type { Logger } from '@/logger/logger.js';
import type { MetricsRegistry, ServerMetrics } from '@/metrics/metrics.js';
import { defineModule } from '@/lib/runtime/runtime.js';

const requestTimer = Symbol('request-timer');

type Deps = {
  config: ServerConfig;
  logger: Logger;
  metrics: ServerMetrics;
  metricsRegistry: MetricsRegistry;
  runtimeStatus: RuntimeStatus;
  subscriptionApi: FastifyPluginCallback;
  subscriptionWeb: FastifyPluginCallback;
};

export function createFastifyServer({
  config,
  logger,
  metrics,
  metricsRegistry,
  runtimeStatus,
  subscriptionApi,
  subscriptionWeb,
}: Deps) {
  const app = Fastify({
    loggerInstance: logger,
  });

  app.addHook('onRequest', (req, reply, done) => {
    (req as typeof req & { [requestTimer]: () => number })[requestTimer] =
      metrics.requestsDuration.startTimer({
        method: req.method,
        path: req.routeOptions.url,
      });
    done();
  });

  app.addHook('onResponse', (req, reply, done) => {
    (req as typeof req & { [requestTimer]: () => number })[requestTimer]();
    metrics.requestsTotal.inc({
      method: req.method,
      path: req.routeOptions.url,
      status: reply.statusCode,
    });
    done();
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'GitHub Release Notifications API',
        description: 'Subscribe to email notifications for new releases of GitHub repo',
        version: '1.0.0',
      },
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });

  app.register(scalarApiReference, {
    routePrefix: '/docs',
    configuration: {
      agent: { disabled: true },
      mcp: { disabled: true },
      hideClientButton: true,
      defaultOpenAllTags: true,
    },
  });

  app.register((adminRoutes, opts, done) => {
    adminRoutes.addHook('onRequest', (req, reply, done) => {
      if (req.headers.authorization !== `Bearer ${config.adminApiKey}`) {
        reply.callNotFound();
        return;
      }
      done();
    });

    adminRoutes.get('/metrics', { schema: { hide: true } }, (req, reply) => {
      reply.header('content-type', metricsRegistry.contentType);
      return metricsRegistry.metrics();
    });

    adminRoutes.get('/live', { schema: { hide: true } }, (req, reply) => {
      const status = runtimeStatus.getState();
      reply.code(status !== 'stopped' ? 200 : 503);
      return status;
    });

    adminRoutes.get('/health', { schema: { hide: true } }, (req, reply) => {
      const status = runtimeStatus.getState();
      reply.code(status === 'running' ? 200 : 503);
      return status;
    });

    done();
  });

  app.register(formbody);

  app.register(subscriptionApi, { prefix: '/api' });
  app.register(subscriptionWeb);

  return defineModule('fastify-server', {
    async start() {
      await app.listen({ host: config.host, port: config.port });
      await app.ready();
    },
    async stop() {
      await app.close();
    },
  });
}
