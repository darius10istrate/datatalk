export const DATA_FILE = 'trips.parquet';

export const LOCKDOWN = [
  'SET autoinstall_known_extensions=false',
  'SET autoload_known_extensions=false',
  "SET memory_limit='1GB'",
  `SET allowed_paths=['${DATA_FILE}']`,
  'SET enable_external_access=false',
  'SET lock_configuration=true',
] as const;

export const CREATE_VIEW = `CREATE VIEW trips AS SELECT * FROM '${DATA_FILE}'`;

export const EXTENSIONS = ['parquet', 'json'] as const;

export const DUCKDB_VERSION = 'v1.4.3';
