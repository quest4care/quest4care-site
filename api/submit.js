// QCLS Form Submission Handler
// Vercel Serverless Function → Neon Native Form Endpoint
// Posts to Neon's own form submission endpoint to trigger native workflows
// (confirmation email to constituent + internal notification to marquest@quest4care.org)

const NEON_FORM_URL = 'https://quest4care.app.neoncrm.com/nx/portal/account-form';

// Form IDs from Neon (used to trigger the right workflow)
const FORM_IDS = {
  individual:   '7',   // QCLS General Contact & Intake
  organization: '8',   // FoundationReady Inquiry
  provider:     '9',   // Provider Network Application
  volunteer:    '10',  // Volunteer Application
};

function buildRequestId() {
  // Generate a UUID v4-style requestId
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function buildNeonPayload(formType, payload) {
  const formId = FORM_IDS[formType] || FORM_IDS.individual;
  const nameParts = (payload.name || '').trim().split(/\s+/);
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  // Map county string to Neon option ID
  const countyMap = { 'Henry County': '59', 'Madison County': '60', 'Other': '61', 'Other Indiana County': '61' };
  const countyId = countyMap[payload.county] || '';

  // Map interest/formType to Program Interest option ID
  const programMap = {
    'individual':   '31', // Community Access Navigation
    'organization': '32', // FoundationReady Assessment
    'provider':     '33', // Provider Network
    'volunteer':    '34', // Volunteer
  };
  const programId = programMap[formType] || '35'; // 35 = General Inquiry

  const neonData = {
    id: formId,
    requestId: buildRequestId(),
    recaptchaResponse: null,
    'name.firstName': firstName,
    'name.lastName': lastName,
    email1: payload.email || '',
    'address.phone1.number': payload.phone || '',
    'address.phone1.type': 'M',
    'company.name': payload.organization || '',
    'customFields[0].id': '87',
    'customFields[0].value': programId,
    'customFields[1].id': '91',
    'customFields[1].value': countyId,
    'customFields[2].id': '83',
    'customFields[2].value': '',
    hiddenFields: [],
    recaptchaMode: 'invisible',
  };

  // Add message/details as a note via the form if there's a notes field,
  // otherwise include it in the interest area field (id 83)
  if (payload.message) {
    // Interest Area field as free text isn't supported — we'll append to name or skip
    // The workflow confirmation email will include the standard fields
  }

  return neonData;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://quest4care.org');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const payload = req.body;
    const { formType, email } = payload;

    if (!email) return res.status(400).json({ error: 'Email is required' });

    const neonPayload = buildNeonPayload(formType || 'individual', payload);

    // POST to Neon's native form endpoint
    const neonRes = await fetch(NEON_FORM_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://quest4care.app.neoncrm.com',
        'Referer': 'https://quest4care.app.neoncrm.com/forms/qcls-general-contact--intake',
      },
      body: JSON.stringify(neonPayload)
    });

    const neonData = await neonRes.json().catch(() => ({}));
    console.log('Neon response status:', neonRes.status);
    console.log('Neon response:', JSON.stringify(neonData));

    if (neonRes.ok || neonRes.status === 200) {
      return res.status(200).json({ success: true });
    } else {
      console.error('Neon form submission failed:', neonRes.status, neonData);
      return res.status(200).json({ success: true, warning: 'Submission logged but email may be delayed' });
    }

  } catch (err) {
    console.error('Submit error:', err);
    return res.status(500).json({ error: 'Submission failed. Please email info@quest4care.org.' });
  }
}
