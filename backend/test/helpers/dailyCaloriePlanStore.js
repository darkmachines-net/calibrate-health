/** @file Regression coverage for daily Calorie Plan Store. */

// Small stateful delegate for tests that use in-memory transaction doubles.
/** Create an isolated mutable daily-plan delegate for transaction doubles, including account/date uniqueness behavior. */
module.exports = function dailyCaloriePlanStore() {
  const rows = [];
  const find = where => rows.find(row => where.id !== undefined ? row.id === where.id :
    row.user_id === where.user_id_local_date.user_id && +row.local_date === +where.user_id_local_date.local_date);
  return {
    rows,
    findUnique: async ({ where }) => find(where) ?? null,
    findMany: async ({ where }) => rows.filter(row => row.user_id === where.user_id &&
      row.local_date >= where.local_date.gte && row.local_date <= where.local_date.lte),
    upsert: async ({ where, create, update }) => {
      const existing = find(where);
      if (existing) return Object.assign(existing, update);
      const row = { id: rows.length + 1, consumed_at: null, timezone_conflict: false, ...create };
      rows.push(row);
      return row;
    },
    update: async ({ where, data }) => Object.assign(find(where), data),
    updateMany: async ({ where, data }) => {
      const matching = rows.filter(row => row.user_id === where.user_id && row.consumed_at === null &&
        where.local_date.in.some(date => +date === +row.local_date));
      matching.forEach(row => Object.assign(row, data));
      return { count: matching.length };
    }
  };
};
