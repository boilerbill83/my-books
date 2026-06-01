<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>my-books</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <div class="app-shell">
    <header class="hero">
      <div>
        <p class="eyebrow">Goodreads-powered recommendation app</p>
        <h1>my-books</h1>
        <p class="subtitle">Import your Goodreads CSV, analyze your reading patterns, and generate 10 recommendations with Match and Confidence scores.</p>
      </div>
      <div class="hero-actions">
        <button id="toggleImportButton" class="ghost-button">Import Goodreads CSV</button>
        <button id="refreshButton" class="ghost-button">Refresh recommendations</button>
      </div>
    </header>

    <section id="statusBar" class="status-bar">Loading app data…</section>

    <section id="importSection" class="import-section hidden">
      <div class="section-heading">
        <h2>Import Goodreads CSV</h2>
        <p>Use your exported Goodreads CSV to populate the app. You can optionally save the normalized JSON back into your repo after you configure storage.js.</p>
      </div>
      <div class="import-actions">
        <input id="csvInput" type="file" accept=".csv,text/csv" />
        <button id="processCsvButton">Process file</button>
        <button id="saveRepoButton" class="ghost-button">Save imported JSON back to repo</button>
      </div>
      <p id="importStatus" class="note">No CSV imported yet.</p>
    </section>

    <section class="analytics-section">
      <div class="section-heading">
        <h2>Quick analytics</h2>
        <p>Tiles + insights only.</p>
      </div>
      <div id="analyticsTiles" class="tile-grid"></div>
      <ul id="insightsList" class="insights-list"></ul>
    </section>

    <section class="recommendations-section">
      <div class="section-heading">
        <h2>Top recommendations</h2>
        <p>Exactly 10 visible at once where possible.</p>
      </div>
      <div id="recommendationsGrid" class="card-grid"></div>
    </section>
  </div>

  <dialog id="dismissDialog" class="dismiss-dialog">
    <form method="dialog" id="dismissForm">
      <h3>Why are you dismissing this recommendation?</h3>
      <p id="dismissBookLabel"></p>
      <div class="reason-list">
        <label><input type="radio" name="dismissReason" value="already_aware_not_interested" checked /> Already aware / not interested</label>
        <label><input type="radio" name="dismissReason" value="wrong_genre_or_vibe" /> Wrong genre or vibe</label>
        <label><input type="radio" name="dismissReason" value="too_similar" /> Too similar to something I already read</label>
        <label><input type="radio" name="dismissReason" value="not_in_the_mood" /> Not in the mood right now</label>
        <label><input type="radio" name="dismissReason" value="author_or_topic_not_appealing" /> Author or topic not appealing</label>
      </div>
      <menu>
        <button value="cancel" class="ghost-button">Cancel</button>
        <button id="confirmDismissButton" value="default">Dismiss and replace</button>
      </menu>
    </form>
  </dialog>

  <script type="module" src="./app.js"></script>
</body>
</html>
