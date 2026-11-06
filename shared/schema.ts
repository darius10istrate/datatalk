export const TABLE = 'trips';

export type Column = {
  readonly name: string;
  readonly type: string;
  readonly description: string;
};

export const COLUMNS = [
  { name: 'pickup_at', type: 'TIMESTAMP', description: 'When the meter started (NYC local time). January 2024 only.' },
  { name: 'dropoff_at', type: 'TIMESTAMP', description: 'When the meter stopped (NYC local time).' },
  { name: 'passenger_count', type: 'INTEGER', description: 'Passengers reported by the driver; may be NULL.' },
  { name: 'trip_distance', type: 'DOUBLE', description: 'Trip distance in miles, from the taximeter.' },
  { name: 'ratecode', type: 'VARCHAR', description: "Final rate: 'Standard rate', 'JFK', 'Newark', 'Nassau or Westchester', 'Negotiated fare', 'Group ride', 'Unknown'." },
  { name: 'pickup_borough', type: 'VARCHAR', description: "Borough of the pickup zone: 'Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island', 'EWR' (Newark airport), 'Unknown', 'N/A' (outside NYC)." },
  { name: 'pickup_zone', type: 'VARCHAR', description: 'TLC taxi zone name of the pickup (for example an airport or a neighbourhood).' },
  { name: 'dropoff_borough', type: 'VARCHAR', description: 'Borough of the drop-off zone; same labels as pickup_borough.' },
  { name: 'dropoff_zone', type: 'VARCHAR', description: 'TLC taxi zone name of the drop-off.' },
  { name: 'payment_type', type: 'VARCHAR', description: "How the rider paid: 'Credit card', 'Cash', 'Flex fare', 'No charge', 'Dispute', 'Unknown', 'Voided trip'." },
  { name: 'fare_amount', type: 'DOUBLE', description: 'Time-and-distance fare in USD, before extras, tolls and tip.' },
  { name: 'tip_amount', type: 'DOUBLE', description: 'Tip in USD. Recorded for card and Flex fare trips; cash tips are not recorded.' },
  { name: 'total_amount', type: 'DOUBLE', description: 'Total charged to the rider in USD (cash tips not included).' },
] as const satisfies readonly Column[];

export type ColumnName = (typeof COLUMNS)[number]['name'];

export function ddl(): string {
  const width = Math.max(...COLUMNS.map((c) => `${c.name} ${c.type}`.length)) + 1;
  const lines = COLUMNS.map((c, i) => {
    const decl = `${c.name} ${c.type}${i < COLUMNS.length - 1 ? ',' : ''}`;
    return `  ${decl.padEnd(width)} -- ${c.description}`;
  });
  return `CREATE TABLE ${TABLE} (\n${lines.join('\n')}\n);`;
}

export type DescribedColumn = { name: string; type: string };

export function schemaDrift(described: readonly DescribedColumn[]): string[] {
  const problems: string[] = [];
  const max = Math.max(described.length, COLUMNS.length);
  for (let i = 0; i < max; i++) {
    const want = COLUMNS[i];
    const got = described[i];
    if (!want) problems.push(`unexpected column ${got!.name} ${got!.type}`);
    else if (!got) problems.push(`missing column ${want.name} ${want.type}`);
    else if (want.name !== got.name || want.type !== got.type)
      problems.push(`column ${i + 1}: expected ${want.name} ${want.type}, found ${got.name} ${got.type}`);
  }
  return problems;
}
