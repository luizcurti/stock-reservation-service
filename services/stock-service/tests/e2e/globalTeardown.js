'use strict';

module.exports = async function globalTeardown() {
  console.log('\n[E2E] Tests finished. MySQL container left running.');
  console.log('[E2E] Run "docker compose down" to stop it.\n');
};
