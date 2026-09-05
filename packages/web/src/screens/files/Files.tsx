import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../api/client.js';
import { Link } from '../../shell/Link.js';
import { formatRoute, type FileFilters } from '../../shell/route.js';
import { FILES_NARROW, useMedia } from '../../shell/useMedia.js';
import { visibleRange } from '../../shell/virtual.js';
import { describeFailure } from '../config/library-form-model.js';
import {
  filtersToQuery,
  formatBytes,
  formatUpdated,
  sortRows,
  toFileRows,
  type ApiFile,
  type FileRow,
  type SortColumn,
} from './files-model.js';

/**
 * How tall one row is, at each of the two shapes `styles.css` gives it.
 *
 * WINDOWING NEEDS AN EXACT NUMBER, not an approximate one: it drives both
 * spacer divs and the index the scroll position maps to, so a row height
 * that is wrong by 3x makes the scrollbar wrong by 3x over 4,625 rows and
 * skips rows as you drag. Wide, `.file-row` is a five-column grid one line
 * tall. Below `48rem` the sheet turns it into a stacked card — six lines,
 * each with its own `::before` label — and the sheet pins that card to an
 * EXACT `height` (not a `min-height`) precisely so this constant can be
 * exact too; the name is ellipsised on one line there for the same reason.
 *
 * The alternative considered and rejected: dropping windowing below `48rem`.
 * The list is not short there — it is the same 4,625 rows — and the phone is
 * the device least able to hold 4,625 rows of six elements each in the DOM.
 */
const ROW_HEIGHT_PX = 36;
const NARROW_ROW_HEIGHT_PX = 152;
const PAGE_SIZE = 200;

// `ALL_STATES` lives in `@trawlarr/server`, which this package does not (and
// should not) depend on — the daemon's process boundary is the point. This
// is the same seven values, hand-carried the way the server's own list is
// hand-maintained against the `FileState` union.
const STATES = ['unknown', 'queued', 'running', 'good', 'failed', 'not_converging', 'held'];

/**
 * A file row's own line: whole-row a `<Link>` so the row itself is what is
 * clickable, keyboard-focusable and middle-click-able — see `shell/Link.tsx`
 * for why that matters more than it looks like it should.
 */
const FileRowLine = (props: {
  row: FileRow;
  filters: FileFilters;
  navigate: (to: string) => void;
}): JSX.Element => {
  const { row } = props;
  return (
    <Link
      // The filters travel WITH the click. A file detail route carries them
      // (see `route.ts`) so the list mounted behind the panel is this list,
      // and the panel's back-link returns to this view rather than to a bare
      // `/files`.
      to={formatRoute({ name: 'file', id: row.id, filters: props.filters })}
      navigate={props.navigate}
      className={`file-row file-row-state-${row.state}`}
    >
      <span className="file-name" title={row.path}>
        {row.name}
      </span>
      <span className="file-state">{row.state}</span>
      <span className="file-codec">{row.video}</span>
      <span className="file-codec">{row.audio}</span>
      <span className="file-size">{formatBytes(row.sizeBytes)}</span>
      <span className="file-updated">{formatUpdated(row.updatedAt)}</span>
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

  // Controlled, and resynchronised whenever `filters` changes from OUTSIDE
  // this form — Clear filters, browser back/forward, or a pasted URL. An
  // uncontrolled `defaultValue` only reads its initial prop; since `Files`
  // is never remounted on a route change (no `key` in `App.tsx`), that left
  // these two inputs showing stale text after such a change while the URL
  // and the fetched rows were already correct — and clicking Apply again
  // would silently resubmit the stale value. `state` never had this bug
  // because its `<select>` was controlled from the start; these now match.
  const [libraryDraft, setLibraryDraft] = useState(filters.library ?? '');
  const [qDraft, setQDraft] = useState(filters.q ?? '');
  useEffect(() => {
    setLibraryDraft(filters.library ?? '');
  }, [filters.library]);
  useEffect(() => {
    setQDraft(filters.q ?? '');
  }, [filters.q]);

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

  const rowHeight = useMedia(FILES_NARROW) ? NARROW_ROW_HEIGHT_PX : ROW_HEIGHT_PX;
  const sorted = sortRows(rows, sort.column, sort.direction);
  const range = visibleRange({
    scrollTop,
    viewportHeight,
    rowHeight,
    count: sorted.length,
    overscan: 6,
  });
  const windowed = sorted.slice(range.start, range.end);

  const good = rows.filter((row) => row.state === 'good').length;
  const sumBytes = rows.reduce((sum, row) => sum + row.sizeBytes, 0);
  // Floored, and 100 reserved for an exact match — the same rule
  // `watch-model.ts` uses for a library card's percentage, so this
  // number and that one never disagree over a rounding rule.
  //
  // THE DENOMINATOR IS WHAT HAS ARRIVED, not the server's `total`. This set
  // is paged in, and dividing a partial `good` by the full total made the
  // figure start near 0 and climb to the truth only as the last page landed
  // — a convergence number that is wrong for the twenty seconds an operator
  // is most likely to be reading it. Over the loaded rows it is a real
  // sample from the first row onward, and the footer already says it is
  // still loading.
  const counted = rows.length;
  const percent = counted === 0 ? 0 : good === counted ? 100 : Math.floor((good / counted) * 100);

  const hasFilters = filters.library !== null || filters.state !== null || filters.q !== null;

  const filterForm = (
    <form
      className="files-filters"
      onSubmit={(event) => {
        event.preventDefault();
        const library = libraryDraft.trim();
        const q = qDraft.trim();
        setFilters({
          library: library === '' ? null : library,
          state: filters.state,
          q: q === '' ? null : q,
        });
      }}
    >
      <label>
        Library ID
        <input
          name="library"
          type="text"
          value={libraryDraft}
          onChange={(event) => {
            setLibraryDraft(event.currentTarget.value);
          }}
        />
      </label>
      <label>
        Search
        <input
          name="q"
          type="text"
          value={qDraft}
          onChange={(event) => {
            setQDraft(event.currentTarget.value);
          }}
          placeholder="path contains…"
        />
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

  const sortButton = (column: SortColumn, label: string): JSX.Element => {
    const active = sort.column === column;
    return (
      <button
        type="button"
        className={`file-head-sort file-head-${column}`}
        aria-current={active ? 'true' : undefined}
        onClick={() => {
          setSort({
            column,
            direction: active && sort.direction === 'asc' ? 'desc' : 'asc',
          });
        }}
      >
        {label}
        {active ? (sort.direction === 'asc' ? ' ▲' : ' ▼') : ''}
      </button>
    );
  };

  /**
   * The column headers, which are also the sort control.
   *
   * They used to be a row of four chips floating above the table with
   * nothing tying them to the columns they sorted, and the two codec
   * columns were unlabelled entirely — the operator had to infer from the
   * values which of `hevc` and `eac3` was video.
   *
   * OUTSIDE THE SCROLL CONTAINER, deliberately. `.file-scroll` has a fixed
   * height that `attachContainer` measures to drive the windowing maths; a
   * sticky header inside it would overlay the first rows while still
   * counting toward that measurement, and the window would be short by a
   * row. Above it, sharing the same grid template, the two line up and the
   * virtualisation never learns it exists. `scrollbar-gutter: stable` on
   * the container is what keeps the columns aligned once a scrollbar
   * appears.
   *
   * Below 48rem the sheet turns this back into a wrapped row of chips,
   * because the rows themselves stop being a grid there.
   */
  const columnHeader = (
    <div className="file-head" role="group" aria-label="Sort files">
      {sortButton('name', 'Name')}
      {sortButton('state', 'State')}
      <span className="file-head-static">Video</span>
      <span className="file-head-static">Audio</span>
      {sortButton('size', 'Size')}
      {sortButton('updated', 'Updated')}
    </div>
  );

  return (
    <div className="files">
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
          {columnHeader}
          <div
            className="file-scroll"
            ref={attachContainer}
            onScroll={(event) => {
              setScrollTop(event.currentTarget.scrollTop);
            }}
          >
            <div style={{ height: `${String(range.start * rowHeight)}px` }} />
            {windowed.map((row) => (
              <FileRowLine key={row.id} row={row} filters={filters} navigate={navigate} />
            ))}
            <div style={{ height: `${String((sorted.length - range.end) * rowHeight)}px` }} />
          </div>
          {/* Labelled fields rather than three values strung together with
              middle dots: "4,625 · 8.2 TB · 63%" needs the reader to work
              out what each number counts, and the percentage in particular
              is meaningless without the word beside it. */}
          <dl className="files-footer">
            <div>
              <dt>Files</dt>
              <dd>{String(total)}</dd>
            </div>
            <div>
              <dt>Total size</dt>
              <dd>{formatBytes(sumBytes)}</dd>
            </div>
            <div>
              <dt>Converged</dt>
              <dd>{String(percent)}%</dd>
            </div>
            {loadingMore && (
              <div className="files-footer-loading">
                <dt>Loading</dt>
                <dd>still fetching pages…</dd>
              </div>
            )}
          </dl>
        </>
      )}
    </div>
  );
};
