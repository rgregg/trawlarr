import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../api/client.js';
import { Link } from '../../shell/Link.js';
import { formatRoute, type FileFilters } from '../../shell/route.js';
import { visibleRange } from '../../shell/virtual.js';
import { describeFailure } from '../library-form-model.js';
import {
  filtersToQuery,
  formatBytes,
  sortRows,
  toFileRows,
  type ApiFile,
  type FileRow,
  type SortColumn,
} from './files-model.js';

/** `2.25rem` at the 16px root this sheet assumes elsewhere (see `styles.css`). */
const ROW_HEIGHT_PX = 36;
const PAGE_SIZE = 200;

// `ALL_STATES` lives in `@trawlarr/server`, which this package does not (and
// should not) depend on — the daemon's process boundary is the point. This
// is the same seven values, hand-carried the way the server's own list is
// hand-maintained against the `FileState` union.
const STATES = ['unknown', 'queued', 'running', 'good', 'failed', 'not_converging', 'held'];

const SORTS: Array<{ column: SortColumn; label: string }> = [
  { column: 'name', label: 'Name' },
  { column: 'state', label: 'State' },
  { column: 'size', label: 'Size' },
  { column: 'updated', label: 'Updated' },
];

/**
 * A file row's own line: whole-row a `<Link>` so the row itself is what is
 * clickable, keyboard-focusable and middle-click-able — see `shell/Link.tsx`
 * for why that matters more than it looks like it should.
 */
const FileRowLine = (props: { row: FileRow; navigate: (to: string) => void }): JSX.Element => {
  const { row } = props;
  return (
    <Link
      to={`/files/${row.id}`}
      navigate={props.navigate}
      className={`file-row state-${row.state}`}
    >
      <span className="file-name" title={row.path}>
        {row.name}
      </span>
      <span className="file-state">{row.state}</span>
      <span className="file-codec">{row.video}</span>
      <span className="file-codec">{row.audio}</span>
      <span className="file-size">{formatBytes(row.sizeBytes)}</span>
    </Link>
  );
};

/**
 * The Files table.
 *
 * A real library is 4,625 rows and grows; this fetches the whole filtered
 * set (in `PAGE_SIZE` pages, so no single request is enormous) and holds it
 * in memory, then renders only the rows `visibleRange` says are worth it.
 * That split — everything fetched, only a window rendered — is what makes
 * the footer's totals honest (they are not a guess from one page) while
 * keeping the DOM small enough that a phone can scroll it.
 *
 * Sort is component state, not a URL param: it is a view preference the
 * operator sets while looking, not a fact worth pasting into a message the
 * way a filter is. Filters ARE in the URL, via `route.filters`, and every
 * filter control here calls `navigate` rather than touching local state.
 */
export const Files = (props: {
  client: ApiClient;
  filters: FileFilters;
  navigate: (to: string) => void;
}): JSX.Element => {
  const { client, filters, navigate } = props;

  const [rows, setRows] = useState<FileRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failure, setFailure] = useState<ReturnType<typeof describeFailure> | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [sort, setSort] = useState<{ column: SortColumn; direction: 'asc' | 'desc' }>({
    column: 'name',
    direction: 'asc',
  });
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(480);
  const resizeObserver = useRef<{ disconnect(): void } | null>(null);

  const attachContainer = useCallback((el: { clientHeight: number } | null) => {
    resizeObserver.current?.disconnect();
    resizeObserver.current = null;
    if (el === null) return;
    setViewportHeight(el.clientHeight);
    const ctor = (
      globalThis as {
        ResizeObserver?: new (cb: () => void) => {
          observe: (t: unknown) => void;
          disconnect: () => void;
        };
      }
    ).ResizeObserver;
    if (ctor === undefined) return;
    const observer = new ctor(() => {
      setViewportHeight((el as { clientHeight: number }).clientHeight);
    });
    observer.observe(el);
    resizeObserver.current = observer;
  }, []);

  useEffect(() => () => resizeObserver.current?.disconnect(), []);

  // Every page of the filtered set, fetched in sequence and appended. The
  // effect re-runs whenever a filter changes (each is a primitive, read off
  // the URL) or `attempt` is bumped by Retry.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadingMore(false);
    setFailure(null);
    setRows([]);
    setTotal(0);
    setScrollTop(0);

    void (async () => {
      let offset = 0;
      let collected: FileRow[] = [];
      try {
        for (;;) {
          const page = await client.get<{
            total: number;
            limit: number;
            offset: number;
            items: ApiFile[];
          }>(`/files${filtersToQuery(filters, PAGE_SIZE, offset)}`);
          if (cancelled) return;
          collected = collected.concat(toFileRows(page.items));
          setRows(collected);
          setTotal(page.total);
          setLoading(false);
          offset += PAGE_SIZE;
          const done = page.items.length === 0 || offset >= page.total;
          setLoadingMore(!done);
          if (done) break;
        }
      } catch (error) {
        if (cancelled) return;
        setFailure(describeFailure(error));
        setLoading(false);
        setLoadingMore(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [client, filters.library, filters.state, filters.q, attempt]);

  const setFilters = (next: FileFilters): void => {
    navigate(formatRoute({ name: 'files', filters: next }));
  };

  const sorted = sortRows(rows, sort.column, sort.direction);
  const range = visibleRange({
    scrollTop,
    viewportHeight,
    rowHeight: ROW_HEIGHT_PX,
    count: sorted.length,
    overscan: 6,
  });
  const windowed = sorted.slice(range.start, range.end);

  const good = rows.filter((row) => row.state === 'good').length;
  const sumBytes = rows.reduce((sum, row) => sum + row.sizeBytes, 0);
  // Floored, and 100 reserved for an exact match — the same rule
  // `overview-model.ts` uses for a library card's percentage, so this
  // number and that one never disagree over a rounding rule.
  const percent = total === 0 ? 0 : good === total ? 100 : Math.floor((good / total) * 100);

  const hasFilters = filters.library !== null || filters.state !== null || filters.q !== null;

  const filterForm = (
    <form
      className="files-filters"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const q = String(data.get('q') ?? '').trim();
        const library = String(data.get('library') ?? '').trim();
        setFilters({
          library: library === '' ? null : library,
          state: filters.state,
          q: q === '' ? null : q,
        });
      }}
    >
      <label>
        Library ID
        <input name="library" type="text" defaultValue={filters.library ?? ''} />
      </label>
      <label>
        Search
        <input name="q" type="text" defaultValue={filters.q ?? ''} placeholder="path contains…" />
      </label>
      <label>
        State
        <select
          value={filters.state ?? ''}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setFilters({ ...filters, state: value === '' ? null : value });
          }}
        >
          <option value="">Any state</option>
          {STATES.map((state) => (
            <option key={state} value={state}>
              {state}
            </option>
          ))}
        </select>
      </label>
      <button type="submit">Apply</button>
      {hasFilters && (
        <Link to="/files" navigate={navigate} className="clear-filters">
          Clear filters
        </Link>
      )}
    </form>
  );

  const sortControls = (
    <div className="files-sort" role="group" aria-label="Sort files">
      {SORTS.map((entry) => {
        const active = sort.column === entry.column;
        return (
          <button
            key={entry.column}
            type="button"
            aria-current={active ? 'true' : undefined}
            onClick={() => {
              setSort({
                column: entry.column,
                direction: active && sort.direction === 'asc' ? 'desc' : 'asc',
              });
            }}
          >
            {entry.label}
            {active ? (sort.direction === 'asc' ? ' ▲' : ' ▼') : ''}
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="files">
      <h2>Files</h2>
      {filterForm}

      {failure !== null && (
        <div role="alert" className="failure">
          <strong>{failure.title}</strong>
          <p className="verbatim">{failure.message}</p>
          <button
            type="button"
            onClick={() => {
              setAttempt((n) => n + 1);
            }}
          >
            Retry
          </button>
        </div>
      )}

      {failure === null && loading && (
        <div className="files-skeleton" aria-busy="true" aria-live="polite">
          <p className="help">Loading files…</p>
          {[0, 1, 2, 3, 4, 5].map((n) => (
            <div key={n} className="skeleton-row" />
          ))}
        </div>
      )}

      {failure === null && !loading && total === 0 && (
        <div className="files-empty">
          <p>No files match these filters.</p>
          {hasFilters && (
            <Link to="/files" navigate={navigate}>
              Clear filters
            </Link>
          )}
        </div>
      )}

      {failure === null && !loading && total > 0 && (
        <>
          {sortControls}
          <div
            className="file-scroll"
            ref={attachContainer}
            onScroll={(event) => {
              setScrollTop(event.currentTarget.scrollTop);
            }}
          >
            <div style={{ height: `${String(range.start * ROW_HEIGHT_PX)}px` }} />
            {windowed.map((row) => (
              <FileRowLine key={row.id} row={row} navigate={navigate} />
            ))}
            <div style={{ height: `${String((sorted.length - range.end) * ROW_HEIGHT_PX)}px` }} />
          </div>
          <p className="files-footer">
            {String(total)} files · {formatBytes(sumBytes)} · {String(percent)}% converged
            {loadingMore ? ' (still loading…)' : ''}
          </p>
        </>
      )}
    </div>
  );
};
