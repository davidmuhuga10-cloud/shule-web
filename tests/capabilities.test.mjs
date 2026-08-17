import { createMockSupabase } from './helpers/mockSupabase.mjs';
import { createCapabilitiesApi, CAPABILITIES } from '../src/lib/api/capabilities.mjs';

let passed = 0, failed = 0;
function check(name, cond) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

async function run() {
  {
    const sb = createMockSupabase({ staff: [{ id: 'st1', full_name: 'Mr. Otieno' }] });
    const api = createCapabilitiesApi(sb);

    const none = await api.listForStaff('st1');
    check('listForStaff starts empty', none.ok === true && none.data.length === 0);

    const bad = await api.grant('st1', 'not_a_real_capability');
    check('grant rejects an unknown capability', bad.ok === false);

    const granted = await api.grant('st1', 'publish_results');
    check('grant succeeds for a known capability', granted.ok === true);
    const listed = await api.listForStaff('st1');
    check('listForStaff reflects the grant', listed.data.indexOf('publish_results') !== -1);

    const grantedAgain = await api.grant('st1', 'publish_results');
    check('granting the same capability twice is a harmless no-op', grantedAgain.ok === true);
    const listedAgain = await api.listForStaff('st1');
    check('granting twice does not create a duplicate row', listedAgain.data.length === 1);

    const revoked = await api.revoke('st1', 'publish_results');
    check('revoke removes the capability', revoked.ok === true);
    const listedAfterRevoke = await api.listForStaff('st1');
    check('listForStaff no longer includes the revoked capability', listedAfterRevoke.data.indexOf('publish_results') === -1);
  }

  {
    const sb = createMockSupabase({});
    const api = createCapabilitiesApi(sb);
    check('listForStaff returns empty (not an error) with no staff id', (await api.listForStaff(null)).data.length === 0);
    check('grant requires a staff id', (await api.grant(null, 'publish_results')).ok === false);
    check('CAPABILITIES includes publish_results plus the Finance module\'s two capabilities',
      CAPABILITIES.indexOf('publish_results') !== -1 &&
      CAPABILITIES.indexOf('finance_manage_fees') !== -1 &&
      CAPABILITIES.indexOf('finance_record_collections') !== -1 &&
      CAPABILITIES.length === 3);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run();
