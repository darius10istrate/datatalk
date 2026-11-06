export const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;
