/* ------------------------------------------------------------------
   Reads data/books.json and renders the landing page and book pages.
   Add or edit books by editing data/books.json only.
------------------------------------------------------------------ */
(function () {
  "use strict";

  var esc = function (s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  };

  // Turn "\n\n"-separated text into paragraphs.
  var paras = function (text) {
    if (!text) return "";
    return String(text).split(/\n\s*\n/).map(function (p) {
      return "<p>" + esc(p.trim()).replace(/\n/g, "<br>") + "</p>";
    }).join("");
  };

  var setText = function (attr, value) {
    document.querySelectorAll("[" + attr + "]").forEach(function (el) {
      el.textContent = value;
    });
  };

  var coverHTML = function (book) {
    if (book && book.cover) {
      return '<div class="cover"><img src="' + esc(book.cover) + '" alt="Cover of ' +
        esc(book.title) + '" loading="lazy"></div>';
    }
    var label = book ? book.title : "";
    return '<div class="cover placeholder"><div class="ph">' +
      '<div class="no">&#10086;</div>' + esc(label) + '</div></div>';
  };

  var buyLabel = function (book) {
    return book.status === "coming-soon" ? "Coming Soon" : "Buy the Book";
  };

  var statusLabel = function (s) {
    return s === "coming-soon" ? "Coming Soon" : "Available Now";
  };

  var SOCIAL_LABELS = {
    instagram: "Instagram", x: "X", tiktok: "TikTok",
    goodreads: "Goodreads", facebook: "Facebook"
  };

  function renderShared(data) {
    var s = data.series || {};
    setText("data-series-name", s.name || "Book Series");
    setText("data-author-name", s.author || "");
    setText("data-year", new Date().getFullYear());
    document.title = (s.name || "Book Series");

    // Socials
    var socials = s.socials || {};
    var links = Object.keys(SOCIAL_LABELS).filter(function (k) {
      return socials[k];
    }).map(function (k) {
      return '<a href="' + esc(socials[k]) + '" target="_blank" rel="noopener">' +
        SOCIAL_LABELS[k] + "</a>";
    }).join("");
    document.querySelectorAll("[data-socials]").forEach(function (el) {
      el.innerHTML = links;
    });

    // Hide newsletter nav if disabled
    if (!s.newsletterEnabled) {
      document.querySelectorAll("[data-newsletter-nav]").forEach(function (el) {
        el.style.display = "none";
      });
    }
  }

  function renderHome(data) {
    var s = data.series || {};
    var books = data.books || [];
    var featured = books[0];

    setText("data-series-tagline", s.tagline || "");
    setText("data-series-description", s.description || "");
    setText("data-author-bio", "");
    document.querySelectorAll("[data-author-bio]").forEach(function (el) {
      el.innerHTML = paras(s.authorBio);
    });

    // Author photo
    var ap = document.querySelector("[data-author-photo]");
    if (ap) {
      if (s.authorPhoto) {
        ap.innerHTML = '<img class="author-photo" src="' + esc(s.authorPhoto) +
          '" alt="' + esc(s.author) + '">';
      } else {
        var initial = (s.author || "?").trim().charAt(0);
        ap.innerHTML = '<div class="author-photo placeholder">' + esc(initial) + "</div>";
      }
    }

    // Featured book (hero)
    if (featured) {
      setText("data-featured-title", featured.title);
      var fb = document.querySelector("[data-featured-blurb]");
      if (fb) fb.innerHTML = paras(featured.blurb);
      var fc = document.querySelector("[data-featured-cover]");
      if (fc) {
        fc.innerHTML = '<a href="book.html?book=' + encodeURIComponent(featured.slug) + '">' +
          coverHTML(featured) + "</a>";
      }
      var fa = document.querySelector("[data-featured-actions]");
      if (fa) {
        var html = '<a class="btn ghost" href="book.html?book=' +
          encodeURIComponent(featured.slug) + '">Read More</a>';
        if (featured.buyUrl) {
          html = '<a class="btn solid" href="' + esc(featured.buyUrl) +
            '" target="_blank" rel="noopener">' + buyLabel(featured) + "</a>" + html;
        }
        fa.innerHTML = html;
      }
    }

    // Book list
    var list = document.querySelector("[data-book-list]");
    if (list) {
      list.innerHTML = books.map(function (b) {
        return '<a class="book-card reveal" href="book.html?book=' +
          encodeURIComponent(b.slug) + '">' +
          coverHTML(b) +
          '<span class="meta">Book ' + esc(b.number) + "</span>" +
          "<h3>" + esc(b.title) + "</h3>" +
          '<span class="badge ' + esc(b.status || "available") + '">' +
          statusLabel(b.status) + "</span>" +
          "</a>";
      }).join("");
    }

    // Newsletter
    if (s.newsletterEnabled) {
      var nl = document.querySelector("[data-newsletter]");
      if (nl) nl.hidden = false;
      setText("data-newsletter-blurb", s.newsletterBlurb || "");
      var form = document.querySelector("[data-newsletter-form]");
      if (form) {
        if (s.newsletterActionUrl) {
          form.setAttribute("action", s.newsletterActionUrl);
          form.setAttribute("method", "post");
          form.setAttribute("target", "_blank");
        } else {
          form.addEventListener("submit", function (e) {
            e.preventDefault();
            form.innerHTML = '<p class="lead" style="font-style:normal">' +
              "Thank you! (Connect a mailing-list provider in data/books.json " +
              'to collect real signups.)</p>';
          });
        }
      }
    }

    revealOnScroll();
  }

  function renderBook(data) {
    var books = data.books || [];
    var s = data.series || {};
    var slug = new URLSearchParams(location.search).get("book");
    var book = books.filter(function (b) { return b.slug === slug; })[0] || books[0];

    if (!book) {
      document.querySelector("[data-book-hero] .wrap").innerHTML =
        '<h1>Book not found</h1><p><a href="index.html">Return home</a></p>';
      return;
    }

    document.title = book.title + " — " + (s.name || "Book Series");
    setText("data-book-eyebrow", s.name ? s.name + "  ·  Book " + book.number : "Book " + book.number);
    setText("data-book-title", book.title);
    setText("data-book-subtitle", book.subtitle || "");
    setText("data-book-release",
      book.status === "coming-soon"
        ? (book.releaseDate ? "Coming " + book.releaseDate : "Coming soon")
        : (book.releaseDate || ""));

    document.querySelector("[data-book-cover]").innerHTML = coverHTML(book);
    document.querySelector("[data-book-blurb]").innerHTML = paras(book.blurb);

    // Formats
    var fmt = document.querySelector("[data-book-formats]");
    if (fmt) {
      fmt.innerHTML = (book.formats || []).map(function (f) {
        return '<span class="format-chip">' + esc(f) + "</span>";
      }).join("");
    }

    // Actions
    var actions = document.querySelector("[data-book-actions]");
    if (actions && book.buyUrl) {
      actions.innerHTML = '<a class="btn solid" href="' + esc(book.buyUrl) +
        '" target="_blank" rel="noopener">' + buyLabel(book) + "</a>";
    }

    // Quote
    if (book.quote) {
      document.querySelector("[data-book-quote-section]").hidden = false;
      setText("data-book-quote", "“" + book.quote + "”");
      setText("data-book-quote-source", book.quoteSource || "");
    }

    // Excerpt
    if (book.excerpt) {
      document.querySelector("[data-book-excerpt-section]").hidden = false;
      document.querySelector("[data-book-excerpt]").innerHTML = paras(book.excerpt);
    }
  }

  function revealOnScroll() {
    var els = document.querySelectorAll(".reveal");
    if (!("IntersectionObserver" in window)) {
      els.forEach(function (el) { el.classList.add("in"); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
      });
    }, { threshold: 0.15 });
    els.forEach(function (el) { io.observe(el); });
  }

  function boot() {
    fetch("data/books.json", { cache: "no-cache" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        renderShared(data);
        if (document.querySelector("[data-book-hero]")) renderBook(data);
        else renderHome(data);
      })
      .catch(function (err) {
        var main = document.querySelector("main");
        if (main) {
          main.innerHTML =
            '<section class="wrap narrow" style="padding-top:80px">' +
            "<h1>Couldn't load the site data</h1>" +
            "<p>The page reads <code>data/books.json</code>. If you're opening " +
            "this file directly from disk, your browser may block that read — " +
            "run a local server instead (see the README) or view it on the " +
            "published site.</p><p class=\"meta\">" + esc(err.message) + "</p></section>";
        }
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
