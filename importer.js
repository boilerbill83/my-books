
// Goodreads CSV parser.
// parseCsv(text)            → array of raw row objects keyed by header name
// transformGoodreadsRows(rows) → goodreadsData.json-compatible object

export function parseCsv(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length < 2) throw new Error('CSV appears empty or has only a header row');

  const headers = splitCsvLine(lines[0]).map(h => h.trim());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = splitCsvLine(line);
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (values[idx] ?? '').trim(); });
    rows.push(obj);
  }

  return rows;
}

// RFC-4180-aware CSV line splitter
function splitCsvLine(line) {
  const result = [];
  let current  = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch   = line[i];
    const next = line[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// Map a Goodreads CSV header to a normalised field name
function mapHeader(raw) {
  const map = {
    'Book Id':             'bookId',
    'book_id':             'bookId',
    'Title':               'title',
    'title':               'title',
    'Author':              'author',
    'author':              'author',
    'Author l-f':          'author',
    'My Rating':           'myRating',
    'my_rating':           'myRating',
    'Average Rating':      'avgRating',
    'average_rating':      'avgRating',
    'Number of Pages':     'pages',
    'num_pages':           'pages',
    '# of Pages':          'pages',
    'Exclusive Shelf':     'shelf',
    'exclusive_shelf':     'shelf',
    'Bookshelves':         'shelves',
    'bookshelves':         'shelves',
    'Date Read':           'dateRead',
    'date_read':           'dateRead',
    'Date Added':          'dateAdded',
    'date_added':          'dateAdded',
    'ISBN':                'isbn',
    'ISBN13':              'isbn13',
    'Publisher':           'publisher',
    'Year Published':      'yearPublished',
    'Original Publication Year': 'yearOriginal',
    'My Review':           'myReview',
    'Read Count':          'readCount',
    'Owned Copies':        'ownedCopies'
  };
  return map[raw] || null;
}

function normaliseShelf(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (s === 'read')               return 'read';
  if (s === 'to-read')            return 'to-read';
  if (s === 'currently-reading')  return 'currently-reading';
  return s || 'other';
}

function bookKey(title, author) {
  const norm = v => String(v || '')
    .replace(/&amp;/gi, '&')
    .toLowerCase().trim()
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `${norm(title)}|${norm(author)}`;
}

export function transformGoodreadsRows(rows) {
  const books = rows
    .map(row => {
      // Build a normalised row from whatever header names Goodreads exports
      const n = {};
      for (const [k, v] of Object.entries(row)) {
        const mapped = mapHeader(k);
        if (mapped) n[mapped] = v;
      }

      const title  = n.title  || '';
      const author = n.author || '';
      if (!title) return null;

      const shelf     = normaliseShelf(n.shelf || n.shelves);
      const myRating  = parseInt(n.myRating, 10)  || 0;
      const avgRating = parseFloat(n.avgRating)    || 0;
      const pages     = parseInt(n.pages, 10)      || null;

      return {
        bookKey:   bookKey(title, author),
        bookId:    n.bookId   || null,
        title,
        author,
        shelf,
        myRating,
        avgRating,
        pages:     Number.isFinite(pages) ? pages : null,
        dateRead:  n.dateRead  || null,
        dateAdded: n.dateAdded || null,
        isbn:      n.isbn      || null,
        isbn13:    n.isbn13    || null,
        publisher: n.publisher || null,
        year:      parseInt(n.yearPublished || n.yearOriginal, 10) || null
      };
    })
    .filter(Boolean);

  const readBooks      = books.filter(b => b.shelf === 'read');
  const toReadBooks    = books.filter(b => b.shelf === 'to-read');
  const currentlyBooks = books.filter(b => b.shelf === 'currently-reading');
  const fiveStar       = readBooks.filter(b => b.myRating === 5);

  const now = new Date().toISOString();

  return {
    meta: {
      sourceFile:            null,
      generatedAt:           now,
      bookCount:             books.length,
      readCount:             readBooks.length,
      toReadCount:           toReadBooks.length,
      currentlyReadingCount: currentlyBooks.length,
      fiveStarCount:         fiveStar.length,
      notes:                 'Imported via in-browser CSV parser.'
    },
    books,
    indexes: {
      read:             readBooks.map(b => b.bookKey),
      toRead:           toReadBooks.map(b => b.bookKey),
      currentlyReading: currentlyBooks.map(b => b.bookKey),
      fiveStar:         fiveStar.map(b => b.bookKey)
    }
  };
}
