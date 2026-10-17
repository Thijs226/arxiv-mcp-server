/**
 * @fileoverview Tests for the mirror harvest runner — where a run starts
 * (saved resumption token vs. `from=last_datestamp`), what it persists as it
 * goes, the write-path index it ensures before the first page (#50), and the
 * deadline that stops it after a whole page (#39). Drives the real
 * `MirrorStore` on a temp file; only `fetch` (the OAI endpoint) is stubbed.
 * @module services/arxiv/mirror/runner.test
 */

import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { worstCasePageFetchMs } from '@/services/arxiv/mirror/harvester.js';
import { runHarvest } from '@/services/arxiv/mirror/runner.js';
import { MirrorStore, openStore, resetStore } from '@/services/arxiv/mirror/store.js';

const config = {
  apiTimeoutMs: 15_000,
  mirrorPath: '',
  mirrorOaiBaseUrl: 'https://oai.test/oai',
  mirrorOaiRequestDelayMs: 0,
};

vi.mock('@/config/server-config.js', () => ({ getServerConfig: () => config }));

const mockFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// OAI response builders
// ---------------------------------------------------------------------------

const record = (id: string, datestamp: string): string => `
  <record>
    <header><identifier>oai:arXiv.org:${id}</identifier><datestamp>${datestamp}</datestamp></header>
    <metadata><arXivRaw>
      <id>${id}</id><title>Paper ${id}</title><authors>A. Author</authors>
      <categories>cs.LG math.AP</categories><abstract>Abstract of ${id}.</abstract>
      <version version="v1"><date>Mon, 1 Jun 2026 00:00:00 GMT</date></version>
    </arXivRaw></metadata>
  </record>`;

const listRecords = (records: string[], token?: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/"><ListRecords>${records.join('')}${
    token ? `<resumptionToken expirationDate="2026-06-05T00:00:00Z">${token}</resumptionToken>` : ''
  }</ListRecords></OAI-PMH>`;

const BAD_TOKEN = `<?xml version="1.0" encoding="UTF-8"?>
<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/"><error code="badResumptionToken">expired</error></OAI-PMH>`;

/** Requested URLs, in order. */
let requests: URL[];

/** Answer each fetch with the next queued body (status 200 unless given). */
function serve(...bodies: (string | { body: string; status: number })[]): void {
  mockFetch.mockImplementation(async (url, init) => {
    init?.signal?.throwIfAborted();
    requests.push(new URL(url));
    const next = bodies.shift();
    if (next === undefined) throw new Error(`unexpected fetch: ${url}`);
    const { body, status } = typeof next === 'string' ? { body: next, status: 200 } : next;
    return new Response(body, { status, headers: { 'content-type': 'text/xml' } });
  });
}

const tokenOf = (u: URL | undefined) => u?.searchParams.get('resumptionToken') ?? null;
const fromOf = (u: URL | undefined) => u?.searchParams.get('from') ?? null;

const makeCtx = (signal = new AbortController().signal) => ({
  log: { debug: vi.fn(), info: vi.fn(), notice: vi.fn(), warning: vi.fn(), error: vi.fn() },
  signal,
});

/** Query plans for the two lookups a record write and a tombstone cascade make by paper_id. */
function writePathPlans(path: string): string[] {
  const db = new Database(path, { readonly: true });
  const plans = [
    `EXPLAIN QUERY PLAN DELETE FROM paper_categories WHERE paper_id = ?`,
    `EXPLAIN QUERY PLAN SELECT 1 FROM paper_categories WHERE paper_id = ?`,
  ].map((sql) =>
    (db.prepare(sql).all('2606.00001') as { detail: string }[]).map((r) => r.detail).join(' | '),
  );
  db.close();
  return plans;
}

const INDEXED_LOOKUP =
  /^SEARCH paper_categories USING (COVERING )?INDEX paper_categories_paper_id_idx \(paper_id=\?\)$/;

describe('runHarvest', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'arxiv-runner-test-'));
    config.mirrorPath = join(dir, 'mirror.db');
    requests = [];
    mockFetch.mockReset();
  });

  afterEach(async () => {
    resetStore();
    await rm(dir, { recursive: true, force: true });
  });

  /** Seed papers plus a harvest_state row through the shared store handle. */
  async function seed(
    state: Parameters<MirrorStore['writeHarvestState']>[0],
  ): Promise<MirrorStore> {
    const store = await openStore(config.mirrorPath);
    store.writeHarvestState(state);
    return store;
  }

  // -------------------------------------------------------------------------
  // Where a run starts
  // -------------------------------------------------------------------------

  describe('start position', () => {
    it('starts a refresh after a completed run from last_datestamp (inclusive)', async () => {
      await seed({ status: 'complete', last_datestamp: '2026-06-03', completed_at: 'c' });
      serve(listRecords([record('2606.00001', '2026-06-03')]));

      await runHarvest(makeCtx(), { mode: 'refresh' });

      expect(requests).toHaveLength(1);
      expect(tokenOf(requests[0])).toBeNull();
      expect(fromOf(requests[0])).toBe('2026-06-03');
    });

    it('resumes a refresh that stopped before draining from its saved token (#50)', async () => {
      await seed({
        status: 'in_progress',
        last_datestamp: '2026-06-04',
        resumption_token: 'saved-tok',
      });
      serve(listRecords([record('2606.00002', '2026-06-04')]));

      await runHarvest(makeCtx(), { mode: 'refresh' });

      expect(tokenOf(requests[0])).toBe('saved-tok');
      expect(fromOf(requests[0])).toBeNull();
    });

    it('resumes from the saved token after a run that ended in error (#50)', async () => {
      await seed({ status: 'error', last_datestamp: '2026-06-04', resumption_token: 'saved-tok' });
      serve(listRecords([record('2606.00002', '2026-06-04')]));

      await runHarvest(makeCtx(), { mode: 'init' });

      expect(tokenOf(requests[0])).toBe('saved-tok');
    });

    it('falls back to from=last_datestamp when the saved token is rejected (#50)', async () => {
      await seed({
        status: 'in_progress',
        last_datestamp: '2026-06-04',
        resumption_token: 'stale-tok',
      });
      serve(BAD_TOKEN, listRecords([record('2606.00003', '2026-06-04')]));

      const result = await runHarvest(makeCtx(), { mode: 'refresh' });

      expect(requests.map((u) => [tokenOf(u), fromOf(u)])).toEqual([
        ['stale-tok', null],
        [null, '2026-06-04'],
      ]);
      expect(result.drained).toBe(true);
    });

    it('keeps the saved token through the start-of-run write (#50)', async () => {
      // A run that fails before its first page must leave the token it started
      // from, or the next run loses its place inside the datestamp.
      await seed({
        status: 'in_progress',
        last_datestamp: '2026-06-04',
        resumption_token: 'saved-tok',
      });
      const store = await openStore(config.mirrorPath);
      let tokenDuringFirstFetch: string | undefined;
      mockFetch.mockImplementation(async (url) => {
        requests.push(new URL(url));
        // A run killed here never reaches its catch: this is the state it leaves.
        tokenDuringFirstFetch = store.readHarvestState().resumption_token;
        return new Response('Bad request', { status: 400 });
      });

      await expect(runHarvest(makeCtx(), { mode: 'refresh' })).rejects.toThrow(/HTTP 400/);

      expect(tokenDuringFirstFetch).toBe('saved-tok');
      const state = (await openStore(config.mirrorPath)).readHarvestState();
      expect(state.status).toBe('error');
      expect(state.resumption_token).toBe('saved-tok');
      expect(state.last_datestamp).toBe('2026-06-04');
    });

    it('writes complete and clears the token once the list drains', async () => {
      const store = await seed({
        status: 'in_progress',
        last_datestamp: '2026-06-04',
        resumption_token: 'saved-tok',
      });
      serve(listRecords([record('2606.00004', '2026-06-05')], 'next-tok'), listRecords([]));

      const result = await runHarvest(makeCtx(), { mode: 'refresh' });

      const state = store.readHarvestState();
      expect(state.status).toBe('complete');
      expect(state.resumption_token).toBeUndefined();
      expect(state.completed_at).toBeDefined();
      expect(state.last_datestamp).toBe('2026-06-05');
      expect(tokenOf(requests[1])).toBe('next-tok');
      expect(result).toMatchObject({
        drained: true,
        pagesFetched: 2,
        recordsApplied: 1,
        lastDatestamp: '2026-06-05',
        totalRecords: 1,
      });
    });

    it("checkpoints this run's start time, not the previous run's", async () => {
      const store = await seed({
        status: 'complete',
        last_datestamp: '2026-06-03',
        started_at: '2020-01-01T00:00:00.000Z',
        completed_at: '2020-01-01T01:00:00.000Z',
      });
      serve(listRecords([record('2606.00001', '2026-06-03')], 'tok-1'), listRecords([]));
      const seen: (string | undefined)[] = [];

      const before = new Date().toISOString();
      await runHarvest(makeCtx(), {
        mode: 'refresh',
        onProgress: () => seen.push(store.readHarvestState().started_at),
      });
      const after = new Date().toISOString();

      // Every checkpoint, and the completed state, carry one start time taken
      // during this run.
      const [startedAt] = seen;
      expect(startedAt! >= before && startedAt! <= after, String(startedAt)).toBe(true);
      expect(seen).toEqual([startedAt, startedAt]);
      expect(store.readHarvestState().started_at).toBe(startedAt);
    });
  });

  // -------------------------------------------------------------------------
  // Write-path index (#50)
  // -------------------------------------------------------------------------

  describe('write-path index on paper_categories(paper_id)', () => {
    it('is absent from a file MirrorStore.open created and full-scans per write', async () => {
      const store = await MirrorStore.open(config.mirrorPath);
      expect(store.schemaVersion().current).toBe(3);
      store.close();

      for (const plan of writePathPlans(config.mirrorPath)) {
        expect(plan).toMatch(/^SCAN paper_categories/);
      }
    });

    it('is built before the first page of a fresh init', async () => {
      // The first fetch fails, so only work done before the first page can
      // have built the index.
      serve({ body: 'Bad request', status: 400 });

      await expect(runHarvest(makeCtx(), { mode: 'init' })).rejects.toThrow(/HTTP 400/);

      for (const plan of writePathPlans(config.mirrorPath)) expect(plan).toMatch(INDEXED_LOOKUP);
    });

    it('is added to a populated schema-v3 file by the next refresh', async () => {
      const store = await MirrorStore.open(config.mirrorPath);
      store.applyBatch(
        [
          {
            paper_id: '2606.00001',
            identifier: 'oai:arXiv.org:2606.00001',
            datestamp: '2026-06-01',
            title: 'Existing paper',
            authors: 'A. Author',
            abstract: 'Already harvested.',
            categories: 'cs.LG',
            versions: [{ version: 'v1', date: '2026-06-01T00:00:00Z' }],
          },
        ],
        [],
      );
      store.writeHarvestState({
        status: 'complete',
        last_datestamp: '2026-06-01',
        completed_at: 'c',
      });
      store.close();
      serve(listRecords([]));

      await runHarvest(makeCtx(), { mode: 'refresh' });

      for (const plan of writePathPlans(config.mirrorPath)) expect(plan).toMatch(INDEXED_LOOKUP);
      expect((await openStore(config.mirrorPath)).schemaVersion().current).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // Deadline (#39)
  // -------------------------------------------------------------------------

  describe('deadline', () => {
    /** Pages p1..pN, each with one record stamped `2026-06-0<n>`, the last one terminal. */
    const pages = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        listRecords(
          [record(`2606.0000${i + 1}`, `2026-06-0${i + 1}`)],
          i < n - 1 ? `tok-${i + 1}` : undefined,
        ),
      );

    it('stops after a whole page once no further page cycle fits, leaving a resumable checkpoint', async () => {
      const store = await seed({
        status: 'complete',
        last_datestamp: '2026-05-31',
        completed_at: '2026-06-01T00:00:00.000Z',
        total_records: 0,
      });
      serve(...pages(3));

      const result = await runHarvest(makeCtx(), { mode: 'refresh', deadline: Date.now() });

      expect(requests).toHaveLength(1);
      expect(result).toMatchObject({
        drained: false,
        pagesFetched: 1,
        recordsApplied: 1,
        lastDatestamp: '2026-06-01',
      });
      const state = store.readHarvestState();
      expect(state.status).toBe('in_progress');
      expect(state.resumption_token).toBe('tok-1');
      expect(state.last_datestamp).toBe('2026-06-01');
      expect(state.completed_at).toBe('2026-06-01T00:00:00.000Z');
      expect(store.countPapers()).toBe(1);
    });

    it('lets the next run continue from the checkpoint the stopped run left', async () => {
      await seed({ status: 'complete', last_datestamp: '2026-05-31', completed_at: 'c' });
      serve(...pages(3));
      await runHarvest(makeCtx(), { mode: 'refresh', deadline: Date.now() });

      const result = await runHarvest(makeCtx(), { mode: 'refresh' });

      expect(requests.map(tokenOf)).toEqual([null, 'tok-1', 'tok-2']);
      expect(result.drained).toBe(true);
      expect((await openStore(config.mirrorPath)).countPapers()).toBe(3);
    });

    it('reserves one worst-case page fetch before the deadline, not just the time left', async () => {
      // At these settings a page fetch can take ~105 s (three attempts at the
      // 15 s timeout plus two 30 s backoffs), so 100 s is not enough room.
      expect(worstCasePageFetchMs(harvestOptions())).toBe(105_000);
      expect(worstCasePageFetchMs({ ...harvestOptions(), requestDelayMs: 3000 })).toBe(108_000);
      await seed({ status: 'complete', last_datestamp: '2026-05-31', completed_at: 'c' });
      serve(...pages(3));

      const result = await runHarvest(makeCtx(), {
        mode: 'refresh',
        deadline: Date.now() + 100_000,
      });

      expect(result.drained).toBe(false);
      expect(requests).toHaveLength(1);
    });

    it('drains when its last page lands past the deadline', async () => {
      const store = await seed({
        status: 'complete',
        last_datestamp: '2026-05-31',
        completed_at: 'c',
      });
      serve(...pages(1));

      const result = await runHarvest(makeCtx(), { mode: 'refresh', deadline: Date.now() });

      expect(result.drained).toBe(true);
      expect(store.readHarvestState().status).toBe('complete');
    });

    it('reserves the slowest page apply seen so far, not only the fetch', async () => {
      await seed({ status: 'complete', last_datestamp: '2026-05-31', completed_at: 'c' });
      serve(...pages(3));
      const apply = MirrorStore.prototype.applyBatch;
      const slowApply = vi.spyOn(MirrorStore.prototype, 'applyBatch').mockImplementation(function (
        this: MirrorStore,
        ...args
      ) {
        const until = performance.now() + 400;
        while (performance.now() < until) {
          // a 400 ms page apply
        }
        return apply.apply(this, args);
      });
      try {
        // Room for one worst-case fetch plus 600 ms: a second page fits without
        // the 400 ms apply reserved, and not with it.
        const result = await runHarvest(makeCtx(), {
          mode: 'refresh',
          deadline: Date.now() + worstCasePageFetchMs(harvestOptions()) + 600,
        });
        expect(result.drained).toBe(false);
        expect(requests).toHaveLength(1);
      } finally {
        slowApply.mockRestore();
      }
    });

    it('drains when every page cycle fits, and advances completed_at', async () => {
      const store = await seed({
        status: 'complete',
        last_datestamp: '2026-05-31',
        completed_at: '2026-06-01T00:00:00.000Z',
      });
      serve(...pages(3));

      const result = await runHarvest(makeCtx(), {
        mode: 'refresh',
        deadline: Date.now() + 3_600_000,
      });

      expect(result).toMatchObject({ drained: true, pagesFetched: 3, lastDatestamp: '2026-06-03' });
      expect(store.readHarvestState().status).toBe('complete');
      expect(store.readHarvestState().completed_at).not.toBe('2026-06-01T00:00:00.000Z');
    });

    it('reports a cancellation as a failure, never as a deadline stop', async () => {
      const store = await seed({
        status: 'complete',
        last_datestamp: '2026-05-31',
        completed_at: 'c',
      });
      const controller = new AbortController();
      const [first] = pages(3);
      mockFetch.mockImplementation(async (url, init) => {
        init?.signal?.throwIfAborted();
        requests.push(new URL(url));
        // Cancelled while the page is in hand — the abort lands during apply.
        controller.abort(new Error('Aborted by SIGTERM'));
        return new Response(first, { status: 200 });
      });

      await expect(
        runHarvest(makeCtx(controller.signal), { mode: 'refresh', deadline: Date.now() }),
      ).rejects.toThrow('Aborted by SIGTERM');

      const state = store.readHarvestState();
      expect(state.status).toBe('error');
      expect(state.resumption_token).toBe('tok-1');
    });
  });
});

/** Harvester options as `runHarvest` derives them from {@link config}. */
function harvestOptions() {
  return {
    baseUrl: config.mirrorOaiBaseUrl,
    requestDelayMs: config.mirrorOaiRequestDelayMs,
    requestTimeoutMs: config.apiTimeoutMs,
  };
}
