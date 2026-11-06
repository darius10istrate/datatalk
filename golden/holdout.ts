import type { GoldenQuestion } from './questions.ts';

export const HOLDOUT_QUESTIONS: readonly GoldenQuestion[] = [
  {
    id: 'jfk-airport-pickups',
    question: 'How many trips were picked up at JFK Airport?',
    check: 'exact',
    reference: `SELECT count(*) AS trips FROM trips WHERE pickup_zone = 'JFK Airport'`,
    trap: "JFK pickups are the zone 'JFK Airport'; ratecode 'JFK' marks only the flat-rate fares",
  },
  {
    id: 'cash-share',
    question: 'What percentage of trips were paid in cash?',
    check: 'exact',
    reference: `SELECT 100.0 * count(*) FILTER (WHERE payment_type = 'Cash') / count(*) AS pct_cash FROM trips`,
    trap: "payment_type holds the label 'Cash', not a code; the answer is a percentage, not a fraction",
  },
  {
    id: 'busiest-hour',
    question: 'Which hour of the day had the most pickups?',
    check: 'top1',
    reference: `SELECT hour(pickup_at) AS hour, count(*) AS trips
FROM trips
GROUP BY hour
ORDER BY trips DESC`,
  },
  {
    id: 'weekday-avg-fare',
    question: 'What is the average fare on weekdays?',
    check: 'any_of',
    reference: [
      `SELECT avg(fare_amount) AS avg_fare FROM trips WHERE dayofweek(pickup_at) BETWEEN 1 AND 5`,
      `SELECT avg(fare_amount) AS avg_fare FROM trips WHERE dayofweek(pickup_at) BETWEEN 1 AND 5 AND fare_amount > 0`,
    ],
    trap: 'weekdays are dayofweek 1 to 5; ambiguous whether refunds (fare_amount <= 0) count as fares',
  },
  {
    id: 'jfk-dropoff-tip',
    question: 'What is the average tip on trips that ended at JFK Airport?',
    check: 'exact',
    reference: `SELECT avg(tip_amount) AS avg_tip
FROM trips
WHERE dropoff_zone = 'JFK Airport' AND payment_type <> 'Cash'`,
    trap: 'cash tips are not recorded, so cash trips must be left out',
  },
  {
    id: 'missing-passenger-count',
    question: 'How many trips have no passenger count recorded?',
    check: 'exact',
    reference: `SELECT count(*) AS trips FROM trips WHERE passenger_count IS NULL`,
    trap: 'a missing passenger count is NULL, not 0',
  },
  {
    id: 'quietest-day',
    question: 'Which day had the fewest trips?',
    check: 'top1',
    reference: `SELECT CAST(pickup_at AS DATE) AS day, count(*) AS trips
FROM trips
GROUP BY day
ORDER BY trips ASC`,
    trap: 'January 2024 only, so the days are the 31 calendar days of that month',
  },
  {
    id: 'march-revenue',
    question: 'What was the total revenue from taxi trips in March 2024?',
    check: 'refuse',
    reference: [],
    trap: 'the data covers January 2024 only',
  },
];
