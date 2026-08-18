'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * `useLayoutEffect` on the server is a no-op React warns about. There is
 * nothing to measure there anyway, so fall back to `useEffect`.
 */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Windowing for the card grids.
 *
 * A master-set goal is 400-plus slots, and every slot is an image, a button and
 * a caption. Rendering all of them costs more than a phone can spend: the
 * browser lays out thousands of nodes before the first card appears, and every
 * optimistic ownership toggle asks React to reconcile the lot.
 *
 * So the grid renders the rows near the viewport and nothing else, with the
 * space above and below held open by padding on the grid container itself.
 * Padding rather than spacer elements, because a spacer inside a CSS grid is a
 * grid item — it would take a cell and shift every card after it.
 *
 * Two things are deliberately measured rather than configured:
 *
 *   - the column count comes from the container's computed
 *     `grid-template-columns`, so the responsive breakpoints stay in CSS where
 *     they belong and this hook never has to know what they are;
 *   - the row height comes from the first rendered tile, so changing a card's
 *     caption or aspect ratio does not silently desynchronise the scrollbar.
 *
 * Before hydration — and if measurement ever fails — the hook reports a fixed
 * opening window, so the server-rendered markup is a real, usable grid rather
 * than an empty box.
 */

/** Rows rendered above and below the viewport, to cover fast scrolls. */
const OVERSCAN = 4;

/** Rows in the server-rendered markup, before anything has been measured. */
const SSR_ROWS = 8;

/**
 * Columns assumed until the container has been measured. The narrow layout is
 * the safe guess: it renders a genuine three-screen opening view on a phone,
 * and on a wide screen hydration widens it within the same frame.
 */
const ASSUMED_COLUMNS = 3;

export interface Windowed {
  /** First item index to render. */
  start: number;
  /** Exclusive end index. */
  end: number;
  /** Style to spread onto the grid container. */
  style: { paddingTop: number; paddingBottom: number };
  /** Columns currently laid out, once measured. */
  columns: number;
}

export function useWindowedGrid(
  ref: RefObject<HTMLElement | null>,
  count: number,
  /** Reset the window to the top when this changes — a new filter or sort. */
  resetKey?: unknown,
): Windowed {
  const [columns, setColumns] = useState(ASSUMED_COLUMNS);
  const [rowHeight, setRowHeight] = useState(0);
  const [range, setRange] = useState({ start: 0, end: SSR_ROWS * ASSUMED_COLUMNS });
  const metrics = useRef({ columns: ASSUMED_COLUMNS, rowHeight: 0 });

  /** Read the layout back out of the DOM rather than restating it here. */
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const cols = getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length || 1;
    const first = el.firstElementChild as HTMLElement | null;
    const gap = parseFloat(getComputedStyle(el).rowGap) || 0;
    const h = first ? first.getBoundingClientRect().height + gap : 0;
    if (cols !== metrics.current.columns || Math.abs(h - metrics.current.rowHeight) > 0.5) {
      metrics.current = { columns: cols, rowHeight: h };
      setColumns(cols);
      setRowHeight(h);
    }
  }, [ref]);

  const recompute = useCallback(() => {
    const el = ref.current;
    const { columns: cols, rowHeight: h } = metrics.current;
    if (!el || h <= 0) return;
    const rows = Math.ceil(count / cols);
    // The container's own top edge, in document coordinates. Padding lives
    // inside the border box, so this stays put as the window moves.
    const top = el.getBoundingClientRect().top + window.scrollY;
    const firstRow = Math.floor((window.scrollY - top) / h);
    const visibleRows = Math.ceil(window.innerHeight / h);
    const startRow = Math.max(0, Math.min(rows, firstRow - OVERSCAN));
    const endRow = Math.max(startRow, Math.min(rows, firstRow + visibleRows + OVERSCAN));
    setRange((prev) => {
      const next = { start: startRow * cols, end: Math.min(count, endRow * cols) };
      return prev.start === next.start && prev.end === next.end ? prev : next;
    });
  }, [ref, count]);

  // Measure as soon as there is something to measure, and again whenever the
  // element resizes — an orientation change, or a desktop window being dragged
  // narrower, both change the column count.
  useIsomorphicLayoutEffect(() => {
    measure();
    recompute();
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      measure();
      recompute();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, recompute, ref]);

  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        recompute();
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [recompute]);

  // A filter or sort change replaces the list under the window. Recomputing
  // from the current scroll position keeps the user where they were on the
  // page rather than teleporting them.
  useEffect(() => {
    recompute();
  }, [resetKey, count, recompute]);

  if (rowHeight <= 0) {
    // Nothing measured yet: render an opening screenful and no padding, so the
    // markup is correct with JavaScript disabled and correct after hydration.
    return {
      start: 0,
      end: Math.min(count, SSR_ROWS * columns),
      style: { paddingTop: 0, paddingBottom: 0 },
      columns,
    };
  }

  const rows = Math.ceil(count / columns);
  const startRow = Math.floor(range.start / columns);
  const endRow = Math.ceil(Math.min(count, range.end) / columns);
  return {
    start: range.start,
    end: Math.min(count, range.end),
    style: {
      paddingTop: startRow * rowHeight,
      paddingBottom: Math.max(0, (rows - endRow) * rowHeight),
    },
    columns,
  };
}
