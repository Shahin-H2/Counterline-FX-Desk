# Counterline FX Desk

A local, single-workspace currency reference and counter-pricing board. The board starts with common USD pairs and also lets an operator add any pair listed by the reference feed. Customer buy/sell values are separate, manually entered rates; no spread, fee, or margin is inferred.

## Run locally

Requires Node.js 18 or later. No package installation is needed.

```sh
npm start
```

Then open <http://127.0.0.1:4173>. The app binds to localhost by default. Set `PORT` or `HOST` to change the development server address. The server has no authentication and is intended for local evaluation, not direct public deployment.

Run the focused domain and provider checks with:

```sh
npm test
```

## Rate data and semantics

- The replaceable starter adapter is Frankfurter's `/v2/rates` API. It supplies daily blended reference rates from central banks and official sources; it needs no API key. The pair convention is `quote currency per one base currency`, retained with each source observation date.
- Pair rows can be reordered by dragging the grip or using the accessible earlier/later buttons. The reverse-direction action changes that row in place; customer prices stay attached to their original pair direction and are never reciprocated automatically.
- The UI labels the reference source, shows the observation date per pair and the last check time, and marks an observation stale after it is more than three calendar days old. The local server caches successful rate responses for 10 minutes. If a later fetch fails, it returns its last successful server cache with an explicit stale-cache state. The browser also retains the last response to identify a display during a server outage.
- The history section plots each board pair from daily observations over one day, one week, one month, three months, or six months. The five-minute control is unavailable because Frankfurter does not provide intraday history; an intraday provider is needed for that resolution. Daily observations can have gaps on weekends and holidays, and unsupported currency pairs are marked individually.
- Desk prices are manual customer buy/sell quotes, stored in this browser's `localStorage`. A buy quote cannot exceed its sell quote. The quick calculator can switch between available base and quote currencies, including Iranian Rial (IRR), and shows a separately labeled indicative reference conversion. When that exact pair is on the board, it also shows the customer buy/sell payout. Calculations use decimal-safe integer arithmetic and round half up to the quote currency's minor unit. Fees are not modeled.
- A Frankfurter/central-bank reference observation is not an executable customer quote. Frankfurter says its API and rates are supplied without warranty, rates can be late, missing or revised, and underlying source terms apply. Some underlying sources discourage transaction use. Review source-specific terms and obtain any rights needed for public/commercial display before operating this as a customer-facing product.

## Provider evaluation

Frankfurter is the lowest-friction candidate for this local evaluation: daily coverage across 223 currencies from 104 central banks and official sources, no API key, and no stated request quota on its public API pages. It has no stated uptime guarantee in the cited license, the feed is daily rather than intraday, and data rights flow through to each underlying provider. Those gaps mean the adapter is not a production approval.

Open Exchange Rates is a commercial alternative to evaluate: its current plan page lists 200+ currencies, hourly updates and 1,000 requests/month on its free plan; paid plans start at $12/month for hourly updates and 10,000 requests/month, with higher tiers offering more frequent updates. An App ID is required. The service terms grant use of its service under the subscription agreement, but the public materials reviewed here do not settle all downstream display/redistribution rights for a money-exchange counter. Confirm business usage, coverage, limits and any SLA with the vendor before selecting it.

Useful primary documentation:

- [Frankfurter overview](https://frankfurter.dev/)
- [Frankfurter license and provider terms](https://frankfurter.dev/license/)
- [Frankfurter API reference](https://api.frankfurter.dev/v2/openapi.json)
- [Open Exchange Rates plans](https://openexchangerates.org/signup)
- [Open Exchange Rates API authentication](https://docs.openexchangerates.org/reference/authentication)
- [ECB rate timing and transaction-use notice](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html)
