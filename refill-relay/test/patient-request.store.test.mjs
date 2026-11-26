import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import {
  STATUS_LABELS,
  EVENT_TYPES,
  initDatabase,
  initSchema,
  seedSyntheticFixtures,
  seedSyntheticAccounts,
  signIn,
  caseRefFor,
  askPatientForRenewal,
} from '../store.mjs';

// --- helpers ---------------------------------------------------------------

function freshDb(label) {
  const dir = mkdtempSync(join(tmpdir(), `refill-relay-${label}-`));
  const dbPath = join(dir, `${label}.sqlite`);
  initDatabase(dbPath);
  seedSyntheticFixtures(dbPath);
  seedSyntheticAccounts(dbPath);
  return { dir, dbPath };
}

// The accepted eligible-create target that the fixture set deliberately
// does NOT provide (all three seeded prescriptions are terminal, pending,
// or ineligible): a deterministic zero-refill prescription for an
// unrelated seeded patient, with no renewal.
const CREATE_RX = Object.freeze({
  id: 'eligible-ask-rx',
  patient_id: 'denial-patient',
  pharmacy_id: 'pharmacy-dunmore',
  prescriber_id: 'denial-prescriber',
  refills_remaining: 0,
});

function seedCreateTarget(dbPath) {
  const db = initDatabase(dbPath);
  try {
    db.prepare(
      `INSERT INTO prescriptions (id, patient_id, pharmacy_id, prescriber_id, refills_remaining, is_synthetic)
       VALUES (?, ?, ?, ?, 0, 1)`
    ).run(CREATE_RX.id, CREATE_RX.patient_id, CREATE_RX.pharmacy_id, CREATE_RX.prescriber_id);
  } finally {
    db.close();
  }
}

function identityFor(dbPath, username, password) {
  const res = signIn(dbPath, username, password);
  assert.equal(res.status, 200, `sign-in ${username} succeeds`);
  return res.body.identity;
}

// Scalar-only snapshot of every data table (normalized to arrays of scalar
// values, never raw SQLite rows) for before/after durable-state equality.
function fullTableState(dbPath) {
  const db = initDatabase(dbPath);
  try {
    const snapshot = (table, orderExpr) =>
      db
        .prepare(`SELECT * FROM ${table} ORDER BY ${orderExpr}`)
        .all()
        .map((r) => Object.values(r));
    return {
      markers: snapshot('markers', 'key'),
      identities: snapshot('identities', 'id'),
      prescriptions: snapshot('prescriptions', 'id'),
      renewals: snapshot('renewals', 'id'),
      renewal_events: snapshot('renewal_events', 'id'),
      pharmacy_conversation_messages: snapshot('pharmacy_conversation_messages', 'id'),
      office_messages: snapshot('office_messages', 'id'),
      phone_notes: snapshot('phone_notes', 'id'),
      sessions: snapshot('sessions', 'token'),
      synthetic_accounts: snapshot('synthetic_accounts', 'username'),
    };
  } finally {
    db.close();
  }
}

function assertStateUnchanged(after, before, label) {
  for (const table of Object.keys(before)) {
    assert.deepEqual(
      after[table],
      before[table],
      `${label}: table ${table} unchanged`
    );
  }
}

// Values whose appearance in a denial's serialization would count as a
// case-data disclosure (fixture ids, names, statuses, timestamps — the
// estate's CASE_DATA_TOKENS convention).
const CASE_DATA_TOKENS = [
  'ending-a-renewal', 'ending-b-renewal',
  'ending-a-rx', 'ending-b-rx', 'denial-rx',
  CREATE_RX.id,
  'ending-a-patient', 'ending-b-patient', 'denial-patient',
  'ending-a-prescriber', 'ending-b-prescriber', 'denial-prescriber',
  'pharmacy-cedar', 'pharmacy-dunmore',
  'Ava Mercer', 'Boris Laine', 'Cleo Voss',
  'Dr. Naomi Okafor', 'Dr. Priya Raman', 'Dr. Emil Hart',
  'Cedar Crossing Pharmacy', 'Dunmore Corner Pharmacy',
  STATUS_LABELS.SENT_TO_PHARMACY,
  STATUS_LABELS.AWAITING_PRESCRIBER,
  STATUS_LABELS.RENEWAL_APPROVED,
  STATUS_LABELS.VISIT_REQUIRED,
  '2026-11-21T08:00:00Z', '2026-11-21T08:30:00Z', '2026-11-21T09:00:00Z',
  '2026-11-21T10:00:00Z',
];

function assertNoCaseData(result, label) {
  const serialized = JSON.stringify(result);
  for (const token of CASE_DATA_TOKENS) {
    assert.ok(
      !serialized.includes(token),
      `${label}: denial result must not disclose case data (found ${JSON.stringify(token)} in ${serialized})`
    );
  }
}

const expectUniqueConstraintError = (err) =>
  assert.match(
    String(err.message),
    /UNIQUE constraint failed:\s*\S*\.?/i,
    `expected a UNIQUE constraint violation, got: ${err.message}`
  );

const WORKER_SCRIPT = `
  import { DatabaseSync } from 'node:sqlite';
  import { parentPort } from 'node:worker_threads';
  const dbPath = process.env.RFRL_DB_PATH;
  const rx = process.env.RFRL_RX_ID;
  const winnerId = process.env.RFRL_WINNER_ID;
  const patientId = process.env.RFRL_PATIENT_ID;
  const pharmacyId = process.env.RFRL_PHARMACY_ID;
  const prescriberId = process.env.RFRL_PRESCRIBER_ID;
  const fail = (message) => {
    parentPort.postMessage({ type: 'error', message });
    process.exitCode = 1;
  };
  (async () => {
    const sab = await new Promise((resolve, reject) => {
      parentPort.once('message', (m) => {
        if (m && m.type === 'sab') resolve(m.sab);
        else reject(new Error('unexpected first worker message'));
      });
    });
    const flag = new Int32Array(sab);
    // Wait for the main thread to finish all of its setup writes. The main
    // thread pairs Atomics.store with Atomics.notify, so this normally
    // wakes by notification; after ANY wake or timeout the flag is
    // RECHECKED before acting (a timed-out wait must not fail the barrier
    // if the main thread set the flag concurrently with the wake).
    for (;;) {
      if (Atomics.load(flag, 0) === 1) break;
      Atomics.wait(flag, 0, 0, 1000);
      if (Atomics.load(flag, 0) !== 1) {
        fail('main thread did not signal readiness in time');
        return;
      }
    }
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    try {
      const at = new Date().toISOString();
      db.exec('BEGIN IMMEDIATE');
      db.prepare(
        'INSERT INTO renewals (id, prescription_id, patient_id, pharmacy_id, prescriber_id, status, next_actor, submitted_at, handoff_at, decided_at, granted_refills, request_idempotency_key, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 1)'
      ).run(winnerId, rx, patientId, pharmacyId, prescriberId, 'Sent to pharmacy', 'pharmacy', at);
      db.prepare(
        'INSERT INTO renewal_events (renewal_id, event_type, actor_role, actor_id, occurred_at, payload) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(winnerId, 'submitted', 'patient', patientId, at, JSON.stringify({ synthetic: true, winner: true }));
      db.exec('COMMIT');
      db.exec('BEGIN IMMEDIATE');
      // Barrier 1: the write lock is now held. The store is paired with an
      // explicit Atomics.notify (the shared flag alone is
      // unreliable — a waiting party that times out must recheck the flag,
      // and a party that has not yet entered its wait must still be
      // woken), so the main thread observes this synchronously and starts
      // its ask with the lock provably held.
      Atomics.store(flag, 1, 1);
      Atomics.notify(flag, 1);
      parentPort.postMessage({ type: 'holding' });
      // Barrier 2: hold the write lock until the MAIN thread reports the
      // ask's first BEGIN IMMEDIATE write-lock error (cell 2), which is the
      // deterministic "the ask is now contending for this lock" signal.
      // This — not a fixed hold duration — is what guarantees the retry
      // fires: even if the main thread's first probe lands after this point,
      // the lock is still held, so that probe cannot have succeeded.
      // The store is paired with Atomics.notify, and after ANY wake or
      // timeout the flag is RECHECKED before acting, so the release signal
      // is never missed even if it arrives during the wait.
      for (;;) {
        if (Atomics.load(flag, 2) === 1) break;
        Atomics.wait(flag, 2, 0, 1000);
        if (Atomics.load(flag, 2) !== 1) {
          fail('the ask never reported a write-lock error while the lock was held');
          return;
        }
      }
      db.exec('ROLLBACK');
      Atomics.store(flag, 2, 2); // release acknowledged: the lock is now free
      Atomics.notify(flag, 2);
      parentPort.postMessage({ type: 'released' });
    } catch (err) {
      fail(String((err && err.message) || err));
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
    parentPort.postMessage({ type: 'done' });
  })().catch((err) => fail(String((err && err.message) || err)));
`;

function startWorkerHolder(dbPath, { winnerId }) {
  // 12 bytes: cell 0 = main-ready (set by the main thread after its setup
  // writes), cell 1 = worker-holding (set by the worker after the winner is
  // committed and the write lock acquired), cell 2 = the release handoff:
  // 1 when the main thread reports the ask's first write-lock error (the
  // worker releases on it), 2 when the worker has acknowledged the release
  // (the lock is now free and the retry may acquire it).
  const sab = new SharedArrayBuffer(12);
  const flag = new Int32Array(sab);
  const env = {
    RFRL_DB_PATH: dbPath,
    RFRL_RX_ID: CREATE_RX.id,
    RFRL_WINNER_ID: winnerId,
    RFRL_PATIENT_ID: CREATE_RX.patient_id,
    RFRL_PHARMACY_ID: CREATE_RX.pharmacy_id,
    RFRL_PRESCRIBER_ID: CREATE_RX.prescriber_id,
  };
  const worker = new Worker(WORKER_SCRIPT, {
    eval: true,
    env: { ...process.env, ...env },
  });
  worker.postMessage({ type: 'sab', sab });

  // Settle-once state: 'error' and 'exit' are observed from worker creation
  // (not when a waiter is registered), so a worker that exits before the
  // main thread awaits it still settles both waiters — no hang.
  let workerError = null;
  let exitCode = null;
  const holdWaiters = [];
  const doneWaiters = [];
  const notify = () => {
    if (workerError) {
      while (holdWaiters.length) holdWaiters.shift()(workerError);
      while (doneWaiters.length) doneWaiters.shift()(workerError);
      return;
    }
    if (exitCode !== null) {
      const err =
        exitCode === 0
          ? null
          : new Error(`worker exited with code ${exitCode}`);
      while (doneWaiters.length) {
        const fn = doneWaiters.shift();
        if (err) fn(err);
        else fn(null);
      }
      if (err) {
        while (holdWaiters.length) holdWaiters.shift()(err);
      }
    }
  };
  worker.on('error', (err) => {
    workerError = workerError ?? err;
    notify();
  });
  worker.on('exit', (code) => {
    exitCode = code;
    notify();
  });
  worker.on('message', (m) => {
    if (m && m.type === 'error') {
      workerError = workerError ?? new Error(`worker error: ${m.message}`);
      notify();
    }
  });

  return {
    // Set by the MAIN thread after all setup writes are committed: releases
    // the worker to commit its winner and take the write lock. The store is
    // paired with Atomics.notify so the worker's wait (even if it enters
    // the wait microseconds after the store) wakes by notification and
    // then rechecks the flag before acting.
    signalMainReady: () => {
      Atomics.store(flag, 0, 1);
      Atomics.notify(flag, 0);
    },
    // Signal the worker and wait for its release acknowledgment inside
    // the fixture's statement observer before the production retry.
    releaseAfterContention: () => {
      Atomics.store(flag, 2, 1);
      Atomics.notify(flag, 2);
      Atomics.wait(flag, 2, 1, 1000);
      assert.equal(Atomics.load(flag, 2), 2, 'worker released SQLite write lock');
    },
    // Resolve once the worker has acknowledged the release (cell 2 === 2:
    // it observed the ask's first write-lock error, rolled back, and the
    // write lock is now free). Reject on worker error, a worker exit before
    // the release, or a 15 s deadline. This is the deterministic point after
    // which the ask's bounded retry is guaranteed to acquire the lock (the
    // worker has released it and the ask holds no connection of its own
    // between the failed probe and the retry, so nothing else competes).
    waitingForRelease: () => new Promise((resolve, reject) => {
      const deadline = Date.now() + 15000;
      const spin = () => {
        if (workerError) return reject(workerError);
        if (exitCode !== null) {
          return reject(
            exitCode === 0
              ? new Error('worker exited before releasing the write lock')
              : new Error(`worker exited with code ${exitCode} before releasing the write lock`)
          );
        }
        if (Atomics.load(flag, 2) === 2) return resolve();
        if (Date.now() > deadline) {
          worker.terminate();
          return reject(new Error('worker did not release the write lock in time'));
        }
        // The worker pairs its release store with Atomics.notify, so this
        // usually wakes by notification; after ANY wake or timeout the flag
        // is RECHECKED before acting, so a near-simultaneous store is never
        // missed and a timeout alone can never resolve or reject.
        Atomics.wait(flag, 2, 0, 25);
        if (Atomics.load(flag, 2) === 2) return resolve();
        spin();
      };
      spin();
    }),
    // Resolve only after the worker has committed the winner AND acquired
    // the write lock (the shared flag barrier); reject on worker error, a
    // worker exit before the barrier, or a 15 s deadline.
    waitingForHold: () => new Promise((resolve, reject) => {
      if (workerError) return reject(workerError);
      if (exitCode !== null) {
        return reject(
          exitCode === 0
            ? new Error('worker exited before holding the write lock')
            : new Error(`worker exited with code ${exitCode}`)
        );
      }
      const deadline = Date.now() + 15000;
      const spin = () => {
        if (workerError) return reject(workerError);
        if (exitCode !== null) {
          return reject(
            new Error(`worker exited with code ${exitCode} before holding the write lock`)
          );
        }
        if (Atomics.load(flag, 1) === 1) return resolve();
        if (Date.now() > deadline) {
          worker.terminate();
          return reject(new Error('worker did not reach the write-lock hold in time'));
        }
        // The worker pairs its store with Atomics.notify, so this usually
        // wakes by notification; after ANY wake or timeout the flag is
        // RECHECKED before acting, so a near-simultaneous store is never
        // missed and a timeout alone can never resolve or reject.
        Atomics.wait(flag, 1, 0, 25);
        if (Atomics.load(flag, 1) === 1) return resolve();
        spin();
      };
      spin();
    }),
    // Resolve when the worker exits 0 (release + close done); reject on a
    // non-zero exit or worker error.
    done: () => new Promise((resolve, reject) => {
      if (workerError) return reject(workerError);
      if (exitCode !== null) {
        if (exitCode === 0) return resolve();
        return reject(new Error(`worker exited with code ${exitCode}`));
      }
      doneWaiters.push((err) => (err ? reject(err) : resolve()));
      notify();
    }),
    terminate: () => worker.terminate(),
  };
}


test('ask authorization and eligibility: role, ownership, assignment, zero-refill; opaque denial; zero writes on every denial', () => {
  const { dir, dbPath } = freshDb('authorization');
  try {
    seedCreateTarget(dbPath);

    const cleo = identityFor(dbPath, 'cleo.voss', 'patient-cleo-2026');
    const boris = identityFor(dbPath, 'boris.laine', 'patient-boris-2026');
    const drHart = identityFor(dbPath, 'dr.emil.hart', 'prescriber-emil-2026');
    const pharmacy = identityFor(dbPath, 'pharmacy.dunmore', 'pharmacy-dunmore-2026');
    assert.equal(cleo.role, 'patient');
    assert.equal(drHart.role, 'prescriber');
    assert.equal(pharmacy.role, 'pharmacy');

    const before = fullTableState(dbPath);
    const sessionsBefore = before.sessions.length;

    const outcomes = [];

    // Non-patient roles are denied before any prescription is considered.
    outcomes.push(['prescriber role', askPatientForRenewal(dbPath, drHart, CREATE_RX.id)]);
    outcomes.push(['pharmacy role', askPatientForRenewal(dbPath, pharmacy, CREATE_RX.id)]);
    outcomes.push(['unknown role', askPatientForRenewal(dbPath, { id: 'ending-a-patient', role: 'clinic' }, CREATE_RX.id)]);
    outcomes.push(['missing id', askPatientForRenewal(dbPath, { id: '', role: 'patient' }, CREATE_RX.id)]);
    outcomes.push(['null identity', askPatientForRenewal(dbPath, null, CREATE_RX.id)]);

    for (const [label, res] of outcomes) {
      assert.equal(res.ok, false, `${label}: denial`);
      assert.equal(res.code, 'not-authorized', `${label}: fixed code`);
      assertNoCaseData(res, label);
    }

    // Another patient's prescription denies with the SAME opaque
    // 'unknown-prescription' result as a nonexistent id: no existence or
    // ownership disclosure (Boris is not the owner of Cleo's new rx).
    const otherPatient = askPatientForRenewal(dbPath, boris, CREATE_RX.id);
    const unknown = askPatientForRenewal(dbPath, boris, 'no-such-rx');
    outcomes.push([
      'other patient vs unknown id (must be byte-identical)',
      [otherPatient, unknown],
    ]);
    assert.equal(otherPatient.ok, false, 'other patient: denial');
    assert.equal(otherPatient.code, 'unknown-prescription', 'other patient: opaque code');
    assertNoCaseData(otherPatient, 'other patient');
    assert.deepEqual(otherPatient, unknown, 'unknown and another-patient denials are byte-identical');

    // Own prescription with refills remaining and NO renewal is
    // ineligible (fixed result, no refill count disclosed). denial-rx
    // belongs to Cleo with refills_remaining = 1 and no renewal.
    const ineligible = askPatientForRenewal(dbPath, cleo, 'denial-rx');
    assert.equal(ineligible.ok, false, 'ineligible: denial');
    assert.equal(ineligible.code, 'ineligible-prescription', 'ineligible: fixed code');
    assertNoCaseData(ineligible, 'ineligible');

    // No rows written on any denial: full durable state (every table, on a
    // fresh connection) is byte-identical; sessions count unchanged.
    const after = fullTableState(dbPath);
    assertStateUnchanged(after, before, 'denials');
    assert.equal(after.sessions.length, sessionsBefore, 'sessions count unchanged');
    assert.equal(after.renewals.length, before.renewals.length, 'no renewal rows from denials');
    assert.equal(after.renewal_events.length, before.renewal_events.length, 'no events from denials');

    // The eligible target is untouched and still creatable: the owner's
    // first ask on it succeeds (this also guards that the denials above did
    // not consume the pending slot or the zero-refill state).
    const created = askPatientForRenewal(dbPath, cleo, CREATE_RX.id);
    assert.equal(created.ok, true, 'eligible target still creatable after denials');
    assert.equal(created.code, 'created');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('first ask creates exactly one pending renewal and one submitted event; repeat returns the existing record and adds nothing', () => {
  const { dir, dbPath } = freshDb('create-repeat');
  try {
    seedCreateTarget(dbPath);
    const cleo = identityFor(dbPath, 'cleo.voss', 'patient-cleo-2026');
    const before = fullTableState(dbPath);
    assert.equal(before.renewals.length, 2, 'the two fixture renewals are the only renewals before the ask');

    // First ask: creates exactly one 'Sent to pharmacy' renewal with the
    // pharmacy as next actor and an ISO submitted_at, plus exactly one
    // 'submitted' event by the asking patient — atomically.
    const first = askPatientForRenewal(dbPath, cleo, CREATE_RX.id);
    assert.equal(first.ok, true);
    assert.equal(first.code, 'created');
    assert.equal(first.created, true);
    const createdId = first.renewal.id;
    assert.match(createdId, /^[0-9a-f]{32}$/, 'new renewal id is 32-hex');
    assert.equal(first.renewal.prescription_id, CREATE_RX.id);
    assert.equal(first.renewal.patient_id, 'denial-patient');
    assert.equal(first.renewal.pharmacy_id, 'pharmacy-dunmore');
    assert.equal(first.renewal.prescriber_id, 'denial-prescriber');
    assert.equal(first.renewal.status, STATUS_LABELS.SENT_TO_PHARMACY);
    assert.equal(first.renewal.next_actor, 'pharmacy');
    assert.ok(!Number.isNaN(Date.parse(first.renewal.submitted_at)), 'submitted_at is ISO');
    assert.equal(first.renewal.handoff_at, null);
    assert.equal(first.renewal.decided_at, null);
    assert.equal(first.renewal.granted_refills, null);
    assert.equal(first.renewal.request_idempotency_key, null, 'natural-key idempotency: no client key column used');
    assert.equal(first.renewal.version, 1);

    // Durability re-read on a fresh connection (the ask's own connection is
    // closed): exactly one new renewal row and exactly one new event row.
    const check = initDatabase(dbPath);
    try {
      const renewals = check
        .prepare(`SELECT * FROM renewals WHERE prescription_id = ?`)
        .all(CREATE_RX.id);
      assert.equal(renewals.length, 1, 'exactly one renewal row for the prescription');
      const row = renewals[0];
      assert.equal(row.id, createdId);
      assert.equal(row.status, STATUS_LABELS.SENT_TO_PHARMACY);
      assert.equal(row.next_actor, 'pharmacy');
      assert.equal(row.patient_id, 'denial-patient');
      assert.equal(row.pharmacy_id, 'pharmacy-dunmore');
      assert.equal(row.prescriber_id, 'denial-prescriber');
      assert.equal(row.request_idempotency_key, null);
      assert.equal(row.version, 1);

      const events = check
        .prepare(`SELECT * FROM renewal_events WHERE renewal_id = ? ORDER BY id`)
        .all(createdId);
      assert.equal(events.length, 1, 'exactly one renewal event for the renewal');
      assert.equal(events[0].event_type, 'submitted');
      assert.equal(events[0].event_type, EVENT_TYPES.SUBMITTED);
      assert.equal(events[0].actor_role, 'patient');
      assert.equal(events[0].actor_id, 'denial-patient');
      assert.equal(events[0].occurred_at, first.renewal.submitted_at, 'event time is the submission time');

      // Exactly one NEW row in each table overall.
      assert.equal(
        check.prepare(`SELECT COUNT(*) AS n FROM renewals`).get().n,
        before.renewals.length + 1,
        'renewals table grew by exactly one row'
      );
      assert.equal(
        check.prepare(`SELECT COUNT(*) AS n FROM renewal_events`).get().n,
        before.renewal_events.length + 1,
        'renewal_events table grew by exactly one row'
      );
    } finally {
      check.close();
    }

    // Repeat (second tab / refresh / stale form submit at the store
    // layer): returns the EXISTING record — same id, same original
    // submitted_at — created:false, code already-pending; no new rows.
    const repeat = askPatientForRenewal(dbPath, cleo, CREATE_RX.id);
    assert.equal(repeat.ok, true);
    assert.equal(repeat.code, 'already-pending');
    assert.equal(repeat.created, false);
    assert.equal(repeat.renewal.id, createdId, 'repeat returns the existing renewal id');
    assert.equal(repeat.renewal.submitted_at, first.renewal.submitted_at, 'original submitted_at preserved');
    assert.equal(repeat.renewal.status, STATUS_LABELS.SENT_TO_PHARMACY);
    assert.equal(repeat.renewal.next_actor, 'pharmacy');

    const afterRepeat = fullTableState(dbPath);
    const afterFirst = fullTableState(dbPath);
    assert.equal(afterRepeat.renewals.length, afterFirst.renewals.length, 'no new renewal row on repeat');
    assert.equal(afterRepeat.renewal_events.length, afterFirst.renewal_events.length, 'no new event on repeat');
    // The repeat's full state equals the post-create state except nothing
    // was added: compare the created row's fields directly.
    const finalCheck = initDatabase(dbPath);
    try {
      assert.equal(
        finalCheck.prepare(`SELECT COUNT(*) AS n FROM renewals WHERE prescription_id = ?`).get(CREATE_RX.id).n,
        1,
        'still exactly one renewal row after the repeat'
      );
      assert.equal(
        finalCheck.prepare(`SELECT COUNT(*) AS n FROM renewal_events WHERE event_type = ?`).get('submitted').n,
        1,
        'still exactly one submitted event after the repeat'
      );
      const row = finalCheck.prepare(`SELECT * FROM renewals WHERE id = ?`).get(createdId);
      assert.equal(row.submitted_at, first.renewal.submitted_at, 'durable submitted_at unchanged by the repeat');
    } finally {
      finalCheck.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('under-lock re-read: a winner committed before the ask is returned idempotently (created:false) with no new rows', () => {
  const { dir, dbPath } = freshDb('re-read');
  try {
    seedCreateTarget(dbPath);
    const cleo = identityFor(dbPath, 'cleo.voss', 'patient-cleo-2026');

    // Commit the winner renewal + one 'submitted' event directly (as a
    // concurrent winner would have), then close the connection.
    const at = new Date().toISOString();
    const winnerId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const write = initDatabase(dbPath);
    try {
      write.exec('BEGIN IMMEDIATE');
      write.prepare(
        `INSERT INTO renewals
           (id, prescription_id, patient_id, pharmacy_id, prescriber_id,
            status, next_actor, submitted_at, handoff_at, decided_at,
            granted_refills, request_idempotency_key, version)
         VALUES (?, ?, ?, ?, ?, ?, 'pharmacy', ?, NULL, NULL, NULL, NULL, 1)`
      ).run(
        winnerId,
        CREATE_RX.id,
        CREATE_RX.patient_id,
        CREATE_RX.pharmacy_id,
        CREATE_RX.prescriber_id,
        STATUS_LABELS.SENT_TO_PHARMACY,
        at
      );
      write.prepare(
        `INSERT INTO renewal_events (renewal_id, event_type, actor_role, actor_id, occurred_at, payload)
         VALUES (?, ?, 'patient', ?, ?, ?)`
      ).run(winnerId, EVENT_TYPES.SUBMITTED, CREATE_RX.patient_id, at, '{"synthetic":true}');
      write.exec('COMMIT');
    } finally {
      write.close();
    }

    // The ask's under-lock re-read (after BEGIN IMMEDIATE) must find the
    // winner and return it without writing anything.
    const res = askPatientForRenewal(dbPath, cleo, CREATE_RX.id);
    assert.equal(res.ok, true);
    assert.equal(res.code, 'already-pending');
    assert.equal(res.created, false);
    assert.equal(res.renewal.id, winnerId, 're-read returns the winner id');
    assert.equal(res.renewal.submitted_at, at, 'winner submission time preserved');

    const check = initDatabase(dbPath);
    try {
      assert.equal(
        check.prepare(`SELECT COUNT(*) AS n FROM renewals WHERE prescription_id = ?`).get(CREATE_RX.id).n,
        1,
        'still exactly one renewal row'
      );
      assert.equal(
        check.prepare(`SELECT COUNT(*) AS n FROM renewal_events WHERE renewal_id = ?`).get(winnerId).n,
        1,
        'still exactly one event row'
      );
    } finally {
      check.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('write-lock contention on a worker thread: bounded retry acquires the lock, re-read converges on the winner, no duplicate rows', async () => {
  const { dir, dbPath } = freshDb('locked-writer');
  const holder = startWorkerHolder(dbPath, {
    winnerId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  try {
    seedCreateTarget(dbPath);
    const cleo = identityFor(dbPath, 'cleo.voss', 'patient-cleo-2026');

    // All of the main thread's setup writes are now committed; release the
    // worker to commit the winner and take the write lock.
    holder.signalMainReady();
    await holder.waitingForHold();

    const prepare = DatabaseSync.prototype.prepare;
    let sawContention = false;
    let res;
    DatabaseSync.prototype.prepare = function (sql) {
      const statement = prepare.call(this, sql);
      if (sql === 'BEGIN IMMEDIATE') {
        const run = statement.run;
        statement.run = function (...args) {
          try {
            return run.apply(this, args);
          } catch (error) {
            if (!sawContention && /database is locked|SQLITE_BUSY/i.test(error.message)) {
              sawContention = true;
              holder.releaseAfterContention();
            }
            throw error;
          }
        };
      }
      return statement;
    };
    try {
      res = askPatientForRenewal(dbPath, cleo, CREATE_RX.id);
    } finally {
      DatabaseSync.prototype.prepare = prepare;
    }
    assert.equal(sawContention, true, 'the first write attempt observed a real SQLite lock error');

    assert.equal(res.ok, true, 'contention did not fail the ask');
    assert.equal(res.code, 'already-pending', 'the retry-then-re-read converges on the winner');
    assert.equal(res.created, false);
    assert.equal(res.renewal.id, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'returned the worker-committed winner id');
    assert.ok(
      Number(res.lockRetries) > 0,
      `the bounded retry must have fired under contention (lockRetries=${res.lockRetries})`
    );

    // Deterministic release check: the worker acknowledged that it observed
    // the ask's first write-lock error, rolled back its (empty) transaction,
    // and freed the write lock — so the retry's acquisition was a response
    // to the worker's release, not a lucky timing gap. (The ask already
    // returned after acquiring the lock; this only confirms the ordering.)
    await holder.waitingForRelease();

    // The worker finished its release and exited cleanly.
    await holder.done();

    // Outcome invariant: exactly one renewal and one 'submitted' event for
    // the prescription, despite the concurrent holder.
    const check = initDatabase(dbPath);
    try {
      assert.equal(
        check.prepare(`SELECT COUNT(*) AS n FROM renewals WHERE prescription_id = ?`).get(CREATE_RX.id).n,
        1,
        'exactly one renewal row despite the contention'
      );
      assert.equal(
        check.prepare(`SELECT COUNT(*) AS n FROM renewal_events WHERE event_type = ?`).get('submitted').n,
        1,
        'exactly one submitted event despite the contention'
      );
      assert.equal(
        check.prepare(`SELECT id FROM renewals WHERE prescription_id = ?`).get(CREATE_RX.id).id,
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'the sole renewal row is the winner'
      );
    } finally {
      check.close();
    }
  } finally {
    holder.terminate();
    rmSync(dir, { recursive: true, force: true });
  }
});


test('failed ask commit: real INSERTs then rollback leaves zero new rows, prior state byte-identical on fresh re-read, next ask succeeds', () => {
  const { dir, dbPath } = freshDb('rollback');
  try {
    seedCreateTarget(dbPath);
    const cleo = identityFor(dbPath, 'cleo.voss', 'patient-cleo-2026');

    // Previous saved state: a committed session for another identity and
    // the fixture rows.
    const other = signIn(dbPath, 'pharmacy.cedar', 'pharmacy-cedar-2026');
    assert.equal(other.status, 200, 'previous committed session exists');

    const before = fullTableState(dbPath);
    assert.equal(before.sessions.length, 2, 'two committed sessions in the before-state (cleo + pharmacy)');
    assert.equal(before.renewals.length, 2, 'the two fixture renewals are the only renewals before the failed ask');

    // Inject the failure AFTER the renewal+event INSERTs and BEFORE the
    // COMMIT: the real INSERTs run, then the transaction rolls back.
    const failed = askPatientForRenewal(dbPath, cleo, CREATE_RX.id, { failAskCommit: true });
    assert.equal(failed.ok, false, 'save failure is reported');
    assert.equal(failed.code, 'ask-save-failed');
    assert.equal(failed.recoverable, true, 'the result is explicitly recoverable');
    assert.equal(failed.created, undefined, 'no record was created');
    assert.equal(failed.renewal, undefined, 'no record value is returned on failure');
    assertNoCaseData(failed, 'failed ask');

    // Reread on a fresh connection: the attempted renewal row and the
    // attempted event row are absent — the rollback removed both; every
    // table is byte-identical to the before-state.
    const after = fullTableState(dbPath);
    assertStateUnchanged(after, before, 'failed ask rollback');
    const fresh = initDatabase(dbPath);
    try {
      assert.equal(
        fresh.prepare(`SELECT COUNT(*) AS n FROM renewals WHERE prescription_id = ?`).get(CREATE_RX.id).n,
        0,
        'no partial renewal row from the failed commit'
      );
      assert.equal(
        fresh.prepare(`SELECT COUNT(*) AS n FROM renewal_events WHERE event_type = ?`).get('submitted').n,
        0,
        'no partial submitted event from the failed commit'
      );
      assert.equal(
        fresh.prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n,
        before.sessions.length,
        'sessions count unchanged after the failed ask'
      );
    } finally {
      fresh.close();
    }

    // Recovery: the next ask (no fault injected) succeeds and creates
    // exactly one renewal and one event.
    const retry = askPatientForRenewal(dbPath, cleo, CREATE_RX.id);
    assert.equal(retry.ok, true, 'recovery: the next ask succeeds');
    assert.equal(retry.code, 'created');
    assert.equal(retry.created, true);
    const check = initDatabase(dbPath);
    try {
      assert.equal(
        check.prepare(`SELECT COUNT(*) AS n FROM renewals WHERE prescription_id = ?`).get(CREATE_RX.id).n,
        1,
        'recovery: exactly one renewal row after the successful retry'
      );
      assert.equal(
        check.prepare(`SELECT COUNT(*) AS n FROM renewal_events WHERE renewal_id = ?`).get(retry.renewal.id).n,
        1,
        'recovery: exactly one event row after the successful retry'
      );
    } finally {
      check.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('every denial path leaves the full durable state unchanged (all tables, fresh connection; sessions count unchanged)', () => {
  const { dir, dbPath } = freshDb('denials');
  try {
    seedCreateTarget(dbPath);
    const cleo = identityFor(dbPath, 'cleo.voss', 'patient-cleo-2026');
    const boris = identityFor(dbPath, 'boris.laine', 'patient-boris-2026');
    const drHart = identityFor(dbPath, 'dr.emil.hart', 'prescriber-emil-2026');
    const pharmacy = identityFor(dbPath, 'pharmacy.dunmore', 'pharmacy-dunmore-2026');

    const cases = [
      ['prescriber role on own rx', () => askPatientForRenewal(dbPath, drHart, CREATE_RX.id)],
      ['pharmacy role on own rx', () => askPatientForRenewal(dbPath, pharmacy, CREATE_RX.id)],
      ['unknown role', () => askPatientForRenewal(dbPath, { id: 'denial-patient', role: 'admin' }, CREATE_RX.id)],
      ['another patient on the target rx', () => askPatientForRenewal(dbPath, boris, CREATE_RX.id)],
      ['unknown prescription id', () => askPatientForRenewal(dbPath, cleo, 'no-such-rx')],
      ['ineligible own rx (refills remaining, no renewal)', () => askPatientForRenewal(dbPath, cleo, 'denial-rx')],
    ];

    for (const [label, invoke] of cases) {
      const before = fullTableState(dbPath);
      const res = invoke();
      assert.equal(res.ok, false, `${label}: denial`);
      assertNoCaseData(res, label);
      const after = fullTableState(dbPath);
      assertStateUnchanged(after, before, label);
      assert.equal(
        after.sessions.length,
        before.sessions.length,
        `${label}: sessions count unchanged`
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('terminal no-re-ask: a repeat ask after a terminal decision returns the existing disposition and creates no renewal and no event', () => {
  const { dir, dbPath } = freshDb('terminal');
  try {
    const ava = identityFor(dbPath, 'ava.mercer', 'patient-ava-2026');
    const cleo = identityFor(dbPath, 'cleo.voss', 'patient-cleo-2026');

    // ending-a-rx: terminal 'Renewal approved' (ending-a-renewal),
    // refills_remaining = 1 — the fixture's saved terminal disposition.
    const before = fullTableState(dbPath);
    const submittedEventsBefore = before.renewal_events
      .filter((r) => r[2] === 'submitted').length;

    const res = askPatientForRenewal(dbPath, ava, 'ending-a-rx');
    assert.equal(res.ok, true, 'a terminal repeat ask still succeeds (ok:true)');
    assert.equal(res.code, 'already-final', 'the outcome is the existing terminal disposition');
    assert.equal(res.created, false, 'nothing was created');
    assert.equal(res.renewal.id, 'ending-a-renewal', 'returns the existing terminal record');
    assert.equal(res.renewal.status, STATUS_LABELS.RENEWAL_APPROVED);
    assert.equal(res.renewal.decided_at, '2026-11-21T09:00:00Z', 'original decided_at preserved');
    assert.equal(res.renewal.granted_refills, 1, 'original granted refills preserved');
    assert.equal(res.renewal.next_actor, 'pharmacy');
    assert.equal(res.renewal.submitted_at, '2026-11-21T08:00:00Z', 'original submission time preserved');

    // No new renewal row and no new event for the prescription; the
    // terminal record is untouched; full durable state unchanged.
    const after = fullTableState(dbPath);
    assert.equal(
      after.renewals.filter((r) => r[1] === 'ending-a-rx').length,
      1,
      'exactly one renewal row for the terminal prescription remains'
    );
    assert.equal(after.renewal_events.length, before.renewal_events.length, 'no new event rows at all');
    assert.equal(
      after.renewal_events.filter((r) => r[2] === 'submitted').length,
      submittedEventsBefore,
      'no new submitted events'
    );
    const terminal = after.renewals.find((r) => r[0] === 'ending-a-renewal');
    assert.deepEqual(
      terminal,
      before.renewals.find((r) => r[0] === 'ending-a-renewal'),
      'the terminal renewal row is byte-identical'
    );
    // The only table that may have moved is sessions (the sign-in above);
    // every table except sessions must be byte-identical.
    for (const table of Object.keys(before)) {
      if (table === 'sessions') continue;
      assert.deepEqual(after[table], before[table], `table ${table} unchanged by the terminal repeat ask`);
    }

    // A second terminal repeat also creates nothing (repeat stability).
    const repeat = askPatientForRenewal(dbPath, ava, 'ending-a-rx');
    assert.equal(repeat.code, 'already-final');
    assert.equal(repeat.renewal.id, 'ending-a-renewal');
    const afterRepeat = fullTableState(dbPath);
    assert.equal(afterRepeat.renewals.length, after.renewals.length, 'no growth on the second terminal repeat');
    assert.equal(afterRepeat.renewal_events.length, after.renewal_events.length, 'no events on the second terminal repeat');

    // The ineligible fixture (no renewal, refills remaining) is a denial
    // for its owner: denial-rx belongs to Cleo with refills_remaining = 1.
    const ineligible = askPatientForRenewal(dbPath, cleo, 'denial-rx');
    assert.equal(ineligible.ok, false);
    assert.equal(ineligible.code, 'ineligible-prescription');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('contract guards: schema unchanged and idempotent, no CHECK on event_type, caseRefFor byte-identical to the server formula, partial unique index intact', () => {
  const { dir, dbPath } = freshDb('constraints');
  try {
    const db = initDatabase(dbPath);
    try {
      initSchema(db);
      const tableNames = new Set(
        db.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table'`).all()
          .map((r) => r.name)
          .filter((name) => !name.startsWith('sqlite_'))
      );
      for (const table of [
        'markers', 'identities', 'prescriptions', 'renewals', 'renewal_events',
        'pharmacy_conversation_messages', 'office_messages', 'phone_notes',
        'sessions', 'synthetic_accounts',
      ]) {
        assert.ok(tableNames.has(table), `table ${table} still exists`);
      }
      // No new tables were introduced.
      assert.equal(tableNames.size, 10, 'exactly the ten accepted tables exist');

      // The canonical invariant indexes are still present.
      const indexNames = new Set(
        db.prepare(`SELECT name FROM sqlite_schema WHERE type = 'index'`).all().map((r) => r.name)
      );
      for (const index of ['refill_pending_per_prescription', 'renewal_events_one_handoff', 'renewal_events_one_final_decision']) {
        assert.ok(indexNames.has(index), `index ${index} still exists`);
      }

      // renewal_events has NO CHECK constraint on event_type: the additive
      // 'submitted' label is safe alongside the invariant-carrying labels.
      const eventsSql = db.prepare(`SELECT sql FROM sqlite_schema WHERE name = 'renewal_events'`).get().sql;
      assert.ok(!/CHECK/i.test(eventsSql), 'renewal_events schema has no CHECK constraint');
      assert.ok(!eventsSql.includes('CHECK (event_type'), 'no event_type enum check');

      // The pending partial unique index still guards the slot: a second
      // non-final renewal for the same prescription is rejected by the DB.
      db.prepare(
        `INSERT INTO prescriptions (id, patient_id, pharmacy_id, prescriber_id, refills_remaining, is_synthetic)
         VALUES ('constraint-rx', 'denial-patient', 'pharmacy-dunmore', 'denial-prescriber', 0, 1)`
      ).run();
      let threwUnique = false;
      try {
        db.exec('BEGIN IMMEDIATE');
        db.prepare(
          `INSERT INTO renewals (id, prescription_id, patient_id, pharmacy_id, prescriber_id, status, next_actor, submitted_at, version)
           VALUES ('constraint-rn-1', 'constraint-rx', 'denial-patient', 'pharmacy-dunmore', 'denial-prescriber', ?, 'pharmacy', '2026-11-22T00:00:00Z', 1)`
        ).run(STATUS_LABELS.SENT_TO_PHARMACY);
        db.prepare(
          `INSERT INTO renewals (id, prescription_id, patient_id, pharmacy_id, prescriber_id, status, next_actor, submitted_at, version)
           VALUES ('constraint-rn-2', 'constraint-rx', 'denial-patient', 'pharmacy-dunmore', 'denial-prescriber', ?, 'pharmacy', '2026-11-22T00:00:01Z', 1)`
        ).run(STATUS_LABELS.SENT_TO_PHARMACY);
        db.exec('ROLLBACK');
      } catch (err) {
        threwUnique = true;
        expectUniqueConstraintError(err);
        try {
          db.exec('ROLLBACK');
        } catch {
          // The transaction already ended; the original error is authoritative.
        }
      }
      assert.ok(threwUnique, 'second non-final renewal rejected by the partial unique index');
      assert.equal(
        db.prepare(`SELECT COUNT(*) AS n FROM renewals WHERE prescription_id = 'constraint-rx'`).get().n,
        0,
        'the rolled-back guard inserts left no rows'
      );

      // The new 'submitted' event label coexists with the handoff/decision
      // unique indexes (a submitted event is not a handoff or a decision).
      db.prepare(
        `INSERT INTO renewals (id, prescription_id, patient_id, pharmacy_id, prescriber_id, status, next_actor, submitted_at, version)
         VALUES ('constraint-rn-3', 'constraint-rx', 'denial-patient', 'pharmacy-dunmore', 'denial-prescriber', ?, 'pharmacy', '2026-11-22T00:00:02Z', 1)`
      ).run(STATUS_LABELS.SENT_TO_PHARMACY);
      db.prepare(
        `INSERT INTO renewal_events (renewal_id, event_type, actor_role, actor_id, occurred_at, payload)
         VALUES ('constraint-rn-3', ?, 'patient', 'denial-patient', '2026-11-22T00:00:02Z', '{"synthetic":true}')`
      ).run(EVENT_TYPES.SUBMITTED);
      assert.equal(
        db.prepare(`SELECT COUNT(*) AS n FROM renewal_events WHERE renewal_id = 'constraint-rn-3'`).get().n,
        1,
        'a submitted event commits without tripping the invariant indexes'
      );
    } finally {
      db.close();
    }

    assert.equal(
      caseRefFor('ending-a-renewal'),
      'f40979e9fbffaafb02072fba5e46e6a3',
      'caseRefFor matches the server formula for the Ending A record'
    );
    assert.equal(
      caseRefFor('ending-b-renewal'),
      '77d74295c5e1ab5d5282a6868224dd5b',
      'caseRefFor matches the server formula for the Ending B record'
    );
    const freshId = 'c'.repeat(32);
    assert.equal(
      caseRefFor(freshId),
      createHash('sha256').update(`rfrl-case-ref-v1:${freshId}`).digest('hex').slice(0, 32),
      'caseRefFor matches the server formula for an arbitrary id'
    );
    assert.match(caseRefFor(freshId), /^[0-9a-f]{32}$/, 'caseRefFor output is 32-hex');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
