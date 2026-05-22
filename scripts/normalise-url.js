// Usage: node scripts/normalise-url.js "<seek url or job id>"
// Prints the canonical https://www.seek.com.au/job/<id> URL to stdout.
const input = (process.argv[2] || '').trim();

function normalise(raw) {
  if (!raw) return '';
  // Bare numeric id
  if (/^\d{5,}$/.test(raw)) return `https://www.seek.com.au/job/${raw}`;
  // Pull a /job/<id> segment from any SEEK host variant
  const m = raw.match(/\/job\/(\d+)/);
  if (m) return `https://www.seek.com.au/job/${m[1]}`;
  // Strip query/hash, rewrite host variants to www.seek.com.au
  try {
    const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    u.search = '';
    u.hash = '';
    if (/^(au\.seek\.com|seek\.com\.au|www\.seek\.com\.au)$/i.test(u.hostname)) {
      u.hostname = 'www.seek.com.au';
    }
    return u.toString();
  } catch {
    return raw;
  }
}

process.stdout.write(normalise(input));
