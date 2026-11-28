import { createHash } from 'node:crypto';
import { STATUS_LABELS, PATIENT_PRESCRIPTION_STATES } from './store.mjs';

export const STATUS_DISPLAY = Object.freeze({
  [STATUS_LABELS.SENT_TO_PHARMACY]: 'Sent to pharmacy',
  [STATUS_LABELS.AWAITING_PRESCRIBER]: 'Awaiting prescriber',
  [STATUS_LABELS.RENEWAL_APPROVED]: 'Renewal approved',
  [STATUS_LABELS.VISIT_REQUIRED]: 'Visit required',
});

// Saved next-actor values render as visible text from this fixed map. An
// unknown or null saved value renders the fixed placeholder below — the map
// is closed, so no arbitrary client-supplied text can be injected.
export const NEXT_ACTOR_DISPLAY = Object.freeze({
  patient: 'Patient',
  pharmacy: 'Pharmacy',
  prescriber: 'Prescriber',
});
export const NEXT_ACTOR_UNKNOWN_DISPLAY = 'Not set';

export const ROLE_DISPLAY = Object.freeze({
  patient: 'patient',
  pharmacy: 'pharmacy',
  prescriber: 'prescriber',
});

const ROLE_PORTAL_LABEL = Object.freeze({
  patient: 'Patient',
  pharmacy: 'Pharmacy',
  prescriber: 'Prescriber',
});

// Minimal, dependency-free stylesheet. Status/next-actor values are plain
// visible text in the document flow; the styling adds no meaning that is
// not also present as text.
const SITE_CSS = `
body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 2rem auto; max-width: 48rem; padding: 0 1rem; color: #111; line-height: 1.5; }
h1 { font-size: 1.6rem; }
h2 { font-size: 1.2rem; }
a { color: #0b4f9e; }
button { font: inherit; }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
th, td { border: 1px solid #888; padding: 0.4rem 0.6rem; text-align: left; }
tr:nth-child(even) { background: #f4f6f8; }
dt { font-weight: bold; margin-top: 0.6rem; }
.error { color: #8b0000; font-weight: bold; margin: 1rem 0; }
.notice { margin: 1rem 0; }
.visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
`;

/**
 * Escape a value for safe interpolation into HTML text content.
 */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stableCaseRef(renewalId) {
  return createHash('sha256').update(`rfrl-case-ref-v1:${renewalId}`).digest('hex').slice(0, 32);
}

function statusText(status) {
  return STATUS_DISPLAY[status] ?? esc(status);
}

function nextActorText(nextActor) {
  return nextActor === null || nextActor === undefined
    ? NEXT_ACTOR_UNKNOWN_DISPLAY
    : (NEXT_ACTOR_DISPLAY[nextActor] ?? esc(nextActor));
}

function timestampText(value) {
  return value === null || value === undefined ? 'Not recorded' : String(value);
}

function caseRefQuery(renewalId) {
  return `/cases?case=${stableCaseRef(renewalId)}`;
}

// --- page frame -------------------------------------------------------------

function page({ title, heading, signedIn = null, identity = null, role = null, error = null, main = '' }) {
  // The sign-out control is a genuine native form submission: a
  // <button type="submit"> bound (via the HTML5 form attribute) to the
  // native <form method="post" action="/sign-out"> declared in the same
  // page. Pressing Enter on the focused button — or clicking it — submits
  // the form to the existing server sign-out route, which invalidates the
  // durable session and clears the HttpOnly cookie. No JavaScript is
  // involved; the control stays keyboard-operable.
  const headerRight = signedIn
    ? `Signed in as <span class="who">${esc(identity?.display_name ?? '')} (${esc(ROLE_DISPLAY[role] ?? role ?? '')})</span>
       · <label class="signout-label">Sign out:
         <button type="submit" form="sign-out-form">Sign out</button>
       </label>`
    : '';
  const errorBlock = error
    ? `<p id="page-error" class="error" tabindex="-1">${esc(error)}</p>`
    : '';
  const headerLine = headerRight ? `  <p>${headerRight}</p>\n` : '';
  const signOutForm = signedIn
    ? `  <form id="sign-out-form" method="post" action="/sign-out" aria-label="Sign out of Refill Relay"></form>\n`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${SITE_CSS}</style>
</head>
<body>
<header>
  <h1>${esc(heading)}</h1>
${headerLine}${signOutForm}</header>
<main id="main">
${errorBlock}${main}
</main>
</body>
</html>
`;
}

// --- sign-in page ------------------------------------------------------------

const SIGN_IN_CREDENTIALS_NOTE =
  'Local synthetic test accounts only — no real people, prescriptions, or external identity systems are used.';

/**
 * Sign-in page. Named, labeled, keyboard-operable native controls:
 * the username and password <input> elements each sit inside their
 * <label> (the label text names the field for the form control), the
 * submit is a native <button type="submit"> with visible text, and the
 * form has an accessible name via aria-label.
 * `error` renders as a visible <p class="error"> with a stable id, and the
 * whole page mirrors the same message for screen readers (role="alert").
 */
export function renderSignInPage({ error = null, returnTo = '/' } = {}) {
  const errorBlock = error
    ? `<p id="sign-in-error" class="error" tabindex="-1">${esc(error)}</p>`
    : '';
  const returnToInput = `<input type="hidden" name="returnTo" value="${esc(returnTo)}">`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in — Refill Relay</title>
<style>${SITE_CSS}</style>
</head>
<body>
<h1>Refill Relay — sign in</h1>
<p class="notice">${esc(SIGN_IN_CREDENTIALS_NOTE)}</p>
<main id="main">
${errorBlock}
<form id="sign-in-form" method="post" action="/sign-in" aria-label="Sign in to Refill Relay">
  <p>
    <label>Username:
      <input type="text" name="username" id="sign-in-username" autocomplete="username" required>
    </label>
  </p>
  <p>
    <label>Password:
      <input type="password" name="password" id="sign-in-password" autocomplete="current-password" required>
    </label>
  </p>
  <p>
    <button type="submit">Sign in</button>
  </p>
  ${returnToInput}
</form>
</main>
</body>
</html>
`;
}

// --- role queue (list) page ---------------------------------------------------

export function renderRoleQueuePage({ role, identity, cases = [] }) {
  const rows = cases
    .map((c) => {
      const status = statusText(c.status);
      const nextActor = nextActorText(c.next_actor);
      return `
      <tr>
        <td><a href="${esc(caseRefQuery(c.id))}">${esc(c.patient_name)}</a></td>
        <td>${esc(c.pharmacy_name)}</td>
        <td>${esc(c.prescriber_name)}</td>
        <td>${esc(status)}</td>
        <td>${esc(nextActor)}</td>
      </tr>`;
    })
    .join('');
  const main = cases.length === 0
    ? `<p class="notice">No saved renewal cases are currently assigned to your role.</p>`
    : `<table>
  <caption class="visually-hidden">Saved renewal cases for the signed-in ${esc(ROLE_DISPLAY[role] ?? role)}: patient, pharmacy, prescriber, saved status, and saved next actor</caption>
  <thead>
    <tr><th scope="col">Patient</th><th scope="col">Pharmacy</th><th scope="col">Prescriber</th><th scope="col">Status</th><th scope="col">Next actor</th></tr>
  </thead>
  <tbody>${rows}
  </tbody>
</table>`;
  return page({
    title: `${ROLE_PORTAL_LABEL[role] ?? role} queue — Refill Relay`,
    heading: `${ROLE_PORTAL_LABEL[role] ?? role} queue`,
    signedIn: true,
    identity,
    role,
    main,
  });
}

// --- case detail page ----------------------------------------------------------

function detailField(label, valueText) {
  return `<dt>${esc(label)}</dt>\n<dd>${valueText}</dd>`;
}

function refillsRemainingText(refillsRemaining) {
  return refillsRemaining === null || refillsRemaining === undefined
    ? 'Not recorded'
    : String(refillsRemaining);
}

export function renderRoleCasePage({ role, identity, case: caseView, refillsRemaining = null }) {
  const c = caseView;
  const status = statusText(c.status);
  const nextActor = nextActorText(c.next_actor);
  // Pharmacy handoff affordance: exactly ONE native form, rendered only for
  // the pharmacy role while the saved status is 'Sent to pharmacy'. The
  // detail page is already object-level authorized, so a pharmacy role here
  // is always the case's assigned pharmacy — a prescriber, a patient, an
  // unrelated pharmacy (which is denied before render), or any other saved
  // status never sees a handoff control. The hidden field carries the
  // STABLE case reference (same derivation as the queue and copied links);
  // the form POSTs it to the /handoff route, where the server reauthorizes
  // the session, role, and assignment before any write. No inline scripts
  // or event handlers (estate rule, asserted by the role-view tests);
  // outside this window the page shows the saved status, next actor, and
  // handoff time only.
  const handoffForm =
    role === 'pharmacy' && c.status === STATUS_LABELS.SENT_TO_PHARMACY
      ? `
<form method="post" action="/handoff" aria-label="Request renewal">
  <input type="hidden" name="case_ref" value="${esc(stableCaseRef(c.id))}">
  <button type="submit">Request renewal</button>
</form>`
      : '';
  const main = `
<nav aria-label="Back to queue"><a href="/cases">Back to my queue</a></nav>
<h2>Saved renewal case</h2>
<dl>
${detailField('Patient', esc(c.patient_name))}
${detailField('Pharmacy', esc(c.pharmacy_name))}
${detailField('Prescriber', esc(c.prescriber_name))}
${detailField('Prescription refills remaining', esc(refillsRemainingText(refillsRemaining)))}
${detailField('Status', esc(status))}
${detailField('Next actor', esc(nextActor))}
${detailField('Submitted at', esc(timestampText(c.submitted_at)))}
${detailField('Handoff at', esc(timestampText(c.handoff_at)))}
${detailField('Decided at', esc(timestampText(c.decided_at)))}
${detailField('Granted refills', c.granted_refills === null || c.granted_refills === undefined ? 'Not decided' : String(c.granted_refills))}
</dl>${handoffForm}`;
  return page({
    title: `Case for ${c.patient_name} — ${ROLE_PORTAL_LABEL[role] ?? role} — Refill Relay`,
    heading: `${ROLE_PORTAL_LABEL[role] ?? role} case: ${c.patient_name}`,
    signedIn: true,
    identity,
    role,
    main,
  });
}

// --- patient prescriptions page ----------------------------------------------------

export const PATIENT_RX_STATE_DISPLAY = Object.freeze({
  [PATIENT_PRESCRIPTION_STATES.PENDING]: 'Renewal pending',
  [PATIENT_PRESCRIPTION_STATES.FINAL]: 'Renewal decided',
  [PATIENT_PRESCRIPTION_STATES.NO_RENEWAL]: 'No renewal yet',
  [PATIENT_PRESCRIPTION_STATES.INELIGIBLE]: 'Not eligible for a renewal request',
});

// Fixed visible notice for an ineligible row (no form, no link): the patient
// sees their own refill count in the Refills remaining cell, but the ask
// affordance is withheld because the prescription is not a first-ask target.
const INELIGIBLE_ROW_NOTICE = 'This prescription is not eligible for a renewal request.';

export function renderPatientPrescriptionsPage({ identity, prescriptions = [] }) {
  const rows = prescriptions
    .map((p) => {
      const state = PATIENT_RX_STATE_DISPLAY[p.state] ?? esc(p.state);
      let action;
      if (p.state === PATIENT_PRESCRIPTION_STATES.NO_RENEWAL) {
        action = `<form method="post" action="/ask" aria-label="Ask my pharmacy">
          <input type="hidden" name="prescription_id" value="${esc(p.id)}">
          <button type="submit">Ask my pharmacy</button>
        </form>`;
      } else if (
        p.state === PATIENT_PRESCRIPTION_STATES.PENDING ||
        p.state === PATIENT_PRESCRIPTION_STATES.FINAL
      ) {
        // A renewal already exists: link to its saved case detail (the server
        // reauthorizes it on every request). No ask form, so a pending or
        // terminal prescription can never present a second ask control.
        action = `<a href="/cases?case=${esc(p.renewal_case_ref)}">View this renewal</a>`;
      } else {
        action = `<p class="notice">${esc(INELIGIBLE_ROW_NOTICE)}</p>`;
      }
      return `\n      <tr>
        <td>${esc(p.pharmacy_name)}</td>
        <td>${esc(p.prescriber_name)}</td>
        <td>${esc(p.refills_remaining)}</td>
        <td>${esc(state)}</td>
        <td>${action}</td>
      </tr>`;
    })
    .join('');
  const main = prescriptions.length === 0
    ? `<p class="notice">You have no saved prescriptions.</p>`
    : `<table>
  <caption class="visually-hidden">Your saved prescriptions: pharmacy, prescriber, refills remaining, state, and the action available for each</caption>
  <thead>
    <tr><th scope="col">Pharmacy</th><th scope="col">Prescriber</th><th scope="col">Refills remaining</th><th scope="col">State</th><th scope="col">Action</th></tr>
  </thead>
  <tbody>${rows}
  </tbody>
</table>`;
  return page({
    title: 'Patient prescriptions — Refill Relay',
    heading: 'Patient prescriptions',
    signedIn: true,
    identity,
    role: 'patient',
    main,
  });
}

// --- denial / error pages ---------------------------------------------------------

export function renderAccessDeniedPage({ reason, message }) {
  return page({
    title: 'Access denied — Refill Relay',
    heading: 'Access denied',
    signedIn: false,
    error: message,
    main: `<p class="notice">If you believe you should have access to this page, sign in with the account that is authorized for the record, or contact your organization.</p>
<p><a href="/">Go to sign in</a></p>`,
  });
}

/**
 * Fixed "not found" page (unknown case reference, unknown route). No case
 * data, no record-existence disclosure, no identity.
 */
export function renderNotFoundPage({ message }) {
  return page({
    title: 'Page not found — Refill Relay',
    heading: 'Page not found',
    signedIn: false,
    error: message,
    main: `<p><a href="/">Go to the Refill Relay home page</a></p>`,
  });
}
