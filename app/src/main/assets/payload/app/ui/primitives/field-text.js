import { escapeHtml } from "../../shared/dom.js";
export function fieldTextHtml(props) {
    const { id, label, value = "", type = "text", placeholder = "", hint = "", error = "", required = false, disabled = false, autocomplete = "off", className = "", } = props;
    const hasError = Boolean(error);
    const wrapperClass = ["field", hasError ? "field--error" : "", className].filter(Boolean).join(" ");
    const describedBy = hasError ? `${id}-error` : hint ? `${id}-hint` : "";
    const inputAttrs = [
        `id="${escapeHtml(id)}"`,
        `type="${type}"`,
        `name="${escapeHtml(id)}"`,
        `value="${escapeHtml(value)}"`,
        placeholder ? `placeholder="${escapeHtml(placeholder)}"` : "",
        required ? "required" : "",
        disabled ? "disabled" : "",
        `autocomplete="${autocomplete}"`,
        describedBy ? `aria-describedby="${describedBy}"` : "",
        hasError ? 'aria-invalid="true"' : "",
    ].filter(Boolean).join(" ");
    const feedbackHtml = hasError
        ? `<p id="${id}-error" class="field__error" role="alert">${escapeHtml(error)}</p>`
        : hint
            ? `<p id="${id}-hint" class="field__hint">${escapeHtml(hint)}</p>`
            : "";
    return `
        <div class="${wrapperClass}">
            <label for="${escapeHtml(id)}">${escapeHtml(label)}</label>
            <input ${inputAttrs}>
            ${feedbackHtml}
        </div>
    `;
}
