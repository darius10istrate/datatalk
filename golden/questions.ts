import type { CheckKind } from './check.ts';

export type GoldenQuestion = {
  id: string;
  question: string;
  check: CheckKind;
  reference: string | string[];
  trap?: string;
};

export const DEV_QUESTIONS: readonly GoldenQuestion[] = [
  {
    id: 'tip-by-borough',
    question: 'What is the average tip by pickup borough?',
    check: 'exact',
    reference: `SELECT pickup_borough, avg(tip_amount) AS avg_tip
FROM trips
WHERE payment_type <> 'Cash'
GROUP BY pickup_borough
ORDER BY avg_tip DESC`,
    trap: 'cash tips are not recorded, so cash trips must be left out',
  },
  {
    id: 'top-tip-payment',
    question: 'Which payment type has the highest average tip?',
    check: 'top1',
    reference: `SELECT payment_type, avg(tip_amount) AS avg_tip
FROM trips
GROUP BY payment_type
ORDER BY avg_tip DESC`,
  },
  {
    id: 'flex-fare-trips',
    question: 'How many trips were paid with a Flex fare?',
    check: 'exact',
    reference: `SELECT count(*) AS trips FROM trips WHERE payment_type = 'Flex fare'`,
    trap: "Flex fare is payment code 0, missing from the classic 1-6 list; the label is 'Flex fare'",
  },
  {
    id: 'newark-pickups',
    question: 'How many trips started at Newark airport?',
    check: 'exact',
    reference: `SELECT count(*) AS trips FROM trips WHERE pickup_borough = 'EWR'`,
    trap: "Newark airport is the borough 'EWR', not a zone filter or 'N/A'",
  },
  {
    id: 'outside-nyc-pickups',
    question: 'How many trips started outside New York City or at an unknown location?',
    check: 'exact',
    reference: `SELECT count(*) AS trips FROM trips WHERE pickup_borough IN ('Unknown', 'N/A')`,
    trap: "'Unknown' and 'N/A' are labels, not NULLs",
  },
  {
    id: 'weekend-trips',
    question: 'How many trips started on a weekend?',
    check: 'exact',
    reference: `SELECT count(*) AS trips FROM trips WHERE dayofweek(pickup_at) IN (0, 6)`,
    trap: 'dayofweek is 0 for Sunday and 6 for Saturday',
  },
  {
    id: 'trips-per-day',
    question: 'How many trips were there on each day?',
    check: 'exact',
    reference: `SELECT CAST(pickup_at AS DATE) AS day, count(*) AS trips
FROM trips
GROUP BY day
ORDER BY day`,
    trap: 'January 2024 only: 31 days, no December or February spill-over',
  },
  {
    id: 'busiest-pickup-zone',
    question: 'Which pickup zone had the most trips?',
    check: 'top1',
    reference: `SELECT pickup_zone, count(*) AS trips
FROM trips
GROUP BY pickup_zone
ORDER BY trips DESC`,
  },
  {
    id: 'fare-by-hour',
    question: 'What is the average fare for each hour of the day?',
    check: 'exact',
    reference: `SELECT hour(pickup_at) AS hour, avg(fare_amount) AS avg_fare
FROM trips
GROUP BY hour
ORDER BY hour`,
  },
  {
    id: 'card-tip-rate',
    question: 'What is the average tip as a share of the fare for credit card trips?',
    check: 'exact',
    reference: `SELECT avg(tip_amount / fare_amount) AS tip_rate
FROM trips
WHERE payment_type = 'Credit card' AND fare_amount > 0`,
    trap: 'fares of zero or less must be excluded before dividing',
  },
  {
    id: 'median-trip-length',
    question: 'What is the median trip length?',
    check: 'any_of',
    reference: [
      `SELECT median(trip_distance) AS median_length FROM trips`,
      `SELECT median(date_diff('minute', pickup_at, dropoff_at)) AS median_length FROM trips`,
      `SELECT median(epoch(dropoff_at - pickup_at) / 60) AS median_length FROM trips`,
    ],
    trap: 'ambiguous: length by distance (miles) or by duration (minutes, as minute boundaries or elapsed seconds / 60)',
  },
  {
    id: 'february-trips',
    question: 'How many trips were there in February 2024?',
    check: 'refuse',
    reference: [],
    trap: 'the data covers January 2024 only',
  },
  {
    id: 'month-over-month',
    question: 'How did the number of trips change from December 2023 to January 2024?',
    check: 'refuse',
    reference: [],
    trap: 'a cross-month comparison needs data the app does not have',
  },
];
