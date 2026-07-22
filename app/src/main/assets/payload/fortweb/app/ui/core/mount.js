/**
 * DOM mount/unmount utilities for the Fortweb view system.
 */
/**
 * Create an element from an HTML string and append it to a parent.
 * Returns the first element child of the inserted HTML, or the parent's last element child as a fallback.
 */
export function insertHTML(parent, html, position = "beforeend") {
    const template = document.createElement("template");
    template.innerHTML = html;
    const firstChild = template.content.firstElementChild;
    if (position === "beforeend") {
        parent.append(template.content);
    }
    else if (position === "afterbegin") {
        parent.prepend(template.content);
    }
    else {
        parent.insertAdjacentHTML(position, html);
    }
    return firstChild || parent.lastElementChild;
}
/**
 * Replace all children of a container with new HTML.
 */
export function replaceContent(container, html) {
    container.innerHTML = html;
}
/**
 * Remove an element from the DOM if it exists.
 */
export function removeElement(element) {
    element?.remove();
}
