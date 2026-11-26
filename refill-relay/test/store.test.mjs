import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  STATUS_LABELS,
  EVENT_TYPES,
  SYNTHETIC_FIXTURES,
  SYNTHETIC_ACCOUNTS,
  SESSION_COOKIE_NAME,
  initDatabase,
  initSchema,
  seedSyntheticFixtures,
  seedSyntheticAccounts,
  signIn,
  getSession,
  signOut,
  handleAppRequest,
  writeMarker,
  readMarker,
} from '../store.mjs';

// --- helpers ---------------------------------------------------------------

function tableNames(db) {
  const rows = db
    .prepare(`SELECT name FROM sqlite_schema WHERE type IN ('table','index','trigger') ORDER BY name`)
    .all();
  return new Set(rows.map((r) => r.name));
}

function columnNames(db, table) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.map((c) => c.name);
}

function schemaSql(db, name) {
  const row = db
    .prepare(`SELECT sql FROM sqlite_schema WHERE name = ?`)
    .get(name);
  return row ? row.sql : null;
}

function rowsFor(db, table) {
  return db.prepare(`SELECT * FROM ${table}`).all();
}

function pragmaInt(db, key) {
  const row = db.prepare(`PRAGMA ${key}`).get();
  if (row && typeof row === 'object') return Number(row[key]);
  return Number(row);
}

function journalMode(db) {
  // Tolerant of the result shape: node:sqlite may surface the pragma as a
  // row ({ journal_mode: 'wal' }) or a bare value. Return the raw string form.
  let row;
  try {
    row = db.prepare('PRAGMA journal_mode').get();
  } catch {
    row = null;
  }
  if (row && typeof row === 'object') return String(row.journal_mode);
  return String(row);
}

function expectUniqueConstraintError(err, table) {
  assert.match(
    String(err.message),
    /UNIQUE constraint failed:\s*\S*\.?/i,
    `expected a UNIQUE constraint violation mentioning ${table}, got: ${err.message}`
  );
}

const REQUIRED_COLUMNS = {
  markers: ['key', 'value'],
  identities: ['id', 'role', 'display_name', 'is_synthetic'],
  prescriptions: ['id', 'patient_id', 'pharmacy_id', 'prescriber_id', 'refills_remaining', 'is_synthetic'],
  renewals: [
    'id', 'prescription_id', 'patient_id', 'pharmacy_id', 'prescriber_id',
    'status', 'next_actor', 'submitted_at', 'handoff_at', 'decided_at',
    'granted_refills', 'request_idempotency_key', 'version',
  ],
  renewal_events: ['id', 'renewal_id', 'event_type', 'actor_role', 'actor_id', 'occurred_at', 'payload'],
  pharmacy_conversation_messages: ['id', 'renewal_id', 'sender_role', 'sender_id', 'body', 'created_at'],
  office_messages: ['id', 'renewal_id', 'decision_id', 'body', 'created_at', 'audience'],
  phone_notes: ['id', 'renewal_id', 'pharmacy_actor_id', 'note', 'created_at'],
  sessions: ['token', 'identity_id', 'created_at', 'expires_at'],
  synthetic_accounts: ['username', 'identity_id', 'password_salt', 'password_hash'],
};

const REQUIRED_UNIQUE_INDEXES = [
  'refill_pending_per_prescription',
  'renewal_events_one_handoff',
  'renewal_events_one_final_decision',
];

const EMPTY_ON_INIT = [
  'identities', 'prescriptions', 'renewals',
  'renewal_events', 'pharmacy_conversation_messages', 'office_messages',
  'phone_notes', 'sessions', 'synthetic_accounts',
];

function seedPrescriptionAndPending(db, idPrefix) {
  db.prepare(
    `INSERT INTO prescriptions (id, patient_id, pharmacy_id, prescriber_id, refills_remaining, is_synthetic)
     VALUES (?, ?, ?, ?, 3, 1)`
  ).run(`${idPrefix}-rx`, `${idPrefix}-patient`, `${idPrefix}-pharmacy`, `${idPrefix}-doctor`);
  db.prepare(
    `INSERT INTO renewals
       (id, prescription_id, patient_id, pharmacy_id, prescriber_id,
        status, next_actor, submitted_at, version)
     VALUES (?, ?, ?, ?, ?, ?, 'pharmacy', '2026-11-20T00:00:00Z', 1)`
  ).run(`${idPrefix}-rn`, `${idPrefix}-rx`, `${idPrefix}-patient`, `${idPrefix}-pharmacy`, `${idPrefix}-doctor`, STATUS_LABELS.SENT_TO_PHARMACY);
}

function insertEvent(db, renewalId, eventType, occurredAt) {
  db.prepare(
    `INSERT INTO renewal_events (renewal_id, event_type, actor_role, actor_id, occurred_at, payload)
     VALUES (?, ?, 'prescriber', 'synthetic-actor', ?, ?)`
  ).run(renewalId, eventType, occurredAt, '{"synthetic":true}');
}


test('schema: required tables, fields, WAL, and empty future-workflow tables', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refill-relay-fixture-'));
  const dbPath = join(dir, 'fixture.sqlite');
  let db;
  try {
    db = initDatabase(dbPath);

    const names = tableNames(db);
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
      assert.ok(
        names.has(table),
        `sqlite_schema is missing table ${table}; present: ${[...names].sort().join(', ')}`
      );
      // columnNames normalizes PRAGMA rows to plain strings first, so this
      // deep-equal compares string arrays, never raw SQLite row objects.
      assert.deepEqual(
        columnNames(db, table),
        columns,
        `table ${table} columns mismatch`
      );
    }
    for (const index of REQUIRED_UNIQUE_INDEXES) {
      assert.ok(
        names.has(index),
        `sqlite_schema is missing unique index ${index}`
      );
    }
    // The unsynchronized decision/handoff tables must not exist: handoff and
    // final-decision data is held in the canonical renewal_events records.
    assert.ok(!names.has('decisions'), 'unsynchronized decisions table must not exist');
    assert.ok(!names.has('handoffs'), 'unsynchronized handoffs table must not exist');

    // The accepted status labels appear verbatim in the renewals schema and
    // in the pending-renewal partial unique index.
    const renewalsSql = schemaSql(db, 'renewals');
    assert.ok(renewalsSql, 'renewals schema sql is present');
    for (const label of Object.values(STATUS_LABELS)) {
      assert.ok(
        renewalsSql.includes(`'${label}'`),
        `renewals status constraint must use the exact label '${label}'`
      );
    }
    const pendingIndexSql = schemaSql(db, 'refill_pending_per_prescription');
    assert.ok(pendingIndexSql, 'refill_pending_per_prescription index sql is present');
    assert.ok(
      pendingIndexSql.includes(`'${STATUS_LABELS.SENT_TO_PHARMACY}'`) &&
        pendingIndexSql.includes(`'${STATUS_LABELS.AWAITING_PRESCRIBER}'`),
      'pending-renewal index must use the exact non-final labels'
    );

    // WAL-backed transactional file database: assert the effective settings.
    assert.equal(journalMode(db), 'wal', 'journal mode must be WAL');
    assert.equal(pragmaInt(db, 'foreign_keys'), 1, 'foreign keys must be ON');

    // Schema-only future-workflow tables (and every other table) start empty.
    for (const table of EMPTY_ON_INIT) {
      assert.equal(
        db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,
        0,
        `table ${table} must be empty on initialization`
      );
    }

    // Close and reopen on a fresh connection; schema and WAL must persist.
    db.close();
    db = initDatabase(dbPath);
    const reopenedNames = tableNames(db);
    for (const table of Object.keys(REQUIRED_COLUMNS)) {
      assert.ok(reopenedNames.has(table), `table ${table} missing after reopen`);
    }
    assert.equal(
      journalMode(db),
      'wal',
      'journal mode must still be WAL after reopen'
    );
    for (const table of EMPTY_ON_INIT) {
      assert.equal(
        db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,
        0,
        `table ${table} must still be empty after reopen`
      );
    }
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('initSchema: effective pragmas are asserted and initialization fails when WAL cannot be established', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refill-relay-fixture-'));
  const dbPath = join(dir, 'fixture.sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    initSchema(db);
    // initSchema only succeeds after asserting these effective settings.
    assert.equal(journalMode(db), 'wal', 'effective journal mode must be WAL');
    assert.equal(pragmaInt(db, 'foreign_keys'), 1, 'effective foreign keys must be ON');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }

  // A read-only database rejects the journal-mode change; the required WAL
  // setting cannot be established, so initSchema must throw instead of
  // silently continuing.
  const roDir = mkdtempSync(join(tmpdir(), 'refill-relay-fixture-'));
  const roPath = join(roDir, 'ro.sqlite');
  let probe;
  let roDb;
  try {
    probe = new DatabaseSync(roPath);
    probe.exec(`CREATE TABLE markers (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    probe.close();
    roDb = new DatabaseSync(roPath, { readOnly: true });
    assert.throws(
      () => initSchema(roDb),
      /could not be established|read-only|attempt to write/i,
      'initSchema must fail when required WAL cannot be established'
    );
  } finally {
    roDb?.close();
    rmSync(roDir, { recursive: true, force: true });
  }
});

test('rule: one pending renewal per prescription (duplicate rejected)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refill-relay-fixture-'));
  const dbPath = join(dir, 'fixture.sqlite');
  let db;
  try {
    db = initDatabase(dbPath);
    seedPrescriptionAndPending(db, 'dup1');

    // One valid insert already succeeded above; the duplicate must fail.
    assert.throws(
      () =>
        db.prepare(
          `INSERT INTO renewals
             (id, prescription_id, patient_id, pharmacy_id, prescriber_id,
              status, next_actor, submitted_at, version)
           VALUES ('dup1-rn2', 'dup1-rx', 'dup1-patient', 'dup1-pharmacy', 'dup1-doctor',
                   'Sent to pharmacy', 'pharmacy', '2026-11-20T01:00:00Z', 1)`
        ).run(),
      (err) => {
        expectUniqueConstraintError(err, 'renewals (prescription_id)');
        return true;
      }
    );
    assert.equal(rowsFor(db, 'renewals').length, 1);

    // The pending slot is also taken by the other non-final label.
    db.prepare(
      `UPDATE renewals SET status = ? WHERE id = 'dup1-rn'`
    ).run(STATUS_LABELS.AWAITING_PRESCRIBER);
    assert.throws(
      () =>
        db.prepare(
          `INSERT INTO renewals
             (id, prescription_id, patient_id, pharmacy_id, prescriber_id,
              status, next_actor, submitted_at, version)
           VALUES ('dup1-rn3', 'dup1-rx', 'dup1-patient', 'dup1-pharmacy', 'dup1-doctor',
                   'Sent to pharmacy', 'pharmacy', '2026-11-20T02:00:00Z', 1)`
        ).run(),
      (err) => {
        expectUniqueConstraintError(err, 'renewals (prescription_id)');
        return true;
      }
    );

    // A final outcome releases the slot: a new pending renewal is allowed.
    db.prepare(
      `UPDATE renewals SET status = ?, granted_refills = 0, decided_at = '2026-11-20T03:00:00Z' WHERE id = 'dup1-rn'`
    ).run(STATUS_LABELS.VISIT_REQUIRED);
    db.prepare(
      `INSERT INTO renewals
         (id, prescription_id, patient_id, pharmacy_id, prescriber_id,
          status, next_actor, submitted_at, version)
       VALUES ('dup1-rn4', 'dup1-rx', 'dup1-patient', 'dup1-pharmacy', 'dup1-doctor',
               'Sent to pharmacy', 'pharmacy', '2026-11-20T04:00:00Z', 1)`
    ).run();
    assert.equal(rowsFor(db, 'renewals').length, 2);
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rule: one handoff per renewal, enforced on renewal_events (duplicate rejected)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refill-relay-fixture-'));
  const dbPath = join(dir, 'fixture.sqlite');
  let db;
  try {
    db = initDatabase(dbPath);
    seedPrescriptionAndPending(db, 'hf');

    // A valid first handoff event succeeds and is durable in renewal_events.
    insertEvent(db, 'hf-rn', EVENT_TYPES.HANDOFF, '2026-11-20T02:00:00Z');
    const [handoff] = rowsFor(db, 'renewal_events');
    assert.equal(handoff.renewal_id, 'hf-rn');
    assert.equal(handoff.event_type, EVENT_TYPES.HANDOFF);

    // A second handoff event for the same renewal is rejected by the
    // renewal_events_one_handoff unique index.
    assert.throws(
      () => insertEvent(db, 'hf-rn', EVENT_TYPES.HANDOFF, '2026-11-20T04:00:00Z'),
      (err) => {
        expectUniqueConstraintError(err, 'renewal_events (renewal_id)');
        return true;
      }
    );
    assert.equal(
      db.prepare(
        `SELECT COUNT(*) AS n FROM renewal_events
         WHERE renewal_id = 'hf-rn' AND event_type = ?`
      ).get(EVENT_TYPES.HANDOFF).n,
      1,
      'still exactly one durable handoff event'
    );
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rule: one final decision per renewal across outcomes, enforced on renewal_events (conflict rejected)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refill-relay-fixture-'));
  const dbPath = join(dir, 'fixture.sqlite');
  let db;
  try {
    db = initDatabase(dbPath);
    seedPrescriptionAndPending(db, 'dec');

    // A valid final decision (Renewal approved, exactly one refill) succeeds
    // in the canonical event record and on the renewal row.
    insertEvent(db, 'dec-rn', EVENT_TYPES.RENEWAL_APPROVED, '2026-11-20T05:00:00Z');
    db.prepare(
      `UPDATE renewals SET status = ?, granted_refills = 1, decided_at = '2026-11-20T05:00:00Z' WHERE id = 'dec-rn'`
    ).run(STATUS_LABELS.RENEWAL_APPROVED);
    const [decision] = rowsFor(db, 'renewal_events');
    assert.equal(decision.renewal_id, 'dec-rn');
    assert.equal(decision.event_type, STATUS_LABELS.RENEWAL_APPROVED);

    // A conflicting final outcome on the same renewal is rejected by the
    // renewal_events_one_final_decision unique index.
    assert.throws(
      () => insertEvent(db, 'dec-rn', EVENT_TYPES.VISIT_REQUIRED, '2026-11-20T07:00:00Z'),
      (err) => {
        expectUniqueConstraintError(err, 'renewal_events (renewal_id)');
        return true;
      }
    );
    assert.equal(
      db.prepare(
        `SELECT COUNT(*) AS n FROM renewal_events
         WHERE renewal_id = 'dec-rn' AND event_type IN (?, ?)`
      ).get(STATUS_LABELS.RENEWAL_APPROVED, STATUS_LABELS.VISIT_REQUIRED).n,
      1,
      'still exactly one durable final decision event'
    );
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rule: final outcome/refill-count pairs (valid succeed, invalid fail)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refill-relay-fixture-'));
  const dbPath = join(dir, 'fixture.sqlite');
  let db;
  try {
    db = initDatabase(dbPath);

    // Invalid pair on the renewals table: Visit required must grant zero.
    seedPrescriptionAndPending(db, 'pairs');
    assert.throws(
      () =>
        db.prepare(
          `UPDATE renewals
             SET status = 'Visit required', granted_refills = 1,
                 decided_at = '2026-11-20T08:00:00Z'
           WHERE id = 'pairs-rn'`
        ).run(),
      /CHECK constraint failed/i
    );

    // Valid pair succeeds: Visit required grants exactly zero refills.
    db.prepare(
      `UPDATE renewals
         SET status = 'Visit required', granted_refills = 0,
             decided_at = '2026-11-20T08:00:00Z'
       WHERE id = 'pairs-rn'`
    ).run();
    const visitRow = db
      .prepare(`SELECT status, granted_refills, decided_at FROM renewals WHERE id = 'pairs-rn'`)
      .get();
    assert.equal(visitRow.status, 'Visit required');
    assert.equal(visitRow.granted_refills, 0);

    // Invalid pair on the renewals table: Renewal approved must grant exactly one.
    seedPrescriptionAndPending(db, 'pairs2');
    assert.throws(
      () =>
        db.prepare(
          `UPDATE renewals
             SET status = 'Renewal approved', granted_refills = 0,
                 decided_at = '2026-11-20T09:00:00Z'
           WHERE id = 'pairs2-rn'`
        ).run(),
      /CHECK constraint failed/i
    );

    // Valid pair succeeds: Renewal approved grants exactly one refill.
    db.prepare(
      `UPDATE renewals
         SET status = 'Renewal approved', granted_refills = 1,
             decided_at = '2026-11-20T09:00:00Z'
       WHERE id = 'pairs2-rn'`
    ).run();
    const updated = db
      .prepare(`SELECT status, granted_refills, decided_at FROM renewals WHERE id = 'pairs2-rn'`)
      .get();
    assert.equal(updated.status, 'Renewal approved');
    assert.equal(updated.granted_refills, 1);
    assert.equal(updated.decided_at, '2026-11-20T09:00:00Z');

    // Invalid status labels are rejected by the CHECK (accepted labels only).
    assert.throws(
      () =>
        db.prepare(
          `UPDATE renewals SET status = 'pending' WHERE id = 'pairs2-rn'`
        ).run(),
      /CHECK constraint failed/i
    );
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('enforcement: foreign keys are ON in initDatabase connections (orphan rejected)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refill-relay-fixture-'));
  const dbPath = join(dir, 'fixture.sqlite');
  let db;
  try {
    db = initDatabase(dbPath);
    assert.equal(pragmaInt(db, 'foreign_keys'), 1);
    assert.throws(
      () =>
        db.prepare(
          `INSERT INTO renewal_events (renewal_id, event_type, occurred_at)
           VALUES ('no-such-renewal', 'handoff', '2026-11-20T06:00:00Z')`
        ).run(),
      /FOREIGN KEY constraint failed/i
    );
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('schema is idempotent: initSchema twice on one connection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refill-relay-fixture-'));
  const dbPath = join(dir, 'fixture.sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    initSchema(db); // idempotent on a plain open connection
    initSchema(db); // and again, to prove re-initialization is safe
    assert.equal(journalMode(db), 'wal');
    assert.equal(pragmaInt(db, 'foreign_keys'), 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});


const EXPECTED_IDENTITIES = [
  {
    id: 'ending-a-patient',
    role: 'patient',
    display_name: 'Ava Mercer',
    is_synthetic: 1,
  },
  {
    id: 'ending-a-prescriber',
    role: 'prescriber',
    display_name: 'Dr. Naomi Okafor',
    is_synthetic: 1,
  },
  {
    id: 'pharmacy-cedar',
    role: 'pharmacy',
    display_name: 'Cedar Crossing Pharmacy',
    is_synthetic: 1,
  },
  {
    id: 'ending-b-patient',
    role: 'patient',
    display_name: 'Boris Laine',
    is_synthetic: 1,
  },
  {
    id: 'ending-b-prescriber',
    role: 'prescriber',
    display_name: 'Dr. Priya Raman',
    is_synthetic: 1,
  },
  {
    id: 'denial-patient',
    role: 'patient',
    display_name: 'Cleo Voss',
    is_synthetic: 1,
  },
  {
    id: 'denial-prescriber',
    role: 'prescriber',
    display_name: 'Dr. Emil Hart',
    is_synthetic: 1,
  },
  {
    id: 'pharmacy-dunmore',
    role: 'pharmacy',
    display_name: 'Dunmore Corner Pharmacy',
    is_synthetic: 1,
  },
];

const EXPECTED_PRESCRIPTIONS = [
  {
    id: 'ending-a-rx',
    patient_id: 'ending-a-patient',
    pharmacy_id: 'pharmacy-cedar',
    prescriber_id: 'ending-a-prescriber',
    refills_remaining: 1,
    is_synthetic: 1,
  },
  {
    id: 'ending-b-rx',
    patient_id: 'ending-b-patient',
    pharmacy_id: 'pharmacy-cedar',
    prescriber_id: 'ending-b-prescriber',
    refills_remaining: 0,
    is_synthetic: 1,
  },
  {
    id: 'denial-rx',
    patient_id: 'denial-patient',
    pharmacy_id: 'pharmacy-dunmore',
    prescriber_id: 'denial-prescriber',
    refills_remaining: 1,
    is_synthetic: 1,
  },
];

const EXPECTED_RENEWALS = [
  {
    // Ending A: the approved terminal renewal.
    id: 'ending-a-renewal',
    prescription_id: 'ending-a-rx',
    patient_id: 'ending-a-patient',
    pharmacy_id: 'pharmacy-cedar',
    prescriber_id: 'ending-a-prescriber',
    status: STATUS_LABELS.RENEWAL_APPROVED,
    next_actor: 'pharmacy',
    submitted_at: '2026-11-21T08:00:00Z',
    handoff_at: '2026-11-21T08:30:00Z',
    decided_at: '2026-11-21T09:00:00Z',
    granted_refills: 1,
    request_idempotency_key: null,
    version: 1,
  },
  {
    // Ending B: the single 'Sent to pharmacy' example.
    id: 'ending-b-renewal',
    prescription_id: 'ending-b-rx',
    patient_id: 'ending-b-patient',
    pharmacy_id: 'pharmacy-cedar',
    prescriber_id: 'ending-b-prescriber',
    status: STATUS_LABELS.SENT_TO_PHARMACY,
    next_actor: 'pharmacy',
    submitted_at: '2026-11-21T10:00:00Z',
    handoff_at: null,
    decided_at: null,
    granted_refills: null,
    request_idempotency_key: null,
    version: 1,
  },
];

// Normalize a row of a table into an array of plain scalars (no raw SQLite
// row objects are deep-compared).
function rowScalars(db, table, id) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  assert.ok(row, `row ${table}.${id} is present`);
  return Object.values(row);
}

function assertSeedRowSet(db, table, expected, label) {
  // Stable counts, no duplicates: row count equals the expected set size and
  // no id repeats (the primary key guarantees the second half).
  const rows = rowsFor(db, table);
  assert.equal(
    rows.length,
    expected.length,
    `${label}: ${table} has exactly ${expected.length} stable rows`
  );
  assert.equal(
    new Set(rows.map((r) => r.id)).size,
    expected.length,
    `${label}: ${table} ids are duplicate-free`
  );
  // Saved values: each expected id maps to exactly the expected scalar row.
  for (const expectedRow of expected) {
    assert.deepEqual(
      rowScalars(db, table, expectedRow.id),
      Object.values(expectedRow),
      `${label}: ${table} row ${expectedRow.id} saved values`
    );
  }
}

test('seed: first seed on a fresh temporary SQLite file persists the exact deterministic fixture set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refill-relay-fixture-'));
  const dbPath = join(dir, 'fixture.sqlite');
  let db;
  try {
    db = initDatabase(dbPath);
    // Fresh file, clean and unseeded before the explicit seed operation.
    for (const table of ['identities', 'prescriptions', 'renewals']) {
      assert.equal(
        db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,
        0,
        `${table} is empty before the seed`
      );
    }

    const counts = seedSyntheticFixtures(dbPath);
    assert.deepEqual(
      counts,
      { identities: 8, prescriptions: 3, renewals: 2 },
      'stable post-seed counts: 8 identities, 3 prescriptions, 2 renewals'
    );

    assertSeedRowSet(db, 'identities', EXPECTED_IDENTITIES, 'first seed');
    assertSeedRowSet(
      db,
      'prescriptions',
      EXPECTED_PRESCRIPTIONS,
      'first seed'
    );
    assertSeedRowSet(db, 'renewals', EXPECTED_RENEWALS, 'first seed');

    // Distinct prescriptions and patient/prescriber identities for Ending A
    // and Ending B (both share the primary pharmacy Cedar Crossing).
    const endA = db
      .prepare(`SELECT * FROM prescriptions WHERE id = 'ending-a-rx'`)
      .get();
    const endB = db
      .prepare(`SELECT * FROM prescriptions WHERE id = 'ending-b-rx'`)
      .get();
    assert.equal(endA.patient_id, 'ending-a-patient');
    assert.equal(endB.patient_id, 'ending-b-patient');
    assert.notEqual(endA.patient_id, endB.patient_id, 'distinct patients');
    assert.notEqual(
      endA.prescriber_id,
      endB.prescriber_id,
      'distinct prescribers'
    );
    assert.equal(endA.pharmacy_id, endB.pharmacy_id, 'both endings at pharmacy-cedar');
    assert.equal(endB.refills_remaining, 0, "the Ending B prescription has zero refills remaining");

    // The seed persists no identity with a mixed or overlapping role:
    // distinct role sets, and patients are never prescriber identities.
    const roleSets = [
      new Set(
        db
          .prepare(`SELECT id FROM identities WHERE role = 'patient'`)
          .all()
          .map((r) => r.id)
      ),
      new Set(
        db
          .prepare(`SELECT id FROM identities WHERE role = 'prescriber'`)
          .all()
          .map((r) => r.id)
      ),
    ];
    for (const a of roleSets[0]) {
      assert.ok(!roleSets[1].has(a), `identity ${a} is not both patient and prescriber`);
    }
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('seed: second seed on the same file is duplicate-free and stable (counts and rows unchanged)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refill-relay-fixture-'));
  const dbPath = join(dir, 'fixture.sqlite');
  let db;
  try {
    db = initDatabase(dbPath);
    const first = seedSyntheticFixtures(dbPath);
    const second = seedSyntheticFixtures(dbPath);
    assert.deepEqual(
      second,
      first,
      're-seeding returns the identical stable counts'
    );
    assert.deepEqual(
      second,
      { identities: 8, prescriptions: 3, renewals: 2 },
      'stable counts after the second seed'
    );
    assertSeedRowSet(db, 'identities', EXPECTED_IDENTITIES, 'second seed');
    assertSeedRowSet(
      db,
      'prescriptions',
      EXPECTED_PRESCRIPTIONS,
      'second seed'
    );
    assertSeedRowSet(db, 'renewals', EXPECTED_RENEWALS, 'second seed');
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('seed: unrelated second pharmacy and unrelated denial identities are present and disjoint from Ending A and Ending B', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refill-relay-fixture-'));
  const dbPath = join(dir, 'fixture.sqlite');
  let db;
  try {
    db = initDatabase(dbPath);
    seedSyntheticFixtures(dbPath);

    // Unrelated second pharmacy, distinct from the primary pharmacy.
    const dunmore = db
      .prepare(`SELECT * FROM identities WHERE id = 'pharmacy-dunmore'`)
      .get();
    const cedar = db
      .prepare(`SELECT * FROM identities WHERE id = 'pharmacy-cedar'`)
      .get();
    assert.equal(dunmore.role, 'pharmacy');
    assert.equal(cedar.role, 'pharmacy');
    assert.notEqual(dunmore.display_name, cedar.display_name);

    // Unrelated synthetic identities and prescription for denial testing.
    const denial = db
      .prepare(`SELECT * FROM prescriptions WHERE id = 'denial-rx'`)
      .get();
    assert.equal(denial.patient_id, 'denial-patient');
    assert.equal(denial.prescriber_id, 'denial-prescriber');
    assert.equal(denial.pharmacy_id, 'pharmacy-dunmore');
    const endA = db
      .prepare(`SELECT * FROM prescriptions WHERE id = 'ending-a-rx'`)
      .get();
    const endB = db
      .prepare(`SELECT * FROM prescriptions WHERE id = 'ending-b-rx'`)
      .get();
    for (const other of [endA, endB]) {
      assert.notEqual(denial.patient_id, other.patient_id);
      assert.notEqual(denial.prescriber_id, other.prescriber_id);
      assert.notEqual(denial.pharmacy_id, other.pharmacy_id);
    }

    // No denial renewal row exists: denial testing gets identities only.
    assert.equal(
      db
        .prepare(`SELECT COUNT(*) AS n FROM renewals WHERE id = 'denial-renewal'`)
        .get().n,
      0,
      'no renewal row is seeded for the denial fixture'
    );
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('seed: saved renewal values respect the outcome/refill constraints and persist across close + reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refill-relay-fixture-'));
  const dbPath = join(dir, 'fixture.sqlite');
  let db;
  try {
    db = initDatabase(dbPath);
    seedSyntheticFixtures(dbPath);

    // Ending A: the approved terminal 'Renewal approved' — exactly one
    // granted refill, decided_at and handoff_at set, next_actor 'pharmacy'
    // persisted.
    const endA = db
      .prepare(`SELECT * FROM renewals WHERE id = 'ending-a-renewal'`)
      .get();
    assert.equal(endA.status, STATUS_LABELS.RENEWAL_APPROVED);
    assert.equal(
      endA.next_actor,
      'pharmacy',
      "approved terminal renewal persists next actor 'pharmacy'"
    );
    assert.equal(endA.submitted_at, '2026-11-21T08:00:00Z');
    assert.equal(endA.handoff_at, '2026-11-21T08:30:00Z');
    assert.equal(endA.decided_at, '2026-11-21T09:00:00Z');
    assert.equal(
      endA.granted_refills,
      1,
      'Renewal approved grants exactly one refill'
    );

    // Ending B: non-final 'Sent to pharmacy' — next actor pharmacy,
    // submitted_at set, and (per the accepted constraint) no decided_at or
    // granted_refills.
    const endB = db
      .prepare(`SELECT * FROM renewals WHERE id = 'ending-b-renewal'`)
      .get();
    assert.equal(endB.status, STATUS_LABELS.SENT_TO_PHARMACY);
    assert.equal(endB.next_actor, 'pharmacy', 'next actor persisted for Ending B');
    assert.equal(endB.submitted_at, '2026-11-21T10:00:00Z');
    assert.equal(endB.handoff_at, null);
    assert.equal(endB.decided_at, null, 'non-final renewal carries no decided_at');
    assert.equal(
      endB.granted_refills,
      null,
      'non-final renewal carries no granted_refills'
    );

    // Minimal saved renewal records: one 'Sent to pharmacy' and exactly one
    // terminal (here 'Renewal approved') renewal, nothing else — no
    // 'Visit required' record is seeded.
    assert.equal(
      db
        .prepare(`SELECT COUNT(*) AS n FROM renewals WHERE status = ?`)
        .get(STATUS_LABELS.SENT_TO_PHARMACY).n,
      1
    );
    assert.equal(
      db
        .prepare(`SELECT COUNT(*) AS n FROM renewals WHERE status = ?`)
        .get(STATUS_LABELS.RENEWAL_APPROVED).n,
      1
    );
    assert.equal(
      db
        .prepare(`SELECT COUNT(*) AS n FROM renewals WHERE status = ?`)
        .get(STATUS_LABELS.VISIT_REQUIRED).n,
      0,
      'no Visit required record is seeded'
    );

    // No workflow tables are seeded.
    for (const table of [
      'renewal_events',
      'pharmacy_conversation_messages',
      'office_messages',
      'phone_notes',
      'sessions',
      'synthetic_accounts',
    ]) {
      assert.equal(
        db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,
        0,
        `${table} must remain empty after the seed`
      );
    }

    // Second lifetime: close this connection and reopen a brand-new one
    // (simulated restart) before the finally cleanup; the same saved values
    // must re-read, and the workflow tables must still be empty.
    db.close();
    db = initDatabase(dbPath);
    assert.deepEqual(
      Object.values(rowsFor(db, 'renewals').find((r) => r.id === 'ending-a-renewal')),
      Object.values(EXPECTED_RENEWALS[0]),
      'Ending A renewal saved values after reopen'
    );
    assert.deepEqual(
      Object.values(rowsFor(db, 'renewals').find((r) => r.id === 'ending-b-renewal')),
      Object.values(EXPECTED_RENEWALS[1]),
      'Ending B renewal saved values after reopen'
    );
    for (const table of ['identities', 'prescriptions']) {
      assertSeedRowSet(
        db,
        table,
        table === 'identities'
          ? EXPECTED_IDENTITIES
          : EXPECTED_PRESCRIPTIONS,
        'reopen'
      );
    }
    for (const table of [
      'renewal_events',
      'pharmacy_conversation_messages',
      'office_messages',
      'phone_notes',
      'sessions',
      'synthetic_accounts',
    ]) {
      assert.equal(
        db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,
        0,
        `${table} must still be empty after reopen`
      );
    }
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('seed: a failed seed rolls back without losing the previous saved state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refill-relay-fixture-'));
  const dbPath = join(dir, 'fixture.sqlite');
  let db;
  try {
    db = initDatabase(dbPath);
    // Previous saved state: the accepted fixture set, committed and closed.
    seedSyntheticFixtures(dbPath);
    const before = {
      identities: db.prepare('SELECT COUNT(*) AS n FROM identities').get().n,
      prescriptions: db.prepare('SELECT COUNT(*) AS n FROM prescriptions').get().n,
      renewals: db.prepare('SELECT COUNT(*) AS n FROM renewals').get().n,
    };
    assert.deepEqual(before, { identities: 8, prescriptions: 3, renewals: 2 });

    // The failing seed first inserts one genuinely NEW valid fixture row
    // (an extra valid 'Sent to pharmacy' renewal for the unrelated denial
    // prescription — a new id, a free pending slot, and a new prescription
    // row), and THEN a second pending renewal for ending-b-rx, which
    // violates the accepted one-pending-renewal-per-prescription rule
    // (partial unique index refill_pending_per_prescription). Everything in
    // the failed transaction — including the genuinely new valid row — must
    // roll back.
    const failingFixtures = {
      ...SYNTHETIC_FIXTURES,
      prescriptions: [
        ...SYNTHETIC_FIXTURES.prescriptions,
        {
          id: 'denial-rx-2',
          patient_id: 'denial-patient',
          pharmacy_id: 'pharmacy-dunmore',
          prescriber_id: 'denial-prescriber',
          refills_remaining: 1,
        },
      ],
      renewals: [
        ...SYNTHETIC_FIXTURES.renewals,
        {
          // Genuinely new valid row, inserted before the failing one.
          id: 'denial-renewal',
          prescription_id: 'denial-rx-2',
          patient_id: 'denial-patient',
          pharmacy_id: 'pharmacy-dunmore',
          prescriber_id: 'denial-prescriber',
          status: STATUS_LABELS.SENT_TO_PHARMACY,
          next_actor: 'pharmacy',
          submitted_at: '2026-11-21T11:00:00Z',
          handoff_at: null,
          decided_at: null,
          granted_refills: null,
        },
        {
          // Second pending renewal on ending-b-rx: violates the accepted
          // one-pending-renewal-per-prescription rule.
          id: 'ending-b-renewal-2',
          prescription_id: 'ending-b-rx',
          patient_id: 'ending-b-patient',
          pharmacy_id: 'pharmacy-cedar',
          prescriber_id: 'ending-b-prescriber',
          status: STATUS_LABELS.SENT_TO_PHARMACY,
          next_actor: 'pharmacy',
          submitted_at: '2026-11-21T12:00:00Z',
          handoff_at: null,
          decided_at: null,
          granted_refills: null,
        },
      ],
    };
    assert.throws(
      () => seedSyntheticFixtures(dbPath, failingFixtures),
      (err) => {
        expectUniqueConstraintError(err, 'renewals (prescription_id)');
        return true;
      }
    );

    // The failed seed left NO partial rows: the genuinely new valid row is
    // rolled back too.
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS n FROM prescriptions WHERE id = 'denial-rx-2'`).get().n,
      0,
      'failed seed rolled back the genuinely new prescription row'
    );
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS n FROM renewals WHERE id = 'denial-renewal'`).get().n,
      0,
      'failed seed rolled back the genuinely new renewal row'
    );
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS n FROM renewals WHERE id = 'ending-b-renewal-2'`).get().n,
      0,
      'failed seed left no failing renewal row'
    );

    // The previous saved state is intact: stable counts and every saved row
    // unchanged.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM identities').get().n, before.identities);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM prescriptions').get().n, before.prescriptions);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM renewals').get().n, before.renewals);
    assertSeedRowSet(db, 'identities', EXPECTED_IDENTITIES, 'after rollback');
    assertSeedRowSet(
      db,
      'prescriptions',
      EXPECTED_PRESCRIPTIONS,
      'after rollback'
    );
    assertSeedRowSet(db, 'renewals', EXPECTED_RENEWALS, 'after rollback');

    // The connection stays usable, and re-seeding the accepted set still
    // converges to the same stable state.
    const again = seedSyntheticFixtures(dbPath);
    assert.deepEqual(again, { identities: 8, prescriptions: 3, renewals: 2 });
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});


test('runtime supports node:sqlite', () => {
  // Reaching here means the built-in `node:sqlite` module (and store.mjs's
  // import of it) resolved for this runtime.
  assert.equal(typeof DatabaseSync, 'function', 'DatabaseSync constructor available');
  console.log(`observed runtime: node ${process.version}; node:sqlite available`);
});

test('committed synthetic marker survives close and reopen', () => {
  // Uniquely named temporary database directory under os.tmpdir(); removed
  // in finally so no shared fixed /tmp database is used or left behind,
  // even when the test fails.
  const dir = mkdtempSync(join(tmpdir(), 'refill-relay-fixture-'));
  const dbPath = join(dir, 'fixture.sqlite');
  try {
    const marker = `fixture-marker-${process.pid}-${Date.now()}`;

    // First lifetime: writeMarker commits the marker and closes the db.
    writeMarker(dbPath, marker);

    // Second lifetime: readMarker opens a fresh connection (simulated restart).
    assert.equal(readMarker(dbPath), marker);

    // Third lifetime: overwrite and read again to prove upsert durability.
    const again = `${marker}-again`;
    writeMarker(dbPath, again);
    assert.equal(readMarker(dbPath), again);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


function assertCookieContract(cookie, label) {
  assert.ok(cookie, `${label}: a cookie must be present`);
  assert.equal(cookie.name, SESSION_COOKIE_NAME, `${label}: cookie name`);
  assert.match(
    cookie.value,
    /^[0-9a-f]{64}$/,
    `${label}: the session cookie value is an opaque token`
  );
  for (const attribute of ['HttpOnly', 'SameSite=Lax']) {
    assert.ok(
      cookie.attributes.includes(attribute),
      `${label}: cookie attributes include ${attribute} (actual: ${cookie.attributes.join(', ')})`
    );
  }
  assert.ok(
    cookie.header.includes('HttpOnly') && cookie.header.includes('SameSite=Lax'),
    `${label}: Set-Cookie style header carries HttpOnly and SameSite=Lax`
  );
}

function captureBeforeState(db) {
  // Scalar-only snapshot of the previously saved state, used to compare
  // against a fresh re-read after the failed session commit. Rows are
  // mapped to arrays of normalized scalar values (never raw SQLite rows).
  const snapshot = (table, orderExpr) =>
    db
      .prepare(`SELECT * FROM ${table} ORDER BY ${orderExpr}`)
      .all()
      .map((r) => Object.values(r));
  return {
    identities: snapshot('identities', 'id'),
    prescriptions: snapshot('prescriptions', 'id'),
    renewals: snapshot('renewals', 'id'),
    sessions: snapshot('sessions', 'token'),
    synthetic_accounts: snapshot('synthetic_accounts', 'username'),
  };
}

function assertStateUnchanged(db, before) {
  const snapshot = (table, orderExpr) =>
    db
      .prepare(`SELECT * FROM ${table} ORDER BY ${orderExpr}`)
      .all()
      .map((r) => Object.values(r));
  assert.deepEqual(
    snapshot('identities', 'id'),
    before.identities,
    'saved identities unchanged'
  );
  assert.deepEqual(
    snapshot('prescriptions', 'id'),
    before.prescriptions,
    'saved prescriptions unchanged'
  );
  assert.deepEqual(
    snapshot('renewals', 'id'),
    before.renewals,
    'saved renewals unchanged'
  );
  assert.deepEqual(
    snapshot('sessions', 'token'),
    before.sessions,
    'saved sessions unchanged'
  );
  assert.deepEqual(
    snapshot('synthetic_accounts', 'username'),
    before.synthetic_accounts,
    'saved synthetic accounts unchanged'
  );
}

test('sign-in: all three synthetic roles sign in via handleAppRequest with actual cookie attributes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refill-relay-fixture-'));
  const dbPath = join(dir, 'fixture.sqlite');
  let db;
  try {
    db = initDatabase(dbPath);
    seedSyntheticFixtures(dbPath);

    // Local fictional accounts: one per seeded identity, three roles.
    const accounts = seedSyntheticAccounts(dbPath);
    assert.equal(accounts.accounts, SYNTHETIC_ACCOUNTS.length, 'one local synthetic account per seeded identity');

    // The seed persists salt + salted hash only — the plaintext password is
    // never written to disk in any persisted row.
    for (const account of SYNTHETIC_ACCOUNTS) {
      const row = db
        .prepare(`SELECT username, identity_id, password_salt, password_hash FROM synthetic_accounts WHERE username = ?`)
        .get(account.username);
      assert.ok(row, `account row for ${account.username} is persisted`);
      assert.equal(row.identity_id, account.identity_id, 'account maps to the seeded identity');
      assert.match(row.password_salt, /^rfrl-demo-salt-/);
      assert.match(row.password_hash, /^[0-9a-f]{64}$/, 'salted iterated-SHA-256 hash as hex');
      const persisted = JSON.stringify(row);
      assert.ok(
        !persisted.includes(account.password),
        `plaintext password for ${account.username} is never persisted`
      );
    }

    // Role establishment + actual cookie attributes, through the same
    // in-process application handler callers use.
    const roleSignIns = [
      ['ava.mercer', 'ending-a-patient', 'patient', 'patient-ava-2026'],
      ['dr.naomi.okafor', 'ending-a-prescriber', 'prescriber', 'prescriber-naomi-2026'],
      ['pharmacy.cedar', 'pharmacy-cedar', 'pharmacy', 'pharmacy-cedar-2026'],
    ];
    const cookies = new Map();
    for (const [username, identityId, role, password] of roleSignIns) {
      const res = handleAppRequest(dbPath, { route: 'sign-in', username, password });
      assert.equal(res.status, 200, `${username}: sign-in status`);
      assert.equal(res.body.ok, true, `${username}: sign-in ok`);
      assert.equal(res.body.identity.id, identityId, `${username}: identity from the stored identity`);
      assert.equal(res.body.identity.role, role, `${username}: role established from the stored identity`);
      assert.equal(res.body.cookie, SESSION_COOKIE_NAME, `${username}: response names the session cookie`);
      assertCookieContract(res.cookie, `${username}`);
      assert.notEqual(res.cookie.value, '', `${username}: non-empty opaque cookie value`);
      cookies.set(username, res.cookie.value);
    }

    // Every successful sign-in committed exactly one server-side session row.
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n,
      3,
      'one committed session row per successful sign-in'
    );

    // The authenticated session lookup, through the same handler, resolves
    // each role's cookie to its stored identity and role.
    for (const [username, identityId, role] of roleSignIns) {
      const session = handleAppRequest(dbPath, { route: 'session', cookie: cookies.get(username) });
      assert.equal(session.status, 200, `${username}: session lookup status`);
      assert.equal(session.body.ok, true, `${username}: session lookup ok`);
      assert.equal(session.identity.id, identityId);
      assert.equal(session.identity.role, role, `${username}: role re-derived from the stored identity`);
    }
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sign-in: invalid credentials (wrong password and unknown username) yield a clear error, no cookie, no session row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refill-relay-fixture-'));
  const dbPath = join(dir, 'fixture.sqlite');
  let db;
  try {
    db = initDatabase(dbPath);
    seedSyntheticFixtures(dbPath);
    seedSyntheticAccounts(dbPath);

    // Wrong password: clear invalid-credential feedback, no session cookie,
    // no server-side session row.
    const wrongPassword = handleAppRequest(
      dbPath,
      { route: 'sign-in', username: 'ava.mercer', password: 'not-the-password' }
    );
    assert.equal(wrongPassword.status, 401, 'wrong password status');
    assert.equal(wrongPassword.body.ok, false);
    assert.equal(wrongPassword.body.error, 'invalid-credentials');
    assert.match(wrongPassword.body.message, /sign-in failed/i, 'clear invalid-credential message');
    assert.equal(wrongPassword.cookie, null, 'no cookie on invalid credentials');
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n,
      0,
      'no session row is created for invalid credentials'
    );

    // Unknown username: same clear, recoverable invalid-credential feedback.
    const unknownUser = handleAppRequest(
      dbPath,
      { route: 'sign-in', username: 'mallory', password: 'whatever' }
    );
    assert.equal(unknownUser.status, 401, 'unknown username status');
    assert.equal(unknownUser.body.error, 'invalid-credentials');
    assert.equal(unknownUser.cookie, null, 'no cookie for an unknown username');
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n,
      0,
      'still no session rows after the failed sign-ins'
    );

    // The failure is recoverable: the same username signs in fine next.
    const retry = handleAppRequest(
      dbPath,
      { route: 'sign-in', username: 'ava.mercer', password: 'patient-ava-2026' }
    );
    assert.equal(retry.status, 200, 'valid sign-in after invalid attempts');
    assert.equal(retry.body.ok, true);
    assert.ok(retry.cookie, 'retry issues a session cookie');
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sessions: committed session persists after close + reopen and is re-readable via the handler', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refill-relay-fixture-'));
  const dbPath = join(dir, 'fixture.sqlite');
  let db;
  try {
    db = initDatabase(dbPath);
    seedSyntheticFixtures(dbPath);
    seedSyntheticAccounts(dbPath);

    // First lifetime: signIn commits the server-side session and issues the
    // cookie; the row is committed and the connection closes.
    const res = signIn(dbPath, 'pharmacy.dunmore', 'pharmacy-dunmore-2026');
    assert.equal(res.status, 200);
    const token = res.cookie.value;
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n,
      1,
      'exactly one committed session row after sign-in'
    );
    const saved = db.prepare(`SELECT * FROM sessions WHERE token = ?`).get(token);
    assert.equal(saved.identity_id, 'pharmacy-dunmore', 'session row is bound to the stored identity');
    assert.match(saved.created_at, /^\d{4}-\d{2}-\d{2}T/, 'created_at persisted');
    assert.match(saved.expires_at, /^\d{4}-\d{2}-\d{2}T/, 'expires_at persisted');
    db.close();

    // Second lifetime: a brand-new connection (simulated restart) reads the
    // same committed row back, and the handler resolves the same cookie.
    db = initDatabase(dbPath);
    const reopened = db.prepare(`SELECT * FROM sessions WHERE token = ?`).get(token);
    assert.ok(reopened, 'session row still present after reopen');
    assert.equal(reopened.identity_id, 'pharmacy-dunmore');
    assert.equal(reopened.expires_at, saved.expires_at, 'saved values unchanged after reopen');

    const session = handleAppRequest(dbPath, { route: 'session', cookie: token });
    assert.equal(session.status, 200, 'session lookup after reopen');
    assert.equal(session.body.ok, true);
    assert.equal(session.identity.id, 'pharmacy-dunmore');
    assert.equal(session.identity.role, 'pharmacy', 'role re-derived from the stored identity after reopen');
    assert.equal(session.identity.display_name, 'Dunmore Corner Pharmacy');

    // Unknown and absent cookies get clear no-session feedback.
    const unknown = handleAppRequest(dbPath, { route: 'session', cookie: 'no-such-token' });
    assert.equal(unknown.status, 401, 'unknown cookie status');
    assert.equal(unknown.body.error, 'no-session');
    assert.equal(unknown.body.ok, false);
    assert.equal(unknown.identity, null, 'no identity for an unknown cookie');

    const absent = handleAppRequest(dbPath, { route: 'session' });
    assert.equal(absent.status, 401, 'missing cookie status');
    assert.equal(absent.body.error, 'no-session');
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sign-out: invalidates the server-side session and the cookie stops resolving (idempotent)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refill-relay-fixture-'));
  const dbPath = join(dir, 'fixture.sqlite');
  let db;
  try {
    db = initDatabase(dbPath);
    seedSyntheticFixtures(dbPath);
    seedSyntheticAccounts(dbPath);

    // Unchanged previous saved state: the marker and fixture rows, plus the
    // second committed session whose invalidation must not be touched.
    writeMarker(dbPath, 'fixture-marker-before-signout');
    const other = signIn(dbPath, 'cleo.voss', 'patient-cleo-2026');
    assert.equal(other.status, 200);
    const endA = db
      .prepare(`SELECT status, granted_refills, decided_at FROM renewals WHERE id = 'ending-a-renewal'`)
      .get();
    const markerBefore = readMarker(dbPath);

    const first = signIn(dbPath, 'boris.laine', 'patient-boris-2026');
    assert.equal(first.status, 200);
    const token = first.cookie.value;
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n,
      2,
      'two committed sessions before sign-out'
    );

    const out = handleAppRequest(dbPath, { route: 'sign-out', cookie: token });
    assert.equal(out.status, 200, 'sign-out status');
    assert.equal(out.body.ok, true);
    assert.equal(out.body.invalidated, true, 'the server-side session was invalidated');
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE token = ?`).get(token).n,
      0,
      'the invalidated session row is gone from the sessions table'
    );

    // The invalidated cookie no longer resolves.
    const after = handleAppRequest(dbPath, { route: 'session', cookie: token });
    assert.equal(after.status, 401);
    assert.equal(after.body.error, 'no-session');
    assert.equal(after.identity, null);

    // Sign-out is idempotent for an already-invalidated token.
    const again = handleAppRequest(dbPath, { route: 'sign-out', cookie: token });
    assert.equal(again.status, 200);
    assert.equal(again.body.invalidated, false, 'second sign-out reports nothing to invalidate');

    // Everything previously saved is unchanged: the other session still
    // resolves, the marker survives, and the fixture row is intact.
    const otherSession = handleAppRequest(dbPath, { route: 'session', cookie: other.cookie.value });
    assert.equal(otherSession.status, 200, 'the other session is unaffected by sign-out');
    assert.equal(otherSession.identity.id, 'denial-patient');
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n,
      1,
      'exactly the unaffected session remains'
    );
    assert.equal(readMarker(dbPath), markerBefore, 'marker unchanged by sign-out');
    assert.deepEqual(
      { status: endA.status, granted_refills: endA.granted_refills, decided_at: endA.decided_at },
      {
        status: STATUS_LABELS.RENEWAL_APPROVED,
        granted_refills: 1,
        decided_at: '2026-11-21T09:00:00Z',
      },
      'fixture row unchanged by sign-out'
    );
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sign-in: injected session-persistence failure after INSERT before COMMIT is recoverable — attempted session row absent, no cookie, re-read state matches before-state, next sign-in succeeds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refill-relay-fixture-'));
  const dbPath = join(dir, 'fixture.sqlite');
  let db;
  try {
    db = initDatabase(dbPath);
    seedSyntheticFixtures(dbPath);
    seedSyntheticAccounts(dbPath);

    // Unchanged previous saved state: two committed sessions, the marker,
    // and the fixture rows.
    const existingA = signIn(dbPath, 'dr.emil.hart', 'prescriber-emil-2026');
    assert.equal(existingA.status, 200, 'first previous committed session');
    const existingB = signIn(dbPath, 'pharmacy.dunmore', 'pharmacy-dunmore-2026');
    assert.equal(existingB.status, 200, 'second previous committed session');
    const markerBefore = 'fixture-marker-before-save-fail';
    writeMarker(dbPath, markerBefore);

    // Capture the full before-state (scalar snapshots of every data table,
    // including the two committed sessions) for comparison after the
    // failed operation.
    const before = captureBeforeState(db);
    assert.equal(before.sessions.length, 2, 'two committed sessions captured in the before-state');
    assert.equal(before.renewals.length, 2, 'both fixture renewals captured in the before-state');

    // Inject the failure AFTER the session INSERT and BEFORE the COMMIT:
    // the credential verifies, the real INSERT of the attempted session row
    // runs, then the transaction fails and rolls back.
    const failed = handleAppRequest(
      dbPath,
      { route: 'sign-in', username: 'dr.priya.raman', password: 'prescriber-priya-2026' },
      { failSessionCommit: true }
    );
    assert.equal(failed.status, 503, 'recoverable save-error status');
    assert.equal(failed.body.ok, false);
    assert.equal(failed.body.error, 'session-save-failed');
    assert.equal(failed.body.recoverable, true, 'response is explicitly recoverable');
    assert.match(failed.body.message, /could not be saved/i, 'clear save-error feedback');
    assert.equal(failed.cookie, null, 'no success cookie when the session save fails');

    // Reread the database after the failed operation: the attempted session
    // row is absent — no partial session for the failed sign-in, and the
    // session table holds exactly the previously committed rows.
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n,
      2,
      'no partial session row from the failed commit'
    );
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE identity_id = 'ending-b-prescriber'`).get().n,
      0,
      'the attempted session row is absent for the failed sign-in'
    );
    assert.equal(
      db.prepare(`SELECT identity_id FROM sessions WHERE token = ?`).get(existingA.cookie.value).identity_id,
      'denial-prescriber',
      'previously committed session A is unchanged'
    );
    assert.equal(
      db.prepare(`SELECT identity_id FROM sessions WHERE token = ?`).get(existingB.cookie.value).identity_id,
      'pharmacy-dunmore',
      'previously committed session B is unchanged'
    );

    assert.equal(readMarker(dbPath), markerBefore, 'marker unchanged by the failed commit');

    // Full cross-connection reread (simulated restart): previously saved
    // sessions and fixture data match the captured before-state exactly.
    db.close();
    db = initDatabase(dbPath);
    assertStateUnchanged(db, before);
    const reopenedExistingA = handleAppRequest(dbPath, { route: 'session', cookie: existingA.cookie.value });
    assert.equal(reopenedExistingA.status, 200, 'previous session A still resolves after reopen');
    assert.equal(reopenedExistingA.identity.id, 'denial-prescriber');
    const reopenedExistingB = handleAppRequest(dbPath, { route: 'session', cookie: existingB.cookie.value });
    assert.equal(reopenedExistingB.status, 200, 'previous session B still resolves after reopen');
    assert.equal(reopenedExistingB.identity.id, 'pharmacy-dunmore');

    // The failure is recoverable: the very next sign-in for the same
    // username commits and issues a working cookie.
    const retry = handleAppRequest(
      dbPath,
      { route: 'sign-in', username: 'dr.priya.raman', password: 'prescriber-priya-2026' }
    );
    assert.equal(retry.status, 200, 'next sign-in succeeds after the recoverable failure');
    assert.equal(retry.body.identity.role, 'prescriber');
    assertCookieContract(retry.cookie, 'recovered sign-in');
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n,
      3,
      'the recovered sign-in committed exactly one new session row'
    );
    const recoveredSession = handleAppRequest(dbPath, { route: 'session', cookie: retry.cookie.value });
    assert.equal(recoveredSession.status, 200);
    assert.equal(recoveredSession.identity.id, 'ending-b-prescriber');
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
