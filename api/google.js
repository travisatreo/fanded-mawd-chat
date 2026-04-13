// MAWD Google API — Gmail send + Calendar create
// Uses OAuth2 refresh token flow for Travis's Google account

async function getAccessToken() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Google OAuth not configured');
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error('Token refresh failed: ' + err);
  }

  const data = await res.json();
  return data.access_token;
}

// ── Gmail: Create draft ──
export async function createDraft({ to, subject, body, cc, bcc }) {
  const token = await getAccessToken();

  // Build RFC 2822 email
  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=utf-8`
  ];
  if (cc) headers.push(`Cc: ${cc}`);
  if (bcc) headers.push(`Bcc: ${bcc}`);

  const raw = headers.join('\r\n') + '\r\n\r\n' + body;
  const encoded = Buffer.from(raw).toString('base64url');

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ message: { raw: encoded } })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error('Draft creation failed: ' + err);
  }

  return await res.json();
}

// ── Gmail: Send email ──
export async function sendEmail({ to, subject, body, html, cc, bcc }) {
  const token = await getAccessToken();

  // RFC 2047 encode subject if it contains non-ASCII characters
  const encodedSubject = /[^\x00-\x7F]/.test(subject)
    ? '=?UTF-8?B?' + Buffer.from(subject, 'utf-8').toString('base64') + '?='
    : subject;

  const contentType = html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
  const headers = [
    `From: Travis Atreo <travis@travisatreo.com>`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    `MIME-Version: 1.0`,
    `Content-Type: ${contentType}`
  ];
  if (cc) headers.push(`Cc: ${cc}`);
  if (bcc) headers.push(`Bcc: ${bcc}`);

  const raw = headers.join('\r\n') + '\r\n\r\n' + (html || body);
  const encoded = Buffer.from(raw).toString('base64url');

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ raw: encoded })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error('Email send failed: ' + err);
  }

  return await res.json();
}

// ── Calendar: Create event ──
export async function createEvent({ summary, description, startTime, endTime, attendees, location }) {
  const token = await getAccessToken();

  const event = {
    summary,
    description: description || '',
    start: { dateTime: startTime, timeZone: 'America/Los_Angeles' },
    end: { dateTime: endTime, timeZone: 'America/Los_Angeles' },
  };

  if (location) event.location = location;
  if (attendees && attendees.length) {
    event.attendees = attendees.map(e => ({ email: e }));
    event.conferenceData = undefined;
  }

  const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(event)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error('Event creation failed: ' + err);
  }

  return await res.json();
}

// ── Execute a tool call ──
// Note: save_memory is handled directly in chat.js, not here
export async function executeTool(name, input) {
  switch (name) {
    case 'send_email':
      return await sendEmail(input);
    case 'create_draft':
      return await createDraft(input);
    case 'create_event':
      return await createEvent(input);
    default:
      throw new Error('Unknown tool: ' + name);
  }
}
