export const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;

export const fingerprintSql = (from: string) => `
SELECT count(*) AS n,
       printf('%016x', (sum(hash(t)::HUGEINT) % 18446744073709551616::HUGEINT)::UBIGINT) AS fp
FROM ${from} t`;
