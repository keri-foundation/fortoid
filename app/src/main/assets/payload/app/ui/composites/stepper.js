import { escapeHtml } from "../../shared/dom.js";
export function stepperHtml(props) {
    const { steps, currentStepId, compact = false, className = "" } = props;
    const classes = [
        "ui-stepper",
        compact ? "ui-stepper--compact" : "",
        className,
    ].filter(Boolean).join(" ");
    const currentIndex = steps.findIndex((step) => step.id === currentStepId);
    const stepsHtml = steps.map((step, index) => {
        const isCurrent = step.id === currentStepId;
        const isCompleted = index < currentIndex;
        const status = isCurrent ? "active" : isCompleted ? "completed" : "pending";
        const stepNum = index + 1;
        return `
            <li class="ui-stepper__step ui-stepper__step--${status}"
                ${isCurrent ? 'aria-current="step"' : ""}>
                <span class="ui-stepper__indicator">${isCompleted ? "&#10003;" : stepNum}</span>
                ${compact ? "" : `<span class="ui-stepper__label">${escapeHtml(step.label)}</span>`}
            </li>
            ${index < steps.length - 1 ? '<li class="ui-stepper__connector" aria-hidden="true"></li>' : ""}
        `;
    }).join("");
    return `
        <ol class="${classes}" role="list" aria-label="Progress">
            ${stepsHtml}
        </ol>
    `;
}
