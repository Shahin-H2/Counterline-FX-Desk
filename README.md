# Counterline FX Desk

A local, single-workspace currency reference and counter-pricing board. The board starts with common USD pairs and also lets an operator add any pair listed by the reference feed. Customer buy/sell values are separate, manually entered rates; no spread, fee, or margin is inferred.

## Run locally

Requires Node.js 18 or later. No package installation is needed.

```sh
npm start
```

Then open <http://127.0.0.1:4173>. The app binds to localhost by default. Set `PORT` or `HOST` to change the development server address. The server has no authentication and is intended for local evaluation, not direct public deployment.

The app works without any API key: currencies, gold and silver all come from Frankfurter, and the 5-minute and 24-hour charts show labelled estimates.

Twelve Data is optional and adds observed intraday data. To turn it on, copy `.env.example` to `.env` and set both values there, then restart the server:

```sh
TWELVE_DATA_API_KEY=your-key
TWELVEDATA_EXTERNAL_DISPLAY_LICENSE=confirmed
```

The server reads `.env` only. `.env.example` is a template that is committed to Git and never loaded, so a key written there does nothing and is published with the repository. Set `TWELVEDATA_EXTERNAL_DISPLAY_LICENSE=confirmed` only when the account has rights to display the data: Twelve Data's free Basic plan is for internal, non-display use. The server prints which mode it is in when it starts.

Run the domain, provider and route checks with:

```sh
npm test
```

## Rate data and semantics

- The replaceable starter adapter is Frankfurter's `/v2/rates` API. It supplies daily blended reference rates from central banks and official sources; it needs no API key. The pair convention is `quote currency per one base currency`, retained with each source observation date.
- Pair rows can be reordered by dragging the grip or using the accessible earlier/later buttons. The reverse-direction action changes that row in place; customer prices stay attached to their original pair direction and are never reciprocated automatically.
- The UI labels the reference source, shows the observation date per pair and the last check time, and marks an observation stale after it is more than three calendar days old. The local server caches successful rate responses for 10 minutes. If a later fetch fails, it returns its last successful server cache with an explicit stale-cache state. The browser also retains the last response to identify a display during a server outage.
- Every chart always draws a line, and every chart card says what its data is. The server picks the best source it has for each series, in this order:
  1. **Observed.** Twelve Data, when it is on: five one-minute observations for the 5-minute view, 24 hourly ones for the 24-hour view, and daily bars for gold and silver.
  2. **Reference.** Frankfurter's daily observations, for every daily range (one week to six months). This is the normal source for currency pairs, and for gold and silver when Twelve Data is off. No key is needed.
  3. **Last observed.** If a refresh fails or a rate limit is hit, the last series a provider delivered is kept and marked "LAST OBSERVED" (for up to 30 minutes on the 5-minute view, 6 hours on the 24-hour view, 36 hours on daily Twelve Data series, 72 hours on Frankfurter history).
  4. **Interpolated estimate.** Otherwise `generateFallbackSeries` in `server.mjs` draws an estimate: a repeatable random walk on the same time grid that ends exactly on the latest Frankfurter reference rate, sized by the pair's own recent day-to-day movement. The card is dashed and labelled "INTERPOLATED ESTIMATE", its low and high read "Est.", and its headline figure is the real reference rate. An estimate is an illustration, not observed market history.
  5. **Unavailable.** With no reference rate at all there is nothing to anchor on, and the card says so instead of inventing a price level.
- Gold (XAU) and silver (XAG) are quoted in USD per troy ounce. The quote cards show Twelve Data's latest price when it is on, and otherwise Frankfurter's daily reference price with the change since the observation before it. A quote card never shows an estimate. Both metals can be added to the pair board against USD in either direction.
- Frankfurter rounds small rates to a few digits (USD to XAU arrives as 0.00024), so a pair quoted in a metal, or any pair whose rate is below 0.01, is fetched in the opposite direction and inverted on the server.
- Twelve Data responses are cached in memory for five minutes and shared between concurrent requests. Currency pairs travel in one batched request; each metal is requested on its own, so a plan without silver still returns gold. A limiter keeps the app inside the plan's credits (8 per minute and 800 per day by default; set `TWELVE_DATA_CREDITS_PER_MINUTE` and `TWELVE_DATA_CREDITS_PER_DAY` for other plans). Series that do not fit in the current minute are served from the fallback order above, and the page asks again by itself when credits return. After an HTTP 429 nothing is sent until the minute, or the day, turns. A symbol the plan does not include is remembered for an hour instead of being asked for again. The key is sent in the `Authorization` header and never appears in a URL.
- Twelve Data's free Basic plan includes gold (XAU/USD) but not silver (XAG/USD), which needs a paid plan; silver then stays on Frankfurter. The same plan's terms cover internal, non-display use only, which is why the app also requires `TWELVEDATA_EXTERNAL_DISPLAY_LICENSE=confirmed` before it uses the key. The app does not create an account or subscribe to a plan.
- Chart cards in both history grids can be reordered like iOS widgets: drag a card with the mouse, press and hold it on a touch screen, or focus it and use Space, the arrow keys and Space again (Escape cancels). Each grid's order is saved in this browser.
- The server sends the browser only the app's own files (`index.html`, `styles.css`, `src/app.js`, `src/domain/`, `src/ui/`). `.env`, `.git` and the server source cannot be downloaded.
- Oil cards remain placeholders until an oil source is configured. The diamond card and graph were removed because the workspace does not use a universal live diamond spot price.
- Desk prices are manual customer buy/sell quotes, stored in this browser's `localStorage`. A buy quote cannot exceed its sell quote. The quick calculator can switch between available base and quote currencies, including Iranian Rial (IRR), and shows a separately labeled indicative reference conversion. When that exact pair is on the board, it also shows the customer buy/sell payout. Calculations use decimal-safe integer arithmetic and round half up to the quote currency's minor unit. Fees are not modeled.
- A Frankfurter/central-bank reference observation is not an executable customer quote. Frankfurter says its API and rates are supplied without warranty, rates can be late, missing or revised, and underlying source terms apply. Some underlying sources discourage transaction use. Review source-specific terms and obtain any rights needed for public/commercial display before operating this as a customer-facing product.

## Data provider terms

Twelve Data's Basic plan lists 8 API credits per minute and 800 per day, but its terms limit that tier to internal, non-display use. Its Business Venture plan lists external-display access and commodity data starting at $149/month. Confirm exchange and regional permissions and attribution requirements with Twelve Data before client-facing use. The app requires an explicit server-side license setting; that setting does not replace a valid vendor entitlement.

Useful primary documentation:

- [Frankfurter overview](https://frankfurter.dev/)
- [Frankfurter license and provider terms](https://frankfurter.dev/license/)
- [Frankfurter API reference](https://api.frankfurter.dev/v2/openapi.json)
- [EIA WTI and Brent daily spot prices](https://www.eia.gov/dnav/pet/PET_PRI_SPT_S1_D.htm)
- [EIA API documentation and key registration](https://www.eia.gov/opendata/documentation.php)
- [EIA copyrights and reuse](https://www.eia.gov/about/copyrights_reuse.php)
- [Twelve Data time-series API documentation](https://twelvedata.com/docs)
- [Twelve Data Forex API coverage, intervals and metals](https://support.twelvedata.com/en/articles/12520817-forex-api-v2)
- [Twelve Data business plans and external display](https://twelvedata.com/pricing-business)
- [Twelve Data commercial and personal use](https://support.twelvedata.com/en/articles/5332349-commercial-and-personal-usage)
- [Twelve Data terms of use](https://twelvedata.com/terms)
- [Twelve Data public attribution rules](https://support.twelvedata.com/en/articles/12647398-attribution-guidelines-for-using-twelve-data)
- [ECB rate timing and transaction-use notice](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html)
