// The app's words in seven languages. Each phrase is looked up by its English
// text (public/i18n/en.js lists them all); a missing translation shows the
// English. Phrases with a number have plural forms, picked with the rules of
// the language (Polish has four).
export const LANGS = { en: 'English', it: 'Italiano', fr: 'Français', es: 'Español', pt: 'Português', de: 'Deutsch', pl: 'Polski' };

export let lang = 'en';
let dict = {};
let english = {};

/** The language to use: the one chosen on this device, else the browser's, else English. */
export function pickLang() {
  try {
    const saved = localStorage.getItem('lang');
    if (LANGS[saved]) return saved;
  } catch {}
  for (const l of navigator.languages || [navigator.language || 'en']) {
    const code = String(l).slice(0, 2).toLowerCase();
    if (LANGS[code]) return code;
  }
  return 'en';
}

export async function loadLang(code) {
  lang = LANGS[code] ? code : 'en';
  english = (await import('./i18n/en.js')).default;
  dict = lang === 'en' ? english : (await import(`./i18n/${lang}.js`).catch(() => ({ default: {} }))).default;
  document.documentElement.lang = lang;
}

/** Chooses the language on this device (the page reloads to show it). */
export function saveLang(code) {
  try {
    localStorage.setItem('lang', code);
  } catch {}
}

/** The phrase in the current language, with {name} filled from `vars` (`n` picks the plural form). */
export function t(src, vars = {}) {
  let s = dict[src] ?? english[src] ?? src;
  if (s && typeof s === 'object') {
    const form = new Intl.PluralRules(lang).select(Number(vars.n) || 0);
    s = s[form] ?? s.other;
  }
  return String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** Translates the fixed words of the page: text, placeholders, titles and labels. */
export function translatePage(root = document.body) {
  if (lang === 'en') return;
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walk.nextNode(); node; node = walk.nextNode()) {
    const text = node.nodeValue.trim();
    if (text && typeof dict[text] === 'string') node.nodeValue = node.nodeValue.replace(text, dict[text]);
  }
  for (const el of root.querySelectorAll('[placeholder], [title], [aria-label]')) {
    for (const attr of ['placeholder', 'title', 'aria-label']) {
      const v = el.getAttribute(attr);
      if (v && typeof dict[v] === 'string') el.setAttribute(attr, dict[v]);
    }
  }
}
