import { escapeHtml } from "../../shared/dom.js";
export function badgeHtml(props) {
    const { label, tone = "neutral", className = "" } = props;
    const classes = ["badge", `badge--${tone}`, className].filter(Boolean).join(" ");
    return `<span class="${classes}">${escapeHtml(label)}</span>`;
}
