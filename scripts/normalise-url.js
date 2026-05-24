// Usage: node scripts/normalise-url.js "<url or seek job id>"
// Prints the canonical URL to stdout.
// SEEK URLs → https://www.seek.com.au/job/<id>
// Non-SEEK URLs → tracking params stripped, everything else preserved
const input = (process.argv[2] || '').trim();

const SEEK_HOST = /seek\.com/i;
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'gh_src', 'trk', 'referer', 'ref',
]);

function normalise(raw) {
  if (!raw) return '';
  if (/^\d{5,}$/.test(raw)) return `https://www.seek.com.au/job/${raw}`;

  let u;
  try {
    u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
  } catch {
    return raw;
  }

  if (SEEK_HOST.test(u.hostname)) {
    const m = u.pathname.match(/\/job\/(\d+)/);
    if (m) return `https://www.seek.com.au/job/${m[1]}`;
    u.hostname = 'www.seek.com.au';
    u.search = '';
    u.hash = '';
    return u.toString();
  }

  // Non-SEEK: strip hash + known tracking params only
  u.hash = '';
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key)) u.searchParams.delete(key);
  }
  return u.toString();
}

process.stdout.write(normalise(input));
