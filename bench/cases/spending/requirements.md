Runtime: node. No network, no model, no secrets, no connections.

STATE (SQLite)
- categories: id, name (required), monthly_budget (optional number), position (integer, for ordering), created_at.
- expenses: id, date (local YYYY-MM-DD), amount (number > 0, two decimals, in euros), category_id, note (optional short text), created_at.

DERIVED (pure functions, unit-tested with an injected today)
- projected: a category's spending projected to the end of the month, linear in the days gone (spent ÷ days gone × days in month); for past months it's the actual total.

OPERATIONS (all @1)
- add_category (write): {name, monthly_budget?} → category (added last).
- update_category (write): {id, name?, monthly_budget?, position?} → category.
- delete_category (destructive): {id} → {deleted: true}; refused with a clear error naming the number of expenses when it has any.
- add_expense (write): {amount, category_id, date? (default today), note?} → expense.
- update_expense (write): {id, amount?, category_id?, date?, note?} → expense.
- delete_expense (destructive): {id} → {deleted: true}.
- list_expenses (read): {month? (YYYY-MM, default this month), category_id?} → expenses newest first with category_name, and the month's total.
- month_summary (read): {month?, today?} → {month, total, budget_total, days_gone, days_in_month, by_category: [{category_id, name, spent, budget, percent_of_budget, projected, over_budget}], by_day: [{date, total}], previous_month: {total, delta_percent}, biggest_expense, recent_categories (the 4 most used in the last 30 days)}.

TESTS
- Projection on the first day, mid-month and the last day, for 28-, 30- and 31-day months; past months use actual totals; categories without a budget; delete_category refusal and success; summary with no expenses; rounding to cents.

LATER (not in v1): recurring expenses, bank import, other currencies, splitting with a partner, yearly view.

UI sketch
- Opened right after paying for something, and at the end of the month to see where the money went. The question is "how am I doing against the budget this month?"
- At the top: this month's total against the budget, and each category's progress (spent and projected against its budget), the ones heading over clearly flagged.
- The main action: "Add expense": amount, category (one tap on the recent ones), today by default, a note if you like.
- Spending per day this month, and how it compares with last month.
- The month's expenses below, newest first, editable; a switch to earlier months.
- Day one: an empty state that suggests a few categories with budgets, then the first expense.
