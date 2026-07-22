const NATIVE_BRIDGE_HANDLER_NAME = "bridge";
function createNativeBridgeAdapter() {
    if (typeof window !== "undefined") {
        const webkitBridge = window.webkit?.messageHandlers?.[NATIVE_BRIDGE_HANDLER_NAME];
        if (webkitBridge && typeof webkitBridge.postMessage === "function") {
            return {
                postMessage(payload) {
                    webkitBridge.postMessage(payload);
                },
            };
        }
        const androidBridge = window.bridge;
        if (androidBridge && typeof androidBridge.postMessage === "function") {
            return {
                postMessage(payload) {
                    androidBridge.postMessage(JSON.stringify(payload));
                },
            };
        }
    }
    return {
        postMessage() { },
    };
}
const nativeBridge = createNativeBridgeAdapter();
function isoNow() {
    return new Date().toISOString();
}
function formatDiagnosticValue(value) {
    if (typeof value === "string") {
        return JSON.stringify(value);
    }
    return String(value);
}
export function formatDiagnosticMessage(event, fields = {}) {
    const parts = Object.entries(fields)
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .map(([key, value]) => `${key}=${formatDiagnosticValue(value)}`);
    if (parts.length === 0) {
        return `[fortweb.runtime] event=${event}`;
    }
    return `[fortweb.runtime] event=${event} ${parts.join(" ")}`;
}
export function postToNativeBridge(payload) {
    try {
        nativeBridge.postMessage(payload);
    }
    catch { }
}
export function postLog(event, fields = {}) {
    postToNativeBridge({
        type: "log",
        timestamp: isoNow(),
        message: formatDiagnosticMessage(event, fields),
    });
}
export function postLifecycle(state, fields = {}) {
    postToNativeBridge({
        type: "lifecycle",
        timestamp: isoNow(),
        message: formatDiagnosticMessage("worker_lifecycle", { state, ...fields }),
    });
}
export function postError(errorType, message, fields = {}) {
    const fieldSuffix = Object.keys(fields).length > 0
        ? " " + Object.entries(fields)
            .filter(([, value]) => value !== undefined && value !== null && value !== "")
            .map(([key, value]) => `${key}=${formatDiagnosticValue(value)}`)
            .join(" ")
        : "";
    postToNativeBridge({
        type: errorType,
        timestamp: isoNow(),
        message: `${message}${fieldSuffix}`,
    });
}
