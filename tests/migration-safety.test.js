const fs = require('fs');
const path = require('path');

const migrationsRoot = path.join(__dirname, '..', 'prisma', 'migrations');
const migrationName = 'z_parent_trust_contracts';

// Prisma applies migrations in directory-name order.
const migrationNames = () => fs.readdirSync(migrationsRoot)
  .filter((name) => fs.statSync(path.join(migrationsRoot, name)).isDirectory())
  .sort();

// Everything production had applied when z_parent_trust_contracts shipped.
const appliedBefore = [
  '0_init',
  '1_route_osm_fields',
  '2_add_school_contact_and_status',
  '3_parent_driver_contact_and_schedule',
  '4_password_reset_requests',
  '5_qr_identity_and_attendance_source',
  '6_card_printed_at',
  '7_attendance_timestamp_index',
  '8_runs_and_calendar',
  '9_mapping_direction',
];

describe('parent trust production migration safety', () => {
  it('sorts after every migration already applied in production', () => {
    const names = migrationNames();

    expect(names.slice(0, names.indexOf(migrationName))).toEqual(appliedBefore);
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

describe('migrations added since', () => {
  const later = () => migrationNames().slice(migrationNames().indexOf(migrationName) + 1);

  it('exist, so this suite is checking something', () => {
    expect(later().length).toBeGreaterThan(0);
  });

  it('only add: no dropped tables, columns, or types, and no deleted rows', () => {
    for (const name of later()) {
      const sql = fs.readFileSync(path.join(migrationsRoot, name, 'migration.sql'), 'utf8');

      expect({ name, drops: /\bDROP\s+(?:TABLE|COLUMN|TYPE)\b/i.test(sql) }).toEqual({ name, drops: false });
      expect({ name, deletes: /^\s*(?:DELETE\s+FROM|TRUNCATE\s+(?:TABLE\s+)?)/im.test(sql) }).toEqual({ name, deletes: false });
    }
  });
});
