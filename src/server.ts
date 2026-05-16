/**
 * HTTP server bootstrap.
 *
 * Builds the Fastify app, starts listening, and wires graceful shutdown
 * on SIGINT/SIGTERM. Anything more elaborate (clustering, prefork, etc.)
 * is out of scope — Fastify in a single process handles tens of thousands
 * of req/s and the assignment is one endpoint.
 */

import { buildApp } from './app';
import { logger } from './logger';

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const HOST = process.env.HOST ?? '0.0.0.0';

async function main(): Promise<void> {
  const app = await buildApp();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down');
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    const address = await app.listen({ port: PORT, host: HOST });
    logger.info({ address }, 'Listening');
  } catch (err) {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  }
}

void main();
