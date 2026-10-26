// Pure helpers for the list's empty state and hidden-closed footer.
// No DOM access, so they can be unit-tested (tests/empty-state.test.mjs).

// Closed = shipped and killed; parked ideas are open and never hidden.
// Returns null when the list has rows; otherwise { title, hint, showClosedAction }.
export function emptyStateMessage({ totalIdeas, visibleCount, hiddenClosedCount, view = "open" }) {
  if (visibleCount > 0) return null;
  if (!totalIdeas) return { title: "No ideas yet", hint: "Add one above.", showClosedAction: false };
  if (view === "closed") return { title: "No closed ideas", hint: "Shipped and killed ideas show here.", showClosedAction: false };
  if (hiddenClosedCount > 0) {
    return { title: `${hiddenClosedCount} closed idea${hiddenClosedCount === 1 ? "" : "s"} hidden`, hint: null, showClosedAction: true };
  }
  return { title: "No ideas match", hint: "Try other filters.", showClosedAction: false };
}

// Muted footer under a non-empty list, or null when nothing is hidden.
export function hiddenClosedFooter(hiddenClosedCount) {
  return hiddenClosedCount > 0 ? `+ ${hiddenClosedCount} closed hidden` : null;
}
