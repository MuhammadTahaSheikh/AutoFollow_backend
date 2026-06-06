/** First URL from FRONTEND_URL (comma-separated for CORS). Prefers HTTPS for invite links. */
export function getPrimaryFrontendUrl() {
  const urls = (process.env.FRONTEND_URL || 'http://localhost:3000')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);

  return urls.find((url) => url.startsWith('https://')) || urls[0] || 'http://localhost:3000';
}
