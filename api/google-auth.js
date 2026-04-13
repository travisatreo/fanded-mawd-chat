// Google OAuth helper — re-authorize with all needed scopes
// Step 1: GET /api/google-auth → redirects to Google consent
// Step 2: Google redirects back with ?code= → exchanges for refresh token → displays it

export default async function handler(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = 'https://fanded-mawd-chat.vercel.app/api/google-auth';

  const SCOPES = [
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.events'
  ].join(' ');

  // Step 2: Handle callback with authorization code
  if (req.query.code) {
    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: req.query.code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code'
        })
      });

      const data = await tokenRes.json();

      if (data.error) {
        return res.status(400).send(`<h2>Error</h2><pre>${JSON.stringify(data, null, 2)}</pre>`);
      }

      // Show the refresh token so Travis can copy it to Vercel
      return res.status(200).send(`
        <html>
        <body style="background:#0a0a0a;color:#e0e0e0;font-family:sans-serif;padding:40px;max-width:600px;margin:0 auto;">
          <h2 style="color:#D4A843;">Google OAuth Complete</h2>
          <p>Scopes: Gmail Send + Compose, Calendar + Events</p>
          <h3>Refresh Token:</h3>
          <textarea style="width:100%;height:120px;background:#1a1a1a;color:#D4A843;border:1px solid #333;border-radius:8px;padding:12px;font-family:monospace;font-size:13px;" readonly onclick="this.select()">${data.refresh_token || 'No refresh token returned (you may have already authorized, try revoking access at myaccount.google.com/permissions first)'}</textarea>
          <p style="margin-top:16px;color:#888;">Copy this token, go to Vercel > Settings > Environment Variables, and update <strong>GOOGLE_REFRESH_TOKEN</strong> with it. Then redeploy.</p>
          <h3 style="margin-top:24px;">Access Token (temporary):</h3>
          <textarea style="width:100%;height:60px;background:#1a1a1a;color:#666;border:1px solid #333;border-radius:8px;padding:12px;font-family:monospace;font-size:11px;" readonly>${data.access_token || 'none'}</textarea>
        </body>
        </html>
      `);
    } catch (err) {
      return res.status(500).send(`<h2>Error</h2><pre>${err.message}</pre>`);
    }
  }

  // Step 1: Redirect to Google consent
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${clientId}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&access_type=offline` +
    `&prompt=consent`;

  return res.redirect(302, authUrl);
}
