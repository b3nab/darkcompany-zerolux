import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject, UIEvent } from "react";

/**
 * A reader's place in a scrolled list, kept as everything in it changes size: at the bottom it
 * follows what comes; anywhere else the first item in view stays where it is, whatever grows
 * or shrinks above or below it. The view keeps it itself, the same in every browser, so the
 * browser's own anchoring is turned off where it is used (`[overflow-anchor:none]`).
 * With `earlier`, the items before the first come by themselves as the reader nears the top.
 */
export function useReadingPlace<List extends HTMLElement = HTMLDivElement>(
  following = true,
  earlier?: {
    /** There are items before the first. */
    more: boolean;
    /** Reads the page before; done when it is in. */
    load: () => Promise<unknown>;
  },
) {
  const scroller = useRef<HTMLDivElement>(null);
  const list = useRef<List>(null);
  const follows = useRef(following);
  // More than a screen above the latest items: a button brings the reader back down.
  const [away, setAway] = useState(false);
  // The first item in view and how far below the top of the view it starts.
  const anchor = useRef<{ item: Element; top: number }>(undefined);
  // Where the view last moved itself: a scroll to anywhere else is the reader's.
  const placed = useRef<number>(undefined);

  const mark = useCallback(() => {
    const view = scroller.current;
    const items = list.current?.children;
    if (!view || !items?.length) return;
    const top = view.getBoundingClientRect().top;
    // The items are in order: the first whose bottom is below the top of the view.
    let low = 0;
    let high = items.length - 1;
    let found: Element | undefined;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const item = items[middle]!;
      if (item.getBoundingClientRect().bottom > top) {
        found = item;
        high = middle - 1;
      } else low = middle + 1;
    }
    anchor.current = found && {
      item: found,
      top: found.getBoundingClientRect().top - top,
    };
  }, []);

  const place = (view: HTMLDivElement, to: number) => {
    view.scrollTop = to;
    placed.current = view.scrollTop;
  };

  /** After anything changed: the bottom stays in view, or the item read stays in place. */
  const settle = useCallback(() => {
    const view = scroller.current;
    if (!view) return;
    const kept = anchor.current;
    if (follows.current) place(view, view.scrollHeight);
    else if (kept?.item.isConnected) {
      const moved =
        kept.item.getBoundingClientRect().top -
        view.getBoundingClientRect().top -
        kept.top;
      if (Math.abs(moved) >= 1) place(view, view.scrollTop + moved);
    }
    mark();
  }, [mark]);

  // Content that changes size once shown (a diagram, highlighted code, a file's card), and the
  // view itself changing size (a strip of open threads, a taller draft). Observed for as long
  // as each element is shown, so one put in place of another (a panel opening beside the view)
  // is observed in its turn.
  const refs = useMemo(() => {
    const kept =
      <E extends Element>(into: RefObject<E | null>) =>
      (element: E | null) => {
        into.current = element;
        if (!element) return;
        const observer = new ResizeObserver(settle);
        observer.observe(element);
        return () => {
          observer.disconnect();
          into.current = null;
        };
      };
    return { scroller: kept(scroller), list: kept(list) };
  }, [settle]);

  // A page before is read once the top is within a screen and a half, one page at a time,
  // and again while it still is, as after a short page.
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const before = useRef(earlier);
  before.current = earlier;
  // Observing the top again says at once whether it is near.
  const look = useRef<() => void>(undefined);
  const top = useCallback((element: HTMLElement | null) => {
    if (!element) return;
    let loading = false;
    const observer = new IntersectionObserver(
      ([entry]) => {
        const wanted = before.current;
        if (!entry?.isIntersecting || !wanted?.more || loading) return;
        loading = true;
        setLoadingEarlier(true);
        const done = () => {
          loading = false;
          setLoadingEarlier(false);
        };
        wanted.load().then(
          () => {
            done();
            look.current?.();
          },
          // Not now: tried again as the reader comes back near the top.
          done,
        );
      },
      { root: element.parentElement, rootMargin: "150% 0px 0px 0px" },
    );
    look.current = () => {
      observer.unobserve(element);
      observer.observe(element);
    };
    observer.observe(element);
    return () => {
      look.current = undefined;
      observer.disconnect();
    };
  }, []);
  // There are earlier items now, as once the first page is in: the top may be near already.
  const more = !!earlier?.more;
  useEffect(() => {
    if (more) look.current?.();
  }, [more]);

  const onScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      const view = event.currentTarget;
      // The view moving itself is not the reader moving.
      const own =
        placed.current !== undefined &&
        Math.abs(view.scrollTop - placed.current) < 1;
      placed.current = undefined;
      const below = view.scrollHeight - view.scrollTop - view.clientHeight;
      if (!own) follows.current = below < 4;
      setAway(below > view.clientHeight);
      mark();
    },
    [mark],
  );

  return {
    ...refs,
    /** The scrolled view, to find what is in it. */
    view: scroller,
    /** Where the scrolled view starts, before the list: earlier items come as it nears. */
    top,
    /** A page before is being read. */
    loadingEarlier,
    away,
    settle,
    onScroll,
    /** From now on the bottom is followed, as after sending. */
    follow: () => {
      follows.current = true;
    },
    /** Stops following, as when the view opens at a point of its own. */
    stay: () => {
      follows.current = false;
    },
    /** Back to the latest items, and following them. */
    toLatest: () => {
      follows.current = true;
      scroller.current?.scrollTo({
        top: scroller.current.scrollHeight,
        behavior: "smooth",
      });
    },
  };
}
