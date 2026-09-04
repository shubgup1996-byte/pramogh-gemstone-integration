const crypto = require('crypto');

const FRESHSALES_BASE = (() => {
  const raw = (process.env.FRESHSALES_BUNDLE_ALIAS || '').trim().replace(/\/$/, '');
  if (!raw) return '';
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
})();
const FRESHSALES_API_KEY = process.env.FRESHSALES_API_KEY || '';
const WATI_ENDPOINT = (process.env.WATI_ENDPOINT || '').replace(/\/$/, '');
const WATI_TOKEN = process.env.WATI_TOKEN || '';
const WATI_TEMPLATE_NAME = (process.env.WATI_TEMPLATE_NAME || 'gems_recommendation').trim();
const WATI_CHANNEL_NUMBER = (process.env.WATI_CHANNEL_NUMBER || '').replace(/\D/g, '');
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';

function required(name, value) {
  if (!value) throw new Error(`${name} is not configured on Vercel.`);
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  return { first_name: parts.shift() || '', last_name: parts.join(' ') || '' };
}

// Canonical CRM identifier format: digits-only international number.
// Example: +91 9541911021 -> 919541911021.
// The country code is used only to build the full international number;
// Freshsales does NOT receive '+' and does NOT use country_code as a separate identifier.
function normalizePhone(phone, countryCode = '') {
  let raw = String(phone || '').trim();
  let digits = raw.replace(/\D/g, '');
  let cc = String(countryCode || '').replace(/\D/g, '');

  if (digits.startsWith('00')) digits = digits.slice(2);

  // If phone already contains the selected country code, keep the full number.
  if (cc && digits.startsWith(cc)) {
    return digits;
  }

  // Otherwise treat phone as a national number and prepend the selected code.
  if (cc) {
    digits = digits.replace(/^0+/, '');
    return `${cc}${digits}`;
  }

  return digits;
}

// Kept as an explicit alias for WATI and any future integrations.
function normalizePhoneDigits(phone, countryCode = '') {
  return normalizePhone(phone, countryCode);
}

function validLead(lead) {
  return !!(
    lead && lead.name && lead.email && normalizePhone(lead.phone, lead.country_code) && lead.dob &&
    lead.time && lead.pob && lead.gender && lead.weight && lead.purpose
  );
}

function freshHeaders() {
  return {
    Authorization: `Token token=${FRESHSALES_API_KEY}`,
    'Content-Type': 'application/json'
  };
}

async function getContactById(id) {
  const response = await fetch(
    `${FRESHSALES_BASE}/api/contacts/${encodeURIComponent(id)}`,
    { method: 'GET', headers: freshHeaders() }
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return null;
  return data.contact || data;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function contactEmails(contact) {
  const values = [];
  const emails = contact && contact.emails;

  if (Array.isArray(emails)) {
    for (const item of emails) {
      if (typeof item === 'string') values.push(item);
      else if (item && item.email) values.push(item.email);
      else if (item && item.value) values.push(item.value);
    }
  } else if (typeof emails === 'string') {
    values.push(emails);
  }

  if (contact && contact.email) values.push(contact.email);
  if (contact && contact.work_email) {
    if (typeof contact.work_email === 'string') values.push(contact.work_email);
    else if (contact.work_email.email) values.push(contact.work_email.email);
    else if (contact.work_email.value) values.push(contact.work_email.value);
  }

  return [...new Set(values.map(normalizeEmail).filter(Boolean))];
}

function buildEmailPayload(contact, newEmail) {
  const normalizedNewEmail = normalizeEmail(newEmail);
  if (!normalizedNewEmail) return null;

  const rawEmails = contact && contact.emails;
  let entries = [];

  if (Array.isArray(rawEmails)) {
    entries = rawEmails.map(item => {
      if (item && typeof item === 'object') return { ...item };
      if (typeof item === 'string' && item.trim()) {
        return {
          value: item.trim(),
          is_primary: false,
          label: 'Other',
          _destroy: false
        };
      }
      return null;
    }).filter(Boolean);
  } else if (typeof rawEmails === 'string' && rawEmails.trim()) {
    entries = [{
      value: rawEmails.trim(),
      is_primary: true,
      label: null,
      _destroy: false
    }];
  }

  // Some contact responses expose only the deprecated primary `email` field.
  // Preserve it if the emails group is absent.
  if (entries.length === 0 && contact && contact.email) {
    entries.push({
      value: String(contact.email).trim(),
      is_primary: true,
      label: null,
      _destroy: false
    });
  }

  const alreadyPresent = entries.some(item => {
    const value = item && (item.value || item.email);
    return normalizeEmail(value) === normalizedNewEmail;
  });

  if (alreadyPresent) return null;

  entries.push({
    value: String(newEmail).trim(),
    is_primary: false,
    label: 'Other',
    _destroy: false
  });

  return entries;
}

async function searchContacts(query) {
  const url = `${FRESHSALES_BASE}/api/search?q=${encodeURIComponent(query)}&include=contact&per_page=100`;
  const response = await fetch(url, { method: 'GET', headers: freshHeaders() });
  const data = await response.json().catch(() => []);
  if (!response.ok || !Array.isArray(data)) return [];
  return data.filter(item => item && item.type === 'contact' && item.id);
}

async function lookupContactsByField(field, value) {
  const url =
    `${FRESHSALES_BASE}/api/lookup?q=${encodeURIComponent(value)}` +
    `&f=${encodeURIComponent(field)}&entities=contact`;
  const response = await fetch(url, { method: 'GET', headers: freshHeaders() });
  const data = await response.json().catch(() => []);
  if (!response.ok || !Array.isArray(data)) return [];
  return data.filter(item => item && item.id);
}

async function findExistingContactByMobile(mobile) {
  // Freshsales lookup search performs an exact match on mobile_number.
  // Try the canonical digits, +digits, and the national last-10-digit form,
  // then normalize the returned value so legacy formatting is handled too.
  const candidates = new Set([mobile, `+${mobile}`]);
  if (mobile.length > 10) candidates.add(mobile.slice(-10));

  const seen = new Set();

  for (const q of candidates) {
    const items = await lookupContactsByField('mobile_number', q);

    for (const item of items) {
      if (seen.has(String(item.id))) continue;
      seen.add(String(item.id));

      const existing = await getContactById(item.id);
      if (!existing) continue;

      const existingDigits = normalizePhoneDigits(existing.mobile_number || '');

      if (
        existingDigits === mobile ||
        (mobile.length > 10 && existingDigits === mobile.slice(-10))
      ) {
        return existing;
      }
    }
  }

  // Fallback for accounts where lookup does not return a legacy formatted
  // number: use the general search API and verify the actual contact value.
  for (const q of candidates) {
    const items = await searchContacts(q);

    for (const item of items) {
      if (seen.has(String(item.id))) continue;
      seen.add(String(item.id));

      const existing = await getContactById(item.id);
      if (!existing) continue;

      const existingDigits = normalizePhoneDigits(existing.mobile_number || '');

      if (
        existingDigits === mobile ||
        (mobile.length > 10 && existingDigits === mobile.slice(-10))
      ) {
        return existing;
      }
    }
  }

  return null;
}

async function findExistingContactByEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;

  const items = await searchContacts(normalized);
  const seen = new Set();

  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);

    const existing = await getContactById(item.id);
    if (!existing) continue;

    if (contactEmails(existing).includes(normalized)) return existing;
  }

  return null;
}

function isBlank(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  return false;
}

function getExistingCustomField(contact, key) {
  const fields = contact && (contact.custom_field || contact.custom_fields);
  if (!fields || typeof fields !== 'object') return '';
  return fields[key];
}

function addIfBlank(payload, field, existingValue, newValue) {
  if (isBlank(existingValue) && !isBlank(newValue)) {
    payload[field] = newValue;
  }
}

function addCustomFieldIfBlank(payload, contact, key, newValue) {
  const existingValue = getExistingCustomField(contact, key);
  if (isBlank(existingValue) && !isBlank(newValue)) {
    payload[key] = newValue;
  }
}

let newContactStatusIdPromise = null;
let recentSourceChoicePromise = null;

// Freshsales dropdowns must receive the configured choice value. We resolve
// the choice from the field definition instead of guessing whether the API
// expects the label, id, or another internal representation.
const RECENT_SOURCE_FIELD = 'cf_sub_source';
const RECENT_SOURCE_LABEL = 'Gemstone Recommendation';

async function getRecentSourceChoice() {
  required('FRESHSALES_BUNDLE_ALIAS', FRESHSALES_BASE);
  required('FRESHSALES_API_KEY', FRESHSALES_API_KEY);

  if (!recentSourceChoicePromise) {
    recentSourceChoicePromise = (async () => {
      const response = await fetch(
        `${FRESHSALES_BASE}/api/settings/contacts/fields`,
        { method: 'GET', headers: freshHeaders() }
      );
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          `Freshsales contact fields lookup error (${response.status}): ${JSON.stringify(data)}`
        );
      }

      const fields = Array.isArray(data.fields) ? data.fields : [];
      const field = fields.find(item =>
        item && String(item.name || '').trim() === RECENT_SOURCE_FIELD
      );

      if (!field) {
        throw new Error(`Freshsales field ${RECENT_SOURCE_FIELD} was not found.`);
      }

      const choices = Array.isArray(field.choices) ? field.choices : [];
      const desired = RECENT_SOURCE_LABEL.trim().toLowerCase();

      const choice = choices.find(item => {
        if (item == null) return false;
        if (typeof item === 'string') return item.trim().toLowerCase() === desired;
        return [item.value, item.label, item.name, item.text]
          .filter(v => v != null)
          .some(v => String(v).trim().toLowerCase() === desired);
      });

      if (!choice) {
        const available = choices.map(item => {
          if (typeof item === 'string') return item;
          return item && (item.value || item.label || item.name || item.text || item.id);
        }).filter(Boolean);
        throw new Error(
          `Freshsales dropdown choice "${RECENT_SOURCE_LABEL}" was not found for ${RECENT_SOURCE_FIELD}. Available choices: ${JSON.stringify(available)}`
        );
      }

      // Freshsales contact custom dropdowns accept the choice text/value.
      // Prefer the explicit value, then label/name/text, then string choice.
      const resolved = typeof choice === 'string'
        ? choice.trim()
        : String(choice.value ?? choice.label ?? choice.name ?? choice.text ?? '').trim();

      if (!resolved) {
        throw new Error(`Freshsales choice "${RECENT_SOURCE_LABEL}" has no usable value.`);
      }

      return resolved;
    })();
  }

  return recentSourceChoicePromise;
}

async function updateRecentSource(contactId) {
  const recentSourceChoice = await getRecentSourceChoice();

  const response = await fetch(
    `${FRESHSALES_BASE}/api/contacts/${encodeURIComponent(contactId)}`,
    {
      method: 'PUT',
      headers: freshHeaders(),
      body: JSON.stringify({
        contact: {
          custom_field: {
            [RECENT_SOURCE_FIELD]: recentSourceChoice
          }
        }
      })
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      `Freshsales Recent Source update error (${response.status}): ${JSON.stringify(data)}`
    );
  }

  // Verify the write with a fresh GET. This prevents a successful HTTP
  // response from being treated as success if Freshsales did not persist the
  // dropdown value.
  const verified = await getContactById(contactId);
  const custom = verified && (verified.custom_field || verified.custom_fields || {});
  const stored = custom && custom[RECENT_SOURCE_FIELD];

  if (String(stored ?? '').trim().toLowerCase() !== recentSourceChoice.trim().toLowerCase()) {
    throw new Error(
      `Freshsales accepted the Recent Source update request but verification failed. Expected "${recentSourceChoice}", received ${JSON.stringify(stored)}.`
    );
  }

  return { value: recentSourceChoice, verified: true, contact: verified || data.contact || data };
}

async function getNewContactStatusId() {
  required('FRESHSALES_BUNDLE_ALIAS', FRESHSALES_BASE);
  required('FRESHSALES_API_KEY', FRESHSALES_API_KEY);

  if (!newContactStatusIdPromise) {
    newContactStatusIdPromise = (async () => {
      const response = await fetch(
        `${FRESHSALES_BASE}/api/selector/contact_statuses`,
        { method: 'GET', headers: freshHeaders() }
      );
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          `Freshsales contact status lookup error (${response.status}): ${JSON.stringify(data)}`
        );
      }

      const statuses =
        Array.isArray(data.contact_statuses) ? data.contact_statuses :
        Array.isArray(data.statuses) ? data.statuses :
        Array.isArray(data) ? data : [];

      const status = statuses.find(item =>
        item && String(item.name || '').trim().toLowerCase() === 'new'
      );

      if (!status || status.id == null) {
        throw new Error('Freshsales contact status "New" was not found.');
      }

      return Number(status.id);
    })();
  }

  return newContactStatusIdPromise;
}

async function freshUpsert(lead) {
  required('FRESHSALES_BUNDLE_ALIAS', FRESHSALES_BASE);
  required('FRESHSALES_API_KEY', FRESHSALES_API_KEY);

  const name = splitName(lead.name);
  const mobile = normalizePhone(lead.phone, lead.country_code);
  const email = normalizeEmail(lead.email);
  const newContactStatusId = await getNewContactStatusId();

  // PHONE IS THE PRIMARY IDENTITY.
  // If Freshsales already has this number in any legacy format, update that
  // exact contact. Existing non-empty CRM values are preserved.
  let target = await findExistingContactByMobile(mobile);
  if (!target) target = await findExistingContactByEmail(email);

  if (target && target.id) {
    const contactPayload = {};

    // ---------------------------------------------------------
    // CONTACT FIELDS: ONLY FILL EMPTY VALUES
    // ---------------------------------------------------------
    addIfBlank(contactPayload, 'first_name', target.first_name, name.first_name);
    addIfBlank(contactPayload, 'last_name', target.last_name, name.last_name);

    // EMAILS: preserve every existing email and append the submitted email
    // when it is new. Never overwrite an existing email and never claim an
    // email that belongs to another Freshsales contact.
    const existingTargetEmails = contactEmails(target);
    if (email && !existingTargetEmails.includes(email)) {
      const emailOwner = await findExistingContactByEmail(email);

      if (!emailOwner || String(emailOwner.id) === String(target.id)) {
        const emailPayload = buildEmailPayload(target, lead.email);
        if (emailPayload) {
          contactPayload.emails = emailPayload;
        }
      }
    }

    // Every form submission moves the matched contact to Freshsales status
    // "New". The ID is resolved from the account's configured statuses.
    contactPayload.contact_status_id = newContactStatusId;

    // If this contact was found by email and its mobile is empty, fill it.
    // If found by mobile, do not resend mobile_number because Freshsales
    // can reject it as a uniqueness conflict on legacy/duplicate records.
    if (isBlank(target.mobile_number)) {
      const mobileOwner = await findExistingContactByMobile(mobile);
      if (!mobileOwner || String(mobileOwner.id) === String(target.id)) {
        contactPayload.mobile_number = mobile;
      }
    }

    // ---------------------------------------------------------
    // CUSTOM FIELDS: ONLY FILL EMPTY VALUES
    // ---------------------------------------------------------
    const customFieldPayload = {};

    addCustomFieldIfBlank(
      customFieldPayload,
      target,
      'cf_primary_source',
      'Gemstone Recommendation'
    );

    addCustomFieldIfBlank(
      customFieldPayload,
      target,
      'cf_date_of_birth_',
      String(lead.dob || '')
    );

    addCustomFieldIfBlank(
      customFieldPayload,
      target,
      'cf_time_of_birth',
      String(lead.time || '')
    );

    addCustomFieldIfBlank(
      customFieldPayload,
      target,
      'cf_place_of_birth',
      String(lead.pob || '')
    );

    addCustomFieldIfBlank(
      customFieldPayload,
      target,
      'cf_body_weight',
      String(lead.weight || '')
    );

    if (Object.keys(customFieldPayload).length > 0) {
      contactPayload.custom_field = customFieldPayload;
    }

    // Nothing to update is still a successful match.
    if (Object.keys(contactPayload).length === 0) {
      return target;
    }

    const response = await fetch(
      `${FRESHSALES_BASE}/api/contacts/${encodeURIComponent(target.id)}`,
      {
        method: 'PUT',
        headers: freshHeaders(),
        body: JSON.stringify({ contact: contactPayload })
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        `Freshsales contact update error (${response.status}): ${JSON.stringify(data)}`
      );
    }

    const updatedContact = data.contact || data;
    const recentSource = await updateRecentSource(target.id);
    return recentSource.contact || updatedContact;
  }

  // No existing phone/email contact: create a new contact.
  // All submitted values are new, so there is nothing to preserve yet.
  const response = await fetch(`${FRESHSALES_BASE}/api/contacts`, {
    method: 'POST',
    headers: freshHeaders(),
    body: JSON.stringify({
      contact: {
        first_name: name.first_name,
        last_name: name.last_name,
        mobile_number: mobile,
        emails: String(lead.email || ''),
        contact_status_id: newContactStatusId,
        custom_field: {
          cf_primary_source: 'Gemstone Recommendation',
          cf_date_of_birth_: String(lead.dob || ''),
          cf_time_of_birth: String(lead.time || ''),
          cf_place_of_birth: String(lead.pob || ''),
          cf_body_weight: String(lead.weight || '')
        }
      }
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    // A concurrent submission may have created the phone/email after our
    // lookup. Resolve it again and apply the same preserve-existing-values rule.
    if (response.status === 400) {
      const retryByMobile = await findExistingContactByMobile(mobile);
      const retryByEmail = retryByMobile ? null : await findExistingContactByEmail(email);
      const retryTarget = retryByMobile || retryByEmail;

      if (retryTarget && retryTarget.id) {
        return freshUpsert(lead);
      }
    }

    throw new Error(
      `Freshsales contact error (${response.status}): ${JSON.stringify(data)}`
    );
  }

  const createdContact = data.contact || data;
  const recentSource = await updateRecentSource(createdContact.id);
  return recentSource.contact || createdContact;
}

function buildLeadNote(lead, extra = {}) {
  return [
    'GEMSTONE RECOMMENDATION',
    '',
    `Name: ${lead.name || ''}`,
    `Email: ${lead.email || ''}`,
    `WhatsApp: ${lead.phone_display || lead.phone || ''}`,
    `DOB: ${lead.dob || ''}`,
    `Time of Birth: ${lead.time || ''}`,
    `Place of Birth: ${lead.pob || ''}`,
    `Gender: ${lead.gender || ''}`,
    `Body Weight: ${lead.weight || ''}`,
    `Guidance Required For: ${lead.purpose || ''}`,
    '',
    `Consultation: ${extra.consultation || lead.consultation || 'Not selected'}`,
    `Consultation Amount: ${extra.amount != null && extra.amount !== '' ? `₹${extra.amount}` : 'Not selected'}`,
    '',
    `Payment Status: ${extra.paymentStatus || 'Payment Pending'}`,
    `Razorpay Order ID: ${extra.orderId || 'Not created'}`,
    `Razorpay Payment ID: ${extra.paymentId || 'Not paid'}`,
    `Lead Source: Gemstone Recommendation`
  ].join('\n');
}

async function freshCreateNote(contactId, description) {
  required('FRESHSALES_BUNDLE_ALIAS', FRESHSALES_BASE);
  required('FRESHSALES_API_KEY', FRESHSALES_API_KEY);

  const response = await fetch(`${FRESHSALES_BASE}/api/notes`, {
    method: 'POST',
    headers: freshHeaders(),
    body: JSON.stringify({
      note: {
        description,
        targetable_type: 'Contact',
        targetable_id: contactId
      }
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Freshsales note error (${response.status}): ${JSON.stringify(data)}`);
  }
  return data.note || data;
}

async function freshUpdateNote(noteId, contactId, description) {
  required('FRESHSALES_BUNDLE_ALIAS', FRESHSALES_BASE);
  required('FRESHSALES_API_KEY', FRESHSALES_API_KEY);

  const response = await fetch(`${FRESHSALES_BASE}/api/notes/${encodeURIComponent(noteId)}`, {
    method: 'PUT',
    headers: freshHeaders(),
    body: JSON.stringify({
      note: {
        description,
        targetable_type: 'Contact',
        targetable_id: contactId
      }
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Freshsales note update error (${response.status}): ${JSON.stringify(data)}`);
  }
  return data.note || data;
}

async function sendWatiTemplate(lead, consultation, amount, paymentId) {
  required('WATI_ENDPOINT', WATI_ENDPOINT);
  required('WATI_TOKEN', WATI_TOKEN);
  required('WATI_TEMPLATE_NAME', WATI_TEMPLATE_NAME);

  // WATI receives the customer's submitted WhatsApp number as digits-only international number.
  const customerWhatsApp = normalizePhoneDigits(lead && lead.phone, lead && lead.country_code);
  if (!customerWhatsApp) throw new Error('Customer WhatsApp number is missing.');

  const parameters = [
    { name: 'name', value: String(lead.name || '') },
    { name: 'date_of_birth', value: String(lead.dob || '') },
    { name: 'time_of_birth', value: String(lead.time || '') },
    { name: 'place_of_birth', value: String(lead.pob || '') },
    { name: 'gender', value: String(lead.gender || '') },
    { name: 'body_weight', value: String(lead.weight || '') },
    { name: 'consultation_type', value: String(consultation || '') },
    { name: 'message', value: String(lead.purpose || '') },
    { name: 'amount', value: `₹${amount}` },
    { name: 'razorpay_payment_id', value: String(paymentId || '') }
  ];

  const body = {
    template_name: WATI_TEMPLATE_NAME,
    broadcast_name: 'Gemstone Website Lead',
    parameters
  };

  if (WATI_CHANNEL_NUMBER) body.channelNumber = WATI_CHANNEL_NUMBER;

  const response = await fetch(
    `${WATI_ENDPOINT}/api/v2/sendTemplateMessage?whatsappNumber=${encodeURIComponent(customerWhatsApp)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WATI_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }
  );

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`WATI error (${response.status}): ${JSON.stringify(data)}`);
  return data;
}

function verifyRazorpaySignature(orderId, paymentId, signature) {
  required('RAZORPAY_KEY_SECRET', RAZORPAY_KEY_SECRET);
  const expected = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  cors,
  validLead,
  normalizePhone,
  normalizePhoneDigits,
  buildLeadNote,
  freshUpsert,
  updateRecentSource,
  getRecentSourceChoice,
  freshCreateNote,
  freshUpdateNote,
  sendWatiTemplate,
  verifyRazorpaySignature,
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET
};
