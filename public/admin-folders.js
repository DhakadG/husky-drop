import { $, createdDropSlug, icon } from "./admin-state.js";
import { showTab } from "./admin.js";
import { renderShareFolderSelection, selectDriveFolder, shareSelectedFolders, folderBreadcrumbs } from "./admin-links.js";

// Recently used Drive folders (per browser) + share-created-drop shortcut.
// ---- Recently used Drive folders (per browser, newest first, six kept) ----
// Drops and shares usually point at the same handful of folders, so the
// picker offers the last few as one-click chips above the listing.

function recentFolders() {
  try {
    return JSON.parse(localStorage.getItem("lhdb_recent_folders") || "[]");
  } catch {
    return [];
  }
}

export function rememberFolder(id, name) {
  if (!id || id === "root") return;
  const path = folderBreadcrumbs.map((crumb) => crumb.name).concat(folderBreadcrumbs.at(-1)?.id === id ? [] : [name]).join(" / ");
  const next = [{ id, name: name || "Folder", path }, ...recentFolders().filter((f) => f.id !== id)].slice(0, 6);
  try {
    localStorage.setItem("lhdb_recent_folders", JSON.stringify(next));
  } catch {}
}

export function renderRecentFolders() {
  const box = $("folder-recent");
  if (!box) return;
  const recent = recentFolders();
  box.classList.toggle("hidden", !recent.length);
  box.innerHTML = recent
    .map((f) => `<button class="mini" type="button" data-recent-folder="${escAttr(f.id)}" data-folder-name="${escAttr(f.name)}" title="${escAttr(f.path)}">${icon("folder")}${esc(f.name)}</button>`)
    .join("");
  box.querySelectorAll("[data-recent-folder]").forEach((button) => button.addEventListener("click", () => selectDriveFolder(button.dataset.recentFolder, button.dataset.folderName)));
}

// "Share this drop's folder": resolve the new drop's Drive folder (created in
// the background) and open the share form with it pre-selected.
export async function shareCreatedDrop() {
  if (!createdDropSlug) return;
  const button = $("create-share-of-drop");
  button.disabled = true;
  try {
    const response = await fetch(`/api/admin/links/${encodeURIComponent(createdDropSlug)}/folder`, { method: "POST" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.folderId) throw new Error(data.error || "Drive folder is not ready yet - try again in a moment.");
    shareSelectedFolders.clear();
    shareSelectedFolders.set(data.folderId, { id: data.folderId, name: data.folderName, path: data.folderName });
    renderShareFolderSelection();
    if ($("s-label") && !$("s-label").value) $("s-label").value = data.folderName;
    showTab("create-share");
  } catch (error) {
    // The form (and its error slot) is hidden by now; say it on the button.
    button.textContent = error.message;
    setTimeout(() => (button.textContent = "Share this drop's folder"), 4000);
  } finally {
    button.disabled = false;
  }
}
