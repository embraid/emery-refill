import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  STATUS_LABELS,
  EVENT_TYPES,
  initDatabase,
  seedSyntheticFixtures,
  seedSyntheticAccounts,
  signIn,
  caseRefFor,
  handoffRenewalToPrescriber,
} from '../store.mjs';

// --- helpers ---------------------------------------------------------------

// One fresh disposable database per test (estate convention): unique temp
// dir, schema, fixture set, and local synthetic accounts.
function freshDb(label) {
  const dir = mkdtempSync(join(tmpdir(), `refill-relay-handoff-${label}-`));
  const dbPath = join(dir, `handoff-${label}.sqlite`);
  initDatabase(dbPath);
  seedSyntheticFixtures(dbPath);
  seedSyntheticAccounts(dbPath);
  return { dir, dbPath };
}

// The accepted synthetic rehearsal case (plan §4.2, fixture reuse):
// ending-b-renewal — 'Sent to pharmacy', assigned to pharmacy-cedar
// (the responsible pharmacy user) and ending-b-prescriber, with
// ending-b-rx at ZERO refills.
const HANDOFF_CASE = Object.freeze({
  id: 'ending-b-renewal',
  prescription_id: 'ending-b-rx',
  patient_id: 'ending-b-patient',
  pharmacy_id: 'pharmacy-cedar',
  prescriber_id: 'ending-b-prescriber',
});

const cedarIdentity = { id: 'pharmacy-cedar', role: 'pharmacy' };

function handoff(dbPath, identity = cedarIdentity, renewalId = HANDOFF_CASE.id, options) {
  return handoffRenewalToPrescriber(dbPath, identity, renewalId, options);
}

// Scalar-only snapshot of every data table (normalized to arrays of scalar
// values, never raw SQLite rows) for before/after durable-state equality
// (estate fullTableState convention).
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
// case-data disclosure (estate CASE_DATA_TOKENS convention).
const CASE_DATA_TOKENS = [
  'ending-a-renewal', 'ending-b-renewal',
  'ending-a-rx', 'ending-b-rx', 'denial-rx',
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

// The durable renewal row for the rehearsal case (fresh connection).
function savedCase(dbPath) {
  const db = initDatabase(dbPath);
  try {
    return db.prepare(`SELECT * FROM renewals WHERE id = ?`).get(HANDOFF_CASE.id);
  } finally {
    db.close();
  }
}

// The durable handoff events for the rehearsal case (fresh connection).
function handoffEvents(dbPath) {
  const db = initDatabase(dbPath);
  try {
    return db
      .prepare(
        `SELECT * FROM renewal_events
          WHERE renewal_id = ? AND event_type = ?`
      )
      .all(HANDOFF_CASE.id, EVENT_TYPES.HANDOFF);
  } finally {
    db.close();
  }
}

// The pre-handoff fixture facts (RFRLM-FR-001), re-verified from the
// durable store on every fresh DB.
function assertSyntheticPreState(dbPath, label) {
  const row = savedCase(dbPath);
  assert.equal(row.id, HANDOFF_CASE.id, `${label}: the rehearsal case exists`);
  assert.equal(row.status, STATUS_LABELS.SENT_TO_PHARMACY, `${label}: case is Sent to pharmacy`);
  assert.equal(row.next_actor, 'pharmacy', `${label}: next actor is the responsible pharmacy`);
  assert.equal(row.pharmacy_id, 'pharmacy-cedar', `${label}: assigned to the responsible pharmacy user`);
  assert.equal(row.prescriber_id, 'ending-b-prescriber', `${label}: an assigned prescriber is present`);
  assert.equal(row.handoff_at, null, `${label}: no handoff time before the handoff`);
  assert.equal(row.version, 1, `${label}: untouched fixture version`);
  const rx = (() => {
    const db = initDatabase(dbPath);
    try {
      return db.prepare(`SELECT * FROM prescriptions WHERE id = ?`).get('ending-b-rx');
    } finally {
      db.close();
    }
  })();
  assert.equal(rx.patient_id, 'ending-b-patient', `${label}: the relevant patient`);
  assert.equal(rx.refills_remaining, 0, `${label}: the zero-refill condition`);
}


test('first handoff: the same renewal moves to Awaiting prescriber with the prescriber as next actor, the first valid handoff time, version +1, exactly one handoff event, and nothing else written', () => {
  const { dir, dbPath } = freshDb('first');
  try {
    assertSyntheticPreState(dbPath, 'pre');
    const before = fullTableState(dbPath);

    const t0 = Date.now();
    const res = handoff(dbPath);
    const t1 = Date.now();
    // NFR-001/KPI-005 measurement (recorded, no threshold asserted): the
    // store-level elapsed time of the handoff operation.
    console.log(`[measure] first handoff store elapsed: ${t1 - t0} ms`);

    assert.equal(res.ok, true, 'first handoff succeeds');
    assert.equal(res.code, 'handed-off', 'outcome code is handed-off');
    assert.equal(res.created, true, 'the transition was created by this call');
    assert.equal(res.renewal.id, HANDOFF_CASE.id, 'the SAME renewal is returned');
    assert.equal(res.renewal.status, STATUS_LABELS.AWAITING_PRESCRIBER);
    assert.equal(res.renewal.next_actor, 'prescriber', 'the assigned prescriber is the next actor');
    assert.ok(res.renewal.handoff_at, 'the handoff time is recorded');
    assert.ok(
      Date.parse(res.renewal.handoff_at) >= t0 && Date.parse(res.renewal.handoff_at) <= t1,
      'the handoff time is the operation-time timestamp (the first valid one)'
    );
    assert.equal(res.renewal.version, 2, 'version incremented exactly once');
    assert.equal(res.renewal.submitted_at, '2026-11-21T10:00:00Z', 'original submission time preserved');
    assert.equal(res.renewal.prescriber_id, 'ending-b-prescriber', 'prescriber assignment unchanged');

    // Durable state (fresh connection): the same row, one transition.
    const row = savedCase(dbPath);
    assert.equal(row.id, HANDOFF_CASE.id, 'no new case: the same row was updated');
    assert.equal(row.status, STATUS_LABELS.AWAITING_PRESCRIBER, 'durable status');
    assert.equal(row.next_actor, 'prescriber', 'durable next actor');
    assert.equal(row.handoff_at, res.renewal.handoff_at, 'durable handoff time matches the result');
    assert.equal(row.version, 2, 'durable version incremented exactly once');
    assert.equal(row.decided_at, null, 'no decision fields written');
    assert.equal(row.granted_refills, null, 'no decision fields written (refills)');

    // Exactly ONE handoff event, recording the handoff time, acted by the
    // responsible pharmacy, with the minimal synthetic payload.
    const events = handoffEvents(dbPath);
    assert.equal(events.length, 1, 'exactly one handoff event');
    assert.equal(events[0].event_type, EVENT_TYPES.HANDOFF);
    assert.equal(events[0].actor_role, 'pharmacy');
    assert.equal(events[0].actor_id, 'pharmacy-cedar', 'the acting pharmacy identity');
    assert.equal(events[0].occurred_at, row.handoff_at, 'the event records the handoff time');
    const payload = JSON.parse(events[0].payload);
    assert.deepEqual(payload, { synthetic: true, renewal_id: HANDOFF_CASE.id }, 'minimal synthetic payload');

    // The zero-refill condition and every other table are unchanged.
    const rx = (() => {
      const db = initDatabase(dbPath);
      try {
        return db.prepare(`SELECT refills_remaining FROM prescriptions WHERE id = 'ending-b-rx'`).get();
      } finally {
        db.close();
      }
    })();
    assert.equal(rx.refills_remaining, 0, 'refill count unchanged by the handoff');
    const after = fullTableState(dbPath);
    assert.equal(after.renewals.length, before.renewals.length, 'no new renewal rows');
    assert.equal(after.renewal_events.length, before.renewal_events.length + 1, 'events grew by exactly one (the handoff)');
    for (const table of Object.keys(before)) {
      if (table === 'renewals' || table === 'renewal_events') continue;
      assert.deepEqual(after[table], before[table], `table ${table} unchanged by the handoff`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('retry after success: idempotent replay — the case stays Awaiting prescriber with one transition, one event, and the ORIGINAL first valid handoff timestamp', () => {
  const { dir, dbPath } = freshDb('retry');
  try {
    assertSyntheticPreState(dbPath, 'pre');
    const first = handoff(dbPath);
    assert.equal(first.code, 'handed-off');
    const firstTimestamp = first.renewal.handoff_at;

    const retry = handoff(dbPath);
    assert.equal(retry.ok, true, 'the retry succeeds (idempotent)');
    assert.equal(retry.code, 'already-handed-off', 'the outcome is the replay indicator');
    assert.equal(retry.created, false, 'nothing was created by the retry');
    assert.equal(retry.renewal.id, HANDOFF_CASE.id, 'the same case is returned');
    assert.equal(retry.renewal.status, STATUS_LABELS.AWAITING_PRESCRIBER);
    assert.equal(retry.renewal.next_actor, 'prescriber');
    assert.equal(retry.renewal.handoff_at, firstTimestamp, 'the ORIGINAL first valid handoff timestamp is preserved');

    // Durable invariants: one transition, one event, original timestamp,
    // no duplicate row of any kind.
    const row = savedCase(dbPath);
    assert.equal(row.status, STATUS_LABELS.AWAITING_PRESCRIBER);
    assert.equal(row.handoff_at, firstTimestamp, 'durable handoff_at is the first valid timestamp');
    assert.equal(row.version, 2, 'version moved 1 -> 2 exactly once (one status change)');
    assert.equal(handoffEvents(dbPath).length, 1, 'exactly one handoff event after the retry');
    const db = initDatabase(dbPath);
    try {
      assert.equal(
        db.prepare(`SELECT COUNT(*) AS n FROM renewals`).get().n,
        2,
        'no duplicate case row (the two fixture renewals remain the only rows)'
      );
      assert.equal(
        db.prepare(`SELECT COUNT(*) AS n FROM renewal_events`).get().n,
        1,
        'no duplicate event row of any type'
      );
      assert.equal(
        db.prepare(`SELECT COUNT(*) AS n FROM pharmacy_conversation_messages`).get().n,
        0,
        'no message history rows'
      );
    } finally {
      db.close();
    }

    // A second repeat is equally stable (repeat-of-repeat).
    const repeat = handoff(dbPath);
    assert.equal(repeat.code, 'already-handed-off');
    assert.equal(repeat.renewal.handoff_at, firstTimestamp, 'repeat-of-repeat preserves the original timestamp');
    assert.equal(savedCase(dbPath).version, 2, 'no further version movement');
    assert.equal(handoffEvents(dbPath).length, 1, 'no further event rows');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('every denial is opaque and byte-identical (unrelated pharmacy, patient, prescriber, unknown role, unknown id) and writes zero durable state', () => {
  const { dir, dbPath } = freshDb('denials');
  try {
    assertSyntheticPreState(dbPath, 'pre');
    const before = fullTableState(dbPath);

    const outcomes = [
      ['unrelated pharmacy', handoff(dbPath, { id: 'pharmacy-dunmore', role: 'pharmacy' })],
      ['patient role', handoff(dbPath, { id: 'ending-b-patient', role: 'patient' })],
      ['prescriber role', handoff(dbPath, { id: 'ending-b-prescriber', role: 'prescriber' })],
      ['unknown role', handoff(dbPath, { id: 'denial-patient', role: 'admin' })],
      ['missing id', handoff(dbPath, { id: '', role: 'pharmacy' })],
      ['null identity', handoff(dbPath, null)],
      ['unknown record id', handoff(dbPath, cedarIdentity, 'no-such-renewal')],
    ];

    for (const [label, res] of outcomes) {
      assert.equal(res.ok, false, `${label}: denial`);
      assert.equal(res.code, 'not-authorized', `${label}: fixed opaque code`);
      assert.equal(res.renewal, undefined, `${label}: no case value is returned`);
      assertNoCaseData(res, label);
    }

    // No existence disclosure: the unrelated-pharmacy denial and the
    // unknown-id denial are byte-identical (the estate convention).
    assert.deepEqual(
      outcomes[0][1],
      outcomes[6][1],
      'unrelated pharmacy and unknown id denials are byte-identical'
    );

    // Every denial left the full durable state unchanged (status, next
    // actor, events, timestamps, message history, decision timeline,
    // refill count — all tables).
    const after = fullTableState(dbPath);
    assertStateUnchanged(after, before, 'denials');
    assert.equal(handoffEvents(dbPath).length, 0, 'no handoff event from any denial');
    assert.equal(savedCase(dbPath).status, STATUS_LABELS.SENT_TO_PHARMACY, 'case still Sent to pharmacy');

    // The case is still handable after the denials (they consumed nothing).
    const ok = handoff(dbPath);
    assert.equal(ok.code, 'handed-off', 'the case is still handable after all denials');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('a saved final outcome is invalid-case-state: fixed result, no event, no change (the case can no longer be handed off)', () => {
  const { dir, dbPath } = freshDb('invalid-state');
  try {
    // ending-a-renewal is the fixture's terminal 'Renewal approved' record,
    // also assigned to pharmacy-cedar (so the assignment check passes and
    // only the state check can fire).
    const before = fullTableState(dbPath);
    const res = handoff(dbPath, cedarIdentity, 'ending-a-renewal');
    assert.equal(res.ok, false, 'a final outcome cannot be handed off');
    assert.equal(res.code, 'invalid-case-state', 'fixed invalid-case-state code');
    assert.equal(res.recoverable, undefined, 'a final state is not a recoverable save failure');
    assertNoCaseData(res, 'invalid-case-state');
    const after = fullTableState(dbPath);
    assertStateUnchanged(after, before, 'invalid-case-state');
    assert.equal(
      (() => {
        const db = initDatabase(dbPath);
        try {
          return db.prepare(`SELECT COUNT(*) AS n FROM renewal_events WHERE renewal_id = 'ending-a-renewal'`).get().n;
        } finally {
          db.close();
        }
      })(),
      0,
      'no event of any kind for the terminal case'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('injected failed handoff commit: real UPDATE+INSERT then rollback leaves zero new rows, prior state byte-identical, no partial event, and the next handoff succeeds', () => {
  const { dir, dbPath } = freshDb('rollback');
  try {
    assertSyntheticPreState(dbPath, 'pre');
    // A committed session for the acting pharmacy (part of the
    // before-state, mirroring the estate's failed-ask test).
    const session = signIn(dbPath, 'pharmacy.cedar', 'pharmacy-cedar-2026');
    assert.equal(session.status, 200, 'previous committed session exists');
    const before = fullTableState(dbPath);

    // Inject the failure AFTER the UPDATE+INSERT and BEFORE the COMMIT:
    // the real writes run, then the transaction rolls back.
    const failed = handoff(dbPath, cedarIdentity, HANDOFF_CASE.id, { failHandoffCommit: true });
    assert.equal(failed.ok, false, 'save failure is reported');
    assert.equal(failed.code, 'handoff-save-failed');
    assert.equal(failed.recoverable, true, 'the result is explicitly recoverable');
    assert.equal(failed.created, undefined, 'no transition was created');
    assert.equal(failed.renewal, undefined, 'no record value is returned on failure');
    assertNoCaseData(failed, 'failed handoff');

    // Reread on a fresh connection: every table byte-identical; no partial
    // transition row and no partial handoff event.
    const after = fullTableState(dbPath);
    assertStateUnchanged(after, before, 'failed handoff rollback');
    const row = savedCase(dbPath);
    assert.equal(row.status, STATUS_LABELS.SENT_TO_PHARMACY, 'the case remains Sent to pharmacy');
    assert.equal(row.handoff_at, null, 'no partial handoff time');
    assert.equal(row.version, 1, 'no partial version movement');
    assert.equal(handoffEvents(dbPath).length, 0, 'no partial handoff event from the failed commit');

    // Recovery: the next handoff (no fault injected) succeeds and creates
    // exactly one transition and one handoff event.
    const retry = handoff(dbPath);
    assert.equal(retry.ok, true, 'recovery: the next handoff succeeds');
    assert.equal(retry.code, 'handed-off');
    assert.equal(retry.created, true);
    assert.equal(savedCase(dbPath).version, 2, 'recovery: exactly one transition total');
    assert.equal(handoffEvents(dbPath).length, 1, 'recovery: exactly one handoff event total');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('missing-release regression (test-only overlap seam): an un-released first-writer hold is a RECOVERABLE failure — the transition rolls back, every durable table is unchanged, and the subsequent retry commits exactly one transition and one handoff event', () => {
  const { dir, dbPath } = freshDb('missing-release');
  try {
    assertSyntheticPreState(dbPath, 'pre');
    const before = fullTableState(dbPath);
    // Cell 0 = 1 (this writer is the only entry); cell 2 is never set: the
    // confirmed second entrant never releases the hold. The 5 s hang guard
    // fires, the in-flight UPDATE+INSERT rolls back, and the failure is
    // reported as recoverable.
    const barrier = new Int32Array(new SharedArrayBuffer(16));
    Atomics.store(barrier, 0, 1);
    const t0 = Date.now();
    const failed = handoff(dbPath, cedarIdentity, HANDOFF_CASE.id, { handoffBarrier: barrier });
    const guardMs = Date.now() - t0;
    assert.ok(guardMs >= 4900, `the 5 s hang guard fired (elapsed ${guardMs} ms)`);
    assert.equal(failed.ok, false, 'the unreleased hold is a reported failure');
    assert.equal(failed.code, 'handoff-save-failed', 'the failure uses the recoverable code');
    assert.equal(failed.recoverable, true, 'the failure is recoverable (no data loss; retry is safe)');
    assert.equal(failed.renewal, undefined, 'no record value is returned on failure');
    assertNoCaseData(failed, 'missing-release failure');

    // Durable state: the rollback removed the attempted transition — every
    // table byte-identical, no partial transition, no partial handoff event.
    assertStateUnchanged(fullTableState(dbPath), before, 'missing-release rollback');
    const row = savedCase(dbPath);
    assert.equal(row.status, STATUS_LABELS.SENT_TO_PHARMACY, 'the case remains Sent to pharmacy');
    assert.equal(row.next_actor, 'pharmacy', 'the next actor is unchanged');
    assert.equal(row.handoff_at, null, 'no partial handoff time');
    assert.equal(row.version, 1, 'no partial version movement');
    assert.equal(handoffEvents(dbPath).length, 0, 'no partial handoff event from the un-released hold');

    // Recovery: the subsequent retry (seam off) succeeds — exactly one
    // transition and one handoff event, the first valid handoff timestamp
    // recorded.
    const retry = handoff(dbPath);
    assert.equal(retry.ok, true, 'recovery: the subsequent handoff succeeds');
    assert.equal(retry.code, 'handed-off');
    assert.equal(retry.created, true);
    assert.equal(retry.renewal.status, STATUS_LABELS.AWAITING_PRESCRIBER);
    assert.equal(retry.renewal.next_actor, 'prescriber');
    assert.ok(!Number.isNaN(Date.parse(retry.renewal.handoff_at)), 'the handoff time is recorded');
    assert.equal(retry.renewal.version, 2, 'exactly one transition (version 1 -> 2)');
    assert.equal(savedCase(dbPath).version, 2, 'durable: exactly one transition');
    const events = handoffEvents(dbPath);
    assert.equal(events.length, 1, 'durable: exactly one handoff event');
    assert.equal(events[0].occurred_at, savedCase(dbPath).handoff_at, 'the event records the handoff time');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('zero-entry observer regression (test-only overlap seam): a fresh, ALL-ZERO four-cell observer — no recorded entry at all — must be rejected by the FINAL pre-COMMIT entry-count guard (the guard runs for EVERY enabled observer, not only the count-equals-one recheck branch): the transition rolls back, the case and every table are unchanged, and zero events and zero proof are published', () => {
  const { dir, dbPath } = freshDb('zero-entry');
  try {
    assertSyntheticPreState(dbPath, 'pre');
    const before = fullTableState(dbPath);
    // A valid four-cell observer with EVERY cell at zero: the writer's
    // recheck after publishing the hold does NOT see count one (it sees
    // zero), so it never enters the count-equals-one branch and never
    // waits. The FINAL guard immediately before the COMMIT still loads
    // cell 0 exactly once (0) and must fail closed: entries < 2 — no
    // second entry was ever recorded — so the in-flight UPDATE+INSERT
    // rolls back and nothing is published.
    const barrier = new Int32Array(new SharedArrayBuffer(16));
    assert.equal(Atomics.load(barrier, 0), 0, 'the observer starts all-zero');
    assert.equal(Atomics.load(barrier, 1), 0, 'the observer starts all-zero (hold)');
    assert.equal(Atomics.load(barrier, 2), 0, 'the observer starts all-zero (release)');
    assert.equal(Atomics.load(barrier, 3), 0, 'the observer starts all-zero (proof)');
    const res = handoff(dbPath, cedarIdentity, HANDOFF_CASE.id, { handoffBarrier: barrier });
    assert.equal(res.ok, false, 'the zero-entry observer fails closed');
    assert.equal(res.code, 'handoff-save-failed', 'the failure uses the recoverable code');
    assert.equal(res.recoverable, true, 'the failure is recoverable (no data loss; retry is safe)');
    assert.equal(res.created, undefined, 'no transition was created');
    assert.equal(res.renewal, undefined, 'no record value is returned on failure');
    assertNoCaseData(res, 'zero-entry failure');

    // The original durable state is byte-identical: the case, the events,
    // and every other table are unchanged by the rolled-back transition.
    assertStateUnchanged(fullTableState(dbPath), before, 'zero-entry rollback');
    const row = savedCase(dbPath);
    assert.equal(row.status, STATUS_LABELS.SENT_TO_PHARMACY, 'the case remains Sent to pharmacy');
    assert.equal(row.next_actor, 'pharmacy', 'the next actor is unchanged');
    assert.equal(row.handoff_at, null, 'no partial handoff time');
    assert.equal(row.version, 1, 'no partial version movement');
    assert.equal(handoffEvents(dbPath).length, 0, 'zero handoff events');
    // ZERO proof: the rolled-back commit published nothing — cell 3 stays
    // at its initial value (the proof is published only after a successful
    // COMMIT, and a rollback publishes nothing).
    assert.equal(Atomics.load(barrier, 3), 0, 'zero proof: the rolled-back commit published nothing to cell 3');

    // Recovery: the same case still hands off cleanly with the seam off —
    // the fail-closed rejection consumed nothing.
    const retry = handoff(dbPath);
    assert.equal(retry.ok, true, 'recovery: the subsequent handoff succeeds');
    assert.equal(retry.code, 'handed-off');
    assert.equal(savedCase(dbPath).version, 2, 'recovery: exactly one transition');
    assert.equal(handoffEvents(dbPath).length, 1, 'recovery: exactly one handoff event');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- deterministic write-lock contention (estate worker-thread pattern) ----

test('overlap-seam recheck: an entrant that arrives just before the hold is published is honored — the hold is not waited on, the first commit proceeds, and cell 3 is published only after the successful COMMIT', () => {
  const { dir, dbPath } = freshDb('recheck');
  try {
    assertSyntheticPreState(dbPath, 'pre');
    const barrier = new Int32Array(new SharedArrayBuffer(16));
    // Two handler entries are already recorded (cell 0 = 2) and the second
    // entry's release (cell 2) has NOT been issued yet: the entrant
    // arrived just before this writer publishes the hold. The recheck
    // after publishing must see the confirmed entrant and proceed to
    // COMMIT without waiting (waiting would hit the 5 s hang guard and
    // roll back the durable transition).
    Atomics.store(barrier, 0, 2);
    const t0 = Date.now();
    const res = handoff(dbPath, cedarIdentity, HANDOFF_CASE.id, { handoffBarrier: barrier });
    const elapsed = Date.now() - t0;
    assert.equal(res.ok, true, 'the recheck does not wait for a release that was never issued');
    assert.equal(res.code, 'handed-off');
    assert.ok(elapsed < 3000, `no hang-guard wait on the rechecked path (elapsed ${elapsed} ms)`);
    assert.equal(Atomics.load(barrier, 1), 1, 'the hold was published before the recheck');
    assert.equal(Atomics.load(barrier, 3), 2, 'cell 3 = the observed entry count, published only after the COMMIT succeeded');
    assert.equal(savedCase(dbPath).version, 2, 'durable: one transition');
    assert.equal(handoffEvents(dbPath).length, 1, 'durable: one handoff event');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('release-before-wait regression (test-only overlap seam): a second entrant that increments the entry count AND delivers the release after the first writer rechecks but BEFORE its Atomics.wait — the valid wait returns "not-equal" (honored, never the decision), the ACTUAL recorded entry count is re-read before the COMMIT, and the phase-B release-without-a-second-entry variant fails closed with unchanged durable state and zero proof; one transition, one event', async () => {
  const { dir, dbPath } = freshDb('release-before-wait');
  try {
    assertSyntheticPreState(dbPath, 'pre');
    // The seam protocol's cells: cell 0 = handler entry count, cell 1 =
    // hold, cell 2 = release, cell 3 = precommit proof. The window under
    // test: a second entrant increments cell 0 (a confirmed 2nd entry)
    // and delivers the release (cell 2) AFTER the first writer's recheck
    // (which saw entries === 1 and therefore takes the wait path) but
    // BEFORE (or during) its Atomics.wait. A valid Atomics.wait on a cell
    // that is already different returns 'not-equal' (not 'ok'); a rule
    // keyed on the wait result (or on the release alone) would be wrong in
    // both directions. The COMMIT decision comes from the ACTUAL recorded
    // entry count, re-read immediately before the COMMIT: the second
    // entry is confirmed (count 2) — never the wait result, never the
    // release alone. The second entrant is a real competing thread: it
    // acts only AFTER it observes the hold
    // (cell 1), which the writer publishes AFTER the recheck — so its
    // entry + release land either strictly between the recheck and the
    // wait (the window under test) or before the recheck (the honored
    // recheck path); every ordering commits exactly once. The specific
    // "release delivered before the wait returns not-equal" path is
    // pinned deterministically in the dedicated deterministic test below.
    const sab = new SharedArrayBuffer(16);
    const barrier = new Int32Array(sab);
    const SECOND_ENTRANT = `import { parentPort } from 'node:worker_threads';
      const sab = await new Promise((resolve, reject) => {
        parentPort.once('message', (m) => (m && m.type === 'sab' ? resolve(m.sab) : reject(new Error('unexpected first worker message'))));
      });
      const b = new Int32Array(sab);
      const mode = process.env.RFRL_ENTRANT_MODE;
      let sawHold = false;
      for (let i = 0; i < 50 && !sawHold; i++) {
        if (Atomics.load(b, 1) === 1) { sawHold = true; break; }
        if (Atomics.wait(b, 1, 0, 200) === 'timed-out') {
          parentPort.postMessage({ type: 'error', message: 'hold never published' });
        }
      }
      if (sawHold && mode === 'race') {
        Atomics.add(b, 0, 1);
        Atomics.store(b, 2, 1);
        Atomics.notify(b, 2);
      }
      parentPort.postMessage({ type: 'done' });`;
    const runSecondEntrant = (mode) => new Promise((resolve) => {
      const worker = new Worker(SECOND_ENTRANT, { eval: true, env: { ...process.env, RFRL_ENTRANT_MODE: mode } });
      let settled = false;
      const finish = (err) => {
        if (!settled) {
          settled = true;
          try { worker.terminate(); } catch { /* already gone */ }
          resolve(err);
        }
      };
      worker.on('message', (m) => {
        if (m && m.type === 'error') finish(new Error(`second entrant: ${m.message}`));
        else if (m && m.type === 'done') finish(null);
      });
      worker.on('error', (err) => finish(err));
      worker.on('exit', (code) => finish(code === 0 ? null : new Error(`second entrant worker exited with code ${code}`)));
      worker.postMessage({ type: 'sab', sab });
    });

    // Phase A — the REAL release-before-wait window (thread race):
    // cell 0 = 1 (this writer is the only entry, so the recheck after
    // publishing the hold takes the wait path).
    Atomics.store(barrier, 0, 1);
    const racePromise = runSecondEntrant('race');
    let resA;
    try {
      resA = handoff(dbPath, cedarIdentity, HANDOFF_CASE.id, { handoffBarrier: barrier });
    } finally {
      // The handoff has returned; the entrant has by then finished (it
      // acted on the hold, which only exists for the handoff's duration).
    }
    const entrantError = await racePromise;
    assert.equal(entrantError, null, `the second entrant completed its entry + release (got ${entrantError && entrantError.message})`);
    // The entrant acted only after it observed the hold, and the hold was
    // published after the recheck could have run: either ordering is
    // honored, and both land the 2nd entry before the first COMMIT.
    assert.equal(Atomics.load(barrier, 0), 2, 'cell 0: two confirmed entries before the first commit');
    assert.equal(Atomics.load(barrier, 1), 1, 'the first writer published the hold');
    assert.equal(Atomics.load(barrier, 2), 1, 'the release was delivered before the wait ended');

    assert.equal(resA.ok, true, 'a valid release delivered before/at the wait must NOT roll back ("not-equal" is honored)');
    assert.equal(resA.code, 'handed-off', 'the transition committed');
    assert.equal(resA.created, true);
    assert.equal(resA.renewal.status, STATUS_LABELS.AWAITING_PRESCRIBER);
    assert.equal(resA.renewal.version, 2, 'exactly one transition (version 1 -> 2)');
    assert.equal(Atomics.load(barrier, 3), 2, 'cell 3 (the precommit proof, store-written) = 2 entries before the first commit');
    // Durable: one transition, one handoff event.
    assert.equal(savedCase(dbPath).version, 2, 'durable: exactly one transition');
    assert.equal(handoffEvents(dbPath).length, 1, 'durable: exactly one handoff event');

    // Phase B — the DETERMINISTIC release-without-a-second-entry (the
    // fail-closed variant of the same window):
    // the release is pre-set (cell 2 = 1) while the recheck still sees
    // ONLY this writer (cell 0 = 1 — one counted request, no second
    // entry ever recorded). The wait begins with the cell already
    // different and returns 'not-equal' — the release WAKES the wait, but
    // the actual recorded entry count remains one. The acceptance
    // predicate is the ACTUAL entry count (never the release, never the
    // wait result), so the transition must FAIL CLOSED: ROLLBACK,
    // unchanged durable state, and ZERO proof (cell 3 stays 0 — nothing
    // was published, because nothing committed).
    const envB = freshDb('release-without-entry');
    const dbPathB = envB.dbPath;
    const beforeB = fullTableState(dbPathB);
    const barrierB = new Int32Array(new SharedArrayBuffer(16));
    Atomics.store(barrierB, 0, 1);
    Atomics.store(barrierB, 2, 1);
    const resB = handoff(dbPathB, cedarIdentity, HANDOFF_CASE.id, { handoffBarrier: barrierB });
    assert.equal(resB.ok, false, 'a release without a second entry is a reported failure (the release is a wake-up only — it is never OR\'ed into the acceptance predicate)');
    assert.equal(resB.code, 'handoff-save-failed', 'the failure uses the recoverable code');
    assert.equal(resB.recoverable, true, 'the failure is recoverable (no data loss; retry is safe)');
    assert.equal(resB.created, undefined, 'no transition was created');
    assert.equal(resB.renewal, undefined, 'no record value is returned on failure');
    assertNoCaseData(resB, 'release-without-entry failure');
    // Durable state: the rollback removed the attempted transition —
    // every table byte-identical; no partial transition, no partial
    // handoff event.
    assertStateUnchanged(fullTableState(dbPathB), beforeB, 'release-without-entry rollback');
    const rowB = savedCase(dbPathB);
    assert.equal(rowB.status, STATUS_LABELS.SENT_TO_PHARMACY, 'the case remains Sent to pharmacy');
    assert.equal(rowB.version, 1, 'no partial version movement');
    assert.equal(handoffEvents(dbPathB).length, 0, 'no partial handoff event');
    // ZERO proof: the failed (rolled-back) commit published nothing —
    // cell 3 stays at its initial value.
    assert.equal(Atomics.load(barrierB, 3), 0, 'zero proof: the rolled-back commit published nothing to cell 3');
    rmSync(envB.dir, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deterministic genuine release-before-wait interleaving (test-only overlap seam): after the count-one recheck, BOTH the increment to a count of two AND cell 2 release are delivered just before the real Atomics.wait — the real wait returns "not-equal", and the ACTUAL recorded entry count (re-read immediately before the COMMIT) is 2: the commit proceeds with proof count 2, one transition, one durable handoff event', () => {
  const { dir, dbPath } = freshDb('deterministic-race');
  try {
    assertSyntheticPreState(dbPath, 'pre');
    // This is the genuine release-before-wait interleaving, made
    // deterministic: the writer's recheck (after publishing the hold)
    // sees count one and takes the wait path; immediately before the
    // real Atomics.wait runs, the second entrant increments the entry
    // count to two AND delivers the release (cell 2) — both just before
    // the wait. The real Atomics.wait then returns 'not-equal' (the cell
    // was already different), and the decision re-reads the ACTUAL
    // recorded entry count — 2 — immediately before the COMMIT. Only
    // this barrier's wait is intercepted: the store's real Atomics.wait
    // implementation runs inside the hook (the 'not-equal' is produced
    // by the real implementation, not simulated), and the hook is
    // restored in finally.
    const barrier = new Int32Array(new SharedArrayBuffer(16));
    Atomics.store(barrier, 0, 1); // this writer is the only recorded entry at the recheck
    let waitCalls = 0;
    let waitArgs = null;
    let waitResult = null;
    const realWait = Atomics.wait;
    try {
      Atomics.wait = function (typedArray, index, value, timeout) {
        waitCalls += 1;
        waitArgs = { index, value, timeout };
        // The second entrant acts in the window between the writer's
        // recheck and its wait: the increment to a count of two AND the
        // release, both just before invoking the real Atomics.wait.
        if (typedArray === barrier && index === 2) {
          Atomics.add(typedArray, 0, 1); // cell 0: 1 -> 2 (the second entry)
          Atomics.store(typedArray, 2, 1); // cell 2: the release
        }
        const result = realWait(typedArray, index, value, timeout);
        if (typedArray === barrier && index === 2) waitResult = result;
        return result;
      };
      const res = handoff(dbPath, cedarIdentity, HANDOFF_CASE.id, { handoffBarrier: barrier });

      // The REAL Atomics.wait was invoked exactly once — on the release
      // cell (2), with the 5 s hang guard — and returned 'not-equal':
      // the release had already been delivered before the wait.
      assert.equal(waitCalls, 1, 'exactly one real Atomics.wait (this barrier only)');
      assert.deepEqual(
        waitArgs,
        { index: 2, value: 0, timeout: 5000 },
        'the wait is on the release cell with the bounded 5 s hang guard'
      );
      assert.equal(waitResult, 'not-equal', 'the real wait returned "not-equal" (release delivered before the wait)');

      assert.equal(res.ok, true, 'the genuine release-before-wait interleaving commits (the actual entry count, not the release alone, is the predicate)');
      assert.equal(res.code, 'handed-off', 'the transition committed');
      assert.equal(res.created, true, 'the transition was created by this call');
      assert.equal(res.renewal.id, HANDOFF_CASE.id, 'the SAME case is handed off');
      assert.equal(res.renewal.status, STATUS_LABELS.AWAITING_PRESCRIBER);
      assert.equal(res.renewal.next_actor, 'prescriber');
      assert.equal(res.renewal.version, 2, 'exactly one transition (version 1 -> 2)');
      assert.equal(Atomics.load(barrier, 0), 2, 'cell 0: two recorded entries');
      assert.equal(Atomics.load(barrier, 3), 2, 'proof count 2: the actual recorded entry count captured before the COMMIT and published after it');
      // Durable: one transition, one handoff event.
      assert.equal(savedCase(dbPath).version, 2, 'durable: exactly one transition');
      const events = handoffEvents(dbPath);
      assert.equal(events.length, 1, 'durable: exactly one handoff event');
      assert.equal(events[0].occurred_at, savedCase(dbPath).handoff_at, 'the event records the handoff time');
    } finally {
      Atomics.wait = realWait;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A worker thread that commits a RIVAL handoff of the same renewal on its
// own connection, then re-acquires the write lock and holds it until the
// main thread reports the store's first write-lock error — the estate's
// proven contention pattern (patient-request.store.test.mjs). The rival
// uses a DIFFERENT synthetic pharmacy identity on the SAME renewal row so
// the under-lock re-read (not a unique-index backstop) is what makes the
// main thread's retry converge on the committed winner.
const RIVAL_SCRIPT = `
  import { DatabaseSync } from 'node:sqlite';
  import { parentPort } from 'node:worker_threads';
  const dbPath = process.env.RFRL_DB_PATH;
  const renewalId = process.env.RFRL_RENEWAL_ID;
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
    // thread pairs Atomics.store with Atomics.notify; after ANY wake or
    // timeout the flag is RECHECKED before acting.
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
      // Commit the rival handoff on its own connection.
      const at = new Date().toISOString();
      db.exec('BEGIN IMMEDIATE');
      db.prepare(
        "UPDATE renewals SET status = 'Awaiting prescriber', next_actor = 'prescriber', handoff_at = ?, version = version + 1 WHERE id = ?"
      ).run(at, renewalId);
      db.prepare(
        'INSERT INTO renewal_events (renewal_id, event_type, actor_role, actor_id, occurred_at, payload) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(renewalId, 'handoff', 'pharmacy', 'rival-worker-pharmacy', at, JSON.stringify({ synthetic: true, rival: true }));
      db.exec('COMMIT');
      // Re-acquire the write lock and hold it: the store's first
      // BEGIN IMMEDIATE will now observe a real lock error.
      db.exec('BEGIN IMMEDIATE');
      Atomics.store(flag, 1, 1);
      Atomics.notify(flag, 1);
      parentPort.postMessage({ type: 'holding' });
      // Hold until the MAIN thread reports the store's first write-lock
      // error (cell 2) — not a fixed duration — so the release is a
      // response to the contention, and the store's bounded retry is what
      // acquires the lock afterward.
      for (;;) {
        if (Atomics.load(flag, 2) === 1) break;
        Atomics.wait(flag, 2, 0, 1000);
        if (Atomics.load(flag, 2) !== 1) {
          fail('the handoff never reported a write-lock error while the lock was held');
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

function startRivalHolder(dbPath, { renewalId }) {
  // 12 bytes: cell 0 = main-ready, cell 1 = rival-holding, cell 2 = the
  // release handoff (1 = the store reported a lock error; 2 = the rival
  // acknowledged the release and the lock is free).
  const sab = new SharedArrayBuffer(12);
  const flag = new Int32Array(sab);
  const worker = new Worker(RIVAL_SCRIPT, {
    eval: true,
    env: { ...process.env, RFRL_DB_PATH: dbPath, RFRL_RENEWAL_ID: renewalId },
  });
  worker.postMessage({ type: 'sab', sab });

  let workerError = null;
  let exitCode = null;
  const doneWaiters = [];
  const notify = () => {
    if (workerError) {
      while (doneWaiters.length) doneWaiters.shift()(workerError);
      return;
    }
    if (exitCode !== null) {
      const err = exitCode === 0 ? null : new Error(`worker exited with code ${exitCode}`);
      while (doneWaiters.length) {
        const fn = doneWaiters.shift();
        if (err) fn(err);
        else fn(null);
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

  const waitingFor = (cell) => new Promise((resolve, reject) => {
    if (workerError) return reject(workerError);
    if (exitCode !== null) {
      return reject(new Error(`worker exited (code ${exitCode}) before reaching the barrier`));
    }
    const deadline = Date.now() + 15000;
    const spin = () => {
      if (workerError) return reject(workerError);
      if (exitCode !== null) {
        return reject(new Error(`worker exited with code ${exitCode} before the barrier`));
      }
      if (Atomics.load(flag, cell) === 1) return resolve();
      if (Date.now() > deadline) {
        worker.terminate();
        return reject(new Error('worker did not reach the write-lock hold in time'));
      }
      Atomics.wait(flag, cell, 0, 25);
      if (Atomics.load(flag, cell) === 1) return resolve();
      spin();
    };
    spin();
  });

  return {
    signalMainReady: () => {
      Atomics.store(flag, 0, 1);
      Atomics.notify(flag, 0);
    },
    waitingForHold: () => waitingFor(1),
    // The store's first lock error calls this (deterministic release point):
    // it signals the rival to roll back and waits for the release
    // acknowledgment, so the store's retry acquires the just-freed lock.
    releaseAfterContention: () => {
      Atomics.store(flag, 2, 1);
      Atomics.notify(flag, 2);
      Atomics.wait(flag, 2, 1, 1000);
      assert.equal(Atomics.load(flag, 2), 2, 'rival released the SQLite write lock');
    },
    waitingForRelease: () =>
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 15000;
        const spin = () => {
          if (workerError) return reject(workerError);
          if (exitCode !== null) return reject(new Error(`worker exited with code ${exitCode} before the release`));
          if (Atomics.load(flag, 2) === 2) return resolve();
          if (Date.now() > deadline) {
            worker.terminate();
            return reject(new Error('worker did not release the write lock in time'));
          }
          Atomics.wait(flag, 2, 0, 25);
          if (Atomics.load(flag, 2) === 2) return resolve();
          spin();
        };
        spin();
      }),
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


test('write-lock contention on a worker thread: the bounded retry fires, the under-lock re-read converges on the committed winner idempotently, one transition, one event, no duplicate rows', async () => {
  const { dir, dbPath } = freshDb('locked-writer');
  const holder = startRivalHolder(dbPath, { renewalId: HANDOFF_CASE.id });
  try {
    // All of the main thread's setup writes are now committed; release the
    // worker to commit its rival handoff and take the write lock.
    holder.signalMainReady();
    await holder.waitingForHold();

    const { DatabaseSync } = await import('node:sqlite');
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
      res = handoffRenewalToPrescriber(dbPath, cedarIdentity, HANDOFF_CASE.id);
    } finally {
      DatabaseSync.prototype.prepare = prepare;
    }
    assert.equal(sawContention, true, 'the first write attempt observed a real SQLite lock error');

    assert.equal(res.ok, true, 'contention did not fail the handoff');
    assert.equal(res.code, 'already-handed-off', 'the retry-then-re-read converges on the committed winner');
    assert.equal(res.created, false, 'the main thread created no second transition');
    assert.equal(res.renewal.id, HANDOFF_CASE.id, 'the winner case is returned');
    assert.equal(res.renewal.status, STATUS_LABELS.AWAITING_PRESCRIBER);
    assert.ok(
      Number(res.lockRetries) > 0,
      `the bounded retry must have fired under contention (lockRetries=${res.lockRetries})`
    );

    // Deterministic release check: the rival acknowledged that it observed
    // the store's first write-lock error, rolled back its (empty)
    // transaction, and freed the write lock.
    await holder.waitingForRelease();
    await holder.done();

    // Outcome invariants: exactly one transition and one handoff event for
    // the renewal, despite the concurrent holder; the version moved exactly
    // once (1 -> 2) and the first valid timestamp is the durable one.
    const check = initDatabase(dbPath);
    try {
      const row = check.prepare(`SELECT * FROM renewals WHERE id = ?`).get(HANDOFF_CASE.id);
      assert.equal(row.status, STATUS_LABELS.AWAITING_PRESCRIBER);
      assert.equal(row.version, 2, 'exactly one committed transition (version 1 -> 2)');
      assert.equal(
        check.prepare(`SELECT COUNT(*) AS n FROM renewal_events WHERE renewal_id = ? AND event_type = ?`).get(HANDOFF_CASE.id, 'handoff').n,
        1,
        'exactly one handoff event despite the contention'
      );
      assert.equal(
        check.prepare(`SELECT COUNT(*) AS n FROM renewals`).get().n,
        2,
        'no duplicate renewal rows'
      );
    } finally {
      check.close();
    }
  } finally {
    holder.terminate();
    rmSync(dir, { recursive: true, force: true });
  }
});


test('contract guards: the handoff writes use the existing schema and vocabulary — one-handoff index intact, no new tables or columns, caseRefFor stable', () => {
  const { dir, dbPath } = freshDb('contracts');
  try {
    const db = initDatabase(dbPath);
    try {
      const tableNames = new Set(
        db.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table'`).all()
          .map((r) => r.name)
          .filter((name) => !name.startsWith('sqlite_'))
      );
      assert.equal(tableNames.size, 10, 'exactly the ten accepted tables exist (no new tables)');
      const indexNames = new Set(
        db.prepare(`SELECT name FROM sqlite_schema WHERE type = 'index'`).all().map((r) => r.name)
      );
      assert.ok(indexNames.has('renewal_events_one_handoff'), 'the one-handoff unique index still exists');

      // A second handoff event for the same renewal is rejected by the
      // durable backstop, even outside the store path.
      db.prepare(
        'INSERT INTO renewal_events (renewal_id, event_type, actor_role, actor_id, occurred_at, payload) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(HANDOFF_CASE.id, EVENT_TYPES.HANDOFF, 'pharmacy', 'guard-pharmacy', '2026-11-22T00:00:00Z', '{"synthetic":true}');
      let threwUnique = false;
      try {
        db.prepare(
          'INSERT INTO renewal_events (renewal_id, event_type, actor_role, actor_id, occurred_at, payload) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(HANDOFF_CASE.id, EVENT_TYPES.HANDOFF, 'pharmacy', 'guard-pharmacy', '2026-11-22T00:00:01Z', '{"synthetic":true}');
      } catch (err) {
        threwUnique = true;
        assert.match(String(err.message), /UNIQUE constraint failed/i, 'the duplicate handoff event trips the backstop');
      }
      assert.ok(threwUnique, 'the second handoff event for the same renewal is rejected');
      assert.equal(
        db.prepare(`SELECT COUNT(*) AS n FROM renewal_events WHERE renewal_id = ? AND event_type = ?`).get(HANDOFF_CASE.id, 'handoff').n,
        1,
        'the guard inserts left exactly one handoff event'
      );
    } finally {
      db.close();
    }
    // The stable opaque ref is unchanged by the handoff (same formula, same
    // id): the copied link and the queue link keep working.
    assert.equal(caseRefFor(HANDOFF_CASE.id), '77d74295c5e1ab5d5282a6868224dd5b');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('malformed observer regression: a 3-cell SAB (12 bytes) — which could reach the server yet would raise RangeError on the post-commit proof write — is rejected with the fixed outcome BEFORE any database write and before any barrier effect: zero durable changes and zero cell effects', () => {
  const { dir, dbPath } = freshDb('malformed-observer');
  try {
    assertSyntheticPreState(dbPath, 'pre');
    const before = fullTableState(dbPath);
    // The protocol needs the FOUR cells (16 bytes). This observer has
    // only three (12 bytes): a post-commit proof write to cell 3 would
    // raise RangeError, so the store must refuse it up front.
    const shortSab = new SharedArrayBuffer(12);
    const shortBarrier = new Int32Array(shortSab);
    const res = handoff(dbPath, cedarIdentity, HANDOFF_CASE.id, { handoffBarrier: shortBarrier });
    assert.equal(res.ok, false, 'the malformed observer is rejected');
    assert.equal(res.code, 'handoff-observer-malformed', 'fixed observer-malformed code');
    assert.equal(res.recoverable, undefined, 'not reported as a recoverable save failure');
    assert.equal(res.renewal, undefined, 'no case value is returned');
    assertNoCaseData(res, 'malformed-observer rejection');

    // Proved before effects: ZERO durable changes (every table
    // byte-identical) and ZERO barrier effects (no cell of the observer
    // was touched).
    assertStateUnchanged(fullTableState(dbPath), before, 'malformed observer');
    assert.equal(shortBarrier[0], 0, 'no entry-count effect');
    assert.equal(shortBarrier[1], 0, 'no hold published');
    assert.equal(shortBarrier[2], 0, 'no release written');
    const row = savedCase(dbPath);
    assert.equal(row.status, STATUS_LABELS.SENT_TO_PHARMACY, 'the case remains Sent to pharmacy');
    assert.equal(row.version, 1, 'no version movement');
    assert.equal(handoffEvents(dbPath).length, 0, 'no handoff event');

    // Other malformed shapes are rejected the same way, before effects:
    // a non-shared (plain ArrayBuffer) view, and a non-view value.
    const nonSharedBarrier = new Int32Array(new ArrayBuffer(16));
    const resNonShared = handoff(dbPath, cedarIdentity, HANDOFF_CASE.id, { handoffBarrier: nonSharedBarrier });
    assert.equal(resNonShared.ok, false, 'a non-shared view is rejected');
    assert.equal(resNonShared.code, 'handoff-observer-malformed');
    const resNonView = handoff(dbPath, cedarIdentity, HANDOFF_CASE.id, { handoffBarrier: shortSab });
    assert.equal(resNonView.ok, false, 'a raw SharedArrayBuffer (not an Int32Array view) is rejected');
    assert.equal(resNonView.code, 'handoff-observer-malformed');
    assertStateUnchanged(fullTableState(dbPath), before, 'malformed observer (all shapes)');

    // The seam stays usable when VALID: the same DB accepts a proper
    // 4-cell observer (seams off otherwise), so the rejection was the
    // shape check, not a broken seam.
    const validBarrier = new Int32Array(new SharedArrayBuffer(16));
    Atomics.store(validBarrier, 0, 2); // a confirmed second entry
    const ok = handoff(dbPath, cedarIdentity, HANDOFF_CASE.id, { handoffBarrier: validBarrier });
    assert.equal(ok.code, 'handed-off', 'a valid 4-cell observer still works on the same DB');
    assert.equal(Atomics.load(validBarrier, 3), 2, 'the proof publishes after the commit with the valid observer');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
