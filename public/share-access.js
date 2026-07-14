export async function switchGoogleAccount({ button, error, logout, navigate }) {
  if (button.disabled) return false;
  const idleLabel = button.textContent;
  button.disabled = true;
  button.textContent = "Choosing account...";
  error.textContent = "";
  try {
    const response = await logout();
    if (!response?.ok) throw new Error("logout failed");
    navigate();
    return true;
  } catch {
    button.disabled = false;
    button.textContent = idleLabel;
    error.textContent = "Could not switch accounts. Please try again.";
    return false;
  }
}
