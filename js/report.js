import { db } from './firebase-config.js';
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js";
import { collection, onSnapshot, doc, getDoc, getDocs } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";

const auth = getAuth();

// Global variables to store data and chart instances (prevents chart overlap/flicker)
let allDetections = [];
let filteredDetections = [];
let trendChartInstance = null;
let typeChartInstance = null;
let currentRangeLabel = "Last 7 Days";

// 1. Initialise Firebase real-time listener
function initReportData() {
    onSnapshot(collection(db, "detections"), (snapshot) => {
        allDetections = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            // Exclude disputed (reverted) detections from all analytics
            // Reference: ISO 45001:2018 Clause 10.2 — Corrective Action
            if (data.disputed === true) return;
            allDetections.push(data);
        });
        // After receiving data, filter by the currently-selected date range and re-render
        applyDateFilter(document.querySelector('.filter-group button.active').dataset.range);
    });
}

// 2. Core logic: time-range filter
function applyDateFilter(daysStr) {
    const now = new Date();
    let cutoffTime = 0; // 0 means All Time

    if (daysStr !== 'all') {
        const days = parseInt(daysStr);
        cutoffTime = new Date(now.getTime() - (days * 24 * 60 * 60 * 1000)).getTime();
        currentRangeLabel = document.querySelector(`.filter-group button[data-range="${daysStr}"]`).innerText;
    } else {
        currentRangeLabel = "All Time";
    }

    filteredDetections = allDetections.filter(d => {
        if (!d.timestamp || typeof d.timestamp.toDate !== 'function') return true;
        return d.timestamp.toDate().getTime() >= cutoffTime;
    });

    updateDashboardUI();
}

// Bind date filter button clicks
document.querySelectorAll('.filter-group button').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.filter-group button').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        applyDateFilter(e.target.dataset.range);
    });
});

// 3. Update UI (stat cards, charts, top violators table)
function updateDashboardUI() {
    let helmetCount = 0;
    let vestCount = 0;
    let userStats = {};
    let dateTrends = {};

    filteredDetections.forEach(d => {
        // Combined violation counts toward both helmet and vest stat totals
        if (d.violation === "No Helmet" || d.violation === "No Helmet & No Vest") helmetCount++;
        if (d.violation === "No Vest"   || d.violation === "No Helmet & No Vest") vestCount++;

        // Backwards-compatible key: use id if present, fall back to name for legacy records
        let empKey = d.id || d.name;
        if (empKey && empKey !== "Unknown") {
            if (!userStats[empKey]) {
                userStats[empKey] = {
                    name: d.name || "Unknown",
                    idToDisplay: d.id ? d.id : "Legacy Data",
                    count: 0
                };
            }
            userStats[empKey].count++;
        }

        // Aggregate daily trend
        if (d.timestamp && typeof d.timestamp.toDate === 'function') {
            const dateStr = d.timestamp.toDate().toLocaleDateString();
            dateTrends[dateStr] = (dateTrends[dateStr] || 0) + 1;
        }
    });

    // 3.1 Update stat cards
    document.getElementById('stat-total').innerText = filteredDetections.length;
    document.getElementById('stat-helmet').innerText = helmetCount;
    document.getElementById('stat-vest').innerText = vestCount;

    // 3.2 Render Top 5 violators
    const sortedUsers = Object.entries(userStats)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 5);

    const topListHtml = sortedUsers.length === 0
        ? "<p>No violations found in this period.</p>"
        : sortedUsers.map((item, index) =>
            `<div style="display:flex; justify-content:space-between; padding: 10px 0; border-bottom: 1px solid #334155;">
                <span><b>#${index + 1}</b> ${item[1].name} <span style="font-size:0.8em; color:#64748b;">(${item[1].idToDisplay})</span></span>
                <span style="color:#ef4444; font-weight:bold;">${item[1].count} violations</span>
            </div>`
          ).join('');
    document.getElementById('top-violators-list').innerHTML = topListHtml;

    // 3.3 Render charts — doughnut uses full helmet/vest counts;
    //     trend chart reads its own type filter independently.
    renderTypeChart(helmetCount, vestCount);
    renderTrendChart();
}

// 4a. Doughnut chart — violation type breakdown (always shows all types)
// Reference: ISO 45001:2018 Clause 9.1 — PPE compliance analytics
function renderTypeChart(helmet, vest) {
    Chart.defaults.color = '#94a3b8';
    const ctxType = document.getElementById('typeChart').getContext('2d');
    if (typeChartInstance !== null) typeChartInstance.destroy();
    typeChartInstance = new Chart(ctxType, {
        type: 'doughnut',
        data: {
            labels: ['No Helmet', 'No Vest'],
            datasets: [{
                data: [helmet, vest],
                backgroundColor: ['#ef4444', '#f59e0b'],
                borderWidth: 0
            }]
        },
        options: { responsive: true, maintainAspectRatio: false }
    });
}

// 4b. Trend line chart — supports violation type filter + day/month grouping.
// "Auto Group": groups by month when data spans more than 2 months, else by day.
// Reference: ISO 45001:2018 Clause 9.1 — data-driven performance evaluation
function renderTrendChart() {
    const typeVal  = document.getElementById('trend-type-filter')?.value  || 'all';
    const groupVal = document.getElementById('trend-group-filter')?.value || 'auto';

    // Collect raw (date count) buckets first to measure span
    const rawBuckets = {};
    filteredDetections.forEach(d => {
        if (typeVal !== 'all' && d.violation !== typeVal) return;
        if (!d.timestamp || typeof d.timestamp.toDate !== 'function') return;
        const dt      = d.timestamp.toDate();
        const dayKey  = dt.toLocaleDateString();   // e.g. "1/6/2026"
        rawBuckets[dayKey] = (rawBuckets[dayKey] || 0) + 1;
    });

    // Decide grouping: auto month if span > 2 months, otherwise day
    const uniqueDays  = Object.keys(rawBuckets).length;
    const useMonthly  = groupVal === 'month'
                     || (groupVal === 'auto' && uniqueDays > 60);

    // Re-aggregate if monthly grouping is active
    const dateTrends = {};
    filteredDetections.forEach(d => {
        if (typeVal !== 'all' && d.violation !== typeVal) return;
        if (!d.timestamp || typeof d.timestamp.toDate !== 'function') return;
        const dt  = d.timestamp.toDate();
        let key;
        if (useMonthly) {
            // "Jan 2026", "Feb 2026", … — sorts correctly as YYYY-MM internally
            const sortKey = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
            key = dt.toLocaleString('default', { month: 'short', year: 'numeric' });
            // Store with sort-friendly key so we can sort before displaying
            if (!dateTrends[sortKey]) dateTrends[sortKey] = { label: key, count: 0 };
            dateTrends[sortKey].count++;
        } else {
            key = dt.toLocaleDateString();
            if (!dateTrends[key]) dateTrends[key] = { label: key, count: 0 };
            dateTrends[key].count++;
        }
    });

    const sorted      = Object.keys(dateTrends).sort();
    const labels      = sorted.map(k => dateTrends[k].label);
    const trendValues = sorted.map(k => dateTrends[k].count);

    const borderColor = typeVal === 'No Helmet' ? '#ef4444'
                      : typeVal === 'No Vest'   ? '#f59e0b'
                      : '#3b82f6';
    const bgColor     = typeVal === 'No Helmet' ? 'rgba(239,68,68,0.2)'
                      : typeVal === 'No Vest'   ? 'rgba(245,158,11,0.2)'
                      : 'rgba(59,130,246,0.2)';
    const unit        = useMonthly ? 'Month' : 'Day';
    const label       = typeVal === 'all' ? `All Violations per ${unit}` : `${typeVal} per ${unit}`;

    Chart.defaults.color = '#94a3b8';
    const ctxTrend = document.getElementById('trendChart').getContext('2d');
    if (trendChartInstance !== null) trendChartInstance.destroy();
    trendChartInstance = new Chart(ctxTrend, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label,
                data: trendValues,
                borderColor,
                backgroundColor: bgColor,
                tension: 0.3,
                fill: true
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } }
        }
    });
}

// Called by the HTML onchange on the trend type filter dropdown
// Only re-draws the trend chart — leaves the doughnut and stat cards untouched
function applyTrendTypeFilter() {
    renderTrendChart();
}
// Expose to HTML (non-module onclick)
window.applyTrendTypeFilter = applyTrendTypeFilter;

// 5. Export filtered data as PDF
// Reference: ISO 45001:2018 Clause 9.1 — documented performance evidence
document.getElementById('btn-export-pdf').addEventListener('click', () => {
    if (!window.jspdf) {
        alert("PDF library is not loaded."); return;
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const today = new Date().toLocaleDateString();

    doc.setFont("helvetica", "bold");
    doc.setFontSize(20);
    doc.text("Sentinel-Eye Analytics Report", 105, 20, { align: "center" });

    doc.setFontSize(12);
    doc.setTextColor(100);
    doc.text(`Report Period: ${currentRangeLabel} | Generated On: ${today}`, 105, 28, { align: "center" });
    doc.line(20, 32, 190, 32);

    let helmetCount = 0; let vestCount = 0; let userStats = {};
    filteredDetections.forEach(d => {
        if (d.violation === "No Helmet") helmetCount++;
        if (d.violation === "No Vest") vestCount++;
        if (d.id && d.id !== "Unknown") {
            if (!userStats[d.id]) userStats[d.id] = { name: d.name, count: 0 };
            userStats[d.id].count++;
        }
    });

    doc.setFont("helvetica", "normal");
    doc.setTextColor(0);
    doc.text("Executive Summary:", 20, 45);
    doc.text(`Total Recorded Violations: ${filteredDetections.length}`, 25, 55);
    doc.text(`- Missing Helmet Incidents: ${helmetCount}`, 30, 65);
    doc.text(`- Missing Vest Incidents: ${vestCount}`, 30, 75);

    doc.setFont("helvetica", "bold");
    doc.text(`Top Violators List (${currentRangeLabel}):`, 20, 95);

    const sortedUsers = Object.entries(userStats)
        .sort((a, b) => b[1].count - a[1].count)
        .map((item, index) => [index + 1, `${item[1].name} (${item[0]})`, item[1].count]);

    doc.autoTable({
        startY: 100,
        head: [['Rank', 'Employee Name (ID)', 'Total Violations']],
        body: sortedUsers,
        theme: 'striped'
    });

    doc.save(`Safety_Report_${currentRangeLabel.replace(/\s+/g, '_')}_${today.replace(/\//g, '-')}.pdf`);
});

// ==========================================
// Feature 10: Monthly Safety Reports Loader
// Reference: ISO 45001:2018 Clause 9.1 — performance monitoring and management review.
// Auto-generated monthly reports are stored in Firestore 'monthly_reports' collection
// by the Python backend. This section reads and displays them for HR review.
// ==========================================
function initMonthlyReports() {
    const container = document.getElementById('monthly-reports-container');
    if (!container) return;

    // Year filter — injected above the report cards
    let _yearFilter = null;  // null = show current year by default

    function getYearFilterEl() {
        return document.getElementById('monthly-reports-year-filter');
    }

    function renderReports(reports) {
        // Build list of unique years from the data
        const years = [...new Set(reports.map(r => r.report_month.split('-')[0]))].sort().reverse();

        // Default to the most recent year on first load
        if (_yearFilter === null && years.length > 0) {
            _yearFilter = years[0];
        }

        // Render year selector (always show so admin can see which year is loaded)
        const yearSelectorHtml = years.length > 0 ? `
            <div style="display:flex; align-items:center; gap:10px; margin-bottom:14px;">
                <label style="color:#94a3b8; font-size:0.85em;">Filter by Year:</label>
                <select id="monthly-reports-year-filter"
                        style="padding:6px 10px; background:#0f172a; color:#cbd5e1; border:1px solid #334155; border-radius:6px; font-size:0.84em; cursor:pointer;">
                    ${years.map(y => `<option value="${y}" ${y === _yearFilter ? 'selected' : ''}>${y}</option>`).join('')}
                </select>
            </div>` : '';

        // Filter cards to selected year
        const filtered = _yearFilter
            ? reports.filter(r => r.report_month.startsWith(_yearFilter))
            : reports;

        const cardsHtml = filtered.map(r => `
            <div style="background:#1e293b; border:1px solid #334155; border-radius:8px; padding:16px; margin-bottom:12px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                    <strong style="color:white; font-size:1.05em;">${r.report_month}</strong>
                    <span style="font-size:0.8em; color:#64748b;">Auto-generated by Sentinel-Eye</span>
                </div>
                <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap:10px; font-size:0.85em;">
                    <div style="background:#0f172a; padding:10px; border-radius:6px; text-align:center;">
                        <div style="color:#ef4444; font-size:1.4em; font-weight:bold;">${r.total_violations}</div>
                        <div style="color:#94a3b8;">Total Violations</div>
                    </div>
                    <div style="background:#0f172a; padding:10px; border-radius:6px; text-align:center;">
                        <div style="color:#f59e0b; font-size:1.4em; font-weight:bold;">${r.helmet_violations}</div>
                        <div style="color:#94a3b8;">No Helmet</div>
                    </div>
                    <div style="background:#0f172a; padding:10px; border-radius:6px; text-align:center;">
                        <div style="color:#f59e0b; font-size:1.4em; font-weight:bold;">${r.vest_violations}</div>
                        <div style="color:#94a3b8;">No Vest</div>
                    </div>
                    <div style="background:#0f172a; padding:10px; border-radius:6px; text-align:center;">
                        <div style="color:#ef4444; font-size:1.4em; font-weight:bold;">${r.suspended_count}</div>
                        <div style="color:#94a3b8;">Suspended</div>
                    </div>
                    <div style="background:#0f172a; padding:10px; border-radius:6px; text-align:center;">
                        <div style="color:#10b981; font-size:1.4em; font-weight:bold;">${r.safe_worker_count}</div>
                        <div style="color:#94a3b8;">Safe Workers</div>
                    </div>
                    <div style="background:#0f172a; padding:10px; border-radius:6px; text-align:center;">
                        <div style="color:#f87171; font-size:1.4em; font-weight:bold;">${r.repeat_offender_count}</div>
                        <div style="color:#94a3b8;">Repeat Offenders</div>
                    </div>
                </div>
                ${r.top_violator_name ? `
                <div style="margin-top:10px; font-size:0.85em; color:#cbd5e1;">
                    Top Violator: <strong style="color:#ef4444;">${r.top_violator_name}</strong>
                    (${r.top_violator_id}) — ${r.top_violator_count} violations this month
                </div>` : ''}
            </div>
        `).join('');

        container.innerHTML = yearSelectorHtml + (cardsHtml || '<p style="color:#94a3b8;">No reports for this year yet.</p>');

        // Bind year selector change
        const sel = getYearFilterEl();
        if (sel) {
            sel.addEventListener('change', () => {
                _yearFilter = sel.value;
                renderReports(reports);
            });
        }
    }

    onSnapshot(collection(db, "monthly_reports"), (snapshot) => {
        const reports = [];
        snapshot.forEach(doc => reports.push(doc.data()));

        // Sort newest first
        reports.sort((a, b) => (b.report_month > a.report_month ? 1 : -1));

        if (reports.length === 0) {
            container.innerHTML = '<p style="color:#94a3b8;">No monthly reports generated yet. Reports are auto-generated on the 1st of each month.</p>';
            return;
        }

        renderReports(reports);
    });
}

// ── Per-Employee Monthly Heatmap ─────────────────────────────────────────────
// NOTE: The heatmap and pattern engine have been moved to Safety Roster.
// Each employee now has a "Pattern" button on the roster row that opens a
// per-employee popup with monthly cells + pattern classification.
// This function is intentionally left empty to avoid a boot error.
function initEmployeeHeatmap() { /* moved to roster.js */ }

function _initHeatmapInner() {
    // Heatmap moved to Safety Roster (roster.js / roster.html).
    // Each employee row now has a "Pattern" button that opens a per-employee popup.
    return;

    // State shared between snapshot and filters
    let _empMap   = {};
    let _monthCols = [];

    // ── Filter event bindings ──────────────────────────────────────────────────
    const patternSel  = document.getElementById('heatmap-pattern-filter');
    const nameInput   = document.getElementById('heatmap-name-filter');

    patternSel?.addEventListener('change', () => renderHeatmap());
    nameInput?.addEventListener('input',   () => renderHeatmap());

    // ── Main render function ───────────────────────────────────────────────────
    function renderHeatmap() {
        const filterPattern = patternSel?.value || 'all';
        const filterName    = (nameInput?.value || '').trim().toLowerCase();

        if (Object.keys(_empMap).length === 0) {
            container.innerHTML = '<p style="color:#94a3b8; padding:20px;">No employee violation data available yet.</p>';
            return;
        }

        // ── Rule-based pattern engine ──────────────────────────────────────────
        // Only months up to TODAY are evaluated — future months are always 0 and
        // must not be counted as "clean recent months" (would wrongly inflate Improved).
        // Reference: ISO 45001:2018 Clause 9.1 — individual performance trends
        const nowMonth = new Date();
        const currentMonthIdx = nowMonth.getMonth(); // 0 = Jan … 11 = Dec

        function classifyEmployee(empKey, emp) {
            const counts       = _monthCols.map(m => emp.months[m] || 0);
            const totalViolations = counts.reduce((a, b) => a + b, 0);

            // Only look at Jan current month (no future zeroes)
            const evalCounts   = counts.slice(0, currentMonthIdx + 1);
            const evalLen      = evalCounts.length;   // e.g. 5 if current month is May

            const activeMonths = evalCounts.filter(c => c > 0).length;

            // Longest consecutive-violation run
            const consecutiveMax = (() => {
                let max = 0, cur = 0;
                evalCounts.forEach(c => { cur = c > 0 ? cur + 1 : 0; max = Math.max(max, cur); });
                return max;
            })();

            // Last 3 evaluated months all clean? (used for Improved check)
            // Using 3 months (not 2) prevents scattered violations like Jan+Mar
            // from falsely triggering Improved just because Apr+May happen to be clean.
            const lastThree     = evalLen >= 3 ? evalCounts.slice(-3) : evalCounts;
            const recentClean   = lastThree.every(c => c === 0);
            // Had violations in any month before the last 3
            const hasEarlyViolations = evalLen >= 4 && evalCounts.slice(0, -3).some(c => c > 0);
            // Enough history to judge a trend (at least 5 months evaluated)
            const hasEnoughHistory   = evalLen >= 5;

            // First/second half of evaluated period (for Regression detection)
            const halfIdx       = Math.ceil(evalLen / 2);
            const firstHalfSum  = evalCounts.slice(0, halfIdx).reduce((a, b) => a + b, 0);
            const secondHalfSum = evalCounts.slice(halfIdx).reduce((a, b) => a + b, 0);

            let patternKey = '', patternLabel = '', patternColor = '';

            if (consecutiveMax >= 3) {
                // 3+ consecutive months with violations mandatory review
                patternKey = 'Consistent Violator';
                patternLabel = 'Consistent Violator';
                patternColor = '#ef4444';

            } else if (activeMonths >= 4) {
                // Violations in 4+ separate months during the year.
                // Employee keeps re-offending without crossing the single-event
                // warning threshold — chronic low-level non-compliance.
                // Reference: ISO 45001:2018 Clause 7.2 — Competence & Training
                patternKey = 'Chronic Underperformer';
                patternLabel = 'Chronic Underperformer';
                patternColor = '#f97316';

            } else if (hasEnoughHistory && recentClean && hasEarlyViolations && activeMonths >= 2) {
                // Had violations in early months; last 3 months clean.
                // Requires ≥5 months of history and violations BEFORE the last 3 months,
                // so scattered patterns like Jan+Mar (Sporadic) don't wrongly qualify.
                patternKey = 'Improved';
                patternLabel = 'Improved';
                patternColor = '#10b981';

            } else if (activeMonths >= 2 && firstHalfSum === 0 && secondHalfSum > 0) {
                // Was clean for the first half of the evaluated period, now worsening
                patternKey = 'Regression';
                patternLabel = 'Regression';
                patternColor = '#f59e0b';

            } else if (activeMonths >= 2) {
                // Occasional violations but no clear direction
                patternKey = 'Sporadic';
                patternLabel = 'Sporadic';
                patternColor = '#f59e0b';

            } else if (activeMonths === 1) {
                // Only one month of violation history — too early to judge a trend
                patternKey = 'Monitoring';
                patternLabel = 'Monitoring';
                patternColor = '#94a3b8';

            } else {
                patternKey = 'Compliant';
                patternLabel = 'Compliant';
                patternColor = '#10b981';
            }

            return { empKey, emp, counts, patternKey, patternLabel, patternColor, totalViolations };
        }

        // Classify all employees first (for summary banner)
        const allEntries = Object.entries(_empMap).map(([k, v]) => classifyEmployee(k, v));

        // Training summary banner — patterns that require HR action
        const needTraining = allEntries.filter(e =>
            e.patternKey === 'Consistent Violator' ||
            e.patternKey === 'Chronic Underperformer' ||
            e.patternKey === 'Regression' ||
            e.patternKey === 'Sporadic');
        const summaryDiv  = document.getElementById('heatmap-training-summary');
        const summaryText = document.getElementById('heatmap-summary-text');
        if (summaryDiv && summaryText) {
            if (needTraining.length > 0) {
                summaryDiv.style.display = 'flex';
                summaryText.textContent  = `${needTraining.length} employee(s) flagged for mandatory safety training based on violation patterns.`;
            } else {
                summaryDiv.style.display = 'none';
            }
        }

        // Apply filters
        const filtered = allEntries.filter(e => {
            if (filterPattern !== 'all' && e.patternKey !== filterPattern) return false;
            if (filterName && !e.emp.name.toLowerCase().includes(filterName)
                           && !e.emp.id.toLowerCase().includes(filterName)) return false;
            return true;
        });

        if (filtered.length === 0) {
            container.innerHTML = '<p style="color:#94a3b8; padding:20px;">No employees match the current filter.</p>';
            return;
        }

        // Sort by total violations descending
        filtered.sort((a, b) => b.totalViolations - a.totalViolations);

        // Build header — show abbreviated month labels (3-char month + year)
        let html = `
        <div style="overflow-x:auto;">
        <table style="width:100%; border-collapse:collapse; font-size:0.82em;">
            <thead>
                <tr style="background:#0f172a;">
                    <th style="padding:10px 14px; text-align:left; color:#94a3b8; font-weight:600; white-space:nowrap; min-width:160px;">Employee</th>
                    ${_monthCols.map(m => {
                        const [yr, mo] = m.split('-');
                        const label = new Date(yr, mo - 1).toLocaleString('default', { month: 'short', year: '2-digit' });
                        return `<th style="padding:8px 5px; text-align:center; color:#94a3b8; font-weight:600; min-width:44px;">${label}</th>`;
                    }).join('')}
                    <th style="padding:10px 8px; text-align:center; color:#94a3b8; font-weight:600; white-space:nowrap;">Pattern</th>
                    <th style="padding:10px 8px; text-align:center; color:#94a3b8; font-weight:600; white-space:nowrap;">Action</th>
                </tr>
            </thead>
            <tbody>`;

        filtered.forEach(({ empKey, emp, counts, patternKey, patternLabel, patternColor }) => {
            // Determine join month for this employee (e.g. "2026-03")
            // If join month is within the current calendar year, cells before it
            // are shaded differently so HR knows the employee didn't exist yet.
            const joinMonth = _joinMonthMap[empKey.toUpperCase()] || null;
            const joinYear  = joinMonth ? parseInt(joinMonth.split('-')[0]) : null;
            const currentYear = new Date().getFullYear();
            // Only apply pre-join shading if employee joined THIS calendar year
            const applyJoinShading = joinMonth && joinYear === currentYear;

            const cells = _monthCols.map((col, idx) => {
                const c = counts[idx];

                // Cell is before the employee's join month this year
                if (applyJoinShading && col < joinMonth) {
                    return `<td style="padding:7px 4px; text-align:center; background:#0a0f1a; border:1px solid #1e293b; opacity:0.45;"
                               title="Before join date">
                        <span style="color:#64748b; font-size:0.85em;">✕</span>
                    </td>`;
                }

                // Cell is the join month itself — highlight with a subtle blue border
                if (applyJoinShading && col === joinMonth) {
                    const bg    = c === 0 ? '#0c1a2e' : c <= 1 ? '#052e16' : c <= 3 ? '#78350f' : '#450a0a';
                    const color = c === 0 ? '#3b82f6'  : c <= 1 ? '#10b981' : c <= 3 ? '#f59e0b' : '#ef4444';
                    return `<td style="padding:7px 4px; text-align:center; background:${bg}; border:2px solid #3b82f6; border-radius:3px; position:relative;"
                               title="Join month">
                        <span style="color:${color}; font-weight:bold;">${c === 0 ? '★' : c} </span>
                    </td>`;
                }

                // Normal cell
                const bg    = c === 0 ? '#0f172a' : c <= 1 ? '#052e16' : c <= 3 ? '#78350f' : '#450a0a';
                const color = c === 0 ? '#334155' : c <= 1 ? '#10b981' : c <= 3 ? '#f59e0b' : '#ef4444';
                return `<td style="padding:7px 4px; text-align:center; background:${bg}; border:1px solid #1e293b;">
                    <span style="color:${color}; font-weight:bold;">${c === 0 ? '—' : c}</span>
                </td>`;
            }).join('');

            // Only show training button for flagged patterns
            const needsTraining = patternKey === 'Consistent Violator'
                               || patternKey === 'Chronic Underperformer'
                               || patternKey === 'Sporadic'
                               || patternKey === 'Regression';
            const actionCell = needsTraining
                ? `<td style="padding:8px 10px; text-align:center;">
                    <button onclick="window.sendHeatmapTrainingEmail('${empKey}', '${emp.name.replace(/'/g, "\\'")}', '${patternLabel.replace(/'/g, "\\'")}', this)"
                        style="padding:5px 10px; background:#1d4ed8; color:white; border:none; border-radius:5px; font-size:0.78em; cursor:pointer; white-space:nowrap;">
                        Send Training Email
                    </button>
                  </td>`
                : `<td style="padding:8px 10px; text-align:center; color:#334155; font-size:0.78em;">—</td>`;

            html += `
            <tr style="border-bottom:1px solid #1e293b;">
                <td style="padding:10px 14px; white-space:nowrap;">
                    <div style="font-weight:600; color:#e2e8f0;">${emp.name}</div>
                    <div style="font-size:0.75em; color:#64748b;">${emp.id}</div>
                </td>
                ${cells}
                <td style="padding:8px 10px; white-space:nowrap; color:${patternColor}; font-size:0.8em; font-weight:600;">${patternLabel}</td>
                ${actionCell}
            </tr>`;
        });

        html += `</tbody></table></div>
        <div style="margin-top:12px; display:flex; gap:20px; flex-wrap:wrap; align-items:center; font-size:0.75em; color:#64748b;">
            <span><span style="color:#10b981;">★</span> 0–1 violations</span>
            <span><span style="color:#f59e0b;">★</span> 2–3 violations</span>
            <span><span style="color:#ef4444;">★</span> 4+ violations</span>
            <span style="border:2px solid #3b82f6; padding:0 4px; border-radius:3px; color:#3b82f6;">★</span> Join month
            <span style="color:#64748b; font-size:0.95em;">✕</span> Before employment
            <div style="margin-left:auto; color:#475569;">Rule-based pattern engine · ISO 45001:2018 Clause 9.1</div>
        </div>`;

        container.innerHTML = html;
    }

    // ── Join-date map: empId "YYYY-MM" of when employee joined ─────────────
    // Used to shade cells that fall before an employee's start month so HR can
    // distinguish "no violation yet" from "employee didn't exist yet".
    // Reads join_date / joinDate / created_at / createdAt from users collection.
    let _joinMonthMap = {};   // { "EMP001": "2026-03", ... }

    // _allUsers: seed map of ALL employees so compliant (zero-violation) staff still appear
    let _allUsers = {};   // { "EMP001": { name, id }, ... }

    async function loadJoinDatesAndUsers() {
        try {
            const snap = await getDocs(collection(db, 'users'));
            snap.forEach(d => {
                const data  = d.data();
                const empId = (data.id || d.id || '').toUpperCase();
                if (!empId) return;

                // Seed all-users map (used to show compliant employees in table)
                if (data.role !== 'Admin' && data.role !== 'admin') {
                    _allUsers[empId] = { name: data.name || empId, id: empId };
                }

                // Parse join date — support multiple field names
                const raw = data.join_date || data.joinDate || data.created_at || data.createdAt || null;
                if (!raw) return;

                let joinDate = null;
                if (typeof raw.toDate === 'function') {
                    joinDate = raw.toDate();
                } else if (typeof raw === 'string') {
                    joinDate = new Date(raw);
                }
                if (!joinDate || isNaN(joinDate)) return;

                const yr = joinDate.getFullYear();
                const mo = String(joinDate.getMonth() + 1).padStart(2, '0');
                _joinMonthMap[empId] = `${yr}-${mo}`;
            });
        } catch (e) {
            console.warn('[Heatmap] Could not load users/join dates:', e);
        }
    }

    // Load users+join dates once, then start the live detections listener
    loadJoinDatesAndUsers().then(() => {

    // ── Firestore listener ─────────────────────────────────────────────────────
    onSnapshot(collection(db, "detections"), (snapshot) => {
        // Start from all known employees (so compliant staff with 0 violations appear)
        _empMap = {};
        Object.entries(_allUsers).forEach(([id, u]) => {
            _empMap[id] = { name: u.name, id, months: {} };
        });

        snapshot.forEach(d => {
            const data = d.data();
            if (data.disputed === true) return;
            if (!data.timestamp || typeof data.timestamp.toDate !== 'function') return;

            const dt       = data.timestamp.toDate();
            const monthKey = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
            const empKey   = data.id || data.name || 'Unknown';
            if (empKey === 'Unknown') return;

            if (!_empMap[empKey]) _empMap[empKey] = { name: data.name || empKey, id: data.id || '', months: {} };
            _empMap[empKey].months[monthKey] = (_empMap[empKey].months[monthKey] || 0) + 1;
        });

        // Build January–December columns for the current calendar year
        const now = new Date();
        const year = now.getFullYear();
        _monthCols = [];
        for (let mo = 1; mo <= 12; mo++) {
            _monthCols.push(`${year}-${String(mo).padStart(2, '0')}`);
        }

        renderHeatmap();
    });

    }); // end loadJoinDatesAndUsers().then

    // ── "Send Training Email" handler — fetches employee email from Firestore ──
    // Reference: ISO 45001:2018 Clause 7.2 — Competence & Training
    window.sendHeatmapTrainingEmail = async function(empId, empName, patternLabel, btnEl) {
        if (btnEl.disabled) return;
        btnEl.disabled = true;
        btnEl.textContent = 'Sending…';

        try {
            // Fetch employee email from Firestore users collection
            const userSnap = await getDoc(fsDoc(db, 'users', empId));
            if (!userSnap.exists()) throw new Error(`No user document found for ${empId}`);
            const userData     = userSnap.data();
            const employeeEmail = userData.email || userData.Email || '';
            if (!employeeEmail) throw new Error(`No email field found for ${empId}`);

            // Count total violations in last 12 months
            const empEntry = _empMap[empId];
            const totalViolations = empEntry
                ? Object.values(empEntry.months).reduce((a, b) => a + b, 0)
                : 0;

            const adminUser = auth.currentUser;
            const adminName = adminUser?.displayName || adminUser?.email || 'Safety Officer';

            const res = await fetch('http://localhost:5050/api/send_training_email', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email:           employeeEmail,
                    name:            empName,
                    pattern:         patternLabel,
                    violation_count: totalViolations,
                    admin_name:      adminName,
                }),
            });
            const json = await res.json();
            if (json.status === 'success') {
                btnEl.textContent = 'Sent!';
                btnEl.style.background = '#065f46';
            } else {
                throw new Error(json.message || 'Unknown error');
            }
        } catch (err) {
            console.error('[Training Email]', err);
            btnEl.textContent  = 'Failed';
            btnEl.style.background = '#7f1d1d';
            btnEl.disabled = false;
            alert(`Failed to send training email: ${err.message}`);
        }
    };
}

// ── Boot ──────────────────────────────────────────────────────────────────────
onAuthStateChanged(auth, (user) => {
    if (user) {
        initReportData();
        initMonthlyReports();
        // initEmployeeHeatmap() — removed; pattern view moved to Safety Roster page
    } else {
        window.location.href = 'login.html';
    }
});
