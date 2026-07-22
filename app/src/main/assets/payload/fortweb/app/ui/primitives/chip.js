import { escapeHtml } from "../../shared/dom.js";
export function chipHtml(props) {
    const { label, tone = "neutral", selected = false, dataValue = "", className = "", } = props;
    const classes = [
        "ui-chip",
        `ui-chip--${tone}`,
        selected ? "is-active" : "",
        className,
    ].filter(Boolean).join(" ");
    const attrs = [
        `class="${classes}"`,
        'type="button"',
        dataValue ? `data-value="${escapeHtml(dataValue)}"` : "",
        selected ? 'aria-pressed="true"' : 'aria-pressed="false"',
    ].filter(Boolean).join(" ");
    return `<button ${attrs}>${escapeHtml(label)}</button>`;
}
