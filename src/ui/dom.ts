// DOM helpers. Text from the disc or the player (names, strings, typed answers) only ever reaches the page through
// textContent or text nodes: nothing in the UI assigns innerHTML.

export function $<T extends HTMLElement = HTMLElement>(sel: string): T {
  const e = document.querySelector<T>(sel);
  if (!e) throw new Error(`missing element ${sel}`);
  return e;
}

type Child = Node | string | null | undefined | false;

/** Creates an element: el('button', { className: 'sbtn', onclick }, 'Save', child...). Strings become text nodes. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & Record<string, unknown> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('aria-') || k.startsWith('data-')) e.setAttribute(k, String(v));
    else (e as unknown as Record<string, unknown>)[k] = v;
  }
  for (const k of kids) if (k != null && k !== false) e.append(k);
  return e;
}

export function clear(e: Element): void { e.replaceChildren(); }

/** Release the mouse (any UI that needs a cursor). */
export const releasePointer = (): void => { document.exitPointerLock?.(); };
