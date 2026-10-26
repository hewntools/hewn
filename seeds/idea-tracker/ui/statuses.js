// Status model shared by the UI. No DOM access, so it can be unit-tested (tests/statuses.test.mjs).

// Lifecycle order, used for pickers, chips and sorting.
export const STATUSES = ["raw", "exploring", "validating", "active", "parked", "shipped", "killed"];
// Open = live statuses plus parked. Closed = shipped and killed only.
export const LIVE = ["raw", "exploring", "validating", "active"];
export const OPEN = [...LIVE, "parked"];
export const CLOSED = ["shipped", "killed"];

// Design-system pill variant per status, one each. 'active' is the only accent-coloured status;
// shipped is the only success colour, killed the only danger colour. Live stages carry a dot;
// raw and parked are the neutral pill (parked keeps a dot so the two read apart at a glance).
export const PILL = {
  raw: "",
  exploring: "info with-dot",
  validating: "warn with-dot",
  active: "accent with-dot",
  parked: "with-dot",
  shipped: "ok with-dot",
  killed: "bad",
};

// Owner-facing names, sentence case.
export const LABEL = {
  raw: "Raw",
  exploring: "Exploring",
  validating: "Validating",
  active: "Active",
  parked: "Parked",
  shipped: "Shipped",
  killed: "Killed",
};

export function isOpen(status) {
  return !CLOSED.includes(status);
}

export function statusRank(status) {
  const i = STATUSES.indexOf(status);
  return i === -1 ? STATUSES.length : i;
}

// Splits a list (already in display order) into labelled sections for a view.
// Open view: live statuses first, then a 'Parked' section. Closed view: 'Shipped', then 'Killed'.
// Empty sections are left out; order within a section is kept.
export function groupIdeas(ideas, view) {
  const sections =
    view === "closed"
      ? [{ label: "Shipped", statuses: ["shipped"] }, { label: "Killed", statuses: ["killed"] }]
      : [{ label: null, statuses: LIVE }, { label: "Parked", statuses: ["parked"] }];
  return sections
    .map((s) => ({ label: s.label, ideas: ideas.filter((i) => s.statuses.includes(i.status)) }))
    .filter((s) => s.ideas.length > 0);
}
