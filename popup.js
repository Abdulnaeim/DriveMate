document.addEventListener("DOMContentLoaded", () => {
    const header = document.querySelector(".header");
    const notDriveMessage = document.getElementById("notDriveMessage");
    const downloadContainer = document.getElementById("downloadContainer");
    const statusMessage = document.getElementById("statusMessage");
    const btnOn = document.getElementById("btnOn");
    const btnOff = document.getElementById("btnOff");
    const reloadBtn = document.querySelector(".reload-btn");

    function updateUI(isEnabled) {
        btnOn.disabled = isEnabled;
        btnOff.disabled = !isEnabled;
        reloadBtn.classList.toggle("active", isEnabled);// always show unless error
        btnOn.classList.remove("hidden");
        btnOff.classList.remove("hidden");
        if (!isEnabled) {
            statusMessage.classList.remove("error");
            setTimeout(() => {
                statusMessage.textContent = "Click ON to start the extension.";
            }, 2000);
        }

    }

    function handleStateChange(newState) {
        chrome.storage.local.set({ extensionEnabled: newState }, () => {
            updateUI(newState);

            if (!newState) {
                downloadContainer.innerHTML = "";
                statusMessage.textContent = "Extension stopped.";
                statusMessage.classList.remove("error");
                setTimeout(() => {
                    statusMessage.textContent = "Click ON to start the extension.";
                }, 2000);
            }

            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                const tab = tabs[0];
                if (!tab) return;

                chrome.runtime.sendMessage(
                    {
                        type: "setEnabled",
                        enabled: newState,
                        tabId: tab.id,
                        url: tab.url,
                    },
                    (response) => {
                        if (newState && response?.success) {
                            chrome.tabs.reload(tab.id);
                        }
                    }
                );
            });
        });
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        if (!tab || !tab.url.startsWith("https://drive.google.com/")) {
            downloadContainer.classList.add("hidden");
            statusMessage.classList.add("hidden");
            notDriveMessage.classList.remove("hidden");
            return;
        }

        downloadContainer.classList.remove("hidden");
        statusMessage.classList.remove("hidden");
        notDriveMessage.classList.add("hidden");

        chrome.storage.local.get(["extensionEnabled"], (result) => {
            const isEnabled =
                result.extensionEnabled !== undefined ? result.extensionEnabled : false;
            updateUI(isEnabled);
        });

        btnOn.addEventListener("click", () => handleStateChange(true));
        btnOff.addEventListener("click", () => handleStateChange(false));

        reloadBtn.addEventListener("click", () => {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (tabs[0]?.id) {
                    chrome.tabs.reload(tabs[0].id);
                }
            });
        });

        const activeTabId = tab.id;
        setInterval(() => {
            chrome.runtime.sendMessage({ type: "getRequests" }, (response) => {
                if (response && response.requests) {
                    const matchingRequests = [];
                    for (const requestId in response.requests) {
                        const req = response.requests[requestId];
                        if (req.tabId === activeTabId && req.lastItagUrl && req.videoTitle) {
                            matchingRequests.push(req);
                        }
                    }

                    if (matchingRequests.length > 0) {
                        statusMessage.textContent = "";
                        statusMessage.classList.remove("error");
                        btnOn.classList.remove("hidden");
                        btnOff.classList.remove("hidden");
                        downloadContainer.innerHTML = "";
                        matchingRequests.forEach((req) => {
                            const item = document.createElement("div");
                            item.classList.add("video-item");

                            const titleSpan = document.createElement("span");
                            titleSpan.classList.add("video-title");
                            titleSpan.textContent =
                                req.videoTitle.length > 35
                                    ? req.videoTitle.substring(0, 35) + "..."
                                    : req.videoTitle;

                            const btn = document.createElement("button");
                            btn.classList.add("download-btn");
                            btn.textContent = "Download";
                            btn.addEventListener("click", () => {
                                chrome.downloads.download(
                                    {
                                        url: req.lastItagUrl,
                                        filename: req.videoTitle,
                                    },
                                    () => {
                                        if (chrome.runtime.lastError) {
                                            statusMessage.textContent =
                                                "Unable to download this file.";
                                            statusMessage.classList.add("error");
                                            btnOn.classList.add("hidden"); // HIDE buttons on error
                                            btnOff.classList.add("hidden");
                                        } else {
                                            statusMessage.textContent =
                                                "Download started successfully.";
                                            statusMessage.classList.remove("error");
                                            btnOn.classList.remove("hidden"); // SHOW buttons again
                                            btnOff.classList.remove("hidden");
                                        }
                                    }
                                );
                            });

                            item.appendChild(titleSpan);
                            item.appendChild(btn);
                            downloadContainer.appendChild(item);
                        });
                    } else {
                        chrome.storage.local.get(["extensionEnabled"], (result) => {
                            if (result.extensionEnabled) {
                                statusMessage.textContent =
                                    "Waiting for new file sources. If not working, reload the page.";
                                statusMessage.classList.remove("error");
                                btnOn.classList.remove("hidden");
                                btnOff.classList.remove("hidden");
                            }
                        });
                    }
                }
            });
        }, 1000);
    });
});