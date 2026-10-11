// Punto di ingresso del daemon: `npm start` (da daemon/).
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './log.js';

const config = loadConfig();
const logger = createLogger({ level: config.logLevel });
const app = createApp({ config, logger });

try {
  await app.start();
} catch (err) {
  if (err?.code === 'EADDRINUSE') {
    console.error(`Porta ${config.port} gia' in uso. Un altro daemon e' in esecuzione? Cambia porta con CP_PORT.`);
  } else {
    console.error(`Avvio non riuscito: ${err?.message ?? err}`);
  }
  process.exit(1);
}
logger.info('started', { port: config.port, host: config.host });

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  logger.info('stopping', { signal });
  await app.stop().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
