/**
 * @fileoverview Tests for the mirror refresh subprocess offload (issues #22,
 * #31, #39) — the parent spawn supervisor (`runRefreshSubprocess`) and the
 * child harvest body (`runRefreshChild`). `node:child_process` and the harvest
 * runner are mocked so the supervisor's wiring (spawn args, log forwarding,
 * outcome resolution, exit handling, timeout escalation, concurrency guard) is
 * exercised without a real process; the last block spawns real child
 * processes against a loopback OAI endpoint to pin exit codes and the
 * deadline stop end to end.
 * @module services/arxiv/mirror/refresh-subprocess.test
 */

import { Database } from 'bun:sqlite';
import type * as ChildProcessModule from 'node:child_process';
import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { worstCasePageFetchMs } from '@/services/arxiv/mirror/harvester.js';
import {
  type RefreshOutcome,
  runRefreshChild,
  runRefreshSubprocess,
} from '@/services/arxiv/mirror/refresh-subprocess.js';
import { runHarvest } from '@/services/arxiv/mirror/runner.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('@/services/arxiv/mirror/runner.js', () => ({ runHarvest: vi.fn() }));

const spawnMock = vi.mocked(spawn);
const runHarvestMock = vi.mocked(runHarvest);

type FakeChild = EventEmitter & {
  stdout: EventEmitter & { setEncoding: () => void };
  stderr: EventEmitter & { setEncoding: () => void };
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: (signal?: NodeJS.Signals) => boolean;
};

/** Fake children made in the current test, closed in `afterEach`. */
const fakeChildren: FakeChild[] = [];

/** A fake ChildProcess with controllable stdout/stderr/exit. */
function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: () => void };
  stdout.setEncoding = () => {};
  const stderr = new EventEmitter() as EventEmitter & { setEncoding: () => void };
  stderr.setEncoding = () => {};
  child.stdout = stdout;
  child.stderr = stderr;
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn(() => true);
  fakeChildren.push(child);
  return child;
}

function makeLog() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    notice: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  };
}

const COUNTS = {
  lastDatestamp: '2026-06-04',
  pagesFetched: 3,
  recordsApplied: 3900,
  tombstonesApplied: 2,
  totalRecords: 2_500_000,
};

/** The child's final stdout line for `outcome`. */
const outcomeLine = (outcome: 'drained' | 'partial') =>
  `${JSON.stringify({ level: 'info', msg: 'Mirror refresh outcome', outcome, ...COUNTS })}\n`;

/** Emit the child's final outcome line, then a clean exit. */
function finish(
  child: ReturnType<typeof makeFakeChild>,
  outcome: 'drained' | 'partial' = 'drained',
): void {
  child.stdout.emit('data', outcomeLine(outcome));
  child.exitCode = 0;
  child.emit('close', 0, null);
}

describe('runRefreshSubprocess', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });
  afterEach(() => {
    // A test that fails before its child exits leaves the supervisor's
    // in-flight guard set, and every later spawn would resolve `skipped`.
    // Closing each fake settles the run still holding it; a settled run
    // ignores the extra close.
    for (const child of fakeChildren.splice(0)) finish(child);
    vi.useRealTimers();
  });

  it('spawns the compiled child entry with the current runtime and piped stdio', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const log = makeLog();

    const done = runRefreshSubprocess({ timeoutMs: 1000, log });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0]!;
    expect(cmd).toBe(process.execPath);
    expect(args?.[0]).toMatch(/refresh-subprocess\.js$/);
    expect((opts as { stdio: unknown }).stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect((opts as { env: unknown }).env).toBe(process.env);

    finish(child);
    await expect(done).resolves.toEqual({ outcome: 'drained', ...COUNTS });
    expect(log.error).not.toHaveBeenCalled();
    // `childPid`, not `pid`: the server logger already binds `pid` to its own process.
    expect(log.info).toHaveBeenCalledWith('Mirror refresh subprocess started', {
      childPid: 4242,
      timeoutMs: 1000,
    });
  });

  it('resolves drained and logs it at info (#39)', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const log = makeLog();

    const done = runRefreshSubprocess({ timeoutMs: 1000, log });
    finish(child, 'drained');

    await expect(done).resolves.toEqual({ outcome: 'drained', ...COUNTS });
    expect(log.info).toHaveBeenCalledWith('Mirror refresh drained', COUNTS);
    expect(log.notice).not.toHaveBeenCalled();
  });

  it('resolves partial when the child stopped at its deadline, logged at notice (#39)', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const log = makeLog();

    const done = runRefreshSubprocess({ timeoutMs: 1000, log });
    finish(child, 'partial');

    await expect(done).resolves.toEqual({ outcome: 'partial', ...COUNTS });
    expect(log.notice).toHaveBeenCalledWith(
      'Mirror refresh stopped at its deadline; the next run resumes',
      COUNTS,
    );
    expect(log.info).not.toHaveBeenCalledWith('Mirror refresh drained', expect.anything());
    expect(log.error).not.toHaveBeenCalled();
  });

  it('keeps the outcome line out of the relayed child log', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const log = makeLog();

    const done = runRefreshSubprocess({ timeoutMs: 1000, log });
    finish(child);
    await done;

    expect(log.info).not.toHaveBeenCalledWith('Mirror refresh outcome', expect.anything());
  });

  it('rejects a clean exit that reported no outcome', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const log = makeLog();

    const done = runRefreshSubprocess({ timeoutMs: 1000, log });
    child.stdout.emit('data', `${JSON.stringify({ level: 'info', msg: 'page', pages: 1 })}\n`);
    child.exitCode = 0;
    child.emit('close', 0, null);

    await expect(done).rejects.toThrow(/without reporting an outcome/);
    expect(log.error).toHaveBeenCalledWith(
      'Mirror refresh subprocess exited without reporting an outcome',
    );
  });

  it('reads an outcome line split across stdout chunks', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const log = makeLog();

    const done = runRefreshSubprocess({ timeoutMs: 1000, log });
    const line = outcomeLine('partial');
    child.stdout.emit('data', line.slice(0, 20));
    child.stdout.emit('data', line.slice(20));
    child.emit('close', 0, null);

    await expect(done).resolves.toMatchObject({ outcome: 'partial' });
  });

  it('rejects on a non-zero exit so the scheduler records the tick as failed (#31)', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const log = makeLog();

    const done = runRefreshSubprocess({ timeoutMs: 1000, log });
    child.exitCode = 1;
    child.emit('close', 1, null);
    await expect(done).rejects.toThrow(/exited with code 1/);
    expect(log.error).toHaveBeenCalledWith(
      'Mirror refresh subprocess exited non-zero',
      expect.objectContaining({ code: 1 }),
    );
  });

  it('rejects when the child fails to spawn (#31)', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('EACCES');
    });
    const log = makeLog();

    await expect(runRefreshSubprocess({ timeoutMs: 1000, log })).rejects.toThrow(/failed to spawn/);
    expect(log.error).toHaveBeenCalledWith(
      'Mirror refresh subprocess failed to spawn',
      expect.objectContaining({ error: 'EACCES' }),
    );
  });

  it('rejects when the child emits an error event (#31)', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const log = makeLog();

    const done = runRefreshSubprocess({ timeoutMs: 1000, log });
    child.emit('error', new Error('spawn ENOENT'));
    await expect(done).rejects.toThrow(/spawn ENOENT/);
    expect(log.error).toHaveBeenCalledWith('Mirror refresh subprocess error', {
      error: 'spawn ENOENT',
    });
  });

  it('settles once when an error event is followed by close', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const log = makeLog();

    const done = runRefreshSubprocess({ timeoutMs: 1000, log });
    child.emit('error', new Error('spawn ENOENT'));
    child.emit('close', -2, null);

    await expect(done).rejects.toThrow(/spawn ENOENT/);
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('releases the concurrency guard after a failed run (#31)', async () => {
    // The rejection must not strand `activeChild`, or every later tick is
    // skipped as "already running".
    const first = makeFakeChild();
    spawnMock.mockReturnValue(first as unknown as ChildProcess);
    const log = makeLog();

    const failed = runRefreshSubprocess({ timeoutMs: 1000, log });
    first.emit('close', 1, null);
    await expect(failed).rejects.toThrow();

    const second = makeFakeChild();
    spawnMock.mockReturnValue(second as unknown as ChildProcess);
    const done = runRefreshSubprocess({ timeoutMs: 1000, log });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    finish(second);
    await expect(done).resolves.toMatchObject({ outcome: 'drained' });
  });

  it('resolves skipped without spawning when a refresh is already running (#39)', async () => {
    const first = makeFakeChild();
    spawnMock.mockReturnValue(first as unknown as ChildProcess);
    const log = makeLog();

    const done1 = runRefreshSubprocess({ timeoutMs: 1000, log });
    const done2 = runRefreshSubprocess({ timeoutMs: 1000, log });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(log.warning).toHaveBeenCalledWith('Mirror refresh already running; skipping this tick');
    await expect(done2).resolves.toEqual({ outcome: 'skipped' });

    finish(first);
    await done1;
  });

  it('escalates SIGTERM then SIGKILL when the child overruns the timeout', async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const log = makeLog();

    const done = runRefreshSubprocess({ timeoutMs: 1000, log });
    vi.advanceTimersByTime(1000);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    vi.advanceTimersByTime(30_000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');

    child.emit('close', null, 'SIGKILL');
    // A harvest killed mid-flight is a failed tick, not a completed one (#31).
    await expect(done).rejects.toThrow(/terminated on timeout/);
    expect(log.error).toHaveBeenCalledWith(
      'Mirror refresh subprocess terminated on timeout',
      expect.objectContaining({ signal: 'SIGKILL' }),
    );
  });

  it('sends no signal to a child that reports in time (#39)', async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const log = makeLog();

    const done = runRefreshSubprocess({ timeoutMs: 1000, log });
    vi.advanceTimersByTime(999);
    finish(child, 'partial');
    await expect(done).resolves.toMatchObject({ outcome: 'partial' });
    vi.advanceTimersByTime(60_000);

    expect(child.kill).not.toHaveBeenCalled();
  });

  it('relays a structured child stdout line at its original level', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const log = makeLog();

    const done = runRefreshSubprocess({ timeoutMs: 1000, log });
    child.stdout.emit('data', `${JSON.stringify({ level: 'info', msg: 'page', pages: 3 })}\n`);
    expect(log.info).toHaveBeenCalledWith('page', { pages: 3 });

    finish(child);
    await done;
  });

  it('forwards a raw child stderr line at error level', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const log = makeLog();

    const done = runRefreshSubprocess({ timeoutMs: 1000, log });
    child.stderr.emit('data', 'segfault in native module\n');
    expect(log.error).toHaveBeenCalledWith('segfault in native module');

    child.emit('close', 1, null);
    await expect(done).rejects.toThrow();
  });
});

describe('runRefreshChild', () => {
  beforeEach(() => {
    runHarvestMock.mockReset();
  });

  it('runs an incremental refresh bounded by the deadline and reports it drained', async () => {
    runHarvestMock.mockResolvedValue({ drained: true, ...COUNTS });
    const log = makeLog();
    const controller = new AbortController();

    const outcome = await runRefreshChild(log, controller.signal, 1_234_567);

    expect(runHarvestMock).toHaveBeenCalledWith(
      { log, signal: controller.signal },
      { mode: 'refresh', deadline: 1_234_567 },
    );
    expect(outcome).toEqual({ outcome: 'drained', ...COUNTS });
  });

  it('reports a run that stopped at its deadline as partial', async () => {
    runHarvestMock.mockResolvedValue({ drained: false, ...COUNTS });
    const outcome = await runRefreshChild(makeLog(), new AbortController().signal, 0);
    expect(outcome).toEqual({ outcome: 'partial', ...COUNTS });
  });

  it('propagates a harvest failure to the caller', async () => {
    runHarvestMock.mockRejectedValue(new Error('OAI unreachable'));
    const log = makeLog();
    await expect(runRefreshChild(log, new AbortController().signal, 0)).rejects.toThrow(
      'OAI unreachable',
    );
  });
});

// ---------------------------------------------------------------------------
// Real child processes against a loopback OAI endpoint
// ---------------------------------------------------------------------------

describe('refresh child process (real)', () => {
  const CHILD_ENTRY = fileURLToPath(
    new URL('../../../../src/services/arxiv/mirror/refresh-subprocess.ts', import.meta.url),
  );
  /** Short per-attempt timeout keeps the worst-case page cycle (and the budgets below) small. */
  const API_TIMEOUT_MS = 1000;
  const RESERVE_MS = worstCasePageFetchMs({
    baseUrl: '',
    requestDelayMs: 0,
    requestTimeoutMs: API_TIMEOUT_MS,
  });

  let realSpawn: typeof ChildProcessModule.spawn;
  /** Real children started in the current test, with a promise for each one's `close`. */
  let started: { child: ChildProcess; closed: Promise<void> }[];
  let dir: string;
  let dbPath: string;
  let server: Server;
  let requests: URL[];
  /** How the endpoint answers the request for page `n` (1-based). */
  let respond: (n: number, res: ServerResponse) => void;

  const record = (id: string) =>
    `<record><header><identifier>oai:arXiv.org:${id}</identifier><datestamp>2026-06-04</datestamp></header><metadata><arXivRaw><id>${id}</id><title>Paper ${id}</title><authors>A</authors><categories>cs.LG</categories><abstract>X</abstract><version version="v1"><date>Mon, 1 Jun 2026 00:00:00 GMT</date></version></arXivRaw></metadata></record>`;
  const pageBody = (n: number, last: boolean) =>
    `<?xml version="1.0" encoding="UTF-8"?><OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/"><ListRecords>${record(`2606.${String(n).padStart(5, '0')}`)}${last ? '' : `<resumptionToken>tok-${n}</resumptionToken>`}</ListRecords></OAI-PMH>`;
  /** Endless list: every page answers after `delayMs` with a token for the next. */
  const endless =
    (delayMs: number) =>
    (n: number, res: ServerResponse): void => {
      setTimeout(() => res.end(pageBody(n, false)), delayMs);
    };

  /** Record a real child so `afterEach` can stop it. */
  function track(child: ChildProcess): ChildProcess {
    started.push({ child, closed: new Promise((r) => child.once('close', () => r())) });
    return child;
  }

  beforeEach(async () => {
    realSpawn = (await vi.importActual<typeof ChildProcessModule>('node:child_process')).spawn;
    started = [];
    spawnMock.mockReset();
    spawnMock.mockImplementation(((...args: Parameters<typeof realSpawn>) =>
      track(realSpawn(...args))) as typeof spawn);
    dir = await mkdtemp(join(tmpdir(), 'arxiv-refresh-child-test-'));
    dbPath = join(dir, 'mirror.db');
    requests = [];
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      requests.push(url);
      const token = url.searchParams.get('resumptionToken');
      respond(token ? Number(token.replace('tok-', '')) + 1 : 1, res);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    vi.stubEnv('ARXIV_MIRROR_PATH', dbPath);
    vi.stubEnv('ARXIV_MIRROR_OAI_BASE_URL', `http://127.0.0.1:${port}/oai`);
    vi.stubEnv('ARXIV_MIRROR_OAI_REQUEST_DELAY_MS', '0');
    vi.stubEnv('ARXIV_API_TIMEOUT_MS', String(API_TIMEOUT_MS));
  });

  afterEach(async () => {
    // A failed or timed-out test can leave its child running, and with it the
    // supervisor's in-flight guard. Kill each such child through its own handle
    // and wait for its close, which releases the guard.
    for (const { child } of started) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await Promise.all(started.map((s) => s.closed));
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  });

  /** Spawn the child entry directly; resolves with its exit code and stdout lines. */
  function runChild(onSpawn?: (child: ChildProcess) => void) {
    return new Promise<{ code: number | null; lines: Record<string, unknown>[] }>((resolve) => {
      const child = track(
        realSpawn(process.execPath, [CHILD_ENTRY], {
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      );
      let out = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString();
      });
      onSpawn?.(child);
      child.on('close', (code) => {
        const lines = out
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>);
        resolve({ code, lines });
      });
    });
  }

  function harvestState() {
    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare('SELECT status, resumption_token, last_datestamp, completed_at FROM harvest_state')
      .get() as {
      completed_at: string | null;
      last_datestamp: string | null;
      resumption_token: string | null;
      status: string;
    };
    db.close();
    return row;
  }

  it('exits 0 and reports drained when the list runs out', async () => {
    vi.stubEnv('ARXIV_MIRROR_REFRESH_TIMEOUT_MS', '7200000');
    respond = (n, res) => res.end(pageBody(n, n === 2));

    const { code, lines } = await runChild();

    expect(code).toBe(0);
    expect(lines.at(-1)).toMatchObject({
      msg: 'Mirror refresh outcome',
      outcome: 'drained',
      pagesFetched: 2,
    });
    expect(harvestState()).toMatchObject({ status: 'complete', resumption_token: null });
  }, 20_000);

  it('exits 0 and reports partial when it stops at its deadline', async () => {
    // The budget leaves ~1.5 s once a worst-case page cycle is reserved.
    vi.stubEnv('ARXIV_MIRROR_REFRESH_TIMEOUT_MS', String(RESERVE_MS + 1500));
    respond = endless(200);

    const { code, lines } = await runChild();

    expect(code).toBe(0);
    const outcome = lines.at(-1);
    expect(outcome).toMatchObject({ msg: 'Mirror refresh outcome', outcome: 'partial' });
    const state = harvestState();
    expect(state.status).toBe('in_progress');
    expect(state.resumption_token).toBe(`tok-${outcome?.pagesFetched}`);
    expect(state.completed_at).toBeNull();
  }, 20_000);

  it('exits 1 when the harvest fails', async () => {
    vi.stubEnv('ARXIV_MIRROR_REFRESH_TIMEOUT_MS', '7200000');
    respond = (_n, res) => {
      res.statusCode = 400;
      res.end('Bad request');
    };

    const { code, lines } = await runChild();

    expect(code).toBe(1);
    expect(lines.at(-1)).toMatchObject({ level: 'error', msg: 'Mirror refresh failed' });
    expect(harvestState().status).toBe('error');
  }, 20_000);

  it('exits 1 when SIGTERM aborts a page in flight', async () => {
    vi.stubEnv('ARXIV_MIRROR_REFRESH_TIMEOUT_MS', '7200000');
    let child: ChildProcess | undefined;
    // Never answer; signal the exact child once its request has arrived.
    respond = () => child?.kill('SIGTERM');

    const { code, lines } = await runChild((c) => {
      child = c;
    });

    expect(code).toBe(1);
    expect(lines.map((l) => l.msg)).toContain('Received SIGTERM; aborting refresh');
    expect(lines.at(-1)).toMatchObject({
      msg: 'Mirror refresh failed',
      error: 'Aborted by SIGTERM',
    });
  }, 20_000);

  it('resolves partial through runRefreshSubprocess with no signal sent, and the next run resumes (#39)', async () => {
    const budget = RESERVE_MS + 1500;
    vi.stubEnv('ARXIV_MIRROR_REFRESH_TIMEOUT_MS', String(budget));
    respond = endless(200);
    const log = makeLog();

    const outcome = (await runRefreshSubprocess({ timeoutMs: budget, log })) as Extract<
      RefreshOutcome,
      { outcome: 'partial' }
    >;

    expect(outcome.outcome).toBe('partial');
    expect(log.notice).toHaveBeenCalledWith(
      'Mirror refresh stopped at its deadline; the next run resumes',
      expect.objectContaining({ pagesFetched: outcome.pagesFetched }),
    );
    expect(log.warning).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();

    // The next tick picks up at the saved token and drains.
    const resumeAt = requests.length;
    respond = (n, res) => res.end(pageBody(n, true));
    const next = await runRefreshSubprocess({ timeoutMs: budget, log });
    expect(requests[resumeAt]?.searchParams.get('resumptionToken')).toBe(
      `tok-${outcome.pagesFetched}`,
    );
    expect(next).toMatchObject({ outcome: 'drained', pagesFetched: 1 });
  }, 30_000);

  it('rejects after SIGTERM at the budget when the child overruns it (#31, #39)', async () => {
    // A budget shorter than one page: the child cannot stop itself in time.
    vi.stubEnv('ARXIV_MIRROR_REFRESH_TIMEOUT_MS', '800');
    respond = () => {};
    const log = makeLog();

    await expect(runRefreshSubprocess({ timeoutMs: 800, log })).rejects.toThrow(
      /terminated on timeout after 800ms/,
    );
    expect(log.warning).toHaveBeenCalledWith('Mirror refresh exceeded timeout; sending SIGTERM', {
      timeoutMs: 800,
    });
  }, 20_000);
});
