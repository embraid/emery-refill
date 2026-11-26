import { writeMarker, readMarker, initDatabase, seedSyntheticFixtures, seedSyntheticAccounts } from './store.mjs';
import { startServer, SERVER_HOST_DEFAULT } from './server.mjs';

const [modeArg, firstArg, secondArg, thirdArg] = process.argv.slice(2);

if (modeArg === 'server') {
  const dbPath = firstArg ?? 'refill-relay.sqlite';
  const host = secondArg ?? SERVER_HOST_DEFAULT;
  const port = thirdArg === undefined ? 0 : Number.parseInt(thirdArg, 10);
  if (host !== SERVER_HOST_DEFAULT) {
    process.stderr.write(
      JSON.stringify({ ok: false, error: 'non-loopback-host', host, allowed: SERVER_HOST_DEFAULT }) + '\n'
    );
    process.stderr.write(
      `refusing to start the server on ${host}: only the loopback host 127.0.0.1 is permitted\n`
    );
    process.exit(64);
  }
  // Fresh, clean initialization for a new file; idempotent no-ops on an
  // already-initialized file. Never overwrites saved state.
  initDatabase(dbPath);
  seedSyntheticFixtures(dbPath);
  seedSyntheticAccounts(dbPath);
  const { server, close, port: boundPort, host: boundHost } = await startServer({ dbPath, host, port });
  console.log(JSON.stringify({ action: 'serve', dbPath, host: boundHost, port: boundPort }));
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      close().then(() => process.exit(0));
    });
  }
  server.on('close', () => process.exit(0));
} else {
  const dbPath = modeArg ?? 'refill-relay.sqlite';
  const valueArg = firstArg;
  if (valueArg !== undefined) {
    writeMarker(dbPath, valueArg);
    console.log(JSON.stringify({ action: 'write', dbPath, value: valueArg }));
  } else {
    console.log(JSON.stringify({ action: 'read', dbPath, value: readMarker(dbPath) }));
  }
}
