/* =====================================================================
   dataProfiler.js — Environmental AI Analyst
   Generic, format-agnostic ingestion + column classification engine.

   Responsibilities:
   1. Given a raw 2D array of cell values (from a sheet or parsed CSV),
      auto-detect which row is the real header row (title/notes rows
      above it are common in real-world exports).
   2. Given a workbook with multiple sheets, identify which sheets look
      like tabular data (candidates) vs. cover/notes sheets.
   3. Normalize messy values: missing-value tokens ("NA","-","غير متوفر"),
      numbers (Arabic-Indic digits, decimal vs thousands separators),
      dates (ISO, DD/MM/YYYY, MM/DD/YYYY, Excel serials, Arabic text).
   4. Classify each column's data type (datetime / numeric_continuous /
      numeric_count / categorical / coordinate).
   5. Classify each column's environmental *semantic meaning* (PM10,
      rainfall, NDVI, pH, location, ...) using a tiered matcher:
      exact alias match -> fuzzy match (Levenshtein/includes) -> none.

   Design note: the output of profileWorkbook()/profileColumns() is
   shaped to stay compatible with the existing fixed-key pipeline
   (row.pm10, row.date, row.location, ...) so the rest of the app
   (anomaly detection, charts, report) keeps working unchanged. Any
   column that cannot be confidently classified is kept under its own
   cleaned header name as a generic column, exactly like before.

   Pure vanilla JS, no dependencies. Exposes a single global: DataProfiler.
   ===================================================================== */
(function (global) {
  "use strict";

  /* ---------------------------------------------------------------------
     1. SEMANTIC DICTIONARY — expandable, bilingual, grouped by category.
     Each entry: canonical internal key -> { category, aliases[], unit_hint }
     Aliases are matched after normalization (lowercase, unit-stripped,
     punctuation-stripped). Order doesn't matter; exact match wins first.
     --------------------------------------------------------------------- */
  const SEMANTIC_DICTIONARY = {
    // --- Core / structural ---
    date:        { category: "core", aliases: ["date","sampling_date","sample_date","timestamp","time","التاريخ","تاريخ","الوقت"] },
    location:    { category: "core", aliases: ["location","site","station","name","site_name","monitoring_station","الموقع","موقع","المحطة","محطة","اسم الموقع"] },
    latitude:    { category: "core", aliases: ["latitude","lat","خط العرض","خط_العرض","العرض"] },
    longitude:   { category: "core", aliases: ["longitude","lon","lng","long","خط الطول","خط_الطول","الطول"] },

    // --- Air quality ---
    pm10:  { category: "air_quality", aliases: ["pm10","pm_10","pm 10"] },
    pm25:  { category: "air_quality", aliases: ["pm2.5","pm25","pm_2.5","pm_25","pm 2.5","الجسيمات الدقيقة"] },
    no2:   { category: "air_quality", aliases: ["no2","nitrogen dioxide","أكسيد النيتروجين","ثاني أكسيد النيتروجين"] },
    so2:   { category: "air_quality", aliases: ["so2","sulfur dioxide","ثاني أكسيد الكبريت"] },
    co:    { category: "air_quality", aliases: ["co","carbon monoxide","أول أكسيد الكربون"] },
    o3:    { category: "air_quality", aliases: ["o3","ozone","الأوزون"] },
    aqi:   { category: "air_quality", aliases: ["aqi","air quality index","مؤشر جودة الهواء"] },

    // --- Climate ---
    rainfall:    { category: "climate", aliases: ["rainfall","precipitation","rain","rain_mm","الأمطار","امطار","هطول الأمطار","هطول"] },
    temperature: { category: "climate", aliases: ["temperature","temp","درجة الحرارة","الحرارة"] },
    humidity:    { category: "climate", aliases: ["humidity","relative humidity","الرطوبة","رطوبة"] },
    wind_speed:  { category: "climate", aliases: ["wind speed","wind_speed","windspeed","سرعة الرياح","الرياح"] },

    // --- Vegetation ---
    ndvi: { category: "vegetation", aliases: ["ndvi"] },
    evi:  { category: "vegetation", aliases: ["evi"] },
    vegetation_cover: { category: "vegetation", aliases: ["vegetation cover","veg cover","الغطاء النباتي","غطاء نباتي"] },

    // --- Water quality ---
    ph:        { category: "water_quality", aliases: ["ph"] },
    ec:        { category: "water_quality", aliases: ["ec","electrical_conductivity","electrical conductivity","التوصيل الكهربائي"] },
    tds:       { category: "water_quality", aliases: ["tds","total dissolved solids","الأملاح الذائبة"] },
    turbidity: { category: "water_quality", aliases: ["turbidity","عكارة","العكارة"] },
    do:        { category: "water_quality", aliases: ["do","dissolved oxygen","أكسجين مذاب","الأكسجين المذاب"] },
    lead:      { category: "water_quality", aliases: ["pb","lead","الرصاص"] },
    cadmium:   { category: "water_quality", aliases: ["cd","cadmium","الكادميوم"] },
    mercury:   { category: "water_quality", aliases: ["hg","mercury","الزئبق"] },

    // --- Biodiversity ---
    species_count: { category: "biodiversity", aliases: ["species count","species_count","عدد الأنواع"] },
    abundance:     { category: "biodiversity", aliases: ["abundance","الوفرة"] },
    biodiversity_index: { category: "biodiversity", aliases: ["biodiversity index","مؤشر التنوع الحيوي"] },
  };

  /* Missing-value tokens (case-insensitive, trimmed match) */
  const MISSING_TOKENS = new Set([
    "", "na", "n/a", "n\\a", "-", "--", "null", "none", "nil", "nan", "?",
    "غير متوفر", "غير معروف", "لا يوجد", "لايوجد", "فارغ", "بدون بيانات", "#n/a"
  ]);

  /* ---------------------------------------------------------------------
     2. STRING / NUMBER / DATE NORMALIZATION
     --------------------------------------------------------------------- */
  function normalizeStr(s) {
    return String(s == null ? "" : s).trim();
  }

  function normalizeHeaderText(h) {
    return normalizeStr(h)
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^\p{L}\p{N}._]/gu, "");
  }

  /* Strip a trailing "(unit)" pattern from a header, e.g. "PM2.5 (µg/m3)" -> {clean:"PM2.5", unit:"µg/m3"} */
  function stripUnitFromHeader(header) {
    const s = normalizeStr(header);
    const m = s.match(/^(.*?)[\s]*[\(\[]([^)\]]+)[\)\]]\s*$/u);
    if (m) return { clean: m[1].trim(), unit: m[2].trim() };
    return { clean: s, unit: "" };
  }

  function isMissingToken(v) {
    if (v === null || v === undefined) return true;
    const s = normalizeStr(v).toLowerCase();
    return MISSING_TOKENS.has(s);
  }

  function arabicIndicToWestern(s) {
    return String(s)
      .replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
      .replace(/[۰-۹]/g, d => "۰۱۲۳۴۵۶۷۸۹".indexOf(d));
  }

  /* Robust number parser: Arabic digits, decimal-vs-thousands disambiguation,
     stripped units/currency/percent symbols. Returns NaN if not parseable. */
  function parseNumberSmart(raw) {
    if (typeof raw === "number") return raw;
    if (raw === null || raw === undefined) return NaN;
    let s = arabicIndicToWestern(String(raw)).trim();
    if (isMissingToken(s)) return NaN;
    s = s.replace(/[%\s]/g, "");
    s = s.replace(/[^\d.,\-eE]/g, ""); // strip currency/unit symbols etc.
    if (s === "" || s === "-") return NaN;

    const hasDot = s.includes(".");
    const hasComma = s.includes(",");
    if (hasDot && hasComma) {
      // Whichever separator appears last is the decimal separator.
      const lastDot = s.lastIndexOf(".");
      const lastComma = s.lastIndexOf(",");
      if (lastComma > lastDot) {
        s = s.replace(/\./g, "").replace(",", ".");
      } else {
        s = s.replace(/,/g, "");
      }
    } else if (hasComma && !hasDot) {
      // Single comma with exactly 2 trailing digits -> likely decimal (European style).
      const parts = s.split(",");
      if (parts.length === 2 && parts[1].length <= 2) {
        s = parts[0].replace(/,/g, "") + "." + parts[1];
      } else {
        s = s.replace(/,/g, ""); // thousands separator
      }
    }
    const n = parseFloat(s);
    return isNaN(n) ? NaN : n;
  }

  const MONTH_AR = {
    "يناير": 1, "فبراير": 2, "مارس": 3, "أبريل": 4, "ابريل": 4, "مايو": 5, "يونيو": 6,
    "يوليو": 7, "أغسطس": 8, "اغسطس": 8, "سبتمبر": 9, "أكتوبر": 10, "اكتوبر": 10,
    "نوفمبر": 11, "ديسمبر": 12
  };
  const MONTH_EN = {
    january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
    may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
    september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12
  };

  /* Excel serial date -> JS Date (Excel epoch 1899-12-30, accounting for the 1900 leap-year bug) */
  function excelSerialToDate(serial) {
    const utcDays = Math.floor(serial - 25569);
    const utcValue = utcDays * 86400;
    return new Date(utcValue * 1000);
  }

  /* Attempts several date formats and returns an ISO 'YYYY-MM-DD' string, or null. */
  function parseDateSmart(raw) {
    if (raw === null || raw === undefined || raw === "") return null;
    if (typeof raw === "number" && raw > 20000 && raw < 60000) {
      // Plausible Excel serial date (roughly years 1954-2064).
      const d = excelSerialToDate(raw);
      if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
    const s = arabicIndicToWestern(String(raw)).trim();
    if (isMissingToken(s)) return null;

    // ISO: YYYY-MM-DD
    let m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
    if (m) return isoFrom(+m[1], +m[2], +m[3]);

    // DD/MM/YYYY or MM/DD/YYYY (disambiguate: if first part > 12, it's the day)
    m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
    if (m) {
      let a = +m[1], b = +m[2], y = +m[3];
      if (a > 12) return isoFrom(y, b, a);       // DD/MM/YYYY
      if (b > 12) return isoFrom(y, a, b);       // MM/DD/YYYY
      return isoFrom(y, b, a);                    // ambiguous -> assume DD/MM/YYYY (more common internationally)
    }

    // Arabic month name text, e.g. "5 يناير 2024" or "يناير 2024"
    for (const name in MONTH_AR) {
      if (s.includes(name)) {
        const yearMatch = s.match(/\d{4}/);
        const dayMatch = s.match(/^(\d{1,2})\s/);
        const y = yearMatch ? +yearMatch[0] : null;
        const d = dayMatch ? +dayMatch[1] : 1;
        if (y) return isoFrom(y, MONTH_AR[name], d);
      }
    }

    // English month name text, e.g. "January 5, 2024", "5 Jan 2024", "Jan 2024"
    const lower = s.toLowerCase();
    for (const name in MONTH_EN) {
      if (new RegExp("\\b" + name + "\\b").test(lower)) {
        const yearMatch = s.match(/\d{4}/);
        const y = yearMatch ? +yearMatch[0] : null;
        if (!y) continue; // require an explicit 4-digit year — never guess one
        let d = 1;
        const dayCandidates = s.match(/\b\d{1,2}\b/g) || [];
        if (dayCandidates.length) d = +dayCandidates[0];
        return isoFrom(y, MONTH_EN[name], d);
      }
    }

    // Deliberately NO generic native Date() fallback beyond this point: V8's
    // Date constructor is dangerously lenient and will happily "parse" plain
    // text like "Station 1" or "محطة 1" into a bogus date (confirmed via the
    // dataProfiler test suite — this silently corrupted a location column
    // during Phase 2 ingestion testing). Every real date format we support is
    // handled explicitly above; anything else is genuinely not a date.
    return null;
  }
  function isoFrom(y, mo, d) {
    const mm = String(mo).padStart(2, "0"), dd = String(d).padStart(2, "0");
    return `${y}-${mm}-${dd}`;
  }

  /* ---------------------------------------------------------------------
     3. FUZZY MATCHING (Levenshtein distance)
     --------------------------------------------------------------------- */
  function levenshtein(a, b) {
    if (a === b) return 0;
    const al = a.length, bl = b.length;
    if (al === 0) return bl;
    if (bl === 0) return al;
    let prev = new Array(bl + 1);
    for (let j = 0; j <= bl; j++) prev[j] = j;
    for (let i = 1; i <= al; i++) {
      const cur = [i];
      for (let j = 1; j <= bl; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      }
      prev = cur;
    }
    return prev[bl];
  }

  /* Returns {key, category, confidence} for the best semantic match, or null. */
  function matchSemanticKey(rawHeader) {
    const { clean, unit } = stripUnitFromHeader(rawHeader);
    const norm = normalizeHeaderText(clean);
    if (!norm) return null;

    // Tier 1: exact alias match (after normalization) — same guarantee as the
    // original fixed dictionary, so previously-working files keep working.
    for (const key in SEMANTIC_DICTIONARY) {
      const entry = SEMANTIC_DICTIONARY[key];
      for (const alias of entry.aliases) {
        if (normalizeHeaderText(alias) === norm) {
          return { key, category: entry.category, confidence: 1, unit };
        }
      }
    }

    // Tier 2: substring / includes match (handles "PM 2.5 concentration", "NO2 levels")
    for (const key in SEMANTIC_DICTIONARY) {
      const entry = SEMANTIC_DICTIONARY[key];
      for (const alias of entry.aliases) {
        const aliasNorm = normalizeHeaderText(alias);
        if (aliasNorm.length >= 2 && (norm.includes(aliasNorm) || aliasNorm.includes(norm))) {
          return { key, category: entry.category, confidence: 0.85, unit };
        }
      }
    }

    // Tier 3: fuzzy (Levenshtein) match — catches typos / minor variants.
    let best = null;
    for (const key in SEMANTIC_DICTIONARY) {
      const entry = SEMANTIC_DICTIONARY[key];
      for (const alias of entry.aliases) {
        const aliasNorm = normalizeHeaderText(alias);
        if (!aliasNorm) continue;
        const dist = levenshtein(norm, aliasNorm);
        const maxLen = Math.max(norm.length, aliasNorm.length);
        const similarity = 1 - dist / maxLen;
        if (similarity >= 0.72 && (!best || similarity > best.confidence)) {
          best = { key, category: entry.category, confidence: Math.round(similarity * 100) / 100, unit };
        }
      }
    }
    return best;
  }

  /* ---------------------------------------------------------------------
     4. DATA TYPE CLASSIFICATION (per column, given sample values)
     --------------------------------------------------------------------- */
  function classifyDataType(values, semanticKey) {
    const nonEmpty = values.filter(v => !isMissingToken(v));
    if (!nonEmpty.length) return "categorical";

    if (semanticKey === "latitude" || semanticKey === "longitude") return "coordinate";
    if (semanticKey === "date") return "datetime";
    if (semanticKey === "location") return "categorical"; // never let a station/site-name column be misread as a date

    const dateHits = nonEmpty.filter(v => parseDateSmart(v) !== null).length;
    if (dateHits / nonEmpty.length > 0.7) return "datetime";

    const numHits = nonEmpty.filter(v => !isNaN(parseNumberSmart(v))).length;
    if (numHits / nonEmpty.length > 0.7) {
      // A recognized environmental measurement (PM10, pH, rainfall, temperature...)
      // is always treated as continuous, regardless of how few sample rows we saw —
      // the count-vs-continuous heuristic below is only meaningful for columns that
      // aren't already semantically classified as physical measurements.
      const knownEntry = semanticKey && SEMANTIC_DICTIONARY[semanticKey];
      const isKnownMeasurement = knownEntry && knownEntry.category !== "core" && semanticKey !== "species_count";
      if (isKnownMeasurement) return "numeric_continuous";

      const nums = nonEmpty.map(parseNumberSmart).filter(v => !isNaN(v));
      const allInts = nums.every(n => Number.isInteger(n));
      const smallRange = nums.length && (Math.max(...nums) - Math.min(...nums)) <= Math.max(...nums, 1) && Math.max(...nums) < 10000;
      return (allInts && smallRange) ? "numeric_count" : "numeric_continuous";
    }
    return "categorical";
  }

  /* ---------------------------------------------------------------------
     5. HEADER ROW AUTO-DETECTION
     Scans the first `scanRows` rows of a 2D array and scores each as a
     header-row candidate: a real header row tends to have (a) mostly
     non-empty cells, (b) mostly unique text values, (c) little numeric
     content, and (d) at least one subsequent row that looks more numeric
     / data-like than it does.
     --------------------------------------------------------------------- */
  function detectHeaderRow(grid, scanRows) {
    scanRows = Math.min(scanRows || 15, grid.length);
    let bestIdx = 0, bestScore = -Infinity;

    for (let i = 0; i < scanRows; i++) {
      const row = grid[i] || [];
      const nonEmpty = row.filter(c => !isMissingToken(c));
      if (nonEmpty.length < 2) continue; // too sparse to be a header row

      const uniqueRatio = new Set(nonEmpty.map(v => normalizeStr(v).toLowerCase())).size / nonEmpty.length;
      const textRatio = nonEmpty.filter(v => isNaN(parseNumberSmart(v))).length / nonEmpty.length;
      const fillRatio = nonEmpty.length / row.length;

      // Look ahead: does the row right after look more "data-like" (more numeric)?
      const nextRow = grid[i + 1] || [];
      const nextNonEmpty = nextRow.filter(c => !isMissingToken(c));
      const nextNumRatio = nextNonEmpty.length
        ? nextNonEmpty.filter(v => !isNaN(parseNumberSmart(v)) || parseDateSmart(v) !== null).length / nextNonEmpty.length
        : 0;

      const score = uniqueRatio * 2 + textRatio * 2 + fillRatio * 1.5 + nextNumRatio * 1.5 + (nonEmpty.length >= 3 ? 0.5 : 0);
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    return bestIdx;
  }

  /* ---------------------------------------------------------------------
     6. SHEET CANDIDATE DETECTION (multi-sheet workbooks)
     `sheets` is an array of {name, grid} where grid is a 2D array of cell
     values (already extracted by the caller via SheetJS sheet_to_json).
     --------------------------------------------------------------------- */
  function rankSheetCandidates(sheets) {
    return sheets.map(s => {
      const grid = s.grid || [];
      if (grid.length < 2) return { name: s.name, looksLikeData: false, score: 0, rowCount: grid.length };
      const headerIdx = detectHeaderRow(grid, 15);
      const dataRows = grid.slice(headerIdx + 1).filter(r => (r || []).some(c => !isMissingToken(c)));
      const headerRow = grid[headerIdx] || [];
      const colCount = headerRow.filter(c => !isMissingToken(c)).length;
      const looksLikeData = dataRows.length >= 2 && colCount >= 2;
      // Score sheets so the caller can pick the best default (most rows/cols = most likely the main table).
      const score = dataRows.length * 2 + colCount;
      return { name: s.name, looksLikeData, score, rowCount: dataRows.length, colCount, headerRowIndex: headerIdx };
    }).sort((a, b) => b.score - a.score);
  }

  /* ---------------------------------------------------------------------
     7. MAIN ENTRY POINTS
     --------------------------------------------------------------------- */

  /* Profiles a single 2D grid (one sheet or one parsed CSV) into
     {rows, keys, columns, headerRowIndex} where:
       - rows: array of plain objects keyed by resolved internal key
               (semantic key if matched, else a cleaned generic key)
       - keys: unique list of those keys (same contract as before)
       - columns: profiling detail per column, for the confirmation UI
       - headerRowIndex: which row index was used as the header
  */
  function profileGrid(grid, opts) {
    opts = opts || {};
    const headerRowIndex = opts.headerRowIndex !== undefined ? opts.headerRowIndex : detectHeaderRow(grid, 15);
    const headerRow = grid[headerRowIndex] || [];
    const dataRows2D = grid.slice(headerRowIndex + 1).filter(r => (r || []).some(c => !isMissingToken(c)));

    const columns = headerRow.map((rawHeader, colIdx) => {
      if (isMissingToken(rawHeader)) return null;
      const { clean, unit: headerUnit } = stripUnitFromHeader(rawHeader);
      const sampleValues = dataRows2D.slice(0, 60).map(r => r[colIdx]);
      const semantic = matchSemanticKey(rawHeader);
      const internalKey = semantic ? semantic.key : normalizeHeaderText(clean) || `col_${colIdx}`;
      const dataType = classifyDataType(sampleValues, internalKey);
      return {
        colIdx, rawHeader: normalizeStr(rawHeader), cleanHeader: clean,
        unit: (semantic && semantic.unit) || headerUnit || "",
        internalKey, semanticCategory: semantic ? semantic.category : "unclassified",
        confidence: semantic ? semantic.confidence : 0, dataType,
      };
    }).filter(Boolean);

    const rows = dataRows2D.map(r => {
      const obj = {};
      columns.forEach(col => {
        let v = r[col.colIdx];
        if (isMissingToken(v)) { obj[col.internalKey] = ""; return; }
        if (col.dataType === "datetime") {
          const iso = parseDateSmart(v);
          obj[col.internalKey] = iso || v;
        } else if (col.dataType === "numeric_continuous" || col.dataType === "numeric_count" || col.dataType === "coordinate") {
          const n = parseNumberSmart(v);
          obj[col.internalKey] = isNaN(n) ? v : n;
        } else {
          obj[col.internalKey] = normalizeStr(v);
        }
      });
      return obj;
    });

    return { rows, keys: [...new Set(columns.map(c => c.internalKey))], columns, headerRowIndex };
  }

  /* Profiles a multi-sheet workbook (array of {name, grid}). Returns the
     ranked sheet candidates plus a full profile of the top-ranked sheet
     (or a caller-specified sheet name), so the UI can offer a picker only
     when there's genuine ambiguity (more than one data-shaped sheet). */
  function profileWorkbook(sheets, opts) {
    opts = opts || {};
    const candidates = rankSheetCandidates(sheets);
    const dataSheets = candidates.filter(c => c.looksLikeData);
    const chosenName = opts.sheetName || (dataSheets[0] || candidates[0]).name;
    const chosenSheet = sheets.find(s => s.name === chosenName) || sheets[0];
    const profile = profileGrid(chosenSheet.grid, { headerRowIndex: opts.headerRowIndex });
    return {
      candidates,
      needsSheetPicker: dataSheets.length > 1,
      chosenSheetName: chosenName,
      ...profile,
    };
  }

  global.DataProfiler = {
    SEMANTIC_DICTIONARY, MISSING_TOKENS,
    isMissingToken, parseNumberSmart, parseDateSmart, stripUnitFromHeader,
    normalizeHeaderText, levenshtein, matchSemanticKey, classifyDataType,
    detectHeaderRow, rankSheetCandidates, profileGrid, profileWorkbook,
  };
})(typeof window !== "undefined" ? window : globalThis);
