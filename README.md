# Counterline FX Desk

A pricing board for a currency exchange desk. It shows daily reference rates for currencies, gold, silver and crude oil, and next to them the desk's own buy and sell prices, which you enter yourself. A reference rate is never presented as a customer price, and no spread or fee is applied for you.

## Download and open

Installers are attached to each release on the repository's **Releases** page. Nothing else needs to be installed.

| Computer | File | To install |
| --- | --- | --- |
| Mac with macOS 13 or later (Apple silicon or Intel) | `Counterline-FX-Desk-<version>-mac.dmg` | Open the file and drag the app onto Applications. |
| Windows 10 or 11 | `Counterline-FX-Desk-<version>-windows-setup.exe` | Open the file. It installs for the current user and starts the app. |

The installers are not yet signed with a paid developer certificate, so the first time the app is opened the system asks for confirmation:

- **macOS** says it could not verify the app. Open **System Settings → Privacy & Security**, scroll to the message about Counterline FX Desk and choose **Open Anyway**. This is needed once.
- **Windows** shows "Windows protected your PC". Choose **More info**, then **Run anyway**.

See [Signing](#signing) for how to remove both prompts.

Desk prices, the pair list and the layout are saved on the computer the app runs on. They are not sent anywhere, and they are not shared between computers.

## What the desk gets

- **Rates board.** Reference rate, observation date and your buy and sell prices for each pair. Add any pair the reference feed lists, reverse a pair, reorder rows by dragging.
- **Margin guard.** Each desk price shows its margin against the reference rate. A buy price above the reference, a sell price below it, or a reference that has moved 0.5% or more since the prices were set is flagged, and a chip above the board counts the pairs to review. In the price dialog, **Fill both prices** sets a buy and sell price a chosen margin either side of the reference.
- **Rate sheet.** **Copy rate sheet** puts the desk's prices on the clipboard as an aligned text table for a message or a printout; it leaves the reference rates out. **CSV** downloads the same prices with their reference rates, for records.
- **Customer display.** A second window for a screen that faces customers: the desk's buy and sell prices in large type and a clock, with no reference rates or margins. It follows the main window as prices are saved, and has a full screen button.
- **Charts.** Price history for every pair on the board and for gold, silver, WTI and Brent, from five minutes to six months. Hover or tap a chart for the date and price of a point.
- **Sorting.** The chart cards and the market cards can be sorted by name (A to Z, Z to A) or by price (low to high, high to low). Chart cards can also be arranged by hand: drag a card, press and hold it on a touch screen, or focus it and use Space and the arrow keys. Doing so switches that group back to your own order, which is saved.
- **Calculator.** An indicative conversion at the reference rate and, when the pair has desk prices, what the customer pays or receives at them.

## Where the prices come from

| Prices | Source | Updated | Key needed |
| --- | --- | --- | --- |
| Currencies, gold (XAU), silver (XAG) | [Frankfurter](https://frankfurter.dev/), blended from central banks and official sources | Daily | No |
| Crude oil: WTI and Brent | [U.S. Energy Information Administration](https://www.eia.gov/dnav/pet/pet_pri_spt_s1_d.htm) daily spot prices | About weekly, a few days in arrears | No (optional, see below) |

Every figure in the app carries its source and observation date. Both sources are daily, so nothing in the app is a live market price:

- The one week to six month charts are the sources' own daily observations.
- The 5-minute and 24-hour charts for currencies and metals are **estimates**. They are drawn dashed and labelled "INTERPOLATED ESTIMATE": a repeatable random walk that ends on the latest reference rate and is sized by the pair's recent day-to-day movement. They show roughly how much a pair moves, not what it did.
- Oil has no intraday chart, because an estimate of a week-old price would mislead.
- Oil prices are always days behind the market. Each oil card and oil chart carries an amber **Delayed** tag that says how many days old its price is, counted on the viewer's own calendar.
- If a source stops answering, the last data it delivered stays on screen marked as not refreshed, and a chart with no reference price at all says it is unavailable instead of showing an invented level.

### Using these sources in a commercial product

This is a summary of what the sources publish, not legal advice. Check the linked pages before you sell or publish the app.

- **Frankfurter** states that its API is free for commercial use and that the rates themselves fall under each underlying provider's terms. It also says the service is not built for live trading. Some underlying central banks, the ECB among them, publish their reference rates for information only and discourage using them for transactions.
- **EIA** states that its publications are in the public domain and may be used and distributed, and asks for an acknowledgment with the date, which the app shows on every oil price. EIA must not be shown as endorsing a product and its logo must not be used. Note that EIA's spot price table names Refinitiv (an LSEG business) as the source of the WTI and Brent series. Ask EIA to confirm that redistributing that series in a paid product is covered before relying on it.
- **There is no free intraday feed** for currencies, metals or oil that is licensed for commercial display. Before a public launch, either remove the two estimated chart ranges or license an intraday feed for them.
- Yahoo Finance and FRED were considered and not used. Yahoo offers no official API, and the libraries that read it are unofficial and not endorsed by Yahoo, so there is no licence to rely on. FRED's terms require written consent for commercial use.

### Optional: an EIA API key

Oil works without a key, by reading EIA's public history pages. A free key from <https://www.eia.gov/opendata/> switches the app to EIA's API, which is quicker and does not depend on the layout of a web page. Put it in a text file as one line:

```
EIA_API_KEY=your-key
```

- Running from source: save the file as `.env` in the project folder (copy `.env.example`).
- Installed app: save it as `settings.env` in the app's data folder, which is `~/Library/Application Support/Counterline FX Desk` on macOS and `%APPDATA%\Counterline FX Desk` on Windows. Restart the app.

The key is sent to EIA in a request header and never appears in a URL or in the pages.

## Run from source

The server and the tests need Node.js 20 or later and no installed packages.

```sh
npm start
```

Then open <http://127.0.0.1:4173>. `PORT` and `HOST` change the address. The server has no sign-in and is meant for one computer; do not put it on the public internet as it is.

```sh
npm test
```

Without an EIA key, expect the first oil prices about ten seconds after the server starts: EIA answers scripted requests to its web pages slowly. The server starts fetching them as soon as it is up, and keeps them for six hours.

## The desktop app

The desktop app is the same pages and the same request handler in an [Electron](https://www.electronjs.org/) window. No network port is opened: the window is answered directly, under the fixed address `app://counterline`, which is also why its saved prices survive restarts. The pages get no access to Node or Electron, cannot navigate away from the app, and links to other sites open in the computer's browser. The code is in `desktop/main.mjs`.

Building it needs **Node.js 22.12 or later** (Electron's tools do not run on Node 20).

```sh
npm install        # once: installs Electron and electron-builder
npm run desktop    # open the app from this folder
npm run dist       # build the installer for this computer's system into dist/
```

On a Mac, `npm run dist` builds the `.dmg`, and `npx electron-builder --win --publish never` builds the Windows installer as well. Only the app's own files go into an installer (`electron-builder.yml` lists them); `.env` is never included.

The app keeps its settings in its own data folder, separately from any browser. Prices entered at `http://127.0.0.1:4173` do not appear in the desktop app, and the other way round.

### Releases

`.github/workflows/release.yml` builds both installers on GitHub. Set `version` in `package.json`, commit, and push a tag with the same number:

```sh
git tag v1.0.0
git push origin v1.0.0
```

The workflow runs the tests, builds the macOS disk image on a Mac and the Windows installer on Windows, and attaches both to a draft release. Publish the draft on GitHub when it looks right.

### Signing

Without signing, every customer sees the warnings described under [Download and open](#download-and-open).

- **macOS** needs an Apple Developer Program membership. With a Developer ID certificate available to the build (`CSC_LINK` and `CSC_KEY_PASSWORD`) and notarization credentials (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`), delete the `identity: "-"` line in `electron-builder.yml` and electron-builder signs and notarizes the app.
- **Windows** needs a code signing certificate, or Azure Trusted Signing. See <https://www.electron.build/code-signing>.

Before the first public release, also set `appId` in `electron-builder.yml` and `author` in `package.json` to your own. Windows treats an installer with a different `appId` as a different program, so choose it once.

### Icon

`build/icon.svg` is the drawing. `build/icon-mac.png` is that drawing exported at 1024 × 1024, and `build/icon.png` is the same drawing cropped to its rounded square (viewBox `84 84 856 856`) for Windows. Re-export both after changing the drawing; electron-builder makes the `.icns` and `.ico` files from them.

## Rate semantics

- A pair's rate is the amount of quote currency per one unit of base currency, and is kept with its observation date. An observation more than three calendar days old is marked stale.
- The server keeps a successful rates response for 10 minutes and chart history for 5 minutes. When a refresh fails it serves the last response it has, marked as such (history for up to 72 hours, oil for up to 14 days). The page also keeps the last rates it showed, so it can say what it is displaying during an outage.
- Gold and silver are US dollars per troy ounce; oil is US dollars per barrel. A market card shows the source's latest daily price and the change since the observation before it, never an estimate.
- Frankfurter rounds small rates to a few digits (USD to XAU arrives as 0.00024), so a pair quoted in a metal, or any pair whose rate is below 0.01, is fetched in the opposite direction and inverted on the server.
- Desk prices are entered by hand. A buy price cannot be higher than its sell price. Reversing a pair never converts its prices: they stay with the direction they were entered for.
- Calculations use exact decimal arithmetic and round half up to the quote currency's minor unit. Fees are not modelled.
- The server sends a browser only the pages' own files (`index.html`, `display.html`, `styles.css`, `src/app.js`, `src/display.js`, `src/domain/`, `src/ui/`). `.env`, `.git` and the server's source cannot be downloaded.

## Source documentation

- [Frankfurter overview and FAQ](https://frankfurter.dev/)
- [Frankfurter license and provider terms](https://frankfurter.dev/license/)
- [Frankfurter API reference](https://api.frankfurter.dev/v2/openapi.json)
- [ECB reference rates: timing and transaction-use notice](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html)
- [EIA WTI and Brent daily spot prices](https://www.eia.gov/dnav/pet/pet_pri_spt_s1_d.htm)
- [EIA copyrights and reuse](https://www.eia.gov/about/copyrights_reuse.php)
- [EIA API documentation and key registration](https://www.eia.gov/opendata/documentation.php)
- [FRED terms of use](https://fred.stlouisfed.org/docs/api/terms_of_use.html)
