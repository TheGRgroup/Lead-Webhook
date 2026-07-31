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
 *   4. Bails out cleanly (200, no action) if: not Facebook-sourced, already
 *      has the "instant-touch-sent" tag (idempotency — GHL can and does
 *      fire workflows more than once for the same event), or is suppressed
 *      (GHL's own dnd flag or an explicit STOP tag — this is the ONE
 *      suppression source reachable from here; the LOCAL dnc.txt on Gus's
 *      PC is not reachable from Render, but a contact that was created
 *      seconds ago cannot possibly already be on that list, so this is a
 *      real, not just theoretical, non-issue for this specific flow).
 *   5. Computes hot/warm/cold from the readiness custom field (same logic
 *      as server.js's ghlLeadTemperature), applies the matching
 *      readiness-* tag AND an "instant-touch-sent" tag.
 *   6. Sends touch #1 — email always, SMS too if the contact's GHL "SMS
 *      Consent Opt In" field is truthy (same phone_outreach_ok logic).
 *      Touch #1 content for hot/warm/cold is duplicated here from
 *      server.js's SEQUENCES[tier][0] — if that content ever changes,
 *      update it here too. Kept to just this one step deliberately, so
 *      there's only one thing to keep in sync, not the whole sequence.
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

const GHL_READINESS_FIELD_ID = "5Ki01GIRnf1Lp0z6k1SE";
const GHL_CONSENT_FIELD_ID = "c1e2KGBr92A5BWNTylGZ";
const INSTANT_TOUCH_TAG = "instant-touch-sent";
const READINESS_TAGS = { hot: "readiness-hot", warm: "readiness-warm", cold: "readiness-cold" };
const SMS_OPTIN_URL = "https://consent-r7gu.onrender.com";

// Duplicated from server.js SEQUENCES[tier][0] — see the file header note.
const TOUCH_ONE = {
  hot: {
    subject: "Let's get you into a new construction home",
    sms: "Hi {{FIRST_NAME}}, this is Gus w/ GR Group — got your new construction inquiry. I can pull what's actually available + current builder incentives right now. Good time to talk today or tmrw? -Gus",
    body: `Hi {{FIRST_NAME}},

Thanks for reaching out about new construction in the Coachella Valley — sounds like you're ready to move soon, so I want to help you move fast.

I can pull the communities and floor plans that are actually available right now (not just listed — available), plus whatever builder incentives are live this week. Fastest way to do this well is a short call.

What's the best number and time to reach you today or tomorrow?

Talk soon,
Gus`,
  },
  warm: {
    subject: "Good to connect — here's what happens next",
    sms: "Hi {{FIRST_NAME}}, this is Gus w/ GR Group. Got your new construction inquiry — no rush, I'll send a few quick useful things over the next few weeks. Reply anytime w/ Qs. -Gus",
    body: `Hi {{FIRST_NAME}},

Thanks for your interest in new construction in the Coachella Valley. Sounds like you're planning ahead rather than needing something immediately — honestly the smart way to do this, since it gives you more time to find the right fit.

Over the next few weeks I'll send a few short, useful things: how the new-construction process actually works, current incentives, and what to look for before you sign anything. No pressure — reply anytime you have a question.

Talk soon,
Gus`,
  },
  cold: {
    subject: "Got your info — no rush",
    sms: "Hi {{FIRST_NAME}}, this is Gus w/ GR Group. Got your new construction inquiry — no rush at all, I'll check in occasionally w/ anything useful. Reply anytime. -Gus",
    body: `Hi {{FIRST_NAME}},

Thanks for checking out new construction homes. Sounds like you're still early in the process, which is completely fine — no rush at all, and no pressure from me.

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
  return String(str).replace(/\{\{FIRST_NAME\}\}/g, firstName);
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

async function sendSms(contactId, message) {
  return ghlFetch(`/conversations/messages`, {
    method: "POST",
    body: JSON.stringify({ type: "SMS", contactId, message }),
  });
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

  if (!source || String(source).toLowerCase() !== "facebook") {
    return { ok: true, skipped: true, reason: `source is "${source}", not facebook`, contact_id: contactId, name };
  }
  if (tags.includes(INSTANT_TOUCH_TAG)) {
    return { ok: true, skipped: true, reason: "already instant-touched (idempotency guard)", contact_id: contactId, name };
  }
  const stoppedInGhl = tags.some((t) => /unsubscribed|opt[- ]?out|replied\s*"?stop"?/i.test(t));
  const suppressed = Boolean(raw.dnd) || stoppedInGhl;
  if (suppressed) {
    return { ok: true, skipped: true, reason: "suppressed (GHL dnd flag or STOP tag)", contact_id: contactId, name };
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

  let smsResult = null;
  if (phoneOutreachOk) {
    const smsText = renderTemplate(template.sms, firstName);
    smsResult = await sendSms(contactId, smsText).catch((err) => ({ error: err.message }));
  }

  return {
    ok: true,
    skipped: false,
    contact_id: contactId,
    name,
    tier,
    tag_applied: readinessTag,
    email_sent: !emailResult?.error,
    email_error: emailResult?.error || null,
    sms_attempted: phoneOutreachOk,
    sms_sent: phoneOutreachOk ? !smsResult?.error : false,
    sms_error: smsResult?.error || null,
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
