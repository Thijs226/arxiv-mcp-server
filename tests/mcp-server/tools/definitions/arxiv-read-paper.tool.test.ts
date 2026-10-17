/**
 * @fileoverview Tests for arxiv_read_paper tool.
 * @module mcp-server/tools/definitions/arxiv-read-paper.test
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { arxivReadPaper } from '@/mcp-server/tools/definitions/arxiv-read-paper.tool.js';
import type { PaperContent } from '@/services/arxiv/types.js';

vi.mock('@/services/arxiv/arxiv-service.js', () => ({
  getArxivService: vi.fn(),
}));

import { getArxivService } from '@/services/arxiv/arxiv-service.js';

const MOCK_CONTENT: PaperContent = {
  paper_id: '2401.12345v1',
  title: 'Test Paper',
  content: '<html><body>Full paper content</body></html>',
  source: 'arxiv_html',
  truncated: false,
  start: 0,
  total_characters: 44,
  body_characters: 44,
  pdf_url: 'https://arxiv.org/pdf/2401.12345v1',
  abstract_url: 'https://arxiv.org/abs/2401.12345v1',
};

const mockReadContent = vi.fn<() => Promise<PaperContent>>();

beforeEach(() => {
  mockReadContent.mockReset();
  vi.mocked(getArxivService).mockReturnValue({ readContent: mockReadContent } as any);
});

describe('arxivReadPaper', () => {
  it('calls service.readContent and returns result', async () => {
    mockReadContent.mockResolvedValue(MOCK_CONTENT);
    const ctx = createMockContext({ errors: arxivReadPaper.errors! }) as Parameters<
      typeof arxivReadPaper.handler
    >[1];
    const input = arxivReadPaper.input.parse({ paper_id: '2401.12345', max_characters: 5000 });
    const result = await arxivReadPaper.handler(input, ctx);

    expect(mockReadContent).toHaveBeenCalledWith(
      '2401.12345',
      { maxCharacters: 5000, start: 0 },
      ctx,
    );
    expect(result.paper_id).toBe('2401.12345v1');
    expect(result.source).toBe('arxiv_html');
  });

  it('passes start offset through to the service', async () => {
    mockReadContent.mockResolvedValue({ ...MOCK_CONTENT, start: 100_000 });
    const ctx = createMockContext({ errors: arxivReadPaper.errors! }) as Parameters<
      typeof arxivReadPaper.handler
    >[1];
    const input = arxivReadPaper.input.parse({
      paper_id: '2401.12345',
      max_characters: 100_000,
      start: 100_000,
    });
    await arxivReadPaper.handler(input, ctx);

    expect(mockReadContent).toHaveBeenCalledWith(
      '2401.12345',
      { maxCharacters: 100_000, start: 100_000 },
      ctx,
    );
  });

  it('formats with truncation notice including slice range and next-start hint', () => {
    const truncated: PaperContent = {
      ...MOCK_CONTENT,
      content: 'x'.repeat(20_000),
      truncated: true,
      start: 0,
      total_characters: 150_000,
      body_characters: 50_000,
    };
    const blocks = arxivReadPaper.format?.(truncated) ?? [];
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('# Test Paper');
    expect(text).toContain('[Truncated:');
    expect(text).toContain('50,000 body characters');
    expect(text).toContain('chars 0–19,999');
    expect(text).toContain('start=20000');
  });

  it('formats with mid-paper slice notice when start > 0 and truncated', () => {
    const slice: PaperContent = {
      ...MOCK_CONTENT,
      content: 'y'.repeat(10_000),
      truncated: true,
      start: 100_000,
      body_characters: 250_000,
    };
    const blocks = arxivReadPaper.format?.(slice) ?? [];
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('chars 100,000–109,999');
    expect(text).toContain('start=110000');
  });

  it('formats final-chunk notice when start > 0 and not truncated', () => {
    const finalChunk: PaperContent = {
      ...MOCK_CONTENT,
      content: 'z'.repeat(50_000),
      truncated: false,
      start: 200_000,
      body_characters: 250_000,
    };
    const blocks = arxivReadPaper.format?.(finalChunk) ?? [];
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('final chunk');
    expect(text).toContain('chars 200,000–249,999');
    expect(text).not.toContain('Truncated:');
  });

  it('formats past-end notice when start exceeds body_characters', () => {
    const pastEnd: PaperContent = {
      ...MOCK_CONTENT,
      content: '',
      truncated: false,
      start: 999_999,
      body_characters: 50_000,
    };
    const blocks = arxivReadPaper.format?.(pastEnd) ?? [];
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('past end of body');
    expect(text).toContain('999,999');
    expect(text).toContain('start=0');
  });

  it('surfaces raw and cleaned body character counts distinctly in the header', () => {
    const mixed: PaperContent = {
      ...MOCK_CONTENT,
      total_characters: 150_000,
      body_characters: 40_000,
    };
    const blocks = arxivReadPaper.format?.(mixed) ?? [];
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Raw: 150000 chars');
    expect(text).toContain('Body: 40000 chars');
  });

  it('passes max_characters: null through as an unbounded read (#24)', async () => {
    mockReadContent.mockResolvedValue(MOCK_CONTENT);
    const ctx = createMockContext({ errors: arxivReadPaper.errors! }) as Parameters<
      typeof arxivReadPaper.handler
    >[1];
    const input = arxivReadPaper.input.parse({ paper_id: '2401.12345', max_characters: null });
    await arxivReadPaper.handler(input, ctx);

    expect(mockReadContent).toHaveBeenCalledWith(
      '2401.12345',
      { maxCharacters: null, start: 0 },
      ctx,
    );
  });

  it('defaults max_characters to 100,000 when omitted (#24)', async () => {
    mockReadContent.mockResolvedValue(MOCK_CONTENT);
    const ctx = createMockContext({ errors: arxivReadPaper.errors! }) as Parameters<
      typeof arxivReadPaper.handler
    >[1];
    const input = arxivReadPaper.input.parse({ paper_id: '2401.12345' });
    await arxivReadPaper.handler(input, ctx);

    expect(mockReadContent).toHaveBeenCalledWith(
      '2401.12345',
      { maxCharacters: 100_000, start: 0 },
      ctx,
    );
  });

  it('flags PDF-extracted content with its fidelity caveat in the text block (#23)', () => {
    const pdfText: PaperContent = {
      ...MOCK_CONTENT,
      content: 'Chip-Scale Rydberg Atomic Electrometer',
      source: 'pdf_text',
    };
    const blocks = arxivReadPaper.format?.(pdfText) ?? [];
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Source: pdf_text');
    expect(text).toContain('Extracted from the PDF');
    expect(text).toContain('flattened');
  });

  it('omits the PDF caveat for HTML sources (#23)', () => {
    const blocks = arxivReadPaper.format?.(MOCK_CONTENT) ?? [];
    const text = (blocks[0] as { text: string }).text;
    expect(text).not.toContain('Extracted from the PDF');
  });

  it('advertises pdf_text in the source output enum (#23)', () => {
    expect(arxivReadPaper.output.shape.source.options).toEqual(['arxiv_html', 'ar5iv', 'pdf_text']);
  });

  it('formats without truncation notice when not truncated and start=0', () => {
    const blocks = arxivReadPaper.format?.(MOCK_CONTENT) ?? [];
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('# Test Paper');
    expect(text).not.toContain('Truncated');
    expect(text).not.toContain('final chunk');
    expect(text).toContain('<html><body>Full paper content</body></html>');
  });

  // -------------------------------------------------------------------------
  // Section outline (#44)
  // -------------------------------------------------------------------------

  const OUTLINED: PaperContent = {
    ...MOCK_CONTENT,
    outline: [
      { level: 1, title: '1 Introduction', start: 5912 },
      { level: 2, title: '3.1 Encoder and Decoder Stacks', start: 12593 },
      { level: 4, title: 'Encoder:', start: 12701 },
      { level: 1, title: 'References', start: 50002 },
    ],
  };

  it('carries the outline through the output schema', () => {
    const parsed = arxivReadPaper.output.parse({ ...OUTLINED, outline_omitted_levels: [3] });

    expect(parsed.outline).toEqual(OUTLINED.outline);
    expect(parsed.outline_omitted_levels).toEqual([3]);
    expect(arxivReadPaper.output.parse(MOCK_CONTENT)).not.toHaveProperty('outline');
  });

  const formatText = (result: PaperContent) =>
    ((arxivReadPaper.format?.(result) ?? [])[0] as { text: string }).text;

  it('renders each outline entry with its level and start, indented by level', () => {
    const text = formatText(OUTLINED);

    expect(text).toContain("Outline (pass an entry's start to read from that heading):");
    expect(text).toContain('\n- 1 Introduction (level 1, start=5912)\n');
    expect(text).toContain('\n  - 3.1 Encoder and Decoder Stacks (level 2, start=12593)\n');
    expect(text).toContain('\n      - Encoder: (level 4, start=12701)\n');
    expect(text).toContain('\n- References (level 1, start=50002)\n');
    expect(text.indexOf('Outline')).toBeLessThan(text.indexOf(MOCK_CONTENT.content));
  });

  it('indents from the shallowest level present', () => {
    const text = formatText({
      ...MOCK_CONTENT,
      outline: [
        { level: 2, title: 'A', start: 1 },
        { level: 3, title: 'A.1', start: 2 },
      ],
    });

    expect(text).toContain('\n- A (level 2, start=1)\n  - A.1 (level 3, start=2)');
  });

  it('says which heading levels were left out of a capped outline', () => {
    const text = formatText({ ...OUTLINED, outline_omitted_levels: [4, 3] });

    expect(text).toContain(
      '[Outline capped at 200 entries: level 3 and level 4 headings omitted. Page through the body to reach them.]',
    );
  });

  // A single level over 200 entries is cut, not dropped; both surfaces name the
  // start that reads on past the cut.
  it('discloses a cut single-level outline through structuredContent and content[]', async () => {
    const outline = Array.from({ length: 200 }, (_, i) => ({
      level: 1,
      title: `${i + 1} Part`,
      start: 100 + i * 50,
    }));
    mockReadContent.mockResolvedValue({
      ...MOCK_CONTENT,
      outline,
      outline_continues_at: 10_100,
    });
    const result = await runToolContract(arxivReadPaper, { paper_id: '2401.12345' });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const structured = result.structuredContent as {
      outline: unknown[];
      outline_continues_at: number;
    };
    expect(structured.outline).toHaveLength(200);
    expect(structured.outline_continues_at).toBe(10_100);
    expect(structured).not.toHaveProperty('outline_omitted_levels');
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    expect(text).toContain(
      '[Outline cut at 200 entries: more level 1 headings follow. Read on with start=10100 to reach them.]',
    );
  });

  it('renders no cut line when the outline was not cut', () => {
    expect(formatText(OUTLINED)).not.toContain('Outline cut');
  });

  it('renders "Outline: none" for an empty outline', () => {
    const text = formatText({ ...MOCK_CONTENT, source: 'pdf_text', outline: [] });

    expect(text).toContain('\nOutline: none\n');
  });

  it('renders no outline lines when the outline was not returned', () => {
    expect(formatText({ ...MOCK_CONTENT, start: 100 })).not.toContain('Outline');
  });

  it('names the outline-then-start chain in the tool and start descriptions', () => {
    expect(arxivReadPaper.description).toContain('outline from the first page');
    expect(arxivReadPaper.input.shape.start.description).toContain("outline entry's start");
  });

  it('renders pdf_url so the LLM can reach the PDF without inspecting structuredContent', () => {
    const blocks = arxivReadPaper.format?.(MOCK_CONTENT) ?? [];
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('PDF: https://arxiv.org/pdf/2401.12345v1');
    expect(text).toContain('Abstract: https://arxiv.org/abs/2401.12345v1');
  });
});
