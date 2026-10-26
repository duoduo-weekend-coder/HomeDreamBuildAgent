import { createApp } from './app.mjs';

if (process.env.HOST && !['127.0.0.1', 'localhost', '::1'].includes(process.env.HOST) && !process.env.WORKSPACE_TOKEN) throw new Error('Set WORKSPACE_TOKEN before binding to a non-local interface.');
const app = createApp();
app.service.recoverInterrupted();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
app.server.listen(port, host, () => console.log(`Home Dream Build → http://${host}:${port}\nInstagram acquisition workspace · check Settings for provider modes`));
const worker = setInterval(() => app.service.tick().catch(error => console.error('Background queue:', error.message)), 15000);
worker.unref();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { clearInterval(worker); app.server.close(async () => { await app.service.tick().catch(() => {}); app.close(); process.exit(0); }); });
