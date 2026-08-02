/**
 * studentLogin.js
 * ----------------------------------------------------------------------------
 * Thin re-export of the shared admission-number <-> login mapping. The real
 * logic lives in ../../../src/lib/studentEmail.shared.js — the SAME file the
 * frontend loads in the browser — so there is exactly one implementation,
 * not two copies to keep in sync.
 * ----------------------------------------------------------------------------
 */
module.exports = require('../../../src/lib/studentEmail.shared.js');
