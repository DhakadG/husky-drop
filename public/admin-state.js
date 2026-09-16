// Admin dashboard shared state: live ES bindings; anything reassigned after
// load goes through a setter so every module sees the new value.

export const $ = (id) => document.getElementById(id);
export let overview = null;
export let liveActive = [];
export let liveRecent = [];
export let liveSocket = null;
export let liveReconnectDelay = 1000;
export let currentDetailSlug = "";
export let createdDropSlug = "";
export let seriesMetric = "bytes";
export let seriesRows = [];
export let detailData = null;
export let detailSearch = "";
export let detailSort = "new";
export let detailShowAll = false;
export const openSettings = new Set();
export let activityFilter = "all";
export let activityQuery = "";
export let activityOlder = [];
export let activityOldestDay = new Date().toISOString().slice(0, 10);
export let activityLoading = false;
export const openActivitySessions = new Set();
export let currentQrUrl = "";
export let adminMobileMore = null;
export let adminMoreToggle = null;
export const adminSecondaryTabs = new Set(["activity", "people", "previews", "images", "logs", "create", "create-share"]);

export function setOverview(v) { overview = v; }
export function setLiveActive(v) { liveActive = v; }
export function setLiveRecent(v) { liveRecent = v; }
export function setLiveSocket(v) { liveSocket = v; }
export function setLiveReconnectDelay(v) { liveReconnectDelay = v; }
export function setCurrentDetailSlug(v) { currentDetailSlug = v; }
export function setCreatedDropSlug(v) { createdDropSlug = v; }
export function setSeriesMetric(v) { seriesMetric = v; }
export function setSeriesRows(v) { seriesRows = v; }
export function setDetailData(v) { detailData = v; }
export function setDetailSearch(v) { detailSearch = v; }
export function setDetailSort(v) { detailSort = v; }
export function setDetailShowAll(v) { detailShowAll = v; }
export function setActivityFilter(v) { activityFilter = v; }
export function setActivityQuery(v) { activityQuery = v; }
export function setActivityOlder(v) { activityOlder = v; }
export function setActivityOldestDay(v) { activityOldestDay = v; }
export function setActivityLoading(v) { activityLoading = v; }
export function setCurrentQrUrl(v) { currentQrUrl = v; }
export function setAdminMobileMore(v) { adminMobileMore = v; }
export function setAdminMoreToggle(v) { adminMoreToggle = v; }

// Small helpers used by every module.
export function value(id) {
  return $(id) ? $(id).value.trim() : "";
}
export function icon(name, className = "ico") {
  return uiIcon(name, className);
}
