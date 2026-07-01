/**
 * employee.js — Sentinel-Eye Employee Self-Service Portal
 *
 * Design rationale:
 * - Employees authenticate via the same Firebase Auth login.
 * - Their Firestore document is found by UID (preferred) then email fallback.
 * - Employees only see their own data (enforced server-side by Firestore rules).
 *
 * References:
 * - ISO 45001:2018 Clause 5.4  — worker participation and consultation
 * - ISO 45001:2018 Clause 9.1  — individual performance monitoring
 * - ISO 45001:2018 Clause 10.3 — positive reinforcement / reward system
 * - Malaysia PDPA 2010          — employees' right to access their own records
 */

import { db } from './firebase-config.js';
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js";
import {
    collection, query, where, getDocs, onSnapshot, limit,
    doc, updateDoc
} from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";

const auth = getAuth();

// ── Module-level state ────────────────────────────────────────────────────────
let empData   = null;   // The employee's Firestore user document data
let _empDocRef = null;  // Firestore doc reference for the current user
let _totpPendingSecret = null;  // Temp secret during TOTP setup flow
let empPhotos = [];     // Array of { url, time, timestampMs, type }
let trendChartInst  = null;
let miniChartInst   = null;
let typeChartInst   = null;

// ── Auth gate ─────────────────────────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'login.html';
        return;
    }
    await loadEmployeeData(user);
});

// ── Load employee data ────────────────────────────────────────────────────────
// Tries UID first (server-enforced), falls back to email for first-login edge case.
async function loadEmployeeData(authUser) {
    try {
        // 1. Try UID match first
        let q = query(collection(db, "users"), where("uid", "==", authUser.uid), limit(1));
        let snap = await getDocs(q);

        if (snap.empty) {
            // Fallback: first login before UID was auto-linked — match by email
            q = query(collection(db, "users"), where("email", "==", authUser.email), limit(1));
            snap = await getDocs(q);
        }

        if (snap.empty) {
            document.getElementById('loading-msg').textContent =
                'No employee record found for your account. Please contact HR.';
            return;
        }

        snap.forEach(d => { empData = d.data(); _empDocRef = d.ref; });

        // 2. Listen for this employee's detections in real-time
        const empId = empData.id || empData.email;
        onSnapshot(collection(db, "detections"), (detSnap) => {
            empPhotos = [];
            detSnap.forEach(doc => {
                const d = doc.data();
                // Keep only this employee's records
                if (d.id !== empId && d.name !== empData.name) return;
                // Skip disputed (reverted) detections — ISO 45001:2018 Clause 10.2 Corrective Action
                if (d.disputed === true) return;
                if (d.image_url) {
                    let timeString = "Unknown Time";
                    let rawDate    = 0;
                    if (d.timestamp && typeof d.timestamp.toDate === 'function') {
                        const dt = d.timestamp.toDate();
                        timeString = dt.toLocaleString();
                        rawDate    = dt.getTime();
                    }
                    empPhotos.push({
                        url:         d.image_url,
                        time:        timeString,
                        timestampMs: rawDate,
                        type:        d.violation || "Violation"
                    });
                }
            });
            // Sort newest first by default
            empPhotos.sort((a, b) => b.timestampMs - a.timestampMs);
            renderPortal();
        }, (err) => {
            console.error("[Employee] Failed to load detections:", err);
            renderPortal(); // still show profile even if photos fail
        });

    } catch (err) {
        console.error("[Employee] Error loading data:", err);
        document.getElementById('loading-msg').textContent =
            'Error loading your profile. Please try again.';
    }
}

// ── Render the full portal ────────────────────────────────────────────────────
function renderPortal() {
    document.getElementById('loading-msg').style.display  = 'none';
    document.getElementById('emp-content').style.display  = 'block';

    renderStatCards();
    renderGoldBadge();
    renderBadges();
    renderRewards();
    renderMiniTrendChart();  // Overview tab — 7-day mini chart
    renderTrendChart();      // Violations tab — full chart with filters
    renderTypeChart();
    renderPhotos();
    renderSecurity();        // Security tab — TOTP status
    checkTrainingRequired(); // Training notification if score dropped this month
}

// ── Training Notification ─────────────────────────────────────────────────────
// Reference: ISO 45001:2018 Clause 7.2 — Competence & Training
// If the employee's safety score has dropped below 70 within the current
// calendar month, they are required to attend a safety training session.
function checkTrainingRequired() {
    const score = empData.current_score !== undefined ? empData.current_score : 100;
    if (score >= 70) return; // above threshold — no training needed

    // Count violations this calendar month only
    const now = new Date();
    const monthViolations = empPhotos.filter(p => {
        if (!p.timestampMs) return false;
        const d = new Date(p.timestampMs);
        return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    }).length;

    if (monthViolations === 0) return; // score may be historic, no current-month violations

    // Show training modal — only once per session using sessionStorage
    const shownKey = `training_shown_${empData.id}_${now.getFullYear()}_${now.getMonth()}`;
    if (sessionStorage.getItem(shownKey)) return;
    sessionStorage.setItem(shownKey, '1');

    const modal = document.getElementById('training-modal');
    if (!modal) return;

    document.getElementById('training-score').textContent  = score;
    document.getElementById('training-count').textContent  = monthViolations;
    document.getElementById('training-month').textContent  =
        now.toLocaleString('default', { month: 'long', year: 'numeric' });
    modal.style.display = 'flex';
}

window.closeTrainingModal = function() {
    const modal = document.getElementById('training-modal');
    if (modal) modal.style.display = 'none';
};

// ── Stat cards ────────────────────────────────────────────────────────────────
function renderStatCards() {
    const score   = empData.current_score !== undefined ? empData.current_score : 100;
    const scoreEl = document.getElementById('emp-score');
    scoreEl.textContent   = score;
    scoreEl.style.color   = score >= 70 ? '#10b981' : score >= 40 ? '#f59e0b' : '#ef4444';

    document.getElementById('emp-violations').textContent = empPhotos.length;
    document.getElementById('emp-rewards').textContent    = empData.reward_points || 0;
    document.getElementById('emp-id').textContent         = empData.id || '—';
    document.getElementById('emp-sub').textContent        =
        `${empData.name || 'Employee'} · ${empData.email || ''}`;
}

// ── Large gold badge hero in the topbar ───────────────────────────────────────
// Reference: ISO 45001:2018 Clause 10.3 — positive reinforcement for safe behaviour
function renderGoldBadge() {
    const heroEl = document.getElementById('gold-badge-display');
    if (empData.gold_badge) {
        heroEl.style.display = 'flex';
    } else {
        heroEl.style.display = 'none';
    }
}

// ── Badge chips (status strip below stat cards) ───────────────────────────────
function renderBadges() {
    const score    = empData.current_score !== undefined ? empData.current_score : 100;
    const badgesEl = document.getElementById('emp-badges');
    badgesEl.innerHTML = '';

    const statusText = score <= 0 || empData.status === 'Suspended'
        ? 'SUSPENDED'
        : score < 40  ? 'Danger Zone'
        : score < 70  ? 'Warning Zone'
        : 'Good Standing';

    const statusBg = score <= 0 || empData.status === 'Suspended'
        ? '#7f1d1d' : score < 40 ? '#450a0a' : score < 70 ? '#451a03' : '#052e16';
    const statusColor = score <= 0 || empData.status === 'Suspended'
        ? '#fca5a5' : score < 40 ? '#fca5a5' : score < 70 ? '#fde68a' : '#6ee7b7';

    badgesEl.innerHTML += `<span class="badge-chip" style="background:${statusBg}; color:${statusColor};">${statusText}</span>`;

    if (empData.gold_badge) {
        badgesEl.innerHTML += `<span class="badge-chip" style="background:#854d0e; color:#fef08a;">Gold Badge</span>`;
    }
    if (empData.safe_worker_status === 'Safe Worker') {
        badgesEl.innerHTML += `<span class="badge-chip" style="background:#052e16; color:#6ee7b7;">Certified Safe Worker</span>`;
    }
    if (empData.is_repeat_offender) {
        badgesEl.innerHTML += `<span class="badge-chip" style="background:#7f1d1d; color:#fca5a5;">Repeat Offender</span>`;
    }
}

// ── Rewards & Recognition section ─────────────────────────────────────────────
const MILESTONES = [
    { pts: 10,  label: '1 Month Clean',  icon: '' },
    { pts: 30,  label: '3 Months Clean', icon: '' },
    { pts: 60,  label: '6 Months Clean', icon: '' },
    { pts: 120, label: '1 Year Clean',   icon: '' },
];

function renderRewards() {
    const pts = empData.reward_points || 0;
    document.getElementById('reward-display').textContent = pts;

    const nextMilestone  = MILESTONES.find(m => m.pts > pts);
    const prevThreshold  = MILESTONES.filter(m => m.pts <= pts).slice(-1)[0]?.pts || 0;

    if (nextMilestone) {
        const progress = ((pts - prevThreshold) / (nextMilestone.pts - prevThreshold)) * 100;
        document.getElementById('reward-next-label').textContent =
            `${nextMilestone.icon} ${nextMilestone.label} (${pts} / ${nextMilestone.pts} pts)`;
        document.getElementById('reward-bar').style.width = `${Math.min(progress, 100)}%`;
    } else {
        document.getElementById('reward-next-label').textContent = 'All milestones achieved!';
        document.getElementById('reward-bar').style.width = '100%';
    }

    const container = document.getElementById('reward-milestones');
    container.innerHTML = MILESTONES.map(m => {
        const achieved = pts >= m.pts;
        return `<div class="milestone-chip ${achieved ? 'achieved' : 'pending'}">
            ${m.icon} ${m.label} — ${m.pts} pts ${achieved ? '' : ''}
        </div>`;
    }).join('');
}

// ── Mini 7-day trend chart (Overview tab) ─────────────────────────────────────
function renderMiniTrendChart() {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const dateCounts = {};
    empPhotos.forEach(p => {
        if (p.timestampMs < cutoff) return;
        const d = new Date(p.timestampMs).toLocaleDateString();
        dateCounts[d] = (dateCounts[d] || 0) + 1;
    });

    const sortedDates = Object.keys(dateCounts).sort((a, b) => new Date(a) - new Date(b));
    const canvas  = document.getElementById('miniTrendChart');
    const noData  = document.getElementById('mini-trend-no-data');

    if (sortedDates.length === 0) {
        canvas.style.display = 'none';
        noData.style.display = 'block';
        if (miniChartInst) { miniChartInst.destroy(); miniChartInst = null; }
        return;
    }
    canvas.style.display = 'block';
    noData.style.display = 'none';
    if (miniChartInst) { miniChartInst.destroy(); miniChartInst = null; }

    Chart.defaults.color = '#94a3b8';
    miniChartInst = new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: {
            labels: sortedDates,
            datasets: [{
                label: 'Violations',
                data: sortedDates.map(d => dateCounts[d]),
                backgroundColor: 'rgba(239,68,68,0.6)',
                borderColor: '#ef4444',
                borderWidth: 1,
                borderRadius: 4,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { ticks: { color: '#94a3b8' }, grid: { color: '#1e293b' } },
                y: { beginAtZero: true, ticks: { stepSize: 1, color: '#94a3b8' }, grid: { color: '#334155' } }
            }
        }
    });
}

// ── Personal violation trend chart (Violations tab) ───────────────────────────
function renderTrendChart() {
    const typeVal   = document.getElementById('trend-type-filter')?.value || 'all';
    const activeBtn = document.querySelector('.trend-date-btn.active');
    const daysVal   = activeBtn ? activeBtn.dataset.days : '90';

    const cutoff = daysVal === 'all'
        ? 0
        : Date.now() - (parseInt(daysVal) * 24 * 60 * 60 * 1000);

    const dateCounts = {};
    empPhotos.forEach(p => {
        if (p.timestampMs < cutoff) return;
        if (typeVal !== 'all' && p.type !== typeVal) return;
        const d = new Date(p.timestampMs).toLocaleDateString();
        dateCounts[d] = (dateCounts[d] || 0) + 1;
    });

    const sortedDates = Object.keys(dateCounts).sort((a, b) => new Date(a) - new Date(b));
    const canvas      = document.getElementById('empTrendChart');
    const noData      = document.getElementById('trend-no-data');

    if (sortedDates.length === 0) {
        canvas.style.display = 'none';
        noData.style.display = 'block';
        if (trendChartInst) { trendChartInst.destroy(); trendChartInst = null; }
        return;
    }
    canvas.style.display = 'block';
    noData.style.display = 'none';
    if (trendChartInst) { trendChartInst.destroy(); trendChartInst = null; }

    const borderColor = typeVal === 'No Helmet' ? '#ef4444'
                      : typeVal === 'No Vest'   ? '#f59e0b'
                      : '#3b82f6';
    const bgColor = typeVal === 'No Helmet' ? 'rgba(239,68,68,0.15)'
                  : typeVal === 'No Vest'   ? 'rgba(245,158,11,0.15)'
                  : 'rgba(59,130,246,0.15)';

    Chart.defaults.color = '#94a3b8';
    trendChartInst = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            labels: sortedDates,
            datasets: [{
                label: typeVal === 'all' ? 'All Violations' : typeVal,
                data:  sortedDates.map(d => dateCounts[d]),
                borderColor,
                backgroundColor: bgColor,
                tension:         0.35,
                fill:            true,
                pointBackgroundColor: borderColor,
                pointRadius:     4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { ticks: { color: '#94a3b8', maxTicksLimit: 10 }, grid: { color: '#1e293b' } },
                y: { beginAtZero: true, ticks: { stepSize: 1, color: '#94a3b8' }, grid: { color: '#334155' } }
            }
        }
    });
}

window.applyTrendFilter = function(clickedBtn) {
    if (clickedBtn) {
        document.querySelectorAll('.trend-date-btn').forEach(b => b.classList.remove('active'));
        clickedBtn.classList.add('active');
    }
    renderTrendChart();
};

// ── Violation type breakdown doughnut ─────────────────────────────────────────
function renderTypeChart() {
    const helmetCount = empPhotos.filter(p => p.type === 'No Helmet').length;
    const vestCount   = empPhotos.filter(p => p.type === 'No Vest').length;
    const otherCount  = empPhotos.filter(p => p.type !== 'No Helmet' && p.type !== 'No Vest').length;

    const noData = document.getElementById('breakdown-no-data');
    const canvas = document.getElementById('empTypeChart');

    if (helmetCount + vestCount + otherCount === 0) {
        canvas.style.display = 'none';
        noData.style.display = 'block';
        return;
    }
    canvas.style.display = 'block';
    noData.style.display = 'none';
    if (typeChartInst) { typeChartInst.destroy(); typeChartInst = null; }

    const labels = ['No Helmet', 'No Vest'];
    const data   = [helmetCount, vestCount];
    if (otherCount > 0) { labels.push('Other'); data.push(otherCount); }

    typeChartInst = new Chart(canvas.getContext('2d'), {
        type: 'doughnut',
        data: {
            labels,
            datasets: [{
                data,
                backgroundColor: ['#ef4444', '#f59e0b', '#6366f1'],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom', labels: { color: '#94a3b8', padding: 16 } }
            }
        }
    });
}

// ── Violation photo archive ───────────────────────────────────────────────────
window.renderPhotos = function() {
    const filterVal = document.getElementById('emp-type-filter').value;
    const photos    = filterVal === 'all' ? empPhotos : empPhotos.filter(p => p.type === filterVal);
    const grid      = document.getElementById('emp-photo-grid');

    if (photos.length === 0) {
        grid.innerHTML = `<p style="color:#94a3b8; grid-column:1/-1; text-align:center; padding:20px;">
            No photos match the current filter.</p>`;
        return;
    }

    grid.innerHTML = photos.map(p => `
        <div class="emp-photo-card">
            <img src="${p.url}" alt="Violation evidence" onerror="this.src='../images/placeholder.png'">
            <div style="color:#ef4444; font-weight:bold; margin-bottom:4px;">${p.type}</div>
            <div style="color:#94a3b8;">${p.time}</div>
        </div>
    `).join('');
};

// ── Tab switching ─────────────────────────────────────────────────────────────
window.switchTab = function(tabName, clickedBtn) {
    // Hide all panels
    document.querySelectorAll('.emp-tab-panel').forEach(p => p.style.display = 'none');
    // Deactivate all tab buttons
    document.querySelectorAll('.emp-tab').forEach(b => b.classList.remove('active'));

    // Show selected panel + mark button active
    document.getElementById(`tab-${tabName}`).style.display = 'block';
    clickedBtn.classList.add('active');

    // Re-render charts on the tab that became visible
    // (Chart.js needs the canvas to be visible to size correctly)
    if (tabName === 'violations') {
        if (trendChartInst) trendChartInst.resize();
        if (typeChartInst)  typeChartInst.resize();
    }
    if (tabName === 'overview') {
        if (miniChartInst) miniChartInst.resize();
    }
};

// ── Logout ────────────────────────────────────────────────────────────────────
window.handleLogout = function() {
    signOut(auth).then(() => {
        window.location.href = 'login.html';
    });
};

// ════════════════════════════════════════════════════════════════════════════
// TOTP (Google Authenticator) Setup
//
// Design:
//   1. A random 20-byte secret is generated using Web Crypto API (CSPRNG).
//   2. The secret is encoded as Base32 (required by TOTP standard RFC 6238).
//   3. An otpauth:// URI is built and rendered as a QR code for scanning.
//   4. The user enters the first code from the app to confirm the secret works.
//   5. Only on successful verification is the secret saved to Firestore.
//   6. From that point, login.js will detect the stored secret and require
//      the 6-digit TOTP code after every password login.
//
// Security notes:
//   - Secret is generated with crypto.getRandomValues() (NIST SP 800-90A CSPRNG)
//   - Secret is stored in the user's Firestore document (accessible only to
//     authenticated users; Firestore security rules should restrict to own doc)
//   - TOTP verification is done client-side using the otpauth library
//   - Tolerates ±1 time window (±30 s) for clock skew (RFC 6238 §5.2)
//
// Reference: RFC 6238 — TOTP: Time-Based One-Time Password Algorithm
//            NIST SP 800-63B §5.1.4 — Multi-Factor OTP Authenticators
//            ISO/IEC 27001:2022 Annex A.9.4 — Access Control
// ════════════════════════════════════════════════════════════════════════════

function renderTotpStatus() {
    const hasTotp      = !!empData.totp_secret;
    const statusIcon   = document.getElementById('totp-status-icon');
    const statusLabel  = document.getElementById('totp-status-label');
    const statusSub    = document.getElementById('totp-status-sub');
    const actionBtn    = document.getElementById('totp-action-btn');
    const disableDiv   = document.getElementById('totp-disable-section');
    const setupFlow    = document.getElementById('totp-setup-flow');

    if (hasTotp) {
        statusIcon.textContent  = '';
        statusLabel.textContent = '2FA Enabled — Google Authenticator';
        statusLabel.style.color = '#10b981';
        statusSub.textContent   = 'Your account is protected by password + authenticator code.';
        actionBtn.style.display = 'none';
        disableDiv.style.display = 'block';
        setupFlow.style.display  = 'none';
    } else {
        statusIcon.textContent  = '';
        statusLabel.textContent = '2FA Not Enabled';
        statusLabel.style.color = '#ef4444';
        statusSub.textContent   = 'Your account is protected by password only.';
        actionBtn.style.display = 'inline-block';
        actionBtn.textContent   = 'Enable 2FA';
        actionBtn.onclick       = initTotpSetup;
        disableDiv.style.display = 'none';
    }
}

// Called by renderPortal to update TOTP status on the Security tab
function renderSecurity() {
    renderTotpStatus();
}

// ── TOTP helpers (Web Crypto API — no external library needed) ────────────────
// Reference: RFC 6238 §4 (TOTP), RFC 4226 §5 (HOTP)

/** Decode a base32 string to a Uint8Array */
function _base32ToBytes(base32) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const c of base32.toUpperCase().replace(/=+$/, '')) {
        const idx = chars.indexOf(c);
        if (idx < 0) continue;
        bits += idx.toString(2).padStart(5, '0');
    }
    const bytes = new Uint8Array(Math.floor(bits.length / 8));
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
    }
    return bytes;
}

/** Compute HOTP(secret, counter) 6-digit string (RFC 4226) */
async function _hotp(secretBytes, counter) {
    // 8-byte big-endian counter
    const counterBuf = new ArrayBuffer(8);
    const view = new DataView(counterBuf);
    // JavaScript numbers are safe up to 2^53; split into high/low 32 bits
    view.setUint32(0, Math.floor(counter / 0x100000000), false);
    view.setUint32(4, counter >>> 0, false);

    const key = await crypto.subtle.importKey(
        'raw', secretBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
    );
    const sig  = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBuf));
    const off  = sig[sig.length - 1] & 0x0f;
    const code = (
        ((sig[off]     & 0x7f) << 24) |
        ((sig[off + 1] & 0xff) << 16) |
        ((sig[off + 2] & 0xff) << 8)  |
        ( sig[off + 3] & 0xff)
    ) % 1_000_000;

    return code.toString().padStart(6, '0');
}

/**
 * Verify a TOTP token against a base32 secret.
 * Allows ±`window` time steps (30 s each) for clock skew.
 * Returns true if valid.
 */
async function _verifyTotp(base32Secret, token, windowSize = 1) {
    const secretBytes = _base32ToBytes(base32Secret);
    const step = Math.floor(Date.now() / 1000 / 30);
    for (let i = -windowSize; i <= windowSize; i++) {
        const expected = await _hotp(secretBytes, step + i);
        if (expected === token) return true;
    }
    return false;
}

// ─────────────────────────────────────────────────────────────────────────────

window.initTotpSetup = function() {
    // 1. Generate a cryptographically random 20-byte secret (CSPRNG)
    //    Reference: NIST SP 800-90A — DRBG using Web Crypto
    const rawBytes = new Uint8Array(20);
    crypto.getRandomValues(rawBytes);

    // 2. Base32 encode (RFC 4648 §6 — required by TOTP / Google Authenticator)
    const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let base32 = '';
    for (let i = 0; i < rawBytes.length; i += 5) {
        const chunk = Array.from(rawBytes.slice(i, i + 5))
            .map(x => x.toString(2).padStart(8, '0')).join('');
        for (let j = 0; j < chunk.length; j += 5) {
            base32 += base32Chars[parseInt(chunk.slice(j, j + 5), 2)] || '';
        }
    }
    while (base32.length % 8 !== 0) base32 += '=';
    _totpPendingSecret = base32.replace(/=/g, '');   // store without padding

    // 3. Build the otpauth:// URI (standard format recognised by all authenticator apps)
    const label  = encodeURIComponent(`Sentinel-Eye:${empData.email || empData.id}`);
    const issuer = encodeURIComponent('Sentinel-Eye');
    const uri    = `otpauth://totp/${label}?secret=${_totpPendingSecret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;

    // 4. Render QR code using qrcodejs (generates into a <div>)
    const qrDiv = document.getElementById('totp-qr-div');
    qrDiv.innerHTML = '';   // clear any previous QR
    try {
        new QRCode(qrDiv, {
            text:         uri,
            width:        200,
            height:       200,
            colorDark:    '#000000',
            colorLight:   '#ffffff',
            correctLevel: QRCode.CorrectLevel.M
        });
    } catch (e) {
        console.error('QR generation error:', e);
        qrDiv.textContent = 'QR generation failed. Use the manual key below.';
    }

    // 5. Show manual key (grouped in 4s for readability)
    document.getElementById('totp-manual-key').textContent =
        _totpPendingSecret.match(/.{1,4}/g).join(' ');

    document.getElementById('totp-setup-flow').style.display = 'block';
    document.getElementById('totp-confirm-code').value = '';
    document.getElementById('totp-setup-error').textContent = '';
    document.getElementById('totp-confirm-code').focus();
};

window.confirmTotpSetup = async function() {
    const code  = document.getElementById('totp-confirm-code').value.trim();
    const errEl = document.getElementById('totp-setup-error');
    errEl.textContent = '';

    if (!code || !/^\d{6}$/.test(code)) {
        errEl.textContent = 'Please enter the 6-digit code from your authenticator app.';
        return;
    }

    // 6. Verify using Web Crypto TOTP (no external library)
    //    Tolerates ±1 time step (±30 s) for clock skew — RFC 6238 §5.2
    try {
        const valid = await _verifyTotp(_totpPendingSecret, code, 1);
        if (!valid) {
            errEl.textContent = 'Incorrect code. Make sure your phone clock is accurate and try again.';
            return;
        }
    } catch (e) {
        errEl.textContent = 'Verification error. Please restart setup.';
        console.error('TOTP verify error:', e);
        return;
    }

    // 7. Code is valid — persist secret to Firestore
    try {
        await updateDoc(_empDocRef, { totp_secret: _totpPendingSecret });
        empData.totp_secret = _totpPendingSecret;
        _totpPendingSecret  = null;
        document.getElementById('totp-setup-flow').style.display = 'none';
        renderTotpStatus();
        alert('Google Authenticator is now enabled!\nYou will need to enter a code on every login from now on.');
    } catch (e) {
        errEl.textContent = 'Failed to save. Check your connection and try again.';
        console.error('TOTP save error:', e);
    }
};

window.disableTotp = async function() {
    if (!confirm('Are you sure you want to disable 2FA? Your account will be less secure.')) return;
    try {
        await updateDoc(_empDocRef, { totp_secret: null });
        empData.totp_secret = null;
        renderTotpStatus();
        alert('2FA has been disabled. You can re-enable it at any time.');
    } catch (e) {
        alert('Failed to disable 2FA. Please try again.');
        console.error('TOTP disable error:', e);
    }
};
