// Server route: GET /
// Fetches a random image from r/BLAHAJ and caches it in memory for 10 minutes.

const REDDIT_LIST_URL = 'https://www.reddit.com/r/BLAHAJ/hot.json?limit=100';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

type CachedImage = {
  fetchedAt: number;
  data: ArrayBuffer;
  contentType: string;
};

let cached: CachedImage | null = null;

// Cloudflare KV binding (optional). When present, we store a single current
// image there so all workers return the same image for the TTL window.
declare const IMAGES_KV: KVNamespace | undefined;
const KV_KEY = 'current-image';
const KV_META_KEY = 'current-image:meta';
const KV_TTL_SECONDS = Math.floor(CACHE_TTL_MS / 1000);

// Minimal Reddit API types used by the scraper. Keep these narrow to avoid
// importing large type packages and to satisfy the linter.
type RedditPost = {
  url?: string;
  url_overridden_by_dest?: string;
  post_hint?: string;
  preview?: { images?: Array<{ source?: { url?: string } }> };
  score?: number;
};

type RedditChild = { data: RedditPost };

type RedditListing = { data?: { children?: RedditChild[] } };

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
  // Try a few variants because some hosts (or Cloudflare worker egress IPs)
  // may be blocked by Reddit. If a 403 occurs, retry with old.reddit.com and
  // with a browser-like header set (Accept + Referer + common User-Agent).
  const fetchVariants: { url: string; headers: Record<string, string> }[] = [
    { url: REDDIT_LIST_URL, headers: { 'User-Agent': 'blahaj-spinner/1.0 (by /u/anonymous)' } },
    { url: REDDIT_LIST_URL.replace('www.reddit.com', 'old.reddit.com'), headers: { 'User-Agent': 'blahaj-spinner/1.0 (by /u/anonymous)' } },
    {
      url: REDDIT_LIST_URL,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/json',
        Referer: 'https://www.reddit.com/',
      },
    },
    {
      url: REDDIT_LIST_URL.replace('www.reddit.com', 'old.reddit.com'),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/json',
        Referer: 'https://www.reddit.com/',
      },
    },
  ];

  let lastErr: Error | null = null;
  let json: RedditListing | null = null;

  for (const c of fetchVariants) {
    try {
      const res = await fetch(c.url, { headers: c.headers });
      if (!res.ok) {
        // On 403 we try next candidate; record error to give better diagnostics
        lastErr = new Error('Failed to fetch subreddit listing: ' + res.status);
        if (res.status === 403) continue;
        throw lastErr;
      }
      json = (await res.json()) as unknown as RedditListing;
      break;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      // try next candidate
    }
  }

  if (!json) throw lastErr ?? new Error('Failed to fetch subreddit listing');

  const posts: RedditChild[] = Array.isArray(json?.data?.children) ? json.data.children! : [];

  const minUpvotes = getMinUpvotes();

  const candidates = posts
    .map((p) => p.data)
    .filter((d) => {
      const url = d.url_overridden_by_dest || d.url;
      if (!url || typeof url !== 'string') return false;
      if (/\.(jpe?g|png|gif|webp)(\?|$)/i.test(url)) return true;
      if (d.post_hint === 'image') return true;
      if (d.preview?.images?.[0]?.source?.url) return true;
      return false;
    });

  // Filter by upvotes (score). If none meet the threshold, fall back to all candidates.
  const byScore = candidates.filter((d) => typeof d.score === 'number' && (d.score ?? 0) >= minUpvotes);

  const selectedPool = byScore.length > 0 ? byScore : candidates;

  const imageUrls: string[] = selectedPool
    .map((d) => {
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

  // Try KV first (global shared cache)
  if (typeof IMAGES_KV !== 'undefined') {
    try {
      const [buf, metaStr] = await Promise.all([
        IMAGES_KV.get(KV_KEY, 'arrayBuffer'),
        IMAGES_KV.get(KV_META_KEY),
      ]);
      if (buf && metaStr) {
        const meta = JSON.parse(metaStr);
        return new Response(buf, {
          status: 200,
          headers: {
            'Content-Type': meta.contentType,
            'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=60',
            'X-Cache-Source': 'kv',
          },
        });
      }
    } catch (e) {
      console.error('KV read failed', e);
      // fall through to in-memory fetch
    }
  }

  // Serve cached if fresh
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    // Uint8Array is an acceptable BodyInit (BufferSource)
    return new Response(cached.data, {
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

    // Update in-memory cache
    cached = {
      fetchedAt: Date.now(),
      data: arrayBuffer,
      contentType,
    };

    // Try writing to KV so other workers will serve the same image
    if (typeof IMAGES_KV !== 'undefined') {
      try {
        await Promise.all([
          IMAGES_KV.put(KV_KEY, arrayBuffer, { expirationTtl: KV_TTL_SECONDS }),
          IMAGES_KV.put(KV_META_KEY, JSON.stringify({ contentType, fetchedAt: Date.now() }), { expirationTtl: KV_TTL_SECONDS }),
        ]);
      } catch (e) {
        console.error('KV write failed', e);
      }
    }

    return new Response(arrayBuffer, {
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
  return new Response(cached.data, {
        status: 200,
        headers: { 'Content-Type': cached.contentType, 'X-Cache-Status': 'stale' },
      });
    }
    return new Response('Could not fetch image', { status: 502 });
  }
}
