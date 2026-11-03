# Import folder

Put the Google Sheet export here (File → Download → Microsoft Excel (.xlsx)).
Everything in this folder except this README is ignored by git, so customer data never gets uploaded.

Then run, from the project folder:

    npm run import-sheet

That is a dry run: it saves nothing and prints (and saves to `import/last-dry-run.txt`) what it would import
and every problem row. When it looks right:

    npm run import-sheet -- --commit

See the top of `scripts/import-sheet.ts` for all options.
