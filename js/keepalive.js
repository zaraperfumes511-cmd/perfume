// ============================================================
// Storeify Watches – Appwrite Keep-Alive Module
// ============================================================
// Purpose:
//   Appwrite Cloud marks projects as inactive when no API
//   activity is detected for an extended period, even if users
//   are uploading images via the frontend SDK.
//
//   This module fires a single, minimal read request to Appwrite
//   every 12 minutes in the background to keep the project
//   flagged as active.
//
// Design rules:
//   • Zero changes to any existing file or logic.
//   • Silent – no UI impact, no console noise in production.
//   • Uses the same endpoint/project values already in CONFIG.
//   • Performs only a lightweight LIST (limit=1) – cheapest op.
// ============================================================

(function () {
    'use strict';

    // How often to ping (12 minutes in milliseconds).
    const PING_INTERVAL_MS = 12 * 60 * 1000;

    // Delay before the very first ping so the page finishes
    // loading normally first (30 seconds).
    const INITIAL_DELAY_MS = 30 * 1000;

    /**
     * Sends a minimal LIST request to the products collection.
     * Only fetches 1 document – purely to register API activity.
     */
    function pingAppwrite() {
        // Guard: CONFIG and required fields must be present.
        if (
            typeof CONFIG === 'undefined' ||
            !CONFIG.appwrite ||
            !CONFIG.appwrite.endpoint ||
            !CONFIG.appwrite.projectId ||
            !CONFIG.appwrite.databaseId ||
            !CONFIG.appwrite.productsCollectionId
        ) {
            return;
        }

        const { endpoint, projectId, databaseId, productsCollectionId } = CONFIG.appwrite;

        // Build the lightest possible query: limit=1, no filters.
        const limitQuery = encodeURIComponent(JSON.stringify({ method: 'limit', values: [1] }));
        const url =
            `${endpoint}/databases/${databaseId}/collections/${productsCollectionId}/documents` +
            `?queries[]=${limitQuery}`;

        fetch(url, {
            method: 'GET',
            headers: {
                'X-Appwrite-Project': projectId,
                // No API key needed – this is an anonymous read.
                'Content-Type': 'application/json'
            }
        }).catch(function () {
            // Silently ignore network errors.
            // The next scheduled ping will retry automatically.
        });
    }

    /**
     * Starts the keep-alive scheduler.
     * The first ping fires after INITIAL_DELAY_MS so it doesn't
     * compete with the page's initial data load.
     */
    function startKeepAlive() {
        setTimeout(function () {
            pingAppwrite();                              // First ping
            setInterval(pingAppwrite, PING_INTERVAL_MS); // Recurring pings
        }, INITIAL_DELAY_MS);
    }

    // Boot when the DOM is ready (or immediately if already ready).
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startKeepAlive);
    } else {
        startKeepAlive();
    }
})();
