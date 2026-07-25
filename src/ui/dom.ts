/** Minimal DOM helpers — enough structure to keep the views readable. */

type Attrs = Record<string, string | number | boolean | undefined | null>
type Child = Node | string | null | undefined | false

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = String(value)
    else if (key === 'text') node.textContent = String(value)
    else node.setAttribute(key, value === true ? '' : String(value))
  }
  append(node, children)
  return node
}

export function append(parent: Node, children: Child[]) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
  }
}

export function clear(node: Element) {
  node.replaceChildren()
}

/**
 * Keyed reconciler for a row of cards.
 *
 * Reusing nodes by key matters here: it keeps CSS transitions and the entry
 * animation from replaying on every state update, so a card only animates when
 * it actually arrives.
 */
export function syncKeyed(
  container: HTMLElement,
  keys: readonly string[],
  create: (key: string, index: number) => HTMLElement,
  update?: (node: HTMLElement, key: string, index: number) => void,
) {
  const existing = new Map<string, HTMLElement>()
  for (const child of Array.from(container.children)) {
    const key = (child as HTMLElement).dataset['key']
    if (key !== undefined) existing.set(key, child as HTMLElement)
  }

  const wanted = new Set(keys)
  for (const [key, node] of existing) {
    if (!wanted.has(key)) node.remove()
  }

  keys.forEach((key, index) => {
    let node = existing.get(key)
    if (!node) {
      node = create(key, index)
      node.dataset['key'] = key
    }
    update?.(node, key, index)
    // appendChild on an existing child moves it, which keeps order correct
    // without tearing down and rebuilding the row.
    if (container.children[index] !== node) {
      container.insertBefore(node, container.children[index] ?? null)
    }
  })
}
