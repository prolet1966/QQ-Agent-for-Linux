// Set mode before importing config, storage and extensions.
process.env.QQ_AGENT_MODE = 'server';
process.env.QQ_AGENT_PRESET ||= 'server-2c2g';
let app;
let stopping;
function shutdown(code = 0) {
  if (stopping) return stopping;
  const deadline = setTimeout(() => process.exit(1), 15000);
  deadline.unref();
  stopping = (async () => {
    try { await app?.stop(); } catch (error) { console.error('[停止失败]', error); code = 1; }
    clearTimeout(deadline);
    process.exit(code);
  })();
  return stopping;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown());
for (const event of ['uncaughtException', 'unhandledRejection']) process.on(event, error => {
  console.error(`[${event}]`, error); shutdown(1);
});
try {
  const { createApp } = await import('./app.js');
  app = createApp();
  await app.start();
} catch (error) { console.error('[启动失败]', error); await shutdown(1); }
