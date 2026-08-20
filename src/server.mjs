import { buildApp } from './app.mjs';
import { config } from './config.mjs';

const app = await buildApp();

try {
  await app.listen({ host: config.host, port: config.port });
  process.stdout.write(`Manga P0 Studio is ready at http://${config.host}:${config.port}\n`);
} catch (error) {
  process.stderr.write('Manga P0 Studio could not start.\n');
  process.exitCode = 1;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
