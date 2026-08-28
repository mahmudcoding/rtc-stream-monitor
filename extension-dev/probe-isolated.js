// Dev-only diagnostic. Runs in the ISOLATED world, so it cannot touch page
// globals — it reports by stamping an attribute on <html>, which both worlds
// can read. If this stamp appears on a page where the MAIN-world monitor did
// not run, then content scripts do reach the page and MAIN-world injection
// specifically is what the site is refusing.
document.documentElement.setAttribute(
  'data-rtcmon-isolated',
  'ran ' + new Date().toISOString()
);
