/* =====================================================================
   chartFactory.js — Environmental AI Analyst
   Builds Chart.js configs (and a couple of native-HTML visuals for cases
   Chart.js 4.x can't do without extra plugins, e.g. a correlation heatmap)
   dynamically from whatever columns DataProfiler + AnalysisSelector
   actually found in the uploaded dataset — titles, axis labels and which
   charts even get built are all derived from real column names/units,
   never hardcoded to the original fixed 8-parameter set.

   Depends on: AnalysisSelector (for capabilities/grouping/correlation).
   Does NOT depend on Chart.js directly — it only returns plain config
   objects; the caller is responsible for `new Chart(canvas, config)`.

   Pure vanilla JS, no dependencies. Exposes a single global: ChartFactory.
   ===================================================================== */
(function (global) {
  "use strict";

  const PALETTE = ["#0e6b52", "#1c6e8c", "#b1791f", "#0e8f83", "#8a4fae", "#c1443c", "#5b6b3e", "#3d5a80"];
  function colorFor(i) { return PALETTE[i % PALETTE.length]; }

  function defaultLabelFor(key) { return key; }
  function defaultUnitFor(key) { return ""; }

  /* ---------------------------------------------------------------------
     1. TIME SERIES (line) — one or more numeric columns plotted against
     the date column. Dual y-axis only when exactly 2 series are shown
     and their scales differ meaningfully (kept simple: 1 axis per series
     up to 2, then all share the primary axis beyond that to stay readable).
     --------------------------------------------------------------------- */
  function buildTimeSeriesConfig(rows, dateKey, numericKeys, opts) {
    opts = opts || {};
    const labelFor = opts.labelFor || defaultLabelFor;
    const unitFor = opts.unitFor || defaultUnitFor;
    const maxSeries = opts.maxSeries || 4;
    const keys = numericKeys.slice(0, maxSeries);

    const sorted = [...rows].sort((a, b) => String(a[dateKey]).localeCompare(String(b[dateKey])));
    const labels = sorted.map(r => r[dateKey]);

    const datasets = keys.map((k, i) => ({
      label: labelFor(k) + (unitFor(k) ? ` (${unitFor(k)})` : ""),
      data: sorted.map(r => (typeof r[k] === "number" ? r[k] : null)),
      borderColor: colorFor(i), backgroundColor: "transparent", tension: 0.3,
      yAxisID: keys.length <= 2 ? (i === 0 ? "y" : "y1") : "y",
    }));

    const scales = { x: { ticks: { maxRotation: 45 } } };
    if (keys.length <= 2) {
      scales.y = { type: "linear", position: "left", title: { display: true, text: labelFor(keys[0]) } };
      if (keys.length === 2) {
        scales.y1 = { type: "linear", position: "right", title: { display: true, text: labelFor(keys[1]) }, grid: { drawOnChartArea: false } };
      }
    }

    return {
      type: "line",
      data: { labels, datasets },
      options: { responsive: true, plugins: { legend: { position: "bottom" } }, scales },
      title: labelFor(keys[0]) + (keys.length > 1 ? ` & ${keys.length - 1} more` : "") + " over time",
      keys,
    };
  }

  /* ---------------------------------------------------------------------
     2. SCATTER — relationship between two numeric columns.
     --------------------------------------------------------------------- */
  function buildScatterConfig(rows, keyX, keyY, opts) {
    opts = opts || {};
    const labelFor = opts.labelFor || defaultLabelFor;
    const unitFor = opts.unitFor || defaultUnitFor;
    const points = rows.filter(r => typeof r[keyX] === "number" && typeof r[keyY] === "number")
      .map(r => ({ x: r[keyX], y: r[keyY] }));
    const xLabel = labelFor(keyX) + (unitFor(keyX) ? ` (${unitFor(keyX)})` : "");
    const yLabel = labelFor(keyY) + (unitFor(keyY) ? ` (${unitFor(keyY)})` : "");

    return {
      type: "scatter",
      data: { datasets: [{ label: `${labelFor(keyY)} vs ${labelFor(keyX)}`, data: points, backgroundColor: colorFor(2) }] },
      options: {
        responsive: true, plugins: { legend: { position: "bottom" } },
        scales: { x: { title: { display: true, text: xLabel } }, y: { title: { display: true, text: yLabel } } },
      },
      title: `${labelFor(keyY)} vs ${labelFor(keyX)}`,
      keys: [keyX, keyY],
    };
  }

  /* ---------------------------------------------------------------------
     3. CATEGORY / LOCATION BAR — average of each numeric column, grouped
     by whatever categorical/location column was detected.
     --------------------------------------------------------------------- */
  function buildCategoryBarConfig(rows, groupingKey, numericKeys, opts) {
    opts = opts || {};
    const labelFor = opts.labelFor || defaultLabelFor;
    const maxSeries = opts.maxSeries || 3;
    const keys = numericKeys.slice(0, maxSeries);

    const byGroup = {};
    rows.forEach(r => {
      const g = r[groupingKey] || "Unknown";
      if (!byGroup[g]) byGroup[g] = {};
      keys.forEach(k => {
        if (typeof r[k] === "number") {
          (byGroup[g][k] = byGroup[g][k] || []).push(r[k]);
        }
      });
    });
    const groupLabels = Object.keys(byGroup);
    const avg = arr => arr && arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) / 100 : 0;

    const datasets = keys.map((k, i) => ({
      label: labelFor(k),
      data: groupLabels.map(g => avg(byGroup[g][k])),
      backgroundColor: colorFor(i),
    }));

    return {
      type: "bar",
      data: { labels: groupLabels, datasets },
      options: { responsive: true, plugins: { legend: { position: "bottom" } }, scales: { x: { ticks: { maxRotation: 45 } } } },
      title: `Average ${keys.map(labelFor).join(", ")} by ${labelFor(groupingKey)}`,
      keys,
    };
  }

  /* ---------------------------------------------------------------------
     4. HISTOGRAM — binned distribution of a single numeric column.
     --------------------------------------------------------------------- */
  function buildHistogramConfig(rows, key, opts) {
    opts = opts || {};
    const labelFor = opts.labelFor || defaultLabelFor;
    const unitFor = opts.unitFor || defaultUnitFor;
    const binCount = opts.binCount || 10;

    const vals = rows.map(r => r[key]).filter(v => typeof v === "number" && !isNaN(v));
    if (!vals.length) return null;
    const min = Math.min(...vals), max = Math.max(...vals);
    const range = (max - min) || 1;
    const binSize = range / binCount;
    const bins = new Array(binCount).fill(0);
    vals.forEach(v => {
      let idx = Math.floor((v - min) / binSize);
      if (idx >= binCount) idx = binCount - 1;
      if (idx < 0) idx = 0;
      bins[idx]++;
    });
    const labels = bins.map((_, i) => {
      const lo = Math.round((min + i * binSize) * 100) / 100;
      const hi = Math.round((min + (i + 1) * binSize) * 100) / 100;
      return `${lo}–${hi}`;
    });

    return {
      type: "bar",
      data: { labels, datasets: [{ label: labelFor(key) + (unitFor(key) ? ` (${unitFor(key)})` : ""), data: bins, backgroundColor: colorFor(4) }] },
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { title: { display: true, text: labelFor(key) } }, y: { title: { display: true, text: "Count" } } } },
      title: `Distribution of ${labelFor(key)}`,
      keys: [key],
    };
  }

  /* ---------------------------------------------------------------------
     5. CORRELATION HEATMAP — rendered as plain HTML (color-coded table)
     rather than a Chart.js plugin, since no matrix/heatmap plugin is
     loaded. Caller injects the returned HTML string via innerHTML.
     --------------------------------------------------------------------- */
  function corrColor(r) {
    // -1 (red) .. 0 (neutral) .. +1 (green)
    if (isNaN(r)) return "#e8e4d8";
    const a = Math.min(1, Math.abs(r));
    if (r >= 0) {
      const g = Math.round(107 + (1 - a) * 90); // toward parchment as a->0
      return `rgba(14, 107, 82, ${0.15 + a * 0.65})`;
    }
    return `rgba(193, 68, 60, ${0.15 + a * 0.65})`;
  }

  function buildCorrelationHeatmapHTML(corrResult, opts) {
    opts = opts || {};
    const labelFor = opts.labelFor || defaultLabelFor;
    const { keys, matrix } = corrResult;
    if (!keys.length) return "";
    let html = '<table class="corr-heatmap"><thead><tr><th></th>';
    keys.forEach(k => { html += `<th>${labelFor(k)}</th>`; });
    html += "</tr></thead><tbody>";
    keys.forEach(k1 => {
      html += `<tr><th>${labelFor(k1)}</th>`;
      keys.forEach(k2 => {
        const v = matrix[k1][k2];
        html += `<td style="background:${corrColor(v)};" title="${labelFor(k1)} vs ${labelFor(k2)}: ${v}">${isNaN(v) ? "—" : v.toFixed(2)}</td>`;
      });
      html += "</tr>";
    });
    html += "</tbody></table>";
    return html;
  }

  /* ---------------------------------------------------------------------
     6. ORCHESTRATOR — given a capability report from AnalysisSelector,
     decide which charts actually get built and return them as a flat
     list ready to render. This is the single entry point Phase 5 wiring
     should call.
     --------------------------------------------------------------------- */
  function buildChartPlan(rows, selection, opts) {
    opts = opts || {};
    const { groups, capabilities, groupingKey } = selection;
    const plan = [];

    if (capabilities.timeSeries) {
      plan.push({ id: "auto_timeseries", kind: "chartjs", spec: buildTimeSeriesConfig(rows, groups.dateKey, groups.numericKeys, opts) });
    }

    if (capabilities.correlationMatrix) {
      const AS = global.AnalysisSelector;
      const corr = AS.correlationMatrix(rows, groups.numericKeys);
      // Strongest-correlated pair gets its own scatter plot, in addition to the heatmap.
      let bestPair = null, bestAbs = 0;
      groups.numericKeys.forEach((k1, i) => {
        groups.numericKeys.slice(i + 1).forEach(k2 => {
          const r = corr.matrix[k1][k2];
          if (!isNaN(r) && Math.abs(r) > bestAbs) { bestAbs = Math.abs(r); bestPair = [k1, k2]; }
        });
      });
      plan.push({ id: "auto_corr_heatmap", kind: "html", title: "Correlation Matrix", html: buildCorrelationHeatmapHTML(corr, opts) });
      if (bestPair) {
        plan.push({ id: "auto_scatter", kind: "chartjs", spec: buildScatterConfig(rows, bestPair[0], bestPair[1], opts) });
      }
    }

    if (capabilities.categoricalGrouping) {
      plan.push({ id: "auto_category_bar", kind: "chartjs", spec: buildCategoryBarConfig(rows, groupingKey, groups.numericKeys, opts) });
    }

    if (capabilities.distributionAnalysis) {
      const maxHistograms = opts.maxHistograms || 2;
      groups.numericKeys.slice(0, maxHistograms).forEach(k => {
        const spec = buildHistogramConfig(rows, k, opts);
        if (spec) plan.push({ id: "auto_hist_" + k, kind: "chartjs", spec });
      });
    }

    return plan;
  }

  global.ChartFactory = {
    buildTimeSeriesConfig, buildScatterConfig, buildCategoryBarConfig,
    buildHistogramConfig, buildCorrelationHeatmapHTML, buildChartPlan,
  };
})(typeof window !== "undefined" ? window : globalThis);
