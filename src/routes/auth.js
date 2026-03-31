const express = require('express');
const router = express.Router();
const config = require('../config');
const fetch = require('node-fetch');

// GET /auth/callback - Pipedrive OAuth callback
router.get('/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send('Manglende authorization code');
  }

  try {
    // Udveksle authorization code for access token
    const credentials = Buffer.from(
      config.pipedrive.clientId + ':' + config.pipedrive.clientSecret
    ).toString('base64');

    const tokenResponse = await fetch('https://oauth.pipedrive.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + credentials,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.appUrl + '/auth/callback',
      }).toString(),
    });

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok) {
      console.error('OAuth token fejl:', tokenData);
      return res.status(400).send('Kunne ikke hente access token: ' + JSON.stringify(tokenData));
    }

    console.log('Pipedrive OAuth success! Access token modtaget.');
    console.log('API domain:', tokenData.api_domain);

    // Vis success-side
    res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>Zalye Dialer - Installeret</title></head>
        <body style="font-family: -apple-system, sans-serif; text-align: center; padding: 60px 20px; background: #f8f9fa;">
          <div style="max-width: 400px; margin: 0 auto; background: white; padding: 40px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
            <div style="font-size: 48px; margin-bottom: 16px;">&#x2705;</div>
            <h1 style="color: #333; margin-bottom: 8px;">Zalye Dialer installeret!</h1>
            <p style="color: #666;">Appen er nu forbundet til din Pipedrive-konto.</p>
            <p style="color: #999; font-size: 14px;">Du kan lukke dette vindue og g\u00e5 tilbage til Pipedrive.</p>
          </div>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('OAuth callback fejl:', error);
    res.status(500).send('Intern fejl under OAuth: ' + error.message);
  }
});

module.exports = router;
