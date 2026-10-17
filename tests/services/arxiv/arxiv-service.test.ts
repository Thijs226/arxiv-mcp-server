/**
 * @fileoverview Tests for ArxivService — search, metadata lookup, and HTML content fetching.
 * Mocks fetch globally and uses zero request delay for fast tests.
 * @module services/arxiv/arxiv-service.test
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { arxivSearchPapers } from '@/mcp-server/tools/definitions/arxiv-search-papers.tool.js';
import {
  buildOutline,
  collapseMathML,
  getArxivService,
  initArxivService,
  isConversionFailurePage,
  resolveRelativeUrls,
  stripHtmlHead,
  stripLatexmlNoise,
} from '@/services/arxiv/arxiv-service.js';
import { PaperMetadataSchema } from '@/services/arxiv/types.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    apiBaseUrl: 'https://export.arxiv.org/api',
    requestDelayMs: 0,
    contentTimeoutMs: 5000,
    apiTimeoutMs: 5000,
  }),
}));

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const mockFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ATOM_SINGLE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>1</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/2401.12345v1</id>
    <title>Test Paper Title</title>
    <summary>Test abstract.</summary>
    <author><name>Alice</name></author>
    <author><name>Bob</name></author>
    <arxiv:primary_category term="cs.AI" />
    <category term="cs.AI" />
    <category term="cs.LG" />
    <published>2024-01-22T00:00:00Z</published>
    <updated>2024-01-22T00:00:00Z</updated>
    <link href="http://arxiv.org/abs/2401.12345v1" rel="alternate" type="text/html" />
    <link href="http://arxiv.org/pdf/2401.12345v1" title="pdf" type="application/pdf" />
    <arxiv:comment>10 pages</arxiv:comment>
  </entry>
</feed>`;

const ATOM_EMPTY = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>0</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
</feed>`;

// Sparse entry: omits arxiv:comment, arxiv:journal_ref, arxiv:doi,
// arxiv:primary_category, and link elements entirely.
const ATOM_SPARSE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>1</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/2401.99999v1</id>
    <title>Sparse Paper</title>
    <summary>Minimal abstract.</summary>
    <author><name>Single Author</name></author>
    <category term="cs.AI" />
    <published>2024-01-22T00:00:00Z</published>
    <updated>2024-01-22T00:00:00Z</updated>
  </entry>
</feed>`;

function atomResponse(xml: string): Response {
  return new Response(xml, {
    status: 200,
    headers: { 'content-type': 'application/atom+xml; charset=UTF-8' },
  });
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=UTF-8' },
  });
}

/**
 * An HTML page as served from `url`. `new Response()` leaves `url` empty, so the
 * served-URL base the service resolves relative links against is set by hand.
 */
function servedPage(html: string, url: string): Response {
  const response = htmlResponse(html);
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

/**
 * A captured arXiv HTML page from `tests/fixtures/arxiv-html/` (gzipped). The
 * `-headings` captures keep every heading of the article but none of its
 * paragraphs; the rest keep the whole article and the site footer after it.
 */
function fixturePage(name: string): string {
  const path = new URL(`../../fixtures/arxiv-html/${name}.html.gz`, import.meta.url);
  return gunzipSync(readFileSync(path)).toString('utf8');
}

/** Single-entry Atom feed for an arbitrary versioned paper ID. */
function atomFor(versionedId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>1</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/${versionedId}</id>
    <title>Fixture ${versionedId}</title><summary>x</summary>
    <author><name>X</name></author>
    <published>2020-01-01T00:00:00Z</published><updated>2020-01-01T00:00:00Z</updated>
  </entry>
</feed>`;
}

/**
 * Serve fixture page `name` for `versionedId` on the requested HTML rung and
 * read it back through the real cleaning pipeline.
 */
async function readFixture(
  versionedId: string,
  name: string,
  rung: 'arxiv_html' | 'ar5iv',
  options: { maxCharacters?: number | null; start?: number } = { maxCharacters: null },
) {
  mockFetch.mockResolvedValueOnce(atomResponse(atomFor(versionedId)));
  if (rung === 'ar5iv') {
    mockFetch
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(
        servedPage(fixturePage(name), `https://ar5iv.labs.arxiv.org/html/${versionedId}`),
      );
  } else {
    mockFetch.mockResolvedValueOnce(
      servedPage(fixturePage(name), `https://arxiv.org/html/${versionedId}`),
    );
  }
  return getArxivService().readContent(versionedId, options, createMockContext());
}

/** Every value of `attr="…"` in `html`, in document order. */
function attrValues(html: string, attr: string): string[] {
  return [...html.matchAll(new RegExp(`\\s${attr}="([^"]*)"`, 'g'))].map((m) => m[1] ?? '');
}

/**
 * Build a minimal but genuinely parseable single-page PDF carrying `text`. Pass
 * an empty string for the image-only (scanned) case, where a page exists but no
 * text layer does. Hand-built rather than mocked so these tests exercise the
 * real `unpdf` extraction the service depends on.
 */
function makePdfBytes(text: string): Uint8Array {
  const stream = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : '';
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefStart = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

function pdfResponse(text: string): Response {
  return new Response(makePdfBytes(text), {
    status: 200,
    headers: { 'content-type': 'application/pdf' },
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockFetch.mockReset();
  initArxivService();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// search()
// ---------------------------------------------------------------------------

describe('ArxivService.search', () => {
  it('parses search results from Atom feed', async () => {
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_SINGLE));
    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.search('all:testing', {}, ctx);

    expect(result.total_results).toBe(1);
    expect(result.start).toBe(0);
    expect(result.papers).toHaveLength(1);
    expect(result.papers[0]).toMatchObject({
      id: '2401.12345v1',
      title: 'Test Paper Title',
      abstract: 'Test abstract.',
      authors: ['Alice', 'Bob'],
      primary_category: 'cs.AI',
      categories: ['cs.AI', 'cs.LG'],
      comment: '10 pages',
    });
  });

  it('sends a descriptive User-Agent identifying this client to arXiv', async () => {
    // arXiv community convention (cf. arxiv.py): include a UA so operators can
    // identify and contact maintainers if a client misbehaves.
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
    const ctx = createMockContext();
    const service = getArxivService();
    await service.search('all:test', {}, ctx);

    const init = mockFetch.mock.calls[0]?.[1];
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['user-agent']).toMatch(/arxiv-mcp-server/);
    expect(headers['user-agent']).toMatch(/github\.com\/cyanheads\/arxiv-mcp-server/);
  });

  it('builds URL with correct query params', async () => {
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
    const ctx = createMockContext();
    const service = getArxivService();
    await service.search('ti:attention', { maxResults: 5, sortBy: 'submitted', start: 10 }, ctx);

    const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/api/query');
    expect(url.searchParams.get('search_query')).toBe('ti:attention');
    expect(url.searchParams.get('max_results')).toBe('5');
    expect(url.searchParams.get('sortBy')).toBe('submittedDate');
    expect(url.searchParams.get('start')).toBe('10');
  });

  it('appends category filter to query with user query wrapped in parens', async () => {
    // Parens scope AND to the whole expression, not just the last bare token —
    // prevents "mixture of experts AND cat:cs.CL" from leaking across categories.
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
    const ctx = createMockContext();
    const service = getArxivService();
    await service.search('all:testing', { category: 'cs.AI' }, ctx);

    const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get('search_query')).toBe('(all:testing) AND cat:cs.AI');
  });

  // Issue #20: the echo is the string that actually went on the wire. Before the
  // fix the handler echoed the raw input query, so a category filter vanished
  // from the reported query while still shaping the results.
  it('returns the wire query as effective_query, category wrapper included', async () => {
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.search('all:testing', { category: 'cs.AI' }, ctx);

    const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(result.effective_query).toBe(url.searchParams.get('search_query'));
    expect(result.effective_query).toBe('(all:testing) AND cat:cs.AI');
  });

  // Issue #20 acceptance: replaying the echo as the bare query, with no filter
  // options at all, has to reach arXiv as the identical search_query — otherwise
  // a caller replaying it gets a different result set than was reported.
  it('replays effective_query to the identical wire query (category + date window)', async () => {
    // Fresh Response per call — a shared one throws ERR_BODY_ALREADY_USED.
    mockFetch.mockImplementation(async () => atomResponse(ATOM_EMPTY));
    const ctx = createMockContext();
    const service = getArxivService();

    const first = await service.search(
      'all:transformer',
      { category: 'cs.CL', submittedFrom: '2020-01-01', submittedTo: '2020-01-31' },
      ctx,
    );
    await service.search(first.effective_query, {}, ctx);

    const originalQuery = new URL(String(mockFetch.mock.calls[0]?.[0])).searchParams.get(
      'search_query',
    );
    const replayedQuery = new URL(String(mockFetch.mock.calls[1]?.[0])).searchParams.get(
      'search_query',
    );
    expect(replayedQuery).toBe(originalQuery);
    expect(originalQuery).toBe(
      '(all:transformer) AND cat:cs.CL AND submittedDate:[202001010000 TO 202002010000]',
    );
  });

  // Issue #32: a bare archive code has to reach the whole subtree. `cat:astro-ph`
  // alone is only the 105,380 legacy flat papers, not the 388,854-paper archive.
  it('wildcards a bare archive code to its subtree', async () => {
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
    const ctx = createMockContext();
    const service = getArxivService();
    await service.search('dark matter', { category: 'astro-ph' }, ctx);

    const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get('search_query')).toBe('(dark matter) AND cat:astro-ph*');
  });

  // Issue #32: `cat:math*` also prefix-matches math-ph, a physics archive with
  // 91,063 papers of its own. The spelled-out subtree keeps it out.
  it('avoids the math / math-ph prefix collision', async () => {
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
    const ctx = createMockContext();
    const service = getArxivService();
    await service.search('manifold', { category: 'math' }, ctx);

    const searchQuery = new URL(String(mockFetch.mock.calls[0]?.[0])).searchParams.get(
      'search_query',
    );
    expect(searchQuery).toBe('(manifold) AND (cat:math.* OR cat:math)');
    expect(searchQuery).not.toContain('cat:math*');
  });

  it('keeps a leaf code an exact match', async () => {
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
    const ctx = createMockContext();
    const service = getArxivService();
    await service.search('folding', { category: 'q-bio.BM' }, ctx);

    const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get('search_query')).toBe('(folding) AND cat:q-bio.BM');
  });

  it('accepts bare archive and group codes that used to be rejected', async () => {
    const ctx = createMockContext();
    const service = getArxivService();
    for (const category of ['astro-ph', 'cond-mat', 'cs', 'econ', 'q-fin', 'physics']) {
      mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
      await expect(service.search('anything', { category }, ctx)).resolves.toBeDefined();
    }
  });

  // Issue #27 — the date window reaches arXiv as a submittedDate clause, and the
  // upper bound is midnight of the day AFTER submitted_to. A same-day 2359 bound
  // would drop that day's last 59 seconds: arXiv compares the bound against the
  // full-precision submission timestamp, not a minute bucket.
  it('folds an inclusive date window into the wire query', async () => {
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
    const ctx = createMockContext();
    const service = getArxivService();
    await service.search(
      'all:transformer',
      { submittedFrom: '2020-01-01', submittedTo: '2020-01-31' },
      ctx,
    );

    const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get('search_query')).toBe(
      '(all:transformer) AND submittedDate:[202001010000 TO 202002010000]',
    );
  });

  it('substitutes a sentinel for an omitted bound so the range stays well-formed', async () => {
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
    const ctx = createMockContext();
    const service = getArxivService();
    await service.search('all:transformer', { submittedFrom: '2020-01-01' }, ctx);

    const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get('search_query')).toBe(
      '(all:transformer) AND submittedDate:[202001010000 TO 300001010000]',
    );
  });

  it('emits adjacent windows that meet at one instant, leaving no gap', async () => {
    // Fresh Response per call — a shared one throws ERR_BODY_ALREADY_USED.
    mockFetch.mockImplementation(async () => atomResponse(ATOM_EMPTY));
    const ctx = createMockContext();
    const service = getArxivService();
    await service.search('q', { submittedFrom: '2020-01-01', submittedTo: '2020-01-15' }, ctx);
    await service.search('q', { submittedFrom: '2020-01-16', submittedTo: '2020-01-31' }, ctx);

    const first = new URL(String(mockFetch.mock.calls[0]?.[0])).searchParams.get('search_query');
    const second = new URL(String(mockFetch.mock.calls[1]?.[0])).searchParams.get('search_query');
    expect(first).toContain('TO 202001160000]');
    expect(second).toContain('submittedDate:[202001160000 ');
  });

  it('rejects a date that is not a real calendar date', async () => {
    const ctx = createMockContext();
    const service = getArxivService();
    await expect(service.search('q', { submittedFrom: '2020-02-31' }, ctx)).rejects.toThrow(
      /not a real UTC calendar date/,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects an inverted date window', async () => {
    const ctx = createMockContext();
    const service = getArxivService();
    await expect(
      service.search('q', { submittedFrom: '2024-05-01', submittedTo: '2024-04-01' }, ctx),
    ).rejects.toThrow(/is after submitted_to/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('wraps multi-word unprefixed queries so category scopes the whole expression', async () => {
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
    const ctx = createMockContext();
    const service = getArxivService();
    await service.search('mixture of experts', { category: 'cs.CL' }, ctx);

    const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get('search_query')).toBe('(mixture of experts) AND cat:cs.CL');
  });

  it('rejects unknown categories with a near-match suggestion', async () => {
    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.search('llm', { category: 'cs.INVALID' }, ctx)).rejects.toThrow(
      /Unknown arXiv category 'cs\.INVALID'\. Did you mean: cs\./,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects unknown categories outside the taxonomy with edit-distance fallback', async () => {
    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.search('anything', { category: 'foo.BAR' }, ctx)).rejects.toThrow(
      /Unknown arXiv category 'foo\.BAR'/,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fails fast on "Rate exceeded" plain-text response without retrying', async () => {
    // arXiv returns 200 OK with `Rate exceeded.` body when throttling. Retrying
    // violates arXiv's 3s crawl etiquette and amplifies the throttle — surface
    // the rate-limit immediately. See issue #8.
    mockFetch.mockResolvedValueOnce(
      new Response('Rate exceeded.', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );

    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.search('all:test', {}, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('fails fast on 4xx without retrying', async () => {
    // arXiv returns HTTP 400 for bad input (e.g., non-integer max_results) with
    // an atom+xml content-type. These are permanent client errors and must not
    // be retried — see https://github.com/cyanheads/arxiv-mcp-server/issues/1.
    mockFetch.mockResolvedValueOnce(
      new Response('<feed/>', {
        status: 400,
        headers: { 'content-type': 'application/atom+xml; charset=UTF-8' },
      }),
    );
    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.search('bad query', {}, ctx)).rejects.toThrow(/HTTP 400/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx transient server error', async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response('<feed/>', {
          status: 503,
          headers: { 'content-type': 'application/atom+xml; charset=UTF-8' },
        }),
      )
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE));

    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.search('all:test', {}, ctx);

    expect(result.papers).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('fails fast on fetch timeout without retrying', async () => {
    // AbortSignal.timeout fires when arXiv hangs (typically connection-layer
    // throttling). The previous classification wrapped this as ServiceUnavailable
    // and retried, doubling caller-visible latency and upstream load. Surface as
    // Timeout and let the caller back off. See production logs 2026-05-08
    // (sessionId fae92e81…, requests with rootCause TimeoutError, durationMs 60-90s).
    const timeoutErr = Object.assign(new Error('The operation timed out.'), {
      name: 'TimeoutError',
    });
    mockFetch.mockRejectedValueOnce(timeoutErr);

    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.search('all:test', {}, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('fails fast on HTTP 429 and surfaces Retry-After header', async () => {
    // 429 means arXiv is throttling — retrying makes it worse. Surface the
    // Retry-After header so clients can honor the cooldown. See issue #8.
    mockFetch.mockResolvedValueOnce(
      new Response('<feed/>', {
        status: 429,
        headers: {
          'content-type': 'application/atom+xml; charset=UTF-8',
          'retry-after': '60',
        },
      }),
    );

    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.search('all:test', {}, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { status: 429, retryAfter: '60' },
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('honors Retry-After at the queue level — subsequent calls wait the cooldown', async () => {
    // When arXiv signals throttle, the cooldown applies to ALL queued calls,
    // not just the one that hit the rate-limit. Otherwise N concurrent callers
    // each hit the same rate-limit window in parallel. Retry-After larger than
    // the adaptive base (5s) wins; smaller values are floored by the adaptive
    // formula. See issues #8, #9.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // Call 1: 429 with Retry-After: 8 (seconds) — larger than adaptive 5s base
      mockFetch.mockResolvedValueOnce(
        new Response('<feed/>', {
          status: 429,
          headers: {
            'content-type': 'application/atom+xml; charset=UTF-8',
            'retry-after': '8',
          },
        }),
      );
      // Call 2: success (should fire only after the 8s cooldown)
      mockFetch.mockResolvedValueOnce(atomResponse(ATOM_SINGLE));

      const service = getArxivService();
      const p1 = service.search('first', {}, createMockContext());
      const p2 = service.search('second', {}, createMockContext());

      await expect(p1).rejects.toMatchObject({ code: JsonRpcErrorCode.RateLimited });
      // After p1 settled, only one fetch has happened.
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Advance just shy of the cooldown — second call still waiting.
      await vi.advanceTimersByTimeAsync(7500);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Advance past the cooldown — second call dispatches and resolves.
      await vi.advanceTimersByTimeAsync(700);
      const result = await p2;
      expect(result.papers).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('grows cooldown geometrically on consecutive rate-limit hits (issue #9)', async () => {
    // First hit: 5s, second: 10s, third: 20s, fourth: 30s (capped). The error
    // data surfaces cooldownAppliedMs and consecutiveRateLimits so callers can
    // self-throttle.
    const rateLimited200 = (): Response =>
      new Response('Rate exceeded.', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    mockFetch
      .mockResolvedValueOnce(rateLimited200())
      .mockResolvedValueOnce(rateLimited200())
      .mockResolvedValueOnce(rateLimited200())
      .mockResolvedValueOnce(rateLimited200());

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const service = getArxivService();
      const expected = [
        { cooldownAppliedMs: 5_000, consecutiveRateLimits: 1, advance: 5_100 },
        { cooldownAppliedMs: 10_000, consecutiveRateLimits: 2, advance: 10_100 },
        { cooldownAppliedMs: 20_000, consecutiveRateLimits: 3, advance: 20_100 },
        { cooldownAppliedMs: 30_000, consecutiveRateLimits: 4, advance: 0 },
      ];
      for (const { cooldownAppliedMs, consecutiveRateLimits, advance } of expected) {
        const p = service.search('t', {}, createMockContext());
        await expect(p).rejects.toMatchObject({
          code: JsonRpcErrorCode.RateLimited,
          data: { cooldownAppliedMs, consecutiveRateLimits },
        });
        if (advance > 0) await vi.advanceTimersByTimeAsync(advance);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets consecutive rate-limit counter on successful response (issue #9)', async () => {
    // Two rate-limit hits grow the cooldown, then a success resets the counter
    // so the next rate-limit goes back to the 5s base.
    const rateLimited200 = (): Response =>
      new Response('Rate exceeded.', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    mockFetch
      .mockResolvedValueOnce(rateLimited200()) // 5s
      .mockResolvedValueOnce(rateLimited200()) // 10s
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE)) // success → reset
      .mockResolvedValueOnce(rateLimited200()); // 5s again (not 20s)

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const service = getArxivService();

      const p1 = service.search('t', {}, createMockContext());
      await expect(p1).rejects.toMatchObject({
        data: { cooldownAppliedMs: 5_000, consecutiveRateLimits: 1 },
      });
      await vi.advanceTimersByTimeAsync(5_100);

      const p2 = service.search('t', {}, createMockContext());
      await expect(p2).rejects.toMatchObject({
        data: { cooldownAppliedMs: 10_000, consecutiveRateLimits: 2 },
      });
      await vi.advanceTimersByTimeAsync(10_100);

      // Success — counter resets
      await service.search('t', {}, createMockContext());

      // Next rate-limit starts fresh at the 5s base
      const p4 = service.search('t', {}, createMockContext());
      await expect(p4).rejects.toMatchObject({
        data: { cooldownAppliedMs: 5_000, consecutiveRateLimits: 1 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('200 "Rate exceeded" and 429 rate-limit paths emit symmetric error data (issue #9)', async () => {
    // Both paths must carry the same diagnostic fields so callers can branch on
    // a single shape. Pre-fix, the 200 path emitted only {url}. The recovery
    // hint is filled at the tool/resource boundary from the declared errors[]
    // contract, not in the service, so this check covers service-level parity only.
    const expectedKeys = new Set([
      'url',
      'status',
      'body',
      'cooldownAppliedMs',
      'consecutiveRateLimits',
      'reason',
    ]);

    // 200 + Rate exceeded
    mockFetch.mockResolvedValueOnce(
      new Response('Rate exceeded.', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    let service = getArxivService();
    let err: unknown;
    try {
      await service.search('t', {}, createMockContext());
    } catch (e) {
      err = e;
    }
    const data200 = (err as { data: Record<string, unknown> }).data;
    for (const key of expectedKeys) {
      expect(data200, `200 path missing ${key}`).toHaveProperty(key);
    }
    expect(data200.status).toBe(200);

    // Reset service so the counter starts fresh
    initArxivService();
    service = getArxivService();

    // 429
    mockFetch.mockResolvedValueOnce(
      new Response('Rate exceeded', {
        status: 429,
        headers: {
          'content-type': 'application/atom+xml; charset=UTF-8',
          'retry-after': '4',
        },
      }),
    );
    try {
      await service.search('t', {}, createMockContext());
    } catch (e) {
      err = e;
    }
    const data429 = (err as { data: Record<string, unknown> }).data;
    for (const key of expectedKeys) {
      expect(data429, `429 path missing ${key}`).toHaveProperty(key);
    }
    expect(data429.status).toBe(429);
    expect(data429.retryAfter).toBe('4');
  });

  it('rate-limit message names the applied cooldown in ms (issue #9)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('Rate exceeded.', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    const service = getArxivService();
    await expect(service.search('t', {}, createMockContext())).rejects.toThrow(
      /arXiv rate limit exceeded — server applied 5000ms cooldown/,
    );
  });

  it('skips queued requests whose ctx.signal aborted before their turn', async () => {
    // A cancelled request shouldn't consume a 3s queue slot — drop it at the
    // queue head so the next live caller dispatches immediately.
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_SINGLE));

    const liveCtx = createMockContext();
    const cancelledCtrl = new AbortController();
    const cancelledCtx = createMockContext({ signal: cancelledCtrl.signal });
    cancelledCtrl.abort(new Error('user cancelled'));

    const service = getArxivService();

    await expect(service.search('cancelled', {}, cancelledCtx)).rejects.toThrow(/cancelled/);
    expect(mockFetch).not.toHaveBeenCalled();

    // Live request after the cancelled one still works.
    const result = await service.search('live', {}, liveCtx);
    expect(result.papers).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Issue #56 — arXiv serves only the first 10,000 results of a query: a request
// whose start + max_results passes 10,000 answers HTTP 500, whatever the total.
// ---------------------------------------------------------------------------

describe('ArxivService.search — the 10,000-result limit (#56)', () => {
  /** Requests the fake API received, as [start, max_results]. */
  let requests: Array<[number, number]>;

  /**
   * A fake arXiv query endpoint holding `total` matches that, like the real one,
   * answers HTTP 500 to any request reaching past result 10,000.
   */
  function fakeArxiv(total: number) {
    requests = [];
    mockFetch.mockImplementation(async (input) => {
      const params = new URL(String(input)).searchParams;
      const start = Number(params.get('start'));
      const max = Number(params.get('max_results'));
      requests.push([start, max]);
      if (start + max > 10_000) return new Response('internal error', { status: 500 });
      const count = Math.max(0, Math.min(max, total - start));
      const entries = Array.from(
        { length: count },
        (_, i) => `<entry>
    <id>http://arxiv.org/abs/2401.${String(start + i).padStart(5, '0')}v1</id>
    <title>Result ${start + i + 1}</title><summary>x</summary>
    <author><name>X</name></author>
    <published>2020-01-01T00:00:00Z</published><updated>2020-01-01T00:00:00Z</updated>
  </entry>`,
      ).join('\n');
      return atomResponse(`<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>${total}</opensearch:totalResults>
  <opensearch:startIndex>${start}</opensearch:startIndex>
  ${entries}
</feed>`);
    });
  }

  const textOf = (result: { content: { type: string; text?: string }[] }) =>
    result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');

  it('cuts a page that would cross result 10,000 to the results arXiv serves', async () => {
    fakeArxiv(13_549);
    const result = await getArxivService().search(
      'all:the',
      { start: 9_990, maxResults: 50 },
      createMockContext(),
    );

    expect(requests).toEqual([[9_990, 10]]);
    expect(result.papers).toHaveLength(10);
    expect(result.result_limit).toBe(10_000);
  });

  it('sends a page ending exactly at result 10,000 unchanged', async () => {
    fakeArxiv(13_549);
    await getArxivService().search(
      'all:the',
      { start: 9_950, maxResults: 50 },
      createMockContext(),
    );
    expect(requests).toEqual([[9_950, 50]]);
  });

  it('refuses a start with nothing reachable before any request, naming the range', async () => {
    fakeArxiv(13_549);
    await expect(
      getArxivService().search('all:the', { start: 10_000, maxResults: 1 }, createMockContext()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('first 10000 results'),
      data: { reason: 'start_beyond_result_limit', start: 10_000, resultLimit: 10_000 },
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('discloses a cut page through structuredContent and content[]', async () => {
    fakeArxiv(13_549);
    const result = await runToolContract(arxivSearchPapers, {
      query: 'all:the',
      start: 9_990,
      max_results: 50,
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(requests).toEqual([[9_990, 10]]);
    const structured = result.structuredContent as {
      papers: unknown[];
      truncated: boolean;
      shown: number;
      cap: number;
      notice: string;
    };
    expect(structured).toMatchObject({ truncated: true, shown: 10, cap: 10 });
    expect(structured.papers).toHaveLength(10);
    expect(structured.notice).toContain('arXiv serves only the first 10000');
    expect(structured.notice).toContain('submitted_from');
    expect(structured.notice).not.toMatch(/start=/);
    const text = textOf(result);
    expect(text).toContain('arXiv serves only the first 10000');
    expect(text).toContain('\n**truncated:** true\n**shown:** 10\n**cap:** 10\n');
  });

  it('refuses start=10000 at the tool with start_beyond_result_limit and its recovery', async () => {
    fakeArxiv(13_549);
    const result = await runToolContract(arxivSearchPapers, {
      query: 'all:the',
      start: 10_000,
      max_results: 10,
    });

    expect(result.isError).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
    const error = (
      result.structuredContent as {
        error: { code: number; data: { reason: string; recovery: { hint: string } } };
      }
    ).error;
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data.reason).toBe('start_beyond_result_limit');
    expect(error.data.recovery.hint).toContain('below 10000');
    expect(error.data.recovery.hint).toContain('submitted_from');
    expect(textOf(result)).toContain('below 10000');
  });

  // Every recipe the truncation notice prints has to run: follow the printed
  // start= against the fake and confirm arXiv is never asked past 10,000.
  it.each([
    { total: 9_995, start: 9_900 },
    { total: 10_000, start: 9_940 },
    { total: 42, start: 0 },
  ])(
    'follows the printed start= without a 500 (total $total from $start)',
    async ({ total, start }) => {
      fakeArxiv(total);
      let next: number | undefined = start;
      let pages = 0;
      while (next !== undefined) {
        const page: number = next;
        const result = await runToolContract(arxivSearchPapers, {
          query: 'all:the',
          start: page,
          max_results: 50,
        });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        const notice: string | undefined = (result.structuredContent as { notice?: string }).notice;
        const printed: string | undefined = notice ? /start=(\d+)/.exec(notice)?.[1] : undefined;
        next = printed === undefined ? undefined : Number(printed);
        pages++;
        expect(pages).toBeLessThan(5);
      }
      expect(requests.every(([s, m]) => s + m <= 10_000)).toBe(true);
      // The walk reached the last match.
      const [lastStart, lastMax] = requests.at(-1) ?? [0, 0];
      expect(lastStart + lastMax).toBeGreaterThanOrEqual(total);
    },
  );
});

// ---------------------------------------------------------------------------
// getPapers()
// ---------------------------------------------------------------------------

describe('ArxivService.getPapers', () => {
  it('returns papers and builds id_list URL param', async () => {
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_SINGLE));
    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.getPapers(['2401.12345'], ctx);

    expect(result.papers).toHaveLength(1);
    expect(result.papers[0]?.id).toBe('2401.12345v1');
    expect(result.not_found).toBeUndefined();

    const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get('id_list')).toBe('2401.12345');
  });

  it('detects not-found paper IDs', async () => {
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_SINGLE));
    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.getPapers(['2401.12345', '9999.99999'], ctx);

    expect(result.papers).toHaveLength(1);
    expect(result.not_found).toEqual([{ id: '9999.99999', reason: 'not_in_arxiv' }]);
  });

  it('preserves input order regardless of arXiv response order (issue #5)', async () => {
    // arXiv returns entries in submission-date desc, not the order we asked
    // for. The service must re-index by input so callers can stitch metadata
    // back to an ordered reference list.
    const ATOM_REORDERED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>3</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/2401.00003v1</id>
    <title>C</title><summary>c</summary>
    <author><name>X</name></author>
    <published>2024-03-01T00:00:00Z</published><updated>2024-03-01T00:00:00Z</updated>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2401.00001v1</id>
    <title>A</title><summary>a</summary>
    <author><name>X</name></author>
    <published>2024-01-01T00:00:00Z</published><updated>2024-01-01T00:00:00Z</updated>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2401.00002v1</id>
    <title>B</title><summary>b</summary>
    <author><name>X</name></author>
    <published>2024-02-01T00:00:00Z</published><updated>2024-02-01T00:00:00Z</updated>
  </entry>
</feed>`;
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_REORDERED));
    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.getPapers(['2401.00001', '2401.00002', '2401.00003'], ctx);

    expect(result.papers.map((p) => p.id)).toEqual([
      '2401.00001v1',
      '2401.00002v1',
      '2401.00003v1',
    ]);
  });

  it('preserves input order across mixed versioned and unversioned IDs (issue #5)', async () => {
    // Input may carry version suffixes inconsistently; the reorder must compare
    // by base id so a versioned input lines up with arXiv's versioned response.
    const ATOM_MIXED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>2</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/2401.00002v3</id>
    <title>B</title><summary>b</summary>
    <author><name>X</name></author>
    <published>2024-02-01T00:00:00Z</published><updated>2024-02-01T00:00:00Z</updated>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2401.00001v1</id>
    <title>A</title><summary>a</summary>
    <author><name>X</name></author>
    <published>2024-01-01T00:00:00Z</published><updated>2024-01-01T00:00:00Z</updated>
  </entry>
</feed>`;
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_MIXED));
    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.getPapers(['2401.00001v1', '2401.00002'], ctx);

    expect(result.papers.map((p) => p.id)).toEqual(['2401.00001v1', '2401.00002v3']);
  });

  it('keeps two explicit versions of one paper in distinct slots (issue #28)', async () => {
    // arXiv honors a `vN` suffix in id_list and returns one entry per requested
    // version, newest first. Matching on base ID alone collapses both slots onto
    // whichever entry landed last in the index.
    const ATOM_TWO_VERSIONS = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>2</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <title>Attention Is All You Need</title><summary>v7</summary>
    <author><name>Vaswani</name></author>
    <published>2017-06-12T00:00:00Z</published><updated>2023-08-02T00:00:00Z</updated>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v1</id>
    <title>Attention Is All You Need</title><summary>v1</summary>
    <author><name>Vaswani</name></author>
    <published>2017-06-12T00:00:00Z</published><updated>2017-06-12T00:00:00Z</updated>
  </entry>
</feed>`;
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_TWO_VERSIONS));
    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.getPapers(['1706.03762v1', '1706.03762v7'], ctx);

    const url = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get('id_list')).toBe('1706.03762v1,1706.03762v7');
    expect(result.papers.map((p) => p.id)).toEqual(['1706.03762v1', '1706.03762v7']);
    expect(result.papers.map((p) => p.abstract)).toEqual(['v1', 'v7']);
    expect(result.not_found).toBeUndefined();
  });

  it('reports an explicitly requested version arXiv did not return as not found (issue #25)', async () => {
    // ATOM_SINGLE carries 2401.12345v1 only — a v2 request must not resolve to it.
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_SINGLE));
    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.getPapers(['2401.12345v2'], ctx);

    expect(result.papers).toHaveLength(0);
    expect(result.not_found).toEqual([{ id: '2401.12345v2', reason: 'not_in_arxiv' }]);
  });

  it('handles sparse upstream entries without fabricating optional fields', async () => {
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_SPARSE));
    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.getPapers(['2401.99999'], ctx);
    const [paper] = result.papers;

    expect(paper).toBeDefined();
    // Output validates against the published schema even with omitted upstream fields
    expect(() => PaperMetadataSchema.parse(paper)).not.toThrow();
    // Genuinely-optional fields stay unset, not coerced into empty strings
    expect(paper?.comment).toBeUndefined();
    expect(paper?.journal_ref).toBeUndefined();
    expect(paper?.doi).toBeUndefined();
    // Primary category falls back to first <category> element when arxiv:primary_category is omitted
    expect(paper?.primary_category).toBe('cs.AI');
    // URLs derive deterministically from the paper ID when <link> elements are omitted
    expect(paper?.pdf_url).toBe('https://arxiv.org/pdf/2401.99999v1');
    expect(paper?.abstract_url).toBe('https://arxiv.org/abs/2401.99999v1');
  });

  // Issue #45: element text that reads as a number keeps its exact upstream
  // spelling, and a comment of "0" is a comment, not an absent one.
  it('keeps numeric-looking text fields verbatim, and the feed counters as numbers', async () => {
    mockFetch.mockResolvedValueOnce(
      atomResponse(`<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>3</opensearch:totalResults>
  <opensearch:startIndex>2</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/2401.00045v1</id>
    <title>1.10</title>
    <summary>007</summary>
    <author><name>1e5</name></author>
    <author><name>+5</name></author>
    <category term="1.10" />
    <published>2024-01-22T00:00:00Z</published>
    <updated>2024-01-22T00:00:00Z</updated>
    <arxiv:comment>0</arxiv:comment>
    <arxiv:journal_ref>0x1F</arxiv:journal_ref>
    <arxiv:doi>-0.50</arxiv:doi>
  </entry>
</feed>`),
    );
    const result = await getArxivService().search('all:numeric', {}, createMockContext());
    const [paper] = result.papers;

    expect(result.total_results).toBe(3);
    expect(result.start).toBe(2);
    expect(paper).toMatchObject({
      title: '1.10',
      abstract: '007',
      authors: ['1e5', '+5'],
      categories: ['1.10'],
      comment: '0',
      journal_ref: '0x1F',
      doi: '-0.50',
    });
  });
});

// ---------------------------------------------------------------------------
// readContent()
// ---------------------------------------------------------------------------

describe('ArxivService.readContent', () => {
  it('fetches metadata then HTML from arxiv.org', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse('<html><body>Paper content</body></html>'));

    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.readContent('2401.12345', {}, ctx);

    expect(result.paper_id).toBe('2401.12345v1');
    expect(result.title).toBe('Test Paper Title');
    expect(result.source).toBe('arxiv_html');
    expect(result.content).toBe('<html><body>Paper content</body></html>');
    expect(result.truncated).toBe(false);
    expect(result.total_characters).toBe(39);
    expect(result.body_characters).toBe(39);
  });

  it('truncates content when max_characters is set', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse('x'.repeat(100)));

    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.readContent('2401.12345', { maxCharacters: 10 }, ctx);

    expect(result.truncated).toBe(true);
    expect(result.start).toBe(0);
    expect(result.content).toBe('x'.repeat(10));
    expect(result.total_characters).toBe(100);
  });

  it('slices from start offset when paginating', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse('abcdefghij'.repeat(10)));

    const ctx = createMockContext();
    const service = getArxivService();
    // body_characters = 100; ask for chars 30..49
    const result = await service.readContent('2401.12345', { maxCharacters: 20, start: 30 }, ctx);

    expect(result.start).toBe(30);
    expect(result.body_characters).toBe(100);
    expect(result.content).toHaveLength(20);
    expect(result.content).toBe('abcdefghij'.repeat(10).slice(30, 50));
    expect(result.truncated).toBe(true);
  });

  it('returns empty content with truncated=false when start is past body_characters', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse('a'.repeat(50)));

    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.readContent(
      '2401.12345',
      { maxCharacters: 100, start: 9999 },
      ctx,
    );

    expect(result.start).toBe(9999);
    expect(result.content).toBe('');
    expect(result.truncated).toBe(false);
    expect(result.body_characters).toBe(50);
  });

  it('reports truncated=false when the slice ends exactly at body_characters', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse('z'.repeat(100)));

    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.readContent('2401.12345', { maxCharacters: 50, start: 50 }, ctx);

    expect(result.start).toBe(50);
    expect(result.content).toHaveLength(50);
    expect(result.truncated).toBe(false);
  });

  it('falls back to ar5iv when arxiv.org returns 404', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(htmlResponse('<html>ar5iv content</html>'));

    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.readContent('2401.12345', {}, ctx);

    expect(result.source).toBe('ar5iv');
    expect(result.content).toBe('<html>ar5iv content</html>');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('forwards the versioned paper ID to arxiv.org HTML fetch (issue #10)', async () => {
    // Versioned input must reach the HTML host with the version intact —
    // arxiv.org/html honors a version suffix, so stripping it silently served
    // the latest version instead of the requested one.
    const ATOM_V1 = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>1</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/2401.12345v1</id>
    <title>V1 Title</title><summary>v1 abstract</summary>
    <author><name>X</name></author>
    <published>2024-01-22T00:00:00Z</published><updated>2024-01-22T00:00:00Z</updated>
  </entry>
</feed>`;
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_V1))
      .mockResolvedValueOnce(htmlResponse('<html>v1 body</html>'));

    const ctx = createMockContext();
    const service = getArxivService();
    await service.readContent('2401.12345v1', {}, ctx);

    // Second fetch (HTML) URL must include the version
    const htmlUrl = String(mockFetch.mock.calls[1]?.[0]);
    expect(htmlUrl).toBe('https://arxiv.org/html/2401.12345v1');
  });

  it('forwards the versioned ID through to the ar5iv fallback (issue #10)', async () => {
    // When arxiv.org/html returns 404 for a versioned paper, the ar5iv fallback
    // must also receive the version — not the stripped form.
    const ATOM_V1 = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>1</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/2401.12345v2</id>
    <title>V2</title><summary>v2</summary>
    <author><name>X</name></author>
    <published>2024-02-01T00:00:00Z</published><updated>2024-02-01T00:00:00Z</updated>
  </entry>
</feed>`;
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_V1))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(htmlResponse('<html>v2 from ar5iv</html>'));

    const ctx = createMockContext();
    const service = getArxivService();
    await service.readContent('2401.12345v2', {}, ctx);

    expect(String(mockFetch.mock.calls[1]?.[0])).toBe('https://arxiv.org/html/2401.12345v2');
    expect(String(mockFetch.mock.calls[2]?.[0])).toBe(
      'https://ar5iv.labs.arxiv.org/html/2401.12345v2',
    );
  });

  it('points the PDF fallback hint at the same version that was requested (issue #10)', async () => {
    // When no artifact is available at all, the error message points the caller
    // at the PDF — and that hint must match the version they asked for, not the
    // stripped form.
    const ATOM_V1 = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>1</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/2401.12345v1</id>
    <title>V1</title><summary>v1</summary>
    <author><name>X</name></author>
    <published>2024-01-22T00:00:00Z</published><updated>2024-01-22T00:00:00Z</updated>
  </entry>
</feed>`;
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_V1))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 307 }))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.readContent('2401.12345v1', {}, ctx)).rejects.toThrow(
      /https:\/\/arxiv\.org\/pdf\/2401\.12345v1/,
    );
  });

  it('throws notFound when paper does not exist', async () => {
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_EMPTY));
    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.readContent('9999.99999', {}, ctx)).rejects.toThrow(/not found/i);
  });

  it('throws content_unavailable when no HTML render and no PDF exist', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      // arxiv.org/html returns 404
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      // ar5iv returns 307 redirect (paper not converted)
      .mockResolvedValueOnce(new Response('', { status: 307 }))
      // the PDF is gone too — nothing left to read
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.readContent('2401.12345', {}, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'content_unavailable' },
    });
  });

  // -------------------------------------------------------------------------
  // PDF text extraction fallback (issue #23)
  // -------------------------------------------------------------------------

  it('extracts PDF text when neither arxiv.org/html nor ar5iv has a render', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 307 }))
      .mockResolvedValueOnce(pdfResponse('Chip-Scale Rydberg Atomic Electrometer'));

    const ctx = createMockContext();
    const result = await getArxivService().readContent('2401.12345', {}, ctx);

    expect(result.source).toBe('pdf_text');
    expect(result.content).toContain('Chip-Scale Rydberg Atomic Electrometer');
    expect(result.truncated).toBe(false);
    // Extracted text needs no cleaning, so both counts describe the same string.
    expect(result.total_characters).toBe(result.body_characters);
    expect(result.pdf_url).toBe('http://arxiv.org/pdf/2401.12345v1');
  });

  it('fetches the PDF from the metadata pdf_url', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 307 }))
      .mockResolvedValueOnce(pdfResponse('body'));

    await getArxivService().readContent('2401.12345', {}, createMockContext());

    expect(String(mockFetch.mock.calls[3]?.[0])).toBe('http://arxiv.org/pdf/2401.12345v1');
  });

  it('leaves extracted text unstripped — no HTML cleaning is applied to PDF output', async () => {
    // The LaTeXML strippers key off markup that plain PDF text never contains;
    // running them would only risk mangling literal angle brackets in the prose.
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 307 }))
      .mockResolvedValueOnce(pdfResponse('id=42 class=ltx_para retained'));

    const result = await getArxivService().readContent('2401.12345', {}, createMockContext());

    expect(result.content).toContain('id=42 class=ltx_para retained');
  });

  it('pages extracted PDF text with start and max_characters', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 307 }))
      .mockResolvedValueOnce(pdfResponse('abcdefghijklmnopqrstuvwxyz'));

    const result = await getArxivService().readContent(
      '2401.12345',
      { maxCharacters: 5, start: 3 },
      createMockContext(),
    );

    expect(result.start).toBe(3);
    expect(result.content).toBe('defgh');
    expect(result.truncated).toBe(true);
    expect(result.body_characters).toBe(26);
  });

  it('treats an empty extraction as a failure, not an empty success', async () => {
    // An image-only (scanned) PDF parses fine but yields no text layer.
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 307 }))
      .mockResolvedValueOnce(pdfResponse(''));

    await expect(
      getArxivService().readContent('2401.12345', {}, createMockContext()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'pdf_extraction_failed', pdfUrl: 'http://arxiv.org/pdf/2401.12345v1' },
    });
  });

  it('never reaches the PDF when arxiv.org/html serves a render', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse('<article><p>native content</p></article>'));

    const result = await getArxivService().readContent('2401.12345', {}, createMockContext());

    expect(result.source).toBe('arxiv_html');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries a 5xx from the PDF host and surfaces ServiceUnavailable', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 307 }))
      .mockResolvedValueOnce(new Response('Server Error', { status: 500 }))
      // withRetry replays the whole chain once (maxRetries=1)
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 307 }))
      .mockResolvedValueOnce(new Response('Server Error', { status: 500 }));

    await expect(
      getArxivService().readContent('2401.12345', {}, createMockContext()),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
  }, 30_000);

  it('reports a 429 from the PDF host as rate_limited, not as an absent PDF', async () => {
    // A throttled PDF request says nothing about whether the paper has a PDF.
    // Collapsing it into content_unavailable would tell the caller no full-text
    // artifact exists and to stop trying — permanent advice for a transient state.
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 307 }))
      .mockResolvedValueOnce(
        new Response('Rate exceeded.', { status: 429, headers: { 'retry-after': '12' } }),
      );

    await expect(
      getArxivService().readContent('2401.12345', {}, createMockContext()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: {
        reason: 'rate_limited',
        retryAfter: '12',
        cooldownAppliedMs: 12_000,
        consecutiveRateLimits: 1,
        url: 'http://arxiv.org/pdf/2401.12345v1',
      },
    });
    // Fail fast: isArxivTransient excludes RateLimited, so the chain is not replayed.
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  // -------------------------------------------------------------------------
  // ar5iv outages fall through to the PDF (issue #38)
  // -------------------------------------------------------------------------

  it('falls through an ar5iv 502 to the PDF rather than ending the chain', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }))
      .mockResolvedValueOnce(pdfResponse('Rydberg electrometer'));

    const result = await getArxivService().readContent('2401.12345', {}, createMockContext());

    expect(result.source).toBe('pdf_text');
    expect(result.content).toContain('Rydberg electrometer');
    expect(String(mockFetch.mock.calls[3]?.[0])).toBe('http://arxiv.org/pdf/2401.12345v1');
  });

  it('falls through an ar5iv network error to the PDF', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockRejectedValueOnce(Object.assign(new Error('ECONNREFUSED'), { name: 'Error' }))
      .mockResolvedValueOnce(pdfResponse('served from the PDF'));

    const result = await getArxivService().readContent('2401.12345', {}, createMockContext());

    expect(result.source).toBe('pdf_text');
    expect(result.content).toContain('served from the PDF');
  });

  it('reports the ar5iv outage, not pdf_extraction_failed, when the PDF has no text layer', async () => {
    // ar5iv never answered whether a render exists, so the permanent "no text
    // layer — go OCR it" verdict would foreclose a retry that could still
    // return the HTML render.
    const attempt = (): Response[] => [
      new Response('Not Found', { status: 404 }),
      new Response('Bad Gateway', { status: 502 }),
      pdfResponse(''),
    ];
    mockFetch.mockResolvedValueOnce(atomResponse(ATOM_SINGLE));
    for (const response of [...attempt(), ...attempt()]) mockFetch.mockResolvedValueOnce(response);

    await expect(
      getArxivService().readContent('2401.12345', {}, createMockContext()),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ServiceUnavailable });
  }, 30_000);

  // -------------------------------------------------------------------------
  // ar5iv conversion-failure pages fall through to the PDF (issue #54)
  // -------------------------------------------------------------------------

  /** Queue metadata, an arxiv.org/html 404, and `ar5ivPage` as ar5iv's 200 answer. */
  function serveAr5ivPage(ar5ivPage: string): void {
    mockFetch
      .mockResolvedValueOnce(atomResponse(atomFor('hep-th/9711200v3')))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(
        servedPage(ar5ivPage, 'https://ar5iv.labs.arxiv.org/html/hep-th/9711200v3'),
      );
  }

  const FATAL_NOTICE =
    '<span class="ltx_ERROR">\nConversion to HTML had a Fatal error and exited abruptly. This document may be truncated or damaged.\n</span>';

  it('serves an ar5iv page whose prose mentions a fatal error', async () => {
    serveAr5ivPage(
      '<article class="ltx_document"><p class="ltx_p">LaTeXML prints "Conversion to HTML had a Fatal error and exited abruptly" when the solver hits a Fatal error.</p></article>',
    );

    const result = await getArxivService().readContent('hep-th/9711200v3', {}, createMockContext());

    expect(result.source).toBe('ar5iv');
    expect(result.content).toContain('when the solver hits a Fatal error');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('serves a partial ar5iv render that carries the fatal-error notice beside paper text', async () => {
    serveAr5ivPage(
      `<article class="ltx_document"><div class="ltx_para">${FATAL_NOTICE}</div><section class="ltx_section"><p class="ltx_p">Partial body text.</p></section></article>`,
    );

    const result = await getArxivService().readContent('hep-th/9711200v3', {}, createMockContext());

    expect(result.source).toBe('ar5iv');
    expect(result.content).toContain('Partial body text.');
  });

  it('falls through the captured ar5iv conversion-failure page to the PDF', async () => {
    serveAr5ivPage(fixturePage('ar5iv-hep-th_9711200v3'));
    mockFetch.mockResolvedValueOnce(pdfResponse('Supergravity and the large N limit'));

    const result = await getArxivService().readContent('hep-th/9711200v3', {}, createMockContext());

    expect(result.source).toBe('pdf_text');
    expect(result.content).toContain('Supergravity and the large N limit');
    expect(result.content).not.toContain('Fatal error');
    expect(String(mockFetch.mock.calls[3]?.[0])).toBe('https://arxiv.org/pdf/hep-th/9711200v3');
  });

  it('falls through a failure page whose notice sits inside an otherwise empty article', async () => {
    serveAr5ivPage(
      `<article class="ltx_document">\n<div class="ltx_para">${FATAL_NOTICE}</div>\n</article>`,
    );
    mockFetch.mockResolvedValueOnce(pdfResponse('pdf body'));

    const result = await getArxivService().readContent('hep-th/9711200v3', {}, createMockContext());

    expect(result.source).toBe('pdf_text');
  });

  it('reports content_unavailable when ar5iv serves only a failure page and there is no PDF', async () => {
    serveAr5ivPage(fixturePage('ar5iv-hep-th_9711200v3'));
    mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

    await expect(
      getArxivService().readContent('hep-th/9711200v3', {}, createMockContext()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'content_unavailable' },
    });
  });

  it('reports pdf_extraction_failed when ar5iv serves only a failure page and the PDF has no text', async () => {
    serveAr5ivPage(fixturePage('ar5iv-hep-th_9711200v3'));
    mockFetch.mockResolvedValueOnce(pdfResponse(''));

    await expect(
      getArxivService().readContent('hep-th/9711200v3', {}, createMockContext()),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'pdf_extraction_failed' },
    });
  });

  // -------------------------------------------------------------------------
  // Unbounded reads (issue #24)
  // -------------------------------------------------------------------------

  it('returns the entire body when maxCharacters is null', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse(`<article>${'q'.repeat(250_000)}</article>`));

    const result = await getArxivService().readContent(
      '2401.12345',
      { maxCharacters: null },
      createMockContext(),
    );

    expect(result.content).toHaveLength(result.body_characters);
    expect(result.body_characters).toBeGreaterThan(250_000);
    expect(result.truncated).toBe(false);
  });

  it('honors start alongside a null maxCharacters — reads to the end of the body', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse('abcdefghij'.repeat(10)));

    const result = await getArxivService().readContent(
      '2401.12345',
      { maxCharacters: null, start: 40 },
      createMockContext(),
    );

    expect(result.start).toBe(40);
    expect(result.content).toHaveLength(result.body_characters - 40);
    expect(result.truncated).toBe(false);
  });

  it('collapses inline MathML to TeX annotation, reclaiming character budget (issue #4)', async () => {
    // arXiv renders inline `70%` as ~250 chars of presentation MathML. The same
    // content is present in the <annotation encoding="application/x-tex"> child
    // as 4 chars. Collapsing typically shrinks math-heavy papers by an order of
    // magnitude with zero content loss.
    const mathTag =
      '<math alttext="70\\%" display="inline">' +
      '<semantics><mrow><mn>70</mn><mo>%</mo></mrow>' +
      '<annotation encoding="application/x-tex">70\\%</annotation>' +
      '</semantics></math>';
    const raw = `<article><p>Fracture point at ${mathTag} utilization.</p></article>`;
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse(raw));
    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.readContent('2401.12345', {}, ctx);

    expect(result.content).not.toContain('<math');
    expect(result.content).not.toContain('annotation');
    expect(result.content).not.toContain('semantics');
    expect(result.content).toContain('$70\\%$');
    expect(result.content).toContain('Fracture point at');
    expect(result.content).toContain('utilization');
  });

  it('marks display-block MathML with $$…$$ and inline with $…$ (issue #4)', async () => {
    // Block-level math (display="block") wraps in $$…$$; inline math wraps in
    // single $. The distinction is preserved so downstream consumers can render
    // each appropriately.
    const blockMath =
      '<math display="block"><semantics><mrow><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></mrow>' +
      '<annotation encoding="application/x-tex">E=mc^2</annotation>' +
      '</semantics></math>';
    const inlineMath =
      '<math display="inline"><semantics><mi>x</mi>' +
      '<annotation encoding="application/x-tex">x</annotation>' +
      '</semantics></math>';
    const raw = `<article><p>${blockMath} and inline ${inlineMath}.</p></article>`;
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse(raw));

    const result = await getArxivService().readContent('2401.12345', {}, createMockContext());
    expect(result.content).toContain('$$E=mc^2$$');
    expect(result.content).toContain('$x$');
  });

  it('falls back to alttext when no annotation child is present (issue #4)', async () => {
    // Some arXiv pages render MathML without an x-tex annotation child but
    // still carry the LaTeX source in the alttext attribute. Drop math
    // elements that have neither.
    const withAlt = '<math alttext="\\alpha" display="inline"><mi>α</mi></math>';
    const noSource = '<math display="inline"><mi>β</mi></math>';
    const raw = `<article><p>${withAlt} vs ${noSource}.</p></article>`;
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse(raw));

    const result = await getArxivService().readContent('2401.12345', {}, createMockContext());
    expect(result.content).toContain('$\\alpha$');
    // The annotation-less element is dropped entirely
    expect(result.content).not.toContain('β');
    expect(result.content).not.toContain('<math');
  });

  it('decodes HTML entities in the LaTeX source (issue #4)', async () => {
    // The <annotation> child may carry HTML-encoded characters (&lt;, &gt;,
    // &amp;) from the upstream LaTeXML transform. Decode them so downstream
    // consumers see literal TeX, not HTML-escaped TeX.
    const mathTag =
      '<math display="inline"><semantics><mi>a</mi>' +
      '<annotation encoding="application/x-tex">a &lt; b &amp;&amp; c &gt; d</annotation>' +
      '</semantics></math>';
    const raw = `<article><p>${mathTag}</p></article>`;
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse(raw));

    const result = await getArxivService().readContent('2401.12345', {}, createMockContext());
    expect(result.content).toContain('$a < b && c > d$');
  });

  it('shrinks math-heavy bodies by an order of magnitude (issue #4)', async () => {
    // Regression check on the practical benefit: a page where MathML dominates
    // the byte budget should compress dramatically after collapse, leaving
    // proportionally more characters for prose.
    const mathExpr =
      '<math alttext="x" display="inline">' +
      '<semantics><mrow><mi>x</mi></mrow>' +
      '<annotation encoding="application/x-tex">x</annotation>' +
      '</semantics></math>';
    // 200 inline math expressions, each ~250 chars raw → ~3 chars collapsed.
    const raw = `<article><p>${mathExpr.repeat(200)}</p></article>`;
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse(raw));

    const result = await getArxivService().readContent('2401.12345', {}, createMockContext());
    // Body should shrink at least 5x — in practice closer to 30x.
    expect(result.body_characters).toBeLessThan(result.total_characters / 5);
  });

  it('strips LaTeXML class/id noise and reports body_characters distinct from total', async () => {
    const raw =
      '<article><span class="ltx_text" id="S1.p1">Hello</span>' +
      '<br class="ltx_break"/><br class="ltx_break"/>' +
      '<p class="ltx_para" id="p2">World</p></article>';
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse(raw));
    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.readContent('2401.12345', {}, ctx);

    // Content should no longer contain ltx_* class or id attributes
    expect(result.content).not.toMatch(/class="ltx_/);
    expect(result.content).not.toMatch(/\sid="/);
    // Runs of <br> should collapse to a single <br>
    expect(result.content).not.toMatch(/<br[^>]*>\s*<br/i);
    // Content should still contain the actual text and tag skeleton
    expect(result.content).toContain('Hello');
    expect(result.content).toContain('World');
    expect(result.content).toContain('<span>');
    expect(result.content).toContain('<p>');
    // Both char counts are reported; body is strictly smaller after stripping
    expect(result.total_characters).toBe(raw.length);
    expect(result.body_characters).toBe(result.content.length);
    expect(result.body_characters).toBeLessThan(result.total_characters);
  });

  it('preserves structural ltx_* class attributes (section, title, bibliography) while stripping noise', async () => {
    // Section boundaries must survive cleaning so the outline and downstream
    // tooling can identify them. Decorative
    // classes like ltx_text and ltx_font_bold should still be stripped.
    const raw = [
      '<article>',
      '<section class="ltx_section">',
      '<h2 class="ltx_title ltx_title_section">1 Introduction</h2>',
      '<p class="ltx_para"><span class="ltx_text ltx_font_bold">Body</span></p>',
      '<section class="ltx_subsection"><h3 class="ltx_title ltx_title_subsection">1.1</h3></section>',
      '<section class="ltx_bibliography"><h2 class="ltx_title">References</h2></section>',
      '</section>',
      '</article>',
    ].join('');
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse(raw));
    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.readContent('2401.12345', {}, ctx);

    // Structural markers preserved
    expect(result.content).toContain('class="ltx_section"');
    expect(result.content).toContain('class="ltx_subsection"');
    expect(result.content).toContain('class="ltx_bibliography"');
    expect(result.content).toContain('ltx_title');
    // Decorative noise stripped
    expect(result.content).not.toContain('ltx_para');
    expect(result.content).not.toContain('ltx_text');
    expect(result.content).not.toContain('ltx_font_bold');
    // Text content survives
    expect(result.content).toContain('1 Introduction');
    expect(result.content).toContain('References');
  });

  it('truncates based on body_characters, not raw total', async () => {
    // Raw HTML with lots of ltx noise that strips down to a small body.
    const raw = `<article>${'<span class="ltx_text" id="x">a</span>'.repeat(20)}</article>`;
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse(raw));
    const ctx = createMockContext();
    const service = getArxivService();
    const result = await service.readContent('2401.12345', { maxCharacters: 50 }, ctx);

    expect(result.total_characters).toBe(raw.length);
    // Cleaned content is much smaller than raw; truncation applies to cleaned form
    expect(result.body_characters).toBeLessThan(raw.length);
    expect(result.content.length).toBeLessThanOrEqual(50);
    if (result.body_characters > 50) {
      expect(result.truncated).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // Article boundary and served-URL resolution (issue #43)
  // -------------------------------------------------------------------------

  it('keeps the whole tail of a page with no <article> (ltx_page_main fallback)', async () => {
    const raw =
      '<html><head><title>t</title></head><body><nav>chrome</nav>' +
      '<div class="ltx_page_main"><p>Body</p></div><footer>site footer</footer></body></html>';
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse(raw));

    const result = await getArxivService().readContent('2401.12345', {}, createMockContext());

    expect(result.content).toBe('<div><p>Body</p></div><footer>site footer</footer></body></html>');
    expect(result.total_characters).toBe(raw.length - raw.indexOf('<div class="ltx_page_main"'));
  });

  it('ends the body at </article>, dropping the arxiv.org site footer', async () => {
    const result = await readFixture('math/9201201v1', 'native-math_9201201v1', 'arxiv_html');

    expect(result.body_characters).toBe(9449);
    expect(result.content.endsWith('</article>')).toBe(true);
    expect(result.content).not.toContain('arxiv-html-footer');
    expect(result.content).not.toContain('ds-funder-logo');
    expect(result.total_characters).toBeLessThan(fixturePage('native-math_9201201v1').length);
  });

  it('ends the body at </article> on the ar5iv rung too', async () => {
    const result = await readFixture('math/9201201v1', 'ar5iv-math_9201201v1', 'ar5iv');

    expect(result.source).toBe('ar5iv');
    expect(result.body_characters).toBe(9449);
    expect(result.content.endsWith('</article>')).toBe(true);
    expect(result.content).not.toContain('ar5iv-footer');
    expect(result.content).not.toContain('<script');
  });

  it('pages the last chunk of article content, not footer chrome', async () => {
    const result = await readFixture('math/9201201v1', 'native-math_9201201v1', 'arxiv_html', {
      maxCharacters: 100_000,
      start: 9000,
    });

    expect(result.content.endsWith('</article>')).toBe(true);
    expect(result.content).not.toMatch(/<svg|<path/);
    expect(result.truncated).toBe(false);
  });

  it('resolves relative figure src and object data against the served page URL', async () => {
    const result = await readFixture('1706.03762v7', 'native-1706.03762v7', 'arxiv_html');

    const srcs = attrValues(result.content, 'src');
    const datas = attrValues(result.content, 'data');
    expect(srcs).toHaveLength(3);
    expect(datas).toHaveLength(5);
    expect(srcs).toContain('https://arxiv.org/html/1706.03762v7/Figures/ModalNet-21.png');
    expect(datas).toContain('https://arxiv.org/html/1706.03762v7/making_more_difficult5_new.svg');
    for (const value of [...srcs, ...datas]) {
      expect(value.startsWith('https://arxiv.org/html/1706.03762v7/')).toBe(true);
    }
  });

  it('leaves fragment, mailto, and absolute links as they are', async () => {
    const result = await readFixture('1706.03762v7', 'native-1706.03762v7', 'arxiv_html');

    const hrefs = attrValues(result.content, 'href');
    expect(hrefs).toContain('#bib.bib13');
    expect(hrefs.filter((h) => h.startsWith('#'))).toHaveLength(75);
    expect(hrefs.filter((h) => h.startsWith('mailto:'))).toHaveLength(8);
    expect(hrefs.filter((h) => h.startsWith('https://github.com/'))).toHaveLength(1);
    expect(hrefs.every((h) => /^(#|mailto:|https:\/\/)/.test(h))).toBe(true);
  });

  it('resolves ar5iv root-relative asset paths against the ar5iv host', async () => {
    const result = await readFixture('1706.03762v7', 'ar5iv-1706.03762v7', 'ar5iv');

    const srcs = attrValues(result.content, 'src');
    expect(srcs).toContain(
      'https://ar5iv.labs.arxiv.org/html/1706.03762/assets/Figures/ModalNet-21.png',
    );
    for (const value of [...srcs, ...attrValues(result.content, 'data')]) {
      expect(value.startsWith('https://ar5iv.labs.arxiv.org/html/1706.03762/assets/')).toBe(true);
    }
  });

  it('resolves a legacy-ID figure under its archive and keeps appendix and bibliography', async () => {
    const result = await readFixture(
      'astro-ph/0603449v2',
      'native-astro-ph_0603449v2-headings',
      'arxiv_html',
    );

    expect(attrValues(result.content, 'src')).toEqual([
      'https://arxiv.org/html/astro-ph/0603449v2/f1.png',
    ]);
    expect(result.content).toContain('ltx_title_appendix');
    expect(result.content).toContain('ltx_title_bibliography');
    expect(result.content.endsWith('</article>')).toBe(true);
  });

  it('resolves against the URL that served the page, not the URL requested', async () => {
    // A redirect to a trailing-slash URL moves the base one segment deeper.
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(
        servedPage(
          '<article><img src="x1.png"><a href="../up.html">u</a></article>',
          'https://arxiv.org/html/2401.12345v1/',
        ),
      );

    const result = await getArxivService().readContent('2401.12345', {}, createMockContext());

    expect(result.content).toBe(
      '<article><img src="https://arxiv.org/html/2401.12345v1/x1.png">' +
        '<a href="https://arxiv.org/html/up.html">u</a></article>',
    );
  });

  it('resolves against the requested URL when the response carries none', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(htmlResponse('<article><img src="2401.12345v1/x1.png"></article>'));

    const result = await getArxivService().readContent('2401.12345', {}, createMockContext());

    expect(result.content).toBe(
      '<article><img src="https://arxiv.org/html/2401.12345v1/x1.png"></article>',
    );
  });

  // -------------------------------------------------------------------------
  // Section outline (issue #44)
  // -------------------------------------------------------------------------

  it('outlines sectioning headings by tag depth, with offsets into the cleaned body', async () => {
    const result = await readFixture('1706.03762v7', 'native-1706.03762v7', 'arxiv_html');
    const outline = result.outline ?? [];

    expect(outline).toHaveLength(29);
    expect(outline[0]).toMatchObject({ level: 1, title: '1 Introduction' });
    expect(outline).toContainEqual(
      expect.objectContaining({ level: 2, title: '3.1 Encoder and Decoder Stacks' }),
    );
    expect(outline).toContainEqual(expect.objectContaining({ level: 4, title: 'Encoder:' }));
    expect(outline).toContainEqual(expect.objectContaining({ level: 1, title: 'References' }));
    const counts: Record<number, number> = {};
    for (const entry of outline) counts[entry.level] = (counts[entry.level] ?? 0) + 1;
    expect(counts).toEqual({ 1: 9, 2: 12, 3: 3, 4: 5 });
    for (const entry of outline) {
      expect(result.content.startsWith(`<h${entry.level + 1}`, entry.start), entry.title).toBe(
        true,
      );
    }
    expect(result.outline_omitted_levels).toBeUndefined();
  });

  it('outlines the ar5iv render of a paper with the same titles and levels', async () => {
    const native = await readFixture('1706.03762v7', 'native-1706.03762v7', 'arxiv_html');
    const ar5iv = await readFixture('1706.03762v7', 'ar5iv-1706.03762v7', 'ar5iv');

    const shape = (o: typeof native.outline) => o?.map(({ level, title }) => ({ level, title }));
    expect(shape(ar5iv.outline)).toEqual(shape(native.outline));
  });

  it('reads from a heading when an outline entry start is passed back', async () => {
    const first = await readFixture('1706.03762v7', 'native-1706.03762v7', 'arxiv_html', {
      maxCharacters: 100_000,
    });
    const entry = first.outline?.find((e) => e.title === '3.2 Attention');
    expect(entry).toBeDefined();

    const jump = await readFixture('1706.03762v7', 'native-1706.03762v7', 'arxiv_html', {
      maxCharacters: 2_000,
      start: entry?.start ?? -1,
    });
    expect(jump.content).toMatch(/^<h3 class="ltx_title ltx_title_subsection">.{0,40}3\.2 /);
    expect(jump.outline).toBeUndefined();
    expect(jump.outline_omitted_levels).toBeUndefined();
  });

  it('levels headings by tag, so subsections rendered as <h2> are level 1', async () => {
    const result = await readFixture('math/9201201v1', 'native-math_9201201v1', 'arxiv_html');

    expect(result.outline).toEqual([
      { level: 1, title: '1', start: expect.any(Number) },
      { level: 1, title: '2', start: expect.any(Number) },
      { level: 1, title: 'References', start: expect.any(Number) },
    ]);
  });

  it('leaves theorem, proof, abstract, and contents titles out of the outline', async () => {
    const result = await readFixture('2405.03599v3', 'native-2405.03599v3-headings', 'arxiv_html');
    const outline = result.outline ?? [];
    const classOf = (entry: (typeof outline)[number]) =>
      /^<h[1-6] class="([^"]*)">/.exec(result.content.slice(entry.start))?.[1] ?? '';

    expect(result.content).toContain('ltx_title_theorem');
    expect(result.content).toContain('ltx_title_proof');
    expect(outline).toHaveLength(183);
    for (const entry of outline) {
      expect(classOf(entry)).toMatch(/ltx_title_(section|subsection|subsubsection|bibliography)\b/);
    }
  });

  it('cuts a single-level outline over 200 entries and says where it continues', async () => {
    const sections = Array.from(
      { length: 201 },
      (_, i) =>
        `<section class="ltx_section"><h2 class="ltx_title ltx_title_section">${i + 1} Part</h2><p>x</p></section>`,
    ).join('');
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(
        htmlResponse(`<html><body><article>${sections}</article></body></html>`),
      );

    const result = await getArxivService().readContent(
      '2401.12345',
      { maxCharacters: null },
      createMockContext(),
    );

    expect(result.outline).toHaveLength(200);
    expect(result.outline?.at(-1)?.title).toBe('200 Part');
    expect(result).not.toHaveProperty('outline_omitted_levels');
    const next = result.outline_continues_at ?? -1;
    expect(result.content.slice(next)).toMatch(/^<h2 class="ltx_title ltx_title_section">201 Part/);
  });

  it('omits the outline on any page past the first', async () => {
    const result = await readFixture('math/9201201v1', 'native-math_9201201v1', 'arxiv_html', {
      maxCharacters: 100,
      start: 1,
    });

    expect(result).not.toHaveProperty('outline');
    expect(result).not.toHaveProperty('outline_omitted_levels');
    expect(result).not.toHaveProperty('outline_continues_at');
  });

  it('returns an empty outline for PDF text on the first page', async () => {
    mockFetch
      .mockResolvedValueOnce(atomResponse(ATOM_SINGLE))
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 307 }))
      .mockResolvedValueOnce(pdfResponse('1 Introduction'));

    const result = await getArxivService().readContent('2401.12345', {}, createMockContext());

    expect(result.source).toBe('pdf_text');
    expect(result.outline).toEqual([]);
    expect(result).not.toHaveProperty('outline_omitted_levels');
  });

  it('throws on unexpected content-type from API', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('Internal error', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const ctx = createMockContext();
    const service = getArxivService();

    await expect(service.readContent('2401.12345', {}, ctx)).rejects.toThrow(/content-type/i);
  });
});

// ---------------------------------------------------------------------------
// Cleaning passes stay linear in page length (issue #52)
// ---------------------------------------------------------------------------

/**
 * Per-call thread CPU of `fn`, in ms: the fastest of three samples, each
 * repeating `fn` until it has used ~20 ms of CPU.
 */
function cpuMs(fn: () => unknown): number {
  let best = Number.POSITIVE_INFINITY;
  for (let sample = 0; sample < 3; sample++) {
    const start = process.threadCpuUsage();
    let calls = 0;
    let usedMs = 0;
    do {
      fn();
      calls++;
      const used = process.threadCpuUsage(start);
      usedMs = (used.user + used.system) / 1000;
    } while (usedMs < 20);
    best = Math.min(best, usedMs / calls);
  }
  return best;
}

/**
 * Assert `run` stays linear on `unit` repeated to a length that doubles from 5k
 * to 320k characters. Each size must meet an absolute CPU bound before the next
 * runs, so a superlinear cost fails at the first doubling it outgrows; the full
 * 64× span must cost under 256× (a quadratic costs ~4,096×).
 */
function expectLinear(unit: string, run: (input: string) => unknown): void {
  const times: number[] = [];
  for (let size = 5_000; size <= 320_000; size *= 2) {
    const input = unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
    const ms = cpuMs(() => run(input));
    expect(ms, `${size} characters took ${ms.toFixed(2)} ms`).toBeLessThan(2 + size / 2_000);
    times.push(ms);
  }
  expect((times.at(-1) ?? 0) / (times[0] ?? 1)).toBeLessThan(256);
}

// Cost bounds are thread CPU; the wall-clock timeout only has to outlast a loaded machine.
describe('HTML cleaning passes', { timeout: 30_000 }, () => {
  it('collapses MathML on the captured pages exactly as the regex pass did', () => {
    // SHA-256 of each page's collapseMathML output from the original
    // `/<math\b([^>]*)>([\s\S]*?)<\/math>/g` implementation.
    const expected: Record<string, string> = {
      'ar5iv-1706.03762v7': 'd530895e13a1b41f7a731c15931389f45d9044c74bdc5705306567e293e631f7',
      'ar5iv-math_9201201v1': '1c16c81e0d7f9fa45542187c58bf52e5637b2f4462562c3f360dc128bed7c29f',
      'native-1706.03762v7': 'd791ea56609b14505ebbd8eb7f30e70e9e0e6e4535d59301251b264f6ac906aa',
      'native-2405.03599v3-headings':
        '3ee942b605da0e1e6ea7a9643e381dd7c9d7dda4e7f3e6d154d0e949f6cc52c7',
      'native-astro-ph_0603449v2-headings':
        'e60d831b28684156377261906b05f019dad906bdd12fbe066feb29629083cbed',
      'native-math_9201201v1': '9b4c24faccf9c50b1688507d0ed215b95c74cfa0877692b1e33845362f430c29',
    };
    for (const [name, hash] of Object.entries(expected)) {
      const collapsed = collapseMathML(fixturePage(name));
      expect(createHash('sha256').update(collapsed).digest('hex'), name).toBe(hash);
    }
  });

  it('leaves an unclosed <math> element in place and still collapses the closed ones before it', () => {
    const closed =
      '<math display="inline"><annotation encoding="application/x-tex">x</annotation></math>';
    expect(collapseMathML(`a ${closed} b <math>y c`)).toBe('a $x$ b <math>y c');
    expect(collapseMathML(`<mathvariant>${closed}`)).toBe('<mathvariant>$x$');
    expect(collapseMathML('<math alttext="z"')).toBe('<math alttext="z"');
  });

  it('takes the first x-tex annotation and skips other annotation encodings', () => {
    const tex = (body: string) => collapseMathML(`<math>${body}</math>`);
    expect(
      tex(
        '<annotation-xml encoding="MathML-Content"><ci>a</ci></annotation-xml>' +
          '<annotation encoding="application/x-tex">a</annotation>',
      ),
    ).toBe('$a$');
    expect(tex('<annotation encoding="application/x-tex">unclosed')).toBe('');
    expect(tex('<annotation encoding="text/plain">p</annotation>')).toBe('');
  });

  it('keeps the <math> element match linear in page length', () => {
    expectLinear('<math>x ', collapseMathML);
  });

  it('keeps the <math> tag read linear in page length', () => {
    expectLinear('<math x ', collapseMathML);
  });

  it('keeps the TeX annotation read linear in page length', () => {
    expectLinear('<annotation encoding="application/x-tex">x ', (s) =>
      collapseMathML(`<math>${s}</math>`),
    );
    expectLinear('<annotation x ', (s) => collapseMathML(`<math>${s}</math>`));
  });

  it('keeps the <article> boundary search linear in page length', () => {
    expectLinear('<article ', stripHtmlHead);
  });

  it('keeps the outline heading scan linear in page length', () => {
    const opener = '<h2 class="ltx_title ltx_title_section">';
    expectLinear(opener, buildOutline);
    expectLinear(`${opener}x `, (s) => buildOutline(`${s}</h2>`));
    expectLinear('<h2 class="ltx_title ltx_title_section ', buildOutline);
  });

  it('keeps relative-URL resolution linear in page length', () => {
    const base = 'https://arxiv.org/html/2401.12345v1';
    expectLinear('<a', (s) => resolveRelativeUrls(s, base));
    expectLinear('<img alt="x" ', (s) => resolveRelativeUrls(s, base));
    expectLinear(' src="x', (s) => resolveRelativeUrls(`<img${s}>`, base));
  });

  it('strips LaTeXML noise on the captured pages exactly as before', () => {
    // SHA-256 of each whole page's stripLatexmlNoise output, recorded before the
    // issue #52 change to the class/id passes.
    const expected: Record<string, string> = {
      'ar5iv-1706.03762v7': 'bc306220be20926dba00028a4f4aa542adda8dbc2a310e740bd8aeeca6c76566',
      'ar5iv-hep-th_9711200v3': '7ba9559b5c5357b95b23bdfeaaba77b407e6b0b28d59aaf3245e14c3bf15d16d',
      'ar5iv-math_9201201v1': 'ff0f05da6bb7c00f067fac54fab7796e256bf0b16e661079522c26f4f3e6047e',
      'native-1706.03762v7': 'd27d29a5d3823418af9ff492eb1a93df44d933cdb3b834503e446ed90605f9fe',
      'native-2405.03599v3-headings':
        '4bd26d44c28c99c143343723443d14e1500a64396eff4c37b24e723a23e820e0',
      'native-astro-ph_0603449v2-headings':
        '5e5ddd3d87cd993a361cd792dfcddeaffbd0793fae287c81c37a22ba504d4172',
      'native-math_9201201v1': 'c12f00dfcc75d3d1de2763395f22e45ff5c08160768ff1218ac7d6f76f5cb57e',
    };
    for (const [name, hash] of Object.entries(expected)) {
      const stripped = stripLatexmlNoise(fixturePage(name));
      expect(createHash('sha256').update(stripped).digest('hex'), name).toBe(hash);
    }
  });

  it('strips a noise attribute together with the whole whitespace run before it', () => {
    expect(stripLatexmlNoise('<p \n  class="ltx_p"  id="p1">x</p>')).toBe('<p>x</p>');
    expect(stripLatexmlNoise('<h2   class="ltx_title ltx_title_section"\tid="S1">')).toBe(
      '<h2   class="ltx_title ltx_title_section">',
    );
    expect(stripLatexmlNoise('<span class="other">  class="ltx_x"')).toBe('<span class="other">');
  });

  it('keeps the class and id strip linear in page length', () => {
    expectLinear(' ', stripLatexmlNoise);
    expectLinear('\n', stripLatexmlNoise);
    expectLinear(' x', stripLatexmlNoise);
  });

  it('keeps the noise-attribute value read linear in page length', () => {
    expectLinear(' class="ltx_x ', stripLatexmlNoise);
    expectLinear(' id="x ', stripLatexmlNoise);
  });

  it('keeps the <br> collapse linear in page length', () => {
    expectLinear('<br ', stripLatexmlNoise);
    expectLinear('<br>x', stripLatexmlNoise);
    expectLinear('<br>\n<br', stripLatexmlNoise);
  });

  it('keeps the ltx_page_main fallback search linear in page length', () => {
    expectLinear(' ', (s) => stripHtmlHead(`<div${s}`));
    expectLinear('<div ', stripHtmlHead);
  });

  it('keeps the alttext read linear in page length', () => {
    expectLinear('alttext=x ', (s) => collapseMathML(`<math ${s}></math>`));
    expectLinear('alttext="x ', (s) => collapseMathML(`<math ${s}></math>`));
  });
});

describe('isConversionFailurePage', { timeout: 30_000 }, () => {
  const NOTICE =
    'Conversion to HTML had a Fatal error and exited abruptly. This document may be truncated or damaged.';

  it('recognizes the captured ar5iv conversion-failure page', () => {
    expect(isConversionFailurePage(fixturePage('ar5iv-hep-th_9711200v3'))).toBe(true);
  });

  it('passes every captured render, including one with undefined-macro error spans', () => {
    for (const name of [
      'ar5iv-1706.03762v7',
      'ar5iv-math_9201201v1',
      'native-1706.03762v7',
      'native-2405.03599v3-headings',
      'native-astro-ph_0603449v2-headings',
      'native-math_9201201v1',
    ]) {
      expect(isConversionFailurePage(fixturePage(name)), name).toBe(false);
    }
  });

  it('recognizes the notice inside an article with no other text', () => {
    expect(
      isConversionFailurePage(
        `<article>\n<div class="ltx_para"><span class="ltx_ERROR">\n${NOTICE}\n</span></div>\n</article>`,
      ),
    ).toBe(true);
  });

  it('passes a page with paper text beside the notice, or the notice outside its error span', () => {
    expect(
      isConversionFailurePage(
        `<article><span class="ltx_ERROR">${NOTICE}</span><p>Partial body.</p></article>`,
      ),
    ).toBe(false);
    expect(isConversionFailurePage(`<article><p>${NOTICE}</p></article>`)).toBe(false);
    expect(isConversionFailurePage('<article></article>')).toBe(false);
  });

  it('keeps the failure-page check linear in page length', () => {
    const page = (s: string) => isConversionFailurePage(`<article>${NOTICE}${s}</article>`);
    expectLinear('<span class="ltx_ERROR ', page);
    expectLinear('<span class="ltx_ERROR">x ', page);
    expectLinear(`<span class="ltx_ERROR">${NOTICE} `, page);
    expectLinear('<a', page);
    expectLinear(`${NOTICE} `, page);
  });

  it('keeps the error-span read linear in page length', () => {
    expectLinear(`${NOTICE} `, (s) =>
      isConversionFailurePage(`<article><span class="ltx_ERROR">${s}</article>`),
    );
  });
});

describe('buildOutline', () => {
  const KIND_BY_TAG: Record<number, string> = {
    2: 'section',
    3: 'subsection',
    4: 'subsubsection',
    5: 'paragraph',
  };
  /** A cleaned LaTeXML heading as `stripLatexmlNoise` leaves it. */
  const heading = (tag: number, title: string) =>
    `<h${tag} class="ltx_title ltx_title_${KIND_BY_TAG[tag]}">${title}</h${tag}>`;

  it('returns no entries for a body without sectioning headings', () => {
    expect(buildOutline('')).toEqual({ entries: [], omittedLevels: [] });
    expect(
      buildOutline('<p>text</p><h6 class="ltx_title ltx_title_theorem">Theorem 1</h6>'),
    ).toEqual({ entries: [], omittedLevels: [] });
  });

  it('keeps every entry at exactly the 200-entry cap', () => {
    const body = Array.from({ length: 200 }, (_, i) => heading(i % 2 ? 3 : 2, `H${i}`)).join('');

    const { entries, omittedLevels } = buildOutline(body);
    expect(entries).toHaveLength(200);
    expect(omittedLevels).toEqual([]);
  });

  it('drops the deepest level whole when the outline passes 200 entries', () => {
    const sections = Array.from({ length: 10 }, (_, s) =>
      [
        heading(2, `${s + 1} Section`),
        ...Array.from({ length: 25 }, (_, ss) => heading(3, `${s + 1}.${ss + 1} Sub`)),
      ].join('<p>body</p>'),
    );
    const body = sections.join('');

    const { entries, omittedLevels } = buildOutline(body);
    expect(entries).toHaveLength(10);
    expect(entries.every((e) => e.level === 1)).toBe(true);
    expect(entries.map((e) => e.title)).toEqual(
      Array.from({ length: 10 }, (_, s) => `${s + 1} Section`),
    );
    expect(omittedLevels).toEqual([2]);
    for (const entry of entries) expect(body.startsWith('<h2', entry.start)).toBe(true);
  });

  it('keeps dropping levels, deepest first, until the rest fit', () => {
    // 5 sections, each with 20 subsections of 1 subsubsection and 1 paragraph:
    // 5 + 100 + 100 + 100 = 305 → drop level 4 (205) → drop level 3 (105).
    const body = Array.from({ length: 5 }, (_, s) =>
      [
        heading(2, `S${s}`),
        ...Array.from({ length: 20 }, (_, ss) =>
          [heading(3, `S${s}.${ss}`), heading(4, `S${s}.${ss}.a`), heading(5, `P${s}.${ss}`)].join(
            '',
          ),
        ),
      ].join(''),
    ).join('');

    const { entries, omittedLevels } = buildOutline(body);
    expect(omittedLevels).toEqual([4, 3]);
    expect(entries).toHaveLength(105);
    expect(entries.slice(0, 3).map((e) => e.title)).toEqual(['S0', 'S0.0', 'S0.1']);
    expect(new Set(entries.map((e) => e.level))).toEqual(new Set([1, 2]));
  });

  // A level alone over the cap has nothing deeper to drop: dropping it too
  // emptied the outline. The shallowest level is cut at 200 instead, and
  // continuesAt names the heading the caller reads on from.
  it('keeps the first 200 entries when one level alone passes the cap', () => {
    const body = Array.from({ length: 201 }, (_, i) => heading(2, `${i + 1} S`)).join('<p>x</p>');

    const { entries, omittedLevels, continuesAt } = buildOutline(body);
    expect(entries).toHaveLength(200);
    expect(entries.at(-1)?.title).toBe('200 S');
    expect(omittedLevels).toEqual([]);
    const cut = body.lastIndexOf('<h2');
    expect(continuesAt).toBe(cut);
    expect(body.slice(cut)).toContain('201 S');
  });

  it('drops deeper levels whole, then cuts the shallowest at 200', () => {
    const body = Array.from({ length: 250 }, (_, i) =>
      [heading(2, `${i + 1} S`), heading(3, `${i + 1}.1 Sub`)].join(''),
    ).join('');

    const { entries, omittedLevels, continuesAt } = buildOutline(body);
    expect(omittedLevels).toEqual([2]);
    expect(entries).toHaveLength(200);
    expect(entries.every((e) => e.level === 1)).toBe(true);
    expect(continuesAt).toBe(body.indexOf(heading(2, '201 S')));
  });

  it('names no continuation when the outline fits', () => {
    const body = Array.from({ length: 200 }, (_, i) => heading(2, `${i + 1} S`)).join('');
    expect(buildOutline(body)).not.toHaveProperty('continuesAt');
  });

  it('builds titles from markup: tags stripped, references decoded, whitespace collapsed', () => {
    const body =
      '<h2 class="ltx_title ltx_title_section"><span>4 </span>Results &amp; \n  Discussion</h2>' +
      '<h3 class="ltx_title ltx_title_subsection">Bounds on &#955; and &#x3bb; for $a&lt;b$&nbsp;&hellip;</h3>';

    expect(buildOutline(body).entries.map((e) => e.title)).toEqual([
      '4 Results & Discussion',
      'Bounds on λ and λ for $a<b$ &hellip;',
    ]);
  });

  it('cuts long titles at 120 characters', () => {
    const { entries } = buildOutline(heading(2, 'word '.repeat(60)));

    expect(entries[0]?.title).toHaveLength(120);
    expect(entries[0]?.title.endsWith('…')).toBe(true);
  });

  it('skips headings that never close or close with another tag', () => {
    const body =
      `<h2 class="ltx_title ltx_title_section">Unclosed<p>${'x'.repeat(5000)}</p>` +
      heading(2, 'Closed') +
      '<h3 class="ltx_title ltx_title_subsection">Mismatched</h4>' +
      '<h3 class="ltx_title ltx_title_subsection">Runs into the next<p>x</p>' +
      heading(3, 'Last');

    expect(buildOutline(body).entries.map((e) => e.title)).toEqual(['Closed', 'Last']);
  });

  it('keeps headings whose collapsed TeX holds < and >', () => {
    // collapseMathML decodes &lt; and &gt;, so a heading's TeX carries them raw.
    const body =
      heading(2, '<span>2 </span>The regime $0<h<1$') +
      heading(2, '<span>3 </span>Bounds with $a<b$ and $c>d$');

    expect(buildOutline(body).entries.map((e) => e.title)).toEqual([
      '2 The regime $0<h<1$',
      '3 Bounds with $a<b$ and $c>d$',
    ]);
  });
});
