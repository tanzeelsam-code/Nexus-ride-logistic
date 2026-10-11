'use strict';
// Portable bcrypt for the standalone Node runtime. Cloudflare delegates password
// hashing to Supabase pgcrypto, keeping the work off the Worker CPU budget.
module.exports = require('bcryptjs');
