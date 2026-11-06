export type Snippet = {
  readonly id: string;
  readonly tags: readonly string[];
  readonly text: string;
};

export const EXAMPLE_PREFIX = 'example-';

export const SNIPPETS: readonly Snippet[] = [
  {
    id: 'tips-not-recorded-for-cash',
    tags: ['tip', 'tips', 'tipping', 'tipped', 'gratuity', 'cash'],
    text: "Tips are recorded for 'Credit card' and 'Flex fare' trips. Cash tips are not recorded, so cash trips show a tip near 0. For questions about tipping, exclude cash trips with payment_type <> 'Cash' unless the question asks about cash.",
  },
  {
    id: 'payment-type-labels',
    tags: ['payment', 'paid', 'pay', 'card', 'credit', 'flex', 'cash', 'method'],
    text: "payment_type holds labels, not codes: 'Credit card', 'Cash', 'Flex fare', 'No charge', 'Dispute', 'Unknown', 'Voided trip'. 'Flex fare' is TLC payment code 0, a fare agreed before the trip. Compare against the label text exactly.",
  },
  {
    id: 'borough-values',
    tags: ['borough', 'boroughs', 'manhattan', 'brooklyn', 'queens', 'bronx', 'staten', 'island', 'outside', 'nyc'],
    text: "pickup_borough and dropoff_borough use the TLC zone labels: 'Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island', 'EWR' (Newark airport, New Jersey), 'Unknown' and 'N/A' (outside New York City). 'Unknown' and 'N/A' are text labels, not NULL.",
  },
  {
    id: 'airports',
    tags: ['airport', 'airports', 'jfk', 'laguardia', 'lga', 'newark', 'ewr', 'flight'],
    text: "Airports are taxi zones: pickup_zone or dropoff_zone 'JFK Airport', 'LaGuardia Airport' and 'Newark Airport'. Newark airport is also the whole borough 'EWR'. ratecode 'JFK' and 'Newark' mark the flat-rate airport fares, which not every airport trip uses.",
  },
  {
    id: 'january-only',
    tags: ['month', 'months', 'monthly', 'year', 'february', 'december', 'march', '2023', '2025', 'trend', 'growth', 'change', 'compare'],
    text: 'The table covers trips that started in January 2024 only. A question about any other month or year, or a comparison across months, cannot be answered from this table: answer with kind "cannot_answer" and say the data covers January 2024 only.',
  },
  {
    id: 'weekend-definition',
    tags: ['weekend', 'weekends', 'weekday', 'weekdays', 'saturday', 'sunday', 'week'],
    text: 'Timestamps are NYC local time. dayofweek(pickup_at) returns 0 for Sunday through 6 for Saturday, so a weekend is dayofweek(pickup_at) IN (0, 6) and a weekday is dayofweek(pickup_at) BETWEEN 1 AND 5. dayname(pickup_at) gives the day name.',
  },
  {
    id: 'time-parts',
    tags: ['hour', 'hourly', 'day', 'daily', 'date', 'morning', 'evening', 'night', 'rush', 'time'],
    text: 'Group by time with hour(pickup_at) for the hour of day (0 to 23), CAST(pickup_at AS DATE) for the calendar day, and date_trunc(\'week\', pickup_at) for weeks. Use pickup_at, the start of the trip, unless the question is about drop-off time.',
  },
  {
    id: 'trip-duration',
    tags: ['duration', 'minutes', 'long', 'longest', 'length', 'time', 'took', 'ride'],
    text: "Trip duration in minutes is date_diff('minute', pickup_at, dropoff_at), or epoch(dropoff_at - pickup_at) / 60 for fractional minutes. Some trips have a drop-off before the pickup or last for days; filter dropoff_at > pickup_at when averaging durations.",
  },
  {
    id: 'distance-units',
    tags: ['distance', 'miles', 'mile', 'far', 'length', 'longest', 'short'],
    text: 'trip_distance is in miles from the taximeter. Some trips record 0 miles and a few record implausibly large distances; say so in the rationale when a maximum or minimum could be a data error.',
  },
  {
    id: 'tip-rate',
    tags: ['rate', 'percentage', 'percent', 'share', 'ratio', 'proportion', 'generous'],
    text: 'Tip rate is tip_amount / fare_amount. Exclude fare_amount <= 0 before dividing so refunds and free trips do not divide by zero or flip the sign.',
  },
  {
    id: 'fare-vs-total',
    tags: ['fare', 'fares', 'total', 'revenue', 'cost', 'price', 'spent', 'earned', 'money', 'expensive', 'cheap'],
    text: 'fare_amount is the time-and-distance fare before extras, tolls and tip. total_amount is everything charged to the rider (cash tips excluded). Use total_amount for revenue or what riders paid, fare_amount for the fare itself.',
  },
  {
    id: 'negative-amounts',
    tags: ['negative', 'refund', 'refunds', 'dispute', 'voided', 'void', 'charge'],
    text: "Refunds and corrections appear as rows with negative fare_amount and total_amount. Exclude amounts <= 0 when the question is about typical fares or revenue per trip.",
  },
  {
    id: 'zones',
    tags: ['zone', 'zones', 'neighbourhood', 'neighborhood', 'area', 'location', 'place', 'popular', 'busiest'],
    text: 'pickup_zone and dropoff_zone are TLC taxi zone names (neighbourhoods, airports, landmarks). Group by the zone column for "where" questions; join pickup and drop-off columns for routes between zones.',
  },
  {
    id: 'passenger-count',
    tags: ['passenger', 'passengers', 'riders', 'people', 'group', 'shared', 'solo', 'alone'],
    text: 'passenger_count is entered by the driver and can be NULL. count(passenger_count) counts only known values; say in the rationale when NULLs were left out.',
  },
  {
    id: 'ratecode-values',
    tags: ['ratecode', 'rate', 'negotiated', 'nassau', 'westchester', 'standard', 'flat'],
    text: "ratecode labels: 'Standard rate', 'JFK', 'Newark', 'Nassau or Westchester', 'Negotiated fare', 'Group ride', 'Unknown'.",
  },
  {
    id: 'pivot-syntax',
    tags: ['pivot', 'crosstab', 'matrix', 'columns', 'breakdown', 'split', 'by'],
    text: "To put values in columns, use the SQL-standard form FROM trips PIVOT (count(*) FOR payment_type IN ('Cash', 'Credit card')). The DuckDB statement form PIVOT trips ON ... is rejected. count(*) FILTER (WHERE ...) per column also works.",
  },
  {
    id: 'duckdb-functions',
    tags: ['median', 'percentile', 'quantile', 'rank', 'top', 'round', 'typical', 'distribution'],
    text: 'DuckDB SQL: median(x), quantile_cont(x, 0.9), round(x, 2), GROUP BY ALL, ORDER BY ... DESC LIMIT n, and QUALIFY row_number() OVER (PARTITION BY ... ORDER BY ...) = 1 for the top row per group.',
  },
  {
    id: 'single-table-only',
    tags: ['series', 'range', 'calendar', 'list', 'file', 'join', 'table', 'tables'],
    text: 'Only the trips table exists. Do not read files or URLs and do not use table functions such as generate_series, range or unnest in FROM; they are blocked. Build day or hour lists from trips itself with GROUP BY.',
  },
  {
    id: `${EXAMPLE_PREFIX}distance-by-dropoff-borough`,
    tags: ['distance', 'dropoff', 'borough'],
    text: 'Example: What is the average trip distance for each drop-off borough?\nSQL: SELECT dropoff_borough, round(avg(trip_distance), 2) AS avg_miles, count(*) AS trips FROM trips GROUP BY ALL ORDER BY avg_miles DESC',
  },
  {
    id: `${EXAMPLE_PREFIX}revenue-by-dropoff-zone`,
    tags: ['revenue', 'total', 'dropoff', 'zone'],
    text: 'Example: Which five drop-off zones brought in the most total revenue?\nSQL: SELECT dropoff_zone, round(sum(total_amount), 2) AS revenue FROM trips WHERE total_amount > 0 GROUP BY ALL ORDER BY revenue DESC LIMIT 5',
  },
  {
    id: `${EXAMPLE_PREFIX}duration-by-ratecode`,
    tags: ['duration', 'minutes', 'ratecode'],
    text: "Example: How long does a trip last on average for each rate code, in minutes?\nSQL: SELECT ratecode, round(avg(date_diff('minute', pickup_at, dropoff_at)), 1) AS avg_minutes FROM trips WHERE dropoff_at > pickup_at GROUP BY ALL ORDER BY avg_minutes DESC",
  },
  {
    id: `${EXAMPLE_PREFIX}large-groups-share`,
    tags: ['share', 'passengers', 'groups', 'percent'],
    text: 'Example: What share of trips with a known passenger count carried more than two passengers?\nSQL: SELECT round(100.0 * count(*) FILTER (WHERE passenger_count > 2) / count(passenger_count), 2) AS pct_over_two FROM trips WHERE passenger_count IS NOT NULL',
  },
  {
    id: `${EXAMPLE_PREFIX}laguardia-to-manhattan`,
    tags: ['laguardia', 'manhattan', 'airport', 'route'],
    text: "Example: How many trips went from LaGuardia Airport to Manhattan?\nSQL: SELECT count(*) AS trips FROM trips WHERE pickup_zone = 'LaGuardia Airport' AND dropoff_borough = 'Manhattan'",
  },
];
