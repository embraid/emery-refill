import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import http from 'node:http';
import {
  initDatabase,
  seedSyntheticFixtures,
  seedSyntheticAccounts,
} from '../store.mjs';
import { startServer } from '../server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const INDEX = join(here, '..', 'index.mjs');

// Non-loopback hosts that must be rejected at both entry points.
const BAD_HOSTS = ['0.0.0.0', '::', 'localhost', '127.0.0.2', '192.0.2.1'];

// Deterministic listen spy: every node:http Server listens through
// Server.prototype.listen (node:http's internal references resolve through
// the same prototype dispatch), so wrapping the prototype method observes
// every listen invocation from any module, including the adapter. A
// rejected host must never be able to reach this boundary.
function spyListen() {
  const listens = [];
  const realListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function wrappedListen(...args) {
    listens.push(args);
    return realListen.apply(this, args);
  };
  return {
    listens,
    realListen,
    restore() {
      http.Server.prototype.listen = realListen;
    },
  };
}

function makeDb(tag) {
  const dir = mkdtempSync(join(tmpdir(), `refill-relay-loopback-${tag}-`));
  const dbPath = join(dir, 'loopback.sqlite');
  initDatabase(dbPath);
  seedSyntheticFixtures(dbPath);
  seedSyntheticAccounts(dbPath);
  return { dir, dbPath };
}

// Run `node index.mjs server [args...]` and collect { code, stdout, stderr }.
function runCli(args, timeoutMs = 8000) {
  const child = spawn(process.execPath, [INDEX, 'server', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += String(d)));
  child.stderr.on('data', (d) => (stderr += String(d)));
  const killTimer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already dead */
    }
  }, timeoutMs);
  return new Promise((resolve) => {
    child.on('close', (code) => {
      clearTimeout(killTimer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(killTimer);
      resolve({ code: -1, stdout, stderr: stderr + String(err) });
    });
  });
}

test('adapter: startServer rejects any non-loopback host before listen; 127.0.0.1:0 still binds', async () => {
  const { dir, dbPath } = makeDb('adapter');
  try {
    // 1) The default (127.0.0.1, port 0) still works — the positive control
    //    for the rejections below.
    const ok = await startServer({ dbPath });
    assert.equal(ok.host, '127.0.0.1');
    assert.ok(ok.port > 0, 'ephemeral port bound');
    await ok.close();

    // 2) Deterministic spy: a non-loopback host must throw synchronously
    //    and the node:http listen boundary must never be reached for it.
    const spies = spyListen();
    try {
      let rejected = null;
      let returned = 'sentinel';
      for (const badHost of BAD_HOSTS) {
        try {
          returned = startServer({ dbPath, host: badHost, port: 0 });
        } catch (err) {
          rejected = err;
        }
        assert.equal(
          spies.listens.length,
          0,
          `startServer(host=${badHost}) must not reach node:http listen`
        );
        assert.ok(rejected, `startServer(host=${badHost}) must throw`);
        assert.match(
          String(rejected.message),
          /only the loopback host 127\.0\.0\.1 is permitted/,
          `host=${badHost}: fixed rejection message`
        );
        assert.ok(!String(rejected.message).includes('listen'), 'message is fixed, not a listen error');
        rejected = null;
      }
      assert.equal(
        returned,
        'sentinel',
        'sentinel untouched: no server was ever returned for a non-loopback host'
      );
    } finally {
      spies.restore();
    }
    assert.equal(
      spies.listens.length,
      0,
      'node:http listen was never reached for any non-loopback host'
    );

    // 3) The real (unspied) attempts throw synchronously too: the check is
    //    a plain synchronous throw, so no server object exists to close.
    for (const badHost of ['0.0.0.0', '::']) {
      assert.throws(
        () => startServer({ dbPath, host: badHost, port: 0 }),
        /only the loopback host 127\.0\.0\.1 is permitted/,
        `real call host=${badHost}`
      );
    }

    // 4) The adapter is still healthy after the rejections (no listener was
    //    ever created for the refused hosts).
    const ok2 = await startServer({ dbPath, host: '127.0.0.1', port: 0 });
    assert.equal(ok2.host, '127.0.0.1');
    await ok2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: rejects a caller-supplied non-loopback host before invoking the server (exit 64, no db, no serve); 127.0.0.1:0 still starts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'refill-relay-loopback-cli-'));
  try {
    // Each probe uses its own nonexistent (absolute) database path under
    // the disposable directory: a rejection that happens BEFORE
    // initialization must not create any file (not even a SQLite file).
    const probes = [
      { name: 'all-interfaces', db: join(dir, 'probe-000000.sqlite'), args: [join(dir, 'probe-000000.sqlite'), '0.0.0.0', '0'] },
      { name: 'ipv6-any', db: join(dir, 'probe-v6any.sqlite'), args: [join(dir, 'probe-v6any.sqlite'), '::', '0'] },
    ];
    for (const probe of probes) {
      const result = await runCli(probe.args);
      assert.equal(result.code, 64, `${probe.name}: exit code 64 (EX_USAGE) — refused before any server work`);
      // Fixed, machine-readable denial record on stderr; no case data.
      const firstLine = result.stderr.split('\n').find((l) => l.startsWith('{'));
      const record = firstLine ? JSON.parse(firstLine) : null;
      assert.ok(record, `${probe.name}: fixed error record on stderr`);
      assert.equal(record.ok, false, `${probe.name}: record ok flag`);
      assert.equal(record.error, 'non-loopback-host', `${probe.name}: fixed error kind`);
      assert.equal(record.allowed, '127.0.0.1', `${probe.name}: only 127.0.0.1 is permitted`);
      assert.ok(!/action/.test(result.stdout), `${probe.name}: no serve action was printed`);
      assert.equal(result.stdout.trim(), '', `${probe.name}: stdout is empty (server never started)`);
      // No database file was created: rejection precedes initialization.
      assert.equal(existsSync(probe.db), false, `${probe.name}: no database file created before the refusal`);
    }

    // Positive control: 127.0.0.1 with port 0 (ephemeral) is still
    // permitted by the CLI. It must initialize its own database, start,
    // print the serve record, and answer a loopback request; then it is
    // terminated (the probe DB is disposable).
    const okPath = join(dir, 'cli-ok.sqlite');
    const child = spawn(process.execPath, [INDEX, 'server', okPath, '127.0.0.1', '0'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let port = 0;
    child.stdout.on('data', (d) => {
      out += String(d);
      const m = out.match(/"port":(\d+)/);
      if (m) port = Number(m[1]);
    });
    const started = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 8000);
      const watch = () => {
        if (port > 0) {
          clearTimeout(timer);
          resolve(true);
        }
      };
      child.stdout.on('data', watch);
    });
    assert.equal(await started, true, 'CLI 127.0.0.1:0 control started on an ephemeral port');
    assert.match(out, /"action":"serve"/, 'control printed the serve record');
    assert.match(out, /"host":"127\.0\.0\.1"/, 'control bound loopback');
    assert.ok(existsSync(okPath), 'control created its database after passing the host check');

    // The control is serving on loopback: a real GET succeeds.
    const res = await fetch(`http://127.0.0.1:${port}/`, { headers: { Connection: 'close' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true, signed_in: false, identity: null });

    child.kill('SIGTERM');
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 5000);
      child.on('close', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    assert.equal(code, 0, 'CLI control exits cleanly on SIGTERM');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loopback binding (combined proof): rejected hosts never reach node:http listen; 127.0.0.1:0 binds only loopback', async () => {
  // The combined proof is deterministic over the node:http listen boundary
  // itself — no /proc baseline, no listener scans:
  //   - every rejected adapter call throws synchronously BEFORE listen is
  //     invoked (the listen spy counts zero invocations for refused
  //     hosts);
  //   - the positive control (127.0.0.1, port 0) is the ONLY listen in the
  //     whole proof;
  //   - the CLI child processes cannot be spied in-process, so the CLI
  //     probes are closed by their exit-code + no-database-file + empty
  //     stdout evidence (test 2): the host check precedes initialization
  //     and server startup, so the server code path is never invoked there.
  const { dir, dbPath } = makeDb('combined');
  const spies = spyListen();
  let control = null;
  try {
    // Positive control at the adapter entry point (127.0.0.1, port 0) —
    // it IS allowed to reach listen; exactly once.
    control = await startServer({ dbPath, host: '127.0.0.1', port: 0 });
    assert.equal(spies.listens.length, 1, 'control invoked listen exactly once');
    assert.deepEqual(
      spies.listens[0].slice(0, 2),
      [0, '127.0.0.1'],
      'the only listen so far is the positive control: 127.0.0.1 on port 0 (ephemeral)'
    );
    assert.equal(control.host, '127.0.0.1', 'control bound loopback only');
    assert.ok(control.port > 0, 'control bound an ephemeral port');

    // Every rejected adapter host must never reach the listen boundary.
    let rejected = null;
    let returned = 'sentinel';
    for (const badHost of BAD_HOSTS) {
      try {
        returned = startServer({ dbPath, host: badHost, port: 0 });
      } catch (err) {
        rejected = err;
      }
      assert.equal(
        spies.listens.length,
        1,
        `host=${badHost}: listen still only the control's single invocation`
      );
      assert.ok(rejected, `host=${badHost}: rejected synchronously`);
      assert.match(String(rejected.message), /only the loopback host 127\.0\.0\.1 is permitted/);
      rejected = null;
    }
    assert.equal(returned, 'sentinel', 'no server was ever returned for a non-loopback host');
  } finally {
    spies.restore();
    if (control) await control.close();
    rmSync(dir, { recursive: true, force: true });
  }
  // After restore: the listen boundary is back to the real node:http
  // implementation (nothing else in this file mutates it).
  assert.equal(
    http.Server.prototype.listen,
    spies.realListen,
    'Server.prototype.listen restored to the real node:http implementation'
  );
});
