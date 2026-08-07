// Worker probe: responds to "ping" with structured pong.
self.onmessage = function (e) {
    if (e.data === "ping") {
        self.postMessage({
            type: "pong",
            origin: self.location.origin,
            isSecureContext: self.isSecureContext || false
        });
    }
};
