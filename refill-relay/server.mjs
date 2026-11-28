import { createServer } from 'node:http';
import {
  SESSION_COOKIE_NAME,
  initDatabase,
  signIn as storeSignIn,
  getSession as storeGetSession,
  signOut as storeSignOut,
  listRoleCases,
  getRoleCase,
  caseRefFor,
  listPatientPrescriptions,
  askPatientForRenewal,
  handoffRenewalToPrescriber,
} from './store.mjs';
import {
  renderSignInPage,
  renderRoleQueuePage,
  renderRoleCasePage,
  renderPatientPrescriptionsPage,
  renderAccessDeniedPage,
  renderNotFoundPage,
} from './views.mjs';

export const SERVER_HOST_DEFAULT = '127.0.0.1';


const REF_LENGTH = 32;

// Resolve a stable case ref to the exact record id (pure SELECT on one
// short-lived read connection; no durable-state change).
function resolveCaseRef(dbPath, ref) {
  if (typeof ref !== 'string' || ref.length !== REF_LENGTH) return undefined;
  const db = initDatabase(dbPath);
  try {
    for (const row of db.prepare(`SELECT id FROM renewals`).all()) {
      if (caseRefFor(row.id) === ref) return row.id;
    }
    return undefined;
  } finally {
    db.close();
  }
}

function prescriptionRefillsRemaining(dbPath, prescriptionId) {
  const db = initDatabase(dbPath);
  try {
    const row = db
      .prepare(`SELECT refills_remaining FROM prescriptions WHERE id = ?`)
      .get(String(prescriptionId));
    return row ? row.refills_remaining : null;
  } finally {
    db.close();
  }
}

const DENIAL_BODIES = Object.freeze({
  'no-session': Object.freeze({
    ok: false,
    error: 'no-session',
    reason: 'no-session',
    message: 'No signed-in session is available; sign in first.',
  }),
  'unknown-role': Object.freeze({
    ok: false,
    error: 'forbidden',
    reason: 'unknown-role',
    message: 'This signed-in role is not recognized.',
  }),
  'not-authorized': Object.freeze({
    ok: false,
    error: 'forbidden',
    reason: 'not-authorized',
    message: 'This case is not available for your signed-in role.',
  }),
});

const NOT_FOUND_BODY = Object.freeze({
  ok: false,
  error: 'not-found',
  message: 'Unknown route.',
});

const BAD_REQUEST_BODY = Object.freeze({
  ok: false,
  error: 'bad-request',
  message: 'This request is missing required fields or has an invalid method.',
});

const ASK_SAVE_FAILED_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Save failed — Refill Relay</title>
</head>
<body>
<h1>Your request could not be saved</h1>
<p id="ask-save-error" class="error" role="alert" tabindex="-1">Your request could not be saved. Nothing was changed; please try again.</p>
</body>
</html>
`;

const HANDOFF_SAVE_FAILED_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Save failed — Refill Relay</title>
</head>
<body>
<h1>Your handoff could not be saved</h1>
<p id="handoff-save-error" class="error" role="alert" tabindex="-1">Your handoff could not be saved. Nothing was changed; please try again.</p>
</body>
</html>
`;

export function readSessionToken(cookieHeader) {
  if (typeof cookieHeader !== 'string' || cookieHeader === '') return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === SESSION_COOKIE_NAME) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function createAppHandler(dbPath, options = {}) {
  let askCommitFailureArmed = Boolean(options.askCommitFailure);
  let handoffCommitFailureArmed = Boolean(options.handoffCommitFailure);
  // Test-only, off by default: the fresh-case overlap test arms this on a
  // dedicated handler instance. It fires once per POST /handoff request,
  // AFTER session/role/body parsing has passed and immediately BEFORE the
  // synchronous store call, and the handler awaits the promise it returns.
  // The event loop stays free while awaiting (no DB call and no write
  // transaction is open), so a second overlapping request can also reach
  // the rendezvous; the test bounds the wait with its own deadline and
  // releases both requests in a finally. Every other startup leaves it
  // undefined, in which case the handler proceeds straight to the store
  // call. Not exposed through any route; production behavior is unchanged.
  const handoffArrivalRendezvous =
    typeof options.handoffArrivalRendezvous === 'function'
      ? options.handoffArrivalRendezvous
      : undefined;
  // Per-handler-instance arrival counter for the rendezvous record
  // descriptor (1-based request ordering within this handler instance).
  let handoffArrivalSeq = 0;

  const readJsonBody = (req) =>
    new Promise((resolve, reject) => {
      let data = '';
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > 16 * 1024) {
          reject(Object.assign(new Error('request body too large'), { statusCode: 400 }));
          req.destroy();
          return;
        }
        data += chunk;
      });
      req.on('end', () => {
        if (data === '') {
          resolve({});
          return;
        }
        try {
          const parsed = JSON.parse(data);
          resolve(
            parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
              ? parsed
              : {}
          );
        } catch {
          resolve({});
        }
      });
      req.on('error', reject);
    });

  // application/x-www-form-urlencoded body for the native sign-in form.
  const readFormBody = (req) =>
    new Promise((resolve, reject) => {
      let data = '';
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > 16 * 1024) {
          reject(Object.assign(new Error('request body too large'), { statusCode: 400 }));
          req.destroy();
          return;
        }
        data += chunk;
      });
      req.on('end', () => {
        const fields = {};
        for (const pair of data.split('&')) {
          if (pair === '') continue;
          const eq = pair.indexOf('=');
          const key = eq >= 0 ? pair.slice(0, eq) : pair;
          const value = eq >= 0 ? pair.slice(eq + 1) : '';
          try {
            const decodedKey = decodeURIComponent(key.replace(/\+/g, ' '));
            const decodedValue = decodeURIComponent(value.replace(/\+/g, ' '));
            if (decodedKey !== '' && !(decodedKey in fields)) fields[decodedKey] = decodedValue;
          } catch {
            // Malformed encoding pair: skip it (fixed-field form only).
          }
        }
        resolve(fields);
      });
      req.on('error', reject);
    });

  const sendJson = (res, status, body, extraHeaders = {}) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    });
    res.end(payload);
  };

  const sendHtml = (res, status, html, extraHeaders = {}) => {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    });
    res.end(html);
  };

  const resolveSession = (token) => storeGetSession(dbPath, token).identity;

  const wantsHtml = (acceptHeader) => {
    if (typeof acceptHeader !== 'string' || acceptHeader.trim() === '') return false;
    for (const part of acceptHeader.split(',')) {
      const media = part.split(';')[0].trim().toLowerCase();
      if (media === 'text/html' || media === 'application/xhtml+xml') return true;
    }
    return false;
  };

  // The stable case reference carried by queue links and detail URLs.
  const extractCaseRef = (url, route) => {
    if (route === '/cases' && url.searchParams.has('case')) return url.searchParams.get('case');
    if (route.startsWith('/case/')) return route.slice('/case/'.length);
    return undefined;
  };

  // Where an anonymous visitor should land after signing in: the very
  // page they tried to open (queue or copied-link detail). A return
  // target is used only as a same-origin absolute path (it must start with
  // a single '/', never '//', carry no backslash, and stay under 200
  // chars), so it can never become an open redirect. The target is ALWAYS
  // re-authorized for the newly signed-in session on the following request
  // (object-level check), so it confers no access on its own.
  const safeReturnTo = (value) => {
    if (typeof value !== 'string') return null;
    if (!value.startsWith('/') || value.startsWith('//') || value.length > 200) return null;
    if (value.includes('\\')) return null;
    return value;
  };
  const returnToFor = (url, route) => {
    if (route === '/case' || route.startsWith('/case/')) return route;
    if (route === '/cases') {
      return url.searchParams.has('id') || url.searchParams.has('case') ? route + url.search : route;
    }
    if (route === '/prescriptions') return route;
    return '/cases';
  };

  return async function handleAppRequest(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname;
    const method = req.method ?? 'GET';

    if (method !== 'GET' && method !== 'POST') {
      return wantsHtml(req.headers.accept)
        ? sendHtml(res, 405, renderNotFoundPage({ message: BAD_REQUEST_BODY.message }))
        : sendJson(res, 405, { ...BAD_REQUEST_BODY });
    }

    try {
      if (method === 'POST' && route === '/sign-in') {
        const acceptHtml = wantsHtml(req.headers.accept);
        const contentType = String(req.headers['content-type'] ?? '');
        const isForm = contentType.includes('application/x-www-form-urlencoded');
        const fields = isForm ? await readFormBody(req) : await readJsonBody(req);
        const username = fields.username !== undefined ? String(fields.username) : '';
        const password = fields.password !== undefined ? String(fields.password) : '';
        const returnTo = safeReturnTo(fields.returnTo) ?? '/cases';
        const result = storeSignIn(dbPath, username, password);
        const headers = result.cookie ? { 'Set-Cookie': result.cookie.header } : {};
        if (!acceptHtml) return sendJson(res, result.status, result.body, headers);
        if (result.body.ok) {
          // Signed in: the browser lands back on the page it requested
          // (the role queue by default); the server rechecks authorization
          // for the new session on that request.
          return sendHtml(res, 303, '', { Location: returnTo, ...headers });
        }
        // Failed sign-in: the sign-in page again (preserving the return
        // target), with the clear, readable error rendered as visible text
        // (401 invalid credentials; 503 for a recoverable session-save
        // failure — the same codes as the JSON contract).
        return sendHtml(res, result.status, renderSignInPage({ error: result.body.message, returnTo }), headers);
      }

      if (method === 'POST' && route === '/sign-out') {
        const token = readSessionToken(req.headers.cookie);
        const result = storeSignOut(dbPath, token);
        const headers = { 'Set-Cookie': result.clearCookie.header };
        if (!wantsHtml(req.headers.accept)) {
          return sendJson(res, result.status, result.body, headers);
        }
        // Signed out: the server-side session is invalidated; land back on
        // the sign-in page (the next request will be rechecked as anonymous).
        return sendHtml(res, 303, '', { Location: '/', ...headers });
      }

      if (method === 'GET' && route === '/session') {
        const result = storeGetSession(dbPath, readSessionToken(req.headers.cookie));
        return sendJson(res, result.status, result.body);
      }

      if (method === 'GET' && route === '/') {
        const identity = resolveSession(readSessionToken(req.headers.cookie));
        if (!wantsHtml(req.headers.accept)) {
          return sendJson(res, 200, {
            ok: true,
            signed_in: Boolean(identity),
            identity: identity
              ? { id: identity.id, role: identity.role, display_name: identity.display_name }
              : null,
          });
        }
        // Landing page: sign in (anonymous) or the role queue (signed in).
        if (identity) {
          return sendHtml(res, 303, '', { Location: '/cases' });
        }
        return sendHtml(res, 200, renderSignInPage({}));
      }

      if (method === 'GET' && route === '/cases') {
        const html = wantsHtml(req.headers.accept);
        const identity = resolveSession(readSessionToken(req.headers.cookie));
        if (!identity) {
          if (html) {
            // Anonymous: a readable sign-in prompt page (no case data) that
            // returns the visitor to the very page they tried to open.
            return sendHtml(res, 401, renderSignInPage({
              error: DENIAL_BODIES['no-session'].message,
              returnTo: returnToFor(url, route),
            }));
          }
          return sendJson(res, 401, { ...DENIAL_BODIES['no-session'] });
        }

        const caseRef = extractCaseRef(url, route);
        if (url.searchParams.has('id')) {
          const result = getRoleCase(dbPath, url.searchParams.get('id'), identity);
          if (!result.ok) {
            if (html) {
              // Fixed, identity-free denial page (no case data, no record
              // reference, no existence disclosure).
              return sendHtml(res, 403, renderAccessDeniedPage({
                reason: result.reason,
                message: DENIAL_BODIES[result.reason].message,
              }));
            }
            return sendJson(res, 403, { ...DENIAL_BODIES[result.reason] });
          }
          if (html) {
            return sendHtml(res, 200, renderRoleCasePage({
              role: result.role,
              identity,
              case: result.case,
              // Display-only saved prescription attribute (fetched
              // AFTER authorization, above — never before).
              refillsRemaining: prescriptionRefillsRemaining(dbPath, result.case.prescription_id),
            }));
          }
          return sendJson(res, 200, { ok: true, role: result.role, case: result.case });
        }
        if (caseRef !== undefined) {
          // Same tolerant resolution as the /case path form: an opaque ref
          // that resolves maps to the record id; anything else is treated as
          // a literal id (unknown values deny with the same opaque reason).
          const result = getRoleCase(dbPath, resolveCaseRef(dbPath, caseRef) ?? caseRef, identity);
          if (!result.ok) {
            if (html) {
              // Fixed, identity-free denial page (no case data, no record
              // reference, no existence disclosure).
              return sendHtml(res, 403, renderAccessDeniedPage({
                reason: result.reason,
                message: DENIAL_BODIES[result.reason].message,
              }));
            }
            return sendJson(res, 403, { ...DENIAL_BODIES[result.reason] });
          }
          if (html) {
            return sendHtml(res, 200, renderRoleCasePage({
              role: result.role,
              identity,
              case: result.case,
              // Display-only saved prescription attribute (fetched
              // AFTER authorization, above — never before).
              refillsRemaining: prescriptionRefillsRemaining(dbPath, result.case.prescription_id),
            }));
          }
          return sendJson(res, 200, { ok: true, role: result.role, case: result.case });
        }

        const result = listRoleCases(dbPath, identity);
        if (!result.ok) {
          if (html) {
            // Fixed, identity-free denial page (no case data, no record
            // reference, no existence disclosure).
            return sendHtml(res, 403, renderAccessDeniedPage({
              reason: result.reason,
              message: DENIAL_BODIES[result.reason].message,
            }));
          }
          return sendJson(res, 403, { ...DENIAL_BODIES[result.reason] });
        }
        if (html) {
          return sendHtml(res, 200, renderRoleQueuePage({ role: result.role, identity, cases: result.cases }));
        }
        return sendJson(res, 200, { ok: true, role: result.role, cases: result.cases });
      }

      if (
        method === 'GET' &&
        (route === '/case' || route.startsWith('/case/'))
      ) {
        const html = wantsHtml(req.headers.accept);
        const identity = resolveSession(readSessionToken(req.headers.cookie));
        if (!identity) {
          if (html) {
            return sendHtml(res, 401, renderSignInPage({
              error: DENIAL_BODIES['no-session'].message,
              returnTo: returnToFor(url, route),
            }));
          }
          return sendJson(res, 401, { ...DENIAL_BODIES['no-session'] });
        }
        const caseRef = route === '/case' ? '' : route.slice('/case/'.length);
        const recordId = resolveCaseRef(dbPath, caseRef) ?? caseRef;
        const result = getRoleCase(dbPath, recordId, identity);
        if (!result.ok) {
          if (html) {
            // Fixed, identity-free denial page (no case data, no record
            // reference, no existence disclosure).
            return sendHtml(res, 403, renderAccessDeniedPage({
              reason: result.reason,
              message: DENIAL_BODIES[result.reason].message,
            }));
          }
          return sendJson(res, 403, { ...DENIAL_BODIES[result.reason] });
        }
        if (html) {
          return sendHtml(res, 200, renderRoleCasePage({
              role: result.role,
              identity,
              case: result.case,
              // Display-only saved prescription attribute (fetched
              // AFTER authorization, above — never before).
              refillsRemaining: prescriptionRefillsRemaining(dbPath, result.case.prescription_id),
            }));
        }
        return sendJson(res, 200, { ok: true, role: result.role, case: result.case });
      }

      if (method === 'GET' && route === '/prescriptions') {
        const html = wantsHtml(req.headers.accept);
        const identity = resolveSession(readSessionToken(req.headers.cookie));
        if (!identity) {
          if (html) {
            return sendHtml(res, 401, renderSignInPage({
              error: DENIAL_BODIES['no-session'].message,
              returnTo: returnToFor(url, route),
            }));
          }
          return sendJson(res, 401, { ...DENIAL_BODIES['no-session'] });
        }
        const result = listPatientPrescriptions(dbPath, identity);
        if (!result.ok) {
          // Fixed denial: no prescription field, no returnTo leakage.
          if (html) {
            return sendHtml(res, 403, renderAccessDeniedPage({
              reason: result.reason,
              message: DENIAL_BODIES[result.reason].message,
            }));
          }
          return sendJson(res, 403, { ...DENIAL_BODIES[result.reason] });
        }
        if (html) {
          return sendHtml(res, 200, renderPatientPrescriptionsPage({
            identity,
            prescriptions: result.prescriptions,
          }));
        }
        return sendJson(res, 200, {
          ok: true,
          role: 'patient',
          prescriptions: result.prescriptions,
        });
      }

      if (method === 'POST' && route === '/ask') {
        const html = wantsHtml(req.headers.accept);
        const identity = resolveSession(readSessionToken(req.headers.cookie));
        if (!identity) {
          if (html) {
            return sendHtml(res, 401, renderSignInPage({
              error: DENIAL_BODIES['no-session'].message,
              returnTo: '/prescriptions',
            }));
          }
          return sendJson(res, 401, { ...DENIAL_BODIES['no-session'] });
        }
        if (identity.role !== 'patient') {
          // Fixed denial (no case data, no returnTo): non-patients cannot
          // ask; the store would deny 'not-authorized' for the same reason.
          if (html) {
            return sendHtml(res, 403, renderAccessDeniedPage({
              reason: 'not-authorized',
              message: DENIAL_BODIES['not-authorized'].message,
            }));
          }
          return sendJson(res, 403, { ...DENIAL_BODIES['not-authorized'] });
        }
        // Consume the one-shot save-failure seam (test-only) BEFORE the
        // store call so the outcome maps to the request that tripped it.
        const optionsForAsk = askCommitFailureArmed
          ? { failAskCommit: true }
          : {};
        askCommitFailureArmed = false;

        const contentType = String(req.headers['content-type'] ?? '');
        const isForm = contentType.includes('application/x-www-form-urlencoded');
        const fields = isForm ? await readFormBody(req) : await readJsonBody(req);
        const prescriptionId = fields.prescription_id;
        const result = askPatientForRenewal(
          dbPath,
          identity,
          prescriptionId === undefined || prescriptionId === null
            ? ''
            : String(prescriptionId),
          optionsForAsk
        );

        if (!result.ok) {
          switch (result.code) {
            case 'unknown-prescription':
              // Fixed 404 with no prescription field: unknown, another
              // patient's, and missing ids are indistinguishable (no
              // existence or ownership disclosure).
              return html
                ? sendHtml(res, 404, renderNotFoundPage({ message: NOT_FOUND_BODY.message }))
                : sendJson(res, 404, { ...NOT_FOUND_BODY });
            case 'ineligible-prescription':
              return html
                ? sendHtml(res, 422, renderAccessDeniedPage({
                  reason: 'not-authorized',
                  message: 'This prescription is not eligible for a renewal request.',
                }))
                : sendJson(res, 422, {
                  ok: false,
                  error: 'ineligible-prescription',
                  message: 'This prescription is not eligible for a renewal request.',
                });
            case 'ask-save-failed':
              return html
                ? sendHtml(res, 503, ASK_SAVE_FAILED_HTML)
                : sendJson(res, 503, {
                  ok: false,
                  error: 'ask-save-failed',
                  recoverable: true,
                  message: 'Your request could not be saved. Nothing was changed; please try again.',
                });
            case 'not-authorized':
            default:
              return html
                ? sendHtml(res, 403, renderAccessDeniedPage({
                  reason: 'not-authorized',
                  message: DENIAL_BODIES['not-authorized'].message,
                }))
                : sendJson(res, 403, { ...DENIAL_BODIES['not-authorized'] });
          }
        }

        // ok outcomes: created (201) / already-pending (200) /
        // already-final (200) — the plan's planned JSON/HTML mapping.
        const status = result.code === 'created' ? 201 : 200;
        if (html) {
          // 303 to the case detail: the existing detail view renders the
          // durable status, submission time, and next actor (created /
          // pending) or the existing terminal disposition (already-final)
          // — no flash cookie, no record data in the redirect.
          return sendHtml(res, 303, '', { Location: `/cases?case=${caseRefFor(result.renewal.id)}` });
        }
        const renewal = {
          id: result.renewal.id,
          status: result.renewal.status,
          next_actor: result.renewal.next_actor,
          submitted_at: result.renewal.submitted_at,
        };
        if (result.code === 'already-final') {
          renewal.decided_at = result.renewal.decided_at;
          renewal.granted_refills = result.renewal.granted_refills;
        }
        return sendJson(res, status, {
          ok: true,
          created: result.created,
          code: result.code,
          renewal,
        });
      }

      if (method === 'POST' && route === '/handoff') {
        const html = wantsHtml(req.headers.accept);
        const identity = resolveSession(readSessionToken(req.headers.cookie));
        if (!identity) {
          if (html) {
            return sendHtml(res, 401, renderSignInPage({
              error: DENIAL_BODIES['no-session'].message,
              returnTo: '/cases',
            }));
          }
          return sendJson(res, 401, { ...DENIAL_BODIES['no-session'] });
        }
        if (identity.role !== 'pharmacy') {
          // Fixed denial (no case data, no returnTo): non-pharmacies cannot
          // hand off; the store would deny 'not-authorized' for the same
          // reason (and re-checks assignment before any write).
          if (html) {
            return sendHtml(res, 403, renderAccessDeniedPage({
              reason: 'not-authorized',
              message: DENIAL_BODIES['not-authorized'].message,
            }));
          }
          return sendJson(res, 403, { ...DENIAL_BODIES['not-authorized'] });
        }
        // Consume the one-shot save-failure seam (test-only) BEFORE the
        // store call so the outcome maps to the request that tripped it
        // (identical to the ask seam).
        const optionsForHandoff = handoffCommitFailureArmed
          ? { failHandoffCommit: true }
          : {};
        handoffCommitFailureArmed = false;

        const contentType = String(req.headers['content-type'] ?? '');
        const isForm = contentType.includes('application/x-www-form-urlencoded');
        const fields = isForm ? await readFormBody(req) : await readJsonBody(req);
        const caseRef = fields.case_ref;

        // Test-only asynchronous rendezvous (armed only by the fresh-case
        // overlap test on a dedicated instance; undefined everywhere else).
        // Fires only after session/role/body parsing has passed and
        // immediately before the synchronous store call; the handler awaits
        // the returned promise with no database call of any kind in flight
        // and no write transaction open, so the event loop stays free to
        // service the overlapping request. When un-armed the store call is
        // reached directly.
        if (handoffArrivalRendezvous) {
          const rendezvousRecord = {
            seq: ++handoffArrivalSeq,
            caseRef: caseRef === undefined || caseRef === null ? '' : String(caseRef),
            wantsHtml: html,
          };
          await handoffArrivalRendezvous(rendezvousRecord);
        }

        // Tolerant resolution (same convention as /cases?case=… and the
        // /ask-adjacent case routes): an opaque ref that resolves maps to
        // the record id; anything else is treated as a literal id (unknown
        // values deny with the same opaque reason inside the store).
        const result = handoffRenewalToPrescriber(
          dbPath,
          identity,
          resolveCaseRef(dbPath, caseRef === undefined || caseRef === null ? '' : String(caseRef)) ??
            (caseRef === undefined || caseRef === null ? '' : String(caseRef)),
          optionsForHandoff
        );

        if (!result.ok) {
          switch (result.code) {
            case 'handoff-save-failed':
              return html
                ? sendHtml(res, 503, HANDOFF_SAVE_FAILED_HTML)
                : sendJson(res, 503, {
                  ok: false,
                  error: 'handoff-save-failed',
                  recoverable: true,
                  message: 'Your handoff could not be saved. Nothing was changed; please try again.',
                });
            case 'not-authorized':
            default:
              // Fixed denial: unknown refs, unrelated identities, and
              // out-of-window records are indistinguishable (no existence,
              // assignment, or status disclosure).
              return html
                ? sendHtml(res, 403, renderAccessDeniedPage({
                  reason: 'not-authorized',
                  message: DENIAL_BODIES['not-authorized'].message,
                }))
                : sendJson(res, 403, { ...DENIAL_BODIES['not-authorized'] });
          }
        }

        // First handoff and replay both return 200 (not 201: the operation
        // mutates the existing renewal rather than creating a resource).
        if (html) {
          // 303 to the case detail: the existing detail view renders the
          // durable status, handoff time, and next actor — no record data
          // in the redirect (ask convention).
          return sendHtml(res, 303, '', { Location: `/cases?case=${caseRefFor(result.renewal.id)}` });
        }
        return sendJson(res, 200, {
          ok: true,
          code: result.code,
          handed_off: result.handed_off,
          renewal: {
            id: result.renewal.id,
            status: result.renewal.status,
            next_actor: result.renewal.next_actor,
            handoff_at: result.renewal.handoff_at,
          },
        });
      }

      return wantsHtml(req.headers.accept)
        ? sendHtml(res, 404, renderNotFoundPage({ message: NOT_FOUND_BODY.message }))
        : sendJson(res, 404, { ...NOT_FOUND_BODY });
    } catch (err) {
      // A transport-level failure (e.g. body too large) is not a case-data
      // response: fixed body, no record field, no durable state was touched
      // on any covered read path before this point.
      const status = Number(err?.statusCode) > 0 ? Number(err.statusCode) : 500;
      if (wantsHtml(req.headers.accept)) {
        return sendHtml(res, status, renderNotFoundPage({
          message: status >= 500
            ? 'The request could not be processed; no state was changed.'
            : BAD_REQUEST_BODY.message,
        }));
      }
      return sendJson(res, status, {
        ok: false,
        error: status >= 500 ? 'server-error' : 'bad-request',
        message: status >= 500 ? 'The request could not be processed; no state was changed.' : BAD_REQUEST_BODY.message,
      });
    }
  };
}

export function startServer({ dbPath, host = SERVER_HOST_DEFAULT, port = 0, options } = {}) {
  if (!dbPath) throw new Error('startServer: dbPath is required');
  if (host !== SERVER_HOST_DEFAULT) {
    throw new Error(
      `startServer: only the loopback host 127.0.0.1 is permitted; refusing to bind ${JSON.stringify(host)}`
    );
  }
  const handler = createAppHandler(dbPath, options);
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      }
      res.end(JSON.stringify({
        ok: false,
        error: 'server-error',
        message: 'The request could not be processed; no state was changed.',
      }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve({
        server,
        host: address.address,
        port: address.port,
        close: () =>
          new Promise((r) => {
            // Drop any keep-alive connections first so close() cannot hang
            // on idle sockets waiting for the next request.
            if (typeof server.closeAllConnections === 'function') {
              server.closeAllConnections();
            }
            server.close(r);
          }),
      });
    });
  });
}
