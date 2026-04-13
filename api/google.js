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

// ── Gmail: List recent emails ──
export async function listEmails({ maxResults = 10, query = '', labelIds } = {}) {
  const token = await getAccessToken();

  let url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}`;
  if (query) url += `&q=${encodeURIComponent(query)}`;
  if (labelIds) url += `&labelIds=${labelIds}`;

  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) throw new Error('List emails failed: ' + await res.text());
  const data = await res.json();

  if (!data.messages || data.messages.length === 0) return [];

  // Fetch headers for each message
  const emails = await Promise.all(data.messages.map(async (msg) => {
    const mRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    if (!mRes.ok) return null;
    const mData = await mRes.json();
    const headers = {};
    (mData.payload?.headers || []).forEach(h => { headers[h.name] = h.value; });
    return {
      id: mData.id,
      threadId: mData.threadId,
      from: headers.From || '',
      to: headers.To || '',
      subject: headers.Subject || '(no subject)',
      date: headers.Date || '',
      snippet: mData.snippet || '',
      labels: mData.labelIds || [],
      isUnread: (mData.labelIds || []).includes('UNREAD')
    };
  }));

  return emails.filter(Boolean);
}

// ── Gmail: Read full email ──
export async function readEmail({ id }) {
  const token = await getAccessToken();

  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error('Read email failed: ' + await res.text());
  const data = await res.json();

  const headers = {};
  (data.payload?.headers || []).forEach(h => { headers[h.name] = h.value; });

  // Extract plain text body
  function getBody(payload) {
    if (payload.mimeType === 'text/plain' && payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    }
    if (payload.parts) {
      for (const part of payload.parts) {
        const result = getBody(part);
        if (result) return result;
      }
    }
    return '';
  }

  return {
    id: data.id,
    threadId: data.threadId,
    from: headers.From || '',
    to: headers.To || '',
    subject: headers.Subject || '',
    date: headers.Date || '',
    body: getBody(data.payload),
    snippet: data.snippet || '',
    labels: data.labelIds || [],
    isUnread: (data.labelIds || []).includes('UNREAD')
  };
}

// ── Gmail: Read full thread ──
export async function readThread({ threadId }) {
  const token = await getAccessToken();

  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error('Read thread failed: ' + await res.text());
  const data = await res.json();

  function getBody(payload) {
    if (payload.mimeType === 'text/plain' && payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    }
    if (payload.parts) {
      for (const part of payload.parts) {
        const result = getBody(part);
        if (result) return result;
      }
    }
    return '';
  }

  return (data.messages || []).map(msg => {
    const headers = {};
    (msg.payload?.headers || []).forEach(h => { headers[h.name] = h.value; });
    return {
      id: msg.id,
      from: headers.From || '',
      to: headers.To || '',
      subject: headers.Subject || '',
      date: headers.Date || '',
      body: getBody(msg.payload),
      snippet: msg.snippet || ''
    };
  });
}

// ── Gmail: Reply to an email (in-thread) ──
export async function replyToEmail({ messageId, threadId, to, body, html }) {
  const token = await getAccessToken();

  // Get original message to grab subject and Message-ID for threading
  const origRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=metadata&metadataHeaders=Subject&metadataHeaders=Message-ID`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  if (!origRes.ok) throw new Error('Failed to fetch original message');
  const origData = await origRes.json();
  const origHeaders = {};
  (origData.payload?.headers || []).forEach(h => { origHeaders[h.name] = h.value; });

  const subject = origHeaders.Subject?.startsWith('Re:') ? origHeaders.Subject : `Re: ${origHeaders.Subject || ''}`;
  const encodedSubject = /[^\x00-\x7F]/.test(subject)
    ? '=?UTF-8?B?' + Buffer.from(subject, 'utf-8').toString('base64') + '?='
    : subject;

  const contentType = html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
  const headers = [
    `From: Travis Atreo <travis@travisatreo.com>`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    `MIME-Version: 1.0`,
    `Content-Type: ${contentType}`,
    `In-Reply-To: ${origHeaders['Message-ID'] || ''}`,
    `References: ${origHeaders['Message-ID'] || ''}`
  ];

  const raw = headers.join('\r\n') + '\r\n\r\n' + (html || body);
  const encoded = Buffer.from(raw).toString('base64url');

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ raw: encoded, threadId })
  });

  if (!res.ok) throw new Error('Reply failed: ' + await res.text());
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
    case 'list_emails':
      return await listEmails(input);
    case 'read_email':
      return await readEmail(input);
    case 'read_thread':
      return await readThread(input);
    case 'reply_to_email':
      return await replyToEmail(input);
    default:
      throw new Error('Unknown tool: ' + name);
  }
}
