/**
 * @fileoverview Security tests for tool definitions.
 * Verifies injection attempts are rejected or safely passed through,
 * that no secrets or env values appear in outputs, and that oversized
 * inputs are bounded before reaching downstream services.
 * @module mcp-server/tools/definitions/security.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { arxivGetMetadata } from '@/mcp-server/tools/definitions/arxiv-get-metadata.tool.js';
import { arxivReadPaper } from '@/mcp-server/tools/definitions/arxiv-read-paper.tool.js';
import { arxivSearchPapers } from '@/mcp-server/tools/definitions/arxiv-search-papers.tool.js';
import type { PaperContent, PaperLookupResult, SearchResult } from '@/services/arxiv/types.js';

vi.mock('@/services/arxiv/arxiv-service.js', () => ({
  getArxivService: vi.fn(),
}));

import { getArxivService } from '@/services/arxiv/arxiv-service.js';

const MOCK_SEARCH_RESULT: SearchResult = {
  total_results: 0,
  start: 0,
  papers: [],
  effective_query: '',
};
const MOCK_CONTENT: PaperContent = {
  paper_id: '2401.12345v1',
  title: 'Test',
  content: 'body',
  source: 'arxiv_html',
  truncated: false,
  start: 0,
  total_characters: 4,
  body_characters: 4,
  pdf_url: 'https://arxiv.org/pdf/2401.12345v1',
  abstract_url: 'https://arxiv.org/abs/2401.12345v1',
};

const mockSearch = vi.fn<() => Promise<SearchResult>>();
const mockGetPapers = vi.fn<() => Promise<PaperLookupResult>>();
const mockReadContent = vi.fn<() => Promise<PaperContent>>();

beforeEach(() => {
  mockSearch.mockReset();
  mockGetPapers.mockReset();
  mockReadContent.mockReset();
  vi.mocked(getArxivService).mockReturnValue({
    search: mockSearch,
    getPapers: mockGetPapers,
    readContent: mockReadContent,
  } as any);
});

// ---------------------------------------------------------------------------
// Query injection via arxiv_search_papers
// ---------------------------------------------------------------------------

describe('arxivSearchPapers — injection and oversized inputs', () => {
  it('schema rejects query with null byte (C0 control char)', () => {
    expect(() => arxivSearchPapers.input.parse({ query: 'valid\x00query' })).toThrow();
  });

  it('schema rejects query with STX control char', () => {
    expect(() => arxivSearchPapers.input.parse({ query: '\x02bad' })).toThrow();
  });

  it('schema rejects query at 1001 chars (one over max)', () => {
    expect(() => arxivSearchPapers.input.parse({ query: 'q'.repeat(1001) })).toThrow();
  });

  it('schema accepts query at exactly 1000 chars (boundary)', () => {
    expect(() => arxivSearchPapers.input.parse({ query: 'q'.repeat(1000) })).not.toThrow();
  });

  it('query-injection payload reaches the service as a plain string — no shell interpretation', async () => {
    // The handler must forward the raw string to the service without further
    // transformation that could cause injection in the URL layer. The query is
    // passed verbatim and the service (mocked) receives it literally.
    mockSearch.mockResolvedValue(MOCK_SEARCH_RESULT);
    const ctx = createMockContext({ errors: arxivSearchPapers.errors! }) as Parameters<
      typeof arxivSearchPapers.handler
    >[1];
    const injection = 'au:alice"; DROP TABLE papers; --';
    const input = arxivSearchPapers.input.parse({ query: injection });
    await arxivSearchPapers.handler(input, ctx);

    // The service received the query exactly as provided — no mutation that
    // could silently drop or alter the injection string.
    expect(mockSearch).toHaveBeenCalledWith(injection, expect.anything(), ctx);
  });

  it('format output does not contain process env values', () => {
    // Set a recognizable env value and confirm it never appears in formatted output.
    const sentinel = 'SUPER_SECRET_SENTINEL_12345';
    vi.stubEnv('ARXIV_API_BASE_URL', sentinel);

    try {
      const result = arxivSearchPapers.format?.({ papers: [] }) ?? [];
      const text = (result[0] as { text: string }).text;
      expect(text).not.toContain(sentinel);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// ---------------------------------------------------------------------------
// Malformed inputs for arxiv_get_metadata (the 100-ID ceiling is pinned in
// input-validation.test.ts)
// ---------------------------------------------------------------------------

describe('arxivGetMetadata — injection and malformed inputs', () => {
  it('schema rejects empty string ID in the array', () => {
    expect(() => arxivGetMetadata.input.parse({ paper_ids: ['2401.12345', ''] })).toThrow();
  });

  it('IDs with path-traversal characters fail invalid_id and never reach the service', async () => {
    // Every ID runs through the arXiv ID parser before any lookup (#41), so a
    // path-traversal string is rejected locally instead of riding to arXiv.
    const ctx = createMockContext({ errors: arxivGetMetadata.errors! }) as Parameters<
      typeof arxivGetMetadata.handler
    >[1];
    const suspiciousId = '../../../etc/passwd';
    const input = arxivGetMetadata.input.parse({ paper_ids: [suspiciousId] });

    await expect(arxivGetMetadata.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_id', ids: [suspiciousId] },
    });
    expect(mockGetPapers).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// arxiv_read_paper — injection and output safety
// ---------------------------------------------------------------------------

describe('arxivReadPaper — output safety', () => {
  it('HTML content from service is returned verbatim without transformation that leaks env vars', async () => {
    const sentinel = 'MY_SECRET_TOKEN_99999';
    vi.stubEnv('ARXIV_CONTENT_TIMEOUT_MS', sentinel);

    try {
      // Even if content happened to contain the sentinel, the FORMAT function
      // must not independently inject env vars into its output framing.
      mockReadContent.mockResolvedValue({ ...MOCK_CONTENT, content: 'clean body content' });
      const ctx = createMockContext({ errors: arxivReadPaper.errors! }) as Parameters<
        typeof arxivReadPaper.handler
      >[1];
      const input = arxivReadPaper.input.parse({ paper_id: '2401.12345' });
      const result = await arxivReadPaper.handler(input, ctx);
      const blocks = arxivReadPaper.format?.(result) ?? [];
      const text = (blocks[0] as { text: string }).text;

      // The format output framing (title, source, char counts, links) must not
      // contain the sentinel env value.
      expect(text).not.toContain(sentinel);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('very large max_characters is accepted by schema (no upper bound enforced at schema level)', () => {
    // No upper cap is enforced by the schema — the service truncates on body_characters.
    // Verify that a large value doesn't throw during parse.
    expect(() =>
      arxivReadPaper.input.parse({ paper_id: '2401.12345', max_characters: 10_000_000 }),
    ).not.toThrow();
  });
});
