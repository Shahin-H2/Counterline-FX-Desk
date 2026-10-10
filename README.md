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
- The currency history section keeps Frankfurter's daily observations for one week through six months. The 24-hour and five-minute controls use Twelve Data: 24 hourly points for the 24-hour view and up to five one-minute points for the five-minute window. The charts plot provider observations only and preserve gaps or unsupported pairs.
- Twelve Data supplies gold (XAU) and silver (XAG) spot prices and their history in USD per troy ounce. These metals can also be added to the pair board against USD. The API key stays on the server in `.env`, never in browser code.
- The app requires both `TWELVEDATA_API_KEY` and `TWELVEDATA_EXTERNAL_DISPLAY_LICENSE=confirmed` before returning Twelve Data values. Current Twelve Data terms describe its free Basic plan as internal non-display use; public client display needs an eligible business tier or separate written rights. The code defaults to an unavailable state until both settings exist. No API account, key, plan, or charge has been created.
- Oil cards remain placeholders until an oil source is configured. The diamond card and graph were removed because the workspace does not use a universal live diamond spot price.
- Desk prices are manual customer buy/sell quotes, stored in this browser's `localStorage`. A buy quote cannot exceed its sell quote. The quick calculator can switch between available base and quote currencies, including Iranian Rial (IRR), and shows a separately labeled indicative reference conversion. When that exact pair is on the board, it also shows the customer buy/sell payout. Calculations use decimal-safe integer arithmetic and round half up to the quote currency's minor unit. Fees are not modeled.
- A Frankfurter/central-bank reference observation is not an executable customer quote. Frankfurter says its API and rates are supplied without warranty, rates can be late, missing or revised, and underlying source terms apply. Some underlying sources discourage transaction use. Review source-specific terms and obtain any rights needed for public/commercial display before operating this as a customer-facing product.

## Data provider terms

Twelve Data's Basic plan lists 800 API requests per day, but its terms limit that tier to internal, non-display use. Its Business Venture plan lists external-display access and commodity data starting at $149/month. Confirm exchange and regional permissions and attribution requirements with Twelve Data before client-facing use. The app requires an explicit server-side license setting; that setting does not replace a valid vendor entitlement.

Useful primary documentation:

- [Frankfurter overview](https://frankfurter.dev/)
- [Frankfurter license and provider terms](https://frankfurter.dev/license/)
- [Frankfurter API reference](https://api.frankfurter.dev/v2/openapi.json)
- [EIA WTI and Brent daily spot prices](https://www.eia.gov/dnav/pet/PET_PRI_SPT_S1_D.htm)
- [EIA API documentation and key registration](https://www.eia.gov/opendata/documentation.php)
- [EIA copyrights and reuse](https://www.eia.gov/about/copyrights_reuse.php)
- [GoldAPI.io plans and supported metals](https://www.goldapi.io/price/XAU/USD/free)
- [GoldAPI.io end-user data terms](https://www.goldapi.io/kb/tos)
- [Alpha Vantage FX intraday API documentation](https://www.alphavantage.co/documentation/)
- [Alpha Vantage terms of service](https://www.alphavantage.co/terms_of_service/)
- [Rapaport Diamond Price List and licensing](https://rapaport.com/diamond-price-list/)
- [Open Exchange Rates plans](https://openexchangerates.org/signup)
- [Open Exchange Rates API authentication](https://docs.openexchangerates.org/reference/authentication)
- [ECB rate timing and transaction-use notice](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html)
