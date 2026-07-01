import { db } from './firebase-config.js';
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js";
import { collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";

// ── Auth gate ─────────────────────────────────────────────────────────────────
// Firebase Auth restores a saved session asynchronously on page load.
// Starting Firestore listeners before auth is ready causes PERMISSION_DENIED.
// onAuthStateChanged waits until the session is confirmed before proceeding.
const auth = getAuth();

const rosterContainer = document.getElementById('roster-container');
const searchInput     = document.getElementById('search-input');
const statusFilter    = document.getElementById('status-filter');
const patternFilter   = document.getElementById('pattern-filter');
// Modal filters are read on-demand via getModalFilters() — not cached at startup
// because the modal elements may not exist in the DOM when this script first runs.

let allEmployeesData = [];
let currentViewingEmployee = null;
let sortKey = 'name';
let sortAsc = true;
let modalTrendChartInstance = null; // Chart.js instance — destroyed/recreated on each open

// Raw data stores — populated independently by each onSnapshot listener
let rawUsersMap = {};
let rawDetections = [];

// ── Loading gate ──────────────────────────────────────────────────────────────
// Both collections must return at least one snapshot before we render anything.
// This prevents the roster from flashing "No employees found" while the second
// collection is still loading, or staying on "Syncing..." if one is slow.
let usersLoaded = false;
let detectionsLoaded = false;

// ── Debounce timer ────────────────────────────────────────────────────────────
// The AI engine writes new detections frequently. Without debouncing, every
// new detection would wipe and rebuild the entire roster DOM, causing flicker.
// 300 ms quiet period coalesces rapid updates into a single render.
let renderTimer = null;
function scheduleRender() {
    if (!usersLoaded || !detectionsLoaded) return;
    clearTimeout(renderTimer);
    renderTimer = setTimeout(processAndRender, 300);
}

function initializeRoster() {
    // 1. Listen to Users collection
    onSnapshot(collection(db, "users"), (userSnapshot) => {
        rawUsersMap = {};
        userSnapshot.forEach(doc => {
            const userData = doc.data();
            const empId = userData.id || doc.id;
            if (empId) {
                rawUsersMap[empId] = {
                    id: empId,
                    name: userData.name || "Unknown Name",
                    email: userData.email,
                    role: userData.role || "Employee",
                    score: userData.current_score !== undefined ? userData.current_score : 100,
                    status: userData.status || "Active",
                    gold_badge: userData.gold_badge || false,
                    safe_worker_status: userData.safe_worker_status || "Standard",
                    reward_points: userData.reward_points || 0,
                    is_repeat_offender: userData.is_repeat_offender || false,
                    join_date: userData.join_date || null,
                    violationsCount: 0,
                    photos: []
                };
            }
        });
        usersLoaded = true;
        scheduleRender();
    }, (error) => {
        console.error("[Roster] Failed to load users:", error);
        rosterContainer.innerHTML = '<p style="color:#ef4444; text-align:center;">Failed to load employee data. Check your Firebase connection or security rules.</p>';
    });

    // 2. Listen to Detections collection
    onSnapshot(collection(db, "detections"), (detectionSnapshot) => {
        rawDetections = [];
        detectionSnapshot.forEach(doc => {
            rawDetections.push(doc.data());
        });
        detectionsLoaded = true;
        scheduleRender();
    }, (error) => {
        console.error("[Roster] Failed to load detections:", error);
        detectionsLoaded = true; // non-fatal — still render user cards
        scheduleRender();
    });
}

// ── Core logic: assemble users + photos, then render ─────────────────────────
function processAndRender() {
    const currentYear = new Date().getFullYear();
    const usersArray  = Object.values(rawUsersMap).map(u => ({
        ...u,
        violationsCount: 0,
        photos: [],
        monthlyCounts: new Array(12).fill(0),   // Jan–Dec violation counts for current year
    }));

    rawDetections.forEach(dData => {
        // Skip disputed (reverted) detections — ISO 45001:2018 Clause 10.2 Corrective Action
        if (dData.disputed === true) return;

        let empId = dData.id;

        // Backwards compatibility: match by name if old records lack an id
        if (!empId && dData.name) {
            const legacyUser = usersArray.find(u => u.name === dData.name);
            if (legacyUser) empId = legacyUser.id;
        }

        if (!empId || empId === "Unknown") return;

        const targetUser = usersArray.find(u => u.id === empId);
        if (!targetUser) return;

        targetUser.violationsCount += 1;

        if (dData.timestamp && typeof dData.timestamp.toDate === 'function') {
            const dt = dData.timestamp.toDate();
            // Accumulate monthly counts for current year (used by pattern engine + popup)
            if (dt.getFullYear() === currentYear) {
                targetUser.monthlyCounts[dt.getMonth()]++;
            }

            if (dData.image_url) {
                targetUser.photos.push({
                    url:         dData.image_url,
                    time:        dt.toLocaleString(),
                    timestampMs: dt.getTime(),
                    type:        dData.violation || "Violation"
                });
            }
        } else if (dData.image_url) {
            targetUser.photos.push({
                url:         dData.image_url,
                time:        "Unknown Time",
                timestampMs: 0,
                type:        dData.violation || "Violation"
            });
        }
    });

    // ── Pre-compute join month index + pattern for every employee ─────────────
    // joinMonthIdx: 0–11 if joined THIS calendar year; -1 if joined earlier.
    // Stored on the employee object so the pattern filter and modal can use it
    // without repeating the join_date parse.
    usersArray.forEach(emp => {
        let joinMonthIdx = -1;
        if (emp.join_date) {
            const raw      = emp.join_date;
            const joinDate = typeof raw.toDate === 'function' ? raw.toDate() : new Date(raw);
            if (joinDate && !isNaN(joinDate) && joinDate.getFullYear() === currentYear) {
                joinMonthIdx = joinDate.getMonth();
            }
        }
        emp.joinMonthIdx = joinMonthIdx;
        // Classify only from the join month (or month 0 if joined before this year)
        const startIdx   = joinMonthIdx >= 0 ? joinMonthIdx : 0;
        emp.pattern      = classifyEmployeePattern(emp.monthlyCounts, startIdx);
    });

    allEmployeesData = usersArray;

    // Refresh modal photos if it's currently open
    if (currentViewingEmployee) {
        currentViewingEmployee = allEmployeesData.find(e => e.id === currentViewingEmployee.id);
        renderModalPhotos();
    }

    applyFiltersAndRender();
}

function applyFiltersAndRender() {
    const searchTerm  = searchInput.value.toLowerCase();
    const statusVal   = statusFilter.value;
    const patternVal  = patternFilter?.value || 'all';

    let filteredData = allEmployeesData.filter(emp => {
        const matchName = emp.name.toLowerCase().includes(searchTerm);
        const matchId   = emp.id && String(emp.id).toLowerCase().includes(searchTerm);

        let matchStatus = true;
        if (statusVal === 'good')         matchStatus = emp.score >= 70;
        else if (statusVal === 'warning') matchStatus = emp.score >= 40 && emp.score < 70;
        else if (statusVal === 'danger')  matchStatus = emp.score < 40;

        // Pattern filter — uses the pre-computed emp.pattern from processAndRender
        const matchPattern = patternVal === 'all' || (emp.pattern && emp.pattern.key === patternVal);

        return (matchName || matchId) && matchStatus && matchPattern;
    });

    // Apply current sort
    filteredData.sort((a, b) => {
        let aVal = sortKey === 'violations' ? a.violationsCount
                 : sortKey === 'index'      ? a.name   // fallback to name for #
                 : a[sortKey];
        let bVal = sortKey === 'violations' ? b.violationsCount
                 : sortKey === 'index'      ? b.name
                 : b[sortKey];
        if (typeof aVal === 'string') aVal = aVal.toLowerCase();
        if (typeof bVal === 'string') bVal = bVal.toLowerCase();
        if (aVal < bVal) return sortAsc ? -1 : 1;
        if (aVal > bVal) return sortAsc ?  1 : -1;
        return 0;
    });

    renderRoster(filteredData);
}

// Column sort toggle — called from onclick on <th> elements
window.sortRoster = function(key) {
    if (sortKey === key) sortAsc = !sortAsc;
    else { sortKey = key; sortAsc = true; }
    applyFiltersAndRender();
};

searchInput.addEventListener('input', applyFiltersAndRender);
statusFilter.addEventListener('change', applyFiltersAndRender);
patternFilter?.addEventListener('change', applyFiltersAndRender);

function renderRoster(dataToRender) {
    rosterContainer.innerHTML = '';

    if (dataToRender.length === 0) {
        const msg = Object.keys(rawUsersMap).length === 0
            ? 'No employees registered yet.'
            : 'No employees match the current filter.';
        rosterContainer.innerHTML =
            `<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:30px;">${msg}</td></tr>`;
        return;
    }

    dataToRender.forEach((emp, idx) => {
        // ── Status class + chip ────────────────────────────────────────────────
        let rowClass   = 'status-green';
        let chipClass  = 'good';
        let statusText = 'Good';

        if (emp.score <= 0 || emp.status === 'Suspended') {
            rowClass = 'status-red'; chipClass = 'suspended';
            statusText = 'Suspended';
        } else if (emp.score < 40) {
            rowClass = 'status-red';    chipClass = 'danger';  statusText = 'Danger';
        } else if (emp.score < 70) {
            rowClass = 'status-yellow'; chipClass = 'warning'; statusText = 'Warning';
        }

        // ── Score pill colour ──────────────────────────────────────────────────
        const pillClass = rowClass === 'status-green' ? 'green'
                        : rowClass === 'status-yellow' ? 'yellow' : 'red';

        // ── Badge / flag chips ─────────────────────────────────────────────────
        // Feature 2: Gold Badge + Safe Worker — ISO 45001:2018 Clause 10.3
        // Feature 4: Repeat Offender — ISO 45001:2018 Clause 6.1
        let badgeHtml = '';
        if (emp.gold_badge)
            badgeHtml += `<span class="badge-chip-sm gold">Gold Badge</span>`;
        if (emp.safe_worker_status === 'Safe Worker')
            badgeHtml += `<span class="badge-chip-sm safe">Safe Worker</span>`;
        if (emp.is_repeat_offender)
            badgeHtml += `<span class="badge-chip-sm repeat">Repeat Offender</span>`;
        if (!badgeHtml) badgeHtml = `<span style="color:#475569; font-size:0.8em;">—</span>`;

        // ── Warning letter button (only for danger / suspended) ───────────────
        const warnBtn = (rowClass === 'status-red')
            ? `<button class="tbl-btn warning" onclick="generateWarningLetter('${emp.id}')">Warning Letter</button>`
            : '';

        // ── Row ───────────────────────────────────────────────────────────────
        const row = document.createElement('tr');
        row.className = rowClass;
        row.innerHTML = `
            <td style="color:#475569; font-size:0.8em;">${idx + 1}</td>
            <td>
                <div style="font-weight:600; color:#e2e8f0;">${emp.name}</div>
                <div style="font-size:0.75em; color:#64748b;">${emp.id} · ${emp.role}</div>
            </td>
            <td><span class="score-pill ${pillClass}">${emp.score} pts</span></td>
            <td style="text-align:center; font-weight:bold;
                       color:${emp.violationsCount > 0 ? '#ef4444' : '#10b981'};">
                ${emp.violationsCount}
            </td>
            <td><span class="status-chip ${chipClass}">${statusText}</span></td>
            <td>${badgeHtml}</td>
            <td style="color:#a78bfa; font-weight:600;">
                ${emp.reward_points > 0 ? `${emp.reward_points}` : '<span style="color:#475569">—</span>'}
            </td>
            <td>
                <button class="tbl-btn archive" onclick="openModal('${emp.id}')">Archive</button>
                <button class="tbl-btn" onclick="openPatternModal('${emp.id}')" style="background:#1e3a5f; border:1px solid #3b82f6; color:#93c5fd;">Pattern</button>
                ${warnBtn}
            </td>`;
        rosterContainer.appendChild(row);
    });
}

// ── Modal ─────────────────────────────────────────────────────────────────────
window.openModal = function(employeeId) {
    currentViewingEmployee = allEmployeesData.find(e => e.id === String(employeeId));
    if (!currentViewingEmployee) return;

    // Reset unified filters to defaults on each open
    document.getElementById('modal-type-filter').value  = 'all';
    document.getElementById('modal-date-range').value   = '90';
    document.getElementById('modal-sort-order').value   = 'newest';

    document.getElementById('modal-title').innerText =
        `[${currentViewingEmployee.name} - ${currentViewingEmployee.id}]'s Archive`;
    document.getElementById('photo-modal').style.display = 'flex';
    applyModalFilters();
};

// ── Single entry point — called by every filter dropdown in the modal header ──
// Reads all three unified filters and re-renders both the chart and photo grid.
window.applyModalFilters = function() {
    renderModalTrendChart();
    renderModalPhotos();
};

window.closeModal = function() {
    document.getElementById('photo-modal').style.display = 'none';
    currentViewingEmployee = null;
    if (modalTrendChartInstance) {
        modalTrendChartInstance.destroy();
        modalTrendChartInstance = null;
    }
};

// ── Helper: read unified filter values from the modal header ─────────────────
function getModalFilters() {
    return {
        typeVal:  document.getElementById('modal-type-filter')?.value  || 'all',
        dateVal:  document.getElementById('modal-date-range')?.value   || 'all',
        sortVal:  document.getElementById('modal-sort-order')?.value   || 'newest',
    };
}

// ── Personal Violation Trend Chart ───────────────────────────────────────────
// Reads unified header filters (type + date range) — no separate chart dropdowns.
// Reference: ISO 45001:2018 Clause 9.1 — individual performance trend monitoring.
function renderModalTrendChart() {
    if (!currentViewingEmployee) return;

    const { typeVal, dateVal } = getModalFilters();
    const cutoff = dateVal === 'all'
        ? 0
        : Date.now() - (parseInt(dateVal) * 24 * 60 * 60 * 1000);

    const dateCounts = {};
    currentViewingEmployee.photos.forEach(photo => {
        if (!photo.timestampMs || photo.timestampMs <= 0) return;
        if (photo.timestampMs < cutoff) return;
        if (typeVal !== 'all' && photo.type !== typeVal) return;
        const dateStr = new Date(photo.timestampMs).toLocaleDateString();
        dateCounts[dateStr] = (dateCounts[dateStr] || 0) + 1;
    });

    const sortedDates = Object.keys(dateCounts).sort((a, b) => new Date(a) - new Date(b));

    if (modalTrendChartInstance) {
        modalTrendChartInstance.destroy();
        modalTrendChartInstance = null;
    }

    const canvas = document.getElementById('modalTrendChart');
    const noData = document.getElementById('modal-trend-nodata');

    if (sortedDates.length === 0) {
        canvas.style.display = 'none';
        noData.style.display = 'block';
        document.getElementById('modal-trend-section').style.display = 'block';
        return;
    }

    canvas.style.display = 'block';
    noData.style.display = 'none';
    document.getElementById('modal-trend-section').style.display = 'block';

    const borderColor = typeVal === 'No Helmet' ? '#ef4444'
                      : typeVal === 'No Vest'   ? '#f59e0b'
                      : '#3b82f6';
    const bgColor     = typeVal === 'No Helmet' ? 'rgba(239,68,68,0.15)'
                      : typeVal === 'No Vest'   ? 'rgba(245,158,11,0.15)'
                      : 'rgba(59,130,246,0.15)';

    modalTrendChartInstance = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            labels: sortedDates,
            datasets: [{
                label: typeVal === 'all' ? 'All Violations' : typeVal,
                data: sortedDates.map(d => dateCounts[d]),
                borderColor,
                backgroundColor: bgColor,
                tension: 0.3,
                fill: true,
                pointBackgroundColor: borderColor,
                pointRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { ticks: { color: '#94a3b8', maxTicksLimit: 8 }, grid: { color: '#1e293b' } },
                y: { beginAtZero: true, ticks: { stepSize: 1, color: '#94a3b8' }, grid: { color: '#334155' } }
            }
        }
    });
}

// ── Photo Grid ────────────────────────────────────────────────────────────────
// Reads all three unified filters: type, date range, sort order.
function renderModalPhotos() {
    if (!currentViewingEmployee) return;

    const { typeVal, dateVal, sortVal } = getModalFilters();
    const cutoff = dateVal === 'all'
        ? 0
        : Date.now() - (parseInt(dateVal) * 24 * 60 * 60 * 1000);

    let photosToShow = currentViewingEmployee.photos.filter(p => {
        if (typeVal !== 'all' && p.type !== typeVal) return false;
        if (p.timestampMs > 0 && p.timestampMs < cutoff) return false;
        return true;
    });

    photosToShow.sort((a, b) =>
        sortVal === 'newest' ? b.timestampMs - a.timestampMs : a.timestampMs - b.timestampMs
    );

    const photoGrid = document.getElementById('modal-photo-grid');
    if (photosToShow.length === 0) {
        photoGrid.innerHTML = `<p style="color:#94a3b8; grid-column:1/-1; text-align:center; padding:20px;">
            No photos match the current filter.</p>`;
        return;
    }

    photoGrid.innerHTML = '';
    photosToShow.forEach(photo => {
        photoGrid.innerHTML += `
            <div style="background:#0f172a; padding:10px; border-radius:8px; border:1px solid #334155;">
                <img src="${photo.url}" style="width:100%; height:150px; object-fit:cover; border-radius:5px; margin-bottom:10px;">
                <div style="font-size:0.85em; color:#ef4444; font-weight:bold;">${photo.type}</div>
                <div style="font-size:0.8em; color:#94a3b8;">${photo.time}</div>
            </div>`;
    });
}

// ── Warning Letter ────────────────────────────────────────────────────────────
window.generateWarningLetter = function(employeeId) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const emp = allEmployeesData.find(e => e.id === String(employeeId));

    if (!emp) { alert("Employee data not found."); return; }
    if (!emp.email) { alert(`Email for ID:${emp.id} is missing!`); return; }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(22);
    doc.setTextColor(239, 68, 68);
    doc.text("OFFICIAL WARNING LETTER", 105, 20, { align: "center" });

    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text("Generated by Sentinel-Eye Automated System", 105, 28, { align: "center" });
    doc.setLineWidth(0.5);
    doc.line(20, 32, 190, 32);

    doc.setFontSize(12);
    doc.setTextColor(0);
    const today = new Date().toLocaleDateString();
    doc.text(`Date: ${today}`, 20, 45);
    doc.text(`To: ${emp.name} (ID: ${emp.id})`, 20, 55);
    doc.text(`Email: ${emp.email}`, 20, 65);
    doc.text(`Subject: Critical Safety Violation Notice`, 20, 75);

    doc.setFont("helvetica", "normal");
    const bodyText =
        `Dear ${emp.name},\n\n` +
        `This letter serves as an official warning regarding multiple severe safety violations ` +
        `recorded by the Sentinel-Eye AI Monitoring System. Your current safety score has dropped ` +
        `to a critical level of ${emp.score} points.\n\n` +
        `Failure to comply with site safety regulations (e.g., wearing hard hats and reflective vests) ` +
        `compromises not only your own safety but also the safety of your colleagues.`;

    const splitBody = doc.splitTextToSize(bodyText, 170);
    doc.text(splitBody, 20, 85);

    let nextY = 85 + (splitBody.length * 6) + 15;
    doc.setFont("helvetica", "bold");
    doc.text("Recorded Violation Evidence:", 20, nextY);

    doc.autoTable({
        startY: nextY + 5,
        head: [['#', 'Timestamp', 'Violation Type']],
        body: emp.photos.map((photo, i) => [i + 1, photo.time, photo.type]),
        theme: 'grid',
        headStyles: { fillColor: [239, 68, 68] },
        alternateRowStyles: { fillColor: [245, 245, 245] }
    });

    const finalY = doc.lastAutoTable.finalY + 20;
    doc.text("Please report to the site manager immediately.", 20, finalY);
    doc.line(20, finalY + 20, 80, finalY + 20);
    doc.text("Authorized Signature", 20, finalY + 25);

    const pdfDataUri = doc.output('datauristring');
    alert(`Generating PDF and sending email to ${emp.email}...`);

    fetch('http://127.0.0.1:5050/api/send_warning_email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emp.email, pdf_data: pdfDataUri })
    })
    .then(r => r.json())
    .then(data => {
        if (data.status === "success") {
            alert(`Warning letter sent to ${emp.email}!`);
        } else {
            alert("Failed to send email. Check backend logs.");
        }
    })
    .catch(() => alert("Cannot connect to the local Python server."));
};

// ── Pattern Engine ────────────────────────────────────────────────────────────
// Rule-based classifier mirroring report.js classifyEmployee().
// Input:  counts[0..11]  — violation count per calendar month (Jan=0, Dec=11)
//         startMonthIdx  — first month to evaluate (employee's join month this year,
//                          or 0 if they joined in a prior year). Defaults to 0.
// Output: { key, color }
// Reference: ISO 45001:2018 Clause 9.1 — performance trend monitoring
function classifyEmployeePattern(counts, startMonthIdx) {
    const nowMonth   = new Date().getMonth();          // 0 = Jan
    const start      = (typeof startMonthIdx === 'number' && startMonthIdx > 0) ? startMonthIdx : 0;
    const evalCounts = counts.slice(start, nowMonth + 1);  // only completed months from join
    const evalLen    = evalCounts.length;

    const activeMonths = evalCounts.filter(c => c > 0).length;

    const consecutiveMax = (() => {
        let max = 0, cur = 0;
        evalCounts.forEach(c => { cur = c > 0 ? cur + 1 : 0; max = Math.max(max, cur); });
        return max;
    })();

    const lastThree          = evalLen >= 3 ? evalCounts.slice(-3) : evalCounts;
    const recentClean        = lastThree.every(c => c === 0);
    const hasEarlyViolations = evalLen >= 4 && evalCounts.slice(0, -3).some(c => c > 0);
    const hasEnoughHistory   = evalLen >= 5;
    const halfIdx            = Math.ceil(evalLen / 2);
    const firstHalfSum       = evalCounts.slice(0, halfIdx).reduce((a, b) => a + b, 0);
    const secondHalfSum      = evalCounts.slice(halfIdx).reduce((a, b) => a + b, 0);

    if (consecutiveMax >= 3)
        return { key: 'Consistent Violator',    color: '#ef4444' };
    if (activeMonths >= 4)
        return { key: 'Chronic Underperformer', color: '#f97316' };
    if (hasEnoughHistory && recentClean && hasEarlyViolations && activeMonths >= 2)
        return { key: 'Improved',               color: '#10b981' };
    if (activeMonths >= 2 && firstHalfSum === 0 && secondHalfSum > 0)
        return { key: 'Regression',             color: '#f59e0b' };
    if (activeMonths >= 2)
        return { key: 'Sporadic',               color: '#f59e0b' };
    if (activeMonths === 1)
        return { key: 'Monitoring',             color: '#94a3b8' };
    return   { key: 'Compliant',               color: '#10b981' };
}

// ── Pattern Popup ─────────────────────────────────────────────────────────────
// Opens a modal for a single employee showing their monthly heatmap + pattern.
// Uses pre-computed monthlyCounts and joinMonthIdx from processAndRender so
// we don't re-scan rawDetections on every click.
window.openPatternModal = function(empId) {
    const emp = allEmployeesData.find(e => e.id === String(empId));
    if (!emp) return;

    const MONTHS      = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const currentYear = new Date().getFullYear();

    // Use the pre-computed monthly counts (populated in processAndRender)
    const counts        = emp.monthlyCounts || new Array(12).fill(0);
    const joinMonthIdx  = typeof emp.joinMonthIdx === 'number' ? emp.joinMonthIdx : -1;
    const pattern       = emp.pattern || classifyEmployeePattern(counts, Math.max(0, joinMonthIdx));
    const needsTraining = ['Consistent Violator','Chronic Underperformer','Regression','Sporadic']
                            .includes(pattern.key);
    const totalViolations = counts.reduce((a, b) => a + b, 0);

    // Header
    document.getElementById('pattern-modal-title').textContent =
        `${emp.name}  (${emp.id})`;
    document.getElementById('pattern-modal-sub').textContent =
        `${currentYear} Monthly Violation Pattern`;

    // Pattern badge
    document.getElementById('pattern-badge').innerHTML = `
        <span style="display:inline-block; background:${pattern.color}22; color:${pattern.color};
                     border:1px solid ${pattern.color}; border-radius:20px;
                     padding:5px 16px; font-size:0.88em; font-weight:600;">
            ${pattern.key}
        </span>`;

    // Monthly heatmap grid
    const nowMonth  = new Date().getMonth();
    const cellsHtml = MONTHS.map((m, i) => {
        const count      = counts[i];
        const isPreJoin  = joinMonthIdx >= 0 && i < joinMonthIdx;
        const isJoinMth  = joinMonthIdx >= 0 && i === joinMonthIdx;
        const isFuture   = i > nowMonth;

        let bg, textColor, display, border;

        if (isPreJoin) {
            // Before the employee's join date — not a "clean month", just non-existent
            bg        = '#0a0f1a';
            textColor = '#334155';
            display   = '✕';
            border    = '1px solid #1e293b';
        } else if (isFuture) {
            bg        = '#0f172a';
            textColor = '#475569';
            display   = '—';
            border    = '1px solid #334155';
        } else {
            bg        = count === 0 ? '#1e293b'
                      : count >= 5  ? '#7f1d1d'
                      : count >= 3  ? '#b91c1c' : '#c2410c';
            textColor = count === 0 ? '#475569' : '#fff';
            display   = String(count);
            border    = isJoinMth ? '2px solid #3b82f6' : '1px solid #334155';
        }

        return `
            <div style="text-align:center;">
                <div style="font-size:0.68em; color:#64748b; margin-bottom:4px;">${m}</div>
                <div style="background:${bg}; color:${textColor}; width:42px; height:36px;
                            border-radius:6px; display:flex; align-items:center;
                            justify-content:center; font-size:0.85em; font-weight:600;
                            border:${border};">${display}</div>
            </div>`;
    }).join('');

    document.getElementById('pattern-grid').innerHTML =
        `<div style="display:flex; gap:6px; flex-wrap:wrap; justify-content:center;">${cellsHtml}</div>`;

    // Training email button (only for flagged patterns)
    const trainDiv = document.getElementById('pattern-train-btn');
    if (needsTraining) {
        const safeName = emp.name.replace(/'/g, "\\'");
        const safeKey  = pattern.key.replace(/'/g, "\\'");
        trainDiv.innerHTML = `
            <button class="tbl-btn warning"
                    onclick="sendRosterTrainingEmail('${empId}','${safeName}','${safeKey}',${totalViolations},this)"
                    style="margin-top:4px;">
                Send Training Email
            </button>`;
    } else {
        trainDiv.innerHTML = '';
    }

    document.getElementById('pattern-modal').style.display = 'flex';
};

window.closePatternModal = function() {
    document.getElementById('pattern-modal').style.display = 'none';
};

// Training email — reuses email already loaded from the users collection.
// Mirrors sendHeatmapTrainingEmail() in report.js.
// Reference: ISO 45001:2018 Clause 7.2 — Competence & Training
window.sendRosterTrainingEmail = async function(empId, empName, patternLabel, totalViolations, btnEl) {
    if (btnEl.disabled) return;
    btnEl.disabled    = true;
    btnEl.textContent = 'Sending…';

    try {
        const emp = allEmployeesData.find(e => e.id === String(empId));
        const employeeEmail = emp?.email || '';
        if (!employeeEmail) throw new Error(`No email address found for ${empId}`);

        const currentUser = getAuth().currentUser;
        const adminName   = currentUser?.displayName || currentUser?.email || 'Safety Officer';

        const res = await fetch('http://localhost:5050/api/send_training_email', {
            method:  'POST',
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
            btnEl.textContent      = 'Sent!';
            btnEl.style.background = '#065f46';
        } else {
            throw new Error(json.message || 'Unknown error');
        }
    } catch (err) {
        console.error('[Training Email]', err);
        btnEl.textContent      = 'Failed';
        btnEl.style.background = '#7f1d1d';
        btnEl.disabled         = false;
        alert(`Failed to send training email: ${err.message}`);
    }
};

// ── Boot ──────────────────────────────────────────────────────────────────────
// Wait for Firebase to restore the saved session before touching Firestore.
// Without this, Firestore sees an unauthenticated user PERMISSION_DENIED.
onAuthStateChanged(auth, (user) => {
    if (user) {
        initializeRoster();
    } else {
        window.location.href = 'login.html';
    }
});
