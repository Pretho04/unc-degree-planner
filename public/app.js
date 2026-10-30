// UNC Minor Planner - all parsing/evaluation happens here; server.ps1 only proxies.
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const parser = new DOMParser();

function load(k, d) { try { const v = localStorage.getItem('mp_' + k); return v ? JSON.parse(v) : d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem('mp_' + k, JSON.stringify(v)); } catch { } }

const state = {
  taken: load('taken', []),
  manual: load('manual', {}),   // slug -> { groupIndex: true } for requirements the user marks done by hand
  term: load('term', ''),
  terms: [],
  subjects: new Set(),
  minors: [],
  parsed: {},
  scanned: false,
  current: null,
};
const courseCache = {};
const seatCache = {};

// ---------- helpers ----------
const clean = s => (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const base = code => code.replace(/(\d)H$/, '$1');   // honors sections count as the regular course
const num = code => parseInt(code.split(' ')[1], 10);
function parseCodes(text) {
  return [...clean(text).toUpperCase().matchAll(/\b([A-Z]{2,5})\s?(\d{2,3}[A-Z]{0,2})\b/g)]
    .filter(m => !state.subjects.size || state.subjects.has(m[1]))
    .map(m => `${m[1]} ${m[2]}`);
}
// "ANTH/LING 520" -> [ANTH 520, LING 520]; "CMPL/GSLL 270/JWST 239" -> [CMPL 270, GSLL 270, JWST 239]
function crossList(text) {
  const t = clean(text).toUpperCase();
  const m = t.match(/^(?:[A-Z]{2,5}(?:\s?\d{2,3}[A-Z]{0,2})?\s?\/\s?)+[A-Z]{2,5}\s?\d{2,3}[A-Z]{0,2}/);
  if (!m) return parseCodes(t);
  const out = [];
  let pending = [];
  for (const part of m[0].split('/')) {
    const p = part.trim().match(/^([A-Z]{2,5})(?:\s?(\d{2,3}[A-Z]{0,2}))?$/);
    if (!p) continue;
    pending.push(p[1]);
    if (p[2]) { pending.forEach(s => out.push(`${s} ${p[2]}`)); pending = []; }
  }
  return out;
}
const takenBases = () => new Set(state.taken.map(base));
const isTaken = code => takenBases().has(base(code));

async function api(path) {
  const r = await fetch(path);
  const text = await r.text();
  if (!r.ok) throw new Error(text || `HTTP ${r.status}`);
  return text;
}

// Run async jobs with limited parallelism (the local server handles one at a time anyway).
async function pool(items, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => { while (i < items.length) await fn(items[i++]); }));
}

// ---------- catalog: minors list + requirement parsing ----------
async function loadPrograms() {
  const html = await api('/api/catalog?path=' + encodeURIComponent('/undergraduate/programs-study/'));
  const doc = parser.parseFromString(html, 'text/html');
  const seen = new Map();
  doc.querySelectorAll('a[href]').forEach(a => {
    const m = a.getAttribute('href').match(/^(?:https?:\/\/catalog\.unc\.edu)?\/undergraduate\/programs-study\/([a-z0-9-]+)\/?$/);
    if (!m || seen.has(m[1])) return;
    const name = clean(a.textContent);
    // Majors include their concentrations/tracks ("Biology Major, B.S.–Quantitative Biology Track").
    const type = m[1].endsWith('-minor') ? 'minor' : /\bMajor\b/.test(name) ? 'major' : null;
    if (type) seen.set(m[1], { slug: m[1], name, type });
  });
  state.programs = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
const typeFilter = () => $('#type-filter').value;
const ofType = p => typeFilter() === 'all' || p.type === typeFilter();

const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
// How many courses a comment row asks for: a number, 'all', or null if it doesn't say.
function parseCount(text) {
  const t = text.toLowerCase();
  const N = '(one|two|three|four|five|six|seven|eight|nine|ten|\\d{1,2})';
  // "Nine (9) additional credits…" / "9 credits from…": credits, about three per course.
  const cr = t.match(new RegExp(`\\b${N}\\b(?:\\s*\\(\\d+\\))?\\s+(?:additional\\s+)?(?:credit|hour)`));
  if (cr) return Math.max(1, Math.round((WORDS[cr[1]] || parseInt(cr[1], 10)) / 3));
  // The count is the number right before "courses" ("Five history (HIST) courses", "Four (4) courses")
  // or after "select" ("Practical-based courses (select three)") - not any number in the sentence.
  let m = t.match(new RegExp(`\\b${N}\\b(?!\\s*(?:\\(\\d+\\)\\s*)?(?:credit|hour))(?:\\s+\\(\\d+\\))?(?:\\s+\\S+){0,5}?\\s+(?:courses?|coures|electives?|classes|of the following)\\b`))
    || t.match(new RegExp(`\\b(?:select|choose|take|complete)(?:\\s+at least)?\\s+${N}\\b`));
  if (m) return WORDS[m[1]] || parseInt(m[1], 10);
  m = t.match(/(\d{1,2})\s*(?:credit\s*)?(?:hours?|credits?)/);
  if (m) return Math.max(1, Math.round(parseInt(m[1], 10) / 3));
  if (/\b(all|each|both)\b|required/.test(t)) return 'all';
  if (/one of/.test(t)) return 1;
  if (/following|choose|select/.test(t)) return 'pick';   // no number given; finalizeGroups uses the hours column
  return null;
}

// "COMP courses 420 or greater excluding COMP 495", "Five history (HIST) courses", "Any course numbered above MATH 500"
// `fallbackSubjects`: for level-only wording ("One course numbered above 400"), the subjects to assume.
function parseRule(text, fallbackSubjects = null) {
  const [main, excl = ''] = text.split(/\bexcluding\b|\bexcept\b|\bother than\b|\bnot including\b/i);
  // "Five ECON courses at the 400, 500, or 600 level, with at least two numbered 500 or higher":
  // the level that applies to every course is in the main clause, before "with at least…".
  const core = main.split(/,?\s*(?:with|including)\s+(?:at least\s+)?(?:one|two|three|four|five|\(?\d+\)?)\b|,?\s*with at least\b|\(at least\b|,\s*at least\b|\bat least \S+ of which\b/i)[0];
  const subjectsIn = s => [...new Set((s.match(/\b[A-Z]{2,5}\b/g) || []).filter(x => state.subjects.has(x)))];
  const subjects = subjectsIn(core).length ? subjectsIn(core) : subjectsIn(main);
  const exclude = parseCodes(excl).map(base);
  if (!subjects.length) {
    const lv = parseLevels(core);
    if (!fallbackSubjects?.length || (lv.min == null && lv.max == null && !/\bat any level\b/i.test(core))) return null;
    return { subjects: fallbackSubjects, ...lv, exclude, text, inferred: true };
  }
  // "Any CLAR or CLAS course numbered above 132 or any GREK or LATN course": each part has its own level.
  // A part that names specific courses and no level ("from CHEM 395 or any…") means just those courses.
  const parts = core.split(/\bor any\b/i).map(s => {
    const lv = parseLevels(s), codes = parseCodes(s);
    return lv.min == null && lv.max == null && codes.length ? { subjects: subjectsIn(s), codes: codes.map(base) } : { subjects: subjectsIn(s), ...lv };
  }).filter(p => p.subjects.length);
  if (parts.length > 1) return { subjects, min: null, max: null, any: parts, exclude, text };
  return { subjects, ...parseLevels(core), exclude, text };
}

// "…with at least two (2) at or above the 200 level" / "…at least two of which must be at the 400-level or above":
// a quota on the courses counted for a requirement. Returns { n, min, max } or null.
function parseQuota(text) {
  const m = text.match(/\bat least\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b(?:\s*\(\d+\))?([^.;]*)/i);
  if (!m) return null;
  const rest = m[2].replace(/^\s*(?:\(\s*out of \d+\s*\)|of (?:which|these|them|the \S+))\s*/i, '');
  if (/^\s*(?:different\s+|distinct\s+|academic\s+)*(?:departments?|subject codes?|disciplines?)\b/i.test(rest)) return null;   // a department minimum, not a quota
  // Level ("at or above the 200 level") and/or subject ("must be AAAD classes").
  const lv = parseLevels(rest);
  const subjects = [...new Set((rest.match(/\b[A-Z]{2,5}\b/g) || []).filter(s => state.subjects.has(s)))];
  const bySubject = subjects.length && lv.min == null && lv.max == null;
  if (!bySubject && lv.min == null && lv.max == null) return null;
  const n = WORDS[m[1].toLowerCase()] || parseInt(m[1], 10);
  // "at least 9 credits from courses numbered 400 and above" = 3 courses
  return { n: /^\s*(?:credit|hour)/i.test(rest) ? Math.max(1, Math.round(n / 3)) : n, ...lv, subjects: bySubject ? subjects : null };
}
const inLevel = (code, q) => { const n = num(code); return (q.min == null || n >= q.min) && (q.max == null || n <= q.max); };
const inQuota = (code, q) => (!q.subjects || q.subjects.includes(code.split(' ')[0])) && inLevel(code, q);
const fmtQuota = q => q.subjects ? q.subjects.join('/') + (q.min != null || q.max != null ? ' ' + fmtLevel(q) : '') : `at ${fmtLevel(q)}`;

// Departments that use more than one subject code, for "from at least three academic departments".
// "Different subject codes" wording counts codes as-is.
const DEPARTMENTS = [
  ['PSYC', 'NSCI'], ['CLAR', 'CLAS', 'GREK', 'LATN'], ['ENGL', 'CMPL'], ['ARTH', 'ARTS'],
  ['FREN', 'ITAL', 'PORT', 'SPAN', 'ROML'], ['GERM', 'GSLL', 'RUSS', 'PLSH', 'CZCH', 'SLAV', 'BCS', 'DTCH'],
  ['ASIA', 'ARAB', 'CHIN', 'JAPN', 'KOR', 'HEBR', 'HNUR', 'PRSN', 'TURK', 'VIET'],
];
const DEPT_OF = new Map(DEPARTMENTS.flatMap(d => d.map(s => [s, d[0]])));
const deptOf = subject => DEPT_OF.get(subject) || subject;

// "from at least two (different) departments", "distributed over at least three academic departments",
// "representing at least three different subject codes" -> { n, by: 'dept' | 'subject' }
function parseMinDepts(text) {
  const m = text.match(/at least\s+(one|two|three|four|five|\d+)\s+(?:different\s+|distinct\s+|academic\s+)*(departments?|subject codes?|disciplines?)\b/i);
  return m ? { n: WORDS[m[1].toLowerCase()] || parseInt(m[1], 10), by: /subject/i.test(m[2]) ? 'subject' : 'dept' } : null;
}

// "with no more than two courses from other departments": at least need - 2 must come from the program's own department.
// The program's own department is the one most of its required courses come from (COMP for CS B.A.).
function parseOutsideCap(text, g, all) {
  const m = text.match(/no more than\s+(one|two|three|four|five|\d+)\s+(?:courses?\s+)?(?:from|in)\s+other\s+departments?/i);
  if (!m) return null;
  const counts = new Map();
  const required = all.filter(x => x.required);
  (required.length ? required : [g]).forEach(x => x.options.forEach(o => o.alts?.forEach(a => a.codes.forEach(c => { const d = deptOf(c.split(' ')[0]); counts.set(d, (counts.get(d) || 0) + 1); }))));
  const home = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!home) return null;
  const subjects = DEPARTMENTS.find(d => d[0] === home) || [home];
  return { n: Math.max(0, g.need - (WORDS[m[1].toLowerCase()] || parseInt(m[1], 10))), subjects, min: null, max: null };
}

// Course-number bounds from catalog wording. "above/beyond/over/higher than N" is strict (> N);
// "N or above/higher", "at or above N" and "N and higher" include N; "at the N level" is N–N+99.
function parseLevels(t) {
  const S = '(?:[A-Z]{2,5}\\s+)?', N = '(\\d{2,3})[A-Z]{0,2}\\b';
  const re = s => new RegExp(s, 'i');
  let m, min = null, max = null;
  if ((m = t.match(re(`between\\s+${S}${N}\\s*(?:and|-|–|to)\\s*${S}${N}`)))) return { min: +m[1], max: +m[2] };
  if ((m = t.match(re(`\\b(\\d{3})(?:,\\s*\\d{3})*,?\\s+(?:or|and)\\s+(\\d{3})[- ]levels?`)))) return { min: +m[1], max: +m[2] + 99 };
  // Ranges need full course numbers ("050-300", "401 - 492"), not "last two digits from 30 to 99".
  if ((m = t.match(re(`${S}(\\d{3})[A-Z]{0,2}\\s*(?:-|–|to|through)\\s*${S}(\\d{3})[A-Z]{0,2}\\b(?!\\s*(?:credit|hour))`)))) return { min: +m[1], max: +m[2] };
  if ((m = t.match(re(`(?:at or above|at or higher than|no lower than)\\s+(?:the\\s+)?${S}${N}`)))
    || (m = t.match(re(`${N}(?:\\s*-?\\s*level)?\\s*(?:or|and)\\s*(?:above|higher|greater|beyond|up)`)))) min = +m[1];
  else if ((m = t.match(re(`(?:above|higher than|greater than|beyond|over)\\s+(?:the\\s+)?${S}${N}`)))) min = +m[1] + 1;
  else if ((m = t.match(re(`(?:at the\\s+)?${N}[- ]level`)))) return { min: +m[1], max: +m[1] + 99 };
  if ((m = t.match(re(`(?:below|under|lower than)\\s+(?:the\\s+)?${S}${N}`)))) max = +m[1] - 1;
  else if ((m = t.match(re(`${N}(?:\\s*-?\\s*level)?\\s*(?:or|and)\\s*(?:below|lower|under)`)))) max = +m[1];
  return { min, max };
}
function matchesRule(code, rule) {
  const [subj] = code.split(' ');
  const n = num(code);
  const fits = r => r.codes ? r.codes.includes(base(code))
    : r.subjects.includes(subj) && (r.min == null || n >= r.min) && (r.max == null || n <= r.max);
  return (rule.any ? rule.any.some(fits) : fits(rule)) && !rule.exclude.includes(base(code));
}
const looksLikeRule = t => /numbered|or greater|or higher|or above|(?:above|beyond|over) (?:[a-z]{2,5}\s+)?\d{2,3}|\d{3}[- ]level/i.test(t)
  || /\b[A-Z]{2,5} (?:courses?|electives?)\b|\([A-Z]{2,5}\) courses|courses? in [A-Z]{2,5}\b/.test(t);

// `variants` collects "Choose one emphasis" blocks (Classics: Greek Emphasis / Latin Emphasis); each becomes an option.
function parseTable(table, groups, variants = null) {
  let section = '', cur = null, last = null, target = groups, inVariants = false;
  for (const tr of table.querySelectorAll('tr')) {
    if (tr.closest('thead') || tr.classList.contains('listsum') || tr.classList.contains('hidden')) continue;
    const codecol = tr.querySelector('td.codecol');
    const comment = tr.querySelector('.courselistcomment');
    const indented = !!tr.querySelector('.blockindent');
    const hours = clean(tr.querySelector('td.hourscol')?.textContent);
    if (tr.classList.contains('areaheader') || tr.querySelector('.areaheader')) {
      const text = clean((comment || tr.querySelector('td'))?.textContent);
      if (inVariants) {
        if (/emphasis|track|option|concentration|focus/i.test(text)) {
          const v = { name: text, groups: [] };
          variants.push(v); target = v.groups; section = text; cur = last = null;
          continue;
        }
        inVariants = false; target = groups;   // a regular header ("Additional Requirements") ends the choice
      }
      if (indented && cur) continue;   // sub-heading inside a group ("Psychology and Neuroscience:")
      // "Select one course from either A or B" followed by headers A and B: one group spans both.
      if (cur && (cur.spans || (!cur.options.length && !looksLikeRule(cur.label)))) { cur.spans = true; cur.indent = null; continue; }
      const count = parseCount(text);
      if (typeof count === 'number') { cur = { section: text, label: text, count, need: count, hours, options: [], indent: null }; target.push(cur); }
      else { section = text; cur = null; }
      last = null;
      continue;
    }

    if (comment) {
      const text = clean(comment.textContent);
      if (variants && !indented && /^choose one (?:emphasis|track|option|concentration|area|focus)/i.test(text)) {
        inVariants = true; cur = last = null;
        continue;
      }
      // An option written as prose inside a group - unless it's a sibling requirement with its own count
      // ("Five Greek courses above GREK 203" then "Two Latin courses above LATN 203").
      if (indented && cur && !(typeof parseCount(text) === 'number' && !cur.options.length)) {
        const opt = looksLikeRule(text) && parseRule(text)
          ? { rule: parseRule(text), label: text }
          : parseCodes(text).length ? { alts: [{ codes: parseCodes(text), title: text }] } : null;
        if (opt) { cur.options.push(opt); last = opt.alts ? opt : null; }
        continue;
      }
      const count = parseCount(text);
      if (cur && cur.options.length && count == null && looksLikeRule(text) && parseRule(text)) {
        cur.options.push({ rule: parseRule(text), label: text });   // "Any PLCY course at the 100 level or above…"
        continue;
      }
      cur = { section, label: text, count, need: count, hours, options: [], indent: null };
      target.push(cur); last = null;
      continue;
    }
    if (!codecol) continue;
    // Each link is one course, possibly cross-listed ("ANTH/LING 520" = either code).
    const linked = [...codecol.querySelectorAll('a')].map(a => crossList(a.textContent)).filter(l => l.length);
    const titleCell = tr.querySelectorAll('td')[1]?.cloneNode(true);
    titleCell?.querySelectorAll('sup').forEach(s => s.remove());
    const title = clean(titleCell?.textContent);
    let alts;
    if (linked.length === 1) alts = linked[0].map(c => ({ codes: [c], title }));
    else if (linked.length > 1) alts = [{ codes: linked.map(l => l[0]), title }];   // "BIOL 271 & 271L": take all
    else {
      const codes = crossList(codecol.textContent);
      if (!codes.length) continue;
      alts = [{ codes, title }];
    }
    const isOr = tr.classList.contains('orclass') || /^or\b/i.test(clean(codecol.textContent));

    if (isOr && last) { last.alts.push(...alts); continue; }
    const opt = { alts };
    if (cur && (cur.indent === null || cur.indent === indented)) {
      cur.indent = indented; cur.options.push(opt); last = opt; continue;
    }
    cur = null;
    target.push({ section, label: '', need: 1, required: true, hours, options: [opt] });
    last = opt;
  }
}

// Rules about courses counted elsewhere ("No more than three courses below 200", "Of the nine total
// courses, at least four must be…") limit which courses count; they don't add courses.
const CONSTRAINT_ANY = /^no more than|out of \d+|\(out of \d+|^of the\b|can be counted|may be counted|to accumulate|free electives/i;
const CONSTRAINT_PROSE = /no more than|maximum|should also|apportioned|of which|of these|among these/i;
// "At least six courses numbered 200 or above" restricts the others - unless it names a subject ("COMP courses numbered 420 or higher").
const LEVEL_PROSE = /must be (?:numbered|at or above|at the)|numbered \d{3} (?:or|and) (?:above|higher)/i;
// "A total of 10 HIST courses" / "A minimum of 10 COMM courses": an umbrella over the other requirements.
const UMBRELLA = /\b(?:a total of|a minimum of|requires|consists of)\s+(?:\S+\s+){0,1}(?:\(\d+\)\s+)?(?:\S+\s+)?courses\b/i;

// The subjects a level-only requirement ("One course numbered above 400") most likely means: the main
// subjects of its own course list, else of its section, else of the whole program.
function inferSubjects(g, groups) {
  const tally = list => {
    const m = new Map();
    list.forEach(x => x.options.forEach(o => o.alts?.forEach(a => a.codes.forEach(c => { const s = c.split(' ')[0]; m.set(s, (m.get(s) || 0) + 1); }))));
    return m;
  };
  for (const pool of [[g], groups.filter(x => x !== g && x.section === g.section), groups.filter(x => x !== g)]) {
    const counts = tally(pool);
    if (!counts.size) continue;
    const top = Math.max(...counts.values());
    return [...counts].filter(([, n]) => n >= top / 2).sort((a, b) => b[1] - a[1]).map(([s]) => s).slice(0, 6);
  }
  return null;
}
// Wording that describes a list or limits other requirements; those don't get a level rule of their own.
const LIST_WORDING = /chosen from|selected from|from the following|following (?:list|lists|options)|list below|lists below|see list|from either|must be|of which|of these|program areas|no more than|which must include courses|any (?:foreign )?language department|any department/i;

function finalizeGroups(groups, context = []) {
  const out = [], notes = [], rules = [];
  for (const g of groups) {
    if (g.required) { out.push(g); continue; }
    // Judge by the main clause: "Four GEOG elective courses, at least two of which must be…" is a real requirement
    // with a quota; "of which" in its quota clause doesn't make it a rule about other requirements.
    const head = g.label.split(/,?\s*at least\b|\(at least\b/i)[0];
    if (CONSTRAINT_ANY.test(g.label) || (!g.options.length && (CONSTRAINT_PROSE.test(head) || (LEVEL_PROSE.test(g.label) && !parseRule(g.label))))) {
      rules.push(g.label); continue;
    }
    if (g.options.length) {
      // No count + unindented list = "take all of these"; no count + indented = pick one.
      if (g.count === 'all' || (g.count == null && !g.indent)) g.need = g.options.length;
      else if (g.count === 'pick') g.need = Math.min(g.options.length, Math.max(1, Math.round((parseInt(g.hours, 10) || 3) / 3)));
      else if (g.count == null) g.need = 1;
      out.push(g);
    } else if (typeof g.count === 'number' && /cour|hour|elective|class/i.test(g.label)) {
      g.rule = looksLikeRule(g.label) || /\([A-Z]{2,5}\)|[A-Z]{3,4} course/.test(g.label) ? parseRule(g.label) : null;
      g.need = g.count;
      out.push(g);   // rule === null -> can't auto-check; user ticks it off manually
    } else notes.push(g.label);
  }
  // Level-only wording ("One course numbered above 400", "Three biology electives numbered above 200") means
  // courses in this program's subject. Becomes the requirement's rule, or an extra option next to its list.
  out.forEach(g => {
    if (g.required || g.rule || g.options.some(o => o.rule) || LIST_WORDING.test(g.label)) return;
    // "…numbered above 200 (not including BIOL 213, BIOL 222…)": the excluded courses name the subject.
    const excl = g.label.split(/\bexcluding\b|\bexcept\b|\bother than\b|\bnot including\b/i)[1] || '';
    const exclSubjects = [...new Set(parseCodes(excl).map(c => c.split(' ')[0]))];
    const rule = parseRule(g.label, exclSubjects.length ? exclSubjects : inferSubjects(g, [...out, ...context]));
    if (!rule || (rule.min == null && rule.max == null && !rule.any && !(rule.inferred && /\bat any level\b/i.test(g.label)))) return;
    if (g.options.length) g.options.push({ rule, label: `Any ${fmtRule(rule)} course${rule.inferred ? ' (subject assumed)' : ''}` });
    else g.rule = rule;
  });
  // Only an umbrella when there are other requirements for it to sit over.
  out.forEach(g => { g.overlay = !g.required && UMBRELLA.test(g.label) && out.some(o => o !== g); });
  // A level quota only matters when it covers fewer courses than the requirement asks for.
  out.forEach(g => {
    if (g.required) return;
    const q = parseQuota(g.label) || parseOutsideCap(g.label, g, out);
    if (q && q.n < g.need && q.n > 0) g.quota = q;
    const d = parseMinDepts(g.label);
    if (d && d.n > 1 && d.n <= g.need) g.minDepts = d;
    // "Three courses above 203 in one Middle Eastern language" / "Two courses … in a second Middle Eastern language"
    if (/\bin one\b[^.]*\blanguage\b/i.test(g.label)) g.oneSubject = true;
    if (/\b(?:second|another|different)\b[^.]*\blanguage\b/i.test(g.label)) g.otherSubject = g.oneSubject = true;   // one other language
  });
  // "At least six courses numbered 200 or above" next to "A total of 10 HIST courses" is a quota on that total.
  const umbrellas = out.filter(g => g.overlay);
  if (umbrellas.length === 1 && !umbrellas[0].quota) {
    for (const text of rules) {
      const q = parseQuota(text);
      if (q && q.n < umbrellas[0].need && !(text.match(/\b[A-Z]{2,5}\b/g) || []).some(s => state.subjects.has(s))) { umbrellas[0].quota = q; break; }
    }
  }
  return { groups: out, notes, rules };
}

async function getMinor(slug) {
  if (state.parsed[slug]) return state.parsed[slug];
  const html = await api('/api/catalog?path=' + encodeURIComponent(`/undergraduate/programs-study/${slug}/`));
  const doc = parser.parseFromString(html, 'text/html');
  const listed = state.programs.find(m => m.slug === slug);
  const name = clean(doc.querySelector('h1.page-title')?.textContent) || listed?.name || slug;
  const container = doc.querySelector('#requirementstextcontainer') || doc;
  const tables = [...container.querySelectorAll('table.sc_courselist')].filter(t => t.querySelector('td.codecol, .courselistcomment'));
  const headingOf = t => { let h = t.previousElementSibling; while (h && !/^H[2-4]$/.test(h.tagName)) h = h.previousElementSibling; return clean(h?.textContent).replace(/:$/, ''); };
  const codesOf = t => new Set([...t.querySelectorAll('td.codecol a')].map(a => clean(a.textContent).toUpperCase()));
  // refRaw: reference lists that aren't requirements, kept only to infer subjects for level-only wording.
  const raw = [], trackDefs = [], mainVariants = [], refRaw = [];
  if (tables[0]) parseTable(tables[0], raw, mainVariants);
  // "Choose one emphasis" inside the main table: each emphasis is an add-on option.
  mainVariants.forEach(v => trackDefs.push({ name: v.name, raw: v.groups, overlap: 0 }));
  const firstCodes = tables[0] ? codesOf(tables[0]) : new Set();

  // Later tables are one of: a course list for an earlier "two courses from the list below" requirement,
  // more of the main requirements, a concentration/track/option, or a sample plan to ignore.
  for (const t of tables.slice(1)) {
    parseTable(t, refRaw);
    const heading = headingOf(t);
    const structured = !!t.querySelector('.courselistcomment, tr.areaheader');
    const waiting = raw.find(g => !g.required && (!g.options.length || g.options.every(o => o.rule)) && /list|below|approved|subfield|elective/i.test(g.label + ' ' + g.options.map(o => o.label).join(' ')));
    if (!structured || /elective/i.test(heading)) {
      if (waiting) {
        const tmp = [];
        parseTable(t, tmp);
        tmp.forEach(g => waiting.options.push(...g.options));
        waiting.indent = true;   // treat as "pick from" list, not "take all"
      }
      continue;
    }
    if (/\bplan\b|plan of study|sample|\blists?\b|listing|suggest|recommend|courses$|coursework|classes$/i.test(heading)) continue;
    // More of the main requirements: no heading or a "Requirements"-style one, and its own "Total Hours" line
    // (Real Estate minor, Clinical Lab Science). Without a total it's a reference list - Geography pathways,
    // the Middle Eastern Languages course-by-language list, Biology's organismal course list.
    if (t.querySelector('tr.listsum') && (!heading || /^(?:core |program )?(?:requirements|courses)$|^core (?:courses|requirements)$/i.test(heading))) { parseTable(t, raw); continue; }
    // A concentration/track/option is a complete requirement block with its own "Total Hours" line.
    if (!t.querySelector('tr.listsum')) continue;
    const codes = codesOf(t);
    const overlap = [...codes].filter(c => firstCodes.has(c)).length / (codes.size || 1);
    const groups = [], variants = [];
    parseTable(t, groups, variants);
    const name = heading.replace(/^.*?\s[–—]\s?|^.*?–/, '').trim() || heading;
    if (!variants.length) trackDefs.push({ name, raw: groups, overlap });
    else variants.forEach(v => trackDefs.push({ name: `${name} – ${v.name}`, raw: [...groups, ...v.groups], overlap }));
  }

  const intro = [...container.querySelectorAll(':scope > p')].map(p => clean(p.textContent)).filter(Boolean).slice(0, 3);
  const type = listed?.type || (slug.endsWith('-minor') ? 'minor' : 'major');
  const main = finalizeGroups(raw, refRaw);
  let tracks = trackDefs.map(d => ({ name: d.name, ...finalizeGroups(d.raw, [...raw, ...refRaw]) })).filter(t => t.groups.length);
  // Complete alternatives (Physics B.A. options, Classics Greek/Latin) restate the core, or the first table
  // is itself one of the options. Otherwise tracks add to the shared requirements (Media and Journalism).
  const firstHeading = tables[0] ? headingOf(tables[0]) : '';
  const repeaters = trackDefs.filter(d => d.overlap >= 0.4).length;
  const replace = tracks.length > 0 && (repeaters * 2 > trackDefs.length || /\b(?:track|concentration|option)\b|[–—]/i.test(firstHeading));
  if (replace) {
    const firstName = firstHeading.replace(/^.*?\s[–—]\s?|^.*?–/, '').trim();
    tracks.unshift({ name: firstName && !/requirements/i.test(firstName) ? firstName : 'Standard', ...main });
  } else if (tracks.length === 1 || (tracks.length && /(?:concentrations?|tracks?|options?)\s+(?:is|are)\s+optional|may (?:choose|elect|pursue|complete|declare)\s+(?:an?\s+|one\s+)?(?:optional\s+)?(?:concentration|track|option)|not required to (?:choose|complete|declare)/i.test(container.textContent))) {
    tracks.unshift({ name: tracks.length === 1 ? 'Without this option' : 'No concentration', groups: [], notes: [], rules: [] });
  }
  const minor = {
    slug, name, type, url: `https://catalog.unc.edu/undergraduate/programs-study/${slug}/`, intro,
    ...(replace ? { groups: [], notes: main.notes, rules: [] } : main),
    tracks, trackMode: replace ? 'replace' : 'addon',
  };
  state.parsed[slug] = minor;
  return minor;
}

// A program as you'd complete it: shared requirements plus the chosen concentration/track/option.
state.track = load('track', {});
function viewOf(m, t = state.track[m.slug]) {
  if (!m.tracks?.length) return { ...m, manualKey: m.slug };
  const i = Math.min(Math.max(0, t ?? bestTrack(m)), m.tracks.length - 1);
  const tr = m.tracks[i];
  const shared = m.trackMode === 'replace' ? [] : m.groups;
  return {
    ...m, track: i, trackName: tr.name, manualKey: `${m.slug}#${i}`,
    groups: [...shared, ...tr.groups.map(g => ({ ...g, section: g.section || tr.name }))],
    notes: [...m.notes, ...tr.notes], rules: [...(m.rules || []), ...(tr.rules || [])],
  };
}
// The option where the most of your courses count; ties go to the earlier (usually standard) option.
function bestTrack(m) {
  let best = 0, bestE = null;
  m.tracks.forEach((_, i) => {
    const e = evaluate(viewOf(m, i));
    if (!bestE || e.done > bestE.done || (e.done === bestE.done && e.done > 0 && e.pct > bestE.pct)) { best = i; bestE = e; }
  });
  return best;
}

// ---------- evaluation ----------
// Greedy: each completed course counts toward one requirement. Most constrained requirements claim first.
function evaluate(minor) {
  const have = takenBases();
  const used = new Set();
  const manual = state.manual[minor.manualKey || minor.slug] || {};
  const results = minor.groups.map(g => ({ g, done: 0, by: [], usedHere: new Set() }));
  // "…in a second language" waits for "…in one language" so it knows which language to avoid.
  const rank = g => g.overlay ? 2000 : g.required ? 0 : (g.options.length && !g.options.some(o => o.rule) ? g.options.length : 1000) + (g.otherSubject ? 1 : 0);
  const firstLanguage = new Set();
  const order = results.map((_, i) => i).sort((a, b) => rank(results[a].g) - rank(results[b].g));
  // How many requirements could use each course you've taken. Each requirement prefers the course
  // fewest others could use (PHIL 163 for "ethics" rather than MEJO 141, which is also a Conceptual course).
  const demand = new Map();
  minor.groups.filter(g => !g.overlay).forEach(g => {
    const fits = new Set();
    g.options.forEach(o => o.alts?.forEach(a => a.codes.forEach(c => fits.add(base(c)))));
    const rules = [...g.options.filter(o => o.rule).map(o => o.rule), ...(g.rule ? [g.rule] : [])];
    have.forEach(c => { if (rules.some(rule => matchesRule(c, rule))) fits.add(c); });
    fits.forEach(c => demand.set(c, (demand.get(c) || 0) + 1));
  });
  const cost = codes => codes.reduce((s, c) => s + (demand.get(base(c)) || 0), 0);
  for (const i of order) {
    const r = results[i], g = r.g;
    if (manual[i]) { r.done = g.need; r.manual = true; continue; }
    // An umbrella total may reuse courses already counted by the other requirements.
    const taken = g.overlay ? new Set() : used;
    const claim = codes => { codes.forEach(c => { taken.add(base(c)); r.usedHere.add(base(c)); }); r.by.push(codes.join(' + ')); r.done++; };
    // Quota ("at least two at or above the 200 level", "at least two of which must be AAAD"): courses outside it
    // can fill at most need - n slots. Department minimum ("from at least three departments"): never take a
    // course that would leave too few slots to reach the minimum.
    const q = g.quota, D = g.minDepts;
    const inQ = codes => !q || codes.every(c => inQuota(c, q));
    const unitOf = codes => { const s = codes[0].split(' ')[0]; return D?.by === 'subject' ? s : deptOf(s); };
    const units = new Set();
    let outside = 0;
    r.quotaHave = 0;
    const subjOf = codes => codes[0].split(' ')[0];
    const take = codes => {
      if (g.oneSubject && r.by.length && subjOf(codes) !== subjOf(r.by[0].split(' + '))) return;
      if (g.otherSubject && firstLanguage.has(subjOf(codes))) return;
      if (q && !inQ(codes) && outside >= g.need - q.n) return;
      if (D) {
        const fresh = !units.has(unitOf(codes));
        if (g.need - (r.done + 1) < D.n - units.size - (fresh ? 1 : 0)) return;
      }
      if (q) { if (inQ(codes)) r.quotaHave++; else outside++; }
      units.add(unitOf(codes));
      claim(codes);
    };
    const fits = a => a.codes.every(c => have.has(base(c)) && !taken.has(base(c)));
    const order2 = (x, y) => inQ(y.codes) - inQ(x.codes) || cost(x.codes) - cost(y.codes);
    const fromOptions = g.options.filter(o => o.alts)
      .map(o => o.alts.filter(fits).sort(order2)[0]).filter(Boolean);
    const rules = [...g.options.filter(o => o.rule).map(o => o.rule), ...(g.rule ? [g.rule] : [])];
    const fromRules = [...have].filter(c => rules.some(rule => matchesRule(c, rule))).map(c => ({ codes: [c] }));
    // Listed options before catch-all rules; within each, courses in the quota first.
    let candidates = [...fromOptions.sort(order2), ...fromRules.sort(order2)];
    if (g.otherSubject) candidates = candidates.filter(a => !firstLanguage.has(subjOf(a.codes)));
    if (g.oneSubject) {   // the language where you have the most qualifying courses
      const per = new Map();
      candidates.forEach(a => per.set(subjOf(a.codes), (per.get(subjOf(a.codes)) || 0) + 1));
      const best = [...per].sort((a, b) => b[1] - a[1])[0]?.[0];
      candidates = candidates.filter(a => subjOf(a.codes) === best);
    }
    for (const pass of D ? [0, 1] : [1]) {   // pass 0: one course per department, to reach the spread
      for (const alt of candidates) {
        if (r.done >= g.need) break;
        if (pass === 0 && units.has(unitOf(alt.codes))) continue;
        if (fits(alt)) take(alt.codes);
      }
    }
    r.units = units.size;
    if (g.oneSubject && !g.otherSubject) r.by.forEach(b => firstLanguage.add(b.split(' ')[0]));
  }
  const regular = results.filter(r => !r.g.overlay);
  const regNeed = regular.reduce((s, r) => s + r.g.need, 0);
  const regDone = regular.reduce((s, r) => s + Math.min(r.done, r.g.need), 0);
  // An umbrella only adds the courses beyond what the other requirements already ask for.
  let extra = 0, extraDone = 0;
  for (const r of results.filter(r => r.g.overlay)) {
    r.extra = Math.max(0, r.g.need - regNeed);
    if (r.extra >= extra) { extra = r.extra; extraDone = Math.min(r.extra, Math.max(0, Math.min(r.done, r.g.need) - regDone)); }
  }
  const need = regNeed + extra, done = regDone + extraDone;
  results.forEach(r => { r.allUsed = used; });
  return { results, need, done, pct: need ? done / need : 0, counted: [...used] };
}

// ---------- course info: prereqs + seats ----------
async function getCourse(code) {
  if (courseCache[code]) return courseCache[code];
  const xml = await api('/api/course?code=' + encodeURIComponent(code));
  const inner = parser.parseFromString(xml, 'text/xml').querySelector('course')?.textContent || '';
  const h = parser.parseFromString(inner, 'text/html');
  const title = clean(h.querySelector('.detail-title')?.textContent).replace(/\.$/, '');
  const credits = clean(h.querySelector('.detail-hours')?.textContent).replace(/\.$/, '');
  const req = expandShorthand(clean(h.querySelector('.detail-requisites')?.textContent).replace(/^Requisites:\s*/i, '').replace(/\s+([,;.])/g, '$1'));
  const reqCodes = [...new Set(parseCodes(req))].filter(c => c !== code);
  const info = { code, found: !!inner.trim(), title, credits, desc: clean(h.querySelector('.courseblockextra')?.textContent), req, reqCodes };
  info.prereqStatus = prereqStatus(info);
  return (courseCache[code] = info);
}

// "MATH 130, 152, 210, or PHIL 155" -> "MATH 130, MATH 152, MATH 210, or PHIL 155"
function expandShorthand(text) {
  let subj = null;
  return text.replace(/\b([A-Z]{2,5})\s(\d{2,3}[A-Z]{0,2})\b|((?:,|\bor|\band|\/)\s*)(\d{2,3}[A-Z]?)\b(?!\s*(?:credit|hour|level|%))/g,
    (m, s, n, sep, bare) => {
      if (s) { if (state.subjects.has(s)) subj = s; return m; }
      return subj ? `${sep}${subj} ${bare}` : m;
    });
}

// UNC wording is mostly "A; B or C" / "A and B": ';' and 'and' join requirements, 'or' joins alternatives.
// Only the prerequisite part is checked (corequisites can be taken alongside).
function prereqStatus(info) {
  const pre = info.req.split(/corequisites?/i)[0];
  const parts = pre.split(/;|\band\b/i).map(p => parseCodes(p).filter(c => c !== info.code)).filter(p => p.length);
  if (!parts.length) return 'none';
  const ok = parts.filter(p => p.some(isTaken)).length;
  return ok === parts.length ? 'met' : ok ? 'partial' : 'unmet';
}

async function getSeats(code) {
  const key = code + '|' + state.term;
  if (seatCache[key]) return seatCache[key];
  const [subject, number] = code.split(' ');
  const html = await api(`/api/seats?subject=${subject}&number=${number}&term=${encodeURIComponent(state.term)}`);
  const mine = parseSections(html).filter(s => base(`X ${s.catalog}`) === base(`X ${number}`));
  return (seatCache[key] = mine);
}

function parseSections(html) {
  const doc = parser.parseFromString(html, 'text/html');
  const sections = [];
  let catalog = '';
  for (const tr of doc.querySelectorAll('tbody tr')) {
    const td = [...tr.querySelectorAll('td')].map(c => clean(c.textContent));
    // Columns (rowspans make early rows longer): [subject] [catalog] sameAs section class# title term hours dates schedule mode seats
    if (td.length < 10) continue;
    if (td.length >= 11) catalog = td[td.length - 11];
    const at = k => td[td.length - k];
    sections.push({ catalog, section: at(9), classNum: at(8), title: at(7), term: at(6), hours: at(5), dates: at(4), schedule: at(3), mode: at(2), seats: parseInt(at(1), 10) || 0 });
  }
  return sections;
}

// One Class Search request covers every section in a subject; it fills the per-course seat cache.
const subjectSeats = {};
async function loadSubjectSeats(subject, codes) {
  const key = subject + '|' + state.term;
  subjectSeats[key] ||= api(`/api/seats?subject=${subject}&number=&term=${encodeURIComponent(state.term)}`)
    .then(parseSections).catch(e => { delete subjectSeats[key]; throw e; });
  const sections = await subjectSeats[key];
  codes.forEach(code => {
    const n = code.split(' ')[1];
    seatCache[code + '|' + state.term] = sections.filter(s => base(`X ${s.catalog}`) === base(`X ${n}`));
  });
}

// Every course in a subject, from its catalog page (catalog.unc.edu/courses/grek/).
const subjectCourses = {};
function getSubjectCourses(subject) {
  return subjectCourses[subject] ||= api('/api/catalog?path=' + encodeURIComponent(`/courses/${subject.toLowerCase()}/`)).then(html => {
    const doc = parser.parseFromString(html, 'text/html');
    return [...doc.querySelectorAll('.courseblock')].map(b => ({
      code: clean(b.querySelector('.detail-code')?.textContent).replace(/\.$/, '').toUpperCase(),
      title: clean(b.querySelector('.detail-title')?.textContent).replace(/\.$/, ''),
      credits: clean(b.querySelector('.detail-hours')?.textContent).replace(/\.$/, ''),
    })).filter(c => /^[A-Z]{2,5} \d/.test(c.code));
  }).catch(e => { delete subjectCourses[subject]; throw e; });
}

// The courses a level rule allows ("Five Greek courses above GREK 203" -> GREK 204 and up), with seats loaded.
// Graduate courses (700+) are left out unless the rule's range reaches them.
async function ruleCourses(rule) {
  const parts = rule.any || [rule];
  const subjects = [...new Set(parts.flatMap(p => p.subjects))];
  const lists = await Promise.all(subjects.map(getSubjectCourses));
  const gradOk = parts.some(p => p.max != null && p.max >= 700);
  const courses = lists.flat().filter(c => matchesRule(c.code, rule) && (gradOk || num(c.code) < 700));
  await Promise.all(subjects.map(s => loadSubjectSeats(s, courses.filter(c => c.code.startsWith(s + ' ')).map(c => c.code)).catch(() => {})));
  return courses;
}

const fmtLevel = p => p.min != null && p.max != null ? `${p.min}–${p.max}` : p.min != null ? `${p.min} and up` : p.max != null ? `up to ${p.max}` : 'any level';
const fmtRule = rule => (rule.any || [rule]).map(p => p.codes ? p.codes.join(', ') : `${p.subjects.join('/')} ${fmtLevel(p)}`).join(' or ')
  + (rule.exclude.length ? `, excluding ${rule.exclude.join(', ')}` : '');

// Expandable list of qualifying courses under a level-based requirement.
function ruleCoursesBlock(rule, usedHere, quota = null) {
  const id = state.ruleRefs.push({ rule, usedHere }) - 1;
  return `<details class="rule-courses" data-rule="${id}">
    <summary class="small">Show courses that qualify (${esc(fmtRule(rule))}${quota ? `; at least ${quota.n} must be ${esc(quota.subjects ? quota.subjects.join('/') : fmtLevel(quota))}` : ''})</summary>
    <label class="small only-offered-label"><input type="checkbox" class="only-offered"> Only courses offered ${esc(state.term || 'in upcoming terms')}</label>
    <div class="rule-list"><p class="small muted">Loading…</p></div>
  </details>`;
}

async function renderRuleCourses(details) {
  const { rule, usedHere } = state.ruleRefs[+details.dataset.rule];
  const box = details.querySelector('.rule-list');
  let courses;
  try { courses = await ruleCourses(rule); }
  catch (e) { box.innerHTML = `<p class="error small">Couldn't load courses: ${esc(e.message)}</p>`; return; }
  const seats = c => seatCache[c.code + '|' + state.term] || [];
  const open = c => seats(c).reduce((s, x) => s + x.seats, 0);
  const rank = c => usedHere.has(base(c.code)) ? 0 : isTaken(c.code) ? 1 : seats(c).length ? (open(c) ? 2 : 3) : 4;
  const onlyOffered = details.querySelector('.only-offered').checked;
  const sorted = courses.filter(c => !onlyOffered || seats(c).length)
    .sort((a, b) => rank(a) - rank(b) || num(a.code) - num(b.code) || a.code.localeCompare(b.code));
  const offered = courses.filter(c => seats(c).length).length;
  box.innerHTML = `<p class="small muted">${courses.length} course${courses.length === 1 ? '' : 's'} qualify · ${offered} offered ${esc(state.term || 'in upcoming terms')}. Counted and offered courses are listed first.</p>
    <ul class="opts">${sorted.map(c => {
      const used = usedHere.has(base(c.code)), taken = isTaken(c.code);
      return `<li class="opt ${used ? 'done' : ''}">
        <span class="mark">${used ? '✓' : taken ? '•' : '○'}</span>
        <span class="code">${esc(c.code)}</span>
        <span class="title">${esc(c.title)}${taken && !used ? ' <em class="muted">(taken, counted elsewhere)</em>' : ''}</span>
        ${!taken ? `<button class="link" data-course="${esc(c.code)}">Details</button>` : ''}
        <span class="badges" data-badges="${esc(c.code)}">${badgesFor(c.code)}</span>
        <div class="course-panel" data-panel="${esc(c.code)}"></div>
      </li>`;
    }).join('') || '<li class="small muted">None offered. Uncheck the filter to see all.</li>'}</ul>`;
}

function seatSummary(sections) {
  if (!sections.length) return { cls: 'bad', text: state.term ? `Not offered ${state.term}` : 'Not on upcoming schedules' };
  const byTerm = {};
  sections.forEach(s => { (byTerm[s.term] ||= { n: 0, seats: 0 }); byTerm[s.term].n++; byTerm[s.term].seats += s.seats; });
  const open = sections.reduce((s, x) => s + x.seats, 0);
  return { cls: open ? 'good' : 'warn', text: Object.entries(byTerm).map(([t, v]) => `${t}: ${v.seats} seats / ${v.n} sec`).join(' · ') };
}

// ---------- rendering: sidebar ----------
function renderTaken() {
  const list = $('#taken-list');
  $('#taken-count').textContent = state.taken.length;
  list.innerHTML = state.taken.length
    ? state.taken.map(c => `<span class="chip">${esc(c)}<button aria-label="Remove ${esc(c)}" data-remove="${esc(c)}">×</button></span>`).join('')
    : '<p class="muted small">No courses yet. Add the ones you\'ve completed or are taking now.</p>';
}

function addTaken(text) {
  const codes = parseCodes(text);
  if (!codes.length) return 0;
  state.taken = [...new Set([...state.taken, ...codes])].sort();
  save('taken', state.taken);
  onTakenChanged();
  return codes.length;
}

function onTakenChanged() {
  renderTaken();
  Object.values(courseCache).forEach(c => { c.prereqStatus = prereqStatus(c); });
  if (state.scanned) renderMatches();
  if (state.current) renderDetail(state.current);
  if (!$('#panel-ideas').hidden) renderIdeas();
}

// ---------- rendering: matches ----------
function bar(pct) { return `<div class="bar" role="progressbar" aria-valuenow="${Math.round(pct * 100)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${Math.round(pct * 100)}%"></span></div>`; }

function renderMatches() {
  // Rank each program by its best-fitting concentration/track unless you've picked one.
  const minors = state.programs.filter(ofType).map(m => state.parsed[m.slug]).filter(m => m && (m.groups.length || m.tracks?.length))
    .map(m => viewOf(m)).filter(v => v.groups.length);
  const rows = minors.map(m => ({ m, e: evaluate(m) }))
    .sort((a, b) => b.e.pct - a.e.pct || (a.e.need - a.e.done) - (b.e.need - b.e.done) || a.m.name.localeCompare(b.m.name));
  const filter = $('#match-filter').value;
  const shown = rows.filter(r => filter === 'all' || r.e.done > 0);
  $('#matches').innerHTML = shown.length ? shown.map(({ m, e }) => `
    <button class="match" data-open="${m.slug}">
      <div class="match-head"><strong><span class="tag ${m.type}">${m.type}</span> ${esc(m.name)}</strong><span class="pct">${Math.round(e.pct * 100)}%</span></div>
      ${bar(e.pct)}
      ${m.trackName ? `<div class="small track-line">${state.track[m.slug] != null ? '' : 'Best fit: '}${esc(m.trackName)}${m.tracks.length > 1 ? ` <span class="muted">· ${m.tracks.length} options</span>` : ''}</div>` : ''}
      <div class="small muted">${e.done} of ${e.need} courses done · <b>${e.need - e.done} to go</b>${e.counted.length ? ` · counts: ${esc(e.counted.join(', '))}` : ''}</div>
    </button>`).join('')
    : `<p class="muted">${minors.length ? 'None of your courses count toward these yet. Switch to "Show all" to browse.' : 'Click <b>Scan</b> to read these programs from the catalog.'}</p>`;
}

async function scanAll() {
  const btn = $('#scan-btn');
  btn.disabled = true;
  const prog = $('#scan-progress');
  prog.hidden = false;
  try {
    if (!state.programs.length) await loadPrograms();
    const todo = state.programs.filter(ofType);
    let n = 0, failed = 0;
    await pool(todo, 3, async m => {
      try { await getMinor(m.slug); } catch { failed++; }
      n++;
      prog.innerHTML = `Reading requirements from the catalog… ${n}/${todo.length}${bar(n / todo.length)}`;
    });
    state.scanned = true;
    prog.hidden = !failed;
    if (failed) prog.textContent = `${failed} catalog page(s) couldn't be loaded. Scan again to retry.`;
    renderMatches();
  } catch (e) {
    prog.textContent = 'Scan failed: ' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Scan';
  }
}

// ---------- rendering: minor detail ----------
const STATUS_TXT = { met: 'Prereqs met', partial: 'Some prereqs met', unmet: 'Prereqs not met', none: 'No prereqs' };
const STATUS_CLS = { met: 'good', partial: 'warn', unmet: 'bad', none: 'good' };

function optionRow(opt, r, minorSlug) {
  if (opt.rule) return `<li class="opt rule"><span class="mark">◇</span><span>${esc(opt.label)}</span>${ruleCoursesBlock(opt.rule, r.usedHere, r.g.quota)}</li>`;
  return opt.alts.map((alt, k) => {
    const done = alt.codes.every(c => r.usedHere.has(base(c)));
    const elsewhere = !done && alt.codes.every(isTaken);
    // Taken but unused anywhere: this requirement's quota or department limit kept it out.
    const blocked = elsewhere && !alt.codes.every(c => r.allUsed?.has(base(c)));
    const code = alt.codes.length === 1 ? alt.codes[0] : null;
    return `<li class="opt ${done ? 'done' : ''}">
      ${k ? '<span class="or">or</span>' : ''}
      <span class="mark">${done ? '✓' : elsewhere ? '•' : '○'}</span>
      <span class="code">${esc(alt.codes.join(' + '))}</span>
      <span class="title">${esc(alt.title)}${blocked ? ` <em class="muted">(taken, but can't count here: ${r.g.minDepts ? (r.g.quota ? 'quota or department limit' : 'needs a different department') : 'over the quota limit'})</em>` : elsewhere ? ' <em class="muted">(taken, counted elsewhere)</em>' : ''}</span>
      ${!done && !elsewhere ? alt.codes.map(c => `<button class="link" data-course="${esc(c)}" data-minor="${minorSlug}">Details</button>`).join('') : ''}
      <span class="badges" data-badges="${esc(alt.codes.join('|'))}">${code ? badgesFor(code) : ''}</span>
      <div class="course-panel" data-panel="${esc(alt.codes.join('|'))}"></div>
    </li>`;
  }).join('');
}

function badgesFor(code) {
  const c = courseCache[code];
  const s = seatCache[code + '|' + state.term];
  let out = '';
  if (c) out += `<span class="badge ${STATUS_CLS[c.prereqStatus]}">${STATUS_TXT[c.prereqStatus]}</span>`;
  if (s) { const sum = seatSummary(s); out += `<span class="badge ${sum.cls}">${esc(sum.text)}</span>`; }
  return out + ideasBadges(code);
}

function renderDetail(slug) {
  if (!state.parsed[slug]) return;
  const m = viewOf(state.parsed[slug]);
  const e = evaluate(m);
  const manual = state.manual[m.manualKey] || {};
  state.ruleRefs = [];
  let lastSection = null;
  const groupsHtml = e.results.map((r, i) => {
    const g = r.g;
    const met = r.done >= g.need;
    const sec = g.section && g.section !== lastSection ? `<h3 class="section">${esc(g.section)}</h3>` : '';
    lastSection = g.section;
    const heading = g.required ? 'Required' : g.overlay
      ? `Overall: ${esc(g.label)} <span class="muted small">(courses above count here too${r.extra ? `; ${r.extra} more beyond them` : ''})</span>`
      : esc(g.label);
    const canManual = (!g.options.length && !g.rule) || (!g.options.some(o => o.rule) && g.need > g.options.length) || g.rule?.inferred;
    return `${sec}<div class="req ${met ? 'met' : r.done ? 'partial' : ''}">
      <div class="req-head">
        <span class="status">${met ? '✓ Complete' : `${r.done}/${g.need}`}</span>
        <span class="req-label">${heading}</span>
        ${g.hours ? `<span class="muted small">${esc(g.hours)} hrs</span>` : ''}
      </div>
      ${(g.quota || g.minDepts) && !r.manual ? `<p class="small">
        ${g.quota ? `<span class="badge ${r.quotaHave >= g.quota.n ? 'good' : 'warn'}">At least ${g.quota.n} ${esc(fmtQuota(g.quota))}: ${Math.min(r.quotaHave, g.quota.n)}/${g.quota.n}</span>` : ''}
        ${g.minDepts ? `<span class="badge ${r.units >= g.minDepts.n ? 'good' : 'warn'}" title="${g.minDepts.by === 'dept' ? 'Departments are approximated by subject code; PSYC/NSCI, Classics, English/CMPL and other multi-code departments count once.' : ''}">${g.minDepts.n}+ ${g.minDepts.by === 'subject' ? 'subject codes' : 'departments'}: ${Math.min(r.units, g.minDepts.n)}/${g.minDepts.n}</span>` : ''}
        ${g.quota && r.quotaHave < g.quota.n && r.done < g.need ? ` <span class="muted">Only ${g.need - g.quota.n} course${g.need - g.quota.n === 1 ? '' : 's'} outside that can count here.</span>` : ''}
        ${g.minDepts && r.units < g.minDepts.n && r.done < g.need ? ` <span class="muted">Your remaining course${g.need - r.done === 1 ? '' : 's'} must come from ${g.minDepts.by === 'subject' ? 'another subject' : 'another department'}.</span>` : ''}
      </p>` : ''}
      ${r.by.length ? `<p class="small">Counting: <b>${esc(r.by.join(', '))}</b></p>` : ''}
      ${g.options.length ? `<ul class="opts">${g.options.map(o => optionRow(o, r, slug)).join('')}</ul>` : ''}
      ${g.rule ? `<p class="small muted">Auto-checked against your courses: ${esc(fmtRule(g.rule))}.${g.rule.inferred ? ` <span class="badge gened" title="The catalog gives only a course level here, so the subject is assumed from this program's own courses.">subject assumed</span>` : ''}</p>${ruleCoursesBlock(g.rule, r.usedHere, g.quota)}` : ''}
      ${canManual ? `<label class="small manual"><input type="checkbox" data-manual="${i}" ${manual[i] ? 'checked' : ''}> ${g.rule?.inferred ? 'I\'ve satisfied this another way (e.g. a course in a different subject)' : 'I\'ve satisfied this (can\'t be checked automatically)'}</label>` : ''}
    </div>`;
  }).join('');

  $('#detail').innerHTML = `
    <div class="detail-head">
      <div>
        <h2><span class="tag ${m.type}">${m.type}</span> ${esc(m.name)}</h2>
        <a href="${m.url}" target="_blank" rel="noopener" class="small">Official catalog page ↗</a>
        ${m.tracks?.length ? `<div class="track-pick">
          <label class="small muted" for="track-select">${m.trackMode === 'replace' ? 'Option' : 'Concentration / track'}</label>
          <select id="track-select">
            <option value="" ${state.track[m.slug] == null ? 'selected' : ''}>Best fit for my courses (${esc(m.tracks[bestTrack(state.parsed[m.slug])].name)})</option>
            ${m.tracks.map((t, i) => `<option value="${i}" ${state.track[m.slug] === i ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
          </select>
        </div>` : ''}
      </div>
      <div class="summary">
        <div class="big">${e.need - e.done}</div><div class="small muted">courses to go</div>
      </div>
    </div>
    ${bar(e.pct)}
    <p class="small muted">${e.done} of ${e.need} required courses complete.</p>
    ${m.type === 'major' ? '<p class="notes small">This covers the major\'s own requirements only. You also need General Education (IDEAs in Action) requirements and 120 total credit hours, — those are on the IDEAs in Action tab.</p>' : ''}
    ${m.notes.length ? `<div class="notes small">${m.notes.map(n => `<p>${esc(n)}</p>`).join('')}</div>` : ''}
    ${m.rules?.length ? `<div class="notes rules small"><b>Rules to keep in mind</b> (not checked automatically; they limit which courses count, not how many you take):<ul>${m.rules.map(n => `<li>${esc(n)}</li>`).join('')}</ul></div>` : ''}
    <div class="toolbar">
      <button id="check-all" class="primary">Check prereqs &amp; seats for remaining courses</button>
      <span id="check-progress" class="small muted"></span>
    </div>
    ${groupsHtml || '<p class="muted">Couldn\'t read requirements for this minor. Use the catalog link above.</p>'}`;
}

async function showMinor(slug) {
  state.current = slug;
  $('#minor-select').value = slug;
  switchTab('detail');
  $('#detail').innerHTML = '<p class="muted">Loading requirements…</p>';
  try { await getMinor(slug); renderDetail(slug); }
  catch (e) { $('#detail').innerHTML = `<p class="error">Couldn't load this minor: ${esc(e.message)}</p>`; }
}

function refreshBadges(code) {
  document.querySelectorAll('[data-badges]').forEach(el => {
    if (el.dataset.badges === code) el.innerHTML = badgesFor(code);
  });
}

async function checkAllRemaining() {
  const m = viewOf(state.parsed[state.current]);
  const e = evaluate(m);
  const codes = new Set();
  e.results.filter(r => r.done < r.g.need).forEach(r => r.g.options.forEach(o => o.alts?.forEach(a => a.codes.forEach(c => { if (!isTaken(c)) codes.add(c); }))));
  const list = [...codes];
  const btn = $('#check-all');
  btn.disabled = true;
  let n = 0;
  await pool(list, 2, async code => {
    try { await getCourse(code); await getSeats(code); } catch { }
    n++;
    const p = $('#check-progress'); if (p) p.textContent = `${n}/${list.length} checked`;
    refreshBadges(code);
  });
  const p = $('#check-progress');
  if (p) p.textContent = list.length ? `Checked ${list.length} course(s). Green = prereqs met and seats open.` : 'Nothing left to check — this minor is complete.';
  if (btn) btn.disabled = false;
}

// Course panel: description, prereqs (each prereq expandable), sections & seats.
async function renderCoursePanel(el, code, depth = 0) {
  el.innerHTML = '<p class="small muted">Loading…</p>';
  try {
    const [c, secs] = await Promise.all([getCourse(code), getSeats(code)]);
    refreshBadges(code);
    let req = esc(c.req || 'None listed.');
    c.reqCodes.forEach(rc => {
      const cls = isTaken(rc) ? 'good' : 'bad';
      req = req.split(esc(rc)).join(`<button class="pre ${cls}" data-pre="${esc(rc)}" title="${isTaken(rc) ? 'You have taken this' : 'Not taken yet'} — click for details">${esc(rc)}</button>`);
    });
    const sum = seatSummary(secs);
    el.innerHTML = `
      <div class="panel">
        <p><b>${esc(code)}${c.title ? ` – ${esc(c.title)}` : ''}</b> ${c.credits ? `<span class="muted small">(${esc(c.credits)})</span>` : ''}</p>
        ${c.desc ? `<p class="small desc">${esc(c.desc)}</p>` : ''}
        <p class="small"><b>Requisites:</b> ${req}</p>
        ${c.reqCodes.length ? `<p class="small"><span class="badge ${STATUS_CLS[c.prereqStatus]}">${STATUS_TXT[c.prereqStatus]}</span> <span class="muted">Green = taken. Read the wording for and/or rules.</span></p>` : ''}
        <div class="nested"></div>
        <p class="small"><b>Sections${state.term ? ` (${esc(state.term)})` : ''}:</b> <span class="badge ${sum.cls}">${esc(sum.text)}</span></p>
        ${secs.length ? `<div class="table-wrap"><table class="sections">
          <thead><tr><th>Term</th><th>Sec</th><th>Class #</th><th>Schedule</th><th>Mode</th><th>Seats</th></tr></thead>
          <tbody>${secs.map(s => `<tr><td>${esc(s.term)}</td><td>${esc(s.section)}${/H$/.test(s.catalog) ? ' (H)' : ''}</td><td>${esc(s.classNum)}</td><td>${esc(s.schedule || 'TBA')}</td><td>${esc(s.mode)}</td><td class="${s.seats ? 'seats-ok' : 'seats-none'}">${s.seats}</td></tr>`).join('')}</tbody>
        </table></div>` : ''}
      </div>`;
    el.querySelectorAll('[data-pre]').forEach(b => b.addEventListener('click', ev => {
      ev.stopPropagation();
      const nested = el.querySelector('.nested');
      if (nested.dataset.code === b.dataset.pre) { nested.innerHTML = ''; nested.dataset.code = ''; return; }
      nested.dataset.code = b.dataset.pre;
      if (depth < 4) renderCoursePanel(nested, b.dataset.pre, depth + 1);
    }));
  } catch (e) {
    el.innerHTML = `<p class="error small">Couldn't load ${esc(code)}: ${esc(e.message)}</p>`;
  }
}

// ---------- IDEAs in Action (general education) ----------
// Approved-course lists come from each category page under catalog.unc.edu/undergraduate/ideas-in-action/.
const FYF = 'First-Year Foundations', FC = 'Focus Capacities', RI = 'Reflection and Integration', ADD = 'Additional Requirements';
const IDEAS = [
  { group: FYF, key: 'thrive', label: 'College Thriving', codes: ['IDST 101', 'HNRS 101'] },
  { group: FYF, key: 'datalab', label: 'Data Literacy Lab', codes: ['IDST 111L'] },
  // Launch courses (BIOL 101, …) only count in their special Launch sections, so only the seminar table is auto-checked.
  { group: FYF, key: 'fys', label: 'First-Year Seminar or First-Year Launch', page: 'first-year-seminars-launches', firstTableOnly: true, manualHint: 'Took a First-Year Launch section' },
  { group: FYF, key: 'writing', label: 'Writing at the Research University', codes: ['ENGL 105', 'ENGL 105I'] },
  { group: FYF, key: 'lang', label: 'Global Language (through level 3)', page: 'global-language', manualHint: 'Placed out or have exam credit' },
  { group: FC, fc: true, key: 'aesth', label: 'Aesthetic and Interpretive Analysis', page: 'aesthetic-interpretive-analysis' },
  { group: FC, fc: true, key: 'create', label: 'Creative Expression, Practice, and Production', page: 'creative-expression' },
  { group: FC, fc: true, key: 'past', label: 'Engagement with the Human Past', page: 'human-past' },
  { group: FC, fc: true, key: 'values', label: 'Ethical and Civic Values', page: 'ethical-civic-values' },
  { group: FC, fc: true, key: 'global', label: 'Global Understanding and Engagement', page: 'global-understanding' },
  { group: FC, fc: true, key: 'natsci', label: 'Natural Scientific Investigation', page: 'natural-scientific' },
  { group: FC, fc: true, key: 'power', label: 'Power and Society', page: 'power-society' },
  { group: FC, fc: true, key: 'quant', label: 'Quantitative Reasoning', page: 'quantitative' },
  { group: FC, fc: true, key: 'knowing', label: 'Ways of Knowing', page: 'ways-of-knowing' },
  { group: FC, key: 'lab', label: 'Empirical Investigation Lab (1 credit)', page: 'lab' },
  { group: RI, key: 'research', label: 'Research and Discovery', page: 'research-discovery' },
  { group: RI, key: 'hie', label: 'High-Impact Experience (or a second Research and Discovery)', page: 'high-impact', alsoPage: 'research-discovery', manualHint: 'Done through a non-course experience' },
  { group: RI, key: 'commbeyond', label: 'Communication Beyond Carolina', page: 'communication-beyond' },
  { group: RI, key: 'interdisc', label: 'Interdisciplinary', page: 'interdisciplinary', since2025: true },
  { group: RI, key: 'lfit', label: 'Lifetime Fitness', page: 'lifetime-fitness', manualHint: 'Exempt (varsity athlete or ROTC)' },
  { group: RI, key: 'cle', label: 'Campus Life Experience (8 events from four categories)', manualOnly: true },
  { group: ADD, key: 'fad', label: 'Foundations of American Democracy', page: 'foundations-american-democracy', since2025: true },
];
const IDEAS_SHORT = {
  thrive: 'College Thriving', datalab: 'Data Literacy', fys: 'First-Year Seminar', writing: 'Writing', lang: 'Global Language',
  aesth: 'Aesthetic', create: 'Creative Expression', past: 'Human Past', values: 'Ethical & Civic', global: 'Global Understanding',
  natsci: 'Natural Science', power: 'Power & Society', quant: 'Quantitative', knowing: 'Ways of Knowing', lab: 'Lab',
  research: 'Research & Discovery', hie: 'High-Impact', commbeyond: 'Comm. Beyond Carolina', interdisc: 'Interdisciplinary',
  lfit: 'Lifetime Fitness', fad: 'American Democracy',
};
const ideasLists = {};   // page -> [{ alts: [{codes, title}] }]
state.ideasManual = load('ideas_manual', {});
state.cohort = load('cohort', '2025');

async function loadIdeas() {
  const pages = [...new Set(IDEAS.flatMap(r => [r.page, r.alsoPage]).filter(Boolean))].filter(p => !ideasLists[p]);
  await pool(pages, 3, async page => {
    const html = await api('/api/catalog?path=' + encodeURIComponent(`/undergraduate/ideas-in-action/${page}/`));
    const doc = parser.parseFromString(html, 'text/html');
    const seen = new Set(), list = [];
    const tables = [...doc.querySelectorAll('table.sc_courselist')];
    const firstOnly = IDEAS.some(r => r.page === page && r.firstTableOnly);
    (firstOnly ? tables.slice(0, 1) : tables).flatMap(t => [...t.querySelectorAll('tr')]).forEach(tr => {
      const codecol = tr.querySelector('td.codecol');
      if (!codecol) return;
      const linked = [...codecol.querySelectorAll('a')].map(a => crossList(a.textContent)).filter(l => l.length);
      const codes = linked.length === 1 ? linked[0] : linked.length ? [linked.map(l => l[0])] : [];
      const title = clean(tr.querySelectorAll('td')[1]?.textContent);
      const alts = linked.length === 1 ? codes.map(c => ({ codes: [c], title })) : codes.length ? [{ codes: codes[0], title }] : [];
      const key = alts.map(a => a.codes.join('+')).join('|');
      if (alts.length && !seen.has(key)) { seen.add(key); list.push({ alts }); }
    });
    ideasLists[page] = list;
  });
  ideasIndex = null;
}

const activeIdeas = () => IDEAS.filter(r => !(r.since2025 && state.cohort === 'pre2025'));
function ideasOptions(r) {
  if (r.codes) return r.codes.map(c => ({ alts: [{ codes: [c], title: '' }] }));
  return [...(ideasLists[r.page] || []), ...(r.alsoPage ? ideasLists[r.alsoPage] || [] : [])];
}
// Which IDEAs requirements a course is approved for (by base code, so honors versions match).
let ideasIndex = null;
function ideasFor(code) {
  if (!ideasIndex) {
    ideasIndex = new Map();
    IDEAS.forEach(r => ideasOptions(r).forEach(o => o.alts.forEach(a => {
      if (a.codes.length !== 1) return;
      const b = base(a.codes[0]);
      if (!ideasIndex.has(b)) ideasIndex.set(b, new Set());
      ideasIndex.get(b).add(r.key);
    })));
  }
  return ideasIndex.get(base(code)) || new Set();
}

function evaluateIdeas() {
  const have = takenBases();
  const reqs = activeIdeas();
  const matches = r => {
    const out = [];
    ideasOptions(r).forEach(o => o.alts.forEach(a => {
      const k = a.codes.join(' + ');
      if (a.codes.every(c => have.has(base(c))) && !out.includes(k)) out.push(k);
    }));
    return out;
  };
  const res = Object.fromEntries(reqs.map(r => [r.key, { r, by: null, manual: !!state.ideasManual[r.key], approved: r.manualOnly ? [] : matches(r) }]));

  // Focus Capacities: one course per capacity, even if a course is approved for two. Bipartite matching.
  const owner = new Map();
  const tryAssign = (key, seen) => {
    for (const c of res[key].approved) {
      if (seen.has(c)) continue;
      seen.add(c);
      if (!owner.has(c) || tryAssign(owner.get(c), seen)) { owner.set(c, key); res[key].by = c; return true; }
    }
    return false;
  };
  reqs.filter(r => r.fc && !res[r.key].manual).forEach(r => tryAssign(r.key, new Set()));

  // Research and Discovery and High-Impact can't use the same course.
  const rd = res.research, hie = res.hie;
  if (rd && hie) {
    const pairs = (rd.manual ? [null] : rd.approved.length ? rd.approved : [null])
      .map(a => [a, hie.manual ? null : hie.approved.find(b => b !== a) || null]);
    const [a, b] = pairs.find(([a, b]) => a && b) || pairs[0];
    rd.by = a; hie.by = b;
  }
  reqs.filter(r => !r.fc && r.key !== 'research' && r.key !== 'hie').forEach(r => { res[r.key].by = res[r.key].approved[0] || null; });

  const list = reqs.map(r => res[r.key]);
  list.forEach(x => { x.done = !!(x.by || x.manual); });
  const done = list.filter(x => x.done).length;
  return { list, done, need: list.length, pct: list.length ? done / list.length : 0 };
}

// Courses that would also fill an unfinished IDEAs requirement - shown next to major/minor options.
function ideasBadges(code) {
  if (!Object.keys(ideasLists).length) return '';
  const open = new Set(evaluateIdeas().list.filter(x => !x.done).map(x => x.r.key));
  const hits = [...ideasFor(code)].filter(k => open.has(k)).map(k => IDEAS.find(r => r.key === k));
  return hits.map(r => `<span class="badge gened" title="Also fills IDEAs in Action: ${esc(r.label)}">Gen Ed: ${esc(IDEAS_SHORT[r.key] || r.label)}</span>`).join('');
}

function renderIdeas() {
  const el = $('#ideas');
  if (!Object.keys(ideasLists).length) { el.innerHTML = '<p class="muted">Loading IDEAs in Action course lists…</p>'; return; }
  const e = evaluateIdeas();
  const program = state.current && state.parsed[state.current] && viewOf(state.parsed[state.current]);
  const programCodes = new Set();
  if (program) program.groups.forEach(g => g.options.forEach(o => o.alts?.forEach(a => a.codes.forEach(c => programCodes.add(base(c))))));
  let group = null;
  el.innerHTML = `
    <div class="detail-head">
      <div>
        <h2>IDEAs in Action</h2>
        <a href="https://catalog.unc.edu/undergraduate/ideas-in-action/" target="_blank" rel="noopener" class="small">Official requirements ↗</a>
      </div>
      <div class="summary"><div class="big">${e.need - e.done}</div><div class="small muted">to go</div></div>
    </div>
    ${bar(e.pct)}
    <div class="toolbar">
      <label class="small" for="cohort">I started at Carolina</label>
      <select id="cohort">
        <option value="2025" ${state.cohort === '2025' ? 'selected' : ''}>Fall 2025 or later</option>
        <option value="pre2025" ${state.cohort === 'pre2025' ? 'selected' : ''}>Fall 2022 – Spring 2025</option>
      </select>
    </div>
    <p class="notes small">Each Focus Capacity needs its own course, even if a course is approved for two. Other requirements can share a course with a Focus Capacity.
      Course lists are from the 2026–27 catalog. Not checked: Disciplinary Distribution (one course from each College division), Supplemental General Education (B.A. only), and Pass/Fail limits.
      ${program ? `Options marked <span class="badge good">also ${esc(program.name)}</span> count toward the program you have open.` : 'Open a major or minor in Details to see which gen-ed options also count toward it.'}</p>
    ${e.list.map((x, i) => {
      const r = x.r;
      const head = r.group !== group ? `<h3 class="section">${r.group}</h3>` : '';
      group = r.group;
      const opts = ideasOptions(r);
      const extra = x.approved.filter(c => c !== x.by);
      return `${head}<div class="req ${x.done ? 'met' : ''}">
        <div class="req-head">
          <span class="status">${x.done ? '✓ Complete' : 'Needed'}</span>
          <span class="req-label">${esc(r.label)}</span>
        </div>
        ${x.by ? `<p class="small">Counting: <b>${esc(x.by)}</b></p>` : ''}
        ${!x.done && extra.length && r.fc ? `<p class="small muted">You've taken ${esc(extra.join(', '))}, but ${extra.length > 1 ? 'they\'re' : 'it\'s'} already used for another Focus Capacity.</p>` : ''}
        ${!r.codes || r.manualHint || r.manualOnly ? `<label class="small manual"><input type="checkbox" data-ideas-manual="${r.key}" ${x.manual ? 'checked' : ''}> ${esc(r.manualHint || (r.manualOnly ? 'I\'ve completed this' : 'Done another way (transfer, exam, or substitution)'))}</label>` : ''}
        ${!x.done && opts.length ? `<details class="ideas-opts" data-key="${r.key}">
          <summary class="small">Show ${opts.length} approved course${opts.length > 1 ? 's' : ''}${programCodes.size ? ` · ${opts.filter(o => o.alts.some(a => a.codes.some(c => programCodes.has(base(c))))).length} also count toward ${esc(program.name)}` : ''}</summary>
          <input type="search" class="ideas-filter" placeholder="Filter, e.g. COMP or Music" aria-label="Filter ${esc(r.label)} courses">
          <ul class="opts" data-list="${r.key}"></ul>
        </details>` : ''}
      </div>`;
    }).join('')}`;
}

// Fill an approved-course list (capped; program matches first, then filter matches).
function renderIdeasList(details) {
  const r = IDEAS.find(x => x.key === details.dataset.key);
  const q = details.querySelector('.ideas-filter').value.trim().toLowerCase();
  const program = state.current && state.parsed[state.current] && viewOf(state.parsed[state.current]);
  const programCodes = new Set();
  if (program) program.groups.forEach(g => g.options.forEach(o => o.alts?.forEach(a => a.codes.forEach(c => programCodes.add(base(c))))));
  const inProgram = o => o.alts.some(a => a.codes.some(c => programCodes.has(base(c))));
  const opts = ideasOptions(r)
    .filter(o => !q || o.alts.some(a => (a.codes.join(' ') + ' ' + a.title).toLowerCase().includes(q)))
    .sort((a, b) => inProgram(b) - inProgram(a));
  const shown = opts.slice(0, 60);
  details.querySelector('[data-list]').innerHTML = shown.map(o => o.alts.map((a, k) => `
    <li class="opt">
      ${k ? '<span class="or">or</span>' : ''}
      <span class="code">${esc(a.codes.join(' + '))}</span>
      <span class="title">${esc(a.title)}</span>
      ${inProgram(o) && !k ? `<span class="badge good">also ${esc(program.name)}</span>` : ''}
      ${a.codes.map(c => `<button class="link" data-course="${esc(c)}">Details</button>`).join('')}
      <span class="badges" data-badges="${esc(a.codes.join('|'))}">${a.codes.length === 1 ? badgesFor(a.codes[0]) : ''}</span>
      <div class="course-panel" data-panel="${esc(a.codes.join('|'))}"></div>
    </li>`).join('')).join('') +
    (opts.length > shown.length ? `<li class="small muted">${opts.length - shown.length} more. Type in the filter to narrow the list.</li>` : '') +
    (!opts.length ? '<li class="small muted">No matches.</li>' : '');
}

// ---------- PDF import (Tar Heel Tracker report / unofficial transcript) ----------
// The PDF is read in the browser with pdf.js; nothing is uploaded anywhere.
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
let pdfjsReady = null;
function loadPdfJs() {
  return pdfjsReady ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = PDFJS + 'pdf.min.js';
    s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js'; resolve(window.pdfjsLib); };
    s.onerror = () => { pdfjsReady = null; reject(new Error('Couldn\'t load the PDF reader. Check your internet connection.')); };
    document.head.appendChild(s);
  });
}

// Rebuild text lines from positioned text items (same baseline = same line, left to right).
async function pdfLines(file) {
  const lib = await loadPdfJs();
  const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
  const lines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const { items } = await (await pdf.getPage(p)).getTextContent();
    const rows = [];
    for (const it of items.filter(i => i.str.trim())) {
      const y = it.transform[5];
      let row = rows.find(r => Math.abs(r.y - y) < 3);
      if (!row) rows.push(row = { y, items: [] });
      row.items.push(it);
    }
    rows.sort((a, b) => b.y - a.y).forEach(r =>
      lines.push(clean(r.items.sort((a, b) => a.transform[4] - b.transform[4]).map(i => i.str).join(' '))));
  }
  return lines;
}

const GRADE_DONE = /^(?:[A-D][+-]?|P|PS|PX|CR|S|T|TR|TP)$/;
const GRADE_IP = /^(?:IP|NR)$/;
const GRADE_NONE = /^(?:W|WD|F|FA|FX|AB|IN|NG|U|NC)$/;
const TERM_RE = /\b(?:(?:FA|SP|SU|SS1|SS2|S1|S2)\s?\d{2,4}|(?:Fall|Spring|Summer(?: I{1,2})?)\s+\d{4}|\d{4}\s+(?:Fall|Spring|Summer(?: I{1,2})?))\b/i;
const NEEDED_RE = /still needed|needed:|course list|\bclass(?:es)? in\b|not satisfied|\bor\s+[A-Z]{2,5}\s+\d/i;

// Grade usually follows the credit hours ("Intro to Programming 3.000 A"); fall back to any grade-like token.
function classifyLine(line, code) {
  const [subj, n] = code.split(' ');
  const at = line.toUpperCase().search(new RegExp(`\\b${subj}\\s?${n}\\b`));
  const tokens = line.slice(at).split(/\s+/).slice(2);
  const firstNum = tokens.findIndex(t => /^\d+(?:\.\d+)?$/.test(t));
  const grade = (list => list.find(t => GRADE_DONE.test(t) || GRADE_IP.test(t) || GRADE_NONE.test(t)))
    (firstNum >= 0 ? tokens.slice(firstNum + 1) : []) ||
    [...tokens].reverse().find(t => GRADE_DONE.test(t) || GRADE_IP.test(t) || GRADE_NONE.test(t));
  if (grade) return { status: GRADE_NONE.test(grade) ? 'none' : GRADE_IP.test(grade) ? 'ip' : 'done', grade };
  return { status: TERM_RE.test(line) ? 'ip' : 'unknown', grade: '' };
}

function extractCourses(lines) {
  const RANK = { done: 4, ip: 3, none: 2, unknown: 1 };
  const found = new Map();
  for (const line of lines) {
    const codes = [...new Set(parseCodes(line))];
    if (!codes.length || NEEDED_RE.test(line)) continue;   // skip Tar Heel Tracker "still needed" lists
    for (const code of codes) {
      const c = codes.length > 1 ? { status: 'unknown', grade: '' } : classifyLine(line, code);
      const prev = found.get(code);
      if (!prev || RANK[c.status] > RANK[prev.status]) found.set(code, { code, ...c, line });   // retakes: best result wins
    }
  }
  return [...found.values()].sort((a, b) => a.code.localeCompare(b.code));
}

const IMPORT_GROUPS = [
  { status: 'done', title: 'Completed', note: 'Has a passing or transfer grade.', checked: true },
  { status: 'ip', title: 'In progress or registered', note: 'No final grade yet. Keep checked to plan as if you\'ll finish them.', checked: true },
  { status: 'none', title: 'Withdrawn, failed, or incomplete', note: 'These usually don\'t count.', checked: false },
  { status: 'unknown', title: 'Found without a grade', note: 'Could be a course you took, or one just mentioned in a requirement. Check only the ones you\'ve taken.', checked: false },
];

async function importPdf(file) {
  const msg = $('#add-msg');
  msg.textContent = `Reading ${file.name}…`;
  try {
    const courses = extractCourses(await pdfLines(file));
    if (!courses.length) {
      msg.textContent = 'No course codes found in that PDF. If it\'s a scanned image, copy the text from ConnectCarolina and paste it instead.';
      return;
    }
    msg.textContent = '';
    $('#import-body').innerHTML = `<p class="small muted">Found ${courses.length} course(s) in <b>${esc(file.name)}</b>. Courses already on your list are marked.</p>` +
      IMPORT_GROUPS.map(g => {
        const list = courses.filter(c => c.status === g.status);
        if (!list.length) return '';
        return `<fieldset class="import-group"><legend>${g.title} <span class="muted small">(${list.length})</span></legend>
          <p class="small muted">${g.note}</p>
          <div class="import-list">${list.map(c => `
            <label title="${esc(c.line)}"><input type="checkbox" value="${esc(c.code)}" ${g.checked ? 'checked' : ''}>
              <b>${esc(c.code)}</b>${c.grade ? ` <span class="muted small">${esc(c.grade)}</span>` : ''}${state.taken.includes(c.code) ? ' <span class="muted small">(already added)</span>' : ''}</label>`).join('')}</div>
        </fieldset>`;
      }).join('');
    $('#import-dialog').showModal();
  } catch (e) {
    msg.textContent = 'Couldn\'t read that PDF: ' + e.message;
  }
}

// ---------- tabs & events ----------
function switchTab(name) {
  document.querySelectorAll('[role=tab]').forEach(t => t.setAttribute('aria-selected', t.dataset.tab === name));
  document.querySelectorAll('[role=tabpanel]').forEach(p => { p.hidden = p.id !== 'panel-' + name; });
  if (name === 'ideas') renderIdeas();
}

function toggleCoursePanel(btn) {
  const panel = btn.closest('li').querySelector('.course-panel');
  if (panel.dataset.open === btn.dataset.course) { panel.innerHTML = ''; panel.dataset.open = ''; btn.textContent = 'Details'; return; }
  panel.dataset.open = btn.dataset.course;
  btn.closest('li').querySelectorAll('[data-course]').forEach(b => { b.textContent = 'Details'; });
  btn.textContent = 'Hide';
  renderCoursePanel(panel, btn.dataset.course);
}

function fillMinorSelect() {
  const opts = type => state.programs.filter(p => p.type === type).map(m => `<option value="${m.slug}">${esc(m.name)}</option>`).join('');
  $('#minor-select').innerHTML = '<option value="">Choose a major or minor…</option>' +
    `<optgroup label="Majors">${opts('major')}</optgroup><optgroup label="Minors">${opts('minor')}</optgroup>`;
  if (state.current) $('#minor-select').value = state.current;
}

function bind() {
  $('#add-form').addEventListener('submit', ev => {
    ev.preventDefault();
    const box = $('#add-input');
    const n = addTaken(box.value);
    $('#add-msg').textContent = n ? `Added ${n} course(s).` : 'No course codes found. Use the format COMP 110.';
    if (n) box.value = '';
  });
  $('#pdf-input').addEventListener('change', ev => {
    const file = ev.target.files[0];
    ev.target.value = '';   // let the same file be picked again
    if (file) importPdf(file);
  });
  $('#import-add').addEventListener('click', () => {
    const picked = [...document.querySelectorAll('#import-body input:checked')].map(i => i.value);
    const before = state.taken.length;
    if (picked.length) addTaken(picked.join(', '));
    $('#add-msg').textContent = `Imported ${state.taken.length - before} new course(s) from your PDF.`;
    $('#import-dialog').close();
  });
  $('#import-cancel').addEventListener('click', () => $('#import-dialog').close());
  $('#taken-list').addEventListener('click', ev => {
    const c = ev.target.dataset.remove;
    if (!c) return;
    state.taken = state.taken.filter(x => x !== c);
    save('taken', state.taken);
    onTakenChanged();
  });
  $('#clear-taken').addEventListener('click', () => {
    if (!state.taken.length || !confirm('Remove all of your courses?')) return;
    state.taken = []; save('taken', state.taken); onTakenChanged();
  });
  $('#term-select').addEventListener('change', ev => {
    state.term = ev.target.value; save('term', state.term);
    if (state.current) renderDetail(state.current);
  });
  document.querySelectorAll('[role=tab]').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $('#scan-btn').addEventListener('click', scanAll);
  $('#match-filter').addEventListener('change', () => state.scanned && renderMatches());
  $('#type-filter').addEventListener('change', () => { save('type', typeFilter()); if (state.scanned) renderMatches(); });
  $('#type-filter').value = load('type', 'minor');
  $('#matches').addEventListener('click', ev => { const b = ev.target.closest('[data-open]'); if (b) showMinor(b.dataset.open); });
  $('#minor-select').addEventListener('change', ev => { if (ev.target.value) showMinor(ev.target.value); });
  $('#detail').addEventListener('click', ev => {
    if (ev.target.id === 'check-all') return checkAllRemaining();
    const btn = ev.target.closest('[data-course]');
    if (btn) toggleCoursePanel(btn);
  });
  const ideas = $('#ideas');
  ideas.addEventListener('click', ev => { const btn = ev.target.closest('[data-course]'); if (btn) toggleCoursePanel(btn); });
  ideas.addEventListener('toggle', ev => { if (ev.target.matches('details.ideas-opts') && ev.target.open) renderIdeasList(ev.target); }, true);
  ideas.addEventListener('input', ev => { if (ev.target.matches('.ideas-filter')) renderIdeasList(ev.target.closest('details')); });
  ideas.addEventListener('change', ev => {
    if (ev.target.id === 'cohort') { state.cohort = ev.target.value; save('cohort', state.cohort); }
    const key = ev.target.dataset.ideasManual;
    if (key) { if (ev.target.checked) state.ideasManual[key] = true; else delete state.ideasManual[key]; save('ideas_manual', state.ideasManual); }
    if (ev.target.id === 'cohort' || key) { renderIdeas(); if (state.current) renderDetail(state.current); }
  });
  $('#detail').addEventListener('toggle', ev => {
    if (ev.target.matches('details.rule-courses') && ev.target.open && !ev.target.dataset.loaded) {
      ev.target.dataset.loaded = '1';
      renderRuleCourses(ev.target);
    }
  }, true);
  $('#detail').addEventListener('change', ev => {
    if (ev.target.matches('.only-offered')) { renderRuleCourses(ev.target.closest('details')); return; }
    const slug = state.current;
    if (ev.target.id === 'track-select') {
      if (ev.target.value === '') delete state.track[slug]; else state.track[slug] = +ev.target.value;
      save('track', state.track);
      renderDetail(slug);
      if (state.scanned) renderMatches();
      return;
    }
    const i = ev.target.dataset.manual;
    if (i == null) return;
    const key = viewOf(state.parsed[slug]).manualKey;
    state.manual[key] = { ...(state.manual[key] || {}), [i]: ev.target.checked };
    if (!ev.target.checked) delete state.manual[key][i];
    save('manual', state.manual);
    renderDetail(slug);
    if (state.scanned) renderMatches();
  });
}

async function init() {
  bind();
  renderTaken();
  try {
    const meta = JSON.parse(await api('/api/meta'));
    state.terms = meta.terms || [];
    state.subjects = new Set(meta.subjects || []);
    $('#term-select').innerHTML = '<option value="">All upcoming terms</option>' +
      state.terms.map(t => `<option ${t === state.term ? 'selected' : ''}>${esc(t)}</option>`).join('');
    if (state.term && !state.terms.includes(state.term)) { state.term = ''; save('term', ''); }
    renderTaken();
  } catch (e) {
    $('#status').textContent = 'Couldn\'t reach UNC Class Search: ' + e.message;
  }
  try { await loadPrograms(); fillMinorSelect(); }
  catch (e) { $('#status').textContent = 'Couldn\'t load the catalog: ' + e.message; }
  try {
    await loadIdeas();
    if (!$('#panel-ideas').hidden) renderIdeas();
    if (state.current) renderDetail(state.current);
  } catch (e) { $('#status').textContent = 'Couldn\'t load IDEAs in Action lists: ' + e.message; }
}

init();
