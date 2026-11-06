import { buildApp } from './app.js';
import { EnvError, loadEnv } from './config/env.js';

async function main(): Promise<void> {
  let env;
  try {
    env = loadEnv();
  } catch (error) {
    if (error instanceof EnvError) {
      console.error(`\nConfiguration error: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const { app, db } = await buildApp({ env, logger: true });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: env.port, host: env.host });
  app.log.info(
    { authMode: env.authMode, dataDir: env.dataDir },
    `freeLatex server listening on http://${env.host}:${env.port}`,
  );
}

main().catch((error: unknown) => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});
