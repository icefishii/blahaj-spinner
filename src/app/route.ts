// Server route: GET /
// Fetches a random image from r/BLAHAJ and caches it in memory for 10 minutes.

const REDDIT_LIST_URL = 'https://www.reddit.com/r/BLAHAJ/hot.json?limit=100';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

type CachedImage = {
  fetchedAt: number;
  data: Uint8Array;
  contentType: string;
};

let cached: CachedImage | null = null;

function guessContentTypeFromUrl(url: string): string | null {
  if (/\.(jpe?g)(\?|$)/i.test(url)) return 'image/jpeg';
  if (/\.(png)(\?|$)/i.test(url)) return 'image/png';
  if (/\.(gif)(\?|$)/i.test(url)) return 'image/gif';
  if (/\.(webp)(\?|$)/i.test(url)) return 'image/webp';
  return null;
}

const DEFAULT_MIN_UPVOTES = 50;

function getMinUpvotes(): number {
  try {
    const v = process?.env?.MIN_UPVOTES;
    if (!v) return DEFAULT_MIN_UPVOTES;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_MIN_UPVOTES;
  } catch {
    return DEFAULT_MIN_UPVOTES;
  }
}

async function fetchRedditImageUrl(): Promise<string> {
  const res = await fetch(REDDIT_LIST_URL, {
    headers: { 'User-Agent': 'blahaj-spinner/1.0 (by /u/anonymous)' },
  });
  if (!res.ok) throw new Error('Failed to fetch subreddit listing: ' + res.status);
  const json: any = await res.json();

  const posts = Array.isArray(json?.data?.children) ? json.data.children : [];

  const minUpvotes = getMinUpvotes();

  const candidates = posts.map((p: any) => p.data).filter((d: any) => {
    const url = d.url_overridden_by_dest || d.url;
    if (!url || typeof url !== 'string') return false;
    if (/\.(jpe?g|png|gif|webp)(\?|$)/i.test(url)) return true;
    if (d.post_hint === 'image') return true;
    if (d.preview?.images?.[0]?.source?.url) return true;
    return false;
  });

  // Filter by upvotes (score). If none meet the threshold, fall back to all candidates.
  const byScore = candidates.filter((d: any) => typeof d.score === 'number' && d.score >= minUpvotes);

  const selectedPool = byScore.length > 0 ? byScore : candidates;

  const imageUrls: string[] = selectedPool
    .map((d: any) => {
      const url = d.url_overridden_by_dest || d.url || d.preview?.images?.[0]?.source?.url;
      return typeof url === 'string' ? url.replace(/&amp;/g, '&') : '';
    })
    .filter(Boolean);

  if (imageUrls.length === 0) throw new Error('No image posts found in subreddit');

  // Pick a random image
  const idx = Math.floor(Math.random() * imageUrls.length);
  return imageUrls[idx];
}

export async function GET() {
  const now = Date.now();

  // Serve cached if fresh
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return new Response(cached.data as any, {
      status: 200,
      headers: {
        'Content-Type': cached.contentType,
        // Let a CDN cache for 10 minutes and client not cache (so fresh each request to CDN)
        'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=60',
      },
    });
  }

  try {
    const imageUrl = await fetchRedditImageUrl();

    const imgRes = await fetch(imageUrl, { headers: { 'User-Agent': 'blahaj-spinner/1.0' } });
    if (!imgRes.ok) throw new Error('Failed to fetch image: ' + imgRes.status);

    const contentType = imgRes.headers.get('Content-Type') || guessContentTypeFromUrl(imageUrl) || 'application/octet-stream';
  const arrayBuffer = await imgRes.arrayBuffer();
  const data = new Uint8Array(arrayBuffer);

    // Update cache
    cached = {
      fetchedAt: Date.now(),
      data,
      contentType,
    };

  return new Response(data as any, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=60',
      },
    });
  } catch (err) {
    // If we have stale cached image, serve it as fallback
    console.error('Error in / route:', err);
    if (cached) {
  return new Response(cached.data as any, {
        status: 200,
        headers: { 'Content-Type': cached.contentType, 'X-Cache-Status': 'stale' },
      });
    }
    return new Response('Could not fetch image', { status: 502 });
  }
}
