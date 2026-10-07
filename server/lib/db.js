const { Pool } = require('pg');

function createDb(url) {
  if (!url) return null;
  const pool = new Pool({ connectionString: url });
  return {
    query: (text, params) => pool.query(text, params),
    close: () => pool.end(),
  };
}

module.exports = { createDb };
