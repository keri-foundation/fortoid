/**
 * Event delegation utilities for the Fortweb view system.
 */
/**
 * Attach a delegated click handler for elements matching a selector.
 * Returns a cleanup function that removes the listener.
 */
export function delegateClick(root, selector, handler) {
    function listener(event) {
        if (!(event.target instanceof Element)) {
            return;
        }
        const target = event.target.closest(selector);
        if (target && root.contains(target)) {
            handler(event, target);
        }
    }
    root.addEventListener("click", listener);
    return () => root.removeEventListener("click", listener);
}
/**
 * Attach multiple delegated handlers at once.
 * Returns a single cleanup function.
 */
export function delegateAll(root, selectorMap) {
    const cleanups = Object.entries(selectorMap).map(([selector, handler]) => delegateClick(root, selector, handler));
    return () => cleanups.forEach((fn) => fn());
}
