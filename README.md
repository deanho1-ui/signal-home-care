# Book Series Website

A clean, elegant static website for a book series — a landing page plus a
dedicated page for each book. No server or build step: it's plain HTML/CSS/JS
that reads all its content from a single data file, so it hosts for free on
**GitHub Pages**.

- **Edit one file:** [`data/books.json`](data/books.json) holds everything —
  series name, author bio, and each book's title, blurb, cover, and buy link.
- **Add a book:** copy an entry in the `books` array and drop a cover image in
  `assets/covers/`.
- **Design:** an elegant, literary theme (warm paper, serif type) in
  [`assets/styles.css`](assets/styles.css).

---

## Fill in your content

Open [`data/books.json`](data/books.json) and replace every placeholder
(anything in `[brackets]`) with your real details:

- **`series`** — the series name, tagline, description, and your author bio.
- **`books`** — one entry per book. The important fields:
  - `title`, `number`, `blurb` (the back-cover synopsis)
  - `status` — `"available"` or `"coming-soon"`
  - `cover` — path to the cover image (e.g. `assets/covers/book-one.jpg`);
    leave `""` for an elegant placeholder
  - `buyUrl` — your Amazon (or other retailer) link
  - `formats` — e.g. `["Kindle", "Paperback"]`
  - Optional: `subtitle`, `releaseDate`, `quote` + `quoteSource` (a review
    blurb), `excerpt` (a sample passage; separate paragraphs with blank lines)

The first book in the array is featured in the home-page hero.

### Cover images

Put image files in `assets/covers/` and point each book's `cover` field at
them. Portrait images around 1000 × 1500 px (a 2:3 ratio) look best.

### Newsletter (optional)

Set `series.newsletterEnabled` to `true`/`false`. To actually collect signups,
paste the form-action URL from a provider (Mailchimp, Buttondown, ConvertKit,
etc.) into `series.newsletterActionUrl`. Left blank, the form just shows a
thank-you message.

---

## Publish it (GitHub Pages, free)

1. Push these files to your repo (this branch, or `main`).
2. **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   pick the branch and `/(root)`, then **Save**.
3. Your site goes live at `https://<your-username>.github.io/<repo>/` in a
   minute or two. (A custom domain can be added on the same Pages screen.)

---

## Preview locally

Because the pages read `data/books.json` with `fetch`, open them through a
local server rather than double-clicking the file:

```bash
npx serve .        # then open the printed URL
# or
python3 -m http.server
```
