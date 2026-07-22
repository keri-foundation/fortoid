/**
 * View contract for Fortweb UI components.
 *
 * Every component follows the render/bind/destroy pattern:
 *   - render(props) returns an HTML string
 *   - bind(root, props) attaches event listeners and returns a cleanup function
 *   - destroy() is called implicitly by the cleanup function
 */
/**
 * Define a reusable view from a render/bind spec.
 *
 * @example
 * const MyCard = defineView({
 *     render({ title, body }) {
 *         return `<div class="card"><h2>${title}</h2><p>${body}</p></div>`;
 *     },
 *     bind(root, { onAction }) {
 *         const btn = root.querySelector("[data-action]");
 *         const handler = () => onAction?.();
 *         btn?.addEventListener("click", handler);
 *         return () => btn?.removeEventListener("click", handler);
 *     },
 * });
 *
 * const cleanup = MyCard.mount(container, { title: "Hi", body: "..." });
 * // later: cleanup();
 */
export function defineView(spec) {
    return {
        mount(root, props) {
            root.innerHTML = spec.render(props);
            const cleanup = spec.bind?.(root, props) ?? null;
            return () => {
                cleanup?.();
            };
        },
    };
}
/**
 * Mount a view into a container, replacing any existing content.
 * Returns a cleanup function.
 */
export function mountView(container, view, props) {
    return view.mount(container, props);
}
