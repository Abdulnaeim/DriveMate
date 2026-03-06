let capturedRequests = {};
let pollingTimers = {};
let autoPopupCount = {};
let extensionEnabled = false;
const pendingTabs = new Set();

chrome.storage.local.get(['extensionEnabled'], (result) => {
    extensionEnabled = result.extensionEnabled || false;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "setEnabled") {
        extensionEnabled = message.enabled;

        if (message.enabled) {
            chrome.tabs.get(message.tabId, (tab) => {
                if (chrome.runtime.lastError || !tab) {
                    sendResponse({ success: false });
                    return;
                }
                if (tab.url?.includes("drive.google.com")) {
                    startAutoCaptureForTab(message.tabId);
                    pendingTabs.add(message.tabId);
                }
                sendResponse({ success: true });
            });
            return true;
        } else {
            capturedRequests = {};
            autoPopupCount = {};
            pendingTabs.clear();

            Object.keys(pollingTimers).forEach(tabId => {
                cleanupTabResources(Number(tabId));
            });
            sendResponse({ success: true });
        }
        return true;
    }
    if (message.type === "getRequests") {
        sendResponse({ requests: capturedRequests });
    }
});

function cleanupTabResources(tabId) {
    if (pollingTimers[tabId]) {
        clearInterval(pollingTimers[tabId]);
        delete pollingTimers[tabId];
    }
    const debuggee = { tabId: tabId };
    chrome.debugger.detach(debuggee, () => {
        if (chrome.runtime.lastError) return;

        Object.keys(capturedRequests).forEach(requestId => {
            if (capturedRequests[requestId].tabId === tabId) {
                delete capturedRequests[requestId];
            }
        });
        delete autoPopupCount[tabId];
    });
    pendingTabs.delete(tabId);
}

function startAutoCaptureForTab(tabId) {
    cleanupTabResources(tabId);

    const debuggee = { tabId: tabId };
    chrome.debugger.attach(debuggee, "1.3", () => {
        if (chrome.runtime.lastError) return;

        chrome.debugger.sendCommand(debuggee, "Network.enable", {}, () => {
            pollingTimers[tabId] = setInterval(() => {
                let validRequests = [];
                for (const requestId in capturedRequests) {
                    const req = capturedRequests[requestId];
                    if (req.tabId === tabId && req.lastItagUrl && req.videoTitle) {
                        validRequests.push(req);
                    }
                }

                let currentCount = validRequests.length;
                if (!autoPopupCount[tabId]) autoPopupCount[tabId] = 0;

                if (currentCount > autoPopupCount[tabId]) {
                    autoPopupCount[tabId] = currentCount;
                    chrome.windows.getLastFocused({ populate: false }, (window) => {
                        if (window && window.type === 'normal') {
                            try {
                                chrome.action.openPopup();
                            } catch (e) {
                            }
                        }
                    });
                }
            }, 1000);
        });
    });
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete" && tab.url?.startsWith("https://drive.google.com/")) {
        if (extensionEnabled || pendingTabs.has(tabId)) {
            if (!pollingTimers[tabId]) {
                startAutoCaptureForTab(tabId);
            }
            pendingTabs.delete(tabId);
        }
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    cleanupTabResources(tabId);
});

chrome.debugger.onEvent.addListener((debuggeeId, method, params) => {
    const tabId = debuggeeId.tabId;
    if (!extensionEnabled && !pendingTabs.has(tabId)) return;

    if (method === "Network.requestWillBeSent") {
        // Google sometimes serves the video metadata from various clients servers
        // (clients2, clients4, etc.).  Matching on the base host was too narrow –
        // we only captured `clients6` which meant requests from other regions were
        // ignored.  We also widen the filter to any request containing
        // "workspacevideo" and treat XHR/Fetch traffic as potential candidates.
        const url = params.request.url || "";
        const isWorkspaceVideo = /https:\/\/workspacevideo(?:-pa)?\.clients\d+\.google\.com/.test(url) || url.includes("workspacevideo");
        const isXHR = params.type === "XHR" || params.type === "Fetch";
        if (isWorkspaceVideo || isXHR) {
            const requestId = params.requestId;
            capturedRequests[requestId] = {
                url: url,
                method: params.request.method,
                timestamp: params.timestamp,
                tabId: tabId
            };
            // debug log to help diagnose missing streams
            console.log("capturing request", requestId, url, "type", params.type);
        }
    } else if (method === "Network.responseReceived") {
        const requestId = params.requestId;
        if (capturedRequests[requestId]) {
            chrome.debugger.sendCommand(
                { tabId: tabId },
                "Network.getResponseBody",
                { requestId: requestId },
                (result) => {
                    if (chrome.runtime.lastError) return;
                    capturedRequests[requestId].responseBody = result.body;
                    capturedRequests[requestId].base64Encoded = result.base64Encoded;
                    try {
                        let body = result.body;
                        if (result.base64Encoded) {
                            body = atob(body);
                        }
                        const data = JSON.parse(body);

                        // try known structured locations
                        let transcodes = null;
                        if (data.mediaStreamingData?.formatStreamingData?.progressiveTranscodes && data.mediaStreamingData.formatStreamingData.progressiveTranscodes.length > 0) {
                            transcodes = data.mediaStreamingData.formatStreamingData.progressiveTranscodes;
                        } else if (data.mediaStreamingData?.formatStreamingData?.adaptiveFormats && data.mediaStreamingData.formatStreamingData.adaptiveFormats.length > 0) {
                            transcodes = data.mediaStreamingData.formatStreamingData.adaptiveFormats;
                        }
                        if (transcodes) {
                            capturedRequests[requestId].lastItagUrl = transcodes[transcodes.length - 1]?.url;
                        }

                        // fallback: scan for any itag-containing URL in the raw body
                        if (!capturedRequests[requestId].lastItagUrl) {
                            const regex = /https?:\\\/\\\/[^"']+itag=[0-9]+/g;
                            let match;
                            while ((match = regex.exec(body))) {
                                capturedRequests[requestId].lastItagUrl = match[0].replace(/\\\\\//g, "/");
                                break;
                            }
                        }
                        if (!capturedRequests[requestId].lastItagUrl) {
                            console.warn("no video URL extracted for request", requestId, capturedRequests[requestId].url);
                        }
                        if (data.mediaMetadata?.title) {
                            capturedRequests[requestId].videoTitle = data.mediaMetadata.title;
                        }
                    } catch (e) {
                        console.log("Failed to parse response body:", e);
                    }
                }
            );
        }
    }
});