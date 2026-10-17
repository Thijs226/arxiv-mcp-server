/**
 * @fileoverview Tests for the MirrorStore — schema migration, batch upsert
 * idempotency, FTS5 round-trip via `search()`, category filter matching, and
 * harvest-state read/write.
 * @module services/arxiv/mirror/store.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { categorySubtree } from '@/services/arxiv/categories.js';
import { translateQuery } from '@/services/arxiv/mirror/query.js';
import { MirrorStore, rawToRow } from '@/services/arxiv/mirror/store.js';
import type { ArxivRawRecord } from '@/services/arxiv/mirror/types.js';

const mkRecord = (overrides: Partial<ArxivRawRecord> = {}): ArxivRawRecord => ({
  paper_id: '2401.00001',
  identifier: 'oai:arXiv.org:2401.00001',
  datestamp: '2024-01-22',
  title: 'Default title',
  authors: 'Default Author',
  abstract: 'Default abstract.',
  categories: 'cs.LG',
  versions: [{ version: 'v1', date: '2024-01-22T00:00:00Z' }],
  ...overrides,
});

describe('MirrorStore', () => {
  let dir: string;
  let dbPath: string;
  let store: MirrorStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arxiv-mirror-test-'));
    dbPath = join(dir, 'mirror.db');
    store = await MirrorStore.open(dbPath);
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('starts with an empty papers table and pending harvest state', () => {
    expect(store.countPapers()).toBe(0);
    expect(store.readHarvestState().status).toBe('pending');
  });

  it('upserts records and indexes them in FTS5', () => {
    const records = [
      mkRecord({
        paper_id: '2401.10001',
        title: 'Transformers for protein folding',
        abstract: 'A novel architecture for predicting protein structure.',
        categories: 'cs.LG q-bio.BM',
      }),
      mkRecord({
        paper_id: '2401.10002',
        title: 'A study of cosmic microwave background',
        abstract: 'Observations from a new telescope array.',
        categories: 'astro-ph.CO',
      }),
    ];
    store.applyBatch(records, []);
    expect(store.countPapers()).toBe(2);

    const result = store.search({
      matchExpr: '"protein"',
      categoryGroups: [],
      limit: 10,
      offset: 0,
      sortBy: 'relevance',
      sortOrder: 'descending',
    });
    expect(result.total).toBe(1);
    expect(result.papers[0]?.id).toBe('2401.10001');
  });

  it('treats repeat upserts as idempotent (same id replaces in place)', () => {
    const r = mkRecord({ paper_id: '2401.20001' });
    store.applyBatch([r], []);
    store.applyBatch([{ ...r, title: 'Revised title' }], []);
    expect(store.countPapers()).toBe(1);
    const [row] = store.getPapersByIds(['2401.20001']);
    expect(row?.title).toBe('Revised title');
  });

  it('removes tombstoned papers from the index', () => {
    store.applyBatch([mkRecord({ paper_id: '9912.30001' })], []);
    expect(store.countPapers()).toBe(1);
    store.applyBatch([], [{ paper_id: '9912.30001' }]);
    expect(store.countPapers()).toBe(0);
    expect(store.getPapersByIds(['9912.30001'])).toEqual([]);
  });

  // Issue #37 — comment and journal_ref joined the FTS index in schema v3, so
  // the documented co: / jr: prefixes have a column to route at.
  describe('comment and journal_ref in the FTS index (#37)', () => {
    const seedAnnotated = () =>
      store.applyBatch(
        [
          mkRecord({
            paper_id: 'annotated',
            title: 'A paper with publication metadata',
            comments: 'Accepted at ICML 2021, 12 pages',
            journal_ref: 'Nature Physics 17 (2021) 123',
          }),
          mkRecord({ paper_id: 'bare', title: 'A paper with no publication metadata' }),
        ],
        [],
      );

    const idsFor = (matchExpr: string): string[] =>
      store
        .search({ matchExpr, limit: 10, offset: 0, sortBy: 'relevance', sortOrder: 'descending' })
        .papers.map((p) => p.id);

    it('matches a comment term through the comment column', () => {
      seedAnnotated();
      expect(idsFor('comment:"ICML"')).toEqual(['annotated']);
      expect(idsFor('comment:"12 pages"')).toEqual(['annotated']);
    });

    it('matches a journal reference through the journal_ref column', () => {
      seedAnnotated();
      expect(idsFor('journal_ref:"Nature"')).toEqual(['annotated']);
    });

    it('keeps the columns distinct rather than pooling every field', () => {
      seedAnnotated();
      expect(idsFor('comment:"Nature"')).toEqual([]);
      expect(idsFor('journal_ref:"ICML"')).toEqual([]);
    });

    it('reaches the new columns from an unqualified term, as arXiv does', () => {
      seedAnnotated();
      expect(idsFor('"ICML"')).toEqual(['annotated']);
    });

    it('leaves the columns empty for a paper with no comment or journal ref', () => {
      seedAnnotated();
      // No match, and no error — a NULL column is indexed as empty text.
      expect(idsFor('comment:"anything"')).toEqual([]);
    });

    // The sync triggers enumerate their columns, so a trigger that missed the
    // two new ones would leave the index frozen at the first-inserted values.
    it('keeps the index in sync when a comment changes', () => {
      seedAnnotated();
      store.applyBatch(
        [
          mkRecord({
            paper_id: 'annotated',
            title: 'A paper with publication metadata',
            comments: 'Withdrawn by the authors',
            journal_ref: 'Nature Physics 17 (2021) 123',
          }),
        ],
        [],
      );
      expect(idsFor('comment:"ICML"')).toEqual([]);
      expect(idsFor('comment:"Withdrawn"')).toEqual(['annotated']);
      expect(idsFor('journal_ref:"Nature"')).toEqual(['annotated']);
    });

    it('drops the indexed comment when the paper is tombstoned', () => {
      seedAnnotated();
      store.applyBatch([], [{ paper_id: 'annotated' }]);
      expect(idsFor('comment:"ICML"')).toEqual([]);
      expect(idsFor('journal_ref:"Nature"')).toEqual([]);
    });
  });

  // Issue #36 — a `cat:` operand in the query text and the `category` parameter
  // are independent filters that the live path AND-s together. Merging them into
  // one OR-ed set would make the same inputs widen the result set here.
  describe('category groups are AND-ed (#36)', () => {
    beforeEach(() => {
      store.applyBatch(
        [
          mkRecord({ paper_id: 'both', categories: 'cs.LG stat.ML' }),
          mkRecord({ paper_id: 'lg-only', categories: 'cs.LG' }),
          mkRecord({ paper_id: 'ml-only', categories: 'stat.ML' }),
        ],
        [],
      );
    });

    const search = (categoryGroups: string[][]) =>
      store
        .search({
          categoryGroups,
          limit: 10,
          offset: 0,
          sortBy: 'updated',
          sortOrder: 'descending',
        })
        .papers.map((p) => p.id)
        .sort();

    it('intersects two groups instead of unioning them', () => {
      expect(search([['cs.LG'], ['stat.ML']])).toEqual(['both']);
    });

    it('still ORs codes within one group', () => {
      expect(search([['cs.LG', 'stat.ML']])).toEqual(['both', 'lg-only', 'ml-only']);
    });

    it('counts the intersection, not the union', () => {
      const result = store.search({
        categoryGroups: [['cs.LG'], ['stat.ML']],
        limit: 10,
        offset: 0,
        sortBy: 'updated',
        sortOrder: 'descending',
      });
      expect(result.total).toBe(1);
    });

    it('returns nothing when the groups cannot both be satisfied', () => {
      expect(search([['cs.LG'], ['astro-ph.CO']])).toEqual([]);
    });

    it('ignores an empty group rather than filtering everything out', () => {
      expect(search([['cs.LG'], []])).toEqual(['both', 'lg-only']);
    });
  });

  it('matches category filters against primary or secondary tokens', () => {
    store.applyBatch(
      [
        mkRecord({ paper_id: '1', categories: 'cs.LG stat.ML' }),
        mkRecord({ paper_id: '2', categories: 'stat.ML cs.LG' }),
        mkRecord({ paper_id: '3', categories: 'physics.flu-dyn' }),
      ],
      [],
    );
    const result = store.search({
      categoryGroups: [['stat.ML']],
      limit: 10,
      offset: 0,
      sortBy: 'updated',
      sortOrder: 'descending',
    });
    expect(result.total).toBe(2);
    expect(result.papers.map((p) => p.id).sort()).toEqual(['1', '2']);
  });

  // Issue #27 — `published` bounds. The category-browse fast path pages straight
  // off the junction index and never touches the generic WHERE clause, so a date
  // window has to force the generic path or the filter silently does nothing.
  describe('published date bounds', () => {
    beforeEach(() => {
      store.applyBatch(
        [
          mkRecord({
            paper_id: 'early',
            categories: 'cs.LG',
            versions: [{ version: 'v1', date: '2024-03-09T23:59:59Z' }],
          }),
          mkRecord({
            paper_id: 'inside',
            categories: 'cs.LG',
            versions: [{ version: 'v1', date: '2024-03-10T12:00:00Z' }],
          }),
          mkRecord({
            paper_id: 'late',
            categories: 'cs.LG',
            versions: [{ version: 'v1', date: '2024-03-11T00:00:01Z' }],
          }),
        ],
        [],
      );
    });

    const search = (extra: Record<string, unknown>) =>
      store.search({
        limit: 10,
        offset: 0,
        sortBy: 'published',
        sortOrder: 'ascending',
        ...extra,
      });

    it('bounds rows inclusively on both ends', () => {
      const result = search({
        publishedFrom: '2024-03-10T00:00:00.000Z',
        publishedTo: '2024-03-11T00:00:00.000Z',
      });
      expect(result.total).toBe(1);
      expect(result.papers.map((p) => p.id)).toEqual(['inside']);
    });

    it('applies each bound on its own', () => {
      expect(search({ publishedFrom: '2024-03-10T00:00:00.000Z' }).total).toBe(2);
      expect(search({ publishedTo: '2024-03-10T00:00:00.000Z' }).total).toBe(1);
    });

    it('applies the window on the single-category browse shape', () => {
      // Same shape that would otherwise take the junction-index fast path:
      // one category, no FTS term, non-published sort.
      const result = store.search({
        categoryGroups: [['cs.LG']],
        publishedFrom: '2024-03-10T00:00:00.000Z',
        publishedTo: '2024-03-11T00:00:00.000Z',
        limit: 10,
        offset: 0,
        sortBy: 'updated',
        sortOrder: 'descending',
      });
      expect(result.total).toBe(1);
      expect(result.papers.map((p) => p.id)).toEqual(['inside']);
    });

    it('applies the window alongside an FTS term', () => {
      const result = store.search({
        matchExpr: '"Default"',
        publishedFrom: '2024-03-10T00:00:00.000Z',
        publishedTo: '2024-03-11T00:00:00.000Z',
        limit: 10,
        offset: 0,
        sortBy: 'published',
        sortOrder: 'ascending',
      });
      expect(result.papers.map((p) => p.id)).toEqual(['inside']);
    });
  });

  it('persists harvest state across writes', () => {
    store.writeHarvestState({
      status: 'in_progress',
      started_at: '2026-05-21T00:00:00Z',
      last_datestamp: '2024-01-22',
      resumption_token: 'tok',
    });
    const state = store.readHarvestState();
    expect(state.status).toBe('in_progress');
    expect(state.last_datestamp).toBe('2024-01-22');
    expect(state.resumption_token).toBe('tok');
  });

  it('preserves the completion marker across an in-progress refresh write (#21)', () => {
    // A completed cold harvest sets the durable markers.
    store.writeHarvestState({
      status: 'complete',
      started_at: '2024-02-21T00:00:00Z',
      completed_at: '2024-02-21T01:00:00Z',
      last_datestamp: '2024-02-20',
      total_records: 3_000_000,
    });
    // A subsequent refresh flips status to in_progress and omits the markers —
    // they must survive so readiness (which keys off completed_at) holds and the
    // mirror keeps serving the existing dataset throughout the refresh.
    store.writeHarvestState({
      status: 'in_progress',
      started_at: '2024-02-22T00:00:00Z',
      last_datestamp: '2024-02-21',
      resumption_token: 'tok',
    });
    const state = store.readHarvestState();
    expect(state.status).toBe('in_progress');
    expect(state.completed_at).toBe('2024-02-21T01:00:00Z');
    expect(state.total_records).toBe(3_000_000);
    expect(state.last_datestamp).toBe('2024-02-21');
  });

  it('preserves the completion marker across a failed refresh write (#21)', () => {
    store.writeHarvestState({
      status: 'complete',
      completed_at: '2024-02-21T01:00:00Z',
      total_records: 3_000_000,
    });
    store.writeHarvestState({
      status: 'error',
      started_at: '2024-02-22T00:00:00Z',
      error_message: 'OAI ListRecords HTTP 503',
    });
    const state = store.readHarvestState();
    expect(state.status).toBe('error');
    expect(state.error_message).toBe('OAI ListRecords HTTP 503');
    expect(state.completed_at).toBe('2024-02-21T01:00:00Z');
    expect(state.total_records).toBe(3_000_000);
  });

  it('advances the completion marker when a later harvest completes (#21)', () => {
    store.writeHarvestState({
      status: 'complete',
      completed_at: '2024-02-21T01:00:00Z',
      total_records: 3_000_000,
    });
    store.writeHarvestState({
      status: 'complete',
      completed_at: '2024-02-22T01:00:00Z',
      total_records: 3_000_100,
    });
    const state = store.readHarvestState();
    expect(state.completed_at).toBe('2024-02-22T01:00:00Z');
    expect(state.total_records).toBe(3_000_100);
  });

  it('passes PRAGMA integrity checks on a freshly migrated database', () => {
    const result = store.integrityCheck();
    expect(result.ok).toBe(true);
    expect(result.results.length).toBeGreaterThan(0);
  });

  // Issue #50 — the write path's index on paper_categories(paper_id) is built
  // by the harvest runner through ensureWriteIndex, never by open.
  describe('write-path index (#50)', () => {
    async function junctionIndexes(): Promise<string[]> {
      const { Database } = await import('bun:sqlite');
      const db = new Database(dbPath, { readonly: true });
      const rows = db.prepare(`PRAGMA index_list(paper_categories)`).all() as { name: string }[];
      db.close();
      return rows.map((r) => r.name).sort();
    }

    it('is not built by open, and ensureWriteIndex adds it idempotently', async () => {
      expect(await junctionIndexes()).not.toContain('paper_categories_paper_id_idx');

      store.ensureWriteIndex();
      store.ensureWriteIndex();

      expect(await junctionIndexes()).toEqual([
        'paper_categories_cat_updated_idx',
        'paper_categories_paper_id_idx',
        'sqlite_autoindex_paper_categories_1',
      ]);
      expect(store.schemaVersion().current).toBe(3);
    });

    it('leaves every search result and count unchanged', () => {
      store.applyBatch(
        [
          mkRecord({ paper_id: 'a', title: 'Protein folding', categories: 'cs.LG stat.ML' }),
          mkRecord({ paper_id: 'b', title: 'Protein design', categories: 'cs.LG' }),
          mkRecord({ paper_id: 'c', title: 'Dark matter', categories: 'astro-ph.CO stat.ML' }),
        ],
        [],
      );
      const shapes = [
        { categoryGroups: [['cs.LG']] },
        { categoryGroups: [['cs.LG', 'astro-ph.CO']] },
        { categoryGroups: [['cs.LG'], ['stat.ML']] },
        { categoryGroups: [['stat.ML']], sortBy: 'published' as const },
        { matchExpr: '"protein"', categoryGroups: [['cs.LG']] },
        { matchExpr: '"protein"' },
      ];
      const runAll = () =>
        shapes.map((s) =>
          store.search({
            limit: 10,
            offset: 0,
            sortBy: 'updated',
            sortOrder: 'descending',
            ...s,
          }),
        );

      const before = runAll();
      store.ensureWriteIndex();
      const after = runAll();

      expect(after).toEqual(before);
      expect(before.map((r) => r.total)).toEqual([2, 3, 1, 2, 2, 2]);
    });

    it('keeps record rewrites and tombstone cascades exact with the index in place', () => {
      store.ensureWriteIndex();
      store.applyBatch([mkRecord({ paper_id: 'x', categories: 'cs.LG stat.ML' })], []);
      store.applyBatch([mkRecord({ paper_id: 'x', categories: 'math.AP' })], []);
      const count = (cat: string) =>
        store.search({
          categoryGroups: [[cat]],
          limit: 10,
          offset: 0,
          sortBy: 'updated',
          sortOrder: 'descending',
        }).total;
      expect([count('cs.LG'), count('stat.ML'), count('math.AP')]).toEqual([0, 0, 1]);

      store.applyBatch([], [{ paper_id: 'x' }]);
      expect(count('math.AP')).toBe(0);
    });
  });

  // Issue #49 — a search with an FTS term is driven from the FTS index: the
  // count and the page read only the matching rows, and relevance is BM25.
  describe('FTS-driven search (#49)', () => {
    const WORDS = ['protein', 'folding', 'galaxy', 'neural', 'quantum', 'graph', 'learning'];
    const AUTHORS = ['Alice Smith', 'Bob Jones', 'Carol Adams', 'Dan Smith'];
    const CATS = ['cs.LG', 'cs.AI', 'stat.ML', 'astro-ph.CO', 'math.AP', 'hep-th'];
    const pick = <T>(list: readonly T[], i: number): T => list[i % list.length] as T;

    /** 60 records whose fields, categories, and dates vary independently. */
    const seedVaried = () =>
      store.applyBatch(
        Array.from({ length: 60 }, (_, i) =>
          mkRecord({
            paper_id: `2001.${String(i).padStart(5, '0')}`,
            title: `${pick(WORDS, i)} ${pick(WORDS, i * 3 + 1)} study`,
            authors: `${pick(AUTHORS, i)}, ${pick(AUTHORS, i + 2)}`,
            abstract: `We examine ${pick(WORDS, i * 5 + 2)} with a neural network and ${pick(WORDS, i + 4)}.`,
            categories: `${pick(CATS, i)} ${pick(CATS, i * 7 + 3)}`,
            ...(i % 4 === 0 && { comments: 'Accepted at ICML, 9 pages' }),
            ...(i % 5 === 0 && { journal_ref: 'Nature Physics 17 (2021)' }),
            versions: [
              { version: 'v1', date: new Date(Date.UTC(2020, 0, 1 + i * 23)).toISOString() },
              {
                version: 'v2',
                date: new Date(Date.UTC(2024, 0, 1 + ((i * 37) % 60))).toISOString(),
              },
            ],
          }),
        ),
        [],
      );

    /** Real arXiv-syntax query shapes, run through the production translator. */
    const SHAPES: { category?: string; from?: string; q: string; to?: string }[] = [
      { q: 'ti:protein' },
      { q: 'au:smith' },
      { q: 'abs:"neural network"' },
      { q: 'co:accepted' },
      { q: 'jr:nature' },
      { q: 'all:quantum' },
      { q: 'protein AND folding' },
      { q: 'protein OR galaxy' },
      { q: 'learning ANDNOT graph' },
      { q: '(protein OR galaxy) AND cat:cs.LG' },
      { q: 'all:study AND cat:cs', category: 'math' },
      { q: 'graph', category: 'astro-ph' },
      { q: 'all:study', from: '2021-01-01T00:00:00.000Z', to: '2022-12-31T00:00:00.000Z' },
      { q: 'neural AND submittedDate:[202001010000 TO 202106300000]' },
      { q: 'au:smith OR co:icml', category: 'cs.AI', from: '2020-06-01T00:00:00.000Z' },
    ];

    const resolve = (shape: (typeof SHAPES)[number]) => {
      const t = translateQuery(shape.q);
      const categoryGroups = [
        t.categoryFilters,
        shape.category ? categorySubtree(shape.category) : [],
      ].filter((g) => g.length > 0);
      const from = shape.from ?? t.published.from;
      const to = shape.to ?? t.published.to;
      return {
        matchExpr: t.matchExpr as string,
        categoryGroups,
        ...(from !== undefined && { publishedFrom: from }),
        ...(to !== undefined && { publishedTo: to }),
      };
    };

    /** The rowid-IN filter `store.search` ran before #49, kept as the reference. */
    async function legacyIds(filters: ReturnType<typeof resolve>): Promise<string[]> {
      const { Database } = await import('bun:sqlite');
      const db = new Database(dbPath, { readonly: true });
      const where = ['papers.rowid IN (SELECT rowid FROM papers_fts WHERE papers_fts MATCH ?)'];
      const params: string[] = [filters.matchExpr];
      for (const group of filters.categoryGroups) {
        where.push(
          `papers.id IN (SELECT paper_id FROM paper_categories WHERE category IN (${group.map(() => '?').join(', ')}))`,
        );
        params.push(...group);
      }
      if (filters.publishedFrom !== undefined) {
        where.push('papers.published >= ?');
        params.push(filters.publishedFrom);
      }
      if (filters.publishedTo !== undefined) {
        where.push('papers.published <= ?');
        params.push(filters.publishedTo);
      }
      const rows = db
        .prepare(`SELECT papers.id AS id FROM papers WHERE ${where.join(' AND ')}`)
        .all(...params) as { id: string }[];
      db.close();
      return rows.map((r) => r.id).sort();
    }

    it.each(SHAPES.map((s) => [s.q + (s.category ? ` [category ${s.category}]` : ''), s] as const))(
      'matches the same set and count as the rowid-IN form for %s',
      async (_label, shape) => {
        seedVaried();
        const filters = resolve(shape);
        const expected = await legacyIds(filters);
        expect(expected.length).toBeGreaterThan(0);
        for (const sortBy of ['relevance', 'published', 'updated'] as const) {
          const result = store.search({
            ...filters,
            limit: 1_000,
            offset: 0,
            sortBy,
            sortOrder: 'descending',
          });
          expect(result.total).toBe(expected.length);
          expect(result.papers.map((p) => p.id).sort()).toEqual(expected);
        }
      },
    );

    // The unfiltered shape counts from the index alone; the filtered one counts
    // inside its page query, and past the end has no page row to count from.
    const PAGED = [
      { label: 'unfiltered', shape: { q: 'all:study' }, total: 60 },
      {
        label: 'category- and date-filtered',
        shape: { q: 'all:study', category: 'cs', from: '2020-06-01T00:00:00.000Z' },
        total: 35,
      },
    ];
    it.each(
      PAGED.flatMap((p) =>
        (['relevance', 'published', 'updated'] as const).map(
          (sortBy) => [p.label, sortBy, p] as const,
        ),
      ),
    )(
      'pages a %s %s-sorted result without gaps or repeats, and past the end returns nothing',
      async (_label, sortBy, { shape, total }) => {
        seedVaried();
        const filters = resolve(shape);
        const run = (limit: number, offset: number) =>
          store.search({ ...filters, limit, offset, sortBy, sortOrder: 'ascending' });
        const full = run(1_000, 0);
        expect(full.total).toBe(total);
        expect(full.papers.map((p) => p.id).sort()).toEqual(await legacyIds(filters));

        const walked: string[] = [];
        for (let offset = 0; ; offset += 7) {
          const page = run(7, offset);
          expect(page.total).toBe(total);
          if (page.papers.length === 0) break;
          walked.push(...page.papers.map((p) => p.id));
        }
        expect(walked).toEqual(full.papers.map((p) => p.id));

        expect(run(7, total)).toEqual({ papers: [], total });
        expect(run(7, total + 50)).toEqual({ papers: [], total });
      },
    );

    it('returns an exact zero for a term nothing matches', () => {
      seedVaried();
      expect(
        store.search({
          matchExpr: '"nonexistentterm"',
          limit: 10,
          offset: 0,
          sortBy: 'relevance',
          sortOrder: 'descending',
        }),
      ).toEqual({ papers: [], total: 0 });
    });

    it('orders relevance pages by BM25 score, best first, not by insertion order', async () => {
      const filler = Array.from({ length: 40 }, (_, i) => `filler${i}`).join(' ');
      store.applyBatch(
        [
          mkRecord({ paper_id: 'weak', title: 'Survey', abstract: `${filler} quantum ${filler}` }),
          mkRecord({ paper_id: 'strong', title: 'Quantum', abstract: 'quantum quantum computing' }),
          mkRecord({ paper_id: 'medium', title: 'Notes', abstract: 'quantum notes on things' }),
          mkRecord({ paper_id: 'unrelated', title: 'Galaxy', abstract: 'galaxy survey' }),
        ],
        [],
      );
      const { Database } = await import('bun:sqlite');
      const db = new Database(dbPath, { readonly: true });
      const scored = db
        .prepare(
          `SELECT papers.id AS id, bm25(papers_fts) AS score
           FROM papers_fts JOIN papers ON papers.rowid = papers_fts.rowid
           WHERE papers_fts MATCH ? ORDER BY score`,
        )
        .all('"quantum"') as { id: string; score: number }[];
      db.close();

      // The reference ranking really is BM25: negative, ascending, and not the
      // order the rows were written in.
      expect(scored.every((r) => r.score < 0)).toBe(true);
      expect(scored.map((r) => r.score)).toEqual(
        [...scored.map((r) => r.score)].sort((a, b) => a - b),
      );
      expect(scored.map((r) => r.id)).not.toEqual(['weak', 'strong', 'medium']);

      const result = store.search({
        matchExpr: '"quantum"',
        limit: 10,
        offset: 0,
        sortBy: 'relevance',
        sortOrder: 'descending',
      });
      expect(result.papers.map((p) => p.id)).toEqual(scored.map((r) => r.id));
      expect(result.total).toBe(3);
    });

    it('orders a category- and date-filtered relevance page by BM25 too', () => {
      const filler = Array.from({ length: 40 }, (_, i) => `filler${i}`).join(' ');
      store.applyBatch(
        [
          mkRecord({ paper_id: 'weak', title: 'Survey', abstract: `${filler} quantum ${filler}` }),
          mkRecord({ paper_id: 'strong', title: 'Quantum', abstract: 'quantum quantum computing' }),
          mkRecord({ paper_id: 'medium', title: 'Notes', abstract: 'quantum notes on things' }),
          mkRecord({
            paper_id: 'other-category',
            title: 'Quantum',
            abstract: 'quantum quantum quantum',
            categories: 'hep-th',
          }),
        ],
        [],
      );

      const result = store.search({
        matchExpr: '"quantum"',
        categoryGroups: [['cs.LG']],
        publishedFrom: '2024-01-01T00:00:00.000Z',
        limit: 10,
        offset: 0,
        sortBy: 'relevance',
        sortOrder: 'descending',
      });

      expect(result.total).toBe(3);
      expect(result.papers.map((p) => p.id)).toEqual(['strong', 'medium', 'weak']);
    });
  });
});

/**
 * Issue #49 — the bounded probe that decides whether a free-text search is small
 * enough for the mirror. One store holds 50,001 matches of `everyword`; the
 * marker terms sit one below, at, and above the cap.
 */
describe('MirrorStore.matchReachesCap (#49)', () => {
  let dir: string;
  let store: MirrorStore;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arxiv-mirror-cap-test-'));
    const dbPath = join(dir, 'mirror.db');
    (await MirrorStore.open(dbPath)).close();
    const { Database } = await import('bun:sqlite');
    const db = new Database(dbPath);
    db.exec(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50001)
      INSERT INTO papers(id, version, title, authors, abstract, primary_category,
                         categories, published, updated, latest_version)
      SELECT 'bulk.' || i, '1', 'Bulk', 'A',
             CASE WHEN i < 50000 THEN 'everyword nearcap atcap'
                  WHEN i = 50000 THEN 'everyword atcap'
                  ELSE 'everyword' END,
             'cs.LG', 'cs.LG', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z',
             '2024-01-01T00:00:00.000Z'
      FROM n;
      INSERT INTO paper_categories(category, paper_id, updated)
      SELECT 'cs.LG', id, updated FROM papers;
    `);
    db.close();
    store = await MirrorStore.open(dbPath);
  });

  afterAll(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('stays under the cap one match below it', () => {
    expect(store.matchReachesCap('"nearcap"')).toBe(false);
  });

  it('reaches the cap at exactly the cap and above it', () => {
    expect(store.matchReachesCap('"atcap"')).toBe(true);
    expect(store.matchReachesCap('"everyword"')).toBe(true);
  });

  it('stays under the cap for a term with no matches', () => {
    expect(store.matchReachesCap('"absent"')).toBe(false);
  });

  it('raises the FTS5 parse error for a malformed expression', () => {
    expect(() => store.matchReachesCap('title:')).toThrow(/^fts5:/);
  });

  it('counts a just-under-cap match set exactly, with and without a category group', () => {
    const run = (categoryGroups: string[][]) =>
      store.search({
        matchExpr: '"nearcap"',
        categoryGroups,
        limit: 2,
        offset: 0,
        sortBy: 'relevance',
        sortOrder: 'descending',
      });
    expect(run([]).total).toBe(49_999);
    expect(run([['cs.LG']]).total).toBe(49_999);
    expect(run([['cs.LG']]).papers).toHaveLength(2);
  });
});

describe('rawToRow', () => {
  it('uses the latest version date as updated and the earliest as published', () => {
    const row = rawToRow(
      mkRecord({
        versions: [
          { version: 'v1', date: '2024-01-22T00:00:00Z' },
          { version: 'v3', date: '2024-04-10T00:00:00Z' },
          { version: 'v2', date: '2024-02-01T00:00:00Z' },
        ],
      }),
    );
    // normalizeDateToIso always uses toISOString() which includes milliseconds.
    expect(row.published).toBe('2024-01-22T00:00:00.000Z');
    expect(row.updated).toBe('2024-04-10T00:00:00.000Z');
    expect(row.version).toBe('3');
  });

  it('picks the first category token as primary', () => {
    const row = rawToRow(mkRecord({ categories: 'physics.optics cs.LG' }));
    expect(row.primary_category).toBe('physics.optics');
    expect(row.categories).toBe('physics.optics cs.LG');
  });
});
