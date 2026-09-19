const fs = require('fs');
const path = require('path');

const migrationsRoot = path.join(__dirname, '..', 'prisma', 'migrations');
const migrationName = 'z_parent_trust_contracts';

describe('parent trust production migration safety', () => {
  it('sorts after every migration already applied in production', () => {
    const names = fs.readdirSync(migrationsRoot)
      .filter((name) => fs.statSync(path.join(migrationsRoot, name)).isDirectory())
      .sort();

    expect(names.at(-1)).toBe(migrationName);
  });

  it('converts legacy UTC timestamps into the school timezone before taking the date', () => {
    const sql = fs.readFileSync(path.join(migrationsRoot, migrationName, 'migration.sql'), 'utf8');

    expect(sql).toContain(`l."startDate" AT TIME ZONE 'UTC'`);
    expect(sql).toContain(`l."endDate" AT TIME ZONE 'UTC'`);
  });

  it('does not drop existing tables, columns, or data', () => {
    const sql = fs.readFileSync(path.join(migrationsRoot, migrationName, 'migration.sql'), 'utf8');

    expect(sql).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN|TYPE)\b/i);
    expect(sql).not.toMatch(/^\s*(?:DELETE\s+FROM|TRUNCATE\s+(?:TABLE\s+)?)/im);
  });
});
