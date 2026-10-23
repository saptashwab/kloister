# ADO export fixtures

Exports from a disposable Azure DevOps Services organization, saved with Boards > Queries >
Export to CSV and kept byte for byte (UTF-8 BOM, LF line endings, no final newline), except that
the person and project names were replaced with example values.

- `agile-tree.csv`: Agile tree query (Title 1–4, Parent, dates, tags, HTML descriptions).
- `scrum-flat.csv`: Scrum flat query (single Title column).
- `basic-tree.csv`: Basic tree query.

Dates follow the exporting user's locale and time zone: day/month order, shown at 05:30 for a
date stored at midnight UTC.
