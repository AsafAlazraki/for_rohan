# UI Placeholders & Mocked Data

This document tracks all hardcoded or "mocked" data implemented during the UI redesign phase. 
Once the UI is finalized, we must return to these items to wire them up to real backend API endpoints.

## 1. Overview Page (`web/src/tabs/Dashboard.jsx`)

The top stats grid currently uses the following placeholders or inferred logic that needs proper backend support:

| Component | Current Mock / Logic | Required Backend API |
| :--- | :--- | :--- |
| **Active Webhooks (Card)** | Hardcoded to `214` and `98% uptime`. | Needs an endpoint (e.g., `/api/webhooks/stats`) to return the true count of configured outbound webhooks and health status. |
| **Recent Errors (Card)** | Currently hardcoded to `17` errors, `3` resolved. | Needs an endpoint (e.g., `/api/events/stats?status=error&window=24h`) to count recent failures. |
| **Sync Status (Card)** | Hardcoded to `Healthy` (green). | Needs an aggregated system health check endpoint that evaluates queue depth, dead-letters, and active API connection status. |
| **Total Records Synced** | Partially real: Uses the `res.total` from the paginated `getEvents()` call, but the `% increase last 24h` text is hardcoded. | Needs historical metrics from the backend to calculate the 24h delta. |

## 2. Webhooks Page (Future)

| Component | Current Mock / Logic | Required Backend API |
| :--- | :--- | :--- |
| **Webhook List** | N/A (Pending implementation) | Will require `/api/webhooks` CRUD operations to replace the empty placeholder. |

## 3. Messages Page (Service Bus Inspector)

| Component | Current Status | Required Backend API |
| :--- | :--- | :--- |
| **Message Feed** | **Implemented** | Uses `/api/service-bus-messages`. |
| **Payload Inspector** | **Implemented** | Displays JSON with syntax highlighting in a side drawer. |
