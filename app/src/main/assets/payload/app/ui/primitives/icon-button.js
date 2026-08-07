import { escapeHtml } from "../../shared/dom.js";
/**
 * Render an icon-only button with required accessible label.
 */
export function iconButtonHtml(props) {
    const { ariaLabel, iconSrc, dataAction = "", disabled = false, className = "", } = props;
    const classes = ["icon-button", className].filter(Boolean).join(" ");
    const attrs = [
        `type="button"`,
        `class="${classes}"`,
        `aria-label="${escapeHtml(ariaLabel)}"`,
        disabled ? "disabled" : "",
        dataAction ? `data-action="${escapeHtml(dataAction)}"` : "",
    ].filter(Boolean).join(" ");
    return `<button ${attrs}><img src="${escapeHtml(iconSrc)}" alt="" width="20" height="20"></button>`;
}
