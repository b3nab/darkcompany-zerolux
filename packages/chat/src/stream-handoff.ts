import type { LiveItem, LiveChange } from "./live";
import type { SessionEvent } from "./session-events";

/** What this view has actually seen. End-of-stream is not acknowledgement by the record. */
export class StreamHandoff {
  private items = new Map<string, { item: LiveItem; after: number }>();
  private matched = new Set<string>();
  private consumed = new Map<number, Set<number>>();
  private next = 0;
  change(c: LiveChange) {
    if (c.type === "clear") {
      this.matched.clear();
      return;
    }
    if (c.type === "done") {
      this.matched.delete(c.item);
      return;
    }
    if ((c.type !== "append" && c.type !== "set") || this.matched.has(c.item))
      return;
    const old = this.items.get(c.item);
    this.items.set(c.item, {
      after: old?.after ?? this.next,
      item: {
        id: c.item,
        kind: c.kind,
        text: c.type === "append" ? (old?.item.text ?? "") + c.text : c.text,
      },
    });
  }
  snapshot(items: LiveItem[]) {
    for (const item of items)
      this.change({
        type: "set",
        item: item.id,
        kind: item.kind,
        text: item.text,
      });
    const active = new Set(items.map((i) => i.id));
    for (const id of this.matched) if (!active.has(id)) this.matched.delete(id);
  }
  /** Pure projection: the native row and its provisional copy never draw together. */
  project(events: SessionEvent[]) {
    const rows: LiveItem[] = [];
    const accepted: [string, number, number][] = [];
    const used = new Set<string>();
    for (const { item, after } of this.items.values()) {
      let match = false;
      let place = 0,
        prev = -1;
      for (const e of events) {
        place = e.at === prev ? place + 1 : 0;
        prev = e.at;
        if (
          e.at < after ||
          this.consumed.get(e.at)?.has(place) ||
          used.has(`${e.at}:${place}`)
        )
          continue;
        const same =
          item.kind === "output"
            ? e.type === "tool_result" && e.id === item.id
            : (e.type === "text" || e.type === "thinking") &&
              e.type === item.kind &&
              item.text.trim().length > 0 &&
              e.text.trim().startsWith(item.text.trim());
        if (same) {
          accepted.push([item.id, e.at, place]);
          used.add(`${e.at}:${place}`);
          match = true;
          break;
        }
      }
      if (!match) rows.push(item);
    }
    return { rows, accepted };
  }
  observe(events: SessionEvent[], accepted: [string, number, number][]) {
    this.next = Math.max(this.next, (events.at(-1)?.at ?? -1) + 1);
    for (const [id, at, index] of accepted) {
      this.items.delete(id);
      this.matched.add(id);
      const used = this.consumed.get(at) ?? new Set();
      used.add(index);
      this.consumed.set(at, used);
    }
    let floor = this.next;
    for (const item of this.items.values()) floor = Math.min(floor, item.after);
    for (const at of this.consumed.keys())
      if (at < floor) this.consumed.delete(at);
  }
}
