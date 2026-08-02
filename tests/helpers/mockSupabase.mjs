/**
 * mockSupabase.mjs
 * ----------------------------------------------------------------------------
 * A minimal in-memory stand-in for the supabase-js query builder, just
 * capable enough to unit-test src/lib/api/*.mjs without a live Supabase
 * project or network access. NOT a full PostgREST emulator — embedded
 * resource ("foreign table") selects are special-cased for the specific
 * patterns this app actually uses (see EMBEDS below); add another entry if a
 * new module starts embedding a different relationship.
 * ----------------------------------------------------------------------------
 */
let uidCounter = 1;
function genId() { return 'mock-id-' + (uidCounter++); }

const EMBEDS = [
  { needle: 'academic_years(', table: 'academic_years', fk: 'academic_year_id', as: 'academic_years' },
  { needle: 'terms(', table: 'terms', fk: 'term_id', as: 'terms' },
  { needle: 'classes(', table: 'classes', fk: 'class_id', as: 'classes' },
  { needle: 'subjects(', table: 'subjects', fk: 'subject_id', as: 'subjects' },
  { needle: 'staff(', table: 'staff', fk: 'staff_id', as: 'staff' },
  { needle: 'students(', table: 'students', fk: 'student_id', as: 'students' }
];

export function createMockSupabase(initialTables) {
  const tables = {};
  Object.keys(initialTables || {}).forEach((t) => { tables[t] = (initialTables[t] || []).map((r) => ({ ...r })); });
  const rpcHandlers = {};

  function ensure(table) { if (!tables[table]) tables[table] = []; return tables[table]; }

  function matches(row, filters) {
    return filters.every(([kind, col, val]) => {
      const rv = row[col];
      if (kind === 'eq') return String(rv) === String(val);
      if (kind === 'neq') return String(rv) !== String(val);
      if (kind === 'is') return val === null ? (rv === null || rv === undefined) : rv === val;
      if (kind === 'ilike') return String(rv || '').toLowerCase() === String(val || '').toLowerCase().replace(/%/g, '');
      if (kind === 'in') return val.map(String).includes(String(rv));
      if (kind === 'gt') return Number(rv) > Number(val);
      return true;
    });
  }

  function applyEmbeds(rows, cols) {
    const active = EMBEDS.filter((e) => cols && cols.indexOf(e.needle) !== -1);
    if (!active.length) return rows;
    return rows.map((row) => {
      const copy = { ...row };
      active.forEach((e) => {
        const related = (tables[e.table] || []).find((r) => String(r.id) === String(row[e.fk]));
        copy[e.as] = related || null;
      });
      return copy;
    });
  }

  function builder(table) {
    const state = { mode: null, filters: [], cols: '*', patch: null, insertRows: null, order: null, count: null, head: false, wantSelect: false, upsertOpts: null };

    const api = {
      select(cols, opts) {
        state.cols = cols || '*';
        if (state.mode === null) state.mode = 'select';
        state.wantSelect = true;
        if (opts && opts.count) state.count = opts.count;
        if (opts && opts.head) state.head = true;
        return api;
      },
      insert(rows) { state.mode = 'insert'; state.insertRows = Array.isArray(rows) ? rows : [rows]; return api; },
      update(patch) { state.mode = 'update'; state.patch = patch; return api; },
      delete() { state.mode = 'delete'; return api; },
      upsert(rows, opts) { state.mode = 'upsert'; state.insertRows = Array.isArray(rows) ? rows : [rows]; state.upsertOpts = opts || {}; return api; },
      eq(col, val) { state.filters.push(['eq', col, val]); return api; },
      neq(col, val) { state.filters.push(['neq', col, val]); return api; },
      is(col, val) { state.filters.push(['is', col, val]); return api; },
      ilike(col, val) { state.filters.push(['ilike', col, val]); return api; },
      in(col, val) { state.filters.push(['in', col, val]); return api; },
      gt(col, val) { state.filters.push(['gt', col, val]); return api; },
      order(col, opts) { state.order = { col, ascending: !opts || opts.ascending !== false }; return api; },
      limit() { return api; },
      async single() {
        const r = await finalize();
        if (r.error) return r;
        if (!Array.isArray(r.data) || r.data.length !== 1) return { data: null, error: { message: 'Row not found' } };
        return { data: r.data[0], error: null };
      },
      async maybeSingle() {
        const r = await finalize();
        if (r.error) return r;
        const arr = Array.isArray(r.data) ? r.data : [];
        return { data: arr[0] || null, error: null };
      },
      then(resolve, reject) { return finalize().then(resolve, reject); }
    };

    async function finalize() {
      const rows = ensure(table);
      if (state.mode === 'insert') {
        const inserted = state.insertRows.map((r) => ({ id: r.id || genId(), created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(), ...r }));
        rows.push(...inserted);
        return { data: state.wantSelect ? applyEmbeds(inserted, state.cols) : null, error: null };
      }
      if (state.mode === 'upsert') {
        const conflictCols = (state.upsertOpts.onConflict || 'id').split(',').map((s) => s.trim());
        const ignoreDup = !!state.upsertOpts.ignoreDuplicates;
        const insertedNow = [];
        state.insertRows.forEach((r) => {
          const existing = rows.find((row) => conflictCols.every((c) => String(row[c]) === String(r[c])));
          if (existing) {
            if (!ignoreDup) Object.assign(existing, r);
            return;
          }
          const created = { id: r.id || genId(), created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(), ...r };
          rows.push(created);
          insertedNow.push(created);
        });
        return { data: state.wantSelect ? insertedNow : null, error: null };
      }
      if (state.mode === 'update') {
        const hit = rows.filter((r) => matches(r, state.filters));
        hit.forEach((r) => Object.assign(r, state.patch, { updated_at: new Date(0).toISOString() }));
        return { data: state.wantSelect ? hit : null, error: null };
      }
      if (state.mode === 'delete') {
        const keep = rows.filter((r) => !matches(r, state.filters));
        const removedCount = rows.length - keep.length;
        tables[table] = keep;
        return { data: null, error: null, count: removedCount };
      }
      // select (default)
      let hit = rows.filter((r) => matches(r, state.filters));
      if (state.head && state.count) return { data: null, error: null, count: hit.length };
      if (state.order) {
        const { col, ascending } = state.order;
        hit = hit.slice().sort((a, b) => {
          const av = a[col], bv = b[col];
          if (av === bv) return 0;
          return (av > bv ? 1 : -1) * (ascending ? 1 : -1);
        });
      }
      hit = applyEmbeds(hit, state.cols);
      return { data: hit, error: null, count: hit.length };
    }

    return api;
  }

  return {
    _tables: tables,
    from(table) { return builder(table); },
    rpc(name, args) {
      const handler = rpcHandlers[name];
      const p = handler ? Promise.resolve(handler(args, tables)) : Promise.resolve({ data: null, error: { message: 'No mock handler for rpc ' + name } });
      p.then = p.then.bind(p);
      return p;
    },
    __registerRpc(name, fn) { rpcHandlers[name] = fn; }
  };
}
