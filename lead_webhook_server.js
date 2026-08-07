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
const SMS_OPTIN_URL = "https://consent-r7gu.onrender.com";

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
// status (Active/Pending/Contingent/etc.), no construction-age filter, so
// this is the closest real match: every active Palm Desert listing.
const HOME_SEARCH_URL =
  "https://gustavoruvalcaba.thegrgroup.net/index.php?advanced=1&area_keyword=Palm+Desert&beds=0&baths=0&min=0&max=100000000&rtype=map#rslt";

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
    throw new Error(`BoldTrail API ${res.status}: ${text}`);
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
  const payload = {
    first_name: firstName || "Unknown",
    last_name: lastName,
    email: raw.email || undefined,
    phone: raw.phone || undefined,
    source: "GHL",
  };
  const data = await btFetch("/contact", { method: "POST", body: JSON.stringify(payload) });
  const contactId = data.id || data.data?.id || null;
  return { pushed: true, boldtrail_contact_id: contactId };
}

function ghlReadinessValue(customFields) {
  const f = (customFields || []).find((cf) => cf.id === GHL_READINESS_FIELD_ID);
  return f ? String(f.value) : null;
}

function ghlConsentValue(customFields) {
  const f = (customFields || []).find((cf) => cf.id === GHL_CONSENT_FIELD_ID);
  if (!f) return false;
  const v = f.value;
  if (Array.isArray(v)) return v.length > 0 && v.some((x) => String(x).trim());
  if (typeof v === "boolean") return v;
  return Boolean(String(v ?? "").trim());
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
    null
  );
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
  const consentOnFile = ghlConsentValue(raw.customFields);
  const phoneOutreachOk = Boolean(raw.phone && consentOnFile);

  await addTags(contactId, [readinessTag, INSTANT_TOUCH_TAG]);

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

  // SMS DISABLED 2026-08-03 (Gus's rewire decision: "BoldTrail owns it, GHL
  // steps back"). BoldTrail's "GR New Construction Buyer - New Lead
  // Cadence" campaign sends its own "Immediately" SMS touch the instant the
  // contact above is pushed in as a New Lead. Sending our own SMS here too
  // would double-text the lead within seconds of each other. Email touch
  // #1 above is unaffected — only outbound texting moved to BoldTrail.

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
    sms_attempted: false,
    sms_sent: false,
    sms_error: null,
    sms_disabled: true,
    sms_note: phoneOutreachOk
      ? "SMS disabled here — BoldTrail's Smart Campaign sends the instant text instead."
      : "SMS disabled here and phone_outreach_ok was false anyway.",
    gus_notified: gusNotified,
    gus_notify_error: gusNotifyError,
  };
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("GR Group instant lead webhook receiver — POST /lead-webhook?token=... to use.");
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

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, () => {
  console.error(`GR Group instant lead webhook receiver running on port ${PORT}`);
});
