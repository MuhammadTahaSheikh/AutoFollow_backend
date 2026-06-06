function parseFrontendUrls() {
  return (process.env.FRONTEND_URL || 'http://localhost:3000')
    .split(',')
    .map((url) => url.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

/** First URL from FRONTEND_URL (comma-separated for CORS). Prefers HTTPS. */
export function getPrimaryFrontendUrl() {
  const urls = parseFrontendUrls();
  return urls.find((url) => url.startsWith('https://')) || urls[0] || 'http://localhost:3000';
}

/**
 * Base URL for invite links — prefer INVITE_LINK_BASE_URL or a frontend on the same
 * domain as EMAIL_FROM (better inbox placement than vercel.app links).
 */
export function getInviteBaseUrl() {
  const override = process.env.INVITE_LINK_BASE_URL?.trim().replace(/\/$/, '');
  if (override) return override;

  const from = process.env.EMAIL_FROM || '';
  const senderDomain = from.match(/@([a-z0-9.-]+\.[a-z]{2,})/i)?.[1]?.toLowerCase();

  if (senderDomain) {
    const sameDomain = parseFrontendUrls().find((url) => {
      try {
        return new URL(url).hostname.toLowerCase().endsWith(senderDomain);
      } catch {
        return false;
      }
    });
    if (sameDomain) return sameDomain;
  }

  return getPrimaryFrontendUrl();
}
