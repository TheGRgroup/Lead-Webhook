#!/usr/bin/env node
/**
 * GR Group — Instant Lead Webhook Receiver
 *
 * Built 2026-07-31. The whole point of this file: get a real person a text
 * or email within SECONDS of filling out the Facebook lead form, even if
 * Gus's laptop is closed. Everything else in this project (the tag-based
 * sequence engine in server.js) only runs while his Claude app is open —
 * this is the one piece that's always on.
 *
 * HOW IT'S WIRED: a GHL Workflow with trigger "Contact Created" (or
 * "Facebook Lead Ads Form Submitted" if that trigger exists in this
 * account — check both) has a Webhook action pointed at this server's
 * /lead-webhook?token=... URL. The moment GHL creates the contact, it
 * calls this endpoint.
 *
 * WHAT IT DOES, in order:
 *   1. Verifies the token (WEBHOOK_TOKEN env var) — refuses anything else.
 *   2. Figures out the contact ID from whatever GHL actually sent (the
 *      exact payload shape is UNVERIFIED until the first real trigger —
 *      see extractContactId below — so this tries several common shapes
 *      and logs the raw body either way so it can be fixed fast if wrong).
 *   3. Fetches the FULL contact from GHL's API directly (never trusts the
 *      webhook body for anything beyond the ID) — this is the same
 *      GHL_API_KEY-authenticated call server.js makes.
 *   4. Pushes the contact into BoldTrail as a plain New Lead (ADDED
 *      2026-08-03 — task #68) — runs for EVERY new GHL lead regardless of
 *      source, before the Facebook-only gate below, guarded by a
 *      "pushed-to-boldtrail" tag so re-fires don't create duplicates.
 *      BoldTrail's own "GR New Construction Buyer - New Lead Cadence"
 *      Smart Campaign then owns the SMS + call-task cadence from there.
 *   5. Bails out cleanly (200, no further action) if: not Facebook-sourced,
 *      already has the "instant-touch-sent" tag (idempotency — GHL can and
 *      does fire workflows more than once for the same event), or is
 *      suppressed (GHL's own dnd flag or an explicit STOP tag — this is the
 *      ONE suppression source reachable from here; the LOCAL dnc.txt on
 *      Gus's PC is not reachable from Render, but a contact that was
 *      created seconds ago cannot possibly already be on that list, so
 *      this is a real, not just theoretical, non-issue for this flow).
 *   6. Computes hot/warm/cold from the readiness custom field (same logic
 *      as server.js's ghlLeadTemperature), applies the matching
 *      readiness-* tag AND an "instant-touch-sent" tag.
 *   7. Sends touch #1 EMAIL ONLY (SMS DISABLED 2026-08-03 — BoldTrail's
 *      Smart Campaign now sends the instant text instead; texting here too
 *      would double-text the lead). Touch #1 content for hot/warm/cold is
 *      duplicated here from server.js's SEQUENCES[tier][0] — if that
 *      content ever changes, update it here too. Kept to just this one
 *      step deliberately, so there's only one thing to keep in sync, not
 *      the whole sequence.
 *
 * WHY "instant-touch-sent" MATTERS to the OTHER system: server.js's
 * run_sequence_engine, when it later sees this contact for the first time
 * (already tagged, thanks to this file), needs to know NOT to re-send
 * touch #1 — see the matching change in server.js's handleRunSequenceEngine
 * that checks for this tag and initializes new entries at step:1 instead
 * of step:0 when it's present.
 */

import http from "http";

const PORT = process.env.PORT || 3000;
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || null;
const GHL_API_KEY = process.env.GHL_API_KEY || null;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || null;
const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "2021-07-28";

// ADDED 2026-08-03 (Gus's rewire decision: "BoldTrail owns it, GHL steps
// back"). BoldTrail's Public API only supports contact create/update, not
// messaging — so BoldTrail can't be triggered from server.js the way GHL
// is. Instead: every new GHL lead gets pushed into BoldTrail as a plain
// New Lead the instant it's created (below), and BoldTrail's own native
// "GR New Construction Buyer - New Lead Cadence" Smart Campaign (UI-
// configured, Starts When: Status IS New Lead) takes it from there —
// that's what actually sends the SMS + call-task cadence now, free,
// entirely on kvCORE's own servers. This service's job narrows to: push
// the contact, then (Facebook-sourced leads only) send the one real-time
// email touch. It must NOT also text — see SMS DISABLED note below.
const BOLDTRAIL_TOKEN = process.env.BOLDTRAIL_API_TOKEN || null;
const BOLDTRAIL_BASE = "https://api.kvcore.com/v2/public";
const PUSHED_TO_BOLDTRAIL_TAG = "pushed-to-boldtrail";

const GHL_READINESS_FIELD_ID = "5Ki01GIRnf1Lp0z6k1SE";
const GHL_CONSENT_FIELD_ID = "c1e2KGBr92A5BWNTylGZ";
const INSTANT_TOUCH_TAG = "instant-touch-sent";
const READINESS_TAGS = { hot: "readiness-hot", warm: "readiness-warm", cold: "readiness-cold" };
// ADDED 2026-08-12 — see ghlExplicitlyDeclinedContact() below for why this exists.
const DECLINED_CONTACT_TAG = "declined-contact-do-not-automate";
// ADDED 2026-08-12 (Gus: "Is Dakota able to call all those last leads?").
// Investigated the "0. New Construction - New Lead Calls" GHL workflow
// (the one with the Voice AI outbound call step / Dakota) and found its
// Facebook Lead Form Submitted trigger is pinned to a specific Page+Form ID
// that has drifted from the live form (task #57 cloned the lead form to add
// the TCPA question, giving it a new formId) — enrollment history showed
// exactly 3 contacts EVER enrolled, all manual test enrollments, ZERO real
// leads. This tag is the fix: applied here (same place/condition as the
// P.S. opt-in text below — raw.phone present AND consentOnFile true) and a
// new "Contact tag added" trigger on this tag was added to that workflow so
// enrollment no longer depends on Meta's form ID staying put. Deliberately
// NOT the same tag as INSTANT_TOUCH_TAG above — that one is applied to
// every Facebook lead regardless of consent, which would re-create the
// jojo124 problem (calling people who said no) if used as the call trigger.
const VOICE_CALL_OK_TAG = "voice-call-ok";
const SMS_OPTIN_URL = "https://consent-r7gu.onrender.com";

// ADDED 2026-08-13 (task #114, follow-up to today's Zillow-style consent fix —
// see the "New Construction - Consent Disclaimer" form work). The old form
// (1038574668870615) had consent as its OWN Yes/No question, mapped to
// GHL_CONSENT_FIELD_ID — that's what ghlConsentValue() below reads. The new
// form removes that question entirely and instead shows the same TCPA
// language as a mandatory disclaimer directly above Submit (can't submit
// without it) — so there is no longer any customField answer to check for
// leads from this form. Without this override, every new-form lead would
// read as consent_on_file=false (no matching customField = "not found" =
// false), silently undoing the whole point of moving to the disclaimer
// pattern. The live ad ("New Construction 2026" > Ad set 1 > Ad 1, account
// 1455220332587658) was repointed at this form today — confirmed via a real
// GHL contact's attributionSource.formId, which is where this reads from
// (present on every GHL contact created via a Facebook Lead Ads form,
// verified via dump_raw_ghl_contact on a live lead before this change).
// UPDATED 2026-08-24 (Salomon): original ID was stale (form-ID churn — the
// ad was re-pointed at a new consent-disclaimer form after this override was
// written for the old one). Confirmed current ID via two real submissions
// pulled from Meta's Leads Center "Form answers" panel (Felix Romero Aug 9,
// Juan Manuel Estrada Aug 12 — both show "Lead form ID 1038574668870615").
// Keeping the old ID too in case any already-synced contacts reference it.
const NEW_CONSENT_FORM_IDS = ["1038574668870615", "1353472936962934"];

// FIXED 2026-08-27 (task #162, ported from server.js's identical fix — see
// that file's comment on this same function for the full incident writeup).
// `attributionSource?.formId || lastAttributionSource?.formId` short-circuits
// on the first truthy value, so a contact whose ORIGINAL first-touch form
// differs from their later real disclaimer-form submission never got the
// second field checked at all. Now checks both and matches on either.
function submittedViaConsentDisclaimerForm(raw) {
  const formIds = [raw?.attributionSource?.formId, raw?.lastAttributionSource?.formId].filter(
    Boolean
  );
  return formIds.some((id) => NEW_CONSENT_FORM_IDS.includes(id));
}

// ADDED 2026-08-07 (Gus: "that also captures them on BT but it shows them
// houses available in their area" — this was NOT already wired anywhere.
// Checked every email template in this file and in server.js's full
// sequence engine: none of them contained a link to Gus's own site. The
// only link anywhere in the built system was the SMS opt-in link above.
// This is his real BoldTrail-hosted IDX site (confirmed live 2026-08-07) —
// has a working MLS/city/zip/beds/baths search box, and because it's
// BoldTrail's own IDX, browsing activity there gets captured back into
// BoldTrail against the lead's record natively, no extra wiring needed.
//
// UPDATED same day: Gus flagged that a bare homepage link doesn't match
// what the ad promises ("New construction in Palm Desert & the Coachella
// Valley") — a lead expecting Palm Desert homes shouldn't land on a
// generic search box. Ran the site's own Palm Desert search live and
// captured the resulting results-page URL (608 live results confirmed
// 2026-08-07) rather than guessing a query-string format. Checked the
// site's own filter panel for a "new construction" toggle — it only has
// Home Type (Single Family/Condos/Multi-Family/Land/Townhouse) and listing
// status (Active/Pending/Contingent/etc.), no construction-age filter — but
// Gus correctly flagged that 608 results (nearly every listing in Palm
// Desert, most of them resale) is spam, not the new-construction shortlist
// the ad promises.
//
// UPDATED AGAIN same day: found a real proxy — a "Min Year Built" filter
// under More Filters, confirmed working via its query param (yearbuilt=).
// Set to 2025+ live and got 14 results (confirmed 2026-08-07), several
// shown as builder elevation renderings/spec homes — i.e. the actual new
// inventory the ad is about, not resale stock. Also tried a keywords=new
// construction search first to see if remarks-text search would work
// instead — it didn't filter at all (still returned all 607), so the
// keyword field only matches location/MLS#/address, not remarks. Year
// Built 2025+ is the closest honest filter this IDX template supports.
const HOME_SEARCH_URL =
  "https://gustavoruvalcaba.thegrgroup.net/index.php?advanced=1&display=Palm+Desert&min=0&max=100000000&beds=0&baths=0&minfootage=0&maxfootage=30000&minacres=0&maxacres=0&yearbuilt=2025&maxyearbuilt=0&walkscore=0&keywords=&areas%5B%5D=city%3Apalm+desert&sortby=listings.price+DESC&rtype=map";

// ADDED 2026-08-05 (Gus's "get this running right" request, after discovering
// the Cowork-scheduled hot-lead-instant-alert task — the thing that used to
// text HIM "CALL NOW" — only runs while his Claude app is open, and had gone
// silent for 23.5 hours). This webhook was already always-on and already
// reliably contacts the LEAD (email here + BoldTrail's own SMS/call-task),
// laptop or no laptop. What it never did is personally ping Gus. This does
// that, for hot leads only (the ones where the 5-minute rule actually
// matters), using Gus's own GHL contact record as the SMS target — same
// sendSms() helper below, just pointed at him instead of the lead.
// GUS_CONTACT_ID is his existing self-record (id DXu3cyGnSL3zy1X0FUKx,
// phone +17084919433) already present in this GHL account.
const GUS_CONTACT_ID = process.env.GUS_GHL_CONTACT_ID || "DXu3cyGnSL3zy1X0FUKx";
const GUS_NOTIFY_ENABLED = process.env.GUS_NOTIFY_ENABLED !== "false";

// ADDED 2026-09-08 (task #187, Gus's exact instruction: "when she calls and
// no answer, she sends a text as well to those that didnt answer. and to
// those that picked up, send a thank you text for talking her call").
//
// THE PROBLEM THIS WORKS AROUND: GHL's Voice AI outbound call action (the
// one that drives Dakota) exposes NO answered/voicemail/no-answer field
// anywhere reachable from the workflow's own If/Else branch builder — every
// category in that field picker (Contact details, Company, Date/Time,
// Workflow trigger, Workflow contact, Events, Custom values) was searched
// and none of them carry a call-disposition signal. The ONLY place any
// call-related data surfaces at all is the separate "Webhook" action's
// Custom Data merge-field picker, under a "Message > Phone Call" category:
// Phone Call Direction, Duration, From, To, From City — durations, not a
// disposition flag.
//
// THE PROXY: Phone Call Duration is the only signal available, so it's used
// as a stand-in for answered-vs-not. A call that's actually picked up and
// talked to (even briefly) reliably runs well past the ring + Dakota's
// opening line; a call that hits voicemail-and-hangs-up or goes unanswered
// does not. Threshold picked deliberately on the conservative side (a
// borderline call counts as "no answer", not "answered") because a wrongly
// premature "thanks for chatting!" text to someone who never actually
// talked is a worse, more visible bad experience than an extra "sorry I
// missed you" text to someone who did pick up.
const CALL_ANSWERED_DURATION_THRESHOLD_SECONDS = 45;

// Idempotency: this workflow (once task #186's cadence rebuild lands) calls
// a no-answer contact multiple times across multiple days. Texting "sorry I
// missed you" after EVERY single no-answer attempt would mean up to a dozen+
// near-identical texts to someone who's never once answered — sent once per
// contact, not once per call attempt. Same reasoning for the thank-you text
// (guards against GHL re-firing the same webhook event, a documented
// behavior elsewhere in this file, and against a contact who gets called
// again later for an unrelated reason). Gus: if you actually want a fresh
// "missed you" text after every single no-answer attempt instead of just
// the first, say so and this guard comes out.
const NO_ANSWER_TEXT_SENT_TAG = "dakota-no-answer-text-sent";
const CALL_THANKYOU_TEXT_SENT_TAG = "dakota-call-thankyou-text-sent";

// Wording updated 2026-09-08 (task #187 follow-up, per Gus's request) to
// match Dakota's repositioning (task #169/#182) away from
// new-construction-only framing to a general home-buying agent — the
// no_answer text no longer name-drops "new construction homes".
const CALL_OUTCOME_SMS = {
    no_answer: [
          "Hi {{FIRST_NAME}}, this is Dakota with GR Group -- sorry I missed you! Happy to help with your home search in the Coachella Valley whenever works for you. Call or text me back anytime, or browse what's available now: {{HOME_SEARCH_URL}}",
          "Hi {{FIRST_NAME}}, Dakota here from GR Group -- just tried calling! No worries if now's not a good time. Whenever you're ready, I'm happy to help with your home search: {{HOME_SEARCH_URL}} -- or just text me back.",
          "Hi {{FIRST_NAME}}, this is Dakota with GR Group, sorry we missed each other on the phone. Take a look at what's out there when you get a chance: {{HOME_SEARCH_URL}} -- reply anytime and I'll help however I can.",
          "Hey {{FIRST_NAME}}, it's Dakota from GR Group -- tried reaching you just now. No rush at all, just wanted to say I'm here whenever you want to talk homes. Browse current options here: {{HOME_SEARCH_URL}}",
        ],
    answered: [
          "Hi {{FIRST_NAME}}, thanks for taking my call just now! This is Dakota with GR Group. If anything comes to mind after we talked, just reply here -- happy to help.",
          "Hi {{FIRST_NAME}}, this is Dakota with GR Group -- really appreciated the chat just now. Reach out anytime if something comes up, I'm just a text away.",
          "Hey {{FIRST_NAME}}, Dakota here from GR Group. Thanks for the time on the phone! Feel free to reply here with any questions as things come up.",
          "Hi {{FIRST_NAME}}, thanks again for chatting with me -- Dakota with GR Group. Don't hesitate to text if anything else comes to mind.",
        ],
};

function pickSmsVariant(disposition) {
    const variants = CALL_OUTCOME_SMS[disposition];
    return variants[Math.floor(Math.random() * variants.length)];
}

// Duplicated from server.js SEQUENCES[tier][0] — see the file header note.
const TOUCH_ONE = {
  hot: {
    subject: "Let's get you into a new construction home",
    sms: "Hi {{FIRST_NAME}}, this is Gus w/ GR Group — got your new construction inquiry. Browse what's actually available now: {{HOME_SEARCH_URL}} — I can also pull current builder incentives. Good time to talk today or tmrw? -Gus",
    body: `Hi {{FIRST_NAME}},

Thanks for reaching out about new construction in the Coachella Valley — sounds like you're ready to move soon, so I want to help you move fast.

Take a look at what's actually available right now (not just listed — available): {{HOME_SEARCH_URL}}

I can also pull whatever builder incentives are live this week. Fastest way to do this well is a short call.

What's the best number and time to reach you today or tomorrow?

Talk soon,
Gus`,
  },
  warm: {
    subject: "Good to connect — here's what happens next",
    sms: "Hi {{FIRST_NAME}}, this is Gus w/ GR Group. Got your new construction inquiry — no rush. Feel free to browse what's out there: {{HOME_SEARCH_URL}} — I'll send a few useful things over the next few weeks. Reply anytime w/ Qs. -Gus",
    body: `Hi {{FIRST_NAME}},

Thanks for your interest in new construction in the Coachella Valley. Sounds like you're planning ahead rather than needing something immediately — honestly the smart way to do this, since it gives you more time to find the right fit.

Feel free to start browsing what's out there whenever you'd like: {{HOME_SEARCH_URL}}

Over the next few weeks I'll send a few short, useful things: how the new-construction process actually works, current incentives, and what to look for before you sign anything. No pressure — reply anytime you have a question.

Talk soon,
Gus`,
  },
  cold: {
    subject: "Got your info — no rush",
    sms: "Hi {{FIRST_NAME}}, this is Gus w/ GR Group. Got your new construction inquiry — no rush at all. Whenever you're curious, browse what's out there: {{HOME_SEARCH_URL}} — I'll check in occasionally w/ anything useful. Reply anytime. -Gus",
    body: `Hi {{FIRST_NAME}},

Thanks for checking out new construction homes. Sounds like you're still early in the process, which is completely fine — no rush at all, and no pressure from me.

Whenever you're curious, feel free to browse what's out there: {{HOME_SEARCH_URL}}

I'll check in every so often with something useful, and I'm always just a reply away if that changes.

Talk soon,
Gus`,
  },
};

function firstNameOf(fullName) {
  const n = String(fullName || "").trim().split(/\s+/)[0];
  return n || "there";
}

function renderTemplate(str, firstName) {
  return String(str)
    .replace(/\{\{FIRST_NAME\}\}/g, firstName)
    .replace(/\{\{HOME_SEARCH_URL\}\}/g, HOME_SEARCH_URL);
}

async function ghlFetch(pathStr, options = {}) {
  if (!GHL_API_KEY || !GHL_LOCATION_ID) {
    throw new Error("GHL_API_KEY / GHL_LOCATION_ID not set in this service's environment");
  }
  const res = await fetch(`${GHL_BASE}${pathStr}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      Version: GHL_API_VERSION,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GHL API ${res.status}: ${text}`);
  }
  return res.json();
}

async function btFetch(pathStr, options = {}) {
  if (!BOLDTRAIL_TOKEN) {
    throw new Error("BOLDTRAIL_API_TOKEN not set in this service's environment");
  }
  const res = await fetch(`${BOLDTRAIL_BASE}${pathStr}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${BOLDTRAIL_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // ADDED 2026-08-10: attach the raw status so callers (pushContactToBoldTrail's
    // 409 upsert fallback below) can branch on it without re-parsing the message.
    const err = new Error(`BoldTrail API ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Pushes a brand-new GHL contact into BoldTrail as a plain New Lead —
// status is intentionally omitted from the payload; server.js's
// handlePushNewLead / statusLabel() confirm an absent status displays as
// "New Lead" in BoldTrail, which is exactly what the cloned campaign's
// "Starts When: Status IS New Lead" trigger is listening for. Uses the
// singular "/contact" (POST) endpoint — confirmed against apidocs.kvcore.com
// in server.js on 2026-07-27 after the plural form 404'd live; duplicated
// here since this is a separate deployed service with no shared module.
async function pushContactToBoldTrail(raw, name) {
  const firstName = raw.firstName || firstNameOf(name);
  const lastName = raw.lastName || "";
  // BUG FIX (2026-08-10): kvcore's contact field is "cell_phone_1", not
  // "phone" — sending "phone" was silently dropped by the API, so every
  // lead pushed through this webhook landed in BoldTrail with no phone
  // number at all, even when GHL had a verified one. Confirmed by
  // dumping a raw GHL contact whose phone was present at the instant of
  // creation, yet showed up null on the BoldTrail side.
  const payload = {
    first_name: firstName || "Unknown",
    last_name: lastName,
    email: raw.email || undefined,
    cell_phone_1: raw.phone || undefined,
    source: "GHL",
  };
  try {
    const data = await btFetch("/contact", { method: "POST", body: JSON.stringify(payload) });
    const contactId = data.id || data.data?.id || null;
    return { pushed: true, boldtrail_contact_id: contactId };
  } catch (err) {
    // ADDED 2026-08-10 (Gus: "they are not putting their number in" — this is
    // the other half of that bug. This runs for EVERY new GHL lead, so a
    // returning contact — same email from a prior import/visit — 409s on
    // create with no upsert support, and before this fix that error just got
    // logged and swallowed: the existing BoldTrail record's phone/name never
    // got corrected with what the new GHL lead actually submitted. Now: on
    // 409, search BoldTrail by email and PUT-update that record instead.
    // Same "email can match more than one person" disambiguation as
    // server.js's handlePushNewLead — only auto-resolve on an unambiguous
    // match, never guess and overwrite the wrong person.
    if (err.status !== 409 || !payload.email) throw err;
    const params = new URLSearchParams({ search: payload.email, limit: "20" });
    const found = await btFetch(`/contacts?${params}`);
    const candidates = found.data || found.contacts || found || [];
    let existingId = null;
    if (candidates.length === 1) {
      existingId = candidates[0].id;
    } else if (candidates.length > 1) {
      const nameNorm = `${firstName || ""} ${lastName || ""}`.trim().toLowerCase();
      const nameMatches = candidates.filter((c) => {
        const cName = c.name || `${c.first_name || ""} ${c.last_name || ""}`.trim();
        return String(cName).trim().toLowerCase() === nameNorm;
      });
      if (nameMatches.length === 1) existingId = nameMatches[0].id;
    }
    if (!existingId) throw err; // can't safely resolve — surface the original 409
    const current = await btFetch(`/contact/${existingId}`);
    const c = current.data || current;
    const updatePayload = {
      email: payload.email || c.email,
      cell_phone_1: payload.cell_phone_1 || c.cell_phone_1 || c.cell_phone_2 || c.home_phone || c.work_phone || undefined,
      first_name: payload.first_name || c.first_name,
      last_name: payload.last_name || c.last_name,
    };
    const updated = await btFetch(`/contact/${existingId}`, { method: "PUT", body: JSON.stringify(updatePayload) });
    return { pushed: true, updated: true, boldtrail_contact_id: updated.id || updated.data?.id || existingId };
  }
}

// ADDED 2026-08-10 (Gus: "I don't see any follow up... going on" — he only
// looks at BoldTrail, and nothing this service does ever wrote back to it).
// PUT /contact/{id}/action/note with {title, details} — confirmed same
// endpoint/shape as server.js's handleLogContactNote 2026-07-27. Best-effort:
// caller wraps this in its own try/catch so a note-logging failure never
// blocks the actual email send it's describing.
async function logBoldTrailNote(boldtrailContactId, title, details) {
  await btFetch(`/contact/${boldtrailContactId}/action/note`, {
    method: "PUT",
    body: JSON.stringify({ title, details }),
  });
}

function ghlReadinessValue(customFields) {
  const f = (customFields || []).find((cf) => cf.id === GHL_READINESS_FIELD_ID);
  return f ? String(f.value) : null;
}

// BUG FIX (2026-08-10): the field's two real answer options are
// ["Yes", "I agree"] and ["No", "please don't contact me"] — the OLD check
// below ("array non-empty = consent") was true for BOTH, so every lead who
// explicitly answered "No, please don't contact me" was still marked
// consent_on_file=true / phone_outreach_ok=true. Found live auditing real
// leads through this exact webhook: Mary Gale and Armando Gonzalez Lugo
// both answered "No" and both showed as consented. Explicit "no" now always
// wins over any other signal in the array — same fix as server.js's
// ghlConsentValue, duplicated here since this is a separate deployed
// service with no shared module.
function ghlConsentValue(raw) {
  // ADDED 2026-08-13 — see NEW_CONSENT_FORM_ID comment above. Submitting this
  // form IS the consent signal (mandatory disclaimer, no way to submit
  // without agreeing) — there is no separate question left to read.
  if (submittedViaConsentDisclaimerForm(raw)) return true;
  const f = (raw?.customFields || []).find((cf) => cf.id === GHL_CONSENT_FIELD_ID);
  if (!f) return false;
  const v = f.value;
  const values = (Array.isArray(v) ? v : [v]).map((x) => String(x ?? "").trim().toLowerCase());
  if (values.some((x) => x === "no" || x.includes("don't contact") || x.includes("do not contact"))) {
    return false;
  }
  if (values.some((x) => x === "yes" || x.includes("i agree"))) {
    return true;
  }
  if (typeof v === "boolean") return v;
  return values.some((x) => x.length > 0);
}

// ADDED 2026-08-12 (real incident, not theoretical): jojo124
// (jcina6653@gmail.com) answered "No, please don't contact me" on this
// exact question, GHL correctly recorded consent_on_file=false, but this
// service still pushed him into BoldTrail as a plain New Lead — and
// BoldTrail's own "GR New Construction Buyer - New Lead Cadence" Smart
// Campaign (native BoldTrail automation, triggers on Status IS New Lead,
// has no knowledge of this GHL field at all) texted him anyway 15 hours
// later. He had to reply STOP himself. A second contact the same day
// (Frances Fantore, same "No" answer) was saved only by coincidence — her
// number happened to already be on BoldTrail's National DNC Registry
// check, which is unrelated to this question and not something every
// declining lead's number will hit.
//
// Root cause: BoldTrail's Smart Campaign is a separate, native automation
// this service cannot see or gate from the outside once a contact is
// pushed in as "New Lead" — there is no known BoldTrail API field to mark
// a contact do-not-contact for our own reasons (its DNC flag is registry-
// derived, not settable per our own consent logic), and no reliable way to
// beat the campaign's send with an after-the-fact status change (confirmed
// varying delay: ~1 minute for Frances, ~15 hours for jojo124 — too
// unpredictable to race against).
//
// Fix: never hand an explicit decliner to BoldTrail's automation at all.
// ghlConsentValue() answers "is texting/automation OK" (false covers both
// "said no" and "no answer yet"); this answers the narrower question "did
// they affirmatively say no" — used below to skip the BoldTrail push and
// our own email touch entirely for that group, rather than pushing them
// into a pipeline this service doesn't control the automation of.
// FIXED 2026-08-25 (real, live incident — found while verifying a server.js
// port of this same function against jojo124 himself, the contact this
// whole function was originally written for). The ADDED 2026-08-13
// short-circuit below — "no separate question exists on the disclaimer
// form, submitting it means they agreed" — was WRONG for jojo124: his
// formId (1038574668870615) is in NEW_CONSENT_FORM_IDS, but he also has a
// real customFields answer of ["No", "please don't contact me"], meaning
// that form ID was reused/shared with a version that DID ask a real
// question. The shortcut fired and hid his own explicit decline behind an
// assumption about the form — meaning this function has been returning
// false for him this whole time, and DECLINED_CONTACT_TAG was never
// applied by this webhook despite the "real incident" comment above citing
// him by name. Removing the shortcut is safe: when no consent customField
// exists at all (the genuine disclaimer-only case), `if (!f) return false`
// below already gives the same correct answer — the shortcut only ever
// changed the outcome when real decline evidence was present, which must
// never be overridden by an assumption about what a form asks.
function ghlExplicitlyDeclinedContact(raw) {
  const f = (raw?.customFields || []).find((cf) => cf.id === GHL_CONSENT_FIELD_ID);
  if (!f) return false;
  const v = f.value;
  const values = (Array.isArray(v) ? v : [v]).map((x) => String(x ?? "").trim().toLowerCase());
  return values.some((x) => x === "no" || x.includes("don't contact") || x.includes("do not contact"));
}

function leadTemperature(readiness) {
  if (readiness === "NOW!") return "hot";
  if (readiness === "1-3 Months" || readiness === "3-6 Months") return "warm";
  return "cold";
}

// The webhook body's exact shape is unverified until the first real GHL
// trigger fires — this tries every field name GHL is known to use across
// different workflow/webhook action configurations rather than guessing one
// and silently failing on the others.
function extractContactId(body) {
  return (
    body?.contact_id ||
    body?.contactId ||
    body?.id ||
    body?.contact?.id ||
    body?.customData?.contact_id ||
    body?.customData?.contactId ||
    null
  );
}

// ADDED 2026-09-08 (task #187) — same defensive multi-shape approach as
// extractContactId above: the exact key name GHL sends depends on what the
// Webhook action's Custom Data section is configured with, which is
// unverified until the workflow side is actually wired up (see the Webhook
// action setup note above handleCallOutcomeWebhook). Tries every plausible
// name for the duration merge field rather than guessing one.
function extractCallDurationSeconds(body) {
  const raw =
    body?.duration ??
    body?.call_duration ??
    body?.callDuration ??
    body?.phone_call_duration ??
    body?.customData?.duration ??
    body?.customData?.call_duration ??
    null;
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// ADDED 2026-09-08 (task #187). Fires once per Dakota call attempt (both
// answered and no-answer outcomes route through here) — see the Webhook
// action setup note near CALL_ANSWERED_DURATION_THRESHOLD_SECONDS above for
// the GHL-side wiring this expects: a "Webhook" action added immediately
// after each "Voice AI outbound call" (Dakota) step in the
// "0. New Construction - New Lead Calls" workflow, POSTing to
// /call-outcome-webhook?token=... with Custom Data containing at minimum
// the contact id and the Phone Call Duration merge field.
async function handleCallOutcomeWebhook(body) {
  const contactId = extractContactId(body);
  if (!contactId) {
    console.error("call-outcome webhook: no contact id found in body:", JSON.stringify(body));
    return { ok: false, reason: "no contact id in payload", raw_body_logged: true };
  }

// FIXED 2026-09-09 (task #189, confirmed via live call log): GHL sends an
    // empty string for the Phone Call Duration merge field when the call never
    // connected (no answer) rather than "0" -- treating that as "missing data"
    // and aborting meant the no-answer text could never fire, which was the
    // actual reason texts weren't sending on real calls. Empty/missing duration
    // is now treated as 0 seconds (no_answer), matching what it really means.
    const extractedDuration = extractCallDurationSeconds(body);
    const durationSeconds = extractedDuration === null ? 0 : extractedDuration;

  const data = await ghlFetch(`/contacts/${contactId}`);
  const raw = data.contact || data;
  const name =
    `${raw.firstName || ""} ${raw.lastName || ""}`.trim() || raw.contactName || raw.name || "";
  const firstName = firstNameOf(name);
  const tags = (raw.tags || []).map((t) => String(t).toLowerCase());

  // Same consent/suppression gate as the lead webhook above — server.js's
  // ghlSendSms comment is explicit that nothing may text a contact without
  // this check, and it is NOT re-verified inside sendSms() itself.
  const consentOnFile = ghlConsentValue(raw);
  const phoneOutreachOk = Boolean(raw.phone && consentOnFile);
  const stoppedInGhl = tags.some((t) => /unsubscribed|opt[- ]?out|replied\s*"?stop"?/i.test(t));
  const suppressed = Boolean(raw.dnd) || stoppedInGhl;

  const answered = durationSeconds >= CALL_ANSWERED_DURATION_THRESHOLD_SECONDS;
  const disposition = answered ? "answered" : "no_answer";
  const dedupeTag = answered ? CALL_THANKYOU_TEXT_SENT_TAG : NO_ANSWER_TEXT_SENT_TAG;
  const alreadySent = tags.includes(dedupeTag);

  if (!phoneOutreachOk || suppressed || alreadySent) {
    return {
      ok: true,
      skipped: true,
      reason: !phoneOutreachOk
        ? "phone_outreach_ok is false (no consent on file or no phone)"
        : suppressed
        ? "suppressed (GHL dnd flag or STOP tag)"
        : `already sent (${dedupeTag} tag present) — idempotency guard, one ${disposition} text per contact`,
      contact_id: contactId,
      name,
      duration_seconds: durationSeconds,
      disposition,
    };
  }

  const smsText = renderTemplate(pickSmsVariant(disposition), firstName);
  let smsSent = false;
  let smsError = null;
  try {
    await sendSms(contactId, smsText);
    smsSent = true;
    await addTags(contactId, [dedupeTag]);
  } catch (err) {
    smsError = err.message;
    console.error(`Failed to send ${disposition} SMS to contact ${contactId}:`, err.message);
  }

  return {
    ok: true,
    skipped: false,
    contact_id: contactId,
    name,
    duration_seconds: durationSeconds,
    disposition,
    sms_sent: smsSent,
    sms_error: smsError,
    sms_text: smsText,
  };
}

async function addTags(contactId, tags) {
  await ghlFetch(`/contacts/${contactId}/tags`, {
    method: "POST",
    body: JSON.stringify({ tags }),
  });
}

async function sendEmail(contactId, subject, html) {
  return ghlFetch(`/conversations/messages`, {
    method: "POST",
    body: JSON.stringify({ type: "Email", contactId, subject, html }),
  });
}

// SMS DISABLED 2026-08-03 (Gus's rewire decision). This function is kept,
// not deleted, so re-enabling is a one-line change if the split ever
// reverts — but nothing below calls it anymore. See the BOLDTRAIL_TOKEN
// comment near the top of this file for the full reasoning.
async function sendSms(contactId, message) {
  return ghlFetch(`/conversations/messages`, {
    method: "POST",
    body: JSON.stringify({ type: "SMS", contactId, message }),
  });
}

// ADDED 2026-08-05 — see GUS_CONTACT_ID comment above. Best-effort and
// deliberately isolated (own try/catch at the call site): a failure here
// must never affect the lead-facing email/BoldTrail-push work above it,
// which is the actually load-bearing part of this handler.
async function notifyGusHotLead(name, phone) {
  const who = name || "Unknown name";
  const ph = phone || "no phone on file";
  const message = `CALL NOW - ${who}, ${ph}, hot lead. Instant email sent, BoldTrail texting them now too.`;
  return sendSms(GUS_CONTACT_ID, message);
}

async function handleLeadWebhook(body) {
  const contactId = extractContactId(body);
  if (!contactId) {
    console.error("No contact id found in webhook body:", JSON.stringify(body));
    return { ok: false, reason: "no contact id in payload", raw_body_logged: true };
  }

  const data = await ghlFetch(`/contacts/${contactId}`);
  const raw = data.contact || data;
  const name =
    `${raw.firstName || ""} ${raw.lastName || ""}`.trim() || raw.contactName || raw.name || "";
  const tags = (raw.tags || []).map((t) => String(t).toLowerCase());
  const source = raw.source || null;

  // ADDED 2026-08-12 (real incident — see ghlExplicitlyDeclinedContact()
  // comment above for the full jojo124 story). This check runs BEFORE the
  // BoldTrail push and BEFORE the email touch, and skips both entirely —
  // no automated system this service controls should touch someone who
  // explicitly said not to contact them, and pushing them into BoldTrail
  // as a "New Lead" is exactly what handed them to BoldTrail's own
  // Smart Campaign automation last time. Still tags them in GHL (so
  // there's a visible record and Gus can decide on a manual, compliant
  // follow-up if any) and returns early — deliberately does NOT touch
  // PUSHED_TO_BOLDTRAIL_TAG or INSTANT_TOUCH_TAG, so if this logic is ever
  // wrong for a given contact, re-running the webhook won't be blocked by
  // an idempotency guard meant for a different case.
  if (ghlExplicitlyDeclinedContact(raw) && !tags.includes(DECLINED_CONTACT_TAG)) {
    await addTags(contactId, [DECLINED_CONTACT_TAG]).catch((err) =>
      console.error(`Contact ${contactId} declined contact but failed to tag it in GHL:`, err.message)
    );
    console.error(`Contact ${contactId} (${name}) explicitly declined contact — not pushed to BoldTrail, no automated touch sent.`);
    return {
      ok: true,
      skipped: true,
      reason: "explicit no-contact consent answer — not pushed to BoldTrail (its Smart Campaign has no consent check of its own), no automated email sent",
      contact_id: contactId,
      name,
    };
  }

  // TASK #68 (2026-08-03): push every new GHL lead into BoldTrail
  // immediately, regardless of source — this runs before the
  // Facebook-only gate below, unlike the email touch. Idempotency guard:
  // skip if already tagged (GHL can and does fire "Contact Created" more
  // than once for the same contact).
  let boldtrailResult = null;
  if (!tags.includes(PUSHED_TO_BOLDTRAIL_TAG)) {
    boldtrailResult = await pushContactToBoldTrail(raw, name).catch((err) => ({ error: err.message }));
    if (!boldtrailResult?.error) {
      await addTags(contactId, [PUSHED_TO_BOLDTRAIL_TAG]).catch((err) =>
        console.error(`Pushed ${contactId} to BoldTrail but failed to tag it in GHL:`, err.message)
      );
    } else {
      console.error(`BoldTrail push failed for contact ${contactId}:`, boldtrailResult.error);
    }
  } else {
    boldtrailResult = { pushed: false, reason: "already pushed (idempotency guard)" };
  }

  if (!source || String(source).toLowerCase() !== "facebook") {
    return {
      ok: true,
      skipped: true,
      reason: `source is "${source}", not facebook`,
      contact_id: contactId,
      name,
      boldtrail: boldtrailResult,
    };
  }
  if (tags.includes(INSTANT_TOUCH_TAG)) {
    return {
      ok: true,
      skipped: true,
      reason: "already instant-touched (idempotency guard)",
      contact_id: contactId,
      name,
      boldtrail: boldtrailResult,
    };
  }
  const stoppedInGhl = tags.some((t) => /unsubscribed|opt[- ]?out|replied\s*"?stop"?/i.test(t));
  const suppressed = Boolean(raw.dnd) || stoppedInGhl;
  if (suppressed) {
    return {
      ok: true,
      skipped: true,
      reason: "suppressed (GHL dnd flag or STOP tag)",
      contact_id: contactId,
      name,
      boldtrail: boldtrailResult,
    };
  }

  const readiness = ghlReadinessValue(raw.customFields);
  const tier = leadTemperature(readiness);
  const readinessTag = READINESS_TAGS[tier];
  const consentOnFile = ghlConsentValue(raw);
  const phoneOutreachOk = Boolean(raw.phone && consentOnFile);

  const tagsToApply = [readinessTag, INSTANT_TOUCH_TAG];
  if (phoneOutreachOk) tagsToApply.push(VOICE_CALL_OK_TAG);
  await addTags(contactId, tagsToApply);

  const firstName = firstNameOf(name);
  const template = TOUCH_ONE[tier];
  const subject = renderTemplate(template.subject, firstName);
  let html = renderTemplate(template.body, firstName).replace(/\n/g, "<br>");
  if (!phoneOutreachOk) {
    html +=
      `<br><br><span style="font-size:12px;color:#5A6175">P.S. — Prefer texts? ` +
      `<a href="${SMS_OPTIN_URL}">Tap here</a> to also get new listing alerts by text — reply STOP anytime to turn them off.</span>`;
  }

  const emailResult = await sendEmail(contactId, subject, html).catch((err) => ({ error: err.message }));

  // Log the send back to BoldTrail so it's visible where Gus actually looks.
  // Uses the id pushContactToBoldTrail already returned above — no extra
  // lookup needed here (unlike server.js's sequence engine, which only has a
  // GHL id and has to search BoldTrail by email to find this same id).
  let boldtrailNoteLogged = false;
  if (!emailResult?.error && boldtrailResult?.boldtrail_contact_id) {
    try {
      await logBoldTrailNote(
        boldtrailResult.boldtrail_contact_id,
        "Email Sent",
        `Instant touch #1 sent: "${subject}" (${tier} tier, via GHL webhook receiver).`
      );
      boldtrailNoteLogged = true;
    } catch (err) {
      console.error(`Failed to log BoldTrail note for contact ${contactId}:`, err.message);
    }
  }

  // SMS RE-ENABLED 2026-09-07 (Gus: "no text right after they submit the
  // form... get in front of the lead and a better chance to connect").
  // From 2026-08-03 to today this was deliberately OFF because BoldTrail's
  // "GR New Construction Buyer - New Lead Cadence" campaign also sends an
  // "Immediately" SMS once the contact is pushed in as a New Lead a few
  // lines above — sending here too would double-text. But "BoldTrail owns
  // it" only works if BoldTrail's side is actually fast, and Gus is now
  // reporting leads get no text right after submitting — this webhook
  // fires the instant Meta/GHL hands us the lead, before the BoldTrail
  // push even completes, so it will always beat BoldTrail's own campaign
  // trigger to the punch.
  //
  // IMPORTANT — this reintroduces the double-text risk this whole block
  // was built to avoid. Turning this back on is only safe if the
  // "Immediately" SMS step in BoldTrail's "GR New Construction Buyer - New
  // Lead Cadence" Smart Campaign is disabled (leave its call/task steps
  // running — just the SMS step). That's a BoldTrail-side change this
  // service can't make from here. Until that step is off, every consenting
  // lead gets texted twice within seconds of each other.
  let smsAttempted = false;
  let smsSent = false;
  let smsError = null;
  if (phoneOutreachOk) {
    smsAttempted = true;
    try {
      const smsText = renderTemplate(template.sms, firstName);
      await sendSms(contactId, smsText);
      smsSent = true;
      if (boldtrailResult?.boldtrail_contact_id) {
        try {
          await logBoldTrailNote(
            boldtrailResult.boldtrail_contact_id,
            "Text Sent",
            `Instant touch #1 SMS sent: "${smsText}" (${tier} tier, via GHL webhook receiver).`
          );
        } catch (err) {
          console.error(`Failed to log BoldTrail SMS note for contact ${contactId}:`, err.message);
        }
      }
    } catch (err) {
      smsError = err.message;
      console.error(`Failed to send instant SMS to contact ${contactId}:`, err.message);
    }
  }

  let gusNotified = false;
  let gusNotifyError = null;
  if (GUS_NOTIFY_ENABLED && tier === "hot") {
    try {
      await notifyGusHotLead(name, raw.phone);
      gusNotified = true;
    } catch (err) {
      gusNotifyError = err.message;
      console.error(`Failed to notify Gus about hot lead ${contactId}:`, err.message);
    }
  }

  return {
    ok: true,
    skipped: false,
    contact_id: contactId,
    name,
    tier,
    tag_applied: readinessTag,
    boldtrail: boldtrailResult,
    email_sent: !emailResult?.error,
    email_error: emailResult?.error || null,
    boldtrail_note_logged: boldtrailNoteLogged,
    sms_attempted: smsAttempted,
    sms_sent: smsSent,
    sms_error: smsError,
    sms_disabled: false,
    sms_note: phoneOutreachOk
      ? "Instant SMS sent from here — make sure BoldTrail's 'Immediately' SMS step is OFF or this lead gets texted twice."
      : "No SMS sent — phone_outreach_ok was false (no consent on file or no phone).",
    gus_notified: gusNotified,
    gus_notify_error: gusNotifyError,
  };
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end(
      "GR Group instant lead webhook receiver — POST /lead-webhook?token=... for new leads, " +
        "POST /call-outcome-webhook?token=... for post-Dakota-call outcome texts."
    );
  }

  if (req.method === "POST" && req.url.startsWith("/lead-webhook")) {
    const token = new URL(req.url, `http://${req.headers.host}`).searchParams.get("token");
    if (!WEBHOOK_TOKEN || token !== WEBHOOK_TOKEN) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "missing or wrong token" }));
    }

    let bodyStr = "";
    req.on("data", (chunk) => {
      bodyStr += chunk;
      if (bodyStr.length > 2e5) req.destroy();
    });
    req.on("end", async () => {
      let body = {};
      try {
        body = JSON.parse(bodyStr || "{}");
      } catch {
        console.error("Non-JSON webhook body received:", bodyStr);
      }
      console.error("Webhook received:", JSON.stringify(body));
      try {
        const result = await handleLeadWebhook(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error("Webhook handling error:", err.message);
        res.writeHead(200, { "Content-Type": "application/json" }); // 200 so GHL doesn't retry-storm
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // ADDED 2026-09-08 (task #187) — see handleCallOutcomeWebhook above for
  // what this expects GHL to POST and why. Mirrors the /lead-webhook route
  // exactly (token check, buffered body, 200-even-on-error so GHL doesn't
  // retry-storm) — deliberately not deduplicated into a shared helper so
  // the two webhook flows stay independently readable and editable.
  if (req.method === "POST" && req.url.startsWith("/call-outcome-webhook")) {
    const token = new URL(req.url, `http://${req.headers.host}`).searchParams.get("token");
    if (!WEBHOOK_TOKEN || token !== WEBHOOK_TOKEN) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "missing or wrong token" }));
    }

    let bodyStr = "";
    req.on("data", (chunk) => {
      bodyStr += chunk;
      if (bodyStr.length > 2e5) req.destroy();
    });
    req.on("end", async () => {
      let body = {};
      try {
        body = JSON.parse(bodyStr || "{}");
      } catch {
        console.error("Non-JSON call-outcome webhook body received:", bodyStr);
      }
      console.error("Call-outcome webhook received:", JSON.stringify(body));
      try {
        const result = await handleCallOutcomeWebhook(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error("Call-outcome webhook handling error:", err.message);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, () => {
  console.error(`GR Group instant lead webhook receiver running on port ${PORT}`);
});
