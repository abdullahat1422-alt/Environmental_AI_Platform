/* =====================================================================
   analysisSelector.js — Environmental AI Analyst
   Decision-rule engine: given the columns/rows produced by DataProfiler,
   decides which analyses are runnable on THIS dataset, and provides
   generalized statistical routines (anomaly detection, correlation)
   that work over ANY numeric column — not just the original fixed
   8-parameter list (pm10, pm25, no2, rainfall, temperature, ndvi, ph, tds).

   Design note: this module is intentionally decoupled from the app's
   original getStatus()/WHO-EPA threshold table. Known parameters can
   still be scored against real reference thresholds by the caller (the
   main app keeps that table); this module supplies the *generic*
   statistical layer that works even when the uploaded dataset contains
   parameters nobody hard-coded a threshold for (heavy metals, custom
   indices, species counts, ...).

   Pure vanilla JS, no dependencies. Exposes a single global: AnalysisSelector.
   ===================================================================== */
(function (global) {
  "use strict";

  /* ---------------------------------------------------------------------
     0. SMALL STATS HELPERS
     --------------------------------------------------------------------- */
  function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN; }
  function stddev(arr) {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) * (v - m), 0) / arr.length);
  }
  function round(v, d) {
    d = d === undefined ? 2 : d;
    return isNaN(v) ? v : Math.round(v * Math.pow(10, d)) / Math.pow(10, d);
  }
  /* Pearson's moment coefficient of skewness (population estimate). */
  function skewness(vals) {
    const n = vals.length;
    if (n < 3) return 0;
    const m = mean(vals);
    const sd = stddev(vals);
    if (sd === 0) return 0;
    const m3 = vals.reduce((s, v) => s + Math.pow(v - m, 3), 0) / n;
    return m3 / Math.pow(sd, 3);
  }
  /* Linear-interpolation percentile over a PRE-SORTED array. */
  function percentile(sorted, p) {
    if (!sorted.length) return NaN;
    const idx = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }
  function pearsonCorrelation(rows, keyX, keyY) {
    const pairs = rows.filter(r =>
      typeof r[keyX] === "number" && !isNaN(r[keyX]) &&
      typeof r[keyY] === "number" && !isNaN(r[keyY])
    );
    const n = pairs.length;
    if (n < 3) return NaN;
    const xs = pairs.map(r => r[keyX]), ys = pairs.map(r => r[keyY]);
    const mx = mean(xs), my = mean(ys);
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2; }
    const denom = Math.sqrt(dx * dy);
    return denom === 0 ? NaN : num / denom;
  }

  /* ---------------------------------------------------------------------
     1. COLUMN CLASSIFICATION — group DataProfiler columns by role.
     `columns` is the `columns` array produced by DataProfiler.profileGrid()
     / profileWorkbook(): [{colIdx, internalKey, dataType, semanticCategory, ...}]
     --------------------------------------------------------------------- */
  function classifyColumns(columns) {
    const dateCol = columns.find(c => c.internalKey === "date" || c.dataType === "datetime");
    const locationCol = columns.find(c => c.internalKey === "location");
    const latCol = columns.find(c => c.internalKey === "latitude");
    const lonCol = columns.find(c => c.internalKey === "longitude");

    // "Measurement" numeric columns: continuous or count, excluding coordinates.
    const numericCols = columns.filter(c =>
      (c.dataType === "numeric_continuous" || c.dataType === "numeric_count") &&
      c.internalKey !== "latitude" && c.internalKey !== "longitude"
    );

    // Categorical columns other than location (e.g. species name, station type, sample id).
    const categoricalCols = columns.filter(c =>
      c.dataType === "categorical" && c.internalKey !== "location"
    );

    return {
      dateKey: dateCol ? dateCol.internalKey : null,
      locationKey: locationCol ? locationCol.internalKey : null,
      latKey: latCol ? latCol.internalKey : null,
      lonKey: lonCol ? lonCol.internalKey : null,
      numericKeys: numericCols.map(c => c.internalKey),
      categoricalKeys: categoricalCols.map(c => c.internalKey),
    };
  }

  /* ---------------------------------------------------------------------
     2. CAPABILITY SELECTION — which analyses/charts make sense to run,
     given what was actually detected in this dataset. The rest of the
     app should gate every chart/section behind these flags instead of
     assuming the fixed 8 parameters are always present.
     --------------------------------------------------------------------- */
  function selectCapabilities(columns, rows) {
    const groups = classifyColumns(columns);
    const hasDate = !!groups.dateKey;
    const hasLocation = !!groups.locationKey;
    const hasCoordinates = !!(groups.latKey && groups.lonKey);
    const numericCount = groups.numericKeys.length;
    const groupingKey = groups.locationKey || groups.categoricalKeys[0] || null;

    const capabilities = {
      timeSeries: hasDate && numericCount >= 1,
      spatialMap: hasCoordinates,
      correlationMatrix: numericCount >= 2,
      categoricalGrouping: !!groupingKey && numericCount >= 1,
      distributionAnalysis: numericCount >= 1,
      anomalyDetection: numericCount >= 1 && rows.length >= 4,
      descriptiveOnly: numericCount === 0,
    };

    return { groups, capabilities, groupingKey };
  }

  /* ---------------------------------------------------------------------
     3. GENERALIZED ANOMALY DETECTION
     Runs over ANY set of numeric column keys. Per column, picks Z-score
     (assumes roughly-symmetric distribution) or IQR/Tukey fences (robust
     to skew — Iglewicz & Hoaglin, 1993) based on measured skewness, so a
     single heavy-tailed column doesn't get miscalibrated by a symmetric
     assumption that doesn't hold for it.
     Returns: [{ date, location, param, value, method, score, severity, direction }]
     --------------------------------------------------------------------- */
  function detectAnomaliesGeneric(rows, numericKeys, opts) {
    opts = opts || {};
    const skewThreshold = opts.skewThreshold != null ? opts.skewThreshold : 1;
    const dateKey = opts.dateKey || "date";
    const locationKey = opts.locationKey || "location";
    const results = [];

    numericKeys.forEach(colKey => {
      const vals = rows.map(r => r[colKey]).filter(v => typeof v === "number" && !isNaN(v));
      if (vals.length < 4) return; // not enough data to establish a baseline

      const skew = skewness(vals);
      const useIqr = Math.abs(skew) > skewThreshold;

      if (!useIqr) {
        const m = mean(vals), sd = stddev(vals);
        if (sd === 0) return;
        rows.forEach(r => {
          const v = r[colKey];
          if (typeof v !== "number" || isNaN(v)) return;
          const z = (v - m) / sd;
          const az = Math.abs(z);
          if (az > 2) {
            const severity = az >= 3 ? "Critical" : (az >= 2.5 ? "High" : "Moderate");
            results.push({
              date: r[dateKey] || "—", location: r[locationKey] || "—", param: colKey,
              value: v, method: "zscore", score: round(z, 2), severity, direction: z > 0 ? "high" : "low",
            });
          }
        });
      } else {
        const sorted = [...vals].sort((a, b) => a - b);
        const q1 = percentile(sorted, 25), q3 = percentile(sorted, 75);
        const iqr = q3 - q1;
        if (iqr === 0) return;
        const lowerMild = q1 - 1.5 * iqr, upperMild = q3 + 1.5 * iqr;
        const lowerExtreme = q1 - 3 * iqr, upperExtreme = q3 + 3 * iqr;
        rows.forEach(r => {
          const v = r[colKey];
          if (typeof v !== "number" || isNaN(v)) return;
          if (v < lowerMild || v > upperMild) {
            const extreme = v < lowerExtreme || v > upperExtreme;
            const severity = extreme ? "Critical" : "Moderate";
            const distIqr = v > upperMild ? (v - q3) / iqr : (q1 - v) / iqr;
            results.push({
              date: r[dateKey] || "—", location: r[locationKey] || "—", param: colKey,
              value: v, method: "iqr", score: round(distIqr, 2), severity, direction: v > upperMild ? "high" : "low",
            });
          }
        });
      }
    });

    const rank = { Critical: 3, High: 2, Moderate: 1 };
    results.sort((a, b) => rank[b.severity] - rank[a.severity] || Math.abs(b.score) - Math.abs(a.score));
    return results;
  }

  /* ---------------------------------------------------------------------
     4. CORRELATION MATRIX — Pearson r between every pair of numeric columns.
     --------------------------------------------------------------------- */
  function correlationMatrix(rows, numericKeys) {
    const matrix = {};
    numericKeys.forEach(k1 => {
      matrix[k1] = {};
      numericKeys.forEach(k2 => {
        matrix[k1][k2] = k1 === k2 ? 1 : round(pearsonCorrelation(rows, k1, k2), 3);
      });
    });
    return { keys: numericKeys, matrix };
  }

  /* ---------------------------------------------------------------------
     5. GENERIC LOCATION RISK — anomaly-density based, works for ANY
     grouping column (not just a "location" semantic match), so it also
     supports categorical grouping keys when no location column exists.
     For parameters with KNOWN reference thresholds, the caller (main app)
     should blend in getStatus()-style scoring separately; this function
     only knows about statistical anomaly density, which is always
     computable regardless of what the columns mean.
     --------------------------------------------------------------------- */
  function computeGroupRisk(rows, anomalies, groupingKey) {
    if (!groupingKey) return [];
    const byGroup = {};
    rows.forEach(r => {
      const g = r[groupingKey] || "Unknown";
      if (!byGroup[g]) byGroup[g] = { group: g, rows: [], latitude: r.latitude, longitude: r.longitude };
      byGroup[g].rows.push(r);
    });

    return Object.values(byGroup).map(entry => {
      const groupAnomalies = anomalies.filter(a => a.location === entry.group);
      const rate = entry.rows.length ? groupAnomalies.length / entry.rows.length : 0;
      let risk = Math.min(100, round(rate * 100 * 2, 0));
      let recommendation;
      if (risk <= 25) recommendation = "Low";
      else if (risk <= 50) recommendation = "Medium";
      else if (risk <= 75) recommendation = "High";
      else recommendation = "Urgent";
      return {
        location: entry.group, latitude: entry.latitude, longitude: entry.longitude,
        records: entry.rows.length, anomalyCount: groupAnomalies.length, risk, recommendation,
      };
    }).sort((a, b) => b.risk - a.risk);
  }

  global.AnalysisSelector = {
    mean, stddev, skewness, percentile, pearsonCorrelation, round,
    classifyColumns, selectCapabilities,
    detectAnomaliesGeneric, correlationMatrix, computeGroupRisk,
  };
})(typeof window !== "undefined" ? window : globalThis);
