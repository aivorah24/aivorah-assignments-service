// In-memory Supabase stand-in that actually applies select/eq/in/order/range
// filters over seeded rows, for logic that queries one table several ways.
function makeFakeSupabase(tables = {}) {
  const calls = [];
  function from(table) {
    const filters = [];
    let orderCol = null;
    let rangeArgs = null;
    const q = {
      select: () => q,
      eq: (col, val) => { filters.push(r => r[col] === val); return q; },
      in: (col, vals) => { filters.push(r => vals.includes(r[col])); return q; },
      order: (col) => { orderCol = col; return q; },
      range: (a, b) => { rangeArgs = [a, b]; return q; },
      then: (resolve, reject) => {
        calls.push(table);
        let rows = (tables[table] || []).filter(r => filters.every(f => f(r)));
        if (orderCol) rows = [...rows].sort((x, y) => String(x[orderCol]).localeCompare(String(y[orderCol])));
        if (rangeArgs) rows = rows.slice(rangeArgs[0], rangeArgs[1] + 1);
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
      },
    };
    return q;
  }
  return { from, calls };
}

module.exports = { makeFakeSupabase };
