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
  handoffRenewalToPrescriber,
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


// --- pharmacy handoff store transaction ------------------------------------

// The assigned responsible pharmacy for the fixture handoff cases.
const HANDOFF_PHARMACY = Object.freeze({ id: 'pharmacy-cedar', role: 'pharmacy' });

// Fresh handoff target: a synthetic zero-refill 'Sent to pharmacy' renewal
// for the seeded Ending B identities — the exact RFRLM-FR-001 pre-handoff
// shape, on ids the fixture set does not use, so the fixture rehearsal
// case is never mutated by the handoff tests.
const HANDOFF_TARGET = Object.freeze({
  rx: 'handoff-rx',
  rn: 'handoff-rn',
  patient: 'ending-b-patient',
  pharmacy: 'pharmacy-cedar',
  prescriber: 'ending-b-prescriber',
});

function seedHandoffTarget(dbPath, { prescriptionId = HANDOFF_TARGET.rx, renewalId = HANDOFF_TARGET.rn } = {}) {
  const db = initDatabase(dbPath);
  try {
    db.prepare(
      `INSERT INTO prescriptions (id, patient_id, pharmacy_id, prescriber_id, refills_remaining, is_synthetic)
       VALUES (?, ?, ?, ?, 0, 1)`
    ).run(prescriptionId, HANDOFF_TARGET.patient, HANDOFF_TARGET.pharmacy, HANDOFF_TARGET.prescriber);
    db.prepare(
      `INSERT INTO renewals
         (id, prescription_id, patient_id, pharmacy_id, prescriber_id,
          status, next_actor, submitted_at, handoff_at, decided_at,
          granted_refills, request_idempotency_key, version)
       VALUES (?, ?, ?, ?, ?, ?, 'pharmacy', '2026-11-21T12:00:00Z', NULL, NULL, NULL, NULL, 1)`
    ).run(
      renewalId,
      prescriptionId,
      HANDOFF_TARGET.patient,
      HANDOFF_TARGET.pharmacy,
      HANDOFF_TARGET.prescriber,
      STATUS_LABELS.SENT_TO_PHARMACY
    );
  } finally {
    db.close();
  }
}

// Scalar-only snapshot of every data table (normalized to arrays of scalar
// values, never raw SQLite rows) for before/after durable-state equality —
// the patient-request store test's fullTableState convention.
function handoffTableState(dbPath) {
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

function assertHandoffStateUnchanged(after, before, label) {
  for (const table of Object.keys(before)) {
    assert.deepEqual(
      after[table],
      before[table],
      `${label}: table ${table} unchanged`
    );
  }
}

// The plan's exact fixed denial: the full outcome is this object and
// nothing else — no status detail, no case field, no error text, no lock
// counter. Every handoff denial must be deepEqual to it.
const handoffDenial = { ok: false, code: 'not-authorized' };

test('handoff: first handoff durably transitions the same renewal once, sets next actor + handoff time + version, records exactly one handoff event, and changes nothing else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refill-relay-fixture-'));
  const dbPath = join(dir, 'fixture.sqlite');
  let db;
  try {
    db = initDatabase(dbPath);
    seedSyntheticFixtures(dbPath);
    seedSyntheticAccounts(dbPath);
    seedHandoffTarget(dbPath);

    const before = handoffTableState(dbPath);
    assert.equal(
      db.prepare(`SELECT version FROM renewals WHERE id = ?`).get(HANDOFF_TARGET.rn).version,
      1,
      'precondition: fresh case at version 1'
    );
    assert.equal(
      db.prepare(`SELECT handoff_at FROM renewals WHERE id = ?`).get(HANDOFF_TARGET.rn).handoff_at,
      null,
      'precondition: no handoff time before the first handoff'
    );

    // The authorized first handoff, by the assigned responsible pharmacy.
    const res = handoffRenewalToPrescriber(dbPath, HANDOFF_PHARMACY, HANDOFF_TARGET.rn);
    assert.equal(res.ok, true, 'first handoff succeeds');
    assert.equal(res.code, 'handed-off', 'first handoff outcome code');
    assert.equal(res.handed_off, true, 'outcome marks the case handed off');
    assert.equal(res.renewal.id, HANDOFF_TARGET.rn, 'the SAME renewal row is returned');
    assert.equal(res.renewal.status, STATUS_LABELS.AWAITING_PRESCRIBER);
    assert.equal(res.renewal.next_actor, 'prescriber', 'next actor is the prescriber role');
    assert.ok(res.renewal.handoff_at, 'handoff_at present');
    assert.match(res.renewal.handoff_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'handoff_at is a UTC ISO-8601 timestamp');
    assert.equal(res.renewal.version, 2, 'version bumped by exactly one');
    assert.equal(res.renewal.pharmacy_id, HANDOFF_TARGET.pharmacy, 'pharmacy assignment unchanged');
    assert.equal(res.renewal.prescriber_id, HANDOFF_TARGET.prescriber, 'prescriber assignment unchanged');
    assert.equal(res.renewal.decided_at, null, 'no decision fields are written by a handoff');
    assert.equal(res.renewal.granted_refills, null);

    // Durability re-read on a fresh connection (the handoff's own
    // connection is closed): exactly one transition and one event.
    const check = initDatabase(dbPath);
    try {
      const row = check.prepare(`SELECT * FROM renewals WHERE id = ?`).get(HANDOFF_TARGET.rn);
      assert.equal(row.status, STATUS_LABELS.AWAITING_PRESCRIBER, 'durable status is Awaiting prescriber');
      assert.equal(row.next_actor, 'prescriber', 'durable next actor is the prescriber role');
      assert.equal(row.handoff_at, res.renewal.handoff_at, 'durable handoff_at matches the response');
      assert.ok(!Number.isNaN(Date.parse(row.handoff_at)), 'durable handoff_at is ISO-8601');
      assert.equal(row.version, 2, 'durable version is exactly +1 (1 -> 2)');
      assert.equal(row.pharmacy_id, HANDOFF_TARGET.pharmacy, 'pharmacy assignment unchanged durably');
      assert.equal(row.prescriber_id, HANDOFF_TARGET.prescriber, 'prescriber assignment unchanged durably');
      assert.equal(row.submitted_at, '2026-11-21T12:00:00Z', 'original submitted_at preserved');
      assert.equal(row.decided_at, null, 'no decided_at written');
      assert.equal(row.granted_refills, null, 'no granted_refills written');

      const events = check
        .prepare(`SELECT * FROM renewal_events WHERE renewal_id = ? ORDER BY id`)
        .all(HANDOFF_TARGET.rn);
      assert.equal(events.length, 1, 'exactly one handoff event, none other');
      assert.equal(events[0].event_type, EVENT_TYPES.HANDOFF, 'event type is handoff');
      assert.equal(events[0].occurred_at, row.handoff_at, 'event time is the handoff time');
      assert.equal(events[0].actor_role, 'pharmacy', 'event actor role is the acting pharmacy role');
      assert.equal(events[0].actor_id, HANDOFF_PHARMACY.id, 'event actor is the acting pharmacy identity');

      // Nothing else changed: the prescription's zero-refill condition,
      // every workflow table, and every other row are byte-identical to
      // the before-state (the only renewal-row delta is this one update).
      const after = handoffTableState(dbPath);
      assert.equal(
        after.prescriptions.find((r) => r[0] === HANDOFF_TARGET.rx)[4],
        0,
        'refills_remaining is untouched (still zero)'
      );
      assert.equal(after.renewals.length, before.renewals.length, 'no new renewal row');
      assert.equal(
        after.renewal_events.length,
        before.renewal_events.length + 1,
        'renewal_events grew by exactly one row'
      );
      for (const table of [
        'markers', 'identities', 'pharmacy_conversation_messages',
        'office_messages', 'phone_notes', 'sessions', 'synthetic_accounts',
      ]) {
        assert.deepEqual(after[table], before[table], `${table} unchanged`);
      }
      // The single renewal-row delta is exactly the handoff update itself.
      const otherRenewals = after.renewals.filter((r) => r[0] !== HANDOFF_TARGET.rn);
      assert.deepEqual(otherRenewals, before.renewals.filter((r) => r[0] !== HANDOFF_TARGET.rn), 'all other renewal rows unchanged');
      const [handedOffScalars] = after.renewals.filter((r) => r[0] === HANDOFF_TARGET.rn);
      const [beforeTarget] = before.renewals.filter((r) => r[0] === HANDOFF_TARGET.rn);
      const expected = [...beforeTarget];
      const cols = ['id', 'prescription_id', 'patient_id', 'pharmacy_id', 'prescriber_id', 'status', 'next_actor', 'submitted_at', 'handoff_at', 'decided_at', 'granted_refills', 'request_idempotency_key', 'version'];
      expected[cols.indexOf('status')] = STATUS_LABELS.AWAITING_PRESCRIBER;
      expected[cols.indexOf('next_actor')] = 'prescriber';
      expected[cols.indexOf('handoff_at')] = row.handoff_at;
      expected[cols.indexOf('version')] = 2;
      assert.deepEqual(handedOffScalars, expected, 'the single renewal-row delta is exactly the handoff update');
    } finally {
      check.close();
    }
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handoff: replay is idempotent — same case state, original handoff time, still exactly one event, zero new rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refill-relay-fixture-'));
  const dbPath = join(dir, 'fixture.sqlite');
  try {
    initDatabase(dbPath);
    seedSyntheticFixtures(dbPath);
    seedHandoffTarget(dbPath);

    // The committed first handoff, then a sequential replay (the story's
    // retry-after-success case).
    const first = handoffRenewalToPrescriber(dbPath, HANDOFF_PHARMACY, HANDOFF_TARGET.rn);
    assert.equal(first.ok, true, 'first handoff succeeds');
    assert.equal(first.code, 'handed-off');

    const afterFirst = handoffTableState(dbPath);
    const replay = handoffRenewalToPrescriber(dbPath, HANDOFF_PHARMACY, HANDOFF_TARGET.rn);
    // Full-outcome check: the replay is exactly the idempotent shape —
    // the same saved renewal (original handoff time, no second version
    // increment), no second event, no extra fields.
    assert.deepEqual(
      replay,
      {
        ok: true,
        code: 'already-handed-off',
        handed_off: true,
        renewal: first.renewal,
        lockRetries: 0,
      },
      'replay returns the full idempotent outcome with the saved renewal unchanged'
    );
    assert.equal(replay.renewal.handoff_at, first.renewal.handoff_at, 'original first valid handoff timestamp preserved');
    assert.equal(replay.renewal.version, first.renewal.version, 'no second version increment');

    // Durability: the replay added nothing — no second event, no row
    // delta of any kind, and the original handoff time is intact.
    const afterReplay = handoffTableState(dbPath);
    assert.deepEqual(afterReplay, afterFirst, 'replay left every table byte-identical');
    const check = initDatabase(dbPath);
    try {
      assert.equal(
        check
          .prepare(`SELECT COUNT(*) AS n FROM renewal_events WHERE renewal_id = ? AND event_type = ?`)
          .get(HANDOFF_TARGET.rn, EVENT_TYPES.HANDOFF).n,
        1,
        'still exactly one handoff event after the replay'
      );
      const row = check.prepare(`SELECT handoff_at, version FROM renewals WHERE id = ?`).get(HANDOFF_TARGET.rn);
      assert.equal(row.handoff_at, first.renewal.handoff_at, 'durable original handoff_at preserved');
      assert.equal(row.version, 2, 'durable version still exactly 2');
    } finally {
      check.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handoff denials: non-pharmacy roles, missing id, unknown id, unrelated pharmacy, lost ownership, and unassigned prescriber all return the exact fixed not-authorized denial, disclose no case data, and leave the rejected cases unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refill-relay-fixture-'));
  const dbPath = join(dir, 'fixture.sqlite');
  try {
    initDatabase(dbPath);
    seedSyntheticFixtures(dbPath);
    seedSyntheticAccounts(dbPath);
    seedHandoffTarget(dbPath);

    const before = handoffTableState(dbPath);
    const sessionsBefore = before.sessions.length;

    const denials = [
      ['prescriber role', HANDOFF_TARGET.rn, { id: HANDOFF_TARGET.prescriber, role: 'prescriber' }],
      ['patient role', HANDOFF_TARGET.rn, { id: HANDOFF_TARGET.patient, role: 'patient' }],
      ['unknown role', HANDOFF_TARGET.rn, { id: HANDOFF_TARGET.pharmacy, role: 'clinic' }],
      ['missing id', HANDOFF_TARGET.rn, { id: '', role: 'pharmacy' }],
      ['null identity', HANDOFF_TARGET.rn, null],
      ['unknown renewal id', 'no-such-renewal', { id: HANDOFF_TARGET.pharmacy, role: 'pharmacy' }],
      ['unrelated pharmacy', HANDOFF_TARGET.rn, { id: 'pharmacy-dunmore', role: 'pharmacy' }],
    ];

    for (const [label, renewalId, identity] of denials) {
      const res = handoffRenewalToPrescriber(dbPath, identity, renewalId);
      // Full-outcome check: the denial is exactly the plan's fixed shape —
      // no case field (status, time, id, or assignment), no status detail,
      // no lock counter.
      assert.deepEqual(res, handoffDenial, `${label}: exact fixed not-authorized denial`);
    }

    // An unknown id and an unrelated id are byte-identical: no existence
    // or assignment disclosure (same discipline as getRoleCase).
    const unknown = handoffRenewalToPrescriber(dbPath, HANDOFF_PHARMACY, 'no-such-renewal');
    const unrelated = handoffRenewalToPrescriber(dbPath, { id: 'pharmacy-dunmore', role: 'pharmacy' }, HANDOFF_TARGET.rn);
    assert.deepEqual(unknown, unrelated, 'unknown and unrelated denials are byte-identical');

    // The pre-lock denials wrote nothing: full durable state on a fresh
    // connection is byte-identical.
    const afterPreLock = handoffTableState(dbPath);
    assertHandoffStateUnchanged(afterPreLock, before, 'pre-lock denials');
    assert.equal(afterPreLock.sessions.length, sessionsBefore, 'sessions count unchanged');
    assert.equal(afterPreLock.renewal_events.length, 0, 'no events from the pre-lock denials');

    // Under-lock ineligibility: the pre-lock check passes (the row exists
    // and was assigned to the acting pharmacy), but the freshly locked row
    // must still be verified — the acting pharmacy still owns the case and
    // a prescriber is still assigned — before either returning a replay or
    // making the transition.
    const mutate = initDatabase(dbPath);
    try {
      mutate
        .prepare(`UPDATE renewals SET pharmacy_id = ? WHERE id = ?`)
        .run('pharmacy-dunmore', HANDOFF_TARGET.rn);
    } finally {
      mutate.close();
    }
    const lostOwnership = handoffRenewalToPrescriber(dbPath, HANDOFF_PHARMACY, HANDOFF_TARGET.rn);
    assert.deepEqual(lostOwnership, handoffDenial, 'lost ownership under the lock: exact fixed denial');

    const mutate2 = initDatabase(dbPath);
    try {
      mutate2
        .prepare(`UPDATE renewals SET prescriber_id = '' WHERE id = ?`)
        .run(HANDOFF_TARGET.rn);
    } finally {
      mutate2.close();
    }
    // State after the test's own two ineligibility mutations: the
    // rejected attempts must leave this byte-identical.
    const afterMutations = handoffTableState(dbPath);
    const unassigned = handoffRenewalToPrescriber(dbPath, HANDOFF_PHARMACY, HANDOFF_TARGET.rn);
    assert.deepEqual(unassigned, handoffDenial, 'unassigned prescriber under the lock: exact fixed denial');

    // The rejected cases are unchanged by the rejected attempts: on a
    // fresh connection, every table is byte-identical to the state just
    // after the two ineligibility mutations the test itself made — no
    // status transition, no handoff time, no version bump, no event.
    const after = handoffTableState(dbPath);
    assertHandoffStateUnchanged(after, afterMutations, 'under-lock denials');
    assert.equal(after.renewal_events.length, 0, 'no events from the rejected attempts');

    // Restoring eligibility, the same assigned pharmacy still hands the
    // case off exactly once — the denials changed nothing that the handoff
    // depends on.
    const restore = initDatabase(dbPath);
    try {
      restore
        .prepare(`UPDATE renewals SET pharmacy_id = ?, prescriber_id = ? WHERE id = ?`)
        .run(HANDOFF_TARGET.pharmacy, HANDOFF_TARGET.prescriber, HANDOFF_TARGET.rn);
    } finally {
      restore.close();
    }
    const res = handoffRenewalToPrescriber(dbPath, HANDOFF_PHARMACY, HANDOFF_TARGET.rn);
    assert.equal(res.ok, true, 'the case is still handable after the denials');
    assert.equal(res.code, 'handed-off');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handoff invalid state: a renewal outside the handoff window (final status) is a fixed denial with no event and no state change', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refill-relay-fixture-'));
  const dbPath = join(dir, 'fixture.sqlite');
  try {
    initDatabase(dbPath);
    seedSyntheticFixtures(dbPath);
    seedHandoffTarget(dbPath);

    // Push the fresh case to a final status directly (the store function
    // never writes final states; this simulates a record that is no longer
    // in the handoff window).
    const mutate = initDatabase(dbPath);
    try {
      mutate
        .prepare(
          `UPDATE renewals
              SET status = ?, granted_refills = 1, decided_at = '2026-11-21T14:00:00Z'
            WHERE id = ?`
        )
        .run(STATUS_LABELS.RENEWAL_APPROVED, HANDOFF_TARGET.rn);
    } finally {
      mutate.close();
    }

    const before = handoffTableState(dbPath);
    const res = handoffRenewalToPrescriber(dbPath, HANDOFF_PHARMACY, HANDOFF_TARGET.rn);
    // The plan's exact fixed denial for an out-of-window row: the full
    // outcome is this object — no status detail, no case data, no lock
    // counter.
    assert.deepEqual(res, handoffDenial, 'exact fixed denial for a final-status row');

    const after = handoffTableState(dbPath);
    assertHandoffStateUnchanged(after, before, 'invalid-state denial');
    assert.equal(
      after.renewal_events.length,
      0,
      'no event for a denial'
    );

    // Eligibility variations on an out-of-window row (the under-lock
    // re-read must apply the same eligibility check to ineligible rows
    // before either returning a replay or making the transition):
    // lost ownership and an unassigned prescriber on a committed
    // 'Awaiting prescriber' row are both the exact same fixed denial —
    // never a replay of the committed winner.
    const mutateOwner = initDatabase(dbPath);
    try {
      mutateOwner
        .prepare(`UPDATE renewals SET pharmacy_id = ? WHERE id = ?`)
        .run('pharmacy-dunmore', HANDOFF_TARGET.rn);
    } finally {
      mutateOwner.close();
    }
    const resLost = handoffRenewalToPrescriber(dbPath, HANDOFF_PHARMACY, HANDOFF_TARGET.rn);
    assert.deepEqual(resLost, handoffDenial, 'lost ownership on an awaiting row: exact fixed denial');

    const mutatePrescriber = initDatabase(dbPath);
    try {
      mutatePrescriber
        .prepare(`UPDATE renewals SET prescriber_id = '' WHERE id = ?`)
        .run(HANDOFF_TARGET.rn);
    } finally {
      mutatePrescriber.close();
    }
    const resUnassigned = handoffRenewalToPrescriber(dbPath, HANDOFF_PHARMACY, HANDOFF_TARGET.rn);
    assert.deepEqual(resUnassigned, handoffDenial, 'unassigned prescriber on an awaiting row: exact fixed denial');

    const afterVariants = handoffTableState(dbPath);
    assert.equal(afterVariants.renewal_events.length, 0, 'no events for the eligibility-variant denials');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handoff failed commit: real UPDATE + INSERT then rollback leaves zero partial rows, prior state byte-identical on fresh re-read, and the next handoff succeeds with exactly one event', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refill-relay-fixture-'));
  const dbPath = join(dir, 'fixture.sqlite');
  try {
    initDatabase(dbPath);
    seedSyntheticFixtures(dbPath);
    seedSyntheticAccounts(dbPath);
    seedHandoffTarget(dbPath);

    // Previous saved state: a committed session for the acting pharmacy.
    const session = signIn(dbPath, 'pharmacy.cedar', 'pharmacy-cedar-2026');
    assert.equal(session.status, 200, 'previous committed session exists');

    const before = handoffTableState(dbPath);
    assert.equal(before.sessions.length, 1, 'one committed session in the before-state');
    assert.equal(before.renewal_events.length, 0, 'no events before the failed handoff');

    // Inject the failure AFTER the real UPDATE + event INSERT and BEFORE
    // the COMMIT: the writes run, then the transaction rolls back.
    const failed = handoffRenewalToPrescriber(dbPath, HANDOFF_PHARMACY, HANDOFF_TARGET.rn, {
      failHandoffCommit: true,
    });
    // Full-outcome check: the failure is exactly the recoverable shape —
    // no handed-off marker, no record value, no lock counter (no
    // contention was involved in this single-writer seam).
    assert.deepEqual(
      failed,
      { ok: false, code: 'handoff-save-failed', recoverable: true, lockRetries: 0 },
      'failed commit returns the exact recoverable save-failure outcome'
    );

    // Reread on a fresh connection: the attempted transition and event are
    // both gone — the rollback removed both — and every table is
    // byte-identical to the before-state (the prior saved state is what a
    // refresh would show).
    const after = handoffTableState(dbPath);
    assertHandoffStateUnchanged(after, before, 'failed handoff rollback');
    const fresh = initDatabase(dbPath);
    try {
      const row = fresh.prepare(`SELECT * FROM renewals WHERE id = ?`).get(HANDOFF_TARGET.rn);
      assert.equal(row.status, STATUS_LABELS.SENT_TO_PHARMACY, 'the case remains in Sent to pharmacy after the failed save');
      assert.equal(row.handoff_at, null, 'no partial handoff time');
      assert.equal(row.version, 1, 'no partial version bump');
      assert.equal(row.next_actor, 'pharmacy', 'next actor unchanged');
      assert.equal(
        fresh
          .prepare(`SELECT COUNT(*) AS n FROM renewal_events WHERE renewal_id = ?`)
          .get(HANDOFF_TARGET.rn).n,
        0,
        'no partial handoff event from the failed commit'
      );
      assert.equal(
        fresh.prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n,
        before.sessions.length,
        'sessions count unchanged after the failed handoff'
      );
    } finally {
      fresh.close();
    }

    // Recovery: the next handoff (no fault injected) succeeds and commits
    // exactly one transition and one event.
    const retry = handoffRenewalToPrescriber(dbPath, HANDOFF_PHARMACY, HANDOFF_TARGET.rn);
    assert.equal(retry.ok, true, 'recovery: the next handoff succeeds');
    assert.equal(retry.code, 'handed-off');
    assert.equal(retry.renewal.status, STATUS_LABELS.AWAITING_PRESCRIBER);
    assert.equal(retry.renewal.version, 2);
    const check = initDatabase(dbPath);
    try {
      assert.equal(
        check
          .prepare(`SELECT COUNT(*) AS n FROM renewal_events WHERE renewal_id = ? AND event_type = ?`)
          .get(HANDOFF_TARGET.rn, EVENT_TYPES.HANDOFF).n,
        1,
        'recovery: exactly one handoff event after the successful retry'
      );
      assert.equal(
        check.prepare(`SELECT handoff_at FROM renewals WHERE id = ?`).get(HANDOFF_TARGET.rn).handoff_at,
        retry.renewal.handoff_at,
        'recovery: the durable handoff time is the retried handoff\'s first valid time'
      );
    } finally {
      check.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handoff unique-index backstop: a committed handoff event on a not-yet-transitioned row blocks the second event; the store returns the committed winner idempotently, or a recoverable save failure without one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'refill-relay-fixture-'));
  const dbPath = join(dir, 'fixture.sqlite');
  try {
    initDatabase(dbPath);
    seedSyntheticFixtures(dbPath);
    seedHandoffTarget(dbPath);

    const winnerAt = '2026-11-21T13:00:00Z';

    // Corrupt winner state (pathological double-writer): a committed
    // handoff event exists, but the renewal row was never transitioned.
    // The one-handoff partial unique index is already taken.
    const corrupt = initDatabase(dbPath);
    try {
      corrupt
        .prepare(
          `INSERT INTO renewal_events (renewal_id, event_type, actor_role, actor_id, occurred_at, payload)
           VALUES (?, ?, 'pharmacy', ?, ?, ?)`
        )
        .run(HANDOFF_TARGET.rn, EVENT_TYPES.HANDOFF, HANDOFF_PHARMACY.id, winnerAt, '{"synthetic":true}');
    } finally {
      corrupt.close();
    }

    // The store function's own event INSERT violates
    // renewal_events_one_handoff; the defense-in-depth UNIQUE catch finds
    // no eligible committed winner (the row was never transitioned), so
    // the outcome is the exact recoverable save failure. ROLLBACK: no
    // partial state, and the pre-existing event is untouched.
    const before = handoffTableState(dbPath);
    const blocked = handoffRenewalToPrescriber(dbPath, HANDOFF_PHARMACY, HANDOFF_TARGET.rn);
    assert.deepEqual(
      blocked,
      { ok: false, code: 'handoff-save-failed', recoverable: true, lockRetries: 0 },
      'no eligible committed winner: exact recoverable save-failure outcome'
    );
    const afterBlocked = handoffTableState(dbPath);
    assertHandoffStateUnchanged(afterBlocked, before, 'unique backstop without winner row');
    assert.equal(
      afterBlocked.renewal_events.length,
      before.renewal_events.length,
      'the pre-existing event is the only event; nothing partial was added'
    );

    // Now commit the winner transition (as the double-writer's successful
    // partner would have). A repeat handoff is rejected again by the
    // index; the UNIQUE-recovery re-read applies the same under-lock
    // eligibility check to the committed winner and returns it
    // idempotently: full outcome is the saved winner — original handoff
    // time, no second event, no second version increment.
    const commitWinner = initDatabase(dbPath);
    try {
      commitWinner.exec('BEGIN IMMEDIATE');
      commitWinner
        .prepare(
          `UPDATE renewals
              SET status = ?, next_actor = 'prescriber', handoff_at = ?, version = version + 1
            WHERE id = ?`
        )
        .run(STATUS_LABELS.AWAITING_PRESCRIBER, winnerAt, HANDOFF_TARGET.rn);
      commitWinner.exec('COMMIT');
    } finally {
      commitWinner.close();
    }

    const expectedWinner = {
      id: HANDOFF_TARGET.rn,
      prescription_id: HANDOFF_TARGET.rx,
      patient_id: HANDOFF_TARGET.patient,
      pharmacy_id: HANDOFF_TARGET.pharmacy,
      prescriber_id: HANDOFF_TARGET.prescriber,
      status: STATUS_LABELS.AWAITING_PRESCRIBER,
      next_actor: 'prescriber',
      submitted_at: '2026-11-21T12:00:00Z',
      handoff_at: winnerAt,
      decided_at: null,
      granted_refills: null,
      request_idempotency_key: null,
      version: 2,
    };
    const replay = handoffRenewalToPrescriber(dbPath, HANDOFF_PHARMACY, HANDOFF_TARGET.rn);
    assert.deepEqual(
      replay,
      {
        ok: true,
        code: 'already-handed-off',
        handed_off: true,
        renewal: expectedWinner,
        lockRetries: 0,
      },
      'eligible committed winner returned idempotently with the original handoff time'
    );
    const check = initDatabase(dbPath);
    try {
      assert.equal(
        check
          .prepare(`SELECT COUNT(*) AS n FROM renewal_events WHERE renewal_id = ? AND event_type = ?`)
          .get(HANDOFF_TARGET.rn, EVENT_TYPES.HANDOFF).n,
        1,
        'still exactly one handoff event after the backstop exercises'
      );
    } finally {
      check.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
